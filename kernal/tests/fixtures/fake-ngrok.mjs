// A stand-in for the ngrok agent program (tests/tunnel.test.ts, #380). Never contacts ngrok: it
// answers `ngrok version`, and for `ngrok http <addr> ...` records what it was given and serves a
// plain loopback forwarder to <addr> as the "public" URL, so a test can drive requests through the
// whole chain. Run through a per-test wrapper script:
//   node fake-ngrok.mjs <behaviour.json> <ngrok args...>
// behaviour.json: { version, mode: "ok" | "fail" | "hang" | "die" | "no-url", record }.
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const [behaviourFile, ...args] = process.argv.slice(2);
const b = JSON.parse(readFileSync(behaviourFile, "utf8"));
const log = (rec) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n");

if (args[0] === "version") {
  process.stdout.write(`ngrok version ${b.version ?? "3.39.11"}\n`);
  process.exit(0);
}
if (args[0] !== "http") {
  process.stderr.write(`fake ngrok: unexpected ${args.join(" ")}\n`);
  process.exit(2);
}
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const addr = args[1];
const record = {
  args,
  config: readFileSync(flag("--config"), "utf8"),
  policy: readFileSync(flag("--traffic-policy-file"), "utf8"),
  envKeys: Object.keys(process.env).sort(),
  pid: process.pid,
};
const save = () => writeFileSync(b.record, JSON.stringify(record));
process.on("SIGTERM", () => process.exit(0));

if (b.mode === "fail") {
  save();
  log({ lvl: "crit", msg: "command failed", err: "authentication failed: The authtoken you specified is invalid.\n\nERR_NGROK_105" });
  process.exit(1);
}
if (b.mode === "hang") {
  save();
  setInterval(() => {}, 1000);
} else {
  const target = new URL(addr);
  const server = http.createServer((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.listen(0, "127.0.0.1", () => {
    record.forwarderUrl = `http://127.0.0.1:${server.address().port}`;
    save();
    log({ lvl: "info", msg: "client session established", obj: "tunnels.session" });
    const url = b.mode === "no-url" ? undefined : (flag("--url") ?? `https://fake-${process.pid}.ngrok-free.app`);
    log({ lvl: "info", msg: "started tunnel", obj: "tunnels", name: "command_line", addr, ...(url ? { url } : {}) });
    if (b.mode === "die") setTimeout(() => process.exit(3), 150);
  });
}
