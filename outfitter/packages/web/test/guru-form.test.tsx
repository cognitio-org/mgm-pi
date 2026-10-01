// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type Guru } from "../src/api/client.ts";
import { GuruForm } from "../src/components/GuruForm.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

const guru: Guru = {
  id: "g1",
  name: "Tape",
  model: "litellm/claude-sonnet-5",
  appendSystemPrompt: "Always cite files.",
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

function render(existing: Guru) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<GuruForm guru={existing} models={[]} meta={null} onClose={vi.fn()} onSaved={vi.fn()} />));
  return container.querySelector<HTMLInputElement>('label.form-check input[type="checkbox"]')!;
}

describe("GuruForm: #132 Allow external CSS and JS in HTML previews", () => {
  it("is off for a Tape without the field, and saving sends the flag without touching the append text", async () => {
    const update = vi.spyOn(api, "updateGuru").mockResolvedValue({ ...guru, allowExternalHtmlResources: true });
    const box = render(guru);
    expect(box.closest("label")!.textContent).toContain("Allow external CSS and JS in HTML previews");
    expect(box.checked).toBe(false);

    act(() => box.click());
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0]![1];
    expect(payload.allowExternalHtmlResources).toBe(true);
    // The paragraph is appended by agentd, never written into the person's own text.
    expect(payload.appendSystemPrompt).toBe("Always cite files.");
  });

  it("shows a Tape that has it on as checked", () => {
    expect(render({ ...guru, allowExternalHtmlResources: true }).checked).toBe(true);
  });
});

describe("GuruForm: #241 VS Code in the browser", () => {
  const ideBox = () =>
    [...container!.querySelectorAll<HTMLInputElement>('label.form-check input[type="checkbox"]')].find((b) =>
      b.closest("label")!.textContent!.includes("VS Code in the browser"),
    )!;

  it("is off for a Tape without the field, and saving sends browserIde", async () => {
    const update = vi.spyOn(api, "updateGuru").mockResolvedValue({ ...guru, browserIde: true });
    render(guru);
    const box = ideBox();
    expect(box.checked).toBe(false);
    act(() => box.click());
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1].browserIde).toBe(true);
    expect(update.mock.calls[0]![1].allowExternalHtmlResources).toBe(false);
  });

  it("shows a Tape that has it on as checked", () => {
    render({ ...guru, browserIde: true });
    expect(ideBox().checked).toBe(true);
  });
});

describe("GuruForm: E9 memory and Agent Engine", () => {
  function renderIt(existing?: Guru) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<GuruForm guru={existing} models={[]} meta={null} onClose={vi.fn()} onSaved={vi.fn()} />));
    return {
      memory: container.querySelector<HTMLSelectElement>("#guru-memory")!,
      agentEngine: container.querySelector<HTMLInputElement>("#guru-agent-engine")!,
    };
  }

  it("both are off for a Tape without the fields, and any person can change them", async () => {
    const update = vi.spyOn(api, "updateGuru").mockResolvedValue({ ...guru, memory: "auto", agentEngine: true });
    const { memory, agentEngine } = renderIt(guru);
    expect(memory.value).toBe("off");
    expect([...memory.options].map((o) => o.value)).toEqual(["off", "tool", "auto"]);
    expect(memory.disabled).toBe(false);
    expect(agentEngine.checked).toBe(false);
    act(() => {
      memory.value = "auto";
      memory.dispatchEvent(new Event("change", { bubbles: true }));
      agentEngine.click();
    });
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(update.mock.calls[0]![1].memory).toBe("auto");
    expect(update.mock.calls[0]![1].agentEngine).toBe(true);
  });

  it("shows a Tape's saved values, and sends them back unchanged", async () => {
    const update = vi.spyOn(api, "updateGuru").mockResolvedValue(guru);
    const { memory, agentEngine } = renderIt({ ...guru, memory: "tool", agentEngine: true });
    expect(memory.value).toBe("tool");
    expect(agentEngine.checked).toBe(true);
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(update.mock.calls[0]![1]).toMatchObject({ memory: "tool", agentEngine: true });
  });
});

describe("GuruForm: #290 Admin tools", () => {
  function renderWith(existing: Guru, isSysop: boolean) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<GuruForm guru={existing} models={[]} meta={null} isSysop={isSysop} onClose={vi.fn()} onSaved={vi.fn()} />));
    return container.querySelector<HTMLSelectElement>("#guru-admin-tools")!;
  }
  const submit = async () => {
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };

  it("is Off by default; only a sysop can turn it on", () => {
    const select = renderWith(guru, false);
    expect(select.value).toBe("off");
    expect(select.disabled).toBe(true);
    expect([...select.options].map((o) => o.value)).toEqual(["off"]);
    act(() => root!.unmount());
    const sysop = renderWith(guru, true);
    expect([...sysop.options].map((o) => o.value)).toEqual(["off", "manage", "operator"]);
  });

  it("saving sends a sysop's choice", async () => {
    const update = vi.spyOn(api, "updateGuru").mockResolvedValue({ ...guru, adminTools: "manage" });
    const select = renderWith(guru, true);
    act(() => {
      select.value = "manage";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submit();
    expect(update.mock.calls[0]![1].adminTools).toBe("manage");
  });

  it("a tape with admin tools is read-only for a non-sysop, and says why", async () => {
    const update = vi.spyOn(api, "updateGuru");
    const select = renderWith({ ...guru, adminTools: "manage" }, false);
    expect(select.value).toBe("manage");
    expect(select.disabled).toBe(true);
    expect(container!.textContent).toContain("Only a sysop can change this tape");
    expect(container!.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
    expect(container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await submit();
    expect(update).not.toHaveBeenCalled();
  });

  it("on a new tape, a sysop can choose operator", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<GuruForm models={[]} meta={null} isSysop onClose={vi.fn()} onSaved={vi.fn()} />));
    act(() => {
      const name = container!.querySelector<HTMLInputElement>("#guru-name")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "Ops");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const select = container!.querySelector<HTMLSelectElement>("#guru-admin-tools")!;
    act(() => {
      select.value = "operator";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect([...select.options].map((o) => o.value)).toContain("operator");
    expect(select.value).toBe("operator");
  });
});

describe("GuruForm: E9.10 the repos hint", () => {
  async function save(existing: Guru, value: string) {
    const update = vi.spyOn(api, "updateGuru").mockResolvedValue(existing);
    render(existing);
    const input = container!.querySelector<HTMLInputElement>("#guru-repos")!;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    return update.mock.calls[0]![1];
  }

  it("shows the saved repos and sends them lowercased", async () => {
    render({ ...guru, repos: ["acme/widgets"] });
    expect(container!.querySelector<HTMLInputElement>("#guru-repos")!.value).toBe("acme/widgets");
    act(() => root?.unmount());
    root = null;
    container?.remove();
    expect((await save(guru, "Acme/Widgets, acme/gears")).repos).toEqual(["acme/widgets", "acme/gears"]);
  });

  it("an emptied field clears them", async () => {
    expect((await save({ ...guru, repos: ["acme/widgets"] }, "")).repos).toEqual([]);
  });
});
