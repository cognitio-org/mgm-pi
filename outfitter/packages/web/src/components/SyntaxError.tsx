import type { ReactNode } from "react";

/** "?SYNTAX ERROR" -- an inline, per-field validation message (docs/reports/mobile-desk.md), used
 * beside an invalid form field (the guru form's name, the token-name input) instead of a generic
 * red asterisk. `children` is the plain reason ("name cannot be empty"), not the full sentence. */
export function SyntaxError({ children }: { children: ReactNode }) {
  return (
    <span className="syntax-error" role="alert">
      <strong>?SYNTAX ERROR</strong> &mdash; {children}
    </span>
  );
}
