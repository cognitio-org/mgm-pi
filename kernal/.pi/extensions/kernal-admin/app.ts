/**
 * The /admin page: one HTML shell, one stylesheet, one script, all served by the extension itself.
 * No framework, no build step, no CDN and no web fonts, so it works offline and under pi's compiled
 * binary. The look extends the house palette of the HTML reports (kernal-context/report.ts: THEME) into
 * an app shell: left navigation, cards, status pills, light and dark from the OS setting.
 *
 * The script builds the DOM with textContent only (never innerHTML with data), so nothing the server
 * returns — a model id, a provider's error text — can become markup. The one piece of HTML it shows is
 * the agent editor's preview, rendered by markdownToHtml (which escapes before it adds markup) and
 * rebuilt here from an allowlist of tags. It is written without template literals (a backtick is
 * String.fromCharCode(96)) so it can live inside this file as a String.raw.
 */
import { THEME } from "../kernal-context/report.ts";

const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}: ${v};`).join(" ");

const MARK = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="${THEME.accent}"/><path d="M8 22V11l4.5 6 3.5-5 3.5 5L24 11v11" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const FAVICON = MARK.replace(' width="28" height="28" aria-hidden="true"', ' xmlns="http://www.w3.org/2000/svg"');

export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>kernal admin</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="side">
    <div class="brand">${MARK}<div class="brand-text"><strong>kernal</strong><span>admin</span></div></div>
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
.mlist li.curated { display: flex; align-items: center; gap: 2px; }
.mlist li[hidden] { display: none; }
.unlisted { padding: 0 16px 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.unlisted .chip { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 12.5px; color: var(--muted); }
.mlist button.rm, .unlisted button.rm { border: 0; background: transparent; border-radius: var(--r-sm); cursor: pointer; }
.mlist button.rm { width: auto; flex: none; min-height: 28px; padding: 0 8px; font-family: inherit; color: var(--muted); }
.mlist button.rm:hover, .unlisted button.rm:hover { color: var(--err); background: var(--err-soft); }
.curate { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 4px 16px 14px; }
.curate input { flex: 1; min-width: 200px; max-width: 360px; }
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

/* ---------- subagents ---------- */
.tag.src-user { background: var(--accent-soft); color: var(--accent-ink); border-color: transparent; }
.tag.src-project { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.tag.src-package { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.tag.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.cmdline { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.cmdline code { background: var(--panel); padding: 5px 8px; border-radius: 6px; overflow-wrap: anywhere; }
.note.warnnote { color: var(--warn); }
.tag.cli { background: var(--accent-soft); color: var(--accent-ink); border-color: transparent; }
.cli-tools { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.cli-tool { border: 1px solid var(--line); border-radius: 10px; padding: 14px; display: grid; gap: 10px; align-content: start; min-width: 0; }
.cli-tool .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cli-tool h3 { margin: 0; font-size: 15px; }
.cli-tool ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.cli-tool li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.cli-tool li a { overflow-wrap: anywhere; }
.cli-tool pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; margin: 0 -2px; }
.a-name { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-weight: 600; font-size: 13px; }
.a-name > span:first-child { white-space: nowrap; }
.a-desc { color: var(--muted); font-size: 12.5px; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 60ch; }
.small { font-size: 12.5px; }
table.agents td { vertical-align: middle; }
table.agents td .mono.small { white-space: nowrap; }
.savebar.autohide:not(.dirty) { display: none; }
table.agents tr.shadowed td { opacity: .7; }
table.agents th.act, table.agents td.act { text-align: right; white-space: nowrap; }
td.act > * + * { margin-left: 6px; }
table.models td { vertical-align: middle; padding-top: 6px; padding-bottom: 6px; padding-right: 10px; }
table.models td:first-child { white-space: nowrap; }
table.models select { height: 30px; font-size: 13px; }
table.models td:nth-child(2) { min-width: 220px; }
table.models td:nth-child(3) { min-width: 130px; }
table.models td.resolves { min-width: 190px; }
table.models td.resolves .mono { font-size: 12.5px; }
.changed > .picker select, td.changed select { border-color: color-mix(in srgb, var(--accent) 65%, var(--field-line)); }
select[aria-invalid=true] { border-color: var(--err); }
.picker { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
select.mono-sel { font-family: var(--mono); font-size: 13px; }
p.where { margin: 14px 0 0; display: flex; gap: 6px; align-items: flex-start; }
p.where svg { margin-top: 2px; }
details.menu { position: relative; display: inline-block; vertical-align: middle; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
.menu-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 8; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-sm); box-shadow: 0 8px 24px rgba(16, 24, 40, .16); padding: 4px; min-width: 250px; display: flex; flex-direction: column; text-align: left; white-space: normal; }
.menu-pop button { text-align: left; background: transparent; border: 0; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.menu-pop button:hover, .menu-pop button:focus-visible { background: var(--hover); }
.menu-pop small { display: block; color: var(--muted); font-size: 12px; }
.crumb { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; font-weight: 550; margin-bottom: 6px; }
.crumb:hover { color: var(--accent-ink); text-decoration: none; }
.head h1 { overflow-wrap: anywhere; }
.head > div:first-child { flex: 1 1 320px; min-width: 0; }
.head p.meta .mono { overflow-wrap: anywhere; }
.head p.meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; max-width: none; }
.seg { display: inline-flex; align-self: flex-start; border: 1px solid var(--field-line); border-radius: var(--r-sm); overflow: hidden; background: var(--field); }
.seg button { border: 0; background: transparent; padding: 0 12px; height: 32px; cursor: pointer; font-weight: 560; color: var(--muted); }
.seg button:hover { color: var(--fg); }
.seg button[aria-pressed=true] { background: var(--sel); color: var(--accent-ink); }
.seg button + button { border-left: 1px solid var(--field-line); }
.seg.sm button { height: 26px; padding: 0 10px; font-size: 12.5px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 26px; align-items: center; }
.chip-t { display: inline-flex; align-items: center; gap: 2px; font-family: var(--mono); font-size: 12.5px; background: var(--accent-soft); color: var(--accent-ink); border-radius: 6px; padding: 2px 3px 2px 8px; }
.chip-t button { border: 0; background: transparent; color: inherit; cursor: pointer; width: 20px; height: 20px; border-radius: 4px; font-size: 14px; line-height: 1; }
.chip-t button:hover { background: rgba(79, 142, 247, .22); }
.tool-pick { border: 1px solid var(--field-line); border-radius: var(--r-sm); background: var(--field); }
.tool-pick .tp-chips { padding: 8px 10px; border-bottom: 1px solid var(--line); }
.tool-pick .tp-head { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tool-pick .tp-head > input { flex: 1 1 160px; }
.tool-pick .tp-add { flex: 1 1 260px; flex-wrap: nowrap; }
.tool-grid { max-height: 230px; overflow: auto; padding: 2px 8px 8px; }
.tool-grid h4 { margin: 10px 4px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 650; }
.tool-grid .opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0 8px; }
.row-f label.tool-opt, .tool-opt { display: flex; font-weight: 450; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-family: var(--mono); font-size: 12.5px; min-width: 0; }
.tool-opt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-opt:hover { background: var(--hover); }
.tool-opt input { accent-color: var(--accent); margin: 0; }
details.adv { border-top: 1px solid var(--line); margin-top: 4px; }
details.adv > summary { cursor: pointer; padding: 12px 0; font-weight: 560; color: var(--muted); }
details.adv > summary:hover { color: var(--fg); }
.extra { border-top: 1px solid var(--line); padding-top: 12px; }
.extra .lab-t { font-weight: 560; }

/* the Markdown editor */
.md { border: 1px solid var(--field-line); border-radius: var(--r); overflow: hidden; background: var(--field); margin-top: 6px; }
.md:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.md-toolbar { display: flex; align-items: center; gap: 2px; padding: 5px 8px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
.md-toolbar .tb { height: 28px; min-width: 30px; padding: 0 7px; border: 0; background: transparent; border-radius: 6px; cursor: pointer; font-weight: 650; color: var(--muted); font-size: 12.5px; }
.md-toolbar .tb:hover { background: var(--hover); color: var(--fg); }
.md-toolbar .tb.b { font-weight: 800; }
.md-toolbar .tb.i { font-style: italic; font-family: Georgia, serif; font-size: 14px; }
.md-toolbar .tb.mono { font-family: var(--mono); font-weight: 600; }
.md-toolbar .sep { width: 1px; height: 18px; background: var(--line); margin: 0 5px; }
.md-toolbar .grow { flex: 1; }
.md-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.md-body.write { grid-template-columns: minmax(0, 1fr); }
.md-body.write .md-preview { display: none; }
.md-body.preview { grid-template-columns: minmax(0, 1fr); }
.md-body.preview .md-input { display: none; }
.md-input { display: block; width: 100%; height: 62vh; min-height: 380px; resize: vertical; border: 0; outline: none; margin: 0; padding: 14px 16px; font: 13px/1.65 var(--mono); background: transparent; tab-size: 2; }
.md-input:focus { box-shadow: none; }
.md-input[readonly] { color: var(--muted); }
.md-preview { border-left: 1px solid var(--line); padding: 4px 22px 18px; overflow: auto; height: 62vh; min-height: 380px; background: var(--card); font-size: 14px; line-height: 1.6; }
.md-preview:focus-visible { box-shadow: inset var(--ring); }
.md-body.preview .md-preview { border-left: 0; }
.md-preview h1, .md-preview h2, .md-preview h3, .md-preview h4, .md-preview h5 { margin: 18px 0 6px; line-height: 1.3; letter-spacing: -.01em; }
.md-preview h2 { font-size: 19px; } .md-preview h3 { font-size: 16px; } .md-preview h4 { font-size: 14.5px; } .md-preview h5 { font-size: 13.5px; }
.md-preview p { margin: 8px 0; }
.md-preview ul, .md-preview ol { margin: 6px 0; padding-left: 22px; }
.md-preview li { margin: 2px 0; }
.md-preview code { font-family: var(--mono); font-size: 12.5px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.md-preview pre { margin: 10px 0; }
.md-preview pre code { background: none; border: 0; padding: 0; }
.md-preview blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--line); color: var(--muted); }
.md-preview table { border-collapse: collapse; margin: 10px 0; font-size: 13px; }
.md-preview th, .md-preview td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
.md-preview hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.md-foot { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 6px 12px; border-top: 1px solid var(--line); background: var(--panel); color: var(--muted); font-size: 12px; flex-wrap: wrap; }
kbd { font: 11px/1.5 var(--mono); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--card); color: var(--fg); }
@media (max-width: 1000px) {
  .md-body { grid-template-columns: minmax(0, 1fr); }
  .md-preview { border-left: 0; border-top: 1px solid var(--line); height: auto; max-height: 50vh; }
  .md-input { height: 50vh; }
}
@media (max-width: 760px) {
  table.agents td:nth-child(3), table.agents th:nth-child(3) { display: none; }
  .md-foot .keys { display: none; }
}

/* ---------- narrow ---------- */
@media (max-width: 1240px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
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
var TOKEN_KEY = "kernal-admin-token";
var token = "";
(function () {
  var m = location.hash.match(/[#&]t=([A-Za-z0-9_-]{20,})/);
  if (m) {
    token = m[1];
    var start = location.hash.match(/[#&]p=([a-z][a-z0-9\/.-]*)/);   // a page, or a deep link such as subagents/edit/user/name
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
  github: '<path d="M10 1.8a8.2 8.2 0 0 0-2.6 16c.4.1.6-.2.6-.4v-1.5c-2.3.5-2.8-1.1-2.8-1.1-.4-1-.9-1.2-.9-1.2-.8-.5 0-.5 0-.5.9.1 1.3.9 1.3.9.7 1.3 2 .9 2.5.7.1-.6.3-.9.5-1.1-1.8-.2-3.8-.9-3.8-4.1 0-.9.3-1.7.9-2.2-.1-.3-.4-1.1.1-2.3 0 0 .7-.2 2.3.9a7.8 7.8 0 0 1 4.2 0c1.6-1.1 2.3-.9 2.3-.9.5 1.2.2 2 .1 2.3.6.5.9 1.3.9 2.2 0 3.2-2 3.9-3.8 4.1.3.3.6.8.6 1.6v2.4c0 .2.1.5.6.4A8.2 8.2 0 0 0 10 1.8z"/>',
  settings: '<path d="M3 5h8M15 5h2M3 10h3M10 10h7M3 15h9M16 15h1"/><circle cx="13" cy="5" r="2"/><circle cx="8" cy="10" r="2"/><circle cx="14" cy="15" r="2"/>',
  key: '<circle cx="6.5" cy="10" r="3.5"/><path d="M10 10h8M15.5 10v3M18 10v2.5"/>',
  subagents: '<circle cx="10" cy="4.5" r="2.5"/><circle cx="4" cy="15.5" r="2.5"/><circle cx="16" cy="15.5" r="2.5"/><path d="M10 7v3M10 10l-5 3.5M10 10l5 3.5"/>',
  power: '<path d="M10 2v7M5.5 4.8a7 7 0 1 0 9 0"/>',
  alert: '<circle cx="10" cy="10" r="8"/><path d="M10 6v5M10 14h.01"/>',
  info: '<circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
  refresh: '<path d="M16.5 9.5a6.5 6.5 0 1 1-2-4.7M16.5 2.5v4h-4"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  back: '<path d="M12 4l-6 6 6 6"/>',
  edit: '<path d="M13.5 3.5l3 3L7 16H4v-3z"/>',
  copy: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/>',
  trash: '<path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11"/>',
  eye: '<path d="M1.5 10s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.5"/>'
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
  var headers = { "x-kernal-admin-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (poll) headers["x-kernal-poll"] = "1";
  return fetch("/api" + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { gone("This page's session has ended", "Run /admin in kernal to open a fresh one."); throw new Error("unauthorised"); }
        if (!res.ok) {
          var msg = typeof data.error === 'object' && data.error !== null ? (data.error.message || JSON.stringify(data.error)) : data.error;
          var e = new Error(msg || ("HTTP " + res.status));
          e.data = data;
          e.status = res.status;
          throw e;
        }
        return data;
      });
    }, function (err) {
      gone("The admin server has stopped", "It stops when kernal exits, after 15 minutes without use, or on /admin stop. Run /admin to start it again.");
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
  { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
  { id: "connections", label: "Connections", icon: "connections", render: renderConnections },
  { id: "model", label: "Model", icon: "model", render: renderModel },
  { id: "index", label: "Codebase index", short: "Index", icon: "index", render: renderIndex },
  { id: "subagents", label: "Subagents", icon: "subagents", render: renderSubagents },
  { id: "github", label: "GitHub", icon: "github", render: renderGithub }
];
var dirty = null;   // a function returning the number of unsaved changes on the current page
var cleanup = [];
var current = "";
var currentHash = "";   // the full route, so sub-pages (an agent in the editor) are guarded too

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
  if (dirty && dirty() > 0 && location.hash !== currentHash) {
    if (!confirm("You have unsaved changes on this page. Leave without saving?")) { history.replaceState(null, "", currentHash || "#/" + current); return; }
  }
  cleanup.forEach(function (f) { try { f(); } catch (e) {} });
  cleanup = []; dirty = null;
  current = next; currentHash = location.hash; markNav();
  var view = clear(document.getElementById("view"));
  view.setAttribute("aria-busy", "true");
  var page = PAGES.filter(function (p) { return p.id === current; })[0];
  document.title = page.label + " · kernal admin";
  page.render(view);
}
// Same page, new data: Re-check and a finished install stay on this hash, so show() would
// drop unsaved edits without asking. Ask first, the same question as leaving the page.
function reload() {
  if (dirty && dirty() > 0 && !confirm("You have unsaved changes on this page. Leave without saving?")) return;
  show();
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
  if (!confirm("Stop the admin server? Run /admin in kernal to start it again.")) return;
  api("POST", "/stop", {}).then(function () { gone("Admin server stopped", "Run /admin in kernal to start it again."); }, function () {});
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
      ["kernal", el("span", { class: "mono", text: v.kernal })],
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

  var keySrc = d.keySources || {};
  add(view, head("Connections", d.account
    ? "Where models come from. Signed in as " + d.account.email + ": a provider key you type here is saved to your account, not the keys file. The providers reconnect as soon as you save."
    : "Where models come from. Saved to the keys file; the providers reconnect as soon as you save, no restart."));

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
        isSet && keySrc[key] ? el("span", { class: "tag" + (keySrc[key] === "your account" || keySrc[key] === "this device" ? " accent" : ""), text: "from " + keySrc[key] }) : null,
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
      textRow("LITELLM_BASE_URL", "Router URL", "An OpenAI-compatible base URL; /v1 is added when missing.", "url", "https://router.kernal.one/v1", true),
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
  add(view, card("You", null, null, el("div", { class: "rows" }, textRow("KERNAL_USER", "Your name", "Shown in the start-up banner. Takes effect at the next start.", "text", "", false))));
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
// Settings: each central value's source, saved to the account or to this machine
// =====================================================================================
var settingsTarget = null;   // "account" or "machine", kept while the page is open
function renderSettings(view) {
  add(view, head("Settings", "What Kernal is set to, and where each value comes from."));
  loading(view);
  api("GET", "/settings").then(function (d) { drawSettings(view, d); }, function (e) { failed(view, e); });
}
function sourceTag(r) {
  if (!r.sourceLabel) return el("span", { class: "note", text: "not set" });
  var central = ["fleet", "group", "user", "profile", "device"].indexOf(r.source) >= 0;
  return el("span", { class: "tag" + (central ? " accent" : r.source === "dotenv" ? " warn" : ""), title: r.source === "dotenv" ? ".env is deprecated for this: save it to your account or this machine" : r.source === "legacy" ? "Set on this machine before it had an account: a value saved to your account or this machine wins over it" : null, text: r.sourceLabel });
}
function shownValue(r) {
  if (r.value === undefined) return "—";
  if (r.type === "boolean") return r.value ? "on" : "off";
  return String(r.value);
}
function drawSettings(view, d) {
  clear(view);
  var canAccount = !!(d.signedIn && d.target);
  if (settingsTarget !== "account" && settingsTarget !== "machine") settingsTarget = canAccount ? "account" : "machine";
  if (settingsTarget === "account" && !canAccount) settingsTarget = "machine";
  var target = settingsTarget;
  var fs = formState(save, function () { drawSettings(view, d); });
  var rows = {};

  var sub = d.signedIn
    ? "Signed in as " + d.account.email + (d.profile ? ", profile " + d.profile : "") + ". Values your Sysop locks are read-only."
    : "Not signed in: these are this machine's settings. Run kernal login to keep them on your account.";
  add(view, head("Settings", sub, el("button", { class: "btn", type: "button", on: { click: function () { reload(); } } }, icon("refresh", 14), "Reload")));
  if (d.targetProblem) add(view, callout("warn", "Your account's settings could not be read (" + d.targetProblem + "); saving to the account is off until they can."));

  // Where a save goes. Switching redraws the rows with that target's own values.
  var seg = el("div", { class: "seg", role: "group", "aria-label": "Save to" });
  [["account", d.target ? d.target.label : "Save to my account"], ["machine", "Only this machine"]].forEach(function (t) {
    var b = el("button", { type: "button", "aria-pressed": target === t[0] ? "true" : "false", disabled: t[0] === "account" && !canAccount }, t[1]);
    b.addEventListener("click", function () {
      if (target === t[0]) return;
      if (fs.count() && !confirm("You have unsaved changes for the other target. Switch without saving?")) return;
      settingsTarget = t[0]; drawSettings(view, d);
    });
    seg.appendChild(b);
  });
  var where = target === "account"
    ? "Saved on Outfitter for " + d.account.email + ": every Kernal signed in to your account uses it from its next start."
    : "Saved in " + d.localFile + " on this machine only; it wins over your account where the setting allows it. Takes effect at the next start.";
  add(view, card("Save to", null, null, el("div", { class: "rows" }, seg, el("p", { class: "note", text: where }))));

  var list = el("div", { class: "rows" });
  d.rows.forEach(function (r) {
    var editable = target === "account" ? r.canAccount : r.canMachine;
    var here = target === "account" ? r.account : r.machine;
    var initial = here === undefined ? "" : String(here);
    var control;
    if (r.type === "boolean" || r.type === "enum") {
      var opts = r.type === "boolean" ? [["true", "on"], ["false", "off"]] : (r.choices || []).map(function (c) { return [c, c]; });
      control = el("select", { disabled: !editable }, el("option", { value: "", text: "not set here" }), opts.map(function (o) { return el("option", { value: o[0], text: o[1] }); }));
      control.value = initial;
      control.addEventListener("change", function () { fs.set(r.key, control.value); row.setError(null); });
    } else {
      control = el("input", { type: r.type === "number" ? "number" : r.type === "url" ? "url" : "text", value: initial, class: "mono", placeholder: r.value !== undefined && !r.secret ? shownValue(r) : "not set here", autocomplete: "off", spellcheck: "false", disabled: !editable, step: r.type === "number" ? "any" : null, min: r.min, max: r.max });
      control.addEventListener("input", function () { fs.set(r.key, control.value); row.setError(null); });
    }
    var now = el("div", { class: "help" }, "Now: ", el("span", { class: "mono", text: shownValue(r) }), " · from ", sourceTag(r),
      r.readOnly ? el("span", { class: "note", text: " · " + r.readOnly }) : !editable ? el("span", { class: "note", text: target === "account" ? " · can't be set on your account; try this machine" : " · can't be set on this machine" }) : null);
    var row = frow("s-" + r.key.replace(/\./g, "-"), r.key, r.description, control, now);
    if (r.locked) row.classList.add("locked");
    if (editable) fs.track(r.key, initial, row);
    rows[r.key] = row;
    list.appendChild(row);
  });
  add(view, card("Values", "Every setting this Kernal knows. Empty means not set at the target; the value then comes from elsewhere.", null, list));
  if (d.providerKeys) add(view, providerKeysCard(d.providerKeys));
  add(view, fs.bar);
  view.setAttribute("aria-busy", "false");

  function save(changes) {
    var values = {};
    for (var k in changes) values[k] = changes[k] === "" ? null : changes[k];
    for (var r in rows) rows[r].setError(null);
    var body = { target: target, values: values };
    if (target === "account") body.version = d.target.version;
    return api("POST", "/settings", body).then(function (res) {
      toast(res.message || "Saved", "ok");
      (res.warnings || []).forEach(function (w) { toast(w, "warn"); });
      api("GET", "/settings").then(function (fresh) { drawSettings(view, fresh); }, function () {});
      return true;
    }, function (e) {
      var errs = e.data && e.data.errors;
      if (e.status === 409 && e.data && e.data.stale) {
        toast("Changed elsewhere, reload: your account's settings were saved from another place since this page loaded. Nothing was overwritten.", "error");
        add(view, callout("error", "Changed elsewhere, reload. Your edits are still in the form; Reload discards them and shows the current values."));
      } else if (errs) { for (var f in errs) if (rows[f]) rows[f].setError(errs[f]); toast("Nothing saved: fix the highlighted fields", "error"); }
      else toast(e.message, "error");
      return false;
    });
  }
}
/** Personal provider keys on the account: write-only, shown as their last four characters. */
function providerKeysCard(pk) {
  var have = {}; (pk.keys || []).forEach(function (k) { have[k.provider] = k; });
  var box = el("div", { class: "rows" });
  if (pk.unavailable) box.appendChild(callout("warn", "The keys on your account could not be read just now."));
  pk.providers.forEach(function (p) {
    var cell = el("div", { class: "secret" });
    var row = frow("k-" + p, p, null, cell);
    function idle() {
      clear(cell);
      var k = have[p];
      add(cell, [
        k ? el("span", { class: "chip", text: "…" + k.last4, title: k.setAt ? "set " + new Date(k.setAt).toLocaleString() : null }) : el("span", { class: "note", text: "Not set" }),
        el("button", { class: "btn sm", type: "button", on: { click: editing } }, k ? "Replace" : "Add key"),
        k ? el("button", { class: "btn sm ghost danger", type: "button", on: { click: remove } }, "Remove") : null
      ]);
    }
    function editing() {
      clear(cell);
      var input = el("input", { type: "password", class: "mono", placeholder: "Paste the key", autocomplete: "new-password", spellcheck: "false", "aria-label": p + " key" });
      var saveBtn = el("button", { class: "btn sm primary", type: "button" }, "Save to my account");
      saveBtn.addEventListener("click", function () { send(input.value, saveBtn); });
      add(cell, el("div", { class: "inline" }, input, saveBtn, el("button", { class: "btn sm ghost", type: "button", on: { click: idle } }, "Cancel")));
      input.focus();
    }
    function remove() { if (confirm("Remove the " + p + " key from your account?")) send(null); }
    function send(value, btn) {
      row.setError(null);
      if (btn) btn.disabled = true;
      api("POST", "/settings/provider-key", { provider: p, value: value }).then(function (res) {
        toast(res.message, "ok");
        have = {}; (res.keys || []).forEach(function (k) { have[k.provider] = k; });
        idle();
      }, function (e) { if (btn) btn.disabled = false; row.setError((e.data && e.data.errors && e.data.errors.value) || e.message); });
    }
    idle();
    box.appendChild(row);
  });
  return card("Keys on your account", "Personal provider keys, kept by Outfitter and delivered to your signed-in Kernals. Never shown again after saving; never written to .env.", null, box);
}

// =====================================================================================
// Model
// =====================================================================================
function renderModel(view) {
  add(view, head("Model", "The model this session talks to."));
  loading(view);
  api("GET", "/models").then(function (d) { drawModels(view, d); }, function (e) { failed(view, e); });
}
// #440: the curated OpenRouter list. Adds and removes go to the account or to this machine only.
var curateTarget = "account", curateChosen = false;
function curateRow(view, d) {
  var c = d.curation;
  if (c.replacedByEnv) return el("p", { class: "note", style: "padding: 0 16px 14px" }, "OPENROUTER_MODELS in .env sets this whole list; edit it there, or remove it to curate the list here.");
  // Signed out: only this machine. Signed in again later: back to the account unless chosen by hand.
  if (!c.canAccount) curateTarget = "machine";
  else if (!curateChosen) curateTarget = "account";
  var input = el("input", { type: "text", list: "or-catalogue", placeholder: "Add any OpenRouter model, e.g. deepseek/deepseek-v4-pro", "aria-label": "OpenRouter model to add", autocomplete: "off" });
  var dl = el("datalist", { id: "or-catalogue" });
  (c.catalogue || []).forEach(function (id) { dl.appendChild(el("option", { value: id })); });
  var seg = el("div", { class: "seg sm", role: "group", "aria-label": "Where list changes are saved" });
  [["account", "My account"], ["machine", "This machine"]].forEach(function (t) {
    var b = el("button", { type: "button", "aria-pressed": curateTarget === t[0] ? "true" : "false", text: t[1] });
    if (t[0] === "account" && !c.canAccount) { b.disabled = true; b.title = "Run kernal login to save to your account"; }
    b.addEventListener("click", function () { curateTarget = t[0]; curateChosen = true; Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); });
    seg.appendChild(b);
  });
  var addBtn = el("button", { type: "button", class: "btn sm", text: "Add" });
  function submit() { var id = input.value.trim(); if (id) curate(view, "add", id, addBtn); }
  addBtn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  var row = el("div", { class: "curate" }, input, dl, addBtn, el("span", { class: "note", text: "Save to" }), seg);
  if (!(c.unavailable || []).length) return row;
  // On a list but not offered (OpenRouter doesn't list them): still removable here.
  var un = el("div", { class: "unlisted" }, el("span", { class: "note warnnote", text: "Not on OpenRouter:" }));
  c.unavailable.forEach(function (id) { un.appendChild(el("span", { class: "chip" }, id, curateButton(view, d, "remove", id))); });
  return el("div", {}, un, row);
}
function curateButton(view, d, action, id) {
  var b = el("button", { type: "button", class: "rm", title: "Remove " + id + " from the list", "aria-label": "Remove " + id + " from the list", text: "×" });
  b.addEventListener("click", function () { curate(view, action, id, b); });
  return b;
}
function curate(view, action, id, btn) {
  btn.disabled = true;
  api("POST", "/model/curate", { action: action, id: id, target: curateTarget }).then(function (r) {
    toast(r.message, "ok");
    api("GET", "/models").then(function (fresh) { drawModels(view, fresh); });
  }, function (e) { btn.disabled = false; toast(e.message, "error"); });
}
function drawModels(view, d) {
  clear(view);
  add(view, head("Model", "Choosing a model switches this session now and saves it as the default for the next session, like /connect."));
  var cur = d.current;
  var defText = d.default ? d.default.provider + (d.default.model ? "/" + d.default.model : "") : "not set";
  var rows = [
    ["In use", el("span", { class: "mono", text: cur ? cur.provider + "/" + cur.id : "none" })],
    ["Default at start", el("span", {}, el("span", { class: "mono", text: defText }), d.default && d.default.source ? el("span", { class: "note", text: "  from " + d.default.source }) : null)],
    ["Thinking", el("span", { text: d.thinking || "—" })]
  ];
  // Signed in (#437): where a chosen default goes, as on the Settings page.
  var target = null;
  if (d.saveTargets && d.saveTargets.length) {
    var pickTarget = el("select", { "aria-label": "Save the default to" });
    d.saveTargets.forEach(function (t) { pickTarget.appendChild(el("option", { value: t.id, text: t.label })); });
    target = pickTarget;
    rows.push(["Save the default to", pickTarget]);
  }
  add(view, card("Current", null, null, kv(rows)));
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
          var body = { provider: p.id, id: id };
          if (target) body.target = target.value;
          api("POST", "/model", body).then(function (r) {
            if (r && r.message) toast("Switched to " + p.id + "/" + id + ": " + r.message, r.savedAsDefault === false ? "error" : "ok");
            else toast("Switched to " + p.id + "/" + id + " and saved it as the default", "ok");
            api("GET", "/models").then(function (fresh) { drawModels(view, fresh); });
          }, function (e) { btn.disabled = false; var s = btn.querySelector(".spin"); if (s) s.remove(); toast(e.message, "error"); });
        });
        var cu = p.id === "openrouter" && d.curation && !d.curation.replacedByEnv;
        ul.appendChild(cu ? el("li", { class: "curated" }, btn, curateButton(view, d, "remove", id)) : el("li", {}, btn));
      });
      lists.push(ul);
      body = p.models.length ? ul : el("div", { class: "empty", text: "No models reported." });
      if (p.id === "openrouter" && d.curation) body = el("div", {}, body, curateRow(view, d));
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
  } else body.push(callout("info", "The indexer is not loaded in this agent (KERNAL_NO_CODEBASE_INDEX, or the package is missing). Settings can still be edited."));
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
// Subagents: the models they run on, and the agent definitions (Markdown files)
// =====================================================================================
var BT = String.fromCharCode(96);   // a backtick: this script lives inside a template string
var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
var MOD = MAC ? "⌘" : "Ctrl+";
var ALT = MAC ? "⌥" : "Alt+";
var SHIFT = MAC ? "⇧" : "Shift+";
var SOURCE_HELP = {
  builtin: "Ships with pi-subagents. Read-only: the file is inside the package and is replaced when it updates.",
  "package": "Comes from an installed pi package. Read-only for the same reason.",
  user: "Yours, for every project.",
  project: "This project's own, in its .pi/agents directory.",
  runtime: "Registered at runtime by an extension."
};
var subagentFlash = null;   // one-shot message for the next render (after a save navigates)

function srcTag(s) { return el("span", { class: "tag src-" + s, title: SOURCE_HELP[s] || "", text: s }); }
function agentHref(kind, source, name) { return "#/subagents/" + kind + "/" + encodeURIComponent(source) + "/" + encodeURIComponent(name); }
function subRoute() {
  var m = location.hash.match(/^#\/subagents\/(edit|view)\/([a-z]+)\/([a-z0-9.-]+)$/);
  if (m) return { kind: m[1], source: m[2], name: decodeURIComponent(m[3]) };
  return /^#\/subagents\/new$/.test(location.hash) ? { kind: "new" } : null;
}
function go(hash) { dirty = null; if (location.hash === hash) show(); else location.hash = hash; }

/** A model picker: the connected providers' live models, a "not set" choice, and a free-form id. */
function modelPicker(o) {
  var sel = el("select", { class: "mono-sel", "aria-label": o.label || "Model" });
  var other = el("input", { type: "text", class: "mono", placeholder: "provider/model-id", hidden: true, autocomplete: "off", spellcheck: "false", "aria-label": (o.label || "Model") + " id" });
  sel.appendChild(el("option", { value: "", text: o.none }));
  var known = {};
  var groups = (o.providers || []).filter(function (p) { return p.registered && p.models && p.models.length; });
  if (o.value && !groups.some(function (p) { return p.models.some(function (id) { return p.id + "/" + id === o.value; }); })) {
    sel.appendChild(el("option", { value: o.value, text: o.value + "  (not listed by a connected provider now)" })); known[o.value] = true;
  }
  groups.forEach(function (p) {
    sel.appendChild(el("optgroup", { label: p.label || p.id }, p.models.map(function (id) { var v = p.id + "/" + id; known[v] = true; return el("option", { value: v, text: v }); })));
  });
  sel.appendChild(el("option", { value: "__other", text: "Another id…" }));
  sel.value = o.value || "";
  if (!groups.length) sel.title = "No provider is connected, so there is no live list; type an id with “Another id”.";
  function get() { return sel.value === "__other" ? other.value.trim() : sel.value; }
  sel.addEventListener("change", function () { other.hidden = sel.value !== "__other"; if (!other.hidden) other.focus(); if (o.onChange) o.onChange(get()); });
  other.addEventListener("input", function () { if (o.onChange) o.onChange(get()); });
  if (o.disabled) { sel.disabled = true; other.disabled = true; }
  return { el: el("div", { class: "picker" }, sel, other), select: sel, get: get };
}
function thinkingSelect(value, none, levels, label) {
  var s = el("select", { "aria-label": label || "Thinking" }, el("option", { value: "", text: none }), levels.map(function (l) { return el("option", { value: l, text: l }); }));
  if (value && levels.indexOf(value) === -1) s.insertBefore(el("option", { value: value, text: value + " (not a pi level)" }), s.children[1]);
  s.value = value || "";
  return s;
}

// ---------- GitHub: the CLI, the sign-in, this repository, and the attribution ----------
function renderGithub(view) {
  add(view, head("GitHub", "The GitHub CLI kernal uses, who it signs in as, and what that means for this repository."));
  loading(view);
  api("GET", "/github").then(function (d) { drawGithub(view, d); }, function (e) { failed(view, e); });
}

/** A command to run in a terminal, with a button that copies it. */
function copyLine(text) {
  var btn = el("button", { class: "btn sm ghost", type: "button", title: "Copy" }, icon("copy", 13), "Copy");
  btn.addEventListener("click", function () {
    var done = function () { btn.replaceChildren(icon("check", 13), document.createTextNode("Copied")); setTimeout(function () { btn.replaceChildren(icon("copy", 13), document.createTextNode("Copy")); }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else { var ta = el("textarea", { value: text }); document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove(); }
  });
  return el("div", { class: "cmdline" }, el("code", { text: text }), btn);
}

function drawGithub(view, d) {
  clear(view);
  add(view, head("GitHub", "The GitHub CLI kernal uses, who it signs in as, and what that means for this repository."));

  // ---- the CLI and the sign-in ----
  var rows = [];
  var cliPill = d.cli ? pill("ok", "gh " + d.cli.version) : pill("warn", "not installed");
  rows.push(frow("f-gh-cli", "GitHub CLI", d.cli ? (d.cli.managed ? "Installed by kernal." : "Found on your PATH.") : "kernal installs it into its own bin directory: no admin rights, and the download is checked against its published checksum.",
    el("div", {}, cliPill, d.cli ? el("span", { class: "mono small", text: "  " + d.cli.path }) : null),
    d.cli ? null : (function () {
      var btn = el("button", { class: "btn primary", type: "button" }, icon("plus", 14), "Install gh");
      btn.addEventListener("click", function () {
        btn.disabled = true; btn.replaceChildren(spinner(), document.createTextNode("Installing"));
        api("POST", "/github/install", {}).then(function (r) { toast(r.message, "ok"); reload(); }, function (e) { btn.disabled = false; btn.replaceChildren(icon("plus", 14), document.createTextNode("Install gh")); toast(e.message, "error"); });
      });
      return el("div", { class: "ctl" }, btn, el("div", { class: "note", text: "into " + d.binDir }));
    })()));

  if (d.cli) {
    var a = d.auth || {};
    var who = a.signedIn
      ? el("div", {}, pill("ok", "signed in"), el("span", { class: "mono small", text: "  " + (a.login || "account unknown") }), a.fromEnv ? el("span", { class: "tag", text: "token from the environment" }) : null)
      : el("div", {}, pill("warn", "not signed in"));
    var scopes = a.signedIn && a.scopes && a.scopes.length ? el("div", { class: "note", text: "scopes: " + a.scopes.join(", ") }) : null;
    var missing = a.missingScopes && a.missingScopes.length
      ? el("div", { class: "note warnnote" }, icon("alert", 13), " missing scopes: " + a.missingScopes.join(", ") + ". Sign in again with the command below to add them.")
      : null;
    rows.push(frow("f-gh-auth", "Account", a.signedIn ? "kernal never sees this token: gh keeps it, and git borrows it." : "Sign in once in a terminal. kernal cannot do it for you: gh asks its own questions, and pi cannot hand over the terminal.",
      who, el("div", {}, scopes, missing, a.signedIn && !a.missingScopes.length ? null : copyLine(d.commands.login))));

    rows.push(frow("f-gh-git", "git over https", "So git push uses the same login, with no SSH keys.",
      a.gitConfigured ? pill("ok", "connected") : pill("warn", "not connected"),
      a.gitConfigured ? null : el("div", {}, el("div", { class: "note", text: "This writes a credential helper for github.com into your global git config, which may take over from the macOS keychain helper." }), copyLine(d.commands.setupGit))));
  }

  var refresh = el("button", { class: "btn sm", type: "button" }, icon("refresh", 13), "Re-check");
  refresh.addEventListener("click", function () { reload(); });
  add(view, card("The GitHub CLI", "kernal works with GitHub through the gh CLI, signed in as you.", refresh, el("div", { class: "rows" }, rows)));

  // ---- this repository ----
  var repoBody;
  if (d.notARepo) repoBody = el("p", { class: "note", text: d.notARepo + " is not inside a git repository." });
  else if (!d.repo) repoBody = el("p", { class: "note", text: "This checkout has no origin remote, so the GitHub tools have nothing to talk to. The git tool still works." });
  else {
    var pairs = [
      ["Repository", el("span", {}, el("span", { class: "mono", text: d.repo.owner + "/" + d.repo.repo }), d.repo.ssh ? el("span", { class: "tag warn", text: "SSH remote" }) : null)],
      ["Branch", el("span", {}, el("span", { class: "mono", text: d.repo.branch || "(detached)" }), el("span", { class: "note", text: "  " + (d.repo.upstream ? (d.repo.ahead || d.repo.behind ? d.repo.ahead + " ahead, " + d.repo.behind + " behind " + d.repo.upstream : "up to date with " + d.repo.upstream) : "not pushed yet") }))],
      ["Working tree", d.repo.clean ? pill("ok", "clean") : pill("warn", "uncommitted changes")],
    ];
    if (d.pr) {
      pairs.push(["Pull request", el("div", {},
        el("a", { href: d.pr.url, target: "_blank", rel: "noreferrer", text: "#" + d.pr.number + " " + d.pr.title }),
        el("div", { class: "note", text: [d.pr.isDraft ? "draft" : String(d.pr.state).toLowerCase(), d.pr.reviewDecision ? String(d.pr.reviewDecision).toLowerCase().replace(/_/g, " ") : null, d.pr.unresolvedThreads ? d.pr.unresolvedThreads + " unresolved thread(s)" : null, checksText(d.pr.checks)].filter(Boolean).join(" · ") }))]);
    } else if (d.prUnavailable) pairs.push(["Pull request", el("span", { class: "note", text: d.prUnavailable })]);
    else if (d.repo.github) pairs.push(["Pull request", el("span", { class: "note", text: "none for this branch" })]);
    repoBody = kv(pairs);
    if (d.repo.ssh) repoBody = el("div", {}, repoBody, el("p", { class: "note" }, icon("info", 13), " kernal's GitHub tools need an https remote; SSH remotes are out of scope."));
  }
  add(view, card("This repository", "What /git reports, and what the tools will act on.", null, repoBody));

  // ---- attribution ----
  var fs = formState(saveAttribution, function () { show(); });
  var commitIn = el("input", { type: "text", value: d.attribution.commit, placeholder: "empty: no trailer", maxlength: "200" });
  var prIn = el("input", { type: "text", value: d.attribution.pr, placeholder: "empty: no footer", maxlength: "200" });
  var commitRow = frow("f-attr-commit", "Commit trailer", "Added once to every commit kernal makes. Empty turns it off.", commitIn,
    el("div", { class: "note", text: "A reserved .invalid address on purpose: a users.noreply.github.com one would credit whichever GitHub account owns that name." }));
  var prRow = frow("f-attr-pr", "Pull request footer", "Added to pull requests kernal opens. Empty turns it off.", prIn);
  commitIn.addEventListener("input", function () { fs.set("commit", commitIn.value); });
  prIn.addEventListener("input", function () { fs.set("pr", prIn.value); });
  fs.track("commit", d.attribution.commit, commitRow);
  fs.track("pr", d.attribution.pr, prRow);
  add(view, card("Attribution", "How kernal signs the work it does here.", null, el("div", { class: "rows" }, commitRow, prRow)));
  fs.bar.classList.add("autohide");
  add(view, fs.bar);
  view.setAttribute("aria-busy", "false");

  function saveAttribution(changes) {
    return api("POST", "/github/attribution", changes).then(function (r) {
      toast(r.message, "ok");
      // What the settings file now holds becomes the baseline, so the unsaved-changes bar clears.
      fs.track("commit", r.attribution.commit, commitRow);
      fs.track("pr", r.attribution.pr, prRow);
      commitIn.value = r.attribution.commit; prIn.value = r.attribution.pr;
      return true;
    }, function (e) {
      if (e.data && e.data.errors) { if (e.data.errors.commit) commitRow.setError(e.data.errors.commit); if (e.data.errors.pr) prRow.setError(e.data.errors.pr); }
      toast(e.message, "error");
      throw e;
    });
  }
}

function checksText(c) {
  if (!c) return null;
  if (c.failed) return "checks: " + c.failed + " failing, " + c.passed + " passed";
  if (c.pending) return "checks: " + c.pending + " running, " + c.passed + " passed";
  return "checks: all " + c.total + " passed";
}

function renderSubagents(view) {
  var r = subRoute();
  if (r) { renderAgentEditor(view, r); return; }
  add(view, head("Subagents", "Agents the main agent delegates to, and the models they run on."));
  loading(view);
  Promise.all([api("GET", "/subagents"), api("GET", "/models").catch(function () { return { providers: [] }; })])
    .then(function (res) { drawSubagents(view, res[0], res[1]); }, function (e) { failed(view, e); });
}

// Command-line agents hand the task to another coding tool installed here (Claude Code, Codex, Cursor),
// which answers with its own login, model and tools. One tile per tool: installed or not, and its agents.
function cliState(c) { return c.unknown ? pill("off", c.machine ? "on " + c.machine : "not checked") : c.installed ? pill("ok", "installed") : pill("warn", "not installed"); }
function cliCard(agents) {
  var byCmd = {}, order = [];
  agents.forEach(function (a) { if (!byCmd[a.cli.command]) { byCmd[a.cli.command] = []; order.push(a.cli.command); } byCmd[a.cli.command].push(a); });
  var tiles = order.map(function (cmd) {
    var list = byCmd[cmd], c = list[0].cli;
    var agentsList = el("ul", {}, list.map(function (a) {
      return el("li", {}, el("a", { href: agentHref(a.editable ? "edit" : "view", a.source, a.name), class: "mono small", text: a.name }),
        el("span", { class: "tag" + (a.cli.writes ? " warn" : ""), title: a.cli.writes ? "May change files in the workspace" : "Analyses only; changes nothing", text: a.cli.writes ? "writes files" : "read-only" }));
    }));
    return el("div", { class: "cli-tool" },
      el("div", { class: "top" }, el("h3", { text: c.tool }), cliState(c)),
      el("div", { class: "note" }, "Runs ", el("code", { text: cmd }), c.installed || c.unknown ? ", with its own login and model." + (c.unknown ? " " + c.reason + "." : "") : ": it is not on this machine's PATH, so these agents cannot run yet."),
      agentsList,
      !c.installed && !c.unknown && c.install ? el("div", {}, el("div", { class: "note", text: "Install it, then sign in once in a terminal:" }), el("pre", { class: "mono small", text: c.install })) : null,
      c.installed ? el("div", { class: "note", text: "Installed is not the same as signed in: if a run fails, run " + cmd + " once in a terminal and sign in." }) : null);
  });
  return card("Command-line agents",
    "These agents hand the task to another coding tool on this machine and bring its answer back. That tool uses its own login, model and tools, so Kernal's model settings do not apply to them. Ask for one by name, for example \"ask claude-code to review this diff\". They run in the background.",
    el("span", { class: "tag cli", text: order.length + " tool" + (order.length === 1 ? "" : "s") }),
    el("div", { class: "cli-tools" }, tiles));
}

function whereAgentsLive(d) {
  var where = d.dirs.userReal || d.dirs.user;
  var text = d.checkout
    ? "Your agents are saved in " + d.dirs.user + ". This is a source checkout, and that directory is git-ignored, so they are never committed."
    : "Your agents are saved in " + where + ", outside the versioned install, so they survive upgrades.";
  return el("p", { class: "note where" }, icon("info", 13), " " + text);
}

function drawSubagents(view, d, m) {
  clear(view);
  var flash = subagentFlash; subagentFlash = null;
  add(view, head("Subagents", "Agents the main agent delegates to, and the models they run on. Everything here is read and written through pi-subagents itself.",
    el("a", { class: "btn primary", href: "#/subagents/new" }, icon("plus", 14), "New agent")));
  if (flash) add(view, callout(flash.kind || "info", flash.text));
  if (d.unavailable) { add(view, callout("error", "pi-subagents could not be loaded: " + d.unavailable)); view.setAttribute("aria-busy", "false"); return; }
  (d.diagnostics || []).forEach(function (x) { add(view, callout("error", "pi-subagents skips " + x.file + ": " + x.error)); });
  var providers = m.providers || [];
  var levels = d.thinkingLevels || [];
  var fs = formState(saveModels, function () { drawSubagents(view, d, m); });

  // ---- models ----
  var defRowPicker = modelPicker({ value: d.settings.defaultModel, providers: providers, none: "Not set: the parent's model", label: "Default model", onChange: function (v) { fs.set("defaultModel", v); defRow.setError(null); } });
  var defRow = frow("f-sub-default", "Default model", "For every agent without a model of its own or an override below", defRowPicker.el, el("div", { class: "note", title: d.settings.file }, "Saved as ", el("code", { text: "subagents.defaultModel" }), " in the agent's settings.json, which upgrades carry forward."));
  fs.track("defaultModel", d.settings.defaultModel || "", defRow);
  var active = d.agents.filter(function (a) { return a.active && !a.cli; });
  var cliActive = d.agents.filter(function (a) { return a.active && a.cli; });
  var cellErr = {};
  var mtable = el("table", { class: "t models" },
    el("thead", {}, el("tr", {}, el("th", { text: "Agent" }), el("th", { text: "Model override" }), el("th", { text: "Thinking override" }), el("th", { text: "Resolves to" }))),
    el("tbody", {}, active.map(function (a) {
      var ov = d.settings.overrides[a.name] || {};
      var mk = "o:" + a.name + ":model", tk = "o:" + a.name + ":thinking";
      var mp = modelPicker({ value: ov.model || "", providers: providers, none: "No override", label: a.name + " model", onChange: function (v) { fs.set(mk, v); mp.select.removeAttribute("aria-invalid"); } });
      var th = thinkingSelect(ov.thinking || "", "No override", levels, a.name + " thinking");
      th.addEventListener("change", function () { fs.set(tk, th.value); th.removeAttribute("aria-invalid"); });
      var mcell = el("td", {}, mp.el), tcell = el("td", {}, th);
      fs.track(mk, ov.model || "", mcell); fs.track(tk, ov.thinking || "", tcell);
      cellErr[a.name + ".model"] = mp.select; cellErr[a.name + ".thinking"] = th;
      return el("tr", {},
        el("td", {}, el("div", { class: "a-name" }, el("span", { text: a.name }), srcTag(a.source))),
        mcell, tcell,
        el("td", { class: "resolves" }, el("div", { class: "mono", text: a.model || "the parent's model" }), el("div", { class: "note", text: "from " + a.modelFrom + (a.thinking ? " · thinking " + a.thinking : "") })));
    })));
  var modelsCard = card("Models", "Which model each agent runs on. An override beats the agent file's own model and the default.", null, [el("div", { class: "rows" }, defRow), el("div", { class: "table-wrap" }, mtable),
    cliActive.length ? el("p", { class: "note where" }, icon("info", 13), " Command-line agents are not listed here: " + cliActive.map(function (a) { return a.name; }).join(", ") + " run another tool, which picks its own model.") : null,
    staleCliOverrides()]);
  // An override saved for a command-line agent (before this page refused them) is never used; offer to remove it.
  function staleCliOverrides() {
    var stale = cliActive.filter(function (a) { var o = d.settings.overrides[a.name]; return o && (o.model || o.thinking); });
    if (!stale.length) return null;
    var btn = el("button", { class: "btn sm", type: "button" }, "Remove them");
    btn.addEventListener("click", function () {
      var body = { overrides: {} };
      stale.forEach(function (a) { body.overrides[a.name] = { model: "", thinking: "" }; });
      btn.disabled = true;
      api("POST", "/subagents/settings", body).then(function () { toast("Removed the unused overrides", "ok"); show(); }, function (e) { btn.disabled = false; toast(e.message, "error"); });
    });
    return el("div", { class: "callout warn" }, icon("alert"), el("div", { class: "t" }, "Settings hold overrides for " + stale.map(function (a) { return a.name; }).join(", ") + ", which run another tool and never use them. ", btn));
  }

  // ---- agents ----
  var q = el("input", { type: "search", placeholder: "Filter by name, description or source", "aria-label": "Filter agents", autocomplete: "off" });
  var tbody = el("tbody");
  d.agents.forEach(function (a) {
    var actions = el("td", { class: "act" });
    if (a.withheld) add(actions, el("span", { class: "tag warn", title: "This file contains something that looks like a key, so it is not shown here. Edit it by hand and remove the key.", text: "contains a key" }));
    else if (a.editable) {
      add(actions, el("a", { class: "btn sm", href: agentHref("edit", a.source, a.name) }, icon("edit", 13), "Edit"));
      var del = el("button", { class: "btn sm ghost danger", type: "button", title: "Delete " + a.file }, icon("trash", 13), "Delete");
      del.addEventListener("click", function () { deleteAgentUI(a, function () { show(); }); });
      add(actions, del);
    } else {
      add(actions, el("a", { class: "btn sm", href: agentHref("view", a.source, a.name) }, icon("eye", 13), "View"));
      if (a.source === "builtin" || a.source === "package") add(actions, customiseMenu(a, d));
    }
    var status = a.active ? null : a.shadowedBy ? el("div", { class: "note", text: "overridden by the " + a.shadowedBy + " copy" }) : el("div", { class: "note", text: "disabled" });
    var tr = el("tr", { class: a.active ? null : "shadowed", "data-q": (a.name + " " + a.description + " " + a.source).toLowerCase() },
      el("td", {}, el("div", { class: "a-name" }, el("span", { text: a.name })), el("div", { class: "a-desc", text: a.withheld ? "Not shown: this file contains a key." : a.description })),
      el("td", {}, srcTag(a.source), status),
      a.cli
        ? el("td", {}, el("div", { class: "small" }, el("span", { class: "tag cli", title: "Runs the " + a.cli.tool + " CLI, which uses its own login and model", text: a.cli.tool + "'s own" })),
            el("div", { class: "note", text: "runs " + a.cli.command + (a.cli.unknown ? " · " + (a.cli.machine ? "on " + a.cli.machine : "not checked") : a.cli.installed ? "" : " · not installed") }))
        : el("td", {}, el("div", { class: "mono small", text: a.model || "parent's model" }), el("div", { class: "note", text: a.tools ? a.tools.length + " tools" : "default tools" })),
      actions);
    tbody.appendChild(tr);
  });
  q.addEventListener("input", function () { var v = q.value.trim().toLowerCase(); Array.prototype.forEach.call(tbody.children, function (tr) { tr.hidden = v && tr.getAttribute("data-q").indexOf(v) === -1; }); });
  var counts = {}; d.agents.forEach(function (a) { counts[a.source] = (counts[a.source] || 0) + 1; });
  var summary = Object.keys(counts).map(function (k) { return counts[k] + " " + k; }).join(" · ");
  add(view, card("Agents", "Same-name agents override by priority: project, then user, then package, then builtin.", el("span", { class: "tag", text: summary }),
    [el("div", { class: "toolbar" }, q), el("div", { class: "table-wrap" }, el("table", { class: "t agents" },
      el("thead", {}, el("tr", {}, el("th", { text: "Agent" }), el("th", { text: "Source" }), el("th", { text: "Model" }), el("th", { class: "act", text: "" }))), tbody)),
      whereAgentsLive(d)]));
  if (cliActive.length) add(view, cliCard(cliActive));
  add(view, modelsCard);
  fs.bar.classList.add("autohide");   // shows only while the model settings have unsaved changes
  add(view, fs.bar);
  view.setAttribute("aria-busy", "false");

  function saveModels(changes) {
    var body = { overrides: {} };
    for (var k in changes) {
      if (k === "defaultModel") { body.defaultModel = changes[k]; continue; }
      var parts = k.split(":"); (body.overrides[parts[1]] = body.overrides[parts[1]] || {})[parts[2]] = changes[k];
    }
    defRow.setError(null);
    return api("POST", "/subagents/settings", body).then(function (res) {
      toast(res.message, "ok");
      (res.warnings || []).forEach(function (w) { toast(w, "warn"); });
      d.settings = res.settings; d.agents = res.agents;
      drawSubagents(view, d, m);
      return true;
    }, function (e) {
      var errs = e.data && e.data.errors;
      if (errs) { for (var f in errs) { if (f === "defaultModel") defRow.setError(errs[f]); else if (cellErr[f]) { cellErr[f].setAttribute("aria-invalid", "true"); cellErr[f].title = errs[f]; } } toast("Nothing saved: " + Object.keys(errs).map(function (f) { return f + ": " + errs[f]; }).join("; "), "error"); }
      else toast(e.message, "error");
      return false;
    });
  }
}

function customiseMenu(a, d) {
  var pop = el("div", { class: "menu-pop", role: "menu" });
  var menu = el("details", { class: "menu" }, el("summary", { class: "btn sm", "aria-haspopup": "menu" }, icon("copy", 13), "Customise"), pop);
  [["user", "For me", "An editable copy in your agents, for every project"], ["project", "For this project", "An editable copy in this project's .pi/agents"]].forEach(function (x) {
    var b = el("button", { type: "button", role: "menuitem" }, el("strong", { text: x[1] }), el("small", { text: x[2] }));
    b.addEventListener("click", function () {
      menu.open = false;
      api("POST", "/subagents/customise", { name: a.name, scope: x[0] }).then(function (r) {
        subagentFlash = { kind: "info", text: "Customised: " + r.message + " pi-subagents now resolves " + a.name + " to this " + r.resolved.source + " copy." };
        go(agentHref("edit", x[0], a.name));
      }, function (e) { toast(e.message, "error"); });
    });
    pop.appendChild(b);
  });
  var close = function (e) { if (!menu.contains(e.target)) menu.open = false; };
  document.addEventListener("click", close);
  cleanup.push(function () { document.removeEventListener("click", close); });
  return menu;
}

function deleteAgentUI(a, done) {
  if (!confirm("Delete the " + a.source + " agent " + a.name + "?\n\n" + a.file + "\n\nThis removes the file.")) return;
  api("POST", "/subagents/delete", { name: a.name, scope: a.source }).then(function (r) {
    var now = r.resolved && r.resolved.found ? " " + a.name + " now resolves to the " + r.resolved.source + " agent." : " No agent named " + a.name + " is left.";
    toast("Deleted " + a.file + "." + now, "ok");
    done();
  }, function (e) { toast(e.message, "error"); });
}

// ---------- the editor ----------
function renderAgentEditor(view, r) {
  add(view, head(r.kind === "new" ? "New agent" : r.name, "Loading…"));
  loading(view);
  var reqs = [api("GET", "/subagents"), api("GET", "/models").catch(function () { return { providers: [] }; })];
  if (r.kind !== "new") reqs.push(api("GET", "/subagents/agent?name=" + encodeURIComponent(r.name) + "&source=" + encodeURIComponent(r.source)));
  Promise.all(reqs).then(function (res) { drawEditor(view, r, res[0], res[1], res[2]); }, function (e) { failed(view, e); });
}

function drawEditor(view, r, list, models, a) {
  clear(view);
  var isNew = r.kind === "new";
  var editable = isNew || (r.kind === "edit" && a && a.row.editable);
  var providers = models.providers || [];
  var levels = list.thinkingLevels || [];
  var flash = subagentFlash; subagentFlash = null;
  var crumb = el("a", { class: "crumb", href: "#/subagents" }, icon("back", 13), "Subagents");

  if (a && a.withheld) {
    add(view, [crumb, head(r.name, null), callout("warn", "This file contains something that looks like a key, so the admin does not show or edit it. Agent prompts are sent to model providers: open " + a.row.file + " in an editor and remove the key.")]);
    view.setAttribute("aria-busy", "false");
    return;
  }
  var f = isNew ? { name: "", description: "", tools: ["read", "grep", "find", "ls"], model: "", thinking: "", systemPromptMode: "", inheritProjectContext: undefined, inheritSkills: undefined } : a.fields;
  var prompt = isNew ? "You are a focused subagent.\n\n## Task\n\nDescribe what this agent does and how it should report back.\n\n## Rules\n\n- Stay within the task you are given.\n- Report file paths and evidence for every claim.\n" : a.prompt;
  var row = a ? a.row : null;

  // ---- header ----
  var actions = [];
  if (!isNew && editable) {
    var del = el("button", { class: "btn ghost danger", type: "button" }, icon("trash", 14), "Delete");
    del.addEventListener("click", function () { deleteAgentUI(row, function () { go("#/subagents"); }); });
    actions.push(del);
  }
  if (!isNew && !editable && (row.source === "builtin" || row.source === "package")) actions.push(customiseMenu(row, list));
  var sub = isNew ? "A Markdown file: the settings below become its frontmatter, the prompt its body." : null;
  var title = el("div", { class: "head" }, el("div", {}, crumb,
    el("h1", {}, isNew ? "New agent" : r.name),
    isNew ? el("p", { text: sub }) : el("p", { class: "meta" }, srcTag(row.source), " ", el("span", { class: "mono small", text: row.file }), row.active ? null : el("span", { class: "tag warn", text: row.shadowedBy ? "overridden by the " + row.shadowedBy + " copy" : "disabled" }))),
    actions.length ? el("div", { class: "actions" }, actions) : null);
  add(view, title);
  if (flash) add(view, callout(flash.kind || "info", flash.text));
  if (!editable) add(view, callout("info", (SOURCE_HELP[row.source] || "Read-only here.") + (row.source === "builtin" || row.source === "package" ? " Customise makes an editable copy with the same name, which pi-subagents then uses instead." : " It lives outside your agents directory; edit it where it is.")));

  var resolvedBox = el("div", { id: "resolved" });
  add(view, resolvedBox);
  var errs = {};   // field -> frow, for server validation messages
  // ---- definition (frontmatter) ----
  var nameIn = el("input", { type: "text", class: "mono", value: f.name, placeholder: "e.g. test-writer", autocomplete: "off", spellcheck: "false", maxlength: "64", disabled: !editable });
  var nameRow = frow("f-agent-name", "Name", isNew ? "Lower-case letters, digits and hyphens. It is also the file name." : editable ? "Renaming renames the file." : "Also the file name.", nameIn);
  nameIn.addEventListener("input", function () { nameIn.value = nameIn.value.toLowerCase(); nameRow.setError(nameProblemUI(nameIn.value)); changed(); });
  errs.name = nameRow; errs.original = nameRow;

  var scope = isNew ? "user" : row.source;
  var scopeRow = null;
  if (isNew) {
    var segU = el("button", { type: "button", "aria-pressed": "true" }, "You");
    var segP = el("button", { type: "button", "aria-pressed": "false" }, "This project");
    var scopeNote = el("div", { class: "note" });
    var paintScope = function () { segU.setAttribute("aria-pressed", String(scope === "user")); segP.setAttribute("aria-pressed", String(scope === "project")); scopeNote.textContent = scope === "user" ? "Saved in " + (list.dirs.userReal || list.dirs.user) + ", for every project." : "Saved in " + (list.dirs.project || "this project's .pi/agents") + "; wins over a user agent of the same name here."; };
    segU.addEventListener("click", function () { scope = "user"; paintScope(); changed(); });
    segP.addEventListener("click", function () { scope = "project"; paintScope(); changed(); });
    paintScope();
    scopeRow = frow("f-agent-scope", "Where", "Who can use it.", el("div", { class: "seg", role: "group", "aria-label": "Where" }, segU, segP), scopeNote);
    errs.scope = scopeRow;
  }

  var descIn = el("input", { type: "text", value: f.description, placeholder: "What it does, in one line: the parent agent reads this to decide when to delegate", maxlength: "500", disabled: !editable });
  var descRow = frow("f-agent-desc", "Description", editable ? "Required. One line." : "How the parent agent decides when to delegate.", descIn);
  descIn.addEventListener("input", function () { descRow.setError(descIn.value.trim() ? null : "a description is required"); changed(); });
  errs.description = descRow;

  var defaultModel = list.settings.defaultModel;
  var mp = modelPicker({ value: f.model, providers: providers, none: "Not set: " + (defaultModel ? "the subagents default, " + defaultModel : "the parent's model"), label: "Model", disabled: !editable, onChange: function () { modelRow.setError(null); changed(); } });
  var ov = a && a.override;
  var modelRow = frow("f-agent-model", "Model", "The agent file's own model.", mp.el, ov && ov.model ? el("div", { class: "note" }, icon("info", 13), " The Models settings override this for " + r.name + ": ", el("code", { text: ov.model }), ".") : null);
  errs.model = modelRow;

  var thSel = thinkingSelect(f.thinking, "Not set", levels, "Thinking");
  thSel.disabled = !editable;
  thSel.addEventListener("change", changed);
  var thRow = frow("f-agent-thinking", "Thinking", "How hard the model reasons before answering.", thSel, ov && ov.thinking ? el("div", { class: "note" }, icon("info", 13), " Overridden in settings: ", el("code", { text: ov.thinking }), ".") : null);
  errs.thinking = thRow;

  // tools: default set, or an allowlist picked from real tool names
  var chosen = (f.tools || []).slice();
  var toolsMode = f.tools === null ? "default" : "only";
  var known = {}; (list.tools || []).forEach(function (t) { known[t.name] = t.from; });
  chosen.forEach(function (t) { if (!known[t]) known[t] = "in this file"; });
  var tmDefault = el("button", { type: "button" }, "Default tools");
  var tmOnly = el("button", { type: "button" }, "Only these");
  var seg = el("div", { class: "seg", role: "group", "aria-label": "Tools" }, tmDefault, tmOnly);
  var chips = el("div", { class: "chips", "aria-live": "polite" });
  var filterIn = el("input", { type: "search", placeholder: "Filter tools", "aria-label": "Filter tools", autocomplete: "off" });
  var otherIn = el("input", { type: "text", class: "mono", placeholder: "mcp:server/tool or another name", "aria-label": "Add a tool by name", autocomplete: "off", spellcheck: "false" });
  var otherBtn = el("button", { type: "button", class: "btn sm" }, "Add");
  var grid = el("div", { class: "tool-grid" });
  var picker = el("div", { class: "tool-pick" }, el("div", { class: "tp-chips" }, chips), el("div", { class: "tp-head" }, filterIn, el("div", { class: "inline tp-add" }, otherIn, otherBtn)), grid);
  var toolsHelp = el("div", { class: "note" });
  var toolsRow = frow("f-agent-tools", "Tools", "What the agent may call.", el("div", { class: "ctl" }, seg, toolsHelp, picker));
  errs.tools = toolsRow;
  var GROUPS = [["pi", "pi"], ["loaded", "Loaded in this agent"], ["named by an agent", "Named by other agents"], ["in this file", "In this file"]];
  function paintTools() {
    tmDefault.setAttribute("aria-pressed", String(toolsMode === "default")); tmOnly.setAttribute("aria-pressed", String(toolsMode === "only"));
    picker.hidden = toolsMode === "default";
    toolsHelp.textContent = toolsMode === "default" ? "No allowlist: the agent gets pi's standard tools (and, run in the background, the parent's extension tools)." : chosen.length + " selected. The agent can call only these.";
    clear(chips);
    if (!chosen.length) chips.appendChild(el("span", { class: "note", text: "None selected yet." }));
    chosen.forEach(function (t) {
      var x = el("button", { type: "button", "aria-label": "Remove " + t, disabled: !editable, text: "×" });
      x.addEventListener("click", function () { chosen = chosen.filter(function (c) { return c !== t; }); paintTools(); changed(); });
      chips.appendChild(el("span", { class: "chip-t" }, t, editable ? x : null));
    });
    clear(grid);
    var v = filterIn.value.trim().toLowerCase();
    GROUPS.forEach(function (g) {
      var names = Object.keys(known).filter(function (n) { return known[n] === g[0] && (!v || n.toLowerCase().indexOf(v) !== -1); }).sort();
      if (!names.length) return;
      grid.appendChild(el("h4", { text: g[1] }));
      grid.appendChild(el("div", { class: "opts" }, names.map(function (n) {
        var cb = el("input", { type: "checkbox", checked: chosen.indexOf(n) !== -1, disabled: !editable });
        cb.addEventListener("change", function () { if (cb.checked) { if (chosen.indexOf(n) === -1) chosen.push(n); } else chosen = chosen.filter(function (c) { return c !== n; }); paintTools(); changed(); });
        return el("label", { class: "tool-opt" }, cb, el("span", { text: n }));
      })));
    });
  }
  tmDefault.addEventListener("click", function () { if (!editable) return; toolsMode = "default"; toolsRow.setError(null); paintTools(); changed(); });
  tmOnly.addEventListener("click", function () { if (!editable) return; toolsMode = "only"; paintTools(); changed(); });
  filterIn.addEventListener("input", paintTools);
  function addOther() {
    var t = otherIn.value.trim();
    if (!t) return;
    if (!/^(mcp:)?[A-Za-z0-9_.\/-]+$/.test(t)) { toolsRow.setError("not a tool name: " + t); return; }
    if (chosen.indexOf(t) === -1) chosen.push(t);
    if (!known[t]) known[t] = "in this file";
    otherIn.value = ""; toolsRow.setError(null); paintTools(); changed();
  }
  otherBtn.addEventListener("click", addOther);
  otherIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addOther(); } });
  if (!editable) { otherIn.disabled = true; otherBtn.disabled = true; }
  paintTools();

  // GitHub access is this agent's own frontmatter (githubTools), not a second list of tool names.
  // Missing on the file is off, which is how every shipped role starts.
  var ghMode = f.githubTools === "read" || f.githubTools === "full" ? f.githubTools : "off";
  var ghOff = el("button", { type: "button" }, "Off");
  var ghRead = el("button", { type: "button" }, "Read");
  var ghFull = el("button", { type: "button" }, "Full");
  var ghSeg = el("div", { class: "seg", role: "group", "aria-label": "GitHub access" }, ghOff, ghRead, ghFull);
  var ghHelp = el("div", { class: "note" });
  var ghRow = frow("f-agent-github", "GitHub", "This agent's GitHub tools. Off until it is given access.", el("div", { class: "ctl" }, ghSeg, ghHelp));
  errs.githubTools = ghRow;
  function paintGh() {
    ghOff.setAttribute("aria-pressed", String(ghMode === "off"));
    ghRead.setAttribute("aria-pressed", String(ghMode === "read"));
    ghFull.setAttribute("aria-pressed", String(ghMode === "full"));
    ghHelp.textContent = ghMode === "off" ? "git and the GitHub tools are excluded for this agent." : ghMode === "read" ? "Those tools stay available. Only status, diff, log, and pull-request and issue reads run." : "Reads, writes, merges, and pushes.";
  }
  function pickGh(mode) { return function () { if (!editable) return; ghMode = mode; ghRow.setError(null); paintGh(); changed(); }; }
  ghOff.addEventListener("click", pickGh("off"));
  ghRead.addEventListener("click", pickGh("read"));
  ghFull.addEventListener("click", pickGh("full"));
  paintGh();

  // advanced: how the prompt is assembled
  var modeSel = el("select", { disabled: !editable }, el("option", { value: "", text: "Not set (replace)" }), el("option", { value: "replace", text: "replace: this prompt only" }), el("option", { value: "append", text: "append: after pi's own prompt" }));
  modeSel.value = f.systemPromptMode || "";
  function triSelect(v) {
    var s = el("select", { disabled: !editable });
    if (v === undefined) s.appendChild(el("option", { value: "", text: "Not set (the package default)" }));
    s.appendChild(el("option", { value: "true", text: "On" })); s.appendChild(el("option", { value: "false", text: "Off" }));
    s.value = v === undefined ? "" : String(v);
    s.addEventListener("change", changed);
    return s;
  }
  var ctxSel = triSelect(f.inheritProjectContext), skillSel = triSelect(f.inheritSkills);
  modeSel.addEventListener("change", changed);
  var adv = el("details", { class: "adv" }, el("summary", {}, "Prompt assembly and context"),
    el("div", { class: "rows" },
      frow("f-agent-mode", "System prompt", "Replace pi's base prompt, or add to it.", modeSel),
      frow("f-agent-ctx", "Project instructions", "Keep AGENTS.md / CLAUDE.md from the repository.", ctxSel),
      frow("f-agent-skills", "Skills catalog", "Let the agent see the discovered skills.", skillSel)));
  var extraKeys = a ? Object.keys(a.extra || {}) : [];
  var extra = extraKeys.length ? el("div", { class: "extra" }, el("div", { class: "lab-t", text: "Other fields in this file" }),
    el("p", { class: "note", text: "Kept exactly as they are when you save. Edit the file to change them." }),
    kv(extraKeys.map(function (k) { return [k, el("span", { class: "mono", text: a.extra[k] })]; }))) : null;
  var cli = row && row.cli;
  var cliRow = cli ? frow("f-agent-cli", "Runs", "Model, thinking and tools come from this tool, not from Kernal.",
    el("div", {}, el("span", { class: "tag cli", text: cli.tool + " CLI" }), " ", el("code", { text: cli.command }), " ", cliState(cli), " ", el("span", { class: "tag" + (cli.writes ? " warn" : ""), text: cli.writes ? "writes files" : "read-only" })),
    el("div", { class: "note" }, "The description and the prompt are the parts you can change: the prompt is sent to " + cli.tool + " with every task." + (!cli.installed && !cli.unknown && cli.install ? " Install it with: " : ""), !cli.installed && !cli.unknown && cli.install ? el("code", { text: cli.install }) : null)) : null;
  add(view, card("Definition", cli ? "The frontmatter: this agent runs the " + cli.tool + " CLI." : "The frontmatter: how pi-subagents runs this agent.", null,
    [el("div", { class: "rows" }, cli ? [nameRow, scopeRow, descRow, cliRow] : [nameRow, scopeRow, descRow, modelRow, thRow, toolsRow, ghRow]), adv, extra]));

  // ---- prompt: a Markdown editor with toolbar, shortcuts and a live preview ----
  var ta = el("textarea", { class: "md-input", spellcheck: "true", "aria-label": "System prompt, Markdown", readonly: !editable, id: "f-agent-prompt" });
  ta.value = prompt;
  var preview = el("div", { class: "md-preview", "aria-label": "Preview", tabindex: "0" });
  var body = el("div", { class: "md-body" }, ta, preview);
  var stats = el("span", {});
  var promptErr = el("div", { class: "err", hidden: true, role: "alert" });
  var tb = el("div", { class: "md-toolbar", role: "toolbar", "aria-label": "Formatting" });
  function tool(label, title, fn, cls) { var b = el("button", { type: "button", class: "tb" + (cls ? " " + cls : ""), title: title, "aria-label": title, text: label }); b.addEventListener("mousedown", function (e) { e.preventDefault(); }); b.addEventListener("click", function () { fn(); ta.focus(); }); return b; }
  var viewMode = "split";
  var vm = {};
  var modeSeg = el("div", { class: "seg sm", role: "group", "aria-label": "Layout" }, ["split", "write", "preview"].map(function (k) {
    var b = el("button", { type: "button", "aria-pressed": String(k === viewMode) }, k === "split" ? "Split" : k === "write" ? "Write" : "Preview");
    b.addEventListener("click", function () { viewMode = k; body.className = "md-body" + (k === "split" ? "" : " " + k); for (var j in vm) vm[j].setAttribute("aria-pressed", String(j === k)); if (k !== "write") renderPreview(); });
    vm[k] = b; return b;
  }));
  if (editable) add(tb, [
    tool("H1", "Heading 1 (" + MOD + ALT + "1)", function () { heading(1); }),
    tool("H2", "Heading 2 (" + MOD + ALT + "2)", function () { heading(2); }),
    tool("H3", "Heading 3 (" + MOD + ALT + "3)", function () { heading(3); }),
    el("span", { class: "sep" }),
    tool("B", "Bold (" + MOD + "B)", function () { wrap("**"); }, "b"),
    tool("I", "Italic (" + MOD + "I)", function () { wrap("*"); }, "i"),
    el("span", { class: "sep" }),
    tool("• List", "Bulleted list (" + MOD + SHIFT + "8)", function () { listify(false); }),
    tool("1. List", "Numbered list (" + MOD + SHIFT + "7)", function () { listify(true); }),
    tool("“", "Quote", function () { prefixLines("> "); }),
    el("span", { class: "sep" }),
    tool(BT + "code" + BT, "Inline code (" + MOD + "E)", function () { wrap(BT); }, "mono"),
    tool("{ }", "Code block (" + MOD + ALT + "C)", codeBlock, "mono"),
    tool("Link", "Link (" + MOD + "K)", link),
    el("span", { class: "grow" }), modeSeg]);
  else add(tb, [el("span", { class: "note", text: "Read-only" }), el("span", { class: "grow" }), modeSeg]);
  var md = el("div", { class: "md" }, tb, body, el("div", { class: "md-foot" }, stats, el("span", { class: "keys" }, editable ? [el("kbd", { text: MOD + "S" }), " save · ", el("kbd", { text: "Enter" }), " continues a list · ", el("kbd", { text: "Tab" }), " indents it"] : null)));
  add(view, card("Prompt", "The body of the file: the agent's system prompt, in Markdown. What you type is saved as it is.", null, [md, promptErr]));

  function sel() { return { s: ta.selectionStart, e: ta.selectionEnd, v: ta.value }; }
  /** Replace a range and keep the browser's undo stack (execCommand is the only way that does). */
  function replace(start, end, text, selStart, selEnd) {
    ta.focus(); ta.setSelectionRange(start, end);
    var ok = false; try { ok = document.execCommand("insertText", false, text); } catch (e) {}
    if (!ok || ta.value.slice(start, start + text.length) !== text) ta.setRangeText(text, start, end, "end");
    ta.setSelectionRange(selStart === undefined ? start + text.length : selStart, selEnd === undefined ? (selStart === undefined ? start + text.length : selStart) : selEnd);
    onInput();
  }
  function wrap(mark) {
    var c = sel(), inner = c.v.slice(c.s, c.e), n = mark.length;
    if (c.v.slice(c.s - n, c.s) === mark && c.v.slice(c.e, c.e + n) === mark) { replace(c.s - n, c.e + n, inner, c.s - n, c.e - n); return; }
    if (inner.length > 2 * n && inner.slice(0, n) === mark && inner.slice(-n) === mark) { replace(c.s, c.e, inner.slice(n, -n), c.s, c.e - 2 * n); return; }
    var text = inner || (mark === BT ? "code" : "text");
    replace(c.s, c.e, mark + text + mark, c.s + n, c.s + n + text.length);
  }
  function lineRange() { var c = sel(); var a0 = c.v.lastIndexOf("\n", c.s - 1) + 1; var b0 = c.v.indexOf("\n", c.e > c.s && c.v[c.e - 1] === "\n" ? c.e - 1 : c.e); if (b0 === -1) b0 = c.v.length; return { a: a0, b: b0, text: c.v.slice(a0, b0) }; }
  function prefixLines(p) {
    var r = lineRange(), lines = r.text.split("\n");
    var all = lines.every(function (l) { return l.indexOf(p) === 0; });
    var out = lines.map(function (l) { return all ? l.slice(p.length) : p + l; }).join("\n");
    replace(r.a, r.b, out, r.a, r.a + out.length);
  }
  function listify(numbered) {
    var r = lineRange(), lines = r.text.split("\n");
    var re = numbered ? /^(\s*)\d+[.)]\s+/ : /^(\s*)[-*+]\s+/;
    var all = lines.every(function (l) { return re.test(l); });
    var i = 0;
    var out = lines.map(function (l) {
      if (all) return l.replace(re, "$1");
      var bare = l.replace(/^(\s*)([-*+]|\d+[.)])\s+/, "$1");
      var ind = bare.match(/^\s*/)[0];
      return ind + (numbered ? (++i) + ". " : "- ") + bare.slice(ind.length);
    }).join("\n");
    replace(r.a, r.b, out, r.a, r.a + out.length);
  }
  function heading(level) {
    var r = lineRange(), first = r.text.split("\n")[0];
    var m = first.match(/^(#{1,6})\s+/);
    var bare = first.replace(/^#{1,6}\s+/, "");
    var next = m && m[1].length === level ? bare : new Array(level + 1).join("#") + " " + bare;
    var end = r.a + first.length;
    replace(r.a, end, next, r.a + next.length);
  }
  function codeBlock() {
    var c = sel(), fence = BT + BT + BT;
    var inner = c.v.slice(c.s, c.e) || "code";
    var before = c.s > 0 && c.v[c.s - 1] !== "\n" ? "\n" : "";
    var text = before + fence + "\n" + inner.replace(/\n$/, "") + "\n" + fence + "\n";
    var at = c.s + before.length + fence.length + 1;
    replace(c.s, c.e, text, at, at + inner.replace(/\n$/, "").length);
  }
  function link() {
    var c = sel(), label = c.v.slice(c.s, c.e) || "text", url = "https://";
    var text = "[" + label + "](" + url + ")";
    var at = c.s + label.length + 3;
    replace(c.s, c.e, text, at, at + url.length);
  }
  ta.addEventListener("keydown", function (e) {
    if (!editable) return;
    var mod = e.metaKey || e.ctrlKey;
    var k = (e.key || "").toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && k === "b") { e.preventDefault(); wrap("**"); return; }
    if (mod && !e.shiftKey && !e.altKey && k === "i") { e.preventDefault(); wrap("*"); return; }
    if (mod && !e.shiftKey && !e.altKey && k === "e") { e.preventDefault(); wrap(BT); return; }
    if (mod && !e.shiftKey && !e.altKey && k === "k") { e.preventDefault(); link(); return; }
    if (mod && e.altKey && /^Digit[1-3]$/.test(e.code)) { e.preventDefault(); heading(Number(e.code.slice(5))); return; }
    if (mod && e.altKey && e.code === "KeyC") { e.preventDefault(); codeBlock(); return; }
    if (mod && e.shiftKey && e.code === "Digit8") { e.preventDefault(); listify(false); return; }
    if (mod && e.shiftKey && e.code === "Digit7") { e.preventDefault(); listify(true); return; }
    var c = sel(), ls = c.v.lastIndexOf("\n", c.s - 1) + 1, line = c.v.slice(ls, c.s);
    var item = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey && c.s === c.e && item && !e.isComposing) {
      e.preventDefault();
      if (!item[4].trim()) { replace(ls, c.s, "", ls); return; }   // Enter on an empty item ends the list
      var marker = /\d/.test(item[2]) ? (parseInt(item[2], 10) + 1) + item[2].slice(-1) : item[2];
      var ins = "\n" + item[1] + marker + item[3];
      replace(c.s, c.e, ins, c.s + ins.length);
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey && item) {
      e.preventDefault();
      if (e.shiftKey) { if (/^ {1,2}/.test(line)) { var cut = line.match(/^ {1,2}/)[0].length; replace(ls, ls + cut, "", c.s - cut); } }
      else replace(ls, ls, "  ", c.s + 2);
    }
  });
  var previewTimer = null, previewSeq = 0;
  function renderPreview() {
    if (viewMode === "write") return;
    var mine = ++previewSeq;
    api("POST", "/subagents/preview", { markdown: ta.value }).then(function (res) {
      if (mine !== previewSeq) return;
      preview.replaceChildren.apply(preview, safeHtml(res.html));
      if (!ta.value.trim()) preview.replaceChildren(el("p", { class: "note", text: "Nothing to preview yet." }));
    }, function (e) { if (mine === previewSeq) preview.replaceChildren(el("p", { class: "note", text: e.status === 500 ? "Preview withheld: the prompt contains something that looks like a key." : "Preview unavailable: " + e.message })); });
  }
  function paintStats() {
    var v = ta.value, tokens = Math.ceil(v.length / 4), lines = v ? v.split("\n").length : 0;
    stats.textContent = "≈ " + fmt(tokens) + " tokens · " + fmt(lines) + " lines · " + fmt(v.length) + " characters";
    stats.title = "Approximate: characters ÷ 4, the estimate pi itself uses. The prompt is sent on every call this agent makes.";
  }
  function onInput() {
    paintStats(); changed();
    promptErr.hidden = true;
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 180);
  }
  ta.addEventListener("input", onInput);
  // keep the preview roughly at the same place as the text
  ta.addEventListener("scroll", function () { var max = ta.scrollHeight - ta.clientHeight; if (max > 0) preview.scrollTop = (ta.scrollTop / max) * (preview.scrollHeight - preview.clientHeight); });
  paintStats(); renderPreview();
  cleanup.push(function () { clearTimeout(previewTimer); previewSeq++; });

  // ---- what pi-subagents resolves (filled in below; shown first, it is the point of the page) ----
  function paintResolved(v, note) {
    clear(resolvedBox);
    if (!v) return;
    if (!v.found) { add(resolvedBox, card("What pi-subagents resolves", null, null, el("p", { class: "note", text: "No agent named " + v.name + " is resolved: it is disabled, or it was removed." }))); return; }
    var other = row && v.file !== row.file;
    add(resolvedBox, card("What pi-subagents resolves", other ? "A delegation to " + v.name + " does not get this file: the " + v.source + " agent of the same name wins." : note || "Read back from the package: this is exactly what a delegation to " + v.name + " gets.", pill(other ? "warn" : "ok", other ? v.source + " copy wins" : "this file wins"), kv([
      ["File", el("span", { class: "mono", text: v.file })],
      v.cli ? ["Runs", el("span", {}, el("span", { text: "the " + v.cli.tool + " CLI (" }), el("code", { text: v.cli.command }), el("span", { text: "), " + (v.cli.unknown ? v.cli.reason : v.cli.installed ? "installed" : "not installed") }))] : null,
      ["Model", v.cli ? v.cli.tool + "'s own: set in " + v.cli.tool + "; Kernal's model settings do not apply" : el("span", {}, el("span", { class: "mono", text: v.model || "the parent's model" }), el("span", { class: "note", text: "  from " + v.modelFrom }))],
      v.cli ? null : ["Thinking", v.thinking || "not set"],
      ["Tools", v.cli ? v.cli.tool + "'s own, as its adapter allows" : v.tools ? el("span", { class: "mono", text: v.tools.join(", ") }) : "default tools"],
      ["Description", v.description],
      ["Prompt", fmt(v.promptChars) + " characters, " + (v.systemPromptMode || "replace") + " mode"]
    ])));
  }
  if (a) paintResolved(a.resolved);

  // ---- state, dirty tracking, save ----
  function collect() {
    return {
      name: nameIn.value.trim(), scope: scope, description: descIn.value.trim(), model: mp.get(), thinking: thSel.value,
      tools: toolsMode === "default" ? null : chosen.slice(), githubTools: ghMode, systemPromptMode: modeSel.value,
      inheritProjectContext: ctxSel.value === "" ? undefined : ctxSel.value === "true", inheritSkills: skillSel.value === "" ? undefined : skillSel.value === "true",
      prompt: ta.value
    };
  }
  var initial = JSON.stringify(collect());
  var saveBtn = el("button", { class: "btn primary", type: "button" }, isNew ? "Create agent" : "Save");
  var discardBtn = el("button", { class: "btn ghost", type: "button" }, "Discard");
  var stateText = el("span", {});
  var bar = el("div", { class: "savebar", role: "region", "aria-label": "Save changes" }, el("div", { class: "state" }, el("span", { class: "d", "aria-hidden": "true" }), stateText), discardBtn, saveBtn);
  function isDirty() { return JSON.stringify(collect()) !== initial ? 1 : 0; }
  function changed() {
    var n = isDirty();
    bar.classList.toggle("dirty", !!n);
    stateText.textContent = n ? (isNew ? "Not created yet" : "Unsaved changes") : isNew ? "Fill in the fields to create it" : "Saved";
    saveBtn.disabled = !n && !isNew; discardBtn.disabled = !n;
    var a2 = document.getElementById("nav-subagents"), dot = a2 && a2.querySelector(".dot");
    if (n && a2 && !dot) a2.appendChild(el("span", { class: "dot", "aria-label": "unsaved changes" }));
    if (!n && dot) dot.remove();
  }
  if (editable) { add(view, bar); dirty = isDirty; changed(); }
  discardBtn.addEventListener("click", function () { if (confirm("Discard your changes?")) { dirty = null; show(); } });
  function onKey(e) { if ((e.metaKey || e.ctrlKey) && (e.key || "").toLowerCase() === "s") { e.preventDefault(); if (editable && !saveBtn.disabled) save(); } }
  document.addEventListener("keydown", onKey);
  cleanup.push(function () { document.removeEventListener("keydown", onKey); var dd = document.querySelector("#nav-subagents .dot"); if (dd) dd.remove(); });
  saveBtn.addEventListener("click", save);

  function save() {
    var v = collect();
    var problems = 0;
    var np = nameProblemUI(v.name); nameRow.setError(np); if (np) problems++;
    descRow.setError(v.description ? null : "a description is required"); if (!v.description) problems++;
    if (!cli) {   // a command-line agent's model, thinking and tools are not on the page, so they are not checked here
      if (v.tools && !v.tools.length) { toolsRow.setError("pick at least one tool, or use the default tools"); problems++; } else toolsRow.setError(null);
      if (v.model && !/^[A-Za-z0-9._-]+\/[^\s,]+$/.test(v.model)) { modelRow.setError("a provider/model id, e.g. litellm/claude-sonnet-5"); problems++; }
    }
    if (problems) { toast("Nothing saved: fix the highlighted fields", "error"); var inv = view.querySelector("[aria-invalid=true]"); if (inv) inv.focus(); return; }
    var body = { mode: isNew ? "create" : "update", scope: isNew ? scope : row.source, name: v.name, description: v.description, tools: v.tools, githubTools: v.githubTools, model: v.model, thinking: v.thinking, prompt: v.prompt };
    if (!isNew) body.original = row.name;
    if (v.systemPromptMode) body.systemPromptMode = v.systemPromptMode;
    if (v.inheritProjectContext !== undefined) body.inheritProjectContext = v.inheritProjectContext;
    if (v.inheritSkills !== undefined) body.inheritSkills = v.inheritSkills;
    saveBtn.disabled = true; saveBtn.replaceChildren(spinner(), "Saving");
    api("POST", "/subagents/agent", body).then(function (res) {
      (res.warnings || []).forEach(function (w) { toast(w, "warn"); });
      toast(isNew ? "Created " + v.name : "Saved " + v.name, "ok");
      subagentFlash = { kind: "info", text: "Saved and checked: pi-subagents re-discovered " + v.name + " and resolves it to this " + res.resolved.source + " file, with the settings you chose." };
      initial = JSON.stringify(collect());
      go(agentHref("edit", body.scope, v.name));
    }, function (e) {
      saveBtn.replaceChildren(isNew ? "Create agent" : "Save"); changed();
      var errs2 = e.data && e.data.errors;
      if (errs2) {
        var unseen = [];
        for (var k in errs2) {
          if (k === "prompt") { promptErr.hidden = false; clear(promptErr); add(promptErr, [icon("alert", 14), el("span", { text: errs2[k] })]); }
          else if (errs[k] && !(cli && (k === "model" || k === "thinking" || k === "tools"))) errs[k].setError(errs2[k]);
          else unseen.push(k + ": " + errs2[k]);
        }
        if (unseen.length) add(resolvedBox, callout("error", "Not saved. The file has fields this page does not show; fix them in " + row.file + ". " + unseen.join("; ")));
        toast(unseen.length ? "Nothing saved: see the message above" : "Nothing saved: fix the highlighted fields", "error");
      } else { toast(e.message, "error"); add(resolvedBox, callout("error", e.message)); }
    });
  }
  view.setAttribute("aria-busy", "false");
  if (isNew) nameIn.focus();
}

function nameProblemUI(n) {
  if (!n) return "a name is required";
  if (/[\/\\]/.test(n) || n.indexOf("..") !== -1) return "no slashes or dots: the name becomes the file name";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) return "lower-case letters, digits and hyphens, starting with a letter or digit";
  return null;
}

/**
 * The preview's HTML comes from the server's markdownToHtml, which escapes everything before adding
 * markup. It is still parsed inertly and rebuilt from an allowlist here, so nothing but these tags
 * and a checked href can reach the page.
 */
var PREVIEW_TAGS = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, UL: 1, OL: 1, LI: 1, PRE: 1, CODE: 1, STRONG: 1, EM: 1, A: 1, BLOCKQUOTE: 1, HR: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, BR: 1 };
function safeHtml(html) {
  var doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
  function copy(node) {
    if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
    if (node.nodeType !== 1) return null;
    var kids = Array.prototype.map.call(node.childNodes, copy).filter(Boolean);
    if (!PREVIEW_TAGS[node.tagName]) return kids.length ? el("span", {}, kids) : null;
    var out = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === "A") { var h = node.getAttribute("href") || ""; if (/^https?:\/\//i.test(h)) { out.setAttribute("href", h); out.setAttribute("rel", "noreferrer noopener"); out.setAttribute("target", "_blank"); } }
    if ((node.tagName === "TH" || node.tagName === "TD") && node.getAttribute("class") === "num") out.className = "num";
    kids.forEach(function (k) { out.appendChild(k); });
    return out;
  }
  return Array.prototype.map.call(doc.body.childNodes, copy).filter(Boolean);
}

// ---------- start ----------
if (!token) { gone("Open this page from kernal", "Run /admin in kernal: it opens the page with a one-time key for this session."); return; }
buildNav();
show();
ping();
var pinger = setInterval(ping, 30000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) ping(); });
})();
`;
