/**
 * The Local Host service units and files (#381, local-host.md §4.3-§4.5): the LaunchAgent and
 * systemd unit text, install/remove/status through an injected runner (launchctl and systemctl are
 * never run), the runtime choice, the stable launcher, and state.ts (lock, host id, log rotation and
 * redaction, the state file's mode). Everything lands in temporary directories.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHD_LABEL, SYSTEMD_UNIT, chooseRuntime, installService, launchdPlist, nodeQualifies, removeService, serviceStatus, stableLauncher, systemdUnit, unitPath,
  type Runner, type ServiceDeps,
} from "../.pi/extensions/kernal-local/service.ts";
import {
  acquireLock, fileLogger, hostIdFrom, hostNameOf, kernalHome, lockPath, logPath, machineId, readState, releaseLock, resolveHostId, statePath, writeState,
} from "../.pi/extensions/kernal-local/state.ts";

const tmp = (p = "kernal-local-") => mkdtempSync(join(tmpdir(), p));

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

const UNIT = { kernal: "/Users/a/.kernal/current/bin/kernal", homeDir: "/Users/a/.kernal", node: "/opt/homebrew/bin/node" };

describe("unit text (§4.5)", () => {
  test("the LaunchAgent", () => {
    const p = launchdPlist(UNIT);
    assert.match(p, /<key>Label<\/key><string>one\.kernal\.local-host<\/string>/);
    assert.match(p, /<array><string>\/bin\/bash<\/string><string>\/Users\/a\/\.kernal\/current\/bin\/kernal<\/string><string>local<\/string><string>run<\/string><\/array>/);
    assert.match(p, /<key>KERNAL_HOME_DIR<\/key><string>\/Users\/a\/\.kernal<\/string>/);
    assert.match(p, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
    assert.match(p, /<key>KERNAL_LOCAL_NODE<\/key><string>\/opt\/homebrew\/bin\/node<\/string>/);
    assert.doesNotMatch(p, /KERNAL_PROFILE/);
    for (const k of ["<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><true/>", "<key>ThrottleInterval</key><integer>30</integer>", "<key>ProcessType</key><string>Background</string>"]) assert.ok(p.includes(k), k);
    assert.match(p, /<key>StandardOutPath<\/key><string>\/Users\/a\/\.kernal\/logs\/local-host\.out\.log<\/string>/);
    assert.match(p, /<key>StandardErrorPath<\/key><string>\/Users\/a\/\.kernal\/logs\/local-host\.out\.log<\/string>/);
    assert.match(p, /^<\?xml/);
  });

  test("LaunchAgent: no node (a bundle), a profile, XML escaping", () => {
    const p = launchdPlist({ kernal: "/Users/a & b/kernal/bin/kernal", homeDir: "/Users/a/.kernal", profile: "work" });
    assert.doesNotMatch(p, /KERNAL_LOCAL_NODE/);
    assert.match(p, /<key>PATH<\/key><string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
    assert.match(p, /<key>KERNAL_PROFILE<\/key><string>work<\/string>/);
    assert.ok(p.includes("<string>/Users/a &amp; b/kernal/bin/kernal</string>"));
  });

  test("the systemd user unit", () => {
    const u = systemdUnit({ kernal: "/home/a/.kernal/current/bin/kernal", homeDir: "/home/a/.kernal", node: "/usr/bin/node" });
    assert.equal(u, [
      "[Unit]",
      "Description=Kernal Local Host (share this machine's local models)",
      "After=network-online.target",
      "",
      "[Service]",
      "ExecStart=/bin/bash /home/a/.kernal/current/bin/kernal local run",
      "Restart=always",
      "RestartSec=30",
      "Environment=KERNAL_HOME_DIR=/home/a/.kernal",
      "Environment=KERNAL_LOCAL_NODE=/usr/bin/node",
      "Environment=PATH=/usr/bin:/usr/local/bin:/usr/bin:/bin",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"));
  });

  test("systemd: values with spaces are quoted; a profile is passed", () => {
    const u = systemdUnit({ kernal: "/home/a b/kernal/bin/kernal", homeDir: "/home/a b/.kernal", profile: "work" });
    assert.match(u, /^ExecStart=\/bin\/bash "\/home\/a b\/kernal\/bin\/kernal" local run$/m);
    assert.match(u, /^Environment="KERNAL_HOME_DIR=\/home\/a b\/\.kernal"$/m);
    assert.match(u, /^Environment=KERNAL_PROFILE=work$/m);
    assert.doesNotMatch(u, /KERNAL_LOCAL_NODE/);
  });
});

describe("install, remove, status (§4.5)", () => {
  function deps(platform: NodeJS.Platform, r: ReturnType<typeof recorder>): ServiceDeps & { userHome: string } {
    return { platform, userHome: tmp("kernal-local-home-"), uid: 501, runner: r.runner };
  }

  test("macOS: write the plist, bootout (ignored), bootstrap; remove: bootout, delete", () => {
    const r = recorder({ "launchctl bootout": { status: 3, stderr: "No such process" } });
    const d = deps("darwin", r);
    const home = join(d.userHome, ".kernal");
    const res = installService({ ...UNIT, homeDir: home }, d);
    assert.deepEqual(res, { ok: true, unit: join(d.userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`) });
    assert.deepEqual(r.calls, [`launchctl bootout gui/501/${LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 ${res.ok && res.unit}`]);
    assert.match(readFileSync(res.ok ? res.unit : "", "utf8"), /one\.kernal\.local-host/);
    assert.ok(existsSync(join(home, "logs")), "the stdout log's directory exists before launchd opens it");
    r.calls.length = 0;
    assert.deepEqual(removeService(d), res);
    assert.deepEqual(r.calls, [`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    assert.equal(existsSync(res.ok ? res.unit : ""), false);
  });

  test("macOS: a failed bootstrap is an error with launchctl's words", () => {
    const r = recorder({ "launchctl bootstrap": { status: 5, stderr: "Bootstrap failed: 5: Input/output error" } });
    const d = deps("darwin", r);
    const res = installService({ ...UNIT, homeDir: join(d.userHome, ".kernal") }, d);
    assert.deepEqual(res, { ok: false, error: "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error" });
  });

  test("Linux: daemon-reload, enable --now; again: restart too; remove: disable --now, delete, daemon-reload", () => {
    const r = recorder();
    const d = deps("linux", r);
    const o = { ...UNIT, homeDir: join(d.userHome, ".kernal") };
    const res = installService(o, d);
    assert.ok(res.ok);
    assert.equal(res.ok && res.unit, join(d.userHome, ".config", "systemd", "user", SYSTEMD_UNIT));
    assert.deepEqual(r.calls, ["systemctl --user daemon-reload", `systemctl --user enable --now ${SYSTEMD_UNIT}`]);
    r.calls.length = 0;
    installService(o, d);
    assert.deepEqual(r.calls, ["systemctl --user daemon-reload", `systemctl --user enable --now ${SYSTEMD_UNIT}`, `systemctl --user restart ${SYSTEMD_UNIT}`]);
    r.calls.length = 0;
    removeService(d);
    assert.deepEqual(r.calls, [`systemctl --user disable --now ${SYSTEMD_UNIT}`, "systemctl --user daemon-reload"]);
    assert.equal(existsSync(res.ok ? res.unit : ""), false);
  });

  test("status from launchctl print and systemctl show", () => {
    const mac = deps("darwin", recorder({ "launchctl print": { status: 0, stdout: `gui/501/${LAUNCHD_LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n}` } }));
    assert.deepEqual(serviceStatus(mac), { installed: false, running: true, pid: 4242, unit: unitPath("darwin", mac.userHome) });
    const gone = deps("darwin", recorder({ "launchctl print": { status: 113, stderr: "Could not find service" } }));
    assert.deepEqual(serviceStatus(gone), { installed: false, running: false, pid: null, unit: unitPath("darwin", gone.userHome) });
    const lin = deps("linux", recorder({ "systemctl --user show": { status: 0, stdout: "ActiveState=active\nMainPID=777\n" } }));
    const unit = unitPath("linux", lin.userHome)!;
    mkdirSync(join(lin.userHome, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unit, "x");
    assert.deepEqual(serviceStatus(lin), { installed: true, running: true, pid: 777, unit });
  });

  test("another platform is refused", () => {
    const d = deps("win32", recorder());
    assert.equal(unitPath("win32", d.userHome), undefined);
    assert.deepEqual(installService(UNIT, d), { ok: false, error: "kernal local runs on macOS and Linux, not win32" });
  });
});

describe("runtime (§4.3) and launcher", () => {
  test("nodeQualifies: 22.18 and later", () => {
    assert.deepEqual(["v22.18.0", "22.19.1", "v23.0.0", "v24.1.0", "v22.17.9", "v20.11.0", "nonsense"].map(nodeQualifies), [true, true, true, true, false, false, false]);
  });

  test("KERNAL_LOCAL_NODE, else node on PATH, else the bundle's pi, else none", () => {
    const exists = (have: string[]) => (p: string) => have.includes(p);
    const runner = (versions: Record<string, string>, onPath = "") => ((cmd: string, args: string[]) => {
      if (cmd === "/bin/sh") return { status: onPath ? 0 : 1, stdout: onPath ? `${onPath}\n` : "", stderr: "" };
      return versions[cmd] ? { status: 0, stdout: `${versions[cmd]}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" };
    }) as Runner;
    assert.deepEqual(
      chooseRuntime({ env: { KERNAL_LOCAL_NODE: "/opt/node/bin/node" }, root: "/k", runner: runner({ "/opt/node/bin/node": "v22.19.0" }, "/usr/bin/node"), exists: exists(["/opt/node/bin/node", "/usr/bin/node"]) }),
      { kind: "node", path: "/opt/node/bin/node", version: "22.19.0" },
    );
    assert.deepEqual(
      chooseRuntime({ env: {}, root: "/k", runner: runner({ "/usr/bin/node": "v24.0.0" }, "/usr/bin/node"), exists: exists(["/usr/bin/node"]) }),
      { kind: "node", path: "/usr/bin/node", version: "24.0.0" },
    );
    assert.deepEqual(
      chooseRuntime({ env: {}, root: "/k", runner: runner({ "/usr/bin/node": "v20.0.0" }, "/usr/bin/node"), exists: exists(["/usr/bin/node", "/k/pi/pi"]) }),
      { kind: "bun", path: "/k/pi/pi" },
      "a Node too old for type stripping falls through to the bundle",
    );
    assert.equal(chooseRuntime({ env: {}, root: "/k", runner: runner({}), exists: exists([]) }), undefined);
  });

  test("stableLauncher: ~/.kernal/current in an install, the checkout's bin/kernal otherwise", () => {
    assert.equal(stableLauncher("/h/.kernal/kernal-0.4.1", "/h/.kernal", (p) => ["/h/.kernal/kernal-0.4.1/VERSION", "/h/.kernal/current/bin/kernal"].includes(p)), "/h/.kernal/current/bin/kernal");
    assert.equal(stableLauncher("/src/localllm/kernal", "/h/.kernal", () => false), "/src/localllm/kernal/bin/kernal");
  });
});

describe("state.ts (§4.4)", () => {
  test("kernalHome: KERNAL_HOME_DIR, MGM_HOME_DIR, ~/.kernal", () => {
    assert.equal(kernalHome({ KERNAL_HOME_DIR: "/x", MGM_HOME_DIR: "/y" }), "/x");
    assert.equal(kernalHome({ MGM_HOME_DIR: "/y" }), "/y");
    assert.equal(kernalHome({ HOME: "/home/a" }), "/home/a/.kernal");
  });

  test("run.lock: one holder; a dead holder's lock is taken over; release only by the holder", () => {
    const home = tmp();
    const a = acquireLock(home, 111, () => true);
    assert.equal(a.ok, true);
    assert.equal(readFileSync(lockPath(home), "utf8"), "111\n");
    assert.deepEqual(acquireLock(home, 222, (pid) => pid === 111), { ok: false, pid: 111 });
    const b = acquireLock(home, 222, () => false);
    assert.equal(b.ok, true, "111 is gone");
    releaseLock(home, 111);
    assert.equal(readFileSync(lockPath(home), "utf8"), "222\n", "not 111's any more");
    if (b.ok) b.release();
    assert.equal(existsSync(lockPath(home)), false);
    assert.equal(statSync(join(home, "local-host")).mode & 0o777, 0o700);
  });

  test("host id: from IOPlatformUUID, /etc/machine-id, else a kept random one", () => {
    const ioreg = `+-o J316sAP  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "1A2B3C4D-0000-1111-2222-333344445555"\n    }`;
    assert.equal(machineId({ platform: "darwin", run: () => ({ status: 0, stdout: ioreg }) }), "1A2B3C4D-0000-1111-2222-333344445555");
    assert.equal(machineId({ platform: "linux", readFile: (p) => { if (p === "/etc/machine-id") throw new Error("ENOENT"); return "abc123\n"; } }), "abc123");
    assert.equal(machineId({ platform: "win32" }), undefined);
    const id = hostIdFrom("1A2B3C4D-0000-1111-2222-333344445555");
    assert.match(id, /^h_[0-9a-f]{24}$/);
    assert.equal(id, hostIdFrom("1A2B3C4D-0000-1111-2222-333344445555"), "stable");
    const home = tmp();
    const none = { platform: "linux" as const, readFile: () => { throw new Error("ENOENT"); } };
    const r1 = resolveHostId(home, none);
    assert.match(r1, /^h_[0-9a-f]{24}$/);
    assert.equal(resolveHostId(home, none), r1, "kept in host-id");
    assert.equal(resolveHostId(home, { platform: "darwin", run: () => ({ status: 0, stdout: ioreg }) }), id, "a machine id wins");
  });

  test("hostNameOf: no .local, ≤ 64, printable", () => {
    assert.equal(hostNameOf("Matthews-MacBook-Pro.local"), "Matthews-MacBook-Pro");
    assert.equal(hostNameOf("x".repeat(80)).length, 64);
    assert.equal(hostNameOf("a\u0001b"), "ab");
    assert.equal(hostNameOf(" "), "host");
  });

  test("state.json: 0600, round-trips", () => {
    const home = tmp();
    const st = { version: 1, pid: 1, startedAt: "x", runtime: "node 24", hostId: "h_" + "0".repeat(24), signedIn: null, shareModels: { value: false, source: "default" }, server: null, discoveryKey: null, models: { total: 0, loaded: 0 }, tunnel: { provider: null, managed: false, state: "off", url: null, publicUrl: null, since: "x", reason: null }, heartbeat: { lastAt: null, ok: null, status: null, nextAt: null, routerModels: [], problems: [], error: null }, updatedAt: "x" } as const;
    writeState(home, st as any);
    assert.deepEqual(readState(home), st);
    assert.equal(statSync(statePath(home)).mode & 0o777, 0o600);
  });

  test("the log: one redacted line per event, rotated at the limit keeping 3", () => {
    const home = tmp();
    const file = logPath(home);
    const log = fileLogger(file, { maxBytes: 200, now: () => Date.parse("2026-10-05T12:00:00Z") });
    log("info", "authtoken=2abcdefghijklmnopqrstuvwxyz0123 and Bearer lhb_secretsecretsecret");
    const first = readFileSync(file, "utf8");
    assert.match(first, /^2026-10-05T12:00:00\.000Z info /);
    assert.ok(!first.includes("2abcdefghijklmnopqrstuvwxyz0123") && !first.includes("lhb_secretsecretsecret"), first);
    for (let i = 0; i < 20; i++) log("warn", `line ${i} ${"x".repeat(60)}`);
    assert.ok(existsSync(`${file}.1`) && existsSync(`${file}.2`) && existsSync(`${file}.3`));
    assert.equal(existsSync(`${file}.4`), false);
    assert.ok(statSync(file).size <= 200);
    log("info", "two\nlines");
    assert.match(readFileSync(file, "utf8"), /two lines\n$/);
  });
});
