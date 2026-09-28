// Browser IDE spike S3/S4/S5, local half (docs/specs/browser-ide.md, phase 0; issue #240).
//
//   browser ──> counting relay ──> LocalPreviewProxy (agentd's, unchanged) ──> code-server
//
// Chromium maps ide-test.kernal.run to 127.0.0.1, so code-server sees the headers it will see in
// production: Host rewritten to localhost:<port>, X-Forwarded-Host the public name, and (on the
// WebSocket upgrade) Origin rewritten to localhost. The relay parses the client's WebSocket frames
// (client frames are masked) and counts them per phase, by opcode, for S4's activity floor.
//
// Usage: node deploy/ide/spike/harness.mjs [--container ide-spike] [--target 18080] [--phase-seconds 120]
import { createServer, connect } from "node:net";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
// In the pod, the image's Playwright (/opt/outfitter/playwright) via PLAYWRIGHT_MODULE.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
import { readFileSync } from "node:fs";

// S3 finding: agentd's proxy rewrites Origin to localhost on upgrades but passes the public host in
// X-Forwarded-Host; code-server compares the two and answers 403 to every WebSocket. The IDE's proxy
// must leave Origin alone (KEEP_ORIGIN=1, the default here). KEEP_ORIGIN=0 runs agentd's proxy as is.
const KEEP_ORIGIN = process.env.KEEP_ORIGIN !== "0";
const proxySrc = process.env.PREVIEW_PROXY_SRC
  ? new URL(`file://${process.env.PREVIEW_PROXY_SRC}`)
  : new URL("../../../packages/agentd/src/preview-proxy.ts", import.meta.url);
let LocalPreviewProxy;
if (KEEP_ORIGIN) {
  const src = readFileSync(proxySrc, "utf8");
  const needle = "if (out.origin) out.origin = `http://localhost:${port}`;";
  if (!src.includes(needle)) throw new Error("preview-proxy.ts changed; update the spike patch");
  const patched = "/tmp/ide-spike-preview-proxy.ts";
  writeFileSync(patched, src.replace(needle, "/* spike: Origin kept */"));
  ({ LocalPreviewProxy } = await import(patched));
} else {
  ({ LocalPreviewProxy } = await import(proxySrc.href));
}

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const CONTAINER = arg("container", "ide-spike");
const TARGET = Number(arg("target", "18080"));
const PHASE_S = Number(arg("phase-seconds", "120"));
const HOST = "ide-test.kernal.run";
// RESULTS_TAG separates runs (e.g. "local", "gke"). IDE_EXEC replaces `docker exec <container>` for
// commands in the IDE's environment (gke-run.sh sets it to `kubectl ... exec <pod> --`).
const TAG = process.env.RESULTS_TAG ?? "local";
const RESULTS_DIR = process.env.RESULTS_DIR ?? new URL(".", import.meta.url).pathname;
const OUT = `${RESULTS_DIR}/s4-results-${TAG}.jsonl`;
const CHECKS = `${RESULTS_DIR}/s3-results-${TAG}.json`;
mkdirSync("/tmp/ide-spike", { recursive: true });
const EXEC = process.env.IDE_EXEC ? process.env.IDE_EXEC.split(" ").filter(Boolean) : ["docker", "exec", CONTAINER];
writeFileSync(OUT, "");

const sh = (cmd) => execFileSync(EXEC[0], [...EXEC.slice(1), "sh", "-c", cmd], { encoding: "utf8" }).trim();

// ---------- counting relay with a client-frame parser ----------
let counters;
function resetCounters() { counters = { c2sBytes: 0, s2cBytes: 0, frames: {}, dataFrames: 0, dataBytes: 0 }; }
resetCounters();
const OPC = { 0: "cont", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong" };

function frameParser() {
  let buf = Buffer.alloc(0);
  let upgraded = false;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      if (process.env.DEBUG_RELAY) console.log("[relay] request:", head.split("\r\n")[0], /^upgrade:/im.test(head) ? "(upgrade)" : "");
      if (!/^upgrade:\s*websocket/im.test(head)) { buf = Buffer.alloc(0); return; } // plain HTTP: not counted as frames
      upgraded = true;
      buf = buf.subarray(end + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf[1] & 0x80) off += 4; // mask key
      if (buf.length < off + len) return;
      const name = OPC[op] ?? `op${op}`;
      counters.frames[name] = (counters.frames[name] ?? 0) + 1;
      if (process.env.DEBUG_RELAY && counters.frames[name] <= 2) console.log("[relay] frame", name, len);
      if (op === 1 || op === 2 || op === 0) { counters.dataFrames++; counters.dataBytes += len; }
      buf = buf.subarray(off + len);
    }
  };
}

