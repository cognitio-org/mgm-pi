/**
 * A stand-in for code-server in ide-server tests (#242). Listens on `--bind-addr`, answers HTTP
 * with 200, accepts WebSocket upgrades (echoing), and writes what it was given to
 * `<--user-data-dir>/fake.json`: its argv, its environment, and the Origin of each upgrade. It also
 * starts a long-lived child and records its pid, so tests can check the whole process group goes.
 * FAKE_CS_MODE=never-listen: never binds (startup timeout). FAKE_CS_MODE=die-after=<ms>: exits.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [host, portText] = (arg("--bind-addr") ?? "127.0.0.1:0").split(":");
const dataDir = arg("--user-data-dir") ?? "/tmp";
mkdirSync(dataDir, { recursive: true });
const record: { argv: string[]; env: Record<string, string | undefined>; origins: string[]; grandchild?: number } = {
  argv: args,
  env: { ...process.env },
  origins: [],
};
const save = () => writeFileSync(join(dataDir, "fake.json"), JSON.stringify(record));

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
record.grandchild = grandchild.pid;
save();

const mode = process.env.FAKE_CS_MODE ?? "";
if (mode.startsWith("die-after=")) setTimeout(() => process.exit(3), Number(mode.split("=")[1]));

if (mode !== "never-listen") {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("fake code-server"); });
  server.on("upgrade", (req, socket) => {
    record.origins.push(String(req.headers.origin ?? ""));
    save();
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", () => {}); // swallow client frames
  });
  server.listen(Number(portText), host);
} else {
  setInterval(() => {}, 1000);
}
