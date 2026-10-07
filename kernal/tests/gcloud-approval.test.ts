// GA-4 (#494): the decision paths of the gcloud MCP approval hook, and its wiring to
// pi-mcp-adapter's approval broker event.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import register, { APPROVAL_REQUEST_EVENT } from "../.pi/extensions/gcloud-approval/index.ts";
import { decide, isGcloudServer, needsApproval, shown, type Call, type Ways } from "../.pi/extensions/gcloud-approval/hook.ts";
import type { AdminReply, AdminTransport } from "../.pi/extensions/outfitter-admin/transport.ts";
import { makePi } from "./harness.ts";

const read: Call = { serverName: "gcloud", tool: "run_gcloud_command", args: { project: "projects/p1", command: "gcloud compute instances list" } };
const write: Call = { serverName: "gcloud", tool: "run_gcloud_command", args: { project: "projects/p1", command: "gcloud compute instances delete vm-1" } };

function transport(kind: "drive" | "laptop", reply: AdminReply = { ok: true, text: "approved" }) {
  const calls: Array<{ op: string; args: Record<string, unknown>; confirmed?: boolean }> = [];
  const t: AdminTransport = {
    kind,
    async call(op, args, opts = {}) {
      calls.push({ op, args, confirmed: opts.confirmed });
      return reply;
    },
  };
  return { t, calls };
}

describe("decide", () => {
  test("a read abstains: no dialog, no call", async () => {
    const drive = transport("drive");
    let asked = 0;
    assert.equal(await decide(read, { drive: false, confirm: async () => (asked++, true) }), "abstain");
    assert.equal(await decide(read, { drive: true, transport: drive.t }), "abstain");
    assert.equal(asked, 0);
    assert.equal(drive.calls.length, 0);
  });

  test("another server's call is not ours", async () => {
    assert.equal(needsApproval({ ...write, serverName: "github" }), false);
    assert.equal(await decide({ ...write, serverName: "github" }, { drive: false }), "abstain");
  });

  test("laptop: a write asks with the project and command; yes allows once and is noted", async () => {
    const shownDialog: string[] = [];
    const lap = transport("laptop");
    const ways: Ways = {
      drive: false,
      transport: lap.t,
      confirm: async (title, message) => (shownDialog.push(title, message), true),
    };
    assert.equal(await decide(write, ways), "allow_once");
    assert.match(shownDialog[1], /projects\/p1/);
    assert.match(shownDialog[1], /instances delete vm-1/);
    assert.deepEqual(lap.calls, [{ op: "gcloud.note", args: { project: "projects/p1", command: "gcloud compute instances delete vm-1", tool: "run_gcloud_command", decision: "allowed" }, confirmed: true }]);
  });

  test("laptop: no is a denial, noted, and tells the person", async () => {
    const lap = transport("laptop");
    const said: string[] = [];
    assert.equal(await decide(write, { drive: false, transport: lap.t, confirm: async () => false, notify: (m) => said.push(m) }), "deny");
    assert.equal(lap.calls[0].args.decision, "denied");
    assert.equal(lap.calls[0].confirmed, false);
    assert.deepEqual(said, ["gcloud: denied by owner"]);
  });

  test("laptop: a failing audit note does not change the decision", async () => {
    const t: AdminTransport = { kind: "laptop", call: async () => { throw new Error("offline"); } };
    assert.equal(await decide(write, { drive: false, transport: t, confirm: async () => true }), "allow_once");
  });

  test("laptop: a logged-out machine still asks (no note)", async () => {
    assert.equal(await decide(write, { drive: false, confirm: async () => true }), "allow_once");
  });

  test("no channel (kernal -p, no TUI): a write is denied", async () => {
    const said: string[] = [];
    assert.equal(await decide(write, { drive: false, notify: (m) => said.push(m) }), "deny");
    assert.match(said[0], /nobody is here/);
  });

  test("Drive: the owner's card allows once through gcloud.run", async () => {
    const d = transport("drive");
    assert.equal(await decide(write, { drive: true, transport: d.t }), "allow_once");
    assert.deepEqual(d.calls, [{ op: "gcloud.run", args: { project: "projects/p1", command: "gcloud compute instances delete vm-1", tool: "run_gcloud_command" }, confirmed: undefined }]);
  });

  test("Drive: a decline, a timeout or any refusal denies", async () => {
    const said: string[] = [];
    const d = transport("drive", { ok: false, error: "the owner declined", needsApproval: true });
    assert.equal(await decide(write, { drive: true, transport: d.t, notify: (m) => said.push(m) }), "deny");
    assert.match(said[0], /the owner declined/);
  });

  test("Drive: no admin socket denies, and never falls back to a dialog", async () => {
    let asked = 0;
    assert.equal(await decide(write, { drive: true, confirm: async () => (asked++, true) }), "deny");
    assert.equal(await decide(write, { drive: true, transport: transport("laptop").t, confirm: async () => (asked++, true) }), "deny");
    assert.equal(asked, 0);
  });

  test("unparseable or unknown commands ask", async () => {
    for (const command of ["gcloud projects list; rm -rf /", "gcloud frob", undefined, 7]) {
      let asked = 0;
      const call = { ...read, args: { project: "p", command } };
      assert.equal(await decide(call, { drive: false, confirm: async () => (asked++, false) }), "deny");
      assert.equal(asked, 1);
    }
  });

  test("run_bq_command writes ask; a plain SELECT does not", async () => {
    const bq = (command: string): Call => ({ serverName: "gcloud", tool: "run_bq_command", args: { project: "p", command } });
    assert.equal(await decide(bq("bq query 'SELECT 1'"), { drive: false }), "abstain");
    assert.equal(await decide(bq("bq rm -f d.t"), { drive: false }), "deny");
  });

  test("an unknown tool on the server asks", () => {
    assert.equal(needsApproval({ ...read, tool: "run_something_new" }), true);
  });
});

