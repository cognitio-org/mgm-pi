// Clipboard HTML -> GitHub-flavoured Markdown, for the composer's paste (docs/reports/
// markdown-composer.md). Lazy-loaded on the first HTML paste, so it costs the Session page nothing
// until then.
//
// Why a custom converter and not turndown + turndown-plugin-gfm (12.8 kB min / 4.7 kB gzip
// together, measured with esbuild; this chunk is 8.8 / 3.8): the GFM plugin (last released 2018)
// `keep`s any table whose first row isn't all <th> as raw HTML. Tables from Google Docs and Word
// never have <th>, tables are the point of this feature, and the draft must never contain HTML.
// Fixing that means overriding the plugin's table rules, rowspan/colspan and Word's list
// paragraphs anyway, at which point the library is carrying little of the weight.
//
// Safety: the HTML is parsed with DOMParser into an inert document (scripts don't run, images don't
// load, nothing is attached to the page) and only its text and a few structural facts are read.
// The output is plain text; nothing from the clipboard is ever inserted as markup.

type Ctx = {
  /** Inside <pre>: keep whitespace verbatim. */
  pre?: boolean;
  /** Inside a table cell: no newlines, pipes escaped. */
  cell?: boolean;
  /** Inside a heading: no bold markers (the heading is already bold). */
  heading?: boolean;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

const DROP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "SVG", "MATH", "IMG",
  "PICTURE", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "CANVAS", "BUTTON", "INPUT", "SELECT",
  "TEXTAREA", "CLIPBOARD-COPY", "O:P",
]);

const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "FIGURE",
  "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "TABLE",
  "HR", "DL", "DT", "DD", "ADDRESS", "CENTER", "DETAILS", "SUMMARY", "BODY", "FORM", "FIELDSET",
  "CAPTION", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH",
]);

/** A <br> inside running text; resolved per context when the text is flushed. */
const BR = "\uE000";

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = renderBlocks(doc.body, {});
  return blocks
    .join("\n\n")
    .replace(/[ \t]+$/gm, (m) => (m === "  " ? m : ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tag(n: Node): string {
  return n.nodeType === 1 ? (n as Element).tagName.toUpperCase() : "";
}

function style(el: Element): string {
  return (el.getAttribute("style") ?? "").toLowerCase();
}

/** Removed from the output entirely: hidden elements, Word's list bullets, Wikipedia's citation
 * markers ([14]) and edit links. */
function dropped(el: Element): boolean {
  const t = el.tagName.toUpperCase();
  if (DROP.has(t)) return true;
  if (el.hasAttribute("hidden")) return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden|mso-list\s*:\s*ignore/.test(style(el))) return true;
  const cls = el.getAttribute("class") ?? "";
  return (t === "SUP" && /\b(reference|mw-ref)\b/.test(cls)) || /\bmw-editsection\b/.test(cls);
}

function isBlock(n: Node): boolean {
  return n.nodeType === 1 && BLOCK.has(tag(n));
}

/** An inline element wrapping blocks, like Google Docs' <b id="docs-internal-guid-..."> around the
 * whole paste, is treated as a plain container. */
function wrapsBlocks(n: Node): boolean {
  return n.nodeType === 1 && Array.from(n.childNodes).some(isBlock);
}

// ---------------------------------------------------------------------------------------------
// Blocks

/** Renders an element's children as a list of Markdown blocks (joined by blank lines by callers).
 * Inline runs between block children become paragraphs. */
function renderBlocks(el: Element, ctx: Ctx): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const p = finishInline(run, ctx);
    if (p) out.push(ctx.cell ? p : escapeLineStart(p));
    run = "";
  };
  let wordList: Element[] = [];
  const flushWordList = () => {
    if (wordList.length) out.push(renderWordList(wordList, ctx));
    wordList = [];
  };
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1 && dropped(child as Element)) continue;
    if (child.nodeType === 1 && isWordListParagraph(child as Element)) {
      flush();
      // A different list id (l0, l1) is a separate list.
      if (wordList.length && wordListId(wordList[0]!) !== wordListId(child as Element)) flushWordList();
      wordList.push(child as Element);
      continue;
    }
    // Word separates its list paragraphs with whitespace and comments; they don't end the list.
    if (wordList.length && (child.nodeType === 8 || (child.nodeType === 3 && !(child.nodeValue ?? "").trim()))) continue;
    flushWordList();
    if (isBlock(child)) {
      flush();
      const b = renderBlock(child as Element, ctx);
      if (b.trim()) out.push(b);
    } else if (wrapsBlocks(child)) {
      flush();
      out.push(...renderBlocks(child as Element, ctx));
    } else if (tag(child) === "BR" && !run.trim()) {
      // A <br> between blocks (Google Docs puts them there) is spacing, not content.
    } else {
      run += renderInline(child, ctx);
    }
  }
  flush();
  flushWordList();
  return out;
}

