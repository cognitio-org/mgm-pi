// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useDebouncedValue } from "../src/hooks/useDebouncedValue.ts";

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
    rerender: (next: React.ReactNode) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function Probe({ value, onRender }: { value: string; onRender: (v: string | undefined) => void }) {
  const debounced = useDebouncedValue(value, 500);
  onRender(debounced);
  return null;
}

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is undefined until the value has been stable for the delay -- including on mount", () => {
    const seen: (string | undefined)[] = [];
    const { unmount } = mount(<Probe value="a" onRender={(v) => seen.push(v)} />);
    expect(seen.at(-1)).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(seen.at(-1)).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(seen.at(-1)).toBe("a");

    unmount();
  });

  it("keeps returning the last settled value while a new change is debouncing, then updates", () => {
    const seen: (string | undefined)[] = [];
    const { rerender, unmount } = mount(<Probe value="a" onRender={(v) => seen.push(v)} />);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(seen.at(-1)).toBe("a");

    rerender(<Probe value="ab" onRender={(v) => seen.push(v)} />);
    expect(seen.at(-1)).toBe("a"); // still the last settled value, not undefined

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(seen.at(-1)).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(seen.at(-1)).toBe("ab");

    unmount();
  });

  it("stays undefined through rapid changes (streaming) and only settles once they stop", () => {
    const seen: (string | undefined)[] = [];
    const { rerender, unmount } = mount(<Probe value="f" onRender={(v) => seen.push(v)} />);

    for (const next of ["fl", "flo", "flow", "flowchart"]) {
      act(() => {
        vi.advanceTimersByTime(200); // less than the 500ms debounce
      });
      rerender(<Probe value={next} onRender={(v) => seen.push(v)} />);
    }
    expect(seen.at(-1)).toBeUndefined(); // still hasn't settled

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(seen.at(-1)).toBe("flowchart");

    unmount();
  });
});