async function startRelay(upstreamPort) {
  const server = createServer((client) => {
    const up = connect(upstreamPort, "127.0.0.1");
    const parse = frameParser();
    client.on("data", (d) => { counters.c2sBytes += d.length; parse(d); up.write(d); });
    up.on("data", (d) => { counters.s2cBytes += d.length; client.write(d); });
    const close = () => { client.destroy(); up.destroy(); };
    client.on("error", close); up.on("error", close); client.on("close", close); up.on("close", close);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function memory() {
  // cgroup v2 memory.current (includes page cache) and the agent user's summed VmRSS (no procps needed).
  // gVisor has no cgroup v2 memory.current; fall back to v1, then to /proc/meminfo's used memory.
  const out = sh("cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {print (t-a)*1024}' /proc/meminfo; awk -v u=$(id -u agent) '/^Uid:/ {m = ($2 == u)} /^VmRSS:/ && m {s += $2} END {print s+0}' /proc/[0-9]*/status 2>/dev/null");
  const [cg, rss] = out.split("\n").map(Number);
  return { cgroupMb: Math.round(cg / 1048576), agentRssMb: Math.round(rss / 1024) };
}
function heartbeatAge() {
  try { return Number(sh("echo $(( $(date +%s) - $(stat -c %Y /home/agent/.local/share/code-server/heartbeat) ))")); } catch { return null; }
}

const checks = {};
async function check(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); checks[name] = { ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) }; }
  catch (err) { checks[name] = { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 400) }; }
  await page.screenshot({ path: `/tmp/ide-spike/${name}.png` }).catch(() => {});
  console.log(name, checks[name].ok ? "PASS" : "FAIL", checks[name].error ?? checks[name].detail ?? "");
}

async function phase(name, seconds, action) {
  resetCounters();
  const hb0 = heartbeatAge();
  const t0 = Date.now();
  const stop = { v: false };
  const running = action ? action(stop) : Promise.resolve();
  await sleep(seconds * 1000);
  stop.v = true;
  await running;
  const row = { phase: name, seconds: (Date.now() - t0) / 1000, ...counters, heartbeatAgeStart: hb0, heartbeatAgeEnd: heartbeatAge(), memory: memory() };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}

// ---------- run ----------
const proxy = new LocalPreviewProxy({ port: TARGET, onActivity: () => { counters.pageRequests = (counters.pageRequests ?? 0) + 1; }, onLog: (l) => console.log("[proxy]", l) });
await proxy.start();
const relayPort = await startRelay(proxy.port);
const url = `http://${HOST}:${relayPort}/?folder=/workspace`;
console.log("proxy", proxy.port, "relay", relayPort, url);

const launchOpts = {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${relayPort}`,
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
};
let browser;
try { browser = await chromium.launch(process.env.HARNESS_CHANNEL ? { ...launchOpts, channel: process.env.HARNESS_CHANNEL } : launchOpts); }
catch (err) { console.log("headless shell failed, trying full chromium:", String(err.message).split("\n")[0]); browser = await chromium.launch({ ...launchOpts, channel: "chromium" }); }
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = async (cmd) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+Shift+P`);
  await page.locator(".quick-input-widget input.input").first().waitFor({ state: "visible" });
  await page.keyboard.type(cmd);
  await sleep(600);
  await page.keyboard.press("Enter");
};

const openFromExplorer = async (name) => {
  await page.keyboard.press("Escape");
  await page.locator(".explorer-folders-view .monaco-list-row", { hasText: name }).first().dblclick();
  await page.locator(".tabs-container .tab", { hasText: name }).first().waitFor({ timeout: 60_000 });
  await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 60_000 });
};
console.log("baseline memory (no client)", JSON.stringify(memory()));

await check("s3.load", async () => {
  await page.goto(url);
  await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
  await page.locator(".explorer-folders-view .monaco-list-row", { hasText: "package.json" }).first().waitFor({ timeout: 60_000 });
});
await sleep(3000);
// Workspace Trust prompt, if any.
await page.getByRole("button", { name: /Yes, I trust/i }).click({ timeout: 3000 }).catch(() => {});

await check("s3.ripgrep", async () => {
  // Quick Open and search run code-server's bundled ripgrep; run it directly as agent.
  return sh("rg=$(ls -d /opt/code-server/lib/vscode/node_modules/@vscode/ripgrep-universal/bin/linux-*/rg | head -1); s=$(date +%s%N); n=$(su agent -s /bin/sh -c \"cd /workspace && timeout 30 $rg --files | wc -l\"); echo \"$n files in $(( ($(date +%s%N) - s) / 1000000 )) ms\"");
});

