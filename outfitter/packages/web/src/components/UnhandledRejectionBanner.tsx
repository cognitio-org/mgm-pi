import { useEffect, useState } from "react";

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "An unexpected error occurred in the background.";
}

/** An unhandled promise rejection (a `.catch()` someone forgot, a background fetch that failed
 * with nobody awaiting it) never reaches a React error boundary -- those only see errors thrown
 * during render. This listens for `window.unhandledrejection` globally (mounted once in App.tsx)
 * and shows a small dismissable banner instead of leaving the failure silent or crashing the whole
 * page with the KERNAL PANIC screen, which is reserved for actual render errors. */
export function UnhandledRejectionBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    function handler(event: PromiseRejectionEvent) {
      setMessage(reasonMessage(event.reason));
    }
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  if (!message) return null;

  return (
    <div className="unhandled-rejection-banner" role="alert">
      <span>
        <strong>Sorry, a system error occurred.</strong> {message}
      </span>
      <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
