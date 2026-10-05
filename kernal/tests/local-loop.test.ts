/**
 * The Local Host loop (#381, local-host.md §1.4, §4.6, §4.8): tick() driven with a fake clock, fake
 * discovery, a fake tunnel provider and a fake Outfitter, so nothing real is contacted. Cadence
 * (start, change, folding, interval, sharing off), credentials hints, signed out with interim
 * credentials, wake, backoff, 401/403 handling, the stop heartbeat, and the state file's contents.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DiscoverySnapshot, LocalModel, ServerSnapshot } from "../.pi/extensions/_shared/local-discovery.ts";
import { TunnelError, type LocalHostTunnel, type OpenTunnelOptions, type TunnelHealth } from "../.pi/extensions/_shared/tunnel/tunnel.ts";
import {
  BLOCKED_RETRY_MS, LocalHostLoop, backoffMs, pickServer, serve,
  type Account, type LoopDeps, type SignalName,
} from "../.pi/extensions/kernal-local/loop.ts";
import type { HeartbeatRequest } from "../.pi/extensions/kernal-local/protocol.ts";
import type { ServiceState } from "../.pi/extensions/kernal-local/state.ts";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const API = "https://link.outfitter.test";
const ACCOUNT: Account = { api: API, email: "a@example.com", deviceId: "dev_1" };
const AUTHTOKEN = "2managedAuthtoken_abcdefghijklmnop";
const BEARER = "lhb_" + "b".repeat(43);

const LMS: ServerSnapshot = { id: "http://localhost:1234", kind: "lmstudio", baseUrl: "http://localhost:1234/v1", ok: true, endpoints: ["/api/v0/models", "/v1/models"], models: 1 };
const OLLAMA: ServerSnapshot = { id: "http://localhost:11434", kind: "ollama", baseUrl: "http://localhost:11434/v1", ok: true, endpoints: ["/api/tags"], models: 1 };
const QWEN: LocalModel = { id: "qwen/qwen3-coder-30b", server: LMS.id, kind: "lmstudio", loaded: true, contextLength: 32768 };

function snapshot(servers: ServerSnapshot[], models: LocalModel[], key = "k1"): DiscoverySnapshot {
  return { servers, models, key };
}

function credsAnswer(n = 1, issuedAt = T0) {
  return {
    provider: "ngrok",
    authtoken: `${AUTHTOKEN}${n}`,
    credentialId: `cr_${n}`,
    url: "https://lh8d0b7c6a5e4f3a2b1c0d9e8f.internal",
    publicUrl: "https://lh-abcdefghijklmnopqrstuvwxyz.kernal.run",
    trafficPolicy: '{"on_http_request":[]}',
    bearer: BEARER,
    allowPaths: ["/v1/chat/completions", "/v1/models"],
    rateLimit: { requests: 100, windowSeconds: 60 },
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 7 * 86400_000).toISOString(),
  };
}

function hbAnswer(credentials: string, extra: Record<string, unknown> = {}) {
  return { accepted: true, id: "lh_8d0b7c6a5e4f3a2b1c0d9e8f", status: "online", nextHeartbeatSeconds: 300, credentials, routerPrefix: "a-box", routerModels: ["local/a-box/qwen/qwen3-coder-30b"], problems: [], ...extra };
}

type Reply = { status: number; body: unknown } | Error;

/** A world the loop lives in: every outside call is recorded and answered from these fields. */
function world(opts: { signedIn?: boolean; share?: boolean; env?: Record<string, string>; snap?: DiscoverySnapshot } = {}) {
  const w = {
    t: T0,
    account: (opts.signedIn ?? true) ? ACCOUNT : undefined as Account | undefined,
    share: opts.share ?? true,
    snap: opts.snap ?? snapshot([LMS], [QWEN]),
    heartbeats: [] as HeartbeatRequest[],
    credentialCalls: 0,
    tokens: [] as Array<string | undefined>,
    tokenValue: "kda_1",
    /** Next answers, by path; the last one repeats. */
    replies: { heartbeat: [] as Reply[], credentials: [] as Reply[] },
    opened: [] as OpenTunnelOptions[],
    stopped: 0,
    openError: undefined as Error | undefined,
    health: { state: "up", since: new Date(T0).toISOString() } as TunnelHealth,
    configRefreshes: 0,
    saved: [] as ServiceState[],
    logs: [] as string[],
    kicks: 0,
    auths: [] as string[],
  };
  const take = (list: Reply[], fallback: Reply): Reply => (list.length > 1 ? list.shift()! : list[0] ?? fallback);
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    w.auths.push(String((init.headers as Record<string, string>).authorization));
    let r: Reply;
    if (path === "/api/local-hosts/heartbeat") {
      w.heartbeats.push(JSON.parse(String(init.body)));
      r = take(w.replies.heartbeat, { status: 200, body: hbAnswer("current") });
    } else if (path === "/api/local-hosts/tunnel-credentials") {
      w.credentialCalls++;
      r = take(w.replies.credentials, { status: 200, body: credsAnswer() });
    } else r = { status: 404, body: { error: "not found" } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const deps: LoopDeps = {
    env: opts.env ?? {},
    now: () => w.t,
    fetch: fetchFn,
    discover: async () => w.snap,
    openTunnel: async (o) => {
      w.opened.push(o);
      if (w.openError) throw w.openError;
      w.health = { state: "up", since: new Date(w.t).toISOString() };
      const handle: LocalHostTunnel = {
        provider: "ngrok",
        publicUrl: (o.credentials[0] as any).url ?? "https://random.ngrok.app",
        health: () => w.health,
        stop: async () => { w.stopped++; },
        guard: () => ({ forwarded: 0, refused: 0, keepAlives: 0 }) as any,
      };
      return handle;
    },
    session: {
      account: () => w.account,
      token: async (_a, rejected) => {
        w.tokens.push(rejected);
        if (rejected) return rejected === w.tokenValue ? undefined : w.tokenValue;
        return w.tokenValue;
      },
    },
    config: {
      refresh: async () => { w.configRefreshes++; },
      shareModels: () => ({ value: w.share, source: "device" }),
    },
    host: { hostId: "h_3f9c0a1b2c3d4e5f60718293", hostName: "box", kernalVersion: "0.4.1", platform: "darwin-arm64", runtime: "node 24.0.0", pid: 4242 },
    log: (level, m) => { w.logs.push(`${level} ${m}`); },
    saveState: (s) => { w.saved.push(s); },
  };
  const loop = new LocalHostLoop(deps);
  loop.setKick(() => { w.kicks++; });
  const at = async (seconds: number) => { w.t = T0 + seconds * 1000; await loop.tick(); };
  const last = () => w.saved[w.saved.length - 1];
  return { w, deps, loop, at, last };
}

describe("pickServer and backoff", () => {
  test("KERNAL_LOCAL_HOST_SERVER when it answers, else the kind order", () => {
    const snap = snapshot([OLLAMA, LMS], []);
    assert.equal(pickServer(snap)?.id, LMS.id);
    assert.equal(pickServer(snap, "localhost:11434")?.id, OLLAMA.id);
    assert.equal(pickServer(snap, "http://localhost:8080")?.id, LMS.id, "a preferred server that doesn't answer falls back");
    assert.equal(pickServer(snapshot([{ ...LMS, ok: false }, OLLAMA], []))?.id, OLLAMA.id);
    assert.equal(pickServer(snapshot([{ ...LMS, ok: false }], [])), undefined);
  });
  test("5 s, 10 s, 20 s ... capped at 5 min", () => {
    assert.deepEqual([0, 1, 2, 3, 6, 7, 20].map(backoffMs), [5000, 10000, 20000, 40000, 300000, 300000, 300000]);
  });
});

describe("signed out (§4.8)", () => {
  test("interim .env credentials run a tunnel; nothing goes to Outfitter", async () => {
    const { w, at, last } = world({ signedIn: false, env: { NGROK_AUTHTOKEN: "2interimToken_0123456789", TUNNEL_DOMAIN_LMSTUDIO: "kernal-test.ngrok.app", LOCAL_TUNNEL_TOKEN: "interim-bearer-123", KERNAL_LOCAL_TUNNEL: "ngrok" } });
    await at(0);
    assert.equal(w.opened.length, 1);
    const o = w.opened[0];
    assert.equal(o.choice, "ngrok");
    assert.equal(o.localUrl, LMS.id);
    assert.deepEqual(o.credentials, [{ provider: "ngrok", authtoken: "2interimToken_0123456789", url: "https://kernal-test.ngrok.app", bearerToken: "interim-bearer-123" }]);
    assert.equal(w.heartbeats.length + w.credentialCalls, 0);
    assert.equal(w.configRefreshes, 0, "signed out: no settings fetch");
    assert.equal(last().tunnel.state, "up");
    assert.equal(last().tunnel.managed, false);
    assert.equal(last().tunnel.publicUrl, "https://kernal-test.ngrok.app");
    assert.equal(last().signedIn, null);
    assert.equal(last().heartbeat.nextAt, null);
    await at(15);
    assert.equal(w.opened.length, 1, "a healthy tunnel is left alone");
  });

  test("no interim credentials: tunnel off with the reason", async () => {
    const { w, at, last } = world({ signedIn: false });
    await at(0);
    assert.equal(w.opened.length, 0);
    assert.deepEqual([last().tunnel.state, last().tunnel.reason], ["off", "no tunnel credentials"]);
  });

  test("a sign-out stops the managed tunnel (its credential is the old account's)", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    assert.equal(w.opened.length, 1);
    w.account = undefined;
    await at(15);
    assert.equal(w.stopped, 1);
    assert.equal(last().tunnel.state, "off");
    assert.equal(last().signedIn, null);
  });
});

