/**
 * `kernal local enable | disable | status | run` (#381, local-host.md §4.2, §4.3, §4.7): commands.ts
 * driven with a fake runner (launchctl and systemctl are never run), a temporary home and user home,
 * fake ngrok status and fake loop dependencies; cli.ts run with node for the usage exit code; and
 * the import-graph rule that lets the loop run under Node or the bundle's pi as Bun.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, statusLines, discoveryEnv, type LocalIo } from "../.pi/extensions/kernal-local/commands.ts";
import type { Runner } from "../.pi/extensions/kernal-local/service.ts";
import { lockPath, writeState, type ServiceState } from "../.pi/extensions/kernal-local/state.ts";
import type { SignalName } from "../.pi/extensions/kernal-local/loop.ts";

const KERNAL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(KERNAL, ".pi", "extensions");
const tmp = (p = "kernal-local-cli-") => mkdtempSync(join(tmpdir(), p));

function recorder(answers: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[] = [];
  const runner: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const hit = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1];
    return { status: hit?.status ?? 0, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
  };
  return { calls, runner };
}

/** An io whose node on PATH is a fake 22.19 at an existing path, in a temporary home. */
function io(opts: { platform?: NodeJS.Platform; answers?: Record<string, { status: number; stdout?: string; stderr?: string }>; root?: string } = {}) {
  const userHome = tmp("kernal-local-user-");
  const home = join(userHome, ".kernal");
  const node = join(userHome, "bin", "node");
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, "");
  const rec = recorder({ "/bin/sh -c command -v node": { status: 0, stdout: `${node}\n` }, [`${node} --version`]: { status: 0, stdout: "v22.19.0\n" }, ...opts.answers });
  const out: string[] = [];
  const err: string[] = [];
  const kills: Array<[number, string]> = [];
  const value: LocalIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { HOME: userHome, KERNAL_HOME_DIR: home },
    root: opts.root ?? tmp("kernal-local-root-"),
    platform: opts.platform ?? "darwin",
    userHome,
    uid: 501,
    runner: rec.runner,
    shareModels: () => ({ value: false, source: "default" }),
    ngrokStatus: async () => ({ provider: "ngrok", available: true, runtime: "ngrok 3.39.11 (/x/ngrok)" }),
    installNgrok: async () => ({ ok: false, detail: "not in tests" }),
    kill: (pid, sig) => { kills.push([pid, sig]); },
    alive: () => false,
    sleep: async () => {},
  };
  return { io: value, out, err, calls: rec.calls, home, userHome, node, kills };
}

function sampleState(over: Partial<ServiceState> = {}): ServiceState {
  return {
    version: 1,
    pid: 4242,
    startedAt: "2026-10-05T12:00:00.000Z",
    runtime: "node 22.19.0",
    hostId: "h_3f9c0a1b2c3d4e5f60718293",
    signedIn: { email: "a@example.com" },
    shareModels: { value: true, source: "device" },
    server: "http://localhost:1234",
    discoveryKey: "k1",
    models: { total: 3, loaded: 1 },
    tunnel: { provider: "ngrok", managed: true, state: "up", url: "https://lhabc.internal", publicUrl: "https://lh-x.kernal.run", since: "2026-10-05T12:00:05.000Z", reason: null },
    heartbeat: { lastAt: "2026-10-05T12:00:05.000Z", ok: true, status: "online", nextAt: "2026-10-05T12:05:05.000Z", routerModels: ["local/a-box/qwen"], problems: ["model id not routable: x"], error: null },
    updatedAt: "2026-10-05T12:00:05.000Z",
    ...over,
  };
}

