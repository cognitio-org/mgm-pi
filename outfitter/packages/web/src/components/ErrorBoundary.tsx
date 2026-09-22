import { Component, useState, type ErrorInfo, type ReactNode } from "react";

interface PanicProps {
  error: Error;
  onReload: () => void;
  onHome: () => void;
}

function details(error: Error): string {
  return [`${error.name}: ${error.message}`, error.stack].filter(Boolean).join("\n");
}

/** The full-screen "KERNAL PANIC" crash screen a KernalPanic-caught render error shows
 * (docs/reports/mobile-desk.md): a C64-style screen with the headline, a plain-language sentence,
 * the error itself in a collapsed <details> (never shown raw -- most of this audience isn't a
 * developer), and three actions. A real <h1> (this replaces the entire page) and role="alert" so
 * assistive tech announces the crash immediately. */
function KernalPanic({ error, onReload, onHome }: PanicProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(details(error));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  return (
    <div className="kernal-panic" role="alert">
      <div className="kernal-panic-inner">
        <h1 className="kernal-panic-headline">
          KERNAL PANIC<span className="cursor-blink" aria-hidden="true" />
        </h1>
        <p className="kernal-panic-message">Something in this page crashed. Your sessions are safe.</p>
        <details className="kernal-panic-details">
          <summary>Error details</summary>
          <pre>{details(error)}</pre>
        </details>
        <div className="form-actions kernal-panic-actions">
          <button type="button" className="btn btn-primary" onClick={onReload}>
            Reload
          </button>
          <button type="button" className="btn" onClick={onHome}>
            Back to the desk
          </button>
          <button type="button" className="btn" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy details"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Wraps the app's routes (App.tsx) so an unhandled render error anywhere shows the KERNAL PANIC
 * screen instead of a blank page -- the bug report this exists for (docs/reports/mobile-desk.md).
 * An unhandled *promise rejection* is deliberately not caught here (React error boundaries never
 * see those) -- UnhandledRejectionBanner.tsx handles that case as a non-fatal banner instead. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console -- last resort once the UI itself has crashed
    console.error("KERNAL PANIC:", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleHome = () => {
    this.setState({ error: null });
    window.location.assign("/");
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <KernalPanic error={error} onReload={this.handleReload} onHome={this.handleHome} />;
  }
}
