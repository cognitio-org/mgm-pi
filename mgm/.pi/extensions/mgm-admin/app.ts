/**
 * The /admin page: one HTML shell, one stylesheet, one script, all served by the extension itself.
 * No framework, no build step, no CDN and no web fonts, so it works offline and under pi's compiled
 * binary. The look extends the house palette of the HTML reports (mgm-context/report.ts: THEME) into
 * an app shell: left navigation, cards, status pills, light and dark from the OS setting.
 *
 * The script builds the DOM with textContent only (never innerHTML with data), so nothing the server
 * returns — a model id, a provider's error text — can become markup. It is written without template
 * literals so it can live inside this file as a String.raw.
 */
import { THEME } from "../mgm-context/report.ts";

const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}: ${v};`).join(" ");

const MARK = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="${THEME.accent}"/><path d="M8 22V11l4.5 6 3.5-5 3.5 5L24 11v11" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const FAVICON = MARK.replace(' width="28" height="28" aria-hidden="true"', ' xmlns="http://www.w3.org/2000/svg"');

export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>mgm admin</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="side">
    <div class="brand">${MARK}<div class="brand-text"><strong>mgm</strong><span>admin</span></div></div>
    <nav aria-label="Sections"><ul id="nav" class="nav"></ul></nav>
    <div class="side-foot" id="server"></div>
  </aside>
  <main id="main" tabindex="-1"><div id="view" class="view" aria-live="polite" aria-busy="true"></div></main>
</div>
<div id="toasts" class="toasts" role="status" aria-live="polite"></div>
<script src="/app.js"></script>
</body></html>
`;