describe("managed credentials and the heartbeat cadence (§1.4)", () => {
  test("after a restart the api answers current, but nothing is cached: credentials are fetched anyway", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("current") }];
    await at(0);
    assert.equal(w.credentialCalls, 1, "fetched although the hint was current");
    assert.equal(w.opened.length, 1);
    assert.equal((w.opened[0].credentials[0] as any).authtoken, `${AUTHTOKEN}1`);
    assert.equal(last().tunnel.state, "up");
    assert.equal(last().tunnel.managed, true);
    await at(15);
    assert.equal(w.credentialCalls, 1, "cached from then on");
  });

  test("start → fetch → tunnel on Outfitter's credentials → change → interval", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch", { status: "offline", routerModels: [] }) }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    assert.equal(w.configRefreshes, 1, "settings fetched at start");
    assert.equal(w.heartbeats.length, 1);
    const start = w.heartbeats[0];
    assert.equal(start.reason, "start");
    assert.equal(start.hostId, "h_3f9c0a1b2c3d4e5f60718293");
    assert.equal(start.shareModels, true);
    assert.equal(start.discoveryKey, "k1");
    assert.deepEqual(start.servers, [LMS]);
    assert.deepEqual(start.models, [QWEN]);
    assert.equal(start.tunnel.state, "off");
    assert.equal(start.tunnel.managed, true);
    assert.equal(w.auths[0], "Bearer kda_1");

    // The "fetch" hint is acted on in the same tick.
    assert.equal(w.credentialCalls, 1);
    assert.equal(w.opened.length, 1);
    const o = w.opened[0];
    assert.deepEqual(o.credentials, [{ provider: "ngrok", authtoken: `${AUTHTOKEN}1`, url: "https://lh8d0b7c6a5e4f3a2b1c0d9e8f.internal", trafficPolicy: '{"on_http_request":[]}', bearerToken: BEARER }]);
    assert.deepEqual(o.allowPaths, ["/v1/chat/completions", "/v1/models"]);
    assert.deepEqual(o.rateLimit, { requests: 100, windowSeconds: 60 });
    assert.equal(o.choice, "auto");

    // The state change goes out on the next poll (the 10 s window).
    await at(15);
    assert.equal(w.heartbeats.length, 2);
    const change = w.heartbeats[1];
    assert.equal(change.reason, "change");
    assert.deepEqual(change.tunnel, { provider: "ngrok", managed: true, state: "up", url: "https://lh8d0b7c6a5e4f3a2b1c0d9e8f.internal", server: LMS.id, credentialId: "cr_1" });
    assert.equal(last().heartbeat.status, "online");
    assert.deepEqual(last().heartbeat.routerModels, ["local/a-box/qwen/qwen3-coder-30b"]);
    assert.equal(last().tunnel.publicUrl, "https://lh-abcdefghijklmnopqrstuvwxyz.kernal.run");

    // Nothing changed: nothing until nextHeartbeatSeconds.
    for (let s = 30; s < 315; s += 15) await at(s);
    assert.equal(w.heartbeats.length, 2);
    await at(315);
    assert.equal(w.heartbeats.length, 3);
    assert.equal(w.heartbeats[2].reason, "interval");
    assert.equal(w.credentialCalls, 1, "current credentials are kept");
    assert.equal(w.opened.length, 1);

    // Secrets never reach the state file.
    const text = JSON.stringify(w.saved);
    assert.ok(!text.includes(AUTHTOKEN) && !text.includes(BEARER) && !text.includes("kda_1"));
  });

  test("changes inside 10 s are folded into one heartbeat", async () => {
    const { w, at } = world();
    await at(0);
    assert.equal(w.heartbeats.length, 1);
    w.snap = snapshot([LMS], [{ ...QWEN, loaded: false }], "k2");
    await at(4);
    w.snap = snapshot([LMS], [QWEN], "k3");
    await at(8);
    assert.equal(w.heartbeats.length, 1);
    await at(11);
    assert.equal(w.heartbeats.length, 2);
    assert.equal(w.heartbeats[1].discoveryKey, "k3");
    assert.equal(w.heartbeats[1].reason, "change");
  });

  test("sharing off: one heartbeat reporting it, none periodic, no tunnel", async () => {
    const { w, at, last } = world({ share: false });
    await at(0);
    assert.equal(w.heartbeats.length, 1);
    assert.equal(w.heartbeats[0].shareModels, false);
    assert.equal(w.opened.length, 0);
    assert.equal(last().tunnel.reason, "sharing is off");
    for (let s = 15; s <= 1200; s += 15) await at(s);
    assert.equal(w.heartbeats.length, 1);
    w.share = true;
    await at(1215);
    assert.equal(w.heartbeats.length, 2);
    assert.equal(w.heartbeats[1].shareModels, true);
  });

  test("turning sharing off stops the tunnel and says so once", async () => {
    const { w, at } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    await at(15);
    w.share = false;
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("none", { status: "not-sharing", routerModels: [] }) }];
    await at(30);
    assert.equal(w.stopped, 1);
    const hb = w.heartbeats[w.heartbeats.length - 1];
    assert.equal(hb.shareModels, false);
    assert.equal(hb.tunnel.state, "off");
    const n = w.heartbeats.length;
    for (let s = 45; s <= 1000; s += 15) await at(s);
    assert.equal(w.heartbeats.length, n);
  });

  test("hint none stops the tunnel even while sharing is on locally", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("none") }];
    await at(0);
    assert.equal(w.opened.length, 1);
    await at(15);
    assert.equal(w.stopped, 1);
    assert.equal(last().tunnel.reason, "Outfitter says this host is not sharing");
  });

  test("hint unavailable: interim credentials, managed false", async () => {
    const { w, at } = world({ env: { NGROK_AUTHTOKEN: "2interimToken_0123456789" } });
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("unavailable", { routerModels: [] }) }];
    await at(0);
    assert.equal(w.credentialCalls, 0);
    assert.equal(w.opened.length, 1);
    assert.equal((w.opened[0].credentials[0] as any).authtoken, "2interimToken_0123456789");
    await at(15);
    assert.equal(w.heartbeats[1].tunnel.managed, false);
    assert.equal(w.heartbeats[1].tunnel.state, "up");
    assert.equal(w.heartbeats[1].tunnel.credentialId, undefined);
  });

  test("credentials are refetched when they expire within a day, and the tunnel restarts on the new ones", async () => {
    const { w, at } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    w.replies.credentials = [{ status: 200, body: credsAnswer(1, T0) }, { status: 200, body: credsAnswer(2, T0 + 6 * 86400_000) }];
    await at(0);
    assert.equal(w.credentialCalls, 1);
    await at(6 * 86400 + 15);   // under a day left
    assert.equal(w.credentialCalls, 2);
    assert.equal(w.opened.length, 2);
    assert.equal((w.opened[1].credentials[0] as any).authtoken, `${AUTHTOKEN}2`);
    assert.equal(w.stopped, 1);
  });

  test("a 'fetch' hint later refetches; 503 from the credentials route falls back to interim", async () => {
    const { w, at } = world({ env: { NGROK_AUTHTOKEN: "2interimToken_0123456789" } });
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }];
    w.replies.credentials = [{ status: 503, body: { error: "local_host_tunnels_off" } }];
    await at(0);
    assert.equal(w.credentialCalls, 1);
    assert.equal(w.opened.length, 1);
    assert.equal((w.opened[0].credentials[0] as any).authtoken, "2interimToken_0123456789");
  });
});

