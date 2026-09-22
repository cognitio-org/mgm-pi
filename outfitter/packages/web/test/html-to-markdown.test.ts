// Paste conversion (docs/reports/markdown-composer.md). Fixtures in test/fixtures/paste/:
// - github-readme.html, wikipedia-table.html(+.txt): real clipboards, captured from Chrome's copy
//   of github.com/mixmark-io/turndown's README and a wikitable on en.wikipedia.org (inline computed
//   styles and all);
// - google-docs.html, word.html, confluence.html, google-sheets.html(+.txt), excel.txt:
//   constructed to match what those apps put on the clipboard (docs-internal-guid wrapper,
//   mso-list paragraphs, <o:p>, conditional comments, confluenceTable, brush: params, TSV).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { htmlToMarkdown } from "../src/lib/html-to-markdown.ts";
import { choosePaste, tsvToMarkdown } from "../src/lib/paste-choice.ts";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/paste", name), "utf8");

describe("htmlToMarkdown: fixtures", () => {
  it("Google Docs: heading, inline styles, nested list, header-less table", () => {
    expect(htmlToMarkdown(fixture("google-docs.html"))).toBe(
      [
        "# Q3 Launch Plan",
        "",
        "The rollout is **on track** for *September*. Run `npm run deploy` and see the [runbook](https://example.com/runbook).",
        "",
        "- Freeze the API",
        "  - Tag v2.4",
        "- Ship",
        "",
        "| Milestone  | Owner | Notes                                  |",
        "| ---------- | ----- | -------------------------------------- |",
        "| API freeze | Dana  | No new endpoints \\| only fixes         |",
        "| Beta       | Sam   | Invite list in the tracker Second line |",
      ].join("\n"),
    );
  });

  it("Word: strips mso junk, rebuilds mso-list bullets and numbers, converts the table", () => {
    const md = htmlToMarkdown(fixture("word.html"));
    expect(md).toBe(
      [
        "## Release checklist",
        "",
        "Before tagging, **confirm** the *staging* soak passed and read [the soak report](https://example.com/soak).",
        "",
        "- Run the migrations",
        "   - Check the row counts",
        "- Flip the flag",
        "",
        "1. First step",
        "2. Second step",
        "",
        "| Service | p95 (ms) |",
        "| ------- | -------- |",
        "| api     | 212      |",
      ].join("\n"),
    );
    expect(md).not.toMatch(/mso|Font Definitions|StartFragment|·/);
  });

  it("Confluence: code macro language, alignment from styles, nested ordered list; no script/style/comment", () => {
    const md = htmlToMarkdown(fixture("confluence.html"));
    expect(md).toContain("```bash\nkubectl rollout undo deploy/api\nkubectl rollout status deploy/api\n```");
    expect(md).toContain("> Page the on-call if it does not recover in 10 minutes.");
    expect(md).toContain("| Step              | Minutes |\n| ----------------- | ------: |");
    expect(md).toContain("| Verify dashboards | 5       |");
    expect(md).toContain("1. Open an incident\n2. Post in [#ops](https://example.com/chat)\n   1. Tag the owner");
    expect(md).not.toMatch(/alert|color:red|a comment/);
  });

  it("GitHub README (real clipboard): headings without anchor icons, code languages, inline code, links", () => {
    const md = htmlToMarkdown(fixture("github-readme.html"));
    expect(md.startsWith("# Turndown\n\nConvert HTML into Markdown with JavaScript.")).toBe(true);
    expect(md).toContain("See it in action [online](https://mixmark-io.github.io/turndown/).");
    expect(md).toContain("## Installation");
    expect(md).toContain("```\nnpm install turndown\n```");
    expect(md).toContain('```html\n<script src="https://unpkg.com/turndown/dist/turndown.js"></script>\n```');
    expect(md).toContain("```js\n// For Node.js\nvar TurndownService = require('turndown')\n");
    expect(md).toContain("- `to-markdown` has been renamed to Turndown.");
    expect(md).not.toMatch(/Permalink|Copy code|style=/);
  });

  it("Wikipedia table (real clipboard): two header rows merge, rowspans, citations and images dropped", () => {
    const md = htmlToMarkdown(fixture("wikipedia-table.html"));
    const lines = md.split("\n");
    expect(lines[0]).toBe("|  | Name | Height m | Height ft | Floors | Image | City | Country | Year | Comments | Ref |");
    expect(lines[1]).toMatch(/^\| --- \| :-- \| --: \| --: \|/);
    expect(lines[2]).toContain("| 1 | **[Burj Khalifa](https://en.wikipedia.org/wiki/Burj_Khalifa)** | 828 | 2,717 |");
    expect(lines).toHaveLength(8);
    expect(md).not.toMatch(/\[14\]|cite_note|<img|thumb/);
    // Every row has the same number of cells as the header.
    const cols = (l: string) => l.replace(/\\\|/g, "").split("|").length;
    for (const l of lines) expect(cols(l)).toBe(cols(lines[0]!));
  });

  it("Google Sheets HTML table converts too (the TSV path normally wins, see choosePaste)", () => {
    expect(htmlToMarkdown(fixture("google-sheets.html"))).toContain("| APAC \\| JP |");
  });
});

