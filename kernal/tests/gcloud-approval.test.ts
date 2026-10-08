// GA-4 (#494): the decision paths of the gcloud MCP approval hook, and its wiring to
// pi-mcp-adapter's approval broker event.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import register, { APPROVAL_REQUEST_EVENT } from "../.pi/extensions/gcloud-approval/index.ts";
import { FIRESTORE_READ_TOOLS, PRODUCT_READ_TOOLS, PRODUCT_WRITE_TOOLS, baseTool, decide, isGated, isGcloudServer, needsApproval, shown, type Call, type Ways } from "../.pi/extensions/gcloud-approval/hook.ts";
import type { AdminReply, AdminTransport } from "../.pi/extensions/outfitter-admin/transport.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfigFiles, configWarnings } from "../.pi/extensions/gcloud-approval/config-check.ts";
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
  test("a read is allowed explicitly: no dialog, no call", async () => {
    const drive = transport("drive");
    let asked = 0;
    assert.equal(await decide(read, { drive: false, confirm: async () => (asked++, true) }), "allow_once");
    assert.equal(await decide(read, { drive: true, transport: drive.t }), "allow_once");
    assert.equal(asked, 0);
    assert.equal(drive.calls.length, 0);
  });

  test("another server's other tools are not ours", async () => {
    const other = { serverName: "github", tool: "create_issue", args: { command: "gcloud compute instances delete vm-1" } };
    assert.equal(isGated(other), false);
    assert.equal(needsApproval(other), false);
    assert.equal(await decide(other, { drive: false }), "abstain");
  });

  test("the command tools are gated on any server name (a renamed server in a project .mcp.json)", async () => {
    const renamed = { ...write, serverName: "totally-innocent" };
    assert.equal(isGated(renamed), true);
    assert.equal(needsApproval(renamed), true);
    assert.equal(await decide(renamed, { drive: false }), "deny");
    assert.equal(await decide({ ...read, serverName: "totally-innocent" }, { drive: false }), "allow_once");
    assert.equal(isGated({ ...write, serverName: "x", tool: "run_bq_command" }), true);
  });

  test("Drive: an abort while the card waits withdraws it", async () => {
    const calls: string[] = [];
    const ac = new AbortController();
    const t: AdminTransport = {
      kind: "drive",
      async call(op) {
        calls.push(op);
        if (op === "gcloud.run") {
          ac.abort();
          return { ok: false, error: "cancelled" };
        }
        return { ok: true, text: "cancelled" };
      },
    };
    assert.equal(await decide(write, { drive: true, transport: t }, ac.signal), "deny");
    assert.deepEqual(calls, ["gcloud.run", "gcloud.cancel"]);
  });

  test("Drive: a plain decline does not call cancel", async () => {
    const d = transport("drive", { ok: false, error: "the owner declined", needsApproval: true });
    await decide(write, { drive: true, transport: d.t });
    assert.deepEqual(d.calls.map((c) => c.op), ["gcloud.run"]);
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

  test("run_bq_command writes ask; a capped plain SELECT does not", async () => {
    const bq = (command: string): Call => ({ serverName: "gcloud", tool: "run_bq_command", args: { project: "p", command } });
    assert.equal(await decide(bq("bq query --maximum_bytes_billed=1000 'SELECT 1'"), { drive: false }), "allow_once");
    assert.equal(await decide(bq("bq query 'SELECT 1'"), { drive: false }), "deny");
    assert.equal(await decide(bq("bq rm -f d.t"), { drive: false }), "deny");
  });

  test("an unknown tool on the server asks", () => {
    assert.equal(needsApproval({ ...read, tool: "run_something_new" }), true);
  });
});