describe("failures", () => {
  test("heartbeat 5xx: backoff 5 s, 10 s, 20 s; the tunnel keeps running", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 503, body: {} }];
    await at(0);
    await at(15);
    assert.equal(w.heartbeats.length, 2);
    assert.equal(last().heartbeat.ok, false);
    await at(19);
    assert.equal(w.heartbeats.length, 2, "not before 5 s");
    await at(20);
    assert.equal(w.heartbeats.length, 3);
    await at(29);
    assert.equal(w.heartbeats.length, 3, "then 10 s");
    await at(30);
    assert.equal(w.heartbeats.length, 4);
    assert.equal(w.stopped, 0);
    assert.equal(last().tunnel.state, "up");
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("current") }];
    await at(50);
    assert.equal(w.heartbeats.length, 5);
    assert.equal(last().heartbeat.ok, true);
  });

  test("network error counts as a failure too", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [new TypeError("fetch failed")];
    await at(0);
    assert.equal(last().heartbeat.error, "fetch failed");
    await at(4);
    assert.equal(w.heartbeats.length, 1);
  });

  test("401: the token is asked for again once; a fresh one is retried", async () => {
    const { w, at, deps } = world();
    let n = 0;
    deps.session.token = async (_a, rejected) => { w.tokens.push(rejected); return rejected ? "kda_2" : n++ === 0 ? "kda_1" : "kda_2"; };
    w.replies.heartbeat = [{ status: 401, body: { error: "invalid_token" } }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    assert.deepEqual(w.tokens.slice(0, 2), [undefined, "kda_1"]);
    assert.deepEqual(w.auths.slice(0, 2), ["Bearer kda_1", "Bearer kda_2"]);
    assert.equal(w.heartbeats.length, 2);
    assert.equal(w.credentialCalls, 1, "'current' with nothing in memory (a restart) fetches them");
  });

  test("401 twice: treated as signed out (managed tunnel stops, no heartbeats)", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 401, body: { error: "invalid_token" } }];
    await at(0);
    assert.equal(w.opened.length, 1);
    await at(15);
    assert.equal(w.stopped, 1);
    assert.equal(last().signedIn, null);
    const n = w.heartbeats.length;
    await at(30);
    await at(300);
    assert.equal(w.heartbeats.length, n);
  });

  test("403 device_token_required: tunnel stops, error recorded, retried in 15 minutes", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 403, body: { error: "device_token_required" } }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    await at(15);
    assert.equal(w.stopped, 1);
    assert.match(last().heartbeat.error!, /device_token_required/);
    assert.equal(last().tunnel.state, "off");
    const n = w.heartbeats.length;
    for (let s = 30; s < 15 + BLOCKED_RETRY_MS / 1000; s += 60) await at(s);
    assert.equal(w.heartbeats.length, n);
    await at(15 + BLOCKED_RETRY_MS / 1000);
    assert.equal(w.heartbeats.length, n + 1);
  });

  test("tunnel open fails: backoff, and a credentials failure refetches", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    w.openError = new TunnelError("credentials", "ngrok refused the credentials: ERR_NGROK_107");
    await at(0);
    assert.equal(w.opened.length, 1);
    assert.equal(last().tunnel.state, "down");
    assert.match(last().tunnel.reason!, /ERR_NGROK_107/);
    await at(4);
    assert.equal(w.opened.length, 1, "no retry before 5 s");
    w.openError = undefined;
    await at(5);
    assert.equal(w.credentialCalls, 2, "refetched after a credentials failure");
    assert.equal(w.opened.length, 2);
    assert.equal(last().tunnel.state, "up");
  });

  test("onDown: state down, a tick is asked for, the tunnel reopens after the backoff", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    await at(15);
    w.health = { state: "down", reason: "ngrok exited", since: new Date(w.t).toISOString() };
    w.opened[0].onDown!("ngrok exited");
    assert.equal(w.kicks, 1);
    assert.equal(last().tunnel.state, "down");
    assert.equal(last().tunnel.reason, "ngrok exited");
    await at(17);
    assert.equal(w.opened.length, 1, "backoff first");
    await at(20);
    assert.equal(w.opened.length, 2);
    assert.equal(w.stopped, 1, "the dead one is stopped first");
    await at(35);
    const states = w.heartbeats.map((h) => h.tunnel.state);
    assert.deepEqual(states.slice(-1), ["up"]);
  });

  test("wake (a poll more than 2 × POLL late): restart the tunnel and heartbeat at once", async () => {
    const { w, at } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    await at(15);
    const n = w.heartbeats.length;
    await at(15 + 3600);
    assert.equal(w.stopped, 1);
    assert.equal(w.opened.length, 2);
    assert.equal(w.heartbeats.length, n + 1);
    assert.ok(w.logs.some((l) => /woke up/.test(l)));
  });

  test("a slow tick (requests timing out) is not a wake: no restart", async () => {
    const { w, deps, loop, at } = world();
    await at(0);
    assert.equal(w.opened.length, 1);
    // Outfitter hangs: each request takes 20 s of the clock, then fails with a 503.
    const real = deps.fetch;
    deps.fetch = (async (url: string, init: RequestInit) => { w.t += 20_000; return real(url, init); }) as unknown as typeof fetch;
    w.replies.heartbeat = [{ status: 503, body: { error: "unavailable" } }];
    w.snap = snapshot([LMS], [QWEN], "k2");
    await at(15); // the change heartbeat; this tick ends at t = 35 s
    const n = w.heartbeats.length;
    w.t = T0 + 50_000; // the next poll, 15 s after that tick ended (35 s after it started)
    await loop.tick();
    assert.equal(w.stopped, 0, "the tunnel was not restarted");
    assert.ok(!w.logs.some((l) => /woke up/.test(l)));
    assert.equal(w.heartbeats.length, n + 1, "one retry after the backoff, nothing more");
  });

  test("400 invalid_heartbeat records the field", async () => {
    const { w, at, last } = world();
    w.replies.heartbeat = [{ status: 400, body: { error: "invalid_heartbeat", field: "hostName" } }];
    await at(0);
    assert.equal(last().heartbeat.error, "invalid_heartbeat (hostName)");
    assert.equal(w.heartbeats.length, 1);
  });
});

