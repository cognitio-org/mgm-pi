import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders a fenced block as pre/code with its language", () => {
    const out = html("```ts\nconst x: number = 1;\n```");
    expect(out).toContain('<pre class="md-pre">');
    expect(out).toContain('class="language-ts"');
    expect(out).toContain('data-lang="ts"');
    expect(out).toContain("const x: number = 1;");
  });

  it("renders a fence without a language and inline code", () => {
    const out = html("run `ls -la` now\n\n```\nplain\n```");
    expect(out).toContain("<code>ls -la</code>");
    expect(out).toContain('<pre class="md-pre"><code>plain');
  });

  it("renders a mermaid fence as a diagram block, not wrapped in <pre class=\"md-pre\">", () => {
    const out = html("```mermaid\nflowchart TD\nA-->B\n```");
    expect(out).toContain('class="mermaid-block"');
    expect(out).not.toContain("md-pre");
  });

  it("renders headings, lists and GFM tables", () => {
    const out = html("## Title\n\n- a\n- b\n\n| k | v |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<li>a</li>");
    expect(out).toContain("<table>");
    expect(out).toContain("<td>2</td>");
  });

  it("never renders raw HTML from a message: it shows as text", () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
  });

  it("drops javascript: links and opens real links in a new tab", () => {
    const bad = html("[click](javascript:alert(1))");
    expect(bad).not.toContain("javascript:");
    const good = html("[docs](https://example.com)");
    expect(good).toContain('href="https://example.com"');
    expect(good).toContain('rel="noopener noreferrer"');
  });

  it("keeps an html fence as visible code, with a Render button and no preview frame yet", () => {
    const out = html("```html\n<div class=\"x\">hi</div>\n```");
    expect(out).toContain("&lt;div class=&quot;x&quot;&gt;hi&lt;/div&gt;");
    expect(out).toContain(">Render<");
    expect(out).not.toContain("<iframe");
  });

  it("does not fetch http or https images; it shows the alt text, or image when alt is empty", () => {
    const https = html("![cat](https://example.com/a.png)");
    expect(https).not.toContain("<img");
    expect(https).not.toContain("https://example.com/a.png");
    expect(https).toContain("cat");
    const http = html("![](http://example.com/a.png)");
    expect(http).not.toContain("<img");
    expect(http).not.toContain("http://example.com/a.png");
    expect(http).toContain(">image<");
  });

  it("renders a data image and leaves relative paths as alt text only", () => {
    const data = html("![shot](data:image/png;base64,aaaa)");
    expect(data).toContain("<img");
    expect(data).toContain('src="data:image/png;base64,aaaa"');
    expect(data).toContain('alt="shot"');
    const relative = html("![local](./files/a.png)");
    expect(relative).not.toContain("<img");
    expect(relative).not.toContain("./files/a.png");
    expect(relative).toContain("local");
    const empty = html("![](./files/a.png)");
    expect(empty).not.toContain("<img");
    expect(empty).not.toContain(">image<");
  });

  it("still drops javascript: and data: links", () => {
    const js = html("![x](javascript:alert(1))");
    expect(js).not.toContain("javascript:");
    expect(js).not.toContain("<img");
    const data = html("[x](data:text/html,hi)");
    expect(data).not.toContain("data:text/html");
  });

  it("collapses a long message to its opening and a Read button", () => {
    const text = `${"a".repeat(50)}\n\n${"b".repeat(1200)}`;
    const out = html(text);
    expect(out).toContain("a".repeat(50));
    expect(out).not.toContain("b".repeat(100));
    expect(out).toContain(">Read<");
    const full = renderToStaticMarkup(<Markdown text={text} reading={false} />);
    expect(full).toContain("b".repeat(100));
    expect(full).not.toContain(">Read<");
  });

  it("collapses two ATX headings even when the prose is short", () => {
    const text = "# Alpha\n\nFirst paragraph.\n\n# Beta\n\nSecond paragraph.";
    const out = html(text);
    expect(out).toContain("First paragraph.");
    expect(out).not.toContain("Second paragraph.");
    expect(out).not.toContain("<h1>");
    expect(out).toContain(">Read<");
    const one = html("# Alpha\n\nJust a sentence.");
    expect(one).toContain("<h1>Alpha</h1>");
    expect(one).not.toContain(">Read<");
  });
});
