import { describe, expect, it } from "vitest";
import { continueList, formatEdit, inCodeBlock, indentEdit, shortcutAction, type FormatAction, type TextEdit } from "../src/lib/md-edit.ts";

/** A draft with the selection written inline: "[" and "]" mark it, "|" marks a caret. */
function parse(marked: string): { value: string; start: number; end: number } {
  const caret = marked.indexOf("|");
  if (caret !== -1) return { value: marked.replace("|", ""), start: caret, end: caret };
  const start = marked.indexOf("[[");
  const end = marked.indexOf("]]") - 2;
  return { value: marked.replace("[[", "").replace("]]", ""), start, end };
}

/** Applies an edit and writes the resulting selection back in the same notation. */
function show(value: string, e: TextEdit | null): string | null {
  if (!e) return null;
  const v = value.slice(0, e.from) + e.insert + value.slice(e.to);
  if (e.selStart === e.selEnd) return v.slice(0, e.selStart) + "|" + v.slice(e.selStart);
  return v.slice(0, e.selStart) + "[[" + v.slice(e.selStart, e.selEnd) + "]]" + v.slice(e.selEnd);
}

function run(action: FormatAction, marked: string): string | null {
  const { value, start, end } = parse(marked);
  return show(value, formatEdit(action, value, { start, end }));
}

describe("formatEdit", () => {
  it("bold wraps, keeps spaces outside the markers, and toggles off", () => {
    expect(run("bold", "a [[word]] b")).toBe("a **[[word]]** b");
    expect(run("bold", "a [[word ]]b")).toBe("a **[[word]]** b");
    expect(run("bold", "a **[[word]]** b")).toBe("a [[word]] b");
    expect(run("bold", "a [[**word**]] b")).toBe("a [[word]] b");
    expect(run("bold", "a | b")).toBe("a **|** b");
  });

  it("italic toggles, and does not mistake a bold marker for an italic one", () => {
    expect(run("italic", "[[x]]")).toBe("*[[x]]*");
    expect(run("italic", "*[[x]]*")).toBe("[[x]]");
    expect(run("italic", "**[[x]]**")).toBe("***[[x]]***");
  });

  it("inline code, with a double-backtick span when the text has a backtick", () => {
    expect(run("code", "run [[ls]]")).toBe("run `[[ls]]`");
    expect(run("code", "[[a`b]]")).toBe("`` [[a`b]] ``");
  });

  it("code block around whole lines, caret ready for a language", () => {
    expect(run("codeBlock", "intro\nli[[ne 1\nline]] 2\nafter")).toBe("intro\n```|\nline 1\nline 2\n```\nafter");
    expect(run("codeBlock", "|")).toBe("```\n|\n```");
    expect(run("codeBlock", "text|")).toBe("text\n```\n|\n```");
  });

  it("link: selection as text or as URL, the placeholder selected", () => {
    expect(run("link", "see [[docs]]")).toBe("see [docs]([[url]])");
    expect(run("link", "[[https://a.b/c]]")).toBe("[[[text]]](https://a.b/c)");
    expect(run("link", "|")).toBe("[[[text]]](url)");
  });

  it("list toggles '- ' on each selected line, skipping blank ones", () => {
    expect(run("list", "[[a\n\nb]]")).toBe("[[- a\n\n- b]]");
    expect(run("list", "[[- a\n- b]]")).toBe("[[a\nb]]");
    expect(run("list", "  x|")).toBe("  - x|");
  });
});

describe("shortcutAction", () => {
  it("maps Cmd/Ctrl+B/I/E/K and Cmd/Ctrl+Shift+K", () => {
    expect(shortcutAction({ key: "b", metaKey: true })).toBe("bold");
    expect(shortcutAction({ key: "i", ctrlKey: true })).toBe("italic");
    expect(shortcutAction({ key: "e", metaKey: true })).toBe("code");
    expect(shortcutAction({ key: "k", ctrlKey: true })).toBe("link");
    expect(shortcutAction({ key: "K", metaKey: true, shiftKey: true })).toBe("codeBlock");
  });

  it("ignores plain keys, Alt combos and other shifted keys (Cmd+Shift+V is paste-as-plain)", () => {
    expect(shortcutAction({ key: "b" })).toBeNull();
    expect(shortcutAction({ key: "b", metaKey: true, altKey: true })).toBeNull();
    expect(shortcutAction({ key: "v", metaKey: true, shiftKey: true })).toBeNull();
    expect(shortcutAction({ key: "c", metaKey: true })).toBeNull();
  });
});

describe("continueList", () => {
  const cont = (marked: string) => {
    const { value, start, end } = parse(marked);
    return show(value, continueList(value, { start, end }));
  };

  it("continues bullets, numbers and task items", () => {
    expect(cont("- a|")).toBe("- a\n- |");
    expect(cont("  * nested|")).toBe("  * nested\n  * |");
    expect(cont("9. nine|")).toBe("9. nine\n10. |");
    expect(cont("1) one|")).toBe("1) one\n2) |");
    expect(cont("- [x] done|")).toBe("- [x] done\n- [ ] |");
    expect(cont("> - quoted|")).toBe("> - quoted\n> - |");
  });

  it("splits an item when the caret is mid-line", () => {
    expect(cont("- ab|cd")).toBe("- ab\n- |cd");
  });

  it("ends the list on an empty item", () => {
    expect(cont("- a\n- |")).toBe("- a\n|");
    expect(cont("> - |")).toBe("> |");
  });

  it("does nothing outside a list, inside a code block, or with a selection", () => {
    expect(cont("plain|")).toBeNull();
    expect(cont("-|")).toBeNull();
    expect(cont("```\n- a|\n```")).toBeNull();
    expect(cont("- [[a]]")).toBeNull();
  });
});

describe("inCodeBlock / indentEdit", () => {
  it("knows when the caret is in a fence body", () => {
    const v = "text\n```js\nx\n```\nafter";
    expect(inCodeBlock(v, 1)).toBe(false);
    expect(inCodeBlock(v, v.indexOf("\nx\n") + 1)).toBe(true);
    expect(inCodeBlock(v, v.indexOf("js"))).toBe(false);
    expect(inCodeBlock(v, v.length)).toBe(false);
    expect(inCodeBlock("```\nopen", 6)).toBe(true);
  });

  const ind = (marked: string, out: boolean) => {
    const { value, start, end } = parse(marked);
    return show(value, indentEdit(value, { start, end }, out));
  };

  it("Tab indents at the caret or across selected lines; Shift+Tab outdents", () => {
    expect(ind("a|b", false)).toBe("a  |b");
    expect(ind("[[a\nb]]", false)).toBe("[[  a\n  b]]");
    expect(ind("    a|", true)).toBe("  a|");
    expect(ind("[[  a\n\tb\nc]]", true)).toBe("[[a\nb\nc]]");
  });
});