function renderBlock(el: Element, ctx: Ctx): string {
  const t = el.tagName.toUpperCase();
  if (/^H[1-6]$/.test(t)) {
    const text = finishInline(inlineChildren(el, { ...ctx, heading: true }), { ...ctx, heading: true });
    if (!text) return "";
    return ctx.cell ? text : "#".repeat(Number(t[1])) + " " + text;
  }
  switch (t) {
    case "UL":
    case "OL":
      return renderList(el, ctx);
    case "PRE":
      return renderPre(el, ctx);
    case "BLOCKQUOTE": {
      const inner = renderBlocks(el, ctx).join("\n\n");
      if (ctx.cell) return inner;
      return inner
        .split("\n")
        .map((l) => (l ? "> " + l : ">"))
        .join("\n");
    }
    case "TABLE":
      return ctx.cell ? renderBlocks(el, ctx).join(" ") : renderTable(el);
    case "HR":
      return ctx.cell ? "" : "---";
    case "TR":
      return renderBlocks(el, ctx).join(ctx.cell ? " " : " | ");
    default:
      return renderBlocks(el, ctx).join(ctx.cell ? " " : "\n\n");
  }
}

// ---- lists

function renderList(list: Element, ctx: Ctx): string {
  const ordered = list.tagName.toUpperCase() === "OL";
  let n = Number(list.getAttribute("start") ?? "1") || 1;
  const items: string[] = [];
  for (const child of Array.from(list.children)) {
    const t = child.tagName.toUpperCase();
    if (t === "UL" || t === "OL") {
      // Google Docs nests a sub-list directly in the parent <ul>, not inside an <li>: attach it
      // to the previous item.
      const nested = indent(renderList(child, ctx), ordered ? `${n - 1}. `.length : 2);
      if (items.length) items[items.length - 1] += "\n" + nested;
      else items.push(nested);
      continue;
    }
    if (t !== "LI" || dropped(child)) continue;
    const marker = ordered ? `${n++}. ` : "- ";
    items.push(listItem(child, marker, ctx));
  }
  if (ctx.cell) return items.join("; ");
  return items.join("\n");
}

function listItem(li: Element, marker: string, ctx: Ctx): string {
  let task = "";
  const box = li.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
  if (box) task = box.hasAttribute("checked") ? "[x] " : "[ ] ";
  // Tight list: an item's paragraphs and nested lists are joined by single newlines.
  const body = renderBlocks(li, ctx).join(ctx.cell ? " " : "\n");
  if (ctx.cell) return task + body;
  return marker + task + indent(body, marker.length).trimStart();
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

/** Word (desktop) exports lists as <p class="MsoListParagraph" style="mso-list:l0 level2 lfo1">
 * with the bullet or number as text inside a mso-list:Ignore span. */
function isWordListParagraph(el: Element): boolean {
  return el.tagName.toUpperCase() === "P" && /mso-list\s*:\s*l\d+\s+level\d+/.test(style(el));
}

function wordListId(p: Element): string {
  return /mso-list\s*:\s*(l\d+)/.exec(style(p))?.[1] ?? "";
}

function renderWordList(paras: Element[], ctx: Ctx): string {
  const counters: number[] = [];
  return paras
    .map((p) => {
      const level = Number(/level(\d+)/.exec(style(p))![1]) - 1;
      const bullet = p.querySelector("[style*='mso-list'][style*='Ignore' i]")?.textContent?.trim() ?? "";
      const ordered = /^[\w]{1,4}[.)]$/.test(bullet);
      counters.length = level + 1;
      counters[level] = (counters[level] ?? 0) + 1;
      const marker = ordered ? `${counters[level]}. ` : "- ";
      const text = finishInline(inlineChildren(p, ctx), ctx);
      return "   ".repeat(level) + marker + text;
    })
    .join("\n");
}

