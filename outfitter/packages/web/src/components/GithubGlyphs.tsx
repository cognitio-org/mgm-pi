// 16×16 pixel marks for the Floppy status cluster, the repository menu, and the GitHub page.
// Same grid as the desk icons, currentColor, and no text inside the svg: a menu button's
// text stays the repository name. Phosphor green is not used; that color is a tool still running.

import type { ReactNode } from "react";

export type GithubGlyphName =
  | "branch"
  | "pull"
  | "lock"
  | "public"
  | "commit"
  | "plus"
  | "none"
  | "pencil"
  | "repo"
  | "warn";

function Mark({ name, children }: { name: GithubGlyphName; children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={`github-glyph github-glyph-${name}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <g fill="currentColor">{children}</g>
    </svg>
  );
}

export function GithubGlyph({ name }: { name: GithubGlyphName }) {
  switch (name) {
    case "branch":
      return (
        <Mark name="branch">
          <rect x="1" y="7" width="4" height="2" />
          <rect x="5" y="4" width="2" height="5" />
          <rect x="7" y="3" width="4" height="2" />
          <rect x="11" y="2" width="3" height="1" />
          <rect x="11" y="3" width="1" height="1" />
          <rect x="13" y="3" width="1" height="1" />
          <rect x="11" y="4" width="3" height="1" />
          <rect x="5" y="9" width="2" height="4" />
          <rect x="7" y="11" width="4" height="2" />
          <rect x="11" y="10" width="3" height="1" />
          <rect x="11" y="11" width="1" height="1" />
          <rect x="13" y="11" width="1" height="1" />
          <rect x="11" y="12" width="3" height="1" />
        </Mark>
      );
    case "pull":
      return (
        <Mark name="pull">
          <rect x="1" y="1" width="4" height="1" />
          <rect x="1" y="2" width="1" height="2" />
          <rect x="4" y="2" width="1" height="2" />
          <rect x="1" y="4" width="4" height="1" />
          <rect x="2" y="5" width="2" height="6" />
          <rect x="6" y="7" width="6" height="2" />
          <rect x="11" y="6" width="2" height="1" />
          <rect x="12" y="5" width="2" height="1" />
          <rect x="11" y="9" width="2" height="1" />
          <rect x="12" y="10" width="2" height="1" />
          <rect x="1" y="11" width="4" height="1" />
          <rect x="1" y="12" width="1" height="2" />
          <rect x="4" y="12" width="1" height="2" />
          <rect x="1" y="14" width="4" height="1" />
        </Mark>
      );
    case "lock":
      return (
        <Mark name="lock">
          <rect x="5" y="1" width="6" height="1" />
          <rect x="5" y="2" width="1" height="3" />
          <rect x="10" y="2" width="1" height="3" />
          <rect x="4" y="5" width="8" height="1" />
          <rect x="4" y="6" width="1" height="6" />
          <rect x="11" y="6" width="1" height="6" />
          <rect x="4" y="12" width="8" height="2" />
          <rect x="7" y="7" width="2" height="2" />
          <rect x="7" y="9" width="2" height="2" />
        </Mark>
      );
    case "public":
      return (
        <Mark name="public">
          <rect x="4" y="2" width="6" height="1" />
          <rect x="4" y="3" width="1" height="2" />
          <rect x="9" y="1" width="1" height="2" />
          <rect x="10" y="1" width="2" height="1" />
          <rect x="4" y="6" width="8" height="1" />
          <rect x="4" y="7" width="1" height="5" />
          <rect x="11" y="7" width="1" height="5" />
          <rect x="4" y="12" width="8" height="2" />
          <rect x="7" y="8" width="2" height="2" />
          <rect x="7" y="10" width="2" height="1" />
        </Mark>
      );
    case "commit":
      return (
        <Mark name="commit">
          <rect x="0" y="7" width="16" height="2" />
          <rect x="5" y="4" width="6" height="1" />
          <rect x="5" y="5" width="1" height="6" />
          <rect x="10" y="5" width="1" height="6" />
          <rect x="5" y="11" width="6" height="1" />
        </Mark>
      );
    case "plus":
      return (
        <Mark name="plus">
          <rect x="7" y="2" width="2" height="12" />
          <rect x="2" y="7" width="12" height="2" />
        </Mark>
      );
    case "none":
      return (
        <Mark name="none">
          <rect x="2" y="2" width="12" height="1" />
          <rect x="2" y="3" width="1" height="10" />
          <rect x="13" y="3" width="1" height="10" />
          <rect x="2" y="13" width="12" height="1" />
          <rect x="5" y="7" width="6" height="2" />
        </Mark>
      );
    case "pencil":
      return (
        <Mark name="pencil">
          <rect x="1" y="7" width="2" height="2" />
          <rect x="3" y="6" width="8" height="4" />
          <rect x="11" y="6" width="1" height="4" />
          <rect x="12" y="5" width="3" height="6" />
        </Mark>
      );
    case "repo":
      return (
        <Mark name="repo">
          <rect x="3" y="2" width="2" height="12" />
          <rect x="5" y="2" width="8" height="1" />
          <rect x="12" y="3" width="1" height="10" />
          <rect x="5" y="13" width="8" height="1" />
          <rect x="6" y="5" width="4" height="1" />
          <rect x="6" y="8" width="4" height="1" />
          <rect x="6" y="11" width="4" height="1" />
        </Mark>
      );
    case "warn":
      return (
        <Mark name="warn">
          <rect x="6" y="1" width="4" height="1" />
          <rect x="6" y="2" width="1" height="9" />
          <rect x="9" y="2" width="1" height="9" />
          <rect x="6" y="11" width="4" height="1" />
          <rect x="7" y="3" width="2" height="4" />
          <rect x="7" y="8" width="2" height="2" />
        </Mark>
      );
  }
}
