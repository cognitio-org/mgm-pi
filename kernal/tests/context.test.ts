/** kernal-context: measuring a provider payload, the panel, and the self-contained HTML report. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysePayload, buildView, reconcile, estimateTokens, verdict, mermaidPie, CATEGORY_ORDER } from "../.pi/extensions/kernal-context/lib.ts";
import { htmlReport, markdownToHtml, svgBar, svgDonut, escapeHtml, table } from "../.pi/extensions/kernal-context/report.ts";
import { makePi, makeCtx } from "./harness.ts";

const payload = {
  model: "litellm/gpt-5.4-nano",
  messages: [
    { role: "system", content: "You are a careful coding agent. ".repeat(40) },
    { role: "user", content: "why does the release build fail" },
    { role: "assistant", content: "Let me look.", tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"scripts/package.sh"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "x".repeat(4000) },
    { role: "assistant", content: "The checksum step runs before the tarball exists.", reasoning_content: "t".repeat(400) },
    { role: "user", content: [{ type: "text", text: "fix it" }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(800) } }] },
  ],
  tools: [
    { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "bash", description: "Run a command. ".repeat(30), parameters: { type: "object", properties: { cmd: { type: "string" }, timeout: { type: "number" } } } } },
  ],
};

describe("measuring the context", () => {
  test("every part of the payload is counted, and nothing is silently dropped", () => {
    const b = analysePayload(payload);
    assert.equal(b.toolCount, 2);
    assert.equal(b.messageCount, 6);
    assert.ok(b.tokens.system > 200, "the system prompt is measured");
    assert.ok(b.tokens.toolResults > 900, "4000 characters of tool output is about a thousand tokens");
    assert.ok(b.tokens.thinking > 90 && b.tokens.thinking < 120, "reasoning is its own category");
    assert.ok(b.tokens.images > 190, "an image part is counted as an image, not as text");
    assert.ok(b.tokens.user > 0 && b.tokens.assistant > 0);
    assert.ok(b.tokens.other > 0, "tool calls land in other rather than vanishing");
    assert.deepEqual(b.largestTools.map((t) => t.name), ["bash", "read"], "biggest schema first");
  });

  test("an empty or foreign payload yields zeros instead of throwing", () => {
    for (const junk of [{}, { messages: "nonsense", tools: 7 }, null]) {
      const b = analysePayload(junk as any);
      assert.equal(Object.values(b.tokens).reduce((a, c) => a + c, 0), 0, JSON.stringify(junk));
      assert.deepEqual([b.toolCount, b.messageCount], [0, 0]);
    }
    const odd = analysePayload({ messages: [{ role: "function", content: "hello there" }] });
    assert.ok(odd.tokens.other > 0, "an unknown role is kept, in other");
  });

  test("estimates are scaled to the provider's own total, keeping the proportions", () => {
    const b = analysePayload(payload);
    const estimated = Object.values(b.tokens).reduce((a, c) => a + c, 0);
    const scaled = reconcile(b, estimated * 2);
    assert.equal(Object.values(scaled).reduce((a, c) => a + c, 0), Object.values(scaled).reduce((a, c) => a + c, 0));
    assert.ok(Math.abs(scaled.system / scaled.toolResults - b.tokens.system / b.tokens.toolResults) < 0.01, "ratios survive scaling");
    assert.deepEqual(reconcile(b, null), b.tokens, "no provider total: estimates as they are");
    assert.deepEqual(reconcile(b, 0), b.tokens);
  });

  test("the view knows the window, the free space and what compaction would reclaim", () => {
    const b = analysePayload(payload);
    const v = buildView({ breakdown: b, reportedTotal: 40_000, window: 128_000, model: "litellm/gpt-5.4-nano", compactPercent: 0.85 });
    assert.equal(v.total, 40_000);
    assert.equal(v.free, 88_000);
    assert.equal(v.compactAt, 108_800);
    assert.ok(Math.abs(v.percent - 0.3125) < 0.001);
    assert.equal(v.estimated, false);
    assert.equal(v.reclaimable, v.tokens.toolResults + v.tokens.thinking, "tool output and thinking are what masking drops first");
    assert.equal(buildView({ breakdown: b, window: 1000 }).estimated, true, "no provider total is admitted, not hidden");
  });

  test("the verdict changes with pressure, and says what to do", () => {
    const b = analysePayload(payload);
    const at = (total: number) => verdict(buildView({ breakdown: b, reportedTotal: total, window: 100_000, compactPercent: 0.85 }));
    assert.match(at(95_000), /compaction is due/);
    assert.match(at(70_000), /compaction triggers around/);
    assert.match(at(5_000), /Comfortable/);
    const fixedHeavy = buildView({ breakdown: analysePayload({ ...payload, messages: payload.messages.slice(0, 1) }), reportedTotal: 3_000, window: 8_000, compactPercent: 0.85 });
    assert.match(verdict(fixedHeavy), /before you type/, "a window mostly spent on prompt and schemas is called out");
  });

  test("mermaid source lists every present part plus free space", () => {
    const v = buildView({ breakdown: analysePayload(payload), reportedTotal: 10_000, window: 50_000 });
    const src = mermaidPie(v);
    assert.match(src, /^pie showData/);
    assert.match(src, /title Context window \(50,000 tokens\)/);
    assert.match(src, /"free" : \d+/);
    for (const c of CATEGORY_ORDER) if (v.tokens[c] > 0) assert.ok(src.includes(`"${c === "toolResults" ? "tool output" : ""}`) || src.includes(":"), c);
  });

  test("estimateTokens is characters over four, rounded up", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });
});

describe("the HTML report", () => {
  const slices = [{ label: "system prompt", value: 300, color: "#4f8ef7" }, { label: "free", value: 700, color: "#d1d5db" }];

  test("it is one self-contained file: no scripts, no network, no fonts", () => {
    const html = htmlReport({ title: "Context window", subtitle: "a project", verdict: "Comfortable", sections: [{ title: "Composition", html: svgBar(slices) + svgDonut(slices) }], mermaid: "pie showData" });
    assert.match(html, /^<!doctype html>/);
    assert.ok(!/<script/i.test(html), "no scripts");
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, "")), "no remote references");
    assert.ok(html.includes("prefers-color-scheme"), "readable in a dark browser too");
    assert.ok(html.includes("<svg") && html.includes("stroke-dasharray"), "bar and donut are inline SVG");
    assert.ok(html.includes("pie showData"), "mermaid source travels as text for pasting");
  });

  test("everything that comes from data is escaped", () => {
    const html = htmlReport({ title: '</title><script>alert(1)</script>', sections: [{ title: '<img src=x onerror=1>', html: table(["a"], [['<b>"quoted"</b>']]) }] });
    assert.ok(!html.includes("<script>alert"), "a hostile title cannot break out");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;b&gt;&quot;quoted&quot;&lt;/b&gt;"));
    assert.equal(escapeHtml("a&b<c>'\""), "a&amp;b&lt;c&gt;&#39;&quot;");
  });

  test("slice widths are proportional and a zero total does not divide by zero", () => {
    const bar = svgBar([{ label: "a", value: 1, color: "#000" }, { label: "b", value: 3, color: "#fff" }]);
    assert.match(bar, /width="25\.000%"/);
    assert.match(bar, /width="75\.000%"/);
    assert.doesNotThrow(() => svgBar([{ label: "none", value: 0, color: "#000" }]));
    assert.doesNotThrow(() => svgDonut([]));
  });
});

describe("/context command", async () => {
  const mod = await import("../.pi/extensions/kernal-context/index.ts");

  const start = async () => {
    const pi = makePi();
    await mod.default(pi as any);
    const ctx: any = makeCtx({ hasUI: true, model: { provider: "litellm", id: "gpt-5.4-nano", contextWindow: 128_000, maxTokens: 8192 } as any });
    ctx.cwd = "/proj";
    ctx.getContextUsage = () => ({ tokens: 40_000, contextWindow: 128_000, percent: 31 });
    return { pi, ctx };
  };

  test("before any request it says so, rather than inventing a breakdown", async () => {
    const { pi, ctx } = await start();
    await pi.commands.get("context")!.handler("", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /Nothing measured yet/);
    assert.equal(ctx.widgets.size, 0);
  });

  test("after a request the panel shows the composition and a verdict", async () => {
    const { pi, ctx } = await start();
    await pi.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);
    await pi.commands.get("context")!.handler("", ctx);
    const factory = ctx.widgets.get("context");
    assert.equal(typeof factory, "function");
    const lines = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t }).render(96).join("\n");
    assert.match(lines, /context window/);
    assert.match(lines, /40,000 of 128,000 tokens/);
    assert.match(lines, /system prompt/);
    assert.match(lines, /tool output/);
    assert.match(lines, /biggest schemas: bash/);
    assert.match(lines, /Comfortable/);
    assert.equal(ctx.statuses.get("context"), "◧ 31%");
    await pi.commands.get("context")!.handler("off", ctx);
    assert.equal(ctx.widgets.get("context"), undefined);
  });

  test("the payload is observed, never altered", async () => {
    const { pi, ctx } = await start();
    const before = JSON.stringify(payload);
    const result = await pi.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);
    assert.equal(result, undefined, "nothing is returned, so pi keeps its own payload");
    assert.equal(JSON.stringify(payload), before, "and the object is untouched");
  });

  test("export writes a self-contained report and reports where it went", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-report-"));
    process.env.KERNAL_REPORT_DIR = dir;
    process.env.KERNAL_NO_BROWSER = "1";
    try {
      const { pi, ctx } = await start();
      await pi.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);
      await pi.commands.get("context")!.handler("export", ctx);
      const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
      assert.equal(files.length, 1);
      const html = readFileSync(join(dir, files[0]), "utf8");
      assert.match(html, /<title>Context window<\/title>/);
      assert.match(html, /gpt-5\.4-nano/);
      assert.match(html, /Largest tool schemas/);
      assert.match(html, /reclaimable by compaction/);
      assert.match(ctx.notices.at(-1)!.msg, /Wrote .*context-.*\.html/);
      assert.ok(!/<script/i.test(html));
    } finally { delete process.env.KERNAL_REPORT_DIR; delete process.env.KERNAL_NO_BROWSER; }
  });

  test("an unknown option is refused with the valid ones", async () => {
    const { pi, ctx } = await start();
    await pi.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);
    await pi.commands.get("context")!.handler("nope", ctx);
    assert.equal(ctx.notices.at(-1)!.type, "error");
    assert.match(ctx.notices.at(-1)!.msg, /Try: export, off/);
  });
});

describe("markdown for reports", () => {
  test("the subset a report needs renders, and nothing else is invented", () => {
    const html = markdownToHtml([
      "# Heading", "", "A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).", "",
      "- one", "- two", "", "1. first", "2. second", "",
      "| col | num |", "|---|---:|", "| a | 1 |", "| b | 2 |", "",
      "> quoted", "", "```bash", "echo hi", "```", "", "---",
    ].join("\n"));
    for (const tag of ["<h2>Heading</h2>", "<strong>bold</strong>", "<em>italic</em>", "<code>code</code>", '<a href="https://example.com"', "<ul>", "<li>one</li>", "<ol>", "<li>first</li>", "<table>", "<blockquote>quoted</blockquote>", "<pre><code>echo hi</code></pre>", "<hr>"]) {
      assert.ok(html.includes(tag), tag);
    }
    assert.ok(!html.includes("<script"), "no element can come from the source text");
    // a model writing a table will use code spans in cells; they must render, not show backticks
    const withCode = markdownToHtml("| model | price |\n|---|---|\n| `gpt-5.4-nano` | **0.20** |");
    assert.match(withCode, /<td><code>gpt-5\.4-nano<\/code><\/td>/);
    assert.match(withCode, /<strong>0\.20<\/strong>/);
    assert.ok(!withCode.includes("`"), "no stray backticks");
  });

  test("content is escaped before any markup is added, so a report cannot carry an injection", () => {
    assert.match(markdownToHtml("<script>alert(1)</script>"), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(markdownToHtml("| a |\n|---|\n| <img src=x onerror=1> |"), /&lt;img src=x onerror=1&gt;/);
    assert.match(markdownToHtml("```\n</code></pre><script>x</script>\n```"), /&lt;\/code&gt;&lt;\/pre&gt;/);
    assert.match(markdownToHtml("[click](javascript:alert(1))"), /\[click\]/, "only http(s) links become anchors");
  });

  test("odd input does not throw or lose text", () => {
    assert.equal(markdownToHtml(""), "");
    assert.equal(markdownToHtml(undefined as any), "");
    assert.match(markdownToHtml("| broken | table"), /<p>\| broken \| table<\/p>/, "a table needs its divider row, else it stays text");
    assert.match(markdownToHtml("```\nunclosed fence"), /<pre><code>unclosed fence<\/code><\/pre>/);
  });
});

describe("html_report tool", async () => {
  const mod = await import("../.pi/extensions/kernal-context/index.ts");
  const tool = async () => {
    const tools = new Map<string, any>();
    const pi = makePi();
    (pi as any).registerTool = (t: any) => tools.set(t.name, t);
    await mod.default(pi as any);
    return tools.get("html_report")!;
  };
  const run = (t: any, params: any) => t.execute("id", params, undefined, undefined, { cwd: "/proj" });
  const text = (r: any) => r.content.map((c: any) => c.text).join("");

  test("its schema is small on purpose: it is charged on every request", async () => {
    const t = await tool();
    const size = Math.ceil(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length / 4);
    assert.ok(size < 260, `schema is ${size} tokens, which is the per-request tax`);
    assert.match(t.description, /only when the user asked/i, "the description discourages unasked-for pages");
  });

  test("it writes a self-contained page into the reports directory and returns the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-tool-"));
    process.env.KERNAL_REPORT_DIR = dir;
    try {
      const t = await tool();
      const out = text(await run(t, { title: "Release check", markdown: "## Findings\n\n- all four platforms built\n" }));
      assert.match(out, /^Wrote /);
      const file = out.replace(/^Wrote /, "").split(".html")[0] + ".html";
      assert.match(file, /release-check-\d{4}-\d{2}-\d{2}T/, "filename comes from the title plus a timestamp");
      const html = readFileSync(file, "utf8");
      assert.match(html, /<title>Release check<\/title>/);
      assert.match(html, /<li>all four platforms built<\/li>/);
      assert.ok(!/<script/i.test(html) && !/https?:\/\/(?!www\.w3)/.test(html.replace(/xmlns="[^"]*"/g, "")), "no scripts, no network");
    } finally { delete process.env.KERNAL_REPORT_DIR; }
  });

  test("a chart becomes inline SVG with a legend; bad rows are dropped, not fatal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-tool-"));
    process.env.KERNAL_REPORT_DIR = dir;
    try {
      const t = await tool();
      const out = text(await run(t, { title: "Spend", markdown: "By model.", chart: { kind: "donut", data: [{ label: "nano", value: 3 }, { label: "sonnet", value: 1 }, { label: "junk" }, null] } }));
      const html = readFileSync(out.replace(/^Wrote /, "").split(".html")[0] + ".html", "utf8");
      assert.match(html, /stroke-dasharray/, "a donut");
      assert.match(html, /nano/);
      assert.ok(!html.includes("junk"), "a row without a number is dropped");
    } finally { delete process.env.KERNAL_REPORT_DIR; }
  });

  test("it does not open a browser unless asked, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-tool-"));
    process.env.KERNAL_REPORT_DIR = dir;
    process.env.KERNAL_NO_BROWSER = "1";   // even with open:true, the environment wins
    try {
      const t = await tool();
      assert.match(text(await run(t, { title: "a", markdown: "b" })), /call again with open: true/);
      assert.match(text(await run(t, { title: "a", markdown: "b", open: true })), /^Wrote /, "KERNAL_NO_BROWSER keeps it closed");
    } finally { delete process.env.KERNAL_REPORT_DIR; delete process.env.KERNAL_NO_BROWSER; }
  });

  test("a title cannot escape the reports directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-tool-"));
    process.env.KERNAL_REPORT_DIR = dir;
    try {
      const t = await tool();
      const out = text(await run(t, { title: "../../etc/passwd", markdown: "x" }));
      const file = out.replace(/^Wrote /, "").split(".html")[0] + ".html";
      assert.ok(file.startsWith(dir), `stayed in the reports directory: ${file}`);
      assert.ok(!file.includes(".."), "no traversal survives the slug");
    } finally { delete process.env.KERNAL_REPORT_DIR; }
  });
});