// ---- code

const LANG_RES = [
  /(?:^|\s)(?:lang(?:uage)?-)([\w+#.-]+)/, // Prism / highlight.js / react-markdown
  /(?:^|\s)highlight-(?:source|text)-([\w+#]+)/, // GitHub
  /brush:\s*([\w+#]+)/, // Confluence / SyntaxHighlighter
];

function codeLanguage(pre: Element): string {
  const probes: Element[] = [pre];
  const code = pre.querySelector("code");
  if (code) probes.push(code);
  if (pre.parentElement) probes.push(pre.parentElement);
  for (const el of probes) {
    const attr = el.getAttribute("data-lang") ?? el.getAttribute("lang");
    if (attr && /^[\w+#.-]+$/.test(attr)) return attr.toLowerCase();
    const hay = `${el.getAttribute("class") ?? ""} ${el.getAttribute("data-syntaxhighlighter-params") ?? ""}`;
    for (const re of LANG_RES) {
      const m = re.exec(hay);
      if (m) return m[1]!.toLowerCase();
    }
  }
  return "";
}

function preText(el: Node): string {
  let s = "";
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3) s += c.nodeValue ?? "";
    else if (c.nodeType === 1) {
      if (dropped(c as Element)) continue;
      const t = tag(c);
      if (t === "BR") s += "\n";
      else {
        s += preText(c);
        // Some highlighters (Confluence, Docs code blocks) put each line in its own block element.
        if (t === "DIV" || t === "P" || t === "LI") s += "\n";
      }
    }
  }
  return s;
}

function renderPre(el: Element, ctx: Ctx): string {
  const text = preText(el).replace(/\u00a0/g, " ").replace(/\n+$/, "");
  if (ctx.cell) return "`" + text.replace(/\s+/g, " ").trim() + "`";
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence + codeLanguage(el) + "\n" + text + "\n" + fence;
}

// ---- tables

type Align = "" | "left" | "center" | "right";

function cellAlign(cell: Element, useStyle: boolean): Align {
  const fromStyle = useStyle ? /text-align\s*:\s*(\w+)/.exec(style(cell))?.[1] : undefined;
  const a = (cell.getAttribute("align") ?? fromStyle ?? "").toLowerCase();
  return a === "left" || a === "center" || a === "right" ? a : "";
}

function cellText(cell: Element): string {
  return renderBlocks(cell, { cell: true })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTable(table: HTMLTableElement | Element): string {
  const rows = Array.from((table as HTMLTableElement).rows ?? table.querySelectorAll("tr")).filter(
    // Only this table's rows, not a nested table's.
    (r) => r.closest("table") === table,
  );
  if (!rows.length) return "";
  // Lay the cells out on a grid so rowspan/colspan land in the right columns.
  const grid: Array<Array<{ text: string; th: boolean; align: Align; spanned: boolean }>> = [];
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of Array.from(row.children)) {
      const t = cell.tagName.toUpperCase();
      if ((t !== "TD" && t !== "TH") || dropped(cell)) continue;
      while (grid[r]![c]) c++;
      const text = cellText(cell);
      const cs = Math.max(1, Math.min(50, Number(cell.getAttribute("colspan")) || 1));
      const rs = Math.max(1, Math.min(500, Number(cell.getAttribute("rowspan")) || 1));
      for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cs; dc++) {
          // A <th>'s inline text-align is usually Chrome serialising the UA's default centring,
          // so only its align attribute counts; a <td>'s inline text-align is the author's.
          grid[r + dr]![c + dc] = { text, th: t === "TH", align: cellAlign(cell, t === "TD"), spanned: dr > 0 || dc > 0 };
        }
      }
      c += cs;
    }
  });
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return "";
  const at = (r: number, c: number) => grid[r]?.[c];

  // Header rows: the <thead> rows, else leading all-<th> rows, else the first row.
  let headRows = rows.filter((r) => r.parentElement?.tagName.toUpperCase() === "THEAD").length;
  if (!headRows) {
    while (headRows < grid.length && grid[headRows]!.length && grid[headRows]!.every((c) => !c || c.th)) headRows++;
  }
  if (!headRows || headRows >= grid.length) headRows = 1;

  // Several header rows (a "Height" spanning "m" and "ft") collapse into one: "Height m".
  const header: string[] = [];
  const aligns: Align[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (let r = 0; r < headRows; r++) {
      // Header cells render bold anyway: "**Owner**" from Docs/Word becomes "Owner".
      const t = (at(r, c)?.text ?? "").replace(/^\*\*(.*)\*\*$/, "$1");
      if (t && parts[parts.length - 1] !== t) parts.push(t);
    }
    header.push(parts.join(" "));
    // A column's alignment: what all its body cells agree on, else the header cell's.
    const body = new Set(grid.slice(headRows).map((row) => row[c]?.align ?? ""));
    const agreed = body.size === 1 ? [...body][0]! : "";
    aligns.push(agreed || at(headRows - 1, c)?.align || "");
  }
  const body = grid.slice(headRows).map((row) => {
    const cells: string[] = [];
    // A spanned body cell is left empty rather than repeated.
    for (let c = 0; c < width; c++) cells.push(row[c] && !row[c]!.spanned ? row[c]!.text : "");
    return cells;
  });
  // Drop columns that are empty everywhere (image-only columns, row-number gutters).
  const keep = header.map((_, c) => header[c] !== "" || body.some((r) => r[c] !== ""));
  const pick = <T,>(xs: T[]) => xs.filter((_, c) => keep[c]);
  const all = [pick(header), ...body.map(pick)];
  const al = pick(aligns);
  if (!all[0]!.length) return "";

  // Pad columns so the source reads as a table too, unless that would make lines very long.
  const widths = all[0]!.map((_, c) => Math.max(3, ...all.map((r) => r[c]!.length)));
  const pad = widths.reduce((a, b) => a + b + 3, 1) <= 120;
  const line = (cells: string[]) =>
    "| " + cells.map((t, c) => (pad ? t.padEnd(widths[c]!) : t)).join(" | ") + " |";
  const delim =
    "| " +
    al
      .map((a, c) => {
        const w = pad ? widths[c]! : 3;
        if (a === "center") return ":" + "-".repeat(w - 2) + ":";
        if (a === "right") return "-".repeat(w - 1) + ":";
        if (a === "left") return ":" + "-".repeat(w - 1);
        return "-".repeat(w);
      })
      .join(" | ") +
    " |";

  const caption = table.querySelector(":scope > caption");
  const cap = caption ? finishInline(inlineChildren(caption, {}), {}) : "";
  const md = [line(all[0]!), delim, ...all.slice(1).map(line)].join("\n");
  return cap ? `${escapeLineStart(cap)}\n\n${md}` : md;
}

// ---------------------------------------------------------------------------------------------
// Inline

function inlineChildren(el: Node, ctx: Ctx): string {
  let s = "";
  for (const c of Array.from(el.childNodes)) s += renderInline(c, ctx);
  return s;
}

/** Collapses whitespace, resolves <br>s and trims one run of inline Markdown. */
function finishInline(s: string, ctx: Ctx): string {
  const br = ctx.cell || ctx.heading ? " " : "  \n";
  return s
    .replace(/[ \t\r\n\u00a0]+/g, " ")
    .replace(new RegExp(` ?${BR} ?`, "g"), BR)
    .trim()
    .replace(new RegExp(`^${BR}+|${BR}+$`, "g"), "")
    .replace(new RegExp(BR, "g"), br)
    .trim();
}

function wrap(inner: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!m[2]) return inner;
  return m[1] + marker + m[2] + marker + m[3];
}

const URL_ESC: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };

