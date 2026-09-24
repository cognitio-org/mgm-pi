/**
 * Laptop-only browser_tabs and browser_capture. The capture tool takes a tab id and talks to
 * the Chrome native host on <kernal-home>/chrome.sock. It does not work in a Drive: there is
 * no Chrome and no socket there.
 *
 * The Drive has its own tool, also named browser_capture, in outfitter-browser.ts. That one
 * takes no tab id and goes through agentd to the link API. pi will not start if both
 * extensions are loaded. The sandbox image deletes this directory; do not put it back.
 *
 * pi loads every `.pi/extensions/<name>/index.ts`. kernal-github is included the same way:
 * there is no extension allowlist in settings.json, and package.sh copies `.pi/extensions` whole.
 * A release bundle therefore ships this file without a separate manifest entry.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { browserCapture, browserTabs, imageContent, NOT_RUNNING, type ToolText } from "./lib.ts";

const GUIDELINES = [
  "browser_tabs: list Chrome tabs the user has shared before capturing one. If the Chrome companion is not running, say so. Do not use HTTP or another browser.",
  "browser_capture: capture only a tab id browser_tabs returned. If that tab is not shared, say so. Do not guess another id and do not fall back to the network.",
];

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function result(res: ToolText) {
  const content: Block[] = [{ type: "text", text: res.text }];
  if (res.image && !res.isError) content.push(imageContent(res.image));
  return { content, isError: res.isError };
}

async function run(fn: () => Promise<ToolText>) {
  try {
    return result(await fn());
  } catch {
    return { content: [{ type: "text" as const, text: NOT_RUNNING }], isError: true };
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_tabs",
    label: "Browser tabs",
    description: "List Chrome tabs the user has shared with Kernal. Returns each tab id, title, URL, and session id. Talks only to the local Chrome companion socket. If it is not running, say so. There is no network fallback.",
    promptSnippet: "browser_tabs: list Chrome tabs shared with Kernal.",
    promptGuidelines: [GUIDELINES[0]],
    parameters: { type: "object", properties: {} },
    execute: async (_id: string, _params: unknown, signal?: AbortSignal) => run(() => browserTabs({ signal })),
  } as any);

  pi.registerTool({
    name: "browser_capture",
    label: "Browser capture",
    description: "Capture one shared Chrome tab. Pass tabId from browser_tabs. Returns the page title, URL, and the workspace-relative path of the jpeg. Talks only to the local Chrome companion socket. If that tab is not shared, say so. There is no network fallback.",
    promptSnippet: "browser_capture: save a jpeg of a shared Chrome tab into the workspace.",
    promptGuidelines: [GUIDELINES[1]],
    parameters: {
      type: "object",
      required: ["tabId"],
      properties: {
        tabId: { type: "number", description: "Tab id from browser_tabs." },
      },
    },
    execute: async (_id: string, params: { tabId?: unknown } | null, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd?: string } | undefined) =>
      run(() => browserCapture(params?.tabId, ctx?.cwd ?? process.cwd(), { signal })),
  } as any);
}
