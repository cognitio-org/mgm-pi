// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// ErrorBoundary.componentDidCatch reports the crash to Sentry (lib/sentry.ts) -- mocked here
// rather than let the real SDK run (it would try to reach the network for every test crash).
const captureExceptionMock = vi.fn();
vi.mock("@sentry/react", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

const { ErrorBoundary } = await import("../src/components/ErrorBoundary.tsx");

// Silences React's "not configured to support act(...)" warning -- this file drives real
// createRoot renders (see the comment on `mount` below for why), which React only recognizes as a
// test environment when this global is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-dom/server's renderToStaticMarkup doesn't run getDerivedStateFromError the way a real
// browser render does, so this mounts into a real (jsdom) DOM via createRoot instead -- the same
// environment the error boundary actually runs in.
function Bomb(): never {
  throw new Error("boom");
}

function mount(children: React.ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(children);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("ErrorBoundary", () => {
  it("renders its children when nothing has thrown", () => {
    const { container, unmount } = mount(
      <ErrorBoundary>
        <div>all good</div>
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("all good");
    unmount();
  });

  it("renders the KERNAL PANIC screen when a child throws during render", () => {
    const { container, unmount } = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("KERNAL PANIC");
    expect(container.textContent).toContain("Something in this page crashed. Your sessions are safe.");
    unmount();
  });

  it("includes the error message inside the collapsed details, and Reload/Back to the desk/Copy details actions", () => {
    const { container, unmount } = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("boom");
    expect(container.querySelector("details")).not.toBeNull();
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Reload");
    expect(buttons).toContain("Back to the desk");
    expect(buttons).toContain("Copy details");
    unmount();
  });

  it('marks the crash screen role="alert" with a real heading', () => {
    const { container, unmount } = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toContain("KERNAL PANIC");
    unmount();
  });

  it("reports the caught error to Sentry", () => {
    captureExceptionMock.mockClear();
    const { unmount } = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [reportedError] = captureExceptionMock.mock.calls[0] as [Error];
    expect(reportedError.message).toBe("boom");
    unmount();
  });
});