export const APP_CSS = `
:root {
  color-scheme: light dark;
  ${vars(THEME.light)}
  --accent: ${THEME.accent}; --accent-ink: #1d5bd6; --accent-soft: rgba(79, 142, 247, .12); --on-accent: #ffffff;
  --side: #f6f7f9; --card: #ffffff; --field: #ffffff; --field-line: #cfd4dc; --hover: rgba(15, 23, 42, .045); --sel: rgba(79, 142, 247, .10);
  --ok: #157a3a; --ok-soft: #e6f5eb; --warn: #9a5b06; --warn-soft: #fbf1db; --err: #b4232a; --err-soft: #fcebeb; --off: #5f6671; --off-soft: #eef0f3;
  --shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 1px 3px rgba(16, 24, 40, .05);
  --ring: 0 0 0 3px rgba(79, 142, 247, .35);
  --r: 10px; --r-sm: 7px;
  --font: ${THEME.font};
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    ${vars(THEME.dark)}
    --accent-ink: #86b1ff; --accent-soft: rgba(79, 142, 247, .16); --on-accent: #ffffff;
    --side: #17181a; --card: #1c1e20; --field: #141517; --field-line: #3a3e43; --hover: rgba(255, 255, 255, .045); --sel: rgba(79, 142, 247, .14);
    --ok: #5fd08a; --ok-soft: rgba(95, 208, 138, .12); --warn: #f2bb4b; --warn-soft: rgba(242, 187, 75, .12); --err: #ff8a8a; --err-soft: rgba(255, 138, 138, .12); --off: #a3a9b1; --off-soft: rgba(163, 169, 177, .12);
    --shadow: 0 0 0 1px rgba(255, 255, 255, .02);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--accent-ink); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: .92em; }
:focus-visible { outline: none; box-shadow: var(--ring); }
.skip { position: absolute; left: -999px; top: 8px; background: var(--card); padding: 6px 10px; border-radius: var(--r-sm); z-index: 10; }
.skip:focus { left: 8px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- shell ---------- */
.shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
.side { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; padding: 18px 12px 14px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 2px 8px 18px; }
.brand-text { display: flex; flex-direction: column; line-height: 1.1; }
.brand-text strong { font-size: 15px; letter-spacing: -.01em; }
.brand-text span { color: var(--muted); font-size: 12px; }
.nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: var(--r-sm); color: var(--fg); font-weight: 500; text-decoration: none; }
.nav a svg { color: var(--muted); flex: none; }
.nav a:hover { background: var(--hover); }
.nav a[aria-current="page"] { background: var(--sel); color: var(--accent-ink); }
.nav a[aria-current="page"] svg { color: var(--accent-ink); }
.nav .dot { margin-left: auto; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
.side-foot { margin-top: auto; padding: 12px 10px 2px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
.side-foot .row { display: flex; align-items: center; gap: 8px; }
.live { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); flex: none; }
.live.dead { background: var(--err); box-shadow: 0 0 0 3px var(--err-soft); }
main { min-width: 0; outline: none; }
.view { max-width: 980px; margin: 0 auto; padding: 36px 40px 120px; }

/* ---------- page head ---------- */
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 26px; flex-wrap: wrap; }
.head h1 { font-size: 22px; line-height: 1.25; margin: 0 0 4px; letter-spacing: -.015em; font-weight: 650; }
.head p { margin: 0; color: var(--muted); max-width: 62ch; }
.head .actions { display: flex; gap: 8px; }

/* ---------- cards ---------- */
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); margin-bottom: 18px; }
.card-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px 0; }
.card-head h2 { font-size: 15px; margin: 0; font-weight: 620; letter-spacing: -.005em; }
.card-head .desc { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
.card-head .grow { flex: 1; min-width: 0; }
.card-body { padding: 8px 20px 16px; }
.card-foot { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 55%, transparent); border-radius: 0 0 var(--r) var(--r); flex-wrap: wrap; }

.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { padding: 16px 18px; margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.stat .k { color: var(--muted); font-size: 12px; font-weight: 550; display: flex; align-items: center; gap: 6px; }
.stat .v { font-size: 20px; font-weight: 650; letter-spacing: -.02em; line-height: 1.2; overflow-wrap: anywhere; }
.stat .v.mono { font-size: 15px; font-weight: 600; letter-spacing: 0; }
.stat .s { color: var(--muted); font-size: 12.5px; }
.stat .conn { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; }
.stat .conn > span:first-child { white-space: nowrap; }

/* ---------- rows ---------- */
.rows { display: flex; flex-direction: column; }
.row-f { display: grid; grid-template-columns: minmax(170px, 34%) minmax(0, 1fr); gap: 6px 24px; padding: 14px 0; border-top: 1px solid var(--line); align-items: start; }
.row-f:first-child { border-top: none; }
.row-f > .lab { padding-top: 7px; }
.row-f label, .row-f .lab-t { font-weight: 560; display: block; }
.row-f .help { color: var(--muted); font-size: 12.5px; margin-top: 2px; line-height: 1.45; }
.row-f .ctl { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.inline > input, .inline > select { flex: 1 1 220px; }
dl.kv { display: grid; grid-template-columns: minmax(130px, 28%) minmax(0, 1fr); margin: 0; }
dl.kv dt, dl.kv dd { padding: 9px 0; border-top: 1px solid var(--line); margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { overflow-wrap: anywhere; }
dl.kv dt:first-of-type, dl.kv dd:first-of-type { border-top: none; }

/* ---------- controls ---------- */
input[type=text], input[type=url], input[type=password], input[type=number], input[type=search], select {
  width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--field-line); border-radius: var(--r-sm); background: var(--field); transition: border-color .12s, box-shadow .12s; min-width: 0; }
input.mono { font-family: var(--mono); font-size: 13px; }
input:hover, select:hover { border-color: color-mix(in srgb, var(--field-line) 60%, var(--fg)); }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
input[readonly] { background: var(--panel); color: var(--muted); }
input[aria-invalid=true], select[aria-invalid=true] { border-color: var(--err); }
input[aria-invalid=true]:focus { box-shadow: 0 0 0 3px var(--err-soft); }
.changed input, .changed select { border-color: color-mix(in srgb, var(--accent) 65%, var(--field-line)); }
.err { color: var(--err); font-size: 12.5px; display: flex; gap: 6px; align-items: flex-start; }
.warn-t { color: var(--warn); font-size: 12.5px; }
.note { color: var(--muted); font-size: 12.5px; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 14px; border-radius: var(--r-sm); border: 1px solid var(--field-line); background: var(--card); font-weight: 560; cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s; }
.btn:hover { background: var(--hover); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.primary:hover { background: color-mix(in srgb, var(--accent) 88%, #000); }
.btn.danger { color: var(--err); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn.ghost:hover { background: var(--hover); color: var(--fg); }
.btn.sm { height: 28px; padding: 0 10px; font-size: 13px; }
.btn .spin, .spin { width: 13px; height: 13px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin, .btn .spin { animation-duration: 2.4s; } * { transition: none !important; } }

.row-f label.switch, .switch { position: relative; display: inline-flex; font-weight: 450; align-items: center; gap: 10px; cursor: pointer; user-select: none; min-height: 34px; }
.switch input { position: absolute; opacity: 0; width: 36px; height: 20px; margin: 0; cursor: pointer; }
.switch .track { width: 36px; height: 20px; border-radius: 999px; background: var(--field-line); position: relative; transition: background .15s; flex: none; }
.switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { box-shadow: var(--ring); }
.switch input:disabled + .track { opacity: .5; }

.secret { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.secret .inline { flex: 1; flex-wrap: nowrap; }
.btn.ghost.danger { color: var(--err); }
.btn.ghost.danger:hover { background: var(--err-soft); color: var(--err); }
.note svg { vertical-align: -2px; margin-right: 2px; }
.chip { font-family: var(--mono); font-size: 12.5px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }

/* ---------- pills ---------- */
.pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--off-soft); color: var(--off); }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.error { background: var(--err-soft); color: var(--err); }
.pill.busy::before { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .25; } }
.tag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 5px; font-size: 11.5px; font-weight: 600; background: var(--panel); color: var(--muted); border: 1px solid var(--line); }
.tag.accent { background: var(--accent-soft); color: var(--accent-ink); border-color: transparent; }

.callout { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--r-sm); font-size: 13px; margin: 8px 0; background: var(--panel); border: 1px solid var(--line); }
.callout.error { background: var(--err-soft); border-color: transparent; color: var(--err); }
.callout.warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.callout.info { background: var(--accent-soft); border-color: transparent; color: var(--accent-ink); }
.callout svg { flex: none; margin-top: 2px; }
.callout .t { color: inherit; }

.test { display: flex; align-items: center; gap: 10px; min-height: 28px; font-size: 13px; color: var(--muted); flex-wrap: wrap; }
.test .d { overflow-wrap: anywhere; }

.meter { height: 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); overflow: hidden; }
.meter > i { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width .4s; }
.meter.warn > i { background: var(--warn); }
.meter.error > i { background: var(--err); }

/* ---------- model list ---------- */
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
.toolbar input { max-width: 360px; }
.group-h { display: flex; align-items: center; gap: 10px; padding: 14px 20px 8px; }
.group-h h3 { margin: 0; font-size: 13px; font-weight: 620; }
.group-h .n { color: var(--muted); font-size: 12px; }
.group-h .grow { flex: 1; }
.lbl-short { display: none; }
.mlist { list-style: none; margin: 0; padding: 0 8px 8px; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 2px 6px; }
.mlist button { width: 100%; display: flex; align-items: center; gap: 8px; text-align: left; padding: 7px 12px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; cursor: pointer; font-family: var(--mono); font-size: 13px; min-height: 34px; }
.mlist button:hover { background: var(--hover); }
.mlist button[aria-pressed=true] { background: var(--sel); border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent-ink); }
.mlist .id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 28px 20px; color: var(--muted); text-align: center; }

table.t { width: 100%; border-collapse: collapse; font-size: 13.5px; }
table.t th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); }
table.t td { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
table.t tr:last-child td { border-bottom: none; }

details.raw summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 4px 0; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px; overflow: auto; font: 12.5px/1.5 var(--mono); margin: 8px 0 0; }

/* ---------- save bar ---------- */
.savebar { position: sticky; bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; margin-top: 8px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(16, 24, 40, .12), 0 2px 6px rgba(16, 24, 40, .06); }
.savebar .state { display: flex; align-items: center; gap: 8px; flex: 1; font-weight: 560; }
.savebar .state .d { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.savebar.dirty .state .d { background: var(--warn); }
.savebar .state small { color: var(--muted); font-weight: 400; }

.toasts { position: fixed; right: 20px; top: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 20; max-width: min(420px, calc(100vw - 32px)); }
.toast { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--ok); border-radius: var(--r-sm); padding: 10px 14px; box-shadow: 0 8px 24px rgba(16, 24, 40, .14); font-size: 13px; animation: in .18s ease-out; }
.toast.error { border-left-color: var(--err); }
.toast.warn { border-left-color: var(--warn); }
@keyframes in { from { transform: translateY(-6px); opacity: 0; } }

.gone { max-width: 460px; margin: 18vh auto; text-align: center; padding: 0 20px; }
.gone h1 { font-size: 20px; margin: 16px 0 6px; }
.gone p { color: var(--muted); }
.skel { background: linear-gradient(90deg, var(--panel), var(--hover), var(--panel)); border-radius: 6px; height: 14px; margin: 10px 0; }

/* ---------- narrow ---------- */
@media (max-width: 1240px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .shell { grid-template-columns: 1fr; }
  .side { position: sticky; top: 0; height: auto; flex-direction: row; align-items: center; padding: 8px 10px; border-right: none; border-bottom: 1px solid var(--line); z-index: 6; gap: 8px; }
  .brand { padding: 0 4px; }
  .brand-text { display: none; }
  nav { flex: 1; min-width: 0; overflow-x: auto; }
  .nav { flex-direction: row; }
  .nav a { padding: 6px 10px; white-space: nowrap; }
  .nav a .lbl-long { display: none; }
  .nav a .lbl-short { display: inline; }
  .side-foot { display: none; }
  .view { padding: 22px 16px 110px; }
  .row-f { grid-template-columns: 1fr; gap: 8px; }
  .row-f > .lab { padding-top: 0; }
  dl.kv { grid-template-columns: 1fr; }
  dl.kv dd { border-top: none; padding-top: 0; }
  .stats { grid-template-columns: 1fr; }
  .card-head, .card-body, .card-foot { padding-left: 16px; padding-right: 16px; }
}
@media (max-width: 460px) { .nav a svg { display: none; } }
`;