describe("htmlToMarkdown: rules", () => {
  it("escapes Markdown characters in plain web text, but not snake_case", () => {
    expect(htmlToMarkdown("<p>5 * 3 = 15, use my_var and _this_</p>")).toBe("5 \\* 3 = 15, use my_var and \\_this\\_");
    expect(htmlToMarkdown("<p># not a heading</p><p>1. not a list</p>")).toBe("\\# not a heading\n\n1\\. not a list");
  });

  it("drops unsafe links but keeps their text; never emits HTML", () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">click</a> <img src=x onerror=alert(1)></p>')).toBe("click");
    expect(htmlToMarkdown("<p>a<script>bad()</script><style>p{}</style>b</p>")).toBe("ab");
  });

  it("uses a longer fence when the code contains ```", () => {
    expect(htmlToMarkdown("<pre><code class='language-md'>```js\nx\n```</code></pre>")).toBe("````md\n```js\nx\n```\n````");
  });

  it("<br> is a hard break in text and a space in a table cell", () => {
    expect(htmlToMarkdown("<p>line one<br>line two</p>")).toBe("line one  \nline two");
    expect(htmlToMarkdown("<table><tr><th>a</th></tr><tr><td>x<br>y</td></tr></table>")).toBe("| a   |\n| --- |\n| x y |");
  });

  it("task lists, strikethrough, colspan padding", () => {
    expect(htmlToMarkdown('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>')).toBe(
      "- [x] done\n- [ ] todo",
    );
    expect(htmlToMarkdown("<p><del>old</del> new</p>")).toBe("~~old~~ new");
    expect(htmlToMarkdown("<table><tr><th colspan=2>ab</th></tr><tr><td>1</td><td>2</td></tr></table>")).toBe(
      "| ab  | ab  |\n| --- | --- |\n| 1   | 2   |",
    );
  });
});

describe("choosePaste", () => {
  it("spreadsheet TSV becomes a table, with or without an HTML table alongside", () => {
    const tsv = fixture("google-sheets.txt");
    const withHtml = choosePaste(tsv, fixture("google-sheets.html"), false);
    expect(withHtml).toEqual({ kind: "insert", text: tsvToMarkdown(tsv) });
    expect(choosePaste(fixture("excel.txt"), "", false)).toEqual({
      kind: "insert",
      text: "| Name  | Role     | Start      |\n| ----- | -------- | ---------- |\n| Ada   | Engineer | 2024-01-08 |\n| Grace |          | 2023-11-20 |",
    });
    expect(tsvToMarkdown(tsv)).toBe(
      "| Region     | Q1    | Q2    |\n| ---------- | ----: | ----: |\n| EMEA       | 1,200 | 1,350 |\n| APAC \\| JP | 800   | 910   |",
    );
  });

  it("ragged tab text (a browser's copy of a complex table) goes to the HTML converter", () => {
    const c = choosePaste(fixture("wikipedia-table.txt"), fixture("wikipedia-table.html"), false);
    expect(c.kind).toBe("html");
  });

  it("literal brackets, tildes and tags in web text stay literal; link text and targets can't break out", () => {
    expect(htmlToMarkdown("<p>[x](javascript:alert(1)) &lt;script&gt; ~~s~~ a &lt; b</p>")).toBe(
      "\\[x](javascript:alert(1)) \\<script> \\~\\~s\\~\\~ a < b",
    );
    expect(htmlToMarkdown('<p><a href="https://e.x/a)b">a ] b [c</a></p>')).toBe("[a \\] b \\[c](https://e.x/a%29b)");
  });

  it("a rectangular table copied from a web page keeps its links and code: the HTML wins over the TSV", () => {
    const html =
      '<table><thead><tr><th>Name</th><th>Docs</th></tr></thead><tbody>' +
      '<tr><td><code>foo()</code></td><td><a href="https://a.example/">docs</a></td></tr>' +
      '<tr><td><strong>bar</strong></td><td><a href="https://b.example/">api</a></td></tr></tbody></table>';
    const c = choosePaste("Name\tDocs\nfoo()\tdocs\nbar\tapi", html, false);
    expect(c.kind).toBe("html");
    const md = htmlToMarkdown((c as { html: string }).html);
    expect(md).toContain("`foo()`");
    expect(md).toContain("[docs](https://a.example/)");
    expect(md).toContain("**bar**");
    // Excel's HTML is recognised as a spreadsheet's, so its TSV still wins.
    const excel = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><table><tr><td>a</td><td>b</td></tr></table></body></html>';
    expect(choosePaste("a\tb\nc\td", excel, false).kind).toBe("insert");
  });

  it("tab-indented code and single tabbed lines are not tables", () => {
    expect(tsvToMarkdown("\tif (x) {\n\t\treturn 1;\n\t}")).toBeNull();
    expect(tsvToMarkdown("\ta\n\tb")).toBeNull();
    expect(tsvToMarkdown("a\tb")).toBeNull();
  });

  it("Markdown and unstructured HTML (a code editor, a terminal) paste natively, unchanged", () => {
    expect(choosePaste("# Title\n\n| a | b |\n|---|---|", "", false)).toEqual({ kind: "native" });
    expect(choosePaste("const x = 1;", '<div style="color:#d4d4d4"><span style="color:#569cd6">const</span> x = 1;</div>', false)).toEqual({
      kind: "native",
    });
  });

  it("structured HTML converts; Cmd/Ctrl+Shift+V forces plain; files alone are ignored", () => {
    expect(choosePaste("Title", "<h1>Title</h1>", false).kind).toBe("html");
    expect(choosePaste("Title", "<h1>Title</h1>", false, true)).toEqual({ kind: "native" });
    expect(choosePaste("", "", true)).toEqual({ kind: "ignore" });
  });
});