describe("arguments (§4.2)", () => {
  test("parseArgs: commands and their options", () => {
    assert.deepEqual(parseArgs(["status", "--json"]), { command: "status", json: true });
    assert.equal(parseArgs(["enable", "--profile", "work"]).profile, "work");
    assert.equal(parseArgs(["enable", "--profile=work"]).profile, "work");
    assert.match(parseArgs([]).bad ?? "", /missing command/);
    assert.match(parseArgs(["start"]).bad ?? "", /unknown command start/);
    assert.match(parseArgs(["enable", "--profile"]).bad ?? "", /needs a profile name/);
    assert.match(parseArgs(["status", "--profile", "x"]).bad ?? "", /unknown option --profile/);
    assert.match(parseArgs(["run", "--json"]).bad ?? "", /unknown option --json/);
  });

  test("usage errors exit 2 with the usage line", async () => {
    const t = io();
    assert.equal(await main(["bogus"], t.io), 2);
    assert.match(t.err.join("\n"), /unknown command bogus/);
    assert.match(t.err.join("\n"), /Usage: kernal local enable/);
    assert.equal(t.calls.length, 0, "nothing ran");
  });

  test("cli.ts with node: a usage error exits 2", () => {
    const home = tmp();
    const env = { ...process.env, HOME: home, KERNAL_HOME_DIR: join(home, ".kernal") };
    const cli = join(EXT, "kernal-local", "cli.ts");
    const bad = spawnSync(process.execPath, [cli, "nope"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /Usage:/);
  });
});

describe("status (§4.7)", () => {
  test("not installed, never run", async () => {
    const t = io({ answers: { "launchctl print": { status: 113, stderr: "Could not find service" } } });
    assert.equal(await main(["status"], t.io), 0);
    assert.match(t.out[0], /^Service: +not installed, not running/);
    assert.match(t.out.join("\n"), /none yet/);
    assert.deepEqual(t.calls, ["launchctl print gui/501/one.kernal.local-host"]);
  });

  test("a running service: account, sharing, tunnel, server, heartbeat, router models", async () => {
    const t = io({ answers: { "launchctl print": { status: 0, stdout: "\tstate = running\n\tpid = 4242\n" } } });
    mkdirSync(join(t.userHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(t.userHome, "Library", "LaunchAgents", "one.kernal.local-host.plist"), "x");
    writeState(t.home, sampleState());
    assert.equal(await main(["status"], t.io), 0);
    const text = t.out.join("\n");
    assert.match(text, /Service: +installed, running \(pid 4242, node 22\.19\.0\)/);
    assert.match(text, /Account: +a@example\.com/);
    assert.match(text, /Sharing: +on \(device\)/);
    assert.match(text, /Tunnel: +up since 2026-10-05T12:00:05\.000Z \(ngrok, managed\), https:\/\/lh-x\.kernal\.run/);
    assert.match(text, /Server: +http:\/\/localhost:1234; models 3, loaded 1/);
    assert.match(text, /Heartbeat: +2026-10-05T12:00:05\.000Z, online, next 2026-10-05T12:05:05\.000Z/);
    assert.match(text, /Problems: +model id not routable: x/);
    assert.match(text, /Router: +local\/a-box\/qwen/);
    assert.doesNotMatch(text, /lhabc\.internal/, "the internal URL is not shown");
  });

  test("statusLines: signed out, interim tunnel, stopped service", () => {
    const st = sampleState({ signedIn: null, tunnel: { provider: "ngrok", managed: false, state: "off", url: null, publicUrl: null, since: "2026-10-05T12:00:00.000Z", reason: "sharing is off" }, heartbeat: { lastAt: null, ok: null, status: null, nextAt: null, routerModels: [], problems: [], error: null } });
    const text = statusLines(st, { installed: true, running: false, pid: null, unit: "/u" }, "/h", false).join("\n");
    assert.match(text, /installed, not running/);
    assert.match(text, /Last run:/);
    assert.match(text, /Account: +signed out/);
    assert.match(text, /Tunnel: +off since .*interim credentials.*: sharing is off/);
    assert.doesNotMatch(text, /Heartbeat:/);
    assert.match(text, /no models registered/);
  });

  test("--json: state.json merged with the service", async () => {
    const t = io({ platform: "linux", answers: { "systemctl --user show": { status: 0, stdout: "ActiveState=active\nMainPID=99\n" } } });
    writeState(t.home, sampleState());
    assert.equal(await main(["status", "--json"], t.io), 0);
    const j = JSON.parse(t.out.join("\n"));
    assert.equal(j.hostId, "h_3f9c0a1b2c3d4e5f60718293");
    assert.deepEqual(j.service, { installed: false, running: true, pid: 99, unit: join(t.userHome, ".config", "systemd", "user", "kernal-local-host.service") });
  });
});

describe("enable and disable (§4.2, §4.5)", () => {
  test("macOS enable: writes the plist with the node it found, bootstraps, prints sharing help", async () => {
    const t = io();
    assert.equal(await main(["enable", "--profile", "work"], t.io), 0, t.err.join("\n"));
    const plist = join(t.userHome, "Library", "LaunchAgents", "one.kernal.local-host.plist");
    const text = readFileSync(plist, "utf8");
    assert.match(text, new RegExp(`<key>KERNAL_LOCAL_NODE</key><string>${t.node}</string>`));
    assert.match(text, /<key>KERNAL_PROFILE<\/key><string>work<\/string>/);
    assert.match(text, new RegExp(`<key>KERNAL_HOME_DIR</key><string>${t.home}</string>`));
    assert.ok(t.calls.includes("launchctl bootout gui/501/one.kernal.local-host"));
    assert.ok(t.calls.includes(`launchctl bootstrap gui/501 ${plist}`));
    const out = t.out.join("\n");
    assert.match(out, /Installed and started/);
    assert.match(out, /Sharing \(localHost\.shareModels\): off, from the default/);
    assert.match(out, /config\.local\.json/);
    assert.match(out, /kernal login/, "signed out: says how to sign in");
    assert.ok(existsSync(join(t.home, "logs")), "the out-log directory exists before launchd writes it");
  });

  test("enable refuses without a runtime (no node, no bundle pi)", async () => {
    const t = io({ answers: { "/bin/sh -c command -v node": { status: 1 } } });
    assert.equal(await main(["enable"], t.io), 1);
    assert.match(t.err.join("\n"), /needs Node 22\.18\+ or a release bundle/);
    assert.ok(!t.calls.some((c) => c.startsWith("launchctl")));
  });

  test("enable with only the bundle's pi: no KERNAL_LOCAL_NODE in the unit", async () => {
    const root = tmp("kernal-local-bundle-");
    mkdirSync(join(root, "pi"), { recursive: true });
    writeFileSync(join(root, "pi", "pi"), "");
    const t = io({ platform: "linux", root, answers: { "/bin/sh -c command -v node": { status: 1 } } });
    assert.equal(await main(["enable"], t.io), 0, t.err.join("\n"));
    const unit = readFileSync(join(t.userHome, ".config", "systemd", "user", "kernal-local-host.service"), "utf8");
    assert.doesNotMatch(unit, /KERNAL_LOCAL_NODE/);
    assert.match(unit, /ExecStart=\/bin\/bash .*bin\/kernal local run/);
    assert.deepEqual(t.calls.filter((c) => c.startsWith("systemctl")), ["systemctl --user daemon-reload", "systemctl --user enable --now kernal-local-host.service"]);
    assert.match(t.out.join("\n"), /the bundle's pi as Bun/);
  });

  test("enable: ngrok missing is installed; a failed install still installs the service", async () => {
    const t = io();
    t.io.ngrokStatus = async () => ({ provider: "ngrok", available: false, installable: true, reason: "not installed" });
    assert.equal(await main(["enable"], t.io), 0);
    assert.match(t.out.join("\n"), /installing the ngrok agent/);
    assert.match(t.err.join("\n"), /could not install ngrok \(not in tests\)/);
  });

  test("enable: a PATH ngrok is not enough; Kernal's own copy is installed for the service", async () => {
    const t = io();
    t.io.ngrokStatus = async () => ({ provider: "ngrok", available: true, source: "path", runtime: "ngrok 3.39.11 (/opt/homebrew/bin/ngrok)" });
    t.io.installNgrok = async () => ({ ok: true, path: "/Users/a/.kernal/bin/ngrok", version: "3.39.11" });
    assert.equal(await main(["enable"], t.io), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.match(out, /not on the service's PATH/);
    assert.match(out, /Tunnel: ngrok 3\.39\.11 \(\/Users\/a\/\.kernal\/bin\/ngrok\)/);
    assert.equal(t.err.join("\n"), "");
  });

  test("enable: KERNAL_NGROK_BIN is left as the only candidate", async () => {
    const t = io();
    let installed = false;
    t.io.ngrokStatus = async () => ({ provider: "ngrok", available: true, source: "env", runtime: "ngrok 3.39.11 (/opt/ngrok)" });
    t.io.installNgrok = async () => { installed = true; return { ok: true, path: "/opt/ngrok", version: "3.39.11" }; };
    assert.equal(await main(["enable"], t.io), 0, t.err.join("\n"));
    assert.equal(installed, false);
    assert.match(t.out.join("\n"), /Tunnel: ngrok 3\.39\.11 \(\/opt\/ngrok\)/);
  });

  test("enable: a failed bootstrap exits 1", async () => {
    const t = io({ answers: { "launchctl bootstrap": { status: 5, stderr: "Bootstrap failed: 5: Input/output error" } } });
    assert.equal(await main(["enable"], t.io), 1);
    assert.match(t.err.join("\n"), /Bootstrap failed/);
  });

  test("enable on another platform exits 1", async () => {
    const t = io({ platform: "win32" });
    assert.equal(await main(["enable"], t.io), 1);
    assert.match(t.err.join("\n"), /macOS and Linux/);
  });

  test("disable: bootout and delete first (no KeepAlive restart), then SIGTERM to a loop still running", async () => {
    const t = io();
    const order: string[] = [];
    const runner = t.io.runner!;
    t.io.runner = (cmd, args) => { order.push(cmd); return runner(cmd, args); };
    const kill = t.io.kill!;
    t.io.kill = (pid, sig) => { order.push("kill"); kill(pid, sig); };
    mkdirSync(join(t.home, "local-host"), { recursive: true });
    writeFileSync(lockPath(t.home), "777\n");
    let alive = 3;
    t.io.alive = (pid) => pid === 777 && alive-- > 0;
    const plist = join(t.userHome, "Library", "LaunchAgents", "one.kernal.local-host.plist");
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "x");
    assert.equal(await main(["disable"], t.io), 0);
    assert.deepEqual(t.kills, [[777, "SIGTERM"]]);
    assert.deepEqual(order, ["launchctl", "launchctl", "kill"], "print, bootout, then the signal");
    assert.ok(t.calls.includes("launchctl bootout gui/501/one.kernal.local-host"));
    assert.ok(!existsSync(plist));
    assert.match(t.out.join("\n"), /Stopped and removed/);
  });

  test("disable with nothing installed is fine", async () => {
    const t = io({ platform: "linux" });
    assert.equal(await main(["disable"], t.io), 0);
    assert.deepEqual(t.kills, []);
    assert.match(t.out.join("\n"), /was not installed/);
  });
});

describe("run (§4.4, §4.6)", () => {
  test("a second run exits 0 with already running while the lock's pid is alive", async () => {
    const t = io();
    mkdirSync(join(t.home, "local-host"), { recursive: true });
    writeFileSync(lockPath(t.home), `${process.ppid}\n`);
    assert.equal(await main(["run"], t.io), 0);
    assert.match(t.out.join("\n"), /already running \(pid \d+\)/);
  });

  test("runs the loop with injected dependencies until SIGTERM, writes state, releases the lock", async () => {
    const t = io();
    const handlers = new Map<SignalName, () => void>();
    const logs: string[] = [];
    let ticks = 0;
    t.io.log = (level, m) => logs.push(`${level} ${m}`);
    t.io.onSignal = (sig, h) => { handlers.set(sig, h); };
    t.io.loopDeps = {
      env: {},
      now: Date.now,
      pollMs: 5,
      fetch: (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch,
      discover: async () => {
        if (++ticks === 2) handlers.get("SIGTERM")!();
        return { servers: [], models: [], key: "k0" };
      },
      openTunnel: async () => { throw new Error("no tunnel in tests"); },
      session: { account: () => undefined, token: async () => undefined },
      config: { refresh: async () => {}, shareModels: () => ({ value: false, source: "default" }) },
      host: { hostId: "h_000000000000000000000000", hostName: "box", kernalVersion: "source", platform: "darwin-arm64", runtime: "node 22.19.0", pid: process.pid },
    };
    assert.equal(await main(["run"], t.io), 0, t.err.join("\n"));
    assert.ok(ticks >= 2);
    assert.ok(handlers.has("SIGINT") && handlers.has("SIGHUP"));
    assert.ok(!existsSync(lockPath(t.home)), "the lock is released");
    const st = JSON.parse(readFileSync(join(t.home, "local-host", "state.json"), "utf8"));
    assert.equal(st.tunnel.state, "stopped");
    assert.equal(st.signedIn, null);
    assert.ok(logs.some((l) => /started \(pid/.test(l)) && logs.some((l) => /stopped/.test(l)));
  });

  test("discoveryEnv probes KERNAL_LOCAL_HOST_SERVER when it isn't a default target", () => {
    assert.equal(discoveryEnv({ KERNAL_LOCAL_HOST_SERVER: "http://localhost:1234" }).KERNAL_LOCAL_SERVERS, undefined);
    assert.equal(discoveryEnv({ KERNAL_LOCAL_HOST_SERVER: "http://10.0.0.5:9000" }).KERNAL_LOCAL_SERVERS, "http://10.0.0.5:9000");
  });
});

describe("runtime rule (§4.3)", () => {
  test("cli.ts imports only node: built-ins and relative .ts files, all the way down", () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const spec = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(spec)) {
        const s = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (s.startsWith("node:")) continue;
        if (s.startsWith(".") && s.endsWith(".ts")) walk(resolve(dirname(file), s));
        else bad.push(`${relative(KERNAL, file)} -> ${s}`);
      }
    };
    walk(join(EXT, "kernal-local", "cli.ts"));
    assert.deepEqual(bad, []);
    assert.ok(seen.size > 5, "the walk followed the imports");
    assert.ok(!existsSync(join(EXT, "kernal-local", "index.ts")), "no index.ts: pi never loads it as an extension");
  });
});
