// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PiEntry } from "../src/api/client.ts";
import { BeatView } from "../src/components/TranscriptRail.tsx";
import { groupBeats } from "../src/lib/beats.ts";
import { entriesToViews } from "../src/lib/entry-view.ts";
import {
  HtmlPreviewAccessContext,
  beatEntryId,
  previewAccessByEntry,
  previewAccessFor,
} from "../src/lib/html-preview-access.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
});

function assistantHtml(id: string, marker: string, runId?: string): PiEntry {
  return {
    id,
    parentId: null,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: `Page ${marker}:\n\n\`\`\`html\n<p>${marker}</p>\n\`\`\`` }] },
    ...(runId ? { outfitterRunId: runId } : {}),
  };
}

/** Renders a transcript the way SessionPage does: one access provider per beat. */
function renderTranscript(entries: PiEntry[], accessByRun: Record<string, boolean>, sessionAllows: boolean) {
  const beats = groupBeats(groupThinkingBlocks(entriesToViews(entries)));
  const access = previewAccessByEntry(entries, accessByRun, previewAccessFor(sessionAllows));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <>
        {beats.map((beat) => (
          <HtmlPreviewAccessContext.Provider key={beat.id} value={access(beatEntryId(beat))}>
            {beat.kind === "passthrough" ? null : <BeatView beat={beat} />}
          </HtmlPreviewAccessContext.Provider>
        ))}
      </>,
    ),
  );
}

/** Opens the fence whose source contains `marker` and returns whether the preview starts external. */
function opensExternal(marker: string): boolean {
  const fence = Array.from(container!.querySelectorAll(".html-fence")).find((f) => f.textContent?.includes(`<p>${marker}</p>`))!;
  const render = Array.from(fence.querySelectorAll("button")).find((b) => b.textContent === "Render")!;
  act(() => render.click());
  const box = document.querySelector<HTMLInputElement>('.html-preview-allow input[type="checkbox"]')!;
  const checked = box.checked;
  const close = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Close")!;
  act(() => close.click());
  return checked;
}

describe("#147: each fence starts from the run that wrote it", () => {
  it("a sealed run's fence stays sealed after a later run was allowed external CSS and JS", () => {
    renderTranscript(
      [assistantHtml("e1", "first", "run-1"), assistantHtml("e2", "second", "run-2")],
      { "run-1": false, "run-2": true },
      true, // the session-wide value follows the latest run
    );
    expect(opensExternal("first")).toBe(false);
    expect(opensExternal("second")).toBe(true);
  });

  it("an external run's fence stays external after a later run was sealed", () => {
    renderTranscript(
      [assistantHtml("e1", "first", "run-1"), assistantHtml("e2", "second", "run-2")],
      { "run-1": true, "run-2": false },
      false,
    );
    expect(opensExternal("first")).toBe(true);
    expect(opensExternal("second")).toBe(false);
  });

  it("an entry with no run, or a run that recorded nothing, uses the session's value", () => {
    renderTranscript([assistantHtml("e1", "old"), assistantHtml("e2", "unrecorded", "run-x")], {}, true);
    expect(opensExternal("old")).toBe(true);
    expect(opensExternal("unrecorded")).toBe(true);
  });
});

describe("beatEntryId", () => {
  it("names the entry an assistant beat's prose came from, even when its rail starts in an earlier entry", () => {
    const entries: PiEntry[] = [
      {
        id: "call",
        parentId: null,
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
      },
      { id: "result", parentId: "call", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: "ok" } },
      assistantHtml("prose", "p"),
    ];
    const [beat] = groupBeats(groupThinkingBlocks(entriesToViews(entries)));
    expect(beat!.kind).toBe("assistant");
    expect(beat!.id.startsWith("call")).toBe(true);
    expect(beatEntryId(beat!)).toBe("prose");
  });
});