function renderInline(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) {
    const text = node.nodeValue ?? "";
    return ctx.code ? text : escapeInline(text, ctx);
  }
  if (node.nodeType !== 1) return ""; // comments (Word's <!--[if ...]-->), processing instructions
  const el = node as Element;
  if (dropped(el)) return "";
  const t = el.tagName.toUpperCase();
  const s = style(el);
  if (t === "BR") return BR;
  if (isBlock(el)) {
    // A block inside inline content (a <div> in a link, a <p> in a <span>): keep its text.
    const inner = t === "PRE" ? preText(el) : inlineChildren(el, ctx);
    return " " + inner + " ";
  }

  // Google Docs has no code style; people use a monospace font on a span.
  const monoSpan = t === "SPAN" && /font-family\s*:[^;]*(mono|courier|consolas)/.test(s);
  if (t === "CODE" || t === "KBD" || t === "SAMP" || t === "TT" || monoSpan) {
    if (ctx.code) return inlineChildren(el, ctx);
    const text = preText(el).replace(/[\s\u00a0]+/g, " ");
    if (!text.trim()) return text;
    const tick = text.includes("`") ? "``" : "`";
    const pad = text.includes("`") ? " " : "";
    const code = tick + pad + text.trim() + pad + tick;
    return ctx.cell ? code.replace(/\|/g, "\\|") : code;
  }

  if (t === "A") {
    const href = (el.getAttribute("href") ?? "").trim();
    const inner = inlineChildren(el, ctx);
    if (!inner.trim()) return "";
    if (!/^(https?:|mailto:)/i.test(href)) return inner;
    // escapeInline already escaped "["; a bare "]" would close the link text early.
    const text = finishInline(inner, { cell: true }).replace(/\]/g, "\\]");
    // encodeURIComponent leaves ( and ) alone, and an unbalanced ")" would end the destination.
    const url = href.replace(/[()\s|<>]/g, (c) => URL_ESC[c] ?? encodeURIComponent(c));
    if (text === href) return url;
    return `[${text}](${url})`;
  }

  // Google Docs wraps the whole paste in <b style="font-weight:normal">; Word writes
  // <b><span style="mso-bidi-font-weight:normal">. Explicit weights win over the tag.
  const weight = /(?:^|;|\s)font-weight\s*:\s*(\w+)/.exec(s)?.[1];
  const tagBold = t === "B" || t === "STRONG";
  const bold =
    !ctx.heading && !ctx.bold && (weight ? weight === "bold" || Number(weight) >= 600 : tagBold) && (tagBold || t === "SPAN");
  const fontStyle = /(?:^|;|\s)font-style\s*:\s*(\w+)/.exec(s)?.[1];
  const tagItalic = t === "EM" || t === "I" || t === "CITE";
  const italic = !ctx.italic && (fontStyle ? fontStyle === "italic" : tagItalic) && (tagItalic || t === "SPAN");
  const strike = t === "DEL" || t === "S" || t === "STRIKE" || (t === "SPAN" && /text-decoration[^;]*line-through/.test(s));

  let inner = inlineChildren(el, { ...ctx, bold: ctx.bold || bold, italic: ctx.italic || italic });
  if (italic) inner = wrap(inner, "*");
  if (bold) inner = wrap(inner, "**");
  if (strike) inner = wrap(inner, "~~");
  return inner;
}

/** Escapes characters that would otherwise start Markdown syntax in plain web text. Intraword
 * underscores (snake_case) are left alone; GFM never treats them as emphasis. */
function escapeInline(text: string, ctx: Ctx): string {
  // "[" (a link or image), "~" (strikethrough) and "<" before a tag-like character (raw HTML, an
  // autolink) are escaped too: literal text on a web page must stay literal, never become syntax.
  let s = text.replace(/([\\`*[~])/g, "\\$1").replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace("_", "\\_"));
  if (ctx.cell) s = s.replace(/\|/g, "\\|");
  return s;
}

/** A paragraph that happens to begin like a heading, quote or list item is escaped. */
function escapeLineStart(p: string): string {
  return p.replace(/^(#{1,6}\s|>|[-+]\s)/, "\\$1").replace(/^(\d{1,9})([.)]\s)/, "$1\\$2");
}
