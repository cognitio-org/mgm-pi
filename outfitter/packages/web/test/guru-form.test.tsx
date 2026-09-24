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