await check("s3.edit-and-save", async () => {
  await openFromExplorer("readme.md");
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press(`${mod}+Home`);
  await page.keyboard.type("SPIKE-EDIT-MARKER\n");
  await page.keyboard.press(`${mod}+S`);
  await sleep(1500);
  const n = sh("grep -c SPIKE-EDIT-MARKER /workspace/readme.md || true");
  if (n === "0") throw new Error("the saved file has no marker");
  return sh("stat -c %U /workspace/readme.md");
});

await check("s3.terminal", async () => {
  await palette("Terminal: Create New Terminal");
  await page.locator(".xterm-helper-textarea").first().waitFor({ state: "attached", timeout: 60_000 });
  await sleep(4000); // xterm draws on a canvas, so wait for the shell rather than match its prompt
  await page.locator(".xterm-helper-textarea").first().focus({ timeout: 60_000 });
  await page.keyboard.type("echo from-terminal $(id -un) > /workspace/t.txt\n");
  await sleep(2500);
  const out = sh("cat /workspace/t.txt 2>&1; stat -c %U /workspace/t.txt 2>&1");
  if (!out.startsWith("from-terminal agent")) throw new Error(`t.txt: ${JSON.stringify(out)}`);
  return out;
});

await check("s3.file-watcher", async () => {
  sh("su agent -s /bin/sh -c 'echo x > /workspace/from-model.txt'");
  await page.locator(".explorer-folders-view .monaco-list-row", { hasText: "from-model.txt" }).first().waitFor({ timeout: 15_000 });
});

await check("s3.quick-open", async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+P`);
  await page.locator(".quick-input-widget input.input").first().waitFor({ state: "visible" });
  await page.keyboard.type("package.json");
  await page.locator(".quick-input-widget .monaco-list-row", { hasText: "package.json" }).first().waitFor({ timeout: 90_000 });
  await page.keyboard.press("Enter");
  await page.locator(".tabs-container .tab", { hasText: "package.json" }).first().waitFor({ timeout: 30_000 });
});

await check("s3.webview-markdown-preview", async () => {
  await openFromExplorer("readme.md");
  await palette("Markdown: Open Preview to the Side");
  for (let i = 0; i < 40; i++) {
    for (const f of page.frames()) {
      const txt = await f.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (f !== page.mainFrame() && txt.includes("SPIKE-EDIT-MARKER")) return f.url().replace(/\?.*/, "");
    }
    await sleep(500);
  }
  throw new Error(`no webview frame rendered the file; frames: ${page.frames().map((f) => f.url().slice(0, 80)).join(" | ")}`);
});

await check("s3.openvsx-cli-install", async () => {
  return sh("su agent -s /bin/sh -c 'env -i HOME=/home/agent PATH=/usr/bin:/bin /opt/code-server/bin/code-server --config /etc/code-server.yaml --extensions-dir /home/agent/.local/share/code-server/extensions --install-extension redhat.vscode-yaml 2>&1 | tail -2'");
});

await check("s3.openvsx-ui-search", async () => {
  await page.locator(".editor-group-container").first().click();
  await page.keyboard.press(`${mod}+Shift+X`);
  await page.locator(".extensions-viewlet").first().waitFor({ timeout: 15_000 });
  await sleep(1000);
  await page.keyboard.type("prettier"); // the view focuses its search box
  await page.locator(".extensions-viewlet .monaco-list-row .name", { hasText: /Prettier/i }).first().waitFor({ timeout: 30_000 });
});

writeFileSync(CHECKS, JSON.stringify({ checks, consoleErrors: consoleErrors.slice(0, 20) }, null, 2));

// S4: activity at the proxy. Close side panels so only the editor is live.
await page.keyboard.press(`${mod}+B`).catch(() => {});
await page.locator(".monaco-editor .view-lines").first().click().catch(() => {});
await phase("idle-focused", PHASE_S);
await phase("typing", PHASE_S, async (stop) => {
  while (!stop.v) { await page.keyboard.type("abc ", { delay: 120 }); await sleep(400); }
});
await phase("idle-after-typing", PHASE_S);
await phase("scrolling-reading", PHASE_S, async (stop) => {
  while (!stop.v) { await page.mouse.wheel(0, 200); await sleep(1500); }
});
await phase("terminal-command", Math.min(PHASE_S, 60), async (stop) => {
  await palette("Terminal: Focus Terminal");
  await sleep(1000);
  while (!stop.v) { await page.keyboard.type("ls\n"); await sleep(3000); }
});
// A tab someone left open behind other tabs.
const other = await ctx.newPage();
await other.goto("about:blank");
await other.bringToFront();
await phase("idle-background-tab", PHASE_S);

await browser.close();
await proxy.stop();
console.log("done; results in", OUT, "and", CHECKS);
process.exit(0);
