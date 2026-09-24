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

const SELECTOR_MAX = 500;
const TEXT_MAX = 8000;

function selectorOk(selector: string): boolean {
  if (selector.length === 0 || selector.length > SELECTOR_MAX) return false;
  if (/[\u0000-\u001f\u007f<{}`;]/.test(selector)) return false;
  if (/javascript\s*:/i.test(selector)) return false;
  if (/eval\s*\(/i.test(selector) || /function\s*\(/i.test(selector)) return false;
  if (selector.includes("=>")) return false;
  if (/url\s*\(/i.test(selector) || /expression\s*\(/i.test(selector)) return false;
  return true;
}

/** CSS selector only. A `code` or `javascript:` field is not an action. */
function actionBody(params: Record<string, unknown> | null | undefined): { kind: "click" | "type"; selector: string; text?: string } | undefined {
  if (!params || typeof params !== "object") return undefined;
  const kind = params.kind;
  const selector = typeof params.selector === "string" ? params.selector.trim() : "";
  if ((kind !== "click" && kind !== "type") || !selectorOk(selector)) return undefined;
  if (kind === "click") {
    if (params.text !== undefined) return undefined;
    return { kind, selector };
  }
  if (typeof params.text !== "string" || params.text.length > TEXT_MAX || params.text.includes("\u0000")) return undefined;
  return { kind, selector, text: params.text };
}

/** The listener only writes this shape. Anything else is not opened. */
function isCaptureFile(path: string): boolean {
  if (path.includes("\0") || path.includes("..")) return false;
  return /\/\.outfitter\/captures\/[A-Za-z0-9_-]+\.jpg$/.test(path);
}

export default function outfitterBrowser(pi: PiBrowserApi, env: NodeJS.ProcessEnv = process.env): void {
  const port = env.OUTFITTER_BROWSER_PORT ?? "";
  const token = env.OUTFITTER_BROWSER_TOKEN ?? "";
  const actionPort = env.OUTFITTER_BROWSER_ACTION_PORT ?? "";
  const actionToken = env.OUTFITTER_BROWSER_ACTION_TOKEN ?? "";

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

  pi.registerTool({
    name: "browser_action",
    label: "Browser action",
    description:
      "Click or type in the browser tab shared with this Floppy. kind is \"click\" or \"type\". " +
      "selector is a CSS selector, not JavaScript. type also needs text. " +
      "The owner confirms each action unless they allowed that kind for this share. " +
      "There is no tab id. Errors are no_share, skipped, denied, rejected, timeout, not_found, permission_denied, tab_gone, not_editable, or not_shared.",
    promptSnippet: "Click or type in the tab shared with this Floppy",
    promptGuidelines: [
      "Use browser_action to click or type in the tab the user shared. Pass kind and a CSS selector. Do not pass JavaScript.",
      "type needs text. The owner is asked before it runs. denied means they said no. skipped means they revoked first. no_share means nothing is shared.",
    ],
    parameters: {
      type: "object",
      required: ["kind", "selector"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["click", "type"], description: "click or type." },
        selector: { type: "string", description: "CSS selector in the shared tab. Not JavaScript." },
        text: { type: "string", description: "Text to type. Required when kind is type. Ignored for click." },
      },
    },
    async execute(_toolCallId, params, signal) {
      const body = actionBody(params);
      if (!body) return textResult("rejected");
      if (!/^[0-9]+$/.test(actionPort) || actionToken.length === 0) {
        return textResult("browser action is not available");
      }
      const timeout = AbortSignal.timeout(100_000);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let parsed: unknown;
      try {
        const res = await fetch(`http://127.0.0.1:${actionPort}/browser/action`, {
          method: "POST",
          headers: { [TOKEN_HEADER]: actionToken, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: abort,
        });
        if (!res.ok) return textResult("browser action is not available");
        parsed = await res.json();
      } catch {
        return textResult("timeout");
      }
      if (!parsed || typeof parsed !== "object") return textResult("timeout");
      const record = parsed as { error?: unknown; ok?: unknown };
      if (typeof record.error === "string" && record.error.length > 0) return textResult(record.error);
      if (record.ok !== true) return textResult("timeout");
      const verb = body.kind === "type" ? "Typed into" : "Clicked";
      return textResult(`${verb} ${body.selector}`, { kind: body.kind, selector: body.selector });
    },
  });
}
