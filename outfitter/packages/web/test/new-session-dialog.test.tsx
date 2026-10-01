// @vitest-environment jsdom
// Bug 4 (docs/reports/cloud-fixes.md): NewSessionDialog used to pick guruId once, from useState's
// initializer -- opened before `gurus` had loaded, guruId stayed "" forever even once gurus arrived
// and the <select> visually showed one, so Start stayed disabled.
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NewSessionDialog, preselectRepo, resolveGuruId } from "../src/components/NewSessionDialog.tsx";
import type { Guru } from "../src/api/client.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function guru(id: string): Guru {
  return { id, name: id, model: "provider/model" } as Guru;
}

describe("resolveGuruId", () => {
  it("picks the first guru when there is no current selection and no initialGuruId", () => {
    expect(resolveGuruId("", [guru("a"), guru("b")])).toBe("a");
  });

  it("returns '' when there are no gurus yet", () => {
    expect(resolveGuruId("", [])).toBe("");
  });

  it("keeps the current selection when it is still a real guru", () => {
    expect(resolveGuruId("b", [guru("a"), guru("b")])).toBe("b");
  });

  it("re-derives once gurus finish loading after starting empty", () => {
    // The exact bug: dialog opened with gurus=[], guruId resolved to "" (current, from
    // useState's initializer); gurus then loads. resolveGuruId must stop returning "".
    expect(resolveGuruId("", [])).toBe("");
    expect(resolveGuruId("", [guru("a")])).toBe("a");
  });

  it("prefers a still-valid initialGuruId over the first guru once current is invalid", () => {
    expect(resolveGuruId("gone", [guru("a"), guru("b")], "b")).toBe("b");
  });

  it("falls back to the first guru when initialGuruId no longer exists", () => {
    expect(resolveGuruId("gone", [guru("a"), guru("b")], "not-a-guru")).toBe("a");
  });
});

function mount(children: React.ReactNode): { container: HTMLDivElement; unmount: () => void; rerender: (next: React.ReactNode) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(children);
  });
  return {
    container,
    rerender: (next) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("NewSessionDialog: Start button stays usable once gurus load late", () => {
  it("enables Start once gurus arrives, for a dialog first rendered with gurus=[]", () => {
    const dialog = (gurus: Guru[]) => (
      <NewSessionDialog gurus={gurus} onClose={() => {}} onCreated={() => {}} />
    );
    const { container, rerender, unmount } = mount(dialog([]));

    const startBefore = container.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(startBefore.disabled).toBe(true); // no guru yet, no prompt yet -- expected

    rerender(dialog([guru("a")]));

    const select = container.querySelector("#ns-guru") as HTMLSelectElement;
    expect(select.value).toBe("a"); // guruId state caught up with the now-loaded gurus

    const prompt = container.querySelector("#ns-prompt") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(prompt, "do the thing");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const startAfter = container.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(startAfter.disabled).toBe(false);

    unmount();
  });
});

describe("NewSessionDialog: a tape's repos hint (E9.10)", () => {
  it("preselectRepo: the tape's first repo until the person picks one", () => {
    expect(preselectRepo("", false, { repos: ["acme/widgets", "acme/gears"] })).toBe("acme/widgets");
    expect(preselectRepo("acme/widgets", false, { repos: undefined })).toBe("");
    expect(preselectRepo("ada/notes", true, { repos: ["acme/widgets"] })).toBe("ada/notes");
  });

  it("pre-selects the first repo of the chosen tape, and follows a tape change", () => {
    const gurus = [{ ...guru("a"), repos: ["acme/widgets"] }, { ...guru("b"), repos: ["acme/gears", "acme/x"] }, guru("c")];
    const { container, unmount } = mount(<NewSessionDialog gurus={gurus} onClose={() => {}} onCreated={() => {}} />);
    const repoInput = () => container.querySelector("#ns-repo") as HTMLInputElement;
    expect(repoInput().value).toBe("acme/widgets");
    const select = container.querySelector("#ns-guru") as HTMLSelectElement;
    const pick = (id: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, id);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    pick("b");
    expect(repoInput().value).toBe("acme/gears");
    pick("c");
    expect(repoInput().value).toBe("");
    unmount();
  });
});
