import type { SessionGit } from "../hooks/useSessionGit.ts";
import { gitChips, type GitChip } from "../lib/git-view.ts";
import { GithubGlyph } from "./GithubGlyphs.tsx";

export type GitChipAction = "changes" | "create-pr" | "fix-ci";

function shortBranch(branch: string): string {
  return branch.replace(/^(claude|outfitter)\//, "");
}

function chipLabel(chip: GitChip): string {
  switch (chip.kind) {
    case "branch":
      return `Branch ${chip.branch}${chip.base ? ` into ${chip.base}` : ""}`;
    case "lines":
      return `${chip.files} files changed, ${chip.additions} lines added, ${chip.deletions} removed`;
    case "behind":
      return `${chip.behind} commits behind ${chip.base}`;
    case "conflict":
      return "Merge conflict with the base branch";
    case "pr":
      return `Pull request #${chip.number}${chip.merged ? ", merged" : chip.draft ? ", draft" : ""}${chip.checks ? `, checks ${chip.checks.text}` : ""}: ${chip.title}`;
    case "create-pr":
      return "Create a pull request";
    case "fix-ci":
      return "Fix CI: send the failing check's log to the agent";
  }
}

function ChipBody({ chip }: { chip: GitChip }) {
  switch (chip.kind) {
    case "branch":
      return (
        <>
          <GithubGlyph name="branch" />
          <span className="git-chip-branch">{shortBranch(chip.branch)}</span>
        </>
      );
    case "lines":
      return (
        <>
          <span className="git-add">+{chip.additions}</span>
          <span className="git-del">−{chip.deletions}</span>
        </>
      );
    case "behind":
      return (
        <>
          ↓{chip.behind} {chip.base}
        </>
      );
    case "conflict":
      return <>⚠ conflict</>;
    case "pr":
      return (
        <>
          <GithubGlyph name="pull" />#{chip.number}
          {chip.merged ? " merged" : chip.draft ? " draft" : ""}
          {chip.checks ? <span className={`git-st-${chip.checks.tone}`}>{chip.checks.text}</span> : null}
        </>
      );
    case "create-pr":
      return (
        <>
          <GithubGlyph name="pull" /> Create PR
        </>
      );
    case "fix-ci":
      return <>Fix CI</>;
  }
}

function chipClass(chip: GitChip): string {
  if (chip.kind === "create-pr") return "btn git-action";
  if (chip.kind === "fix-ci") return "btn git-action is-fix";
  const tone =
    chip.kind === "conflict" || (chip.kind === "pr" && chip.checks?.tone === "fail")
      ? " is-fail"
      : chip.kind === "behind"
        ? " is-behind"
        : chip.kind === "pr" && chip.merged
          ? " is-merged"
          : "";
  return `git-chip${tone}`;
}

function actionOf(chip: GitChip): GitChipAction {
  return chip.kind === "create-pr" ? "create-pr" : chip.kind === "fix-ci" ? "fix-ci" : "changes";
}

/** #502 (docs/design/sessions-redesign-demo.html note 15): the header's git chips. Each opens the
 * Changes tab; Create PR and Fix CI do what they say. */
export function GitChips({ git, onAction }: { git: SessionGit; onAction: (action: GitChipAction) => void }) {
  const chips = gitChips({ status: git.status, changes: git.changes, syncConflict: git.syncConflict, mergedPr: git.mergedPr });
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((chip) => (
        <button
          key={chip.kind}
          type="button"
          className={chipClass(chip)}
          title={chipLabel(chip)}
          aria-label={chipLabel(chip)}
          disabled={(chip.kind === "fix-ci" && git.busy === "fix-ci") || (chip.kind === "create-pr" && git.busy === "create-pr")}
          onClick={() => onAction(actionOf(chip))}
        >
          <ChipBody chip={chip} />
        </button>
      ))}
    </>
  );
}

/** The phone's one-line version under the header: tapping it opens the Changes view. */
export function GitStrip({ git, onOpen }: { git: SessionGit; onOpen: () => void }) {
  const chips = gitChips({ status: git.status, changes: git.changes, syncConflict: git.syncConflict, mergedPr: git.mergedPr }).filter(
    (c) => c.kind !== "create-pr" && c.kind !== "fix-ci",
  );
  if (chips.length === 0) return null;
  return (
    <button type="button" className="git-strip" onClick={onOpen} aria-label={`Changes: ${chips.map(chipLabel).join("; ")}`}>
      {chips.map((chip) => (
        <span key={chip.kind} className={chipClass(chip).replace("git-chip", "git-strip-part")}>
          <ChipBody chip={chip} />
        </span>
      ))}
      <span className="git-strip-caret" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
