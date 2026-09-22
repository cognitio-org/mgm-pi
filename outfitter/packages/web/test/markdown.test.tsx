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

  it("keeps HTML inside a code fence as visible code", () => {
    const out = html("```html\n<div class=\"x\">hi</div>\n```");
    expect(out).toContain("&lt;div class=&quot;x&quot;&gt;hi&lt;/div&gt;");
  });
});
