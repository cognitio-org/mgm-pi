// @vitest-environment jsdom
// The composer's Markdown editor wired end to end in jsdom: mirror, toolbar, shortcuts, list
// continuation with both Enter modes, Tab in code blocks, preview and paste conversion.
// (jsdom has no execCommand, so edits take the setRangeText fallback; real browsers were checked
// with Playwright, see docs/reports/markdown-composer.md.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../src/components/Composer.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let sent: string[];

function mount(mode: "send" | "newline") {
  sent = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<Composer onSend={async (t) => void sent.push(t)} />);
  });
  // Enter mode lives on a right-click menu on Send (storage may be unavailable here).
  const wrap = host.querySelector<HTMLElement>(".send-wrap")!;
  if (wrap.dataset.enterMode === mode) return;
  act(() => {
    wrap.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  const label = mode === "send" ? "Enter sends" : "Enter is a new line";
  const item = Array.from(host.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")).find((b) => b.textContent?.includes(label));
  if (!item) throw new Error(`missing enter-mode item ${label}`);
  act(() => item.click());
}

beforeEach(() => mount("send"));
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const ta = () => host.querySelector("textarea")!;
const mirror = () => host.querySelector(".md-editor-mirror")!;
const button = (name: RegExp) => Array.from(host.querySelectorAll("button")).find((b) => name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))!;

function type(value: string, caret = value.length, end = caret) {
  const el = ta();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  el.setSelectionRange(caret, end);
}

function key(init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    ta().dispatchEvent(ev);
  });
  return ev;
}

describe("MarkdownEditor", () => {
  it("keeps the textarea's label and mirrors the draft, highlighted, in an aria-hidden <pre>", async () => {
    expect(ta().getAttribute("aria-label")).toBe("Message");
    type("# Title\n**b** `c`");
    expect(mirror().getAttribute("aria-hidden")).toBe("true");
    // Synchronous normally; on a loaded CI box a slow pass moves later passes to rAF.
    await vi.waitFor(() => expect(mirror().textContent).toBe("# Title\n**b** `c`"));
    expect(mirror().querySelector(".mdh-h")?.textContent).toBe(" Title");
    expect(mirror().querySelector(".mdh-b")?.textContent).toBe("b");
    expect(mirror().querySelector(".mdh-code")?.textContent).toBe("c");
  });

  it("labels every toolbar button and wires the toggle buttons' state", () => {
    for (const n of [/^Bold/, /^Italic/, /^Inline code/, /^Code block/, /^Link/, /^Bulleted list/]) expect(button(n)).toBeTruthy();
    const aa = button(/Formatting tools/);
    expect(aa.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(aa.getAttribute("aria-controls")!)?.getAttribute("aria-label")).toBe("Formatting");
    act(() => aa.click());
    expect(aa.getAttribute("aria-expanded")).toBe("true");
  });

  it("toolbar Bold wraps the selection; Ctrl+I and Ctrl+E use the same edits (jsdom is not a Mac)", () => {
    type("make this bold", 10, 14);
    act(() => button(/^Bold/).click());
    expect(ta().value).toBe("make this **bold**");
    type("x y", 2, 3);
    const ev = key({ key: "i", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta().value).toBe("x *y*");
    type("run ls", 4, 6);
    key({ key: "e", ctrlKey: true });
    expect(ta().value).toBe("run `ls`");
  });

  it("ctrl-click on Send opens the enter menu and does not send the draft", () => {
    type("hello");
    const wrap = host.querySelector<HTMLElement>(".send-wrap")!;
    const send = wrap.querySelector("button")!;
    act(() => {
      wrap.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    expect(sent).toEqual([]);
    expect(host.querySelector(".enter-mode-menu")).toBeTruthy();
  });

  it("Enter sends in send mode but continues a list with Shift+Enter", () => {
    type("- one");
    key({ key: "Enter", shiftKey: true });
    expect(ta().value).toBe("- one\n- ");
    type("hello");
    key({ key: "Enter" });
    expect(sent).toEqual(["hello"]);
  });

  it("in new-line mode Enter continues the list and Shift+Enter still sends", () => {
    act(() => root.unmount());
    host.remove();
    mount("newline");
    type("1. first");
    key({ key: "Enter" });
    expect(ta().value).toBe("1. first\n2. ");
    key({ key: "Enter", shiftKey: true });
    expect(sent).toEqual(["1. first\n2. "]);
  });

  it("Tab indents only inside a code block", () => {
    type("```\nx\n```", 4);
    const ev = key({ key: "Tab" });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta().value).toBe("```\n  x\n```");
    type("plain", 5);
    expect(key({ key: "Tab" }).defaultPrevented).toBe(false);
  });

  it("Preview renders the draft with the transcript's Markdown component and toggles aria-pressed", () => {
    type("| a | b |\n|---|---|\n| 1 | 2 |");
    const p = button(/^Preview$/);
    expect(p.getAttribute("aria-pressed")).toBe("false");
    act(() => p.click());
    expect(p.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".md-preview table td")?.textContent).toBe("1");
    expect(host.querySelector(".md-editor")!.hasAttribute("hidden")).toBe(true);
    expect(button(/^Bold/).disabled).toBe(true);
    act(() => p.click());
    expect(host.querySelector(".md-preview")).toBeNull();
  });

  function paste(data: Record<string, string>, files = false) {
    const types = Object.keys(data).concat(files ? ["Files"] : []);
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", { value: { types, getData: (t: string) => data[t] ?? "" } });
    act(() => {
      ta().dispatchEvent(ev);
    });
    return ev;
  }

  it("converts pasted HTML to Markdown (lazy converter) and never inserts HTML", async () => {
    type("");
    const ev = paste({ "text/plain": "Name Qty\nA 1", "text/html": "<table><tr><th>Name</th><th>Qty</th></tr><tr><td>A</td><td>1</td></tr></table>" });
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ta().value).toBe("| Name | Qty |\n| ---- | --- |\n| A    | 1   |"));
  });

  it("spreadsheet TSV pastes as a table at once; plain Markdown and images are left alone", () => {
    type("");
    paste({ "text/plain": "a\tb\nx\t2" });
    expect(ta().value).toBe("| a   | b   |\n| --- | --: |\n| x   | 2   |");
    expect(paste({ "text/plain": "**md**" }).defaultPrevented).toBe(false);
    expect(paste({}, true).defaultPrevented).toBe(true);
  });

  it("Cmd/Ctrl+Shift+V pastes the plain text natively, even when HTML is on the clipboard", () => {
    type("");
    key({ key: "V", metaKey: true, shiftKey: true });
    expect(paste({ "text/plain": "Title", "text/html": "<h1>Title</h1>" }).defaultPrevented).toBe(false);
  });
});
