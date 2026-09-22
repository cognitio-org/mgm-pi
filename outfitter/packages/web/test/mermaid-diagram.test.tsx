import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// mermaid can't actually run in jsdom (see test/mermaid-safety.test.ts) -- so MermaidDiagram's own
// orchestration (lazy-load, debounce, the safety gate, the error fallback) is tested here against
// a mocked "mermaid" module instead of a real render, which also keeps these tests fast and
// deterministic regardless of diagram content.
const renderMock = vi.fn();
const initializeMock = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

const { MermaidDiagram } = await import("../src/components/MermaidDiagram.tsx");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(children: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(children);
  });
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushDebounceAndRender() {
  // Debounce is 500ms; then the render pipeline is a couple of microtask hops (dynamic import +
  // mermaid.render). Real timers keep this simple and still fast.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });
}

afterEach(() => {
  renderMock.mockReset();
  initializeMock.mockReset();
});

describe("MermaidDiagram", () => {
  it("shows the Working indicator, initializes mermaid with strict security settings, then shows the rendered diagram", async () => {
    renderMock.mockResolvedValue({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>` });
    const { container, unmount } = mount(<MermaidDiagram source="flowchart TD\nA-->B" />);

    expect(container.querySelector(".mermaid-loading")).not.toBeNull();
    expect(container.querySelector(".working-label")?.textContent).toContain("Drawing diagram");

    await flushDebounceAndRender();

    expect(container.querySelector(".mermaid-loading")).toBeNull();
    expect(container.querySelector(".mermaid-canvas svg")).not.toBeNull();
    expect(container.querySelector(".mermaid-toolbar")).not.toBeNull();

    // MermaidDiagram caches mermaid.initialize per theme (re-initializing is not free), so this
    // is the only test in the file that can observe the call -- later tests reuse the same
    // (unchanged, default) theme and correctly skip re-initializing.
    expect(initializeMock).toHaveBeenCalledTimes(1);
    const config = initializeMock.mock.calls[0][0];
    expect(config.securityLevel).toBe("strict");
    expect(config.startOnLoad).toBe(false);
    // htmlLabels: false keeps mermaid from ever wrapping a label in <foreignObject><div>...--
    // otherwise-legitimate diagrams (flowcharts especially) would trip the "no HTML in the SVG"
    // security gate in lib/mermaid-safety.ts.
    expect(config.htmlLabels).toBe(false);
    // A diagram's own %%{init}%% directive / front matter must not be able to re-enable HTML
    // labels or inject page CSS (themeCSS), and a parse error must not leave mermaid's error
    // graphic stranded in <body>.
    for (const key of ["securityLevel", "htmlLabels", "themeCSS", "fontFamily", "themeVariables"]) {
      expect(config.secure).toContain(key);
    }
    expect(config.suppressErrorRendering).toBe(true);
    unmount();
  });

  it("does not render before the diagram has scrolled into view and settled (nothing to assert on load, just no crash/no premature call)", async () => {
    renderMock.mockResolvedValue({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>` });
    const { container, unmount } = mount(<MermaidDiagram source="flowchart TD\nA-->B unique-2" />);
    // Immediately after mount, still within the debounce window: nothing rendered yet.
    expect(renderMock).not.toHaveBeenCalled();
    expect(container.querySelector(".mermaid-canvas")).toBeNull();
    await flushDebounceAndRender();
    expect(renderMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("debounces while the source keeps changing (streaming), rendering only the final value once", async () => {
    renderMock.mockResolvedValue({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>` });
    const { rerender, unmount } = mount(<MermaidDiagram source="flowchart TD" />);

    for (const next of ["flowchart TD\nA", "flowchart TD\nA--", "flowchart TD\nA-->B"]) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200)); // less than the 500ms debounce
      });
      rerender(<MermaidDiagram source={next} />);
    }
    expect(renderMock).not.toHaveBeenCalled();

    await flushDebounceAndRender();

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0][1]).toBe("flowchart TD\nA-->B");
    unmount();
  });

  it("uses a fresh render id per render, so mermaid never deletes the SVG currently on screen", async () => {
    renderMock.mockResolvedValue({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>` });
    const { rerender, unmount } = mount(<MermaidDiagram source="flowchart TD\nA-->B id-1" />);
    await flushDebounceAndRender();
    rerender(<MermaidDiagram source="flowchart TD\nA-->C id-1" />);
    await flushDebounceAndRender();
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(renderMock.mock.calls[0][0]).not.toBe(renderMock.mock.calls[1][0]);
    unmount();
  });

  it("falls back to the source as a code block, with an error note, when mermaid fails to parse", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1: unexpected token"));
    const { container, unmount } = mount(<MermaidDiagram source="not a valid diagram (((" />);

    await flushDebounceAndRender();

    expect(container.querySelector(".mermaid-canvas")).toBeNull();
    const note = container.querySelector(".mermaid-error-badge");
    expect(note?.textContent).toContain("diagram error");
    const pre = container.querySelector(".mermaid-source pre, .mermaid-error pre.md-pre");
    expect(container.textContent).toContain("not a valid diagram (((");
    expect(container.querySelector("details")?.textContent).toContain("Parse error");
    expect(pre).not.toBeNull();
    unmount();
  });

  it("treats an unsafe rendered SVG (defense in depth) as an error and never inserts it", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    });
    const { container, unmount } = mount(<MermaidDiagram source="flowchart TD\nA-->B" />);

    await flushDebounceAndRender();

    expect(container.querySelector(".mermaid-canvas")).toBeNull();
    expect(container.innerHTML).not.toContain("<script>alert(1)</script>");
    expect(container.querySelector(".mermaid-error-badge")).not.toBeNull();
    unmount();
  });
});