describe("stop and limits", () => {
  test("stop(): the stop heartbeat (tunnel stopped), then the tunnel", async () => {
    const { w, at, loop, last } = world();
    w.replies.heartbeat = [{ status: 200, body: hbAnswer("fetch") }, { status: 200, body: hbAnswer("current") }];
    await at(0);
    await at(15);
    await loop.stop();
    const hb = w.heartbeats[w.heartbeats.length - 1];
    assert.equal(hb.reason, "stop");
    assert.equal(hb.tunnel.state, "stopped");
    assert.equal(w.stopped, 1);
    assert.equal(last().tunnel.state, "stopped");
  });

  test("stop() before any accepted heartbeat sends none", async () => {
    const { w, loop } = world({ signedIn: false });
    await loop.stop();
    assert.equal(w.heartbeats.length, 0);
  });

  test("servers and models are capped at the api's limits", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...QWEN, id: `m${i}` }));
    const { w, at } = world({ snap: snapshot([LMS], many) });
    await at(0);
    assert.equal(w.heartbeats[0].models.length, 256);
  });

  test("settings are refreshed every 10 minutes and on SIGHUP", async () => {
    const { w, at, loop } = world({ share: false });
    await at(0);
    await at(300);
    assert.equal(w.configRefreshes, 1);
    await at(600);
    assert.equal(w.configRefreshes, 2);
    loop.requestConfigRefresh();
    await at(615);
    assert.equal(w.configRefreshes, 3);
  });
});

describe("serve()", () => {
  test("ticks until SIGTERM, then stop(); SIGHUP asks for a settings refresh", async () => {
    const handlers = new Map<SignalName, () => void>();
    let ticks = 0, stops = 0, refreshes = 0;
    const fake = {
      setKick() {},
      requestConfigRefresh() { refreshes++; },
      nextDelayMs: () => 5,
      async tick() {
        ticks++;
        if (ticks === 2) handlers.get("SIGHUP")!();
        if (ticks === 3) handlers.get("SIGTERM")!();
      },
      async stop() { stops++; },
    } as unknown as LocalHostLoop;
    await serve(fake, { onSignal: (s, h) => handlers.set(s, h), log: () => {} });
    assert.deepEqual([ticks, stops, refreshes], [3, 1, 1]);
    assert.deepEqual([...handlers.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  });
});