describe("shown and isGcloudServer", () => {
  test("control and bidi characters are made visible; long text is clipped", () => {
    assert.equal(shown("a\u001b[31mb‮c"), "a�[31mb�c");
    assert.equal(shown("x".repeat(900)).length, 800);
    assert.equal(shown(undefined), "");
  });

  test("the server name: gcloud, or plugin-prefixed", () => {
    assert.equal(isGcloudServer("gcloud"), true);
    assert.equal(isGcloudServer("acme__gcloud"), true);
    assert.equal(isGcloudServer("gcloud2"), false);
    assert.equal(isGcloudServer("not-gcloud"), false);
  });
});

describe("wiring to the adapter's approval event", () => {
  function request(call: Call) {
    let handler: (() => unknown) | undefined;
    return {
      req: { serverName: call.serverName, originalToolName: call.tool, args: call.args, claim: (h: () => unknown) => ((handler = h), true) },
      claimed: () => handler,
    };
  }
  const fireWith = (ways: Ways, call: Call) => {
    const pi = makePi();
    register(pi as any, { ways: () => ways });
    const r = request(call);
    pi.events.emit(APPROVAL_REQUEST_EVENT, r.req);
    return r.claimed();
  };

  test("a read is left unclaimed", () => {
    assert.equal(fireWith({ drive: false }, read), undefined);
  });

  test("another server is left unclaimed", () => {
    assert.equal(fireWith({ drive: false }, { ...write, serverName: "sentry" }), undefined);
  });

  test("a write is claimed synchronously and answered by the decision", async () => {
    const yes = fireWith({ drive: false, confirm: async () => true }, write);
    assert.ok(yes);
    assert.equal(await yes(), "allow_once");
    const no = fireWith({ drive: false, confirm: async () => false }, write);
    assert.equal(await no!(), "deny");
    const none = fireWith({ drive: false }, write);
    assert.equal(await none!(), "deny");
  });

  test("remembers the latest context from pi events for the dialog", async () => {
    const pi = makePi();
    const seen: any[] = [];
    register(pi as any, { ways: (ctx) => (seen.push(ctx), { drive: false }) });
    const ctx = { mode: "tui" };
    await pi.emit("session_start", {}, ctx);
    const r = request(write);
    pi.events.emit(APPROVAL_REQUEST_EVENT, r.req);
    await r.claimed()!();
    assert.equal(seen[0], ctx);
  });
});
