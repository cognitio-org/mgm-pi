/**
 * Self-contained HTML reports: one file, inline CSS and inline SVG, no network and no build step, so
 * it opens anywhere and still works on a plane. Shared on purpose — any kernal extension can import
 * `htmlReport` to turn what it knows into something openable. Mermaid source is included as text for
 * pasting into documents, not as a rendered dependency.
 */
export type Section = { title: string; html: string };
export type Slice = { label: string; value: number; color: string };

export const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** A stacked proportional bar. Widths are percentages, so it scales with the page. */
export function svgBar(slices: Slice[], height = 34): string {
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
  let x = 0;
  const parts = slices.map((s) => {
    const width = (s.value / total) * 100;
    const rect = `<rect x="${x.toFixed(3)}%" y="0" width="${width.toFixed(3)}%" height="${height}" fill="${s.color}"><title>${escapeHtml(s.label)}: ${s.value.toLocaleString("en-US")}</title></rect>`;
    x += width;
    return rect;
  });
  return `<svg class="bar" viewBox="0 0 100 ${height}" preserveAspectRatio="none" height="${height}" width="100%" role="img" aria-label="context composition">${parts.join("")}</svg>`;
}

/** A donut, drawn with stroke-dasharray so there is no arc trigonometry to get wrong. */
export function svgDonut(slices: Slice[], size = 190): string {
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
  const radius = 60, circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = slices.map((s) => {
    const length = (s.value / total) * circumference;
    const ring = `<circle r="${radius}" cx="80" cy="80" fill="transparent" stroke="${s.color}" stroke-width="28" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"><title>${escapeHtml(s.label)}: ${s.value.toLocaleString("en-US")}</title></circle>`;
    offset += length;
    return ring;
  });
  return `<svg class="donut" viewBox="0 0 160 160" width="${size}" height="${size}" role="img" aria-label="context composition">${rings.join("")}</svg>`;
}

export function legend(slices: Slice[], total: number): string {
  const rows = slices.map((s) => `<tr><td><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}</td><td class="num">${s.value.toLocaleString("en-US")}</td><td class="num">${((s.value / (total || 1)) * 100).toFixed(1)}%</td></tr>`);
  return `<table class="legend"><thead><tr><th>part</th><th class="num">tokens</th><th class="num">of window</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function table(headers: string[], rows: (string | number)[][]): string {
  return tableHtml(headers.map(escapeHtml), rows.map((r) => r.map((c) => escapeHtml(c))));
}

/** Same layout, for cells that are already HTML (Markdown tables, whose cells carry inline markup). */
function tableHtml(headers: string[], rows: string[][]): string {
  const head = headers.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((cell, i) => `<td${i ? ' class="num"' : ""}>${cell}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Markdown → HTML for the subset a report needs: headings, paragraphs, lists, tables, fenced code,
 * blockquotes, inline code, bold, italic and links. Everything is escaped before any markup is added,
 * so content from a file, a command or a model cannot introduce elements of its own — the reason this
 * exists rather than pulling in a renderer whose escaping we would have to audit.
 */
export function markdownToHtml(source: string): string {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | undefined;
  let para: string[] = [];
  let quote: string[] = [];
  let code: { lang: string; body: string[] } | undefined;

  const inline = (text: string) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer noopener">$1</a>');
  const flushParagraph = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = undefined; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (code) {
      if (/^```/.test(line.trim())) { out.push(`<pre><code>${escapeHtml(code.body.join("\n"))}</code></pre>`); code = undefined; }
      else code.body.push(line);
      continue;
    }
    const fence = line.trim().match(/^```(\w*)/);
    if (fence) { flushAll(); code = { lang: fence[1], body: [] }; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { flushAll(); const level = Math.min(4, heading[1].length + 1); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }

    // a table needs a header row, a divider, then body rows
    if (isTableRow(line) && isTableRow(lines[i + 1] ?? "") && /^[\s|:-]+$/.test(lines[i + 1])) {
      flushAll();
      const headers = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(tableHtml(headers.map(inline), rows.map((r) => r.map(inline))));   // cells carry inline markup
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph(); flushQuote();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }

    if (!line.trim()) { flushAll(); continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.body.join("\n"))}</code></pre>`);
  flushAll();
  return out.join("\n");
}

/**
 * The house palette: light and dark from the OS setting, one accent. Exported so every kernal page
 * (reports, the /admin web app) shares one look; extend it there rather than inventing another.
 */
export const THEME = {
  light: { fg: "#1a1a1a", muted: "#6b7280", bg: "#ffffff", panel: "#f6f7f9", line: "#e5e7eb" },
  dark: { fg: "#e8e8e8", muted: "#9aa0a6", bg: "#131415", panel: "#1c1e20", line: "#2a2d30" },
  accent: "#4f8ef7",
  font: `ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif`,
};
const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}: ${v};`).join(" ");

const STYLE = `
:root { color-scheme: light dark; ${vars(THEME.light)} }
@media (prefers-color-scheme: dark) { :root { ${vars(THEME.dark)} } }
* { box-sizing: border-box; }
body { margin: 0; padding: 2.5rem 1.5rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.55rem; margin: 0 0 .2rem; letter-spacing: -.01em; }
h2 { font-size: 1.05rem; margin: 2.2rem 0 .7rem; }
.sub { color: var(--muted); margin: 0 0 2rem; }
.verdict { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid #4f8ef7;
  border-radius: 6px; padding: .8rem 1rem; margin: 0 0 1.5rem; }
.bar { border-radius: 5px; overflow: hidden; display: block; }
.split { display: flex; gap: 2rem; align-items: center; flex-wrap: wrap; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; padding: .42rem .6rem; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.swatch { display: inline-block; width: .72rem; height: .72rem; border-radius: 3px; margin-right: .5rem; vertical-align: -1px; }
details { margin-top: 2rem; }
summary { cursor: pointer; color: var(--muted); }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .9rem; overflow-x: auto; font-size: .85rem; }
footer { color: var(--muted); font-size: .82rem; margin-top: 3rem; border-top: 1px solid var(--line); padding-top: 1rem; }
blockquote { margin: 1rem 0; padding: .1rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
code { background: var(--panel); border-radius: 3px; padding: .1rem .3rem; font-size: .88em; }
pre code { background: none; padding: 0; }
h3 { font-size: .98rem; margin: 1.6rem 0 .5rem; }
h4 { font-size: .9rem; margin: 1.3rem 0 .4rem; color: var(--muted); }
li { margin: .2rem 0; }
hr { border: none; border-top: 1px solid var(--line); margin: 1.6rem 0; }
a { color: #4f8ef7; }
`;

/** One document: no scripts, no fonts, no network. */
export function htmlReport(opts: { title: string; subtitle?: string; verdict?: string; sections: Section[]; mermaid?: string; generatedAt?: Date }): string {
  const when = (opts.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 19);
  const sections = opts.sections.map((s) => `<h2>${escapeHtml(s.title)}</h2>\n${s.html}`).join("\n");
  const mermaid = opts.mermaid
    ? `<details><summary>Mermaid source, for pasting into a document</summary><pre>${escapeHtml(opts.mermaid)}</pre></details>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLE}</style></head>
<body><main>
<h1>${escapeHtml(opts.title)}</h1>
${opts.subtitle ? `<p class="sub">${escapeHtml(opts.subtitle)}</p>` : ""}
${opts.verdict ? `<p class="verdict">${escapeHtml(opts.verdict)}</p>` : ""}
${sections}
${mermaid}
<footer>Generated by kernal at ${escapeHtml(when)} UTC. This file is self-contained: no scripts, no network.</footer>
</main></body></html>
`;
}
