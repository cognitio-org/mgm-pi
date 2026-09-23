// @vitest-environment jsdom
import { act, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary.tsx";
import { lazyRoute } from "../src/lib/chunk-reload.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHUNK =
  "Failed to fetch dynamically imported module: https://app.kernal.one/assets/SessionPage-5UGgYCdr.js";

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("stale chunk during render", () => {
  it("shows the crash screen when a reload was already tried", () => {
    sessionStorage.setItem("outfitter:chunk-reload", "1");
    function Bomb(): never {
      throw new TypeError(CHUNK);
    }
    const { container, unmount } = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("KERNAL PANIC");
    unmount();
    sessionStorage.removeItem("outfitter:chunk-reload");
  });

  it("keeps the loading fallback and records one reload when the route chunk is gone", async () => {
    sessionStorage.removeItem("outfitter:chunk-reload");
    const Page = lazyRoute(() => Promise.reject(new TypeError(CHUNK)));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Suspense fallback={<div>Loading</div>}>
            <Page />
          </Suspense>
        </ErrorBoundary>,
      );
    });
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("KERNAL PANIC");
    expect(sessionStorage.getItem("outfitter:chunk-reload")).toBe("1");
    act(() => root.unmount());
    container.remove();
  });
});
