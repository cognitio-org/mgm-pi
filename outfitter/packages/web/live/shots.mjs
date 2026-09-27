// Screenshots of every live-test step, for review after a deploy (CI uploads them as the
// `outfitter-live-screenshots` artifact on every run, pass or fail).
//
// Artifacts are readable by anyone with repository read access, and pages like the Disk Box list
// other people's floppies. So every shot masks table rows that aren't the test's own (its
// `live-test …` floppy, its "e2e (live tests)" Tape) before it's taken: only what the suite made is
// readable. Viewport-sized, not full-page, to keep the artifact small.
//
// `finish()` writes index.html (a gallery: step, test, pass or fail, time) and manifest.json next to
// the pictures.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const shots = [];
let seq = 0;

/** Table rows (Disk Box, Archive, Tapes) that don't contain any of `own`: masked in every shot. */
function othersRows(page, own) {
  let rows = page.locator(".data-table tbody tr");
  for (const text of own) rows = rows.filter({ hasNotText: text });
  return rows;
}

/** Loading indicators: a page-level spinner, or a Working bar labelled "Loading…" (not the
 * "Working" bar a running turn shows, which is a real state worth capturing). */
const LOADING = '.page-loading, .working:has-text("Loading"), .empty-state:has-text("Loading")';

/** Waits (up to `ms`) until nothing is loading, so a shot shows data rather than a spinner. Never
 * throws: a page still loading after that is captured as it is. */
async function settle(page, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await page.locator(LOADING).count().catch(() => 0)) === 0) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(250); // let the last render and any fade finish
}

/**
 * A masked screenshot of `page` as step `step` of `test`. Never throws: a failed capture is
 * recorded, not allowed to fail the test.
 */
export async function shot(page, dir, test, step, { own = [], ok = true } = {}) {
  const n = String(++seq).padStart(2, "0");
  const slug = step.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const file = `${n}-${slug}.png`;
  const entry = { n: Number(n), test, step, ok, file, at: new Date().toISOString(), path: "" };
  try {
    entry.path = new URL(page.url()).pathname;
    await mkdir(dir, { recursive: true });
    await settle(page);
    await page.screenshot({ path: join(dir, file), mask: [othersRows(page, own)], maskColor: "#444", animations: "disabled" });
  } catch (err) {
    entry.file = "";
    entry.error = String(err?.message ?? err).slice(0, 200);
  }
  shots.push(entry);
  return entry;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Writes the gallery and manifest. `meta`: {origin, release?, commit?, startedAt}. */
export async function finish(dir, meta) {
  await mkdir(dir, { recursive: true });
  const failed = shots.filter((s) => !s.ok).length;
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), shots }, null, 2));
  const cards = shots.map((s) => `
    <figure class="${s.ok ? "ok" : "fail"}">
      ${s.file ? `<a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="${esc(s.step)}" loading="lazy"></a>` : `<div class="missing">no screenshot: ${esc(s.error ?? "")}</div>`}
      <figcaption><b>${esc(String(s.n).padStart(2, "0"))} ${esc(s.step)}</b><br>${esc(s.test)} · <code>${esc(s.path)}</code> · ${esc(s.at.slice(11, 19))} UTC ${s.ok ? "" : "· <strong>FAILED</strong>"}</figcaption>
    </figure>`).join("");
  const title = `Outfitter live tests${meta.release ? ` · ${meta.release}` : ""}`;
  await writeFile(join(dir, "index.html"), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:14px/1.45 system-ui,sans-serif;margin:1.5rem;background:#111;color:#ddd}
  h1{font-size:1.2rem;margin:0 0 .25rem} p.meta{color:#999;margin:0 0 1.25rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:1rem}
  figure{margin:0;background:#1b1b1b;border:1px solid #333;border-radius:6px;overflow:hidden}
  figure.fail{border-color:#c33} img{display:block;width:100%;height:auto;border-bottom:1px solid #333}
  figcaption{padding:.5rem .7rem} code{color:#9cf} .missing{padding:2rem;color:#c66}
  strong{color:#f66}
</style>
<h1>${esc(title)}</h1>
<p class="meta">${esc(meta.origin)}${meta.commit ? ` · commit <code>${esc(meta.commit)}</code>` : ""} · ${esc(meta.startedAt)} · ${shots.length} steps, ${failed ? `<strong>${failed} failed</strong>` : "all passed"}. Other people's floppies are masked.</p>
<div class="grid">${cards}
</div>
</html>
`);
}