export const APP_JS = String.raw`(function () {
"use strict";

// ---------- token: from the URL fragment once, then this tab's sessionStorage ----------
var TOKEN_KEY = "mgm-admin-token";
var token = "";
(function () {
  var m = location.hash.match(/[#&]t=([A-Za-z0-9_-]{20,})/);
  if (m) {
    token = m[1];
    var start = location.hash.match(/[#&]p=([a-z]+)/);
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    history.replaceState(null, "", location.pathname + "#/" + (start ? start[1] : "overview"));
  } else {
    try { token = sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) {}
  }
})();

// ---------- DOM helpers: textContent only, so server data never becomes markup ----------
function el(tag, props) {
  var node = document.createElement(tag);
  props = props || {};
  for (var k in props) {
    var v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "on") { for (var ev in v) node.addEventListener(ev, v[ev]); }
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = !!v;
    else if (k === "disabled") node.disabled = !!v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (var i = 2; i < arguments.length; i++) add(node, arguments[i]);
  return node;
}
function add(node, child) {
  if (child === undefined || child === null || child === false) return;
  if (Array.isArray(child)) { child.forEach(function (c) { add(node, c); }); return; }
  node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

var ICONS = {
  overview: '<path d="M3 3h6v8H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 13h6v4H3z"/>',
  connections: '<path d="M7 13l-2 2a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0M13 7l2-2a2.8 2.8 0 0 1 4 4l-3 3a2.8 2.8 0 0 1-4 0M7.5 12.5l5-5"/>',
  model: '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 1.5v3M12 1.5v3M8 15.5v3M12 15.5v3M1.5 8h3M1.5 12h3M15.5 8h3M15.5 12h3"/>',
  index: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l5 5M6 8.5h5M8.5 6v5"/>',
  subagents: '<circle cx="10" cy="4.5" r="2.5"/><circle cx="4" cy="15.5" r="2.5"/><circle cx="16" cy="15.5" r="2.5"/><path d="M10 7v3M10 10l-5 3.5M10 10l5 3.5"/>',
  power: '<path d="M10 2v7M5.5 4.8a7 7 0 1 0 9 0"/>',
  alert: '<circle cx="10" cy="10" r="8"/><path d="M10 6v5M10 14h.01"/>',
  info: '<circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
  refresh: '<path d="M16.5 9.5a6.5 6.5 0 1 1-2-4.7M16.5 2.5v4h-4"/>'
};
function icon(name, size) {
  var s = size || 16;
  var span = document.createElement("span");
  span.style.display = "inline-flex";
  span.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  return span.firstChild;
}
function pill(kind, text, busy) { return el("span", { class: "pill " + (kind || "off") + (busy ? " busy" : "") }, text); }
function spinner() { return el("span", { class: "spin", "aria-hidden": "true" }); }
function fmt(n) { return typeof n === "number" ? n.toLocaleString("en-US") : "—"; }
function kTokens(n) { return typeof n === "number" ? (n >= 1000 ? Math.round(n / 1000) + "k" : String(n)) : "—"; }

function toast(text, kind) {
  var box = document.getElementById("toasts");
  var t = el("div", { class: "toast " + (kind || "") }, text);
  box.appendChild(t);
  setTimeout(function () { t.remove(); }, kind === "error" ? 9000 : 5000);
}

// ---------- API ----------
var alive = true;
function api(method, path, body, poll) {
  var headers = { "x-mgm-admin-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (poll) headers["x-mgm-poll"] = "1";
  return fetch("/api" + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { gone("This page's session has ended", "Run /admin in mgm to open a fresh one."); throw new Error("unauthorised"); }
        if (!res.ok) { var e = new Error(data.error || ("HTTP " + res.status)); e.data = data; e.status = res.status; throw e; }
        return data;
      });
    }, function (err) {
      gone("The admin server has stopped", "It stops when mgm exits, after 15 minutes without use, or on /admin stop. Run /admin to start it again.");
      throw err;
    });
}
function gone(title, text) {
  if (!alive) return;
  alive = false;
  var dot = document.querySelector(".live"); if (dot) dot.classList.add("dead");
  document.body.replaceChildren(el("div", { class: "gone" }, icon("power", 28), el("h1", { text: title }), el("p", { text: text })));
}

// ---------- navigation and the unsaved-changes guard ----------
var PAGES = [
  { id: "overview", label: "Overview", icon: "overview", render: renderOverview },
  { id: "connections", label: "Connections", icon: "connections", render: renderConnections },
  { id: "model", label: "Model", icon: "model", render: renderModel },
  { id: "index", label: "Codebase index", short: "Index", icon: "index", render: renderIndex },
  { id: "subagents", label: "Subagents", icon: "subagents", render: renderSubagents }
];
var dirty = null;   // a function returning the number of unsaved changes on the current page
var cleanup = [];
var current = "";

function route() { var m = location.hash.match(/^#\/([a-z]+)/); var id = m ? m[1] : "overview"; return PAGES.some(function (p) { return p.id === id; }) ? id : "overview"; }
function buildNav() {
  var nav = clear(document.getElementById("nav"));
  PAGES.forEach(function (p) {
    // On a narrow window the long label gives way to the short one; screen readers get the long one.
    var a = el("a", { href: "#/" + p.id, id: "nav-" + p.id, "aria-label": p.label }, icon(p.icon),
      el("span", { class: p.short ? "lbl-long" : null }, p.label), p.short ? el("span", { class: "lbl-short", "aria-hidden": "true" }, p.short) : null);
    nav.appendChild(el("li", {}, a));
  });
}
function markNav() {
  PAGES.forEach(function (p) {
    var a = document.getElementById("nav-" + p.id);
    if (!a) return;
    if (p.id === current) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}
function show() {
  var next = route();
  if (dirty && dirty() > 0 && next !== current) {
    if (!confirm("You have unsaved changes on this page. Leave without saving?")) { history.replaceState(null, "", "#/" + current); return; }
  }
  cleanup.forEach(function (f) { try { f(); } catch (e) {} });
  cleanup = []; dirty = null;
  current = next; markNav();
  var view = clear(document.getElementById("view"));
  view.setAttribute("aria-busy", "true");
  var page = PAGES.filter(function (p) { return p.id === current; })[0];
  document.title = page.label + " · mgm admin";
  page.render(view);
}
window.addEventListener("hashchange", show);
window.addEventListener("beforeunload", function (e) { if (dirty && dirty() > 0) { e.preventDefault(); e.returnValue = ""; } });

// ---------- shared pieces ----------
function head(title, text, actions) {
  return el("div", { class: "head" }, el("div", {}, el("h1", { text: title }), text ? el("p", {}, text) : null), actions ? el("div", { class: "actions" }, actions) : null);
}
function card(title, desc, right, body, foot) {
  return el("section", { class: "card", "aria-label": title },
    el("div", { class: "card-head" }, el("div", { class: "grow" }, el("h2", { text: title }), desc ? el("p", { class: "desc" }, desc) : null), right || null),
    el("div", { class: "card-body" }, body),
    foot ? el("div", { class: "card-foot" }, foot) : null);
}
function loading(view) { add(view, el("div", { class: "card" }, el("div", { class: "card-body" }, el("div", { class: "skel" }), el("div", { class: "skel" }), el("div", { class: "skel" })))); }
function failed(view, err) { clear(view); add(view, el("div", { class: "callout error", role: "alert" }, icon("alert"), el("div", { class: "t", text: "Could not load this page: " + (err && err.message || err) }))); view.setAttribute("aria-busy", "false"); }
function callout(kind, text) { return el("div", { class: "callout " + kind, role: kind === "error" ? "alert" : null }, icon(kind === "info" ? "info" : "alert"), el("div", { class: "t", text: text })); }
function kv(pairs) { var dl = el("dl", { class: "kv" }); pairs.forEach(function (p) { if (p) add(dl, [el("dt", { text: p[0] }), el("dd", {}, p[1])]); }); return dl; }

/** A labelled form row: the label is a real <label for>, help and the error are tied to the control. */
function frow(id, label, help, control, extra) {
  var errId = id + "-err", helpId = id + "-help";
  var errBox = el("div", { class: "err", id: errId, hidden: true });
  var target = control.querySelector ? (control.matches && control.matches("input,select") ? control : control.querySelector("input,select")) : null;
  if (target) { target.id = target.id || id; target.setAttribute("aria-describedby", helpId + " " + errId); }
  var row = el("div", { class: "row-f" },
    el("div", { class: "lab" }, el("label", { for: target ? target.id : null, text: label }), help ? el("div", { class: "help", id: helpId, text: help.charAt(0).toUpperCase() + help.slice(1) + (/[.!?)]$/.test(help) ? "" : ".") }) : null),
    el("div", { class: "ctl" }, control, extra || null, errBox));
  row.setError = function (msg, warn) {
    errBox.hidden = !msg; clear(errBox);
    errBox.className = warn ? "warn-t" : "err";
    if (msg) add(errBox, [warn ? null : icon("alert", 14), el("span", { text: msg })]);
    if (target) target.setAttribute("aria-invalid", msg && !warn ? "true" : "false");
  };
  return row;
}

/** Tracks initial vs current values for a page, and draws the sticky save bar. */
function formState(onSave, onDiscard) {
  var initial = {}, now = {};
  var bar = el("div", { class: "savebar", role: "region", "aria-label": "Save changes" });
  var stateText = el("span", {}), small = el("small", {});
  var saveBtn = el("button", { class: "btn primary", type: "button" }, "Save changes");
  var discardBtn = el("button", { class: "btn ghost", type: "button" }, "Discard");
  add(bar, [el("div", { class: "state" }, el("span", { class: "d", "aria-hidden": "true" }), stateText, small), discardBtn, saveBtn]);
  var rows = {};
  function count() { var n = 0; for (var k in now) if (JSON.stringify(now[k]) !== JSON.stringify(initial[k])) n++; return n; }
  function paint() {
    var n = count();
    bar.classList.toggle("dirty", n > 0);
    stateText.textContent = n ? (n === 1 ? "1 unsaved change" : n + " unsaved changes") : "All changes saved";
    saveBtn.disabled = n === 0; discardBtn.disabled = n === 0;
    for (var k in rows) rows[k].classList.toggle("changed", JSON.stringify(now[k]) !== JSON.stringify(initial[k]));
    var dot = document.querySelector("#nav-" + current + " .dot");
    var a = document.getElementById("nav-" + current);
    if (n && a && !dot) a.appendChild(el("span", { class: "dot", "aria-label": "unsaved changes" }));
    if (!n && dot) dot.remove();
  }
  saveBtn.addEventListener("click", function () {
    var changes = {}; for (var k in now) if (JSON.stringify(now[k]) !== JSON.stringify(initial[k])) changes[k] = now[k];
    saveBtn.disabled = true; saveBtn.replaceChildren(spinner(), "Saving");
    Promise.resolve(onSave(changes)).then(function (ok) {
      saveBtn.replaceChildren("Save changes");
      if (ok) small.textContent = " · saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      paint();
    }, function () { saveBtn.replaceChildren("Save changes"); paint(); });
  });
  discardBtn.addEventListener("click", function () { onDiscard(); });
  document.addEventListener("keydown", keySave);
  cleanup.push(function () { document.removeEventListener("keydown", keySave); var d = document.querySelector(".nav .dot"); if (d) d.remove(); });
  function keySave(e) { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (count()) saveBtn.click(); } }
  dirty = count;
  return {
    bar: bar,
    track: function (key, value, row) { initial[key] = value; now[key] = value; if (row) rows[key] = row; paint(); },
    set: function (key, value) { now[key] = value; paint(); },
    get: function (key) { return now[key]; },
    commit: function () { for (var k in now) initial[k] = now[k]; paint(); },
    count: count, paint: paint
  };
}

// ---------- server card in the sidebar ----------
var serverInfo = null;
function paintServer() {
  var box = clear(document.getElementById("server"));
  if (!serverInfo) return;
  var mins = Math.max(0, Math.round(serverInfo.idleRemaining / 60000));
  add(box, [
    el("div", { class: "row" }, el("span", { class: "live", "aria-hidden": "true" }), el("span", {}, "Local only · ", el("span", { class: "mono", text: location.host }))),
    el("div", {}, "Stops after " + Math.round(serverInfo.idleMs / 60000) + " min idle" + (mins < Math.round(serverInfo.idleMs / 60000) ? " (" + mins + " left)" : "")),
    el("button", { class: "btn sm", type: "button", on: { click: stopServer } }, icon("power", 14), "Stop server")
  ]);
}
function stopServer() {
  if (!confirm("Stop the admin server? Run /admin in mgm to start it again.")) return;
  api("POST", "/stop", {}).then(function () { gone("Admin server stopped", "Run /admin in mgm to start it again."); }, function () {});
}
function ping() { if (!alive) return; api("GET", "/ping", undefined, true).then(function (d) { serverInfo = d; paintServer(); }, function () {}); }

// =====================================================================================
// Overview
// =====================================================================================
function renderOverview(view) {
  add(view, head("Overview", "What this agent is running right now."));
  loading(view);
  api("GET", "/overview").then(function (d) {
    clear(view);
    add(view, head("Overview", "What this agent is running right now.", el("button", { class: "btn", type: "button", on: { click: function () { show(); } } }, icon("refresh", 14), "Refresh")));
    var m = d.model;
    var modelCard = el("section", { class: "card stat", "aria-label": "Model" },
      el("div", { class: "k" }, icon("model", 14), "Model"),
      m ? el("div", { class: "v mono", text: m.id }) : el("div", { class: "v", text: "None yet" }),
      el("div", { class: "s", text: m ? m.provider + (d.thinking ? " · thinking " + d.thinking : "") + (m.contextWindow ? " · " + kTokens(m.contextWindow) + " window" : "") : "pick one under Model" }));
    var u = d.usage, pct = u && typeof u.percent === "number" ? u.percent : null;
    var meter = el("div", { class: "meter" + (pct >= 80 ? " error" : pct >= 50 ? " warn" : ""), role: "meter", "aria-label": "Context used", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct === null ? "0" : String(Math.round(pct)) }, el("i"));
    meter.firstChild.style.width = (pct || 0) + "%";
    var ctxCard = el("section", { class: "card stat", "aria-label": "Context" },
      el("div", { class: "k" }, icon("overview", 14), "Context"),
      el("div", { class: "v", text: pct === null ? "—" : Math.round(pct) + "%" }),
      meter,
      el("div", { class: "s", text: u && u.tokens != null ? fmt(u.tokens) + " of " + fmt(u.contextWindow) + " tokens" : "measured after the next request" }));
    var ix = d.index || {};
    var ixPill = !ix.loaded ? pill("off", "not loaded") : ix.running ? pill("ok", "indexing", true) : ix.indexed ? pill("ok", "indexed") : pill("warn", "not indexed");
    var ixCard = el("section", { class: "card stat", "aria-label": "Codebase index" },
      el("div", { class: "k" }, icon("index", 14), "Codebase index"),
      el("div", { class: "v", text: ix.indexed ? fmt(ix.chunks) + " chunks" : ix.loaded ? "No index" : "Off" }),
      el("div", { class: "s" }, ixPill, ix.indexed && ix.branch ? "  branch " + ix.branch : ""));
    var connCard = el("section", { class: "card stat", "aria-label": "Connections" },
      el("div", { class: "k" }, icon("connections", 14), "Connections"),
      (d.connections || []).map(function (c) { return el("div", { class: "conn" }, el("span", { text: c.name }), pill(c.pill, c.text)); }));
    add(view, el("div", { class: "stats" }, modelCard, ctxCard, ixCard, connCard));
    var v = d.versions || {};
    add(view, card("Versions", null, null, kv([
      ["mgm", el("span", { class: "mono", text: v.mgm })],
      ["pi", el("span", { class: "mono", text: v.pi })],
      ["Runtime", el("span", { class: "mono", text: v.runtime })],
      ["Working directory", el("span", { class: "mono", text: d.cwd })],
      ["Agent directory", el("span", { class: "mono", text: d.agentDir })],
      ["Keys file", el("span", { class: "mono", text: d.envFile })]
    ])));
    view.setAttribute("aria-busy", "false");
  }, function (e) { failed(view, e); });
}

// =====================================================================================
// Connections
// =====================================================================================
function renderConnections(view) {
  add(view, head("Connections", "Where models come from."));
  loading(view);
  api("GET", "/connections").then(function (d) { drawConnections(view, d); }, function (e) { failed(view, e); });
}
function drawConnections(view, d) {
  clear(view);
  var v = d.values;
  var fs = formState(save, function () { drawConnections(view, d); });
  var rows = {};
  var backends = {}; (d.backends || []).forEach(function (b) { backends[b.id] = b; });

  add(view, head("Connections", "Where models come from. Saved to the keys file; the providers reconnect as soon as you save, no restart."));

  function textRow(key, label, help, type, placeholder, mono) {
    var input = el("input", { type: type || "text", value: v[key] || "", placeholder: placeholder || null, class: mono ? "mono" : null, autocomplete: "off", spellcheck: "false" });
    var row = frow("f-" + key, label, help, input);
    input.addEventListener("input", function () { fs.set(key, input.value); row.setError(null); });
    fs.track(key, v[key] || "", row);
    rows[key] = row;
    return row;
  }
  function secretRow(key, label, help) {
    var masked = v[key];
    var isSet = masked && masked !== "—";
    var box = el("div", { class: "secret" });
    var row = frow("f-" + key, label, help, box);
    fs.track(key, "", row);
    rows[key] = row;
    function idle() {
      clear(box); fs.set(key, "");
      add(box, [
        isSet ? el("span", { class: "chip", text: masked, title: "Only the last four characters are ever shown" }) : el("span", { class: "note", text: "Not set" }),
        el("button", { class: "btn sm", type: "button", on: { click: editing } }, isSet ? "Replace" : "Add key"),
        isSet ? el("button", { class: "btn sm ghost danger", type: "button", on: { click: removing } }, "Remove") : null
      ]);
    }
    function editing() {
      clear(box);
      var input = el("input", { type: "password", class: "mono", placeholder: "Paste the new key", autocomplete: "new-password", spellcheck: "false", "aria-label": label });
      input.id = "f-" + key;
      input.addEventListener("input", function () { fs.set(key, input.value); row.setError(null); });
      add(box, el("div", { class: "inline", style: null }, input, el("button", { class: "btn sm ghost", type: "button", on: { click: idle } }, "Cancel")));
      input.focus();
    }
    function removing() {
      clear(box); fs.set(key, { clear: true });
      add(box, [el("span", { class: "note", text: "Will be removed when you save" }), el("button", { class: "btn sm ghost", type: "button", on: { click: idle } }, "Undo")]);
    }
    idle();
    return row;
  }
  function testFoot(id) {
    var out = el("div", { class: "test", "aria-live": "polite" });
    var b = backends[id];
    if (b) add(out, [pill(b.pill, b.text), el("span", { class: "d", text: b.detail })]);
    var btn = el("button", { class: "btn sm", type: "button" }, "Test connection");
    btn.addEventListener("click", function () {
      btn.disabled = true; clear(out); add(out, [spinner(), el("span", { text: "Testing…" })]);
      var body = { backend: id };
      if (id === "litellm") { body.baseUrl = fs.get("LITELLM_BASE_URL"); if (typeof fs.get("LITELLM_AGENT_KEY") === "string") body.apiKey = fs.get("LITELLM_AGENT_KEY"); }
      if (id === "openrouter" && typeof fs.get("OPENROUTER_API_KEY") === "string") body.apiKey = fs.get("OPENROUTER_API_KEY");
      if (id === "lmstudio") body.baseUrl = fs.get("LMSTUDIO_BASE_URL");
      api("POST", "/connections/test", body).then(function (r) {
        clear(out);
        var kind = r.state === "reachable" ? "ok" : r.state === "rejected" ? "error" : r.state === "not-configured" ? "off" : "warn";
        var words = { reachable: "reachable", unreachable: "unreachable", rejected: "key rejected", "not-configured": "not configured" };
        add(out, [pill(kind, words[r.state] || r.state), el("span", { class: "d", text: r.detail })]);
        if (id === "lmstudio" && r.models) loadLocalModels();
      }, function (e) { clear(out); add(out, [pill("error", "failed"), el("span", { class: "d", text: e.message })]); })
        .then(function () { btn.disabled = false; });
    });
    return [btn, out];
  }
  function headPill(id) { var b = backends[id]; return b ? pill(b.pill, b.text) : null; }

  var datalist = el("datalist", { id: "local-models" });
  function loadLocalModels() {
    api("GET", "/connections/local-models?url=" + encodeURIComponent(fs.get("LMSTUDIO_BASE_URL") || "")).then(function (r) {
      clear(datalist); (r.models || []).forEach(function (m) { datalist.appendChild(el("option", { value: m })); });
    }, function () {});
  }

  add(view, card("LiteLLM router", "The default backend: every cloud model the agent key's team may use.", headPill("litellm"),
    el("div", { class: "rows" },
      textRow("LITELLM_BASE_URL", "Router URL", "An OpenAI-compatible base URL; /v1 is added when missing.", "url", "https://litellm.augment-code.support/v1", true),
      secretRow("LITELLM_AGENT_KEY", "Agent key", "This agent's own LiteLLM virtual key. Ask Matthew for one.")),
    testFoot("litellm")));
  add(view, card("OpenRouter", "Your own key from openrouter.ai; its models appear only when the key is accepted.", headPill("openrouter"),
    el("div", { class: "rows" }, secretRow("OPENROUTER_API_KEY", "API key", "Starts with sk-or-v1-. Paste just the key, no \"Bearer\".")),
    testFoot("openrouter")));
  var localModelRow = textRow("LMSTUDIO_MODEL", "Default local model", "Used when the server cannot be asked. Pick from what it serves.", "text", "qwen/qwen3.6-35b-a3b", true);
  localModelRow.querySelector("input").setAttribute("list", "local-models");
  add(view, card("Local model server", "LM Studio or any OpenAI-compatible server on this machine. Optional.", headPill("lmstudio"),
    el("div", { class: "rows" },
      textRow("LMSTUDIO_BASE_URL", "Server URL", "LM Studio serves one on port 1234.", "url", "http://localhost:1234/v1", true),
      localModelRow, datalist),
    testFoot("lmstudio")));
  add(view, card("You", null, null, el("div", { class: "rows" }, textRow("MGM_USER", "Your name", "Shown in the start-up banner. Takes effect at the next start.", "text", "", false))));
  add(view, fs.bar);
  loadLocalModels();
  view.setAttribute("aria-busy", "false");

  function save(changes) {
    var body = { clear: [] };
    for (var k in changes) {
      var val = changes[k];
      if (val && typeof val === "object" && val.clear) body.clear.push(k);
      else body[k] = val;
    }
    for (var r in rows) rows[r].setError(null);
    return api("POST", "/connections", body).then(function (res) {
      toast(res.message || "Saved", "ok");
      for (var w in res.warnings || {}) toast(res.warnings[w], "warn");
      (res.notes || []).forEach(function (n) { toast(n, "warn"); });
      api("GET", "/connections").then(function (fresh) { drawConnections(view, fresh); });
      return true;
    }, function (e) {
      var errs = e.data && e.data.errors;
      if (errs) { var first = null; for (var f in errs) if (rows[f]) { rows[f].setError(errs[f]); first = first || rows[f]; } if (first) { var i = first.querySelector("input"); if (i) i.focus(); } toast("Nothing saved: fix the highlighted fields", "error"); }
      else toast(e.message, "error");
      return false;
    });
  }
}

// =====================================================================================
// Model
// =====================================================================================
function renderModel(view) {
  add(view, head("Model", "The model this session talks to."));
  loading(view);
  api("GET", "/models").then(function (d) { drawModels(view, d); }, function (e) { failed(view, e); });
}
function drawModels(view, d) {
  clear(view);
  add(view, head("Model", "Choosing a model switches this session now and saves it as the default for the next start, like /connect."));
  var cur = d.current;
  add(view, card("Current", null, null, kv([
    ["In use", el("span", { class: "mono", text: cur ? cur.provider + "/" + cur.id : "none" })],
    ["Default at start", el("span", { class: "mono", text: d.default ? d.default.provider + "/" + d.default.model : "not set" })],
    ["Thinking", el("span", { text: d.thinking || "—" })]
  ])));
  var search = el("input", { type: "search", placeholder: "Filter models", "aria-label": "Filter models", autocomplete: "off" });
  add(view, el("div", { class: "toolbar" }, search));
  var lists = [];
  (d.providers || []).forEach(function (p) {
    var body;
    if (!p.registered) body = el("div", { class: "empty" }, el("div", { text: p.detail || "Not connected." }), el("a", { href: "#/connections" }, "Set it up under Connections"));
    else {
      var ul = el("ul", { class: "mlist", role: "list" });
      p.models.forEach(function (id) {
        var isCur = cur && cur.provider === p.id && cur.id === id;
        var isDef = d.default && d.default.provider === p.id && d.default.model === id;
        var btn = el("button", { type: "button", "aria-pressed": isCur ? "true" : "false", "data-id": id.toLowerCase(), title: p.id + "/" + id },
          el("span", { class: "id", text: id }), isDef ? el("span", { class: "tag", text: "default" }) : null, isCur ? el("span", { class: "tag accent", text: "in use" }) : null);
        btn.addEventListener("click", function () {
          if (isCur) return;
          btn.disabled = true; btn.appendChild(spinner());
          api("POST", "/model", { provider: p.id, id: id }).then(function () {
            toast("Switched to " + p.id + "/" + id + " and saved it as the default", "ok");
            api("GET", "/models").then(function (fresh) { drawModels(view, fresh); });
          }, function (e) { btn.disabled = false; var s = btn.querySelector(".spin"); if (s) s.remove(); toast(e.message, "error"); });
        });
        ul.appendChild(el("li", {}, btn));
      });
      lists.push(ul);
      body = p.models.length ? ul : el("div", { class: "empty", text: "No models reported." });
    }
    add(view, el("section", { class: "card", "aria-label": p.label },
      el("div", { class: "group-h" }, el("h3", { text: p.label }), el("span", { class: "n", text: p.registered ? p.models.length + " models" : "" }), el("span", { style: null, class: "grow" }), pill(p.pill, p.text)),
      body));
  });
  search.addEventListener("input", function () {
    var q = search.value.trim().toLowerCase();
    lists.forEach(function (ul) { Array.prototype.forEach.call(ul.children, function (li) { li.hidden = q && li.firstChild.getAttribute("data-id").indexOf(q) === -1; }); });
  });
  view.setAttribute("aria-busy", "false");
}

// =====================================================================================
// Codebase index
// =====================================================================================
var indexTimer = null;
function renderIndex(view) {
  add(view, head("Codebase index", "Semantic and keyword search over this repository."));
  loading(view);
  api("GET", "/index").then(function (d) { drawIndex(view, d); }, function (e) { failed(view, e); });
  cleanup.push(function () { if (indexTimer) clearTimeout(indexTimer); indexTimer = null; });
}
function statusCard(d) {
  var s = d.status;
  var right, lines = [];
  if (!d.loaded) right = pill("off", "indexer not loaded");
  else if (d.running) right = pill("ok", "indexing", true);
  else if (s && s.indexed) right = pill("ok", "indexed");
  else right = pill("warn", "not indexed");
  var pairs = [];
  if (s) {
    if (s.running && s.progress) {
      var pct = s.progress.files && s.progress.files.total ? Math.round(100 * s.progress.files.done / s.progress.files.total) : s.progress.percent;
      var meter = el("div", { class: "meter", role: "progressbar", "aria-label": "Indexing progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, el("i"));
      meter.firstChild.style.width = pct + "%";
      pairs.push(["Progress", el("div", {}, meter, el("div", { class: "note", text: s.progress.phase + " · " + pct + "%" + (s.progress.files ? " · " + s.progress.files.done + "/" + s.progress.files.total + " files" : "") }))]);
    }
    pairs.push(["Chunks", s.indexed ? fmt(s.chunks) : "none yet"]);
    if (s.branch) pairs.push(["Branch", el("span", { class: "mono", text: s.branch })]);
    if (s.mode) pairs.push(["Mode", s.mode]);
    if (s.location) pairs.push(["Store", el("span", { class: "mono", text: s.location })]);
  }
  var e = d.embeddings;
  pairs.push(["Embedding server", e ? (e.onRouter ? pill("ok", "on the router") : e.reachable ? (e.loaded === false ? pill("warn", "up, model not loaded") : pill("ok", "reachable")) : pill("error", "unreachable")) : pill("off", "not configured")]);
  pairs.push(["Settings file", el("span", {}, el("span", { class: "mono", text: d.file }), el("span", { class: "note", text: "  (" + d.scope + ")" }))]);
  if (d.knowledgeBases && d.knowledgeBases.length) pairs.push(["Knowledge bases", el("div", {}, d.knowledgeBases.map(function (k) { return el("div", { class: "mono", text: k }); }))]);
  var body = [kv(pairs)];
  if (s && s.incompatible) body.push(callout("error", "The stored vectors no longer match the settings (" + s.incompatible + "). Rebuild the index."));
  (d.problems || []).forEach(function (p) { body.push(callout("error", p)); });
  var foot = null;
  if (d.loaded) {
    var up = el("button", { class: "btn", type: "button", disabled: d.running }, s && s.indexed ? "Update index" : "Index now");
    var re = el("button", { class: "btn", type: "button", disabled: d.running }, "Rebuild from scratch");
    function run(op) {
      if (op === "rebuild" && !confirm("Rebuild the whole index? On a large repository this takes minutes; search keeps working on the old index until it finishes.")) return;
      up.disabled = re.disabled = true;
      api("POST", "/index/run", { op: op }).then(function (r) { toast(r.already ? "An index run is already going" : op === "rebuild" ? "Rebuild started" : "Update started", "ok"); pollIndex(); }, function (e2) { toast(e2.message, "error"); up.disabled = re.disabled = false; });
    }
    up.addEventListener("click", function () { run("update"); });
    re.addEventListener("click", function () { run("rebuild"); });
    foot = [up, re, el("span", { class: "note", text: "Runs the same tools the model uses." })];
  } else body.push(callout("info", "The indexer is not loaded in this agent (MGM_NO_CODEBASE_INDEX, or the package is missing). Settings can still be edited."));
  return card("Status", null, right, body, foot);
}
var indexView = null;
function pollIndex() {
  if (indexTimer) clearTimeout(indexTimer);
  indexTimer = setTimeout(function () {
    api("GET", "/index/status", undefined, true).then(function (d) {
      if (!indexView || current !== "index") return;
      var old = indexView.querySelector("#status-card");
      var fresh = statusCard(d); fresh.id = "status-card";
      if (old) old.replaceWith(fresh);
      if (d.running) pollIndex(); else toast("Index run finished", "ok");
    }, function () {});
  }, 2000);
}

function drawIndex(view, d) {
  clear(view); indexView = view;
  var fs = formState(save, function () { drawIndex(view, d); });
  var rows = {};
  var byId = {}; d.fields.forEach(function (f) { byId[f.id] = f; });
  add(view, head("Codebase index", "Semantic and keyword search over " + d.cwd + ". The same settings /index edits, with the same checks."));
  var sc = statusCard(d); sc.id = "status-card"; add(view, sc);
  if (d.running) pollIndex();
  if (d.projectFile) add(view, callout("info", "This repository has its own index settings (" + d.projectFile + ") for " + d.projectBlocks.join(", ") + ". Those win here. Edits on this page go to your user settings and apply to every project without its own."));

  function control(f) {
    var id = "f-" + f.id.replace(/\./g, "-");
    var ctl, get;
    if (f.kind === "bool") {
      var cb = el("input", { type: "checkbox", role: "switch", checked: f.value === true });
      var txt = el("span", { text: f.value === true ? "On" : "Off" });
      ctl = el("label", { class: "switch" }, cb, el("span", { class: "track", "aria-hidden": "true" }), txt);
      cb.addEventListener("change", function () { txt.textContent = cb.checked ? "On" : "Off"; fs.set(f.id, cb.checked); });
      var row = frow(id, f.label, f.help, ctl);
      cb.id = id;
      rows[f.id] = row; fs.track(f.id, f.value === true, row);
      return shadow(row, f);
    }
    if (f.kind === "choice") {
      ctl = el("select", {}, f.choices.map(function (c) { return el("option", { value: c, text: c }); }));
      ctl.value = f.value === undefined ? "" : String(f.value);
      ctl.addEventListener("change", function () { fs.set(f.id, ctl.value); rows[f.id].setError(null); });
    } else {
      ctl = el("input", { type: f.kind === "url" ? "url" : (f.kind === "number" || f.kind === "dimensions") ? "number" : "text", value: f.value === undefined ? "" : String(f.value), class: (f.kind === "url" || f.kind === "model") ? "mono" : null, min: f.min, max: f.max, step: f.id === "search.minScore" ? "0.01" : "1", autocomplete: "off", spellcheck: "false", inputmode: (f.kind === "number" || f.kind === "dimensions") ? "decimal" : null });
      ctl.addEventListener("input", function () {
        fs.set(f.id, ctl.value);
        var n = Number(ctl.value);
        var msg = null;
        if ((f.kind === "number" || f.kind === "dimensions") && ctl.value !== "") {
          if (!isFinite(n)) msg = f.label + " must be a number";
          else if (f.min !== undefined && f.min !== null && n < f.min) msg = f.label + " must be at least " + f.min;
          else if (f.max !== undefined && f.max !== null && n > f.max) msg = f.label + " must be at most " + f.max;
          else if (f.kind === "dimensions" && Math.floor(n) !== n) msg = "dimensions must be a whole number";
        }
        if (f.kind === "url" && ctl.value && !/^https?:\/\//.test(ctl.value)) msg = "the server must be an http(s) URL";
        rows[f.id].setError(msg);
      });
    }
    var r = frow(id, f.label, f.help, ctl);
    rows[f.id] = r;
    fs.track(f.id, f.value === undefined ? "" : String(f.value), r);
    return shadow(r, f);
  }
  /** A field this repository's own config declares: say so at the field, with the value that wins. */
  function shadow(row, f) {
    if (!f || !f.project) return row;
    var v = f.project.value;
    row.querySelector(".ctl").appendChild(el("div", { class: "note" }, icon("info", 13), " This repository sets ", el("code", { text: v === undefined ? "its own " + f.path[0] + " block" : String(v) }), " here, which wins in this project."));
    return row;
  }

  // Embeddings: a picker over both sources; picking sets server, model and dimensions together.
  var modelField = byId["customProvider.model"];
  var pick = el("select", {}, el("option", { value: "", text: "Loading models from the local server and the router…" }));
  pick.disabled = true;
  var typed = el("input", { type: "text", class: "mono", value: modelField.value || "", placeholder: "model id", "aria-label": "Embedding model id", hidden: true, autocomplete: "off", spellcheck: "false" });
  var pickNote = el("div", { class: "note", text: "Current: " + (modelField.value || "not set") });
  var modelRow = frow("f-customProvider-model", modelField.label, "From the local server or the router's embedding deployments. Picking one sets the server, the model and the dimensions together.", el("div", { class: "ctl" }, pick, typed), pickNote);
  rows["customProvider.model"] = modelRow;
  fs.track("embedding", null, modelRow);
  shadow(modelRow, modelField);
  var choices = [];
  api("GET", "/index/choices").then(function (c) {
    choices = c.embedding || [];
    clear(pick);
    pick.appendChild(el("option", { value: "", text: "Keep " + (modelField.value || "the current model") }));
    var local = choices.filter(function (x) { return x.source === "local"; }), router = choices.filter(function (x) { return x.source === "router"; });
    if (local.length) pick.appendChild(el("optgroup", { label: "Local server" }, local.map(function (x) { return el("option", { value: "local|" + x.id, text: x.id }); })));
    if (router.length) pick.appendChild(el("optgroup", { label: "Router" }, router.map(function (x) { return el("option", { value: "router|" + x.id, text: x.id + (x.dimensions ? "  (" + x.dimensions + "d)" : "") }); })));
    pick.appendChild(el("option", { value: "typed", text: "Another id…" }));
    pick.disabled = false;
    if (!local.length && !router.length) pickNote.textContent = "Neither the local server nor the router listed embedding models. Type an id instead.";
    drawRerankChoices(c.rerank || [], c.routerConfigured);
  }, function () { clear(pick); pick.appendChild(el("option", { value: "", text: "Could not list models" })); });
  pick.addEventListener("change", function () {
    modelRow.setError(null);
    typed.hidden = pick.value !== "typed";
    if (pick.value === "typed") { typed.focus(); fs.set("embedding", { typed: typed.value }); return; }
    if (!pick.value) { fs.set("embedding", null); pickNote.textContent = "Current: " + (modelField.value || "not set"); lockEmbedding(false); return; }
    var parts = pick.value.split("|"), choice = choices.filter(function (x) { return x.source === parts[0] && x.id === parts.slice(1).join("|"); })[0];
    fs.set("embedding", { source: choice.source, id: choice.id, dimensions: choice.dimensions });
    pickNote.textContent = choice.source === "router" ? "Uses the router's endpoint and key. " + (choice.dimensions ? choice.dimensions + " dimensions, as the router declares." : "Dimensions are measured when you save.") : "Uses the local server. Dimensions are measured when you save.";
    lockEmbedding(true);
  });
  typed.addEventListener("input", function () { fs.set("embedding", { typed: typed.value }); });

  var embedRows = el("div", { class: "rows" }, modelRow);
  var urlRow = control(byId["customProvider.baseUrl"]);
  var dimsRow = control(byId["customProvider.dimensions"]);
  var measure = el("button", { class: "btn sm", type: "button" }, "Measure");
  measure.addEventListener("click", function () {
    measure.disabled = true; measure.replaceChildren(spinner(), "Measuring");
    api("POST", "/index/detect", { baseUrl: urlRow.querySelector("input").value, model: typed.hidden ? modelField.value : typed.value }).then(function (r) {
      var inp = dimsRow.querySelector("input"); inp.value = String(r.dimensions); inp.dispatchEvent(new Event("input"));
      toast("The model returns " + r.dimensions + " dimensions", "ok");
    }, function (e) { dimsRow.setError(e.message); }).then(function () { measure.disabled = false; measure.replaceChildren("Measure"); });
  });
  var dimsInput = dimsRow.querySelector("input");
  var wrap = el("div", { class: "inline" }); dimsInput.replaceWith(wrap); add(wrap, [dimsInput, measure]);
  add(embedRows, [urlRow, dimsRow, control(byId["embeddingProvider"])]);
  function lockEmbedding(on) {
    [urlRow, dimsRow].forEach(function (r) { var i = r.querySelector("input"); i.readOnly = on; });
    measure.disabled = on;
  }
  add(view, card("Embeddings", "Changing any of these changes how text is embedded, so the index needs a rebuild afterwards.", null, embedRows));

  var groups = { search: "Search", indexing: "Indexing" };
  var descs = { search: "Query-time settings: they apply to the next search, no rebuild.", indexing: "When the index is built and kept current." };
  ["search", "indexing"].forEach(function (g) {
    var box = el("div", { class: "rows" });
    d.fields.filter(function (f) { return f.group === g; }).forEach(function (f) { add(box, control(f)); });
    add(view, card(groups[g], descs[g], null, box));
  });

  // Reranking: a switch and a model from the router's rerank deployments.
  var rrOn = byId["reranker.enabled"], rrModel = byId["reranker.model"];
  var rrCb = el("input", { type: "checkbox", role: "switch", checked: rrOn.value === true, id: "f-reranker-enabled" });
  var rrTxt = el("span", { text: rrOn.value === true ? "On" : "Off" });
  var rrRow = frow("f-reranker-enabled", rrOn.label, rrOn.help, el("label", { class: "switch" }, rrCb, el("span", { class: "track", "aria-hidden": "true" }), rrTxt));
  rrCb.id = "f-reranker-enabled";
  var rrSel = el("select", { id: "f-reranker-model" }, el("option", { value: rrModel.value || "", text: rrModel.value || "Loading the router's rerank models…" }));
  var rrModelRow = frow("f-reranker-model", rrModel.label, rrModel.help, rrSel);
  rows["reranker.enabled"] = rrRow; rows["reranker.model"] = rrModelRow;
  fs.track("reranker.enabled", rrOn.value === true, rrRow);
  fs.track("reranker.model", rrModel.value || "", rrModelRow);
  rrCb.addEventListener("change", function () { rrTxt.textContent = rrCb.checked ? "On" : "Off"; fs.set("reranker.enabled", rrCb.checked); rrRow.setError(null); });
  rrSel.addEventListener("change", function () { fs.set("reranker.model", rrSel.value); rrModelRow.setError(null); });
  var rrNote = el("div", {});
  function drawRerankChoices(list, configured) {
    clear(rrSel);
    if (!configured) { rrSel.appendChild(el("option", { value: "", text: "Needs the LiteLLM router" })); rrSel.disabled = true; rrCb.disabled = !rrCb.checked; clear(rrNote); add(rrNote, callout("info", "Reranking runs on the LiteLLM router. Add its URL and key under Connections first.")); return; }
    var have = {}; list.forEach(function (m) { have[m] = true; });
    if (rrModel.value && !have[rrModel.value]) rrSel.appendChild(el("option", { value: rrModel.value, text: rrModel.value + " (not listed now)" }));
    if (!rrModel.value) rrSel.appendChild(el("option", { value: "", text: "Choose a model" }));
    list.forEach(function (m) { rrSel.appendChild(el("option", { value: m, text: m })); });
    rrSel.value = rrModel.value || "";
  }
  add(view, card("Reranking", "A second pass that reorders results. Result snippets go to the router and its upstream provider, billed to the router key.", null,
    [el("div", { class: "rows" }, rrRow, rrModelRow), rrNote]));

  add(view, el("div", { id: "index-notes" }));
  add(view, fs.bar);
  view.setAttribute("aria-busy", "false");

  function save(changes) {
    var body = { edits: [] };
    for (var k in changes) {
      if (k === "embedding") {
        var e = changes[k];
        if (e && e.typed !== undefined) { if (e.typed.trim()) body.edits.push({ id: "customProvider.model", value: e.typed }); }
        else if (e) body.embedding = e;
      } else if (k === "reranker.enabled" || k === "reranker.model") {
        body.reranking = { enabled: fs.get("reranker.enabled"), model: fs.get("reranker.model") || undefined };
      } else body.edits.push({ id: k, value: changes[k] });
    }
    if (body.embedding) body.edits = body.edits.filter(function (x) { return x.id !== "customProvider.baseUrl" && x.id !== "customProvider.dimensions"; });
    for (var r in rows) rows[r].setError(null);
    return api("POST", "/index", body).then(function (res) {
      toast("Saved to " + res.file, "ok");
      api("GET", "/index").then(function (fresh) {
        drawIndex(view, fresh);
        var box = document.getElementById("index-notes");
        (res.notes || []).forEach(function (n) { add(box, callout(n.kind, n.text)); });
        if (box && box.firstChild) box.scrollIntoView({ block: "nearest" });
      });
      return true;
    }, function (e) {
      var errs = e.data && e.data.errors;
      if (errs) {
        for (var f in errs) (rows[f] || modelRow).setError(errs[f]);
        toast("Nothing saved: fix the highlighted settings", "error");
      } else toast(e.message, "error");
      return false;
    });
  }
}

// =====================================================================================
// Subagents (read-only for now)
// =====================================================================================
function renderSubagents(view) {
  add(view, head("Subagents", "The models pi-subagents uses for delegated work."));
  loading(view);
  api("GET", "/subagents").then(function (d) {
    clear(view);
    add(view, head("Subagents", "The models pi-subagents uses for delegated work. Read-only here for now: edit the subagents block of the settings file to change them."));
    var s = d.subagents;
    if (!s) { add(view, card("Not configured", null, pill("off", "defaults"), el("p", { class: "note", text: "No subagents block in " + d.file + ", so each subagent uses pi-subagents' own defaults (the parent's model)." }))); view.setAttribute("aria-busy", "false"); return; }
    var other = {}; for (var k in s) if (k !== "defaultModel" && k !== "agentOverrides") other[k] = s[k];
    add(view, card("Default", null, null, kv([
      ["Default model", el("span", { class: "mono", text: s.defaultModel || "the parent's model" })],
      ["Settings file", el("span", { class: "mono", text: d.file })]
    ])));
    var ov = s.agentOverrides || {};
    var names = Object.keys(ov).sort();
    var table = el("table", { class: "t" }, el("thead", {}, el("tr", {}, el("th", { text: "Agent" }), el("th", { text: "Model" }), el("th", { text: "Other settings" }))),
      el("tbody", {}, names.map(function (n) {
        var o = ov[n] || {}; var rest = {}; for (var k2 in o) if (k2 !== "model") rest[k2] = o[k2];
        return el("tr", {}, el("td", { text: n }), el("td", { class: "mono", text: o.model || "default" }), el("td", { class: "mono note", text: Object.keys(rest).length ? JSON.stringify(rest) : "" }));
      })));
    add(view, card("Per-agent overrides", names.length ? null : "None: every agent uses the default.", el("span", { class: "tag", text: names.length + " agents" }), names.length ? table : el("div")));
    if (Object.keys(other).length) add(view, card("Other settings", null, null, el("pre", { text: JSON.stringify(other, null, 2) })));
    view.setAttribute("aria-busy", "false");
  }, function (e) { failed(view, e); });
}

// ---------- start ----------
if (!token) { gone("Open this page from mgm", "Run /admin in mgm: it opens the page with a one-time key for this session."); return; }
buildNav();
show();
ping();
var pinger = setInterval(ping, 30000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) ping(); });
})();
`;
