import { describe, expect, it } from "vitest";
import { highlightLines, tokenizeMarkdown, type Token } from "../src/lib/md-highlight.ts";

const join = (ts: Token[]) => ts.map((t) => t.text).join("");
/** The text of every token with class `cls`. */
const of = (src: string, cls: string) =>
  tokenizeMarkdown(src)
    .filter((t) => t.cls === cls)
    .map((t) => t.text);

describe("tokenizeMarkdown", () => {
  it("round-trips any input exactly (the overlay must never add or drop a character)", () => {
    const samples = [
      "",
      "\n",
      "plain text",
      "# H\n## H2 **b**\n\n- a\n  - b\n1. c\n> q *i*\n\n```ts\nconst x = 1;\n```\n",
      "| a | b |\n|:--|--:|\n| 1 | `x|y` |\n",
      "unclosed **bold and `code and [link](",
      "***\n---\n___\n* * *",
      "\t\ttabs\r\nand CRLF\r\n",
      "emoji 🎉 and CJK 漢字 **太字**",
    ];
    for (const s of samples) expect(join(tokenizeMarkdown(s))).toBe(s);
  });

  it("colours headings with a dimmed marker", () => {
    const ts = tokenizeMarkdown("## Title **x**");
    expect(ts[0]).toEqual({ text: "##", cls: "mk" });
    expect(of("## Title", "h")).toEqual([" Title"]);
    expect(of("#hashtag", "h")).toEqual([]);
  });

  it("bold, italic, strikethrough and inline code", () => {
    expect(of("a **b** c", "b")).toEqual(["b"]);
    expect(of("a __b__ c", "b")).toEqual(["b"]);
    expect(of("a *i* _j_ c", "i")).toEqual(["i", "j"]);
    expect(of("~~gone~~", "s")).toEqual(["gone"]);
    expect(of("run `ls -la` and ``a`b``", "code")).toEqual(["ls -la", "a`b"]);
  });

  it("does not treat snake_case, a lone * or escaped markers as emphasis", () => {
    expect(of("snake_case_name", "i")).toEqual([]);
    expect(of("2 * 3 * 4", "i")).toEqual([]);
    expect(of("\\*not\\*", "i")).toEqual([]);
    expect(of("** not bold **", "b")).toEqual([]);
  });

  it("does not highlight inside inline code", () => {
    expect(of("`**x**`", "b")).toEqual([]);
  });

  it("fenced code: fence lines, a language label, a body with no inline highlighting", () => {
    const src = "```python\nx = **y**\n# not a heading\n```\nafter **b**";
    expect(of(src, "lang")).toEqual(["python"]);
    expect(of(src, "fence")).toEqual(["```", "```"]);
    expect(of(src, "pre")).toEqual(["x = **y**", "# not a heading"]);
    expect(of(src, "b")).toEqual(["b"]);
    expect(of(src, "h")).toEqual([]);
  });

  it("an unclosed fence runs to the end; ~~~ fences and longer closers work", () => {
    expect(of("```\nopen\nstill", "pre")).toEqual(["open", "still"]);
    expect(of("~~~~\na\n~~~\nb\n~~~~~\nc", "pre")).toEqual(["a", "~~~", "b"]);
  });

  it("links, autolinks and bare URLs", () => {
    expect(of("see [docs](https://x.dev/a) now", "link")).toEqual(["docs"]);
    expect(of("see [docs](https://x.dev/a) now", "url")).toEqual(["https://x.dev/a"]);
    expect(of("<https://a.b/c>", "url")).toEqual(["https://a.b/c"]);
    expect(of("go to https://a.b/c.", "url")).toEqual(["https://a.b/c"]);
  });

  it("lists, task items and blockquotes", () => {
    expect(of("- a\n* b\n+ c\n10. d\n2) e", "li")).toEqual(["- ", "* ", "+ ", "10. ", "2) "]);
    expect(of("- [x] done", "li")).toEqual(["- [x]"]);
    expect(of("> quoted *i*", "q")).toEqual(["quoted "]);
    expect(of("> quoted *i*", "i")).toEqual(["i"]);
    expect(of("-not a list", "li")).toEqual([]);
  });

  it("tables: pipes, delimiter row and cell content", () => {
    const src = "| Name | **Qty** |\n| :--- | ---: |\n| a \\| b | 2 |\nnot a row";
    expect(of(src, "tdelim")).toEqual([" :--- ", " ---: "]);
    expect(of(src, "pipe").length).toBe(9);
    expect(of(src, "b")).toEqual(["Qty"]);
    expect(of("a | b\nno delimiter", "pipe")).toEqual([]);
  });

  it("horizontal rules", () => {
    expect(of("---\n***\n_ _ _", "hr")).toEqual(["---", "***", "_ _ _"]);
  });
});

describe("highlightLines", () => {
  it("escapes the draft: it can never inject markup", () => {
    const html = highlightLines('<img src=x onerror="alert(1)"> & **<b>**').join("");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
  });

  it("one string per line, each keeping its newline, so the editor can patch only changed lines", () => {
    expect(highlightLines("a\n**b**\n")).toEqual(["a\n", '<span class="mdh-mk">**</span><span class="mdh-b">b</span><span class="mdh-mk">**</span>\n', " "]);
    expect(highlightLines("")).toEqual([" "]);
  });

  it("pads a trailing newline so the mirror's last line has height", () => {
    expect(highlightLines("a\n").join("").endsWith("\n ")).toBe(true);
    expect(highlightLines("a").join("")).toBe("a");
  });

  it("is fast on a 20 KB paste (budget 5 ms; asserted loosely for slow CI)", () => {
    const chunk =
      "## Section **bold** and _it_\n\nSome text with `code`, a [link](https://example.com/x) and snake_case.\n\n" +
      "- item one\n- item two with **b**\n  1. nested\n\n> a quote\n\n```ts\nconst x = { a: 1 } // **no**\n```\n\n" +
      "| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |\n| x | `y|z` | w |\n\n---\n\n";
    let src = "";
    while (src.length < 20_000) src += chunk;
    for (let k = 0; k < 5; k++) highlightLines(src).join(""); // warm the JIT
    const runs: number[] = [];
    for (let k = 0; k < 20; k++) {
      const t0 = performance.now();
      highlightLines(src).join("");
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[10]!;
    console.info(`md-highlight: 20 KB median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(15);
  });

  it("stays linear on a pathological 20 KB single line of unclosed openers", () => {
    for (const unit of ["*a ", "_a ", "`a ", "[a ", "**a ", "~~a ", "https://x "]) {
      const src = unit.repeat(Math.ceil(20_000 / unit.length));
      const t0 = performance.now();
      const out = tokenizeMarkdown(src);
      const ms = performance.now() - t0;
      expect(join(out)).toBe(src);
      expect(ms, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`).toBeLessThan(250); // quadratic would be seconds
    }
  });
});