describe("router-prefixed tool names", () => {
  // The router names upstream tools `<server>-<tool>` (seen live 2026-10-08: gcloud-run_gcloud_command).
  test("baseTool strips a server prefix and nothing else", () => {
    assert.equal(baseTool("run_gcloud_command"), "run_gcloud_command");
    assert.equal(baseTool("gcloud-run_gcloud_command"), "run_gcloud_command");
    assert.equal(baseTool("gcloud-run_bq_command"), "run_bq_command");
    assert.equal(baseTool("gcp_run_gcloud_command"), "run_gcloud_command");
    assert.equal(baseTool("acme.gcloud:run_bq_command"), "run_bq_command");
    assert.equal(baseTool("xrun_gcloud_command"), "xrun_gcloud_command");
    assert.equal(baseTool("run_gcloud_command_v2"), "run_gcloud_command_v2");
  });

  test("on the gcloud server, a prefixed read runs and a prefixed write asks", async () => {
    const r = { ...read, tool: "gcloud-run_gcloud_command" };
    const w = { ...write, tool: "gcloud-run_gcloud_command" };
    assert.equal(needsApproval(r), false);
    assert.equal(needsApproval(w), true);
    assert.equal(await decide(r, { drive: false, confirm: async () => false }), "allow_once");
    assert.equal(await decide(w, { drive: false, confirm: async () => false }), "deny");
  });

  test("a renamed server pointing at the router's gcloud is still gated", () => {
    const renamed = { serverName: "gcp", tool: "gcloud-run_gcloud_command", args: write.args };
    assert.equal(isGated(renamed), true);
    assert.equal(needsApproval(renamed), true);
    assert.equal(needsApproval({ ...renamed, args: read.args }), false);
  });

  test("the Drive card and audit get the base tool name, so a bq write is labelled bq", async () => {
    const d = transport("drive");
    const bq = { serverName: "gcloud", tool: "gcloud-run_bq_command", args: { project: "projects/p1", command: "bq rm -f ds.t" } };
    assert.equal(await decide(bq, { drive: true, transport: d.t }), "allow_once");
    assert.equal((d.calls[0] as { args: { tool: string } }).args.tool, "run_bq_command");
  });

  test("an unknown tool on the gcloud server still asks", () => {
    assert.equal(needsApproval({ serverName: "gcloud", tool: "gcloud-something_else", args: read.args }), true);
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

  test("a read is claimed and allowed explicitly (so approveTools is only the fallback)", async () => {
    const h = fireWith({ drive: false }, read);
    assert.ok(h);
    assert.equal(await h(), "allow_once");
  });

  test("another server's other tools are left unclaimed", () => {
    assert.equal(fireWith({ drive: false }, { serverName: "sentry", tool: "get_issue", args: {} }), undefined);
  });

  test("a renamed server with the gcloud tools is claimed", async () => {
    const h = fireWith({ drive: false }, { ...write, serverName: "docs" });
    assert.equal(await h!(), "deny");
  });

  test("when another extension claimed first, it says so loudly", () => {
    const pi = makePi();
    const warned: string[] = [];
    register(pi as any, { ways: () => ({ drive: false }), warn: (m) => warned.push(m) });
    const err = console.error;
    console.error = () => {};
    try {
      pi.events.emit(APPROVAL_REQUEST_EVENT, { serverName: "gcloud", originalToolName: "run_gcloud_command", args: write.args, claim: () => false });
    } finally {
      console.error = err;
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /another extension claimed/);
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

describe("startup self-check: approveTools on the gcloud server", () => {
  const warnings = (cfg: unknown) => configWarnings(cfg, "mcp.json");

  test("warns when the gcloud server has no approveTools: true", () => {
    assert.equal(warnings({ mcpServers: { gcloud: { url: "https://router.kernal.one/gcloud/mcp" } } }).length, 1);
    assert.equal(warnings({ mcpServers: { gcloud: { approveTools: ["delete_*"] } } }).length, 1);
    assert.equal(warnings({ mcpServers: { gcloud: { approveTools: false } } }).length, 1);
  });

  test("a renamed server pointing at the gcloud URL is recognised", () => {
    assert.equal(warnings({ mcpServers: { docs: { url: "https://router.kernal.one/gcloud/mcp" } } }).length, 1);
    assert.equal(warnings({ mcpServers: { docs: { url: "https://cloudcli.googleapis.com/mcp" } } }).length, 1);
  });

  test("quiet with approveTools: true, per server or in settings", () => {
    assert.deepEqual(warnings({ mcpServers: { gcloud: { approveTools: true } } }), []);
    assert.deepEqual(warnings({ settings: { approveTools: true }, mcpServers: { gcloud: {} } }), []);
  });

  test("quiet for other servers and odd input", () => {
    assert.deepEqual(warnings({ mcpServers: { sentry: { url: "https://x/sentry/mcp" } } }), []);
    assert.deepEqual(warnings(null), []);
    assert.deepEqual(warnings({ mcpServers: 3 }), []);
  });

  test("session_start reads the config files and warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { gcloud: { url: "https://router.kernal.one/gcloud/mcp" } } }));
    const pi = makePi();
    const warned: string[] = [];
    register(pi as any, { ways: () => ({ drive: false }), warn: (m) => warned.push(m), configDirs: () => ({ agentDir: dir }) });
    await pi.emit("session_start", {}, {});
    assert.equal(warned.length, 1);
    assert.match(warned[0], /approveTools/);
    assert.deepEqual(checkConfigFiles({ agentDir: join(dir, "nope") }), []);
  });
});

describe("Google product tools (GB-5, #541)", () => {
  const prod = (tool: string, args: Record<string, unknown> = {}, serverName = "google_cloud"): Call => ({ serverName, tool, args });
  const READS: Record<string, string[]> = {
    cloudrun: ["get_service", "list_services"],
    cloudlogging: ["list_log_entries", "list_log_names", "get_bucket", "list_buckets", "get_view", "list_views"],
    cloudmonitoring: ["list_timeseries", "query_range", "get_alert_policy", "list_alert_policies", "get_alert", "list_alerts", "list_metric_descriptors", "list_dashboards", "get_dashboard"],
  };

  test("the allow-list is exactly Google's readOnlyHint tools", () => {
    assert.deepEqual([...PRODUCT_READ_TOOLS].sort(), Object.values(READS).flat().sort());
    assert.deepEqual([...PRODUCT_WRITE_TOOLS].sort(), ["deploy_service_from_archive", "deploy_service_from_file_contents", "deploy_service_from_image"]);
    assert.equal(FIRESTORE_READ_TOOLS.size, 0);
  });

  test("every read tool runs unasked, bare and prefixed, on google_cloud and on a renamed server", async () => {
    for (const [server, tools] of Object.entries(READS)) {
      for (const t of tools) {
        for (const call of [prod(t), prod(`${server}-${t}`), prod(`${server}-${t}`, {}, "gcp"), prod(`${server}_${t}`, {}, "whatever")]) {
          assert.equal(isGated(call), true, call.tool);
          assert.equal(needsApproval(call), false, call.tool);
          assert.equal(await decide(call, { drive: false }), "allow_once", call.tool);
        }
      }
    }
  });

  test("deploys ask, on any server, and the Drive gets the base tool, project and a summary", async () => {
    for (const t of PRODUCT_WRITE_TOOLS) {
      for (const call of [prod(`cloudrun-${t}`), prod(`cloudrun-${t}`, {}, "gcp"), prod(t, {}, "anything")]) {
        assert.equal(isGated(call), true);
        assert.equal(needsApproval(call), true);
        assert.equal(await decide(call, { drive: false }), "deny");
      }
    }
    const d = transport("drive");
    const args = { name: "projects/p1/locations/us-central1/services/web", image: "gcr.io/p1/web" };
    assert.equal(await decide(prod("cloudrun-deploy_service_from_image", args), { drive: true, transport: d.t }), "allow_once");
    const sent = d.calls[0];
    assert.equal(sent.op, "gcloud.run");
    assert.equal(sent.args.tool, "deploy_service_from_image");
    assert.equal(sent.args.project, "projects/p1");
    assert.equal(sent.args.command, JSON.stringify(args));
  });

  test("an explicit project arg wins; parent is parsed; a long summary is clipped on one line", async () => {
    const d = transport("drive");
    await decide(prod("cloudrun-deploy_service_from_file_contents", { project: "p9", parent: "projects/p1/locations/x", files: "a".repeat(5000) }), { drive: true, transport: d.t });
    const a = d.calls[0].args as { project: string; command: string };
    assert.equal(a.project, "p9");
    assert.ok(a.command.length <= 600);
    assert.ok(a.command.endsWith("…"));
    assert.ok(!a.command.includes("\n"));
    const d2 = transport("drive");
    await decide(prod("cloudrun-deploy_service_from_archive", { parent: "projects/p2/locations/x" }), { drive: true, transport: d2.t });
    assert.equal((d2.calls[0].args as { project: string }).project, "projects/p2");
    const d3 = transport("drive");
    await decide(prod("cloudrun-deploy_service_from_archive", {}), { drive: true, transport: d3.t });
    assert.equal((d3.calls[0].args as { project: string; command: string }).project, "");
    assert.equal((d3.calls[0].args as { command: string }).command, "(no arguments)");
  });

  test("laptop: the confirm names the tool and arguments, and the audit note carries them", async () => {
    const l = transport("laptop");
    let shownMsg = "";
    const yes = await decide(prod("cloudrun-deploy_service_from_image", { image: "i" }), { drive: false, transport: l.t, confirm: async (title, msg) => ((shownMsg = `${title} ${msg}`), true) });
    assert.equal(yes, "allow_once");
    assert.match(shownMsg, /deploy_service_from_image/);
    assert.match(shownMsg, /"image":"i"/);
    assert.equal(l.calls[0].op, "gcloud.note");
    assert.equal((l.calls[0].args as { tool: string }).tool, "deploy_service_from_image");
  });

  test("unknown tools ask: firestore (none are allow-listed), new Google tools, unknown servers' tools on google_cloud", async () => {
    for (const t of ["firestore-get_document", "firestore-list_documents", "firestore-run_query", "firestore-delete_document", "cloudrun-delete_service", "mystery-tool"]) {
      const call = prod(t);
      assert.equal(isGated(call), true, t);
      assert.equal(needsApproval(call), true, t);
      assert.equal(await decide(call, { drive: false }), "deny", t);
    }
    const d = transport("drive");
    await decide(prod("firestore-delete_document", { name: "projects/p1/databases/(default)/documents/a/b" }), { drive: true, transport: d.t });
    assert.equal((d.calls[0].args as { tool: string }).tool, "firestore-delete_document");
    assert.equal((d.calls[0].args as { project: string }).project, "projects/p1");
  });

  test("a plugin-prefixed google_cloud server is gated; lookalike tools on other servers are not", () => {
    assert.equal(isGcloudServer("google_cloud"), true);
    assert.equal(isGcloudServer("acme__google_cloud"), true);
    assert.equal(isGcloudServer("xgoogle_cloud"), false);
    assert.equal(isGated(prod("something_new", {}, "acme__google_cloud")), true);
    assert.equal(isGated(prod("xget_service", {}, "github")), false);
    assert.equal(isGated(prod("get_services", {}, "github")), false);
    assert.equal(isGated(prod("create_issue", {}, "github")), false);
  });

  test("baseTool: product names with underscores, only the known tool after a boundary", () => {
    assert.equal(baseTool("cloudrun-deploy_service_from_image"), "deploy_service_from_image");
    assert.equal(baseTool("cloudmonitoring-list_alert_policies"), "list_alert_policies");
    assert.equal(baseTool("cloudlogging-get_view"), "get_view");
    assert.equal(baseTool("google_cloud.cloudrun:get_service"), "get_service");
    assert.equal(baseTool("get_service"), "get_service");
    assert.equal(baseTool("forget_service"), "forget_service");
    assert.equal(baseTool("get_service_v2"), "get_service_v2");
    assert.equal(baseTool("firestore-get_document"), "firestore-get_document");
  });

  test("a gcloud command tool on google_cloud still uses the classifier", async () => {
    assert.equal(needsApproval({ ...read, serverName: "google_cloud", tool: "gcloud-run_gcloud_command" }), false);
    assert.equal(needsApproval({ ...write, serverName: "google_cloud", tool: "gcloud-run_gcloud_command" }), true);
    const d = transport("drive");
    await decide({ ...write, serverName: "google_cloud", tool: "gcloud-run_gcloud_command" }, { drive: true, transport: d.t });
    assert.deepEqual(d.calls[0].args, { project: "projects/p1", command: write.args.command, tool: "run_gcloud_command" });
  });

  test("wiring: the adapter's request for a cloudrun deploy is claimed and denied headless; a read is allowed", async () => {
    const pi = makePi();
    register(pi as any, { ways: () => ({ drive: false }), warn: () => {}, configDirs: () => ({}) });
    const answer = async (serverName: string, tool: string) => {
      let handler: any;
      pi.events.emit(APPROVAL_REQUEST_EVENT, { serverName, originalToolName: tool, args: {}, claim: (h: any) => ((handler = h), true) });
      return handler ? await handler() : "unclaimed";
    };
    assert.equal(await answer("google_cloud", "cloudrun-deploy_service_from_image"), "deny");
    assert.equal(await answer("google_cloud", "cloudrun-list_services"), "allow_once");
    assert.equal(await answer("gcp", "cloudrun-deploy_service_from_image"), "deny");
    assert.equal(await answer("github", "create_issue"), "unclaimed");
  });

  test("config check: a google_cloud server by name or URL needs approveTools: true", () => {
    const w = (c: any) => configWarnings(c, "mcp.json");
    assert.equal(w({ mcpServers: { google_cloud: {} } }).length, 1);
    assert.equal(w({ mcpServers: { gc: { url: "https://router.kernal.one/google_cloud/mcp" } } }).length, 1);
    assert.equal(w({ mcpServers: { gc: { url: "https://router.kernal.one/google_cloud/mcp", approveTools: true } } }).length, 0);
    assert.equal(w({ mcpServers: { google_cloud: { approveTools: true } } }).length, 0);
  });
});
