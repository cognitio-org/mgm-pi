/**
 * Drive-only `browser_capture` (docs/specs/chrome-companion.md, "Two tools, one name"). Loaded
 * the same way as outfitter-mail.ts: agentd adds `--extension` only inside a Drive. No tab id.
 * A Floppy has one share. The tool never sees OUTFITTER_TOKEN. It calls the loopback listener
 * agentd binds while this extension is loaded; agentd talks to the link API, and the owner's
 * Chrome takes the screenshot.
 *
 * kernal-chrome, on the laptop, registers a different tool with this same name. That one needs
 * the local Chrome socket and must not be in this image. pi refuses to start if both load.
 *
 * pi 0.86 tool results (the ToolResultMessage content array in @earendil-works/pi-ai) are
 * `(TextContent | ImageContent)[]`, and ImageContent is `{ type: "image", data, mimeType }`
 * with `data` base64. That is not the user-message `{ type: "image", source }` shape. The text
 * (title, url, path) is the contract; the jpeg is attached as that image block when the file
 * can be read.
 */

import { lstat, readFile } from "node:fs/promises";

const TOKEN_HEADER = "x-outfitter-browser-token";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: "image/jpeg" };
type ToolResult = { content: Array<TextBlock | ImageBlock>; details: Record<string, unknown> };

type PiBrowserApi = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  }): void;
};

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/** The listener only writes this shape. Anything else is not opened. */
function isCaptureFile(path: string): boolean {
  if (path.includes("\0") || path.includes("..")) return false;
  return /\/\.outfitter\/captures\/[A-Za-z0-9_-]+\.jpg$/.test(path);
}

export default function outfitterBrowser(pi: PiBrowserApi, env: NodeJS.ProcessEnv = process.env): void {
  const port = env.OUTFITTER_BROWSER_PORT ?? "";
  const token = env.OUTFITTER_BROWSER_TOKEN ?? "";

  pi.registerTool({
    name: "browser_capture",
    label: "Capture shared tab",
    description:
      "Capture the browser tab shared with this Floppy. There is no tab id: a Floppy has one share. " +
      "Returns the page title, URL, and the jpeg path under /workspace/.outfitter/captures/. " +
      "The owner is asked before the shot. Errors are no_share, skipped, timeout, permission_denied, tab_gone, or too_large.",
    promptSnippet: "Capture the browser tab shared with this Floppy",
    promptGuidelines: [
      "Use browser_capture to see the tab the user shared with this Floppy. It takes no arguments.",
      "The result's path is a jpeg in the workspace. no_share means nothing is shared; skipped means the owner revoked during the shot.",
    ],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_toolCallId, _params, signal) {
      if (!/^[0-9]+$/.test(port) || token.length === 0) {
        return textResult("browser capture is not available");
      }
      const timeout = AbortSignal.timeout(100_000);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let body: unknown;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/browser/capture`, {
          headers: { [TOKEN_HEADER]: token },
          signal: abort,
        });
        if (!res.ok) return textResult("browser capture is not available");
        body = await res.json();
      } catch {
        return textResult("timeout");
      }
      if (!body || typeof body !== "object") return textResult("timeout");
      const record = body as { error?: unknown; title?: unknown; url?: unknown; path?: unknown };
      if (typeof record.error === "string" && record.error.length > 0) return textResult(record.error);
      if (typeof record.title !== "string" || typeof record.url !== "string" || typeof record.path !== "string") {
        return textResult("timeout");
      }
      if (!isCaptureFile(record.path)) return textResult("timeout");
      const content: Array<TextBlock | ImageBlock> = [
        { type: "text", text: `title: ${record.title}\nurl: ${record.url}\npath: ${record.path}` },
      ];
      try {
        const info = await lstat(record.path);
        if (info.isFile()) {
          const bytes = await readFile(record.path);
          content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });
        }
      } catch {
        // The text path is the contract. A jpeg the tool cannot read is still named above.
      }
      return { content, details: { title: record.title, url: record.url, path: record.path } };
    },
  });
}
