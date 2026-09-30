// Sysop tools (outfitter/docs/specs/sysop-tools.md): the outfitter-admin extension's transports,
// the tool -> op mapping, the laptop delete confirm, and the token budget for its definitions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../.pi/extensions/outfitter-admin/index.ts";
import { ADMIN_TOOLS, runTool } from "../.pi/extensions/outfitter-admin/tools.ts";
import { adminTransport, httpTransport, socketTransport, type AdminTransport } from "../.pi/extensions/outfitter-admin/transport.ts";

function fakePi() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t) } as any, tools };
}

function recorder(replies: Array<Record<string, unknown>>, kind: "laptop" | "drive" = "laptop") {
  const calls: Array<{ op: string; args: Record<string, unknown>; confirmed?: boolean }> = [];
  const transport: AdminTransport = {
    kind,
    async call(op, args, opts = {}) {
      calls.push({ op, args, confirmed: opts.confirmed });
      return (replies.shift() ?? { ok: true, text: "" }) as any;
    },
  };
  return { transport, calls };
}

const tapes = ADMIN_TOOLS.find((t) => t.name === "outfitter_tapes")!;

describe("registration", () => {
  test("no transport, no tools", () => {
    const { pi, tools } = fakePi();
    register(pi, undefined);
    assert.equal(tools.length, 0);
  });

  test("with a transport: three tools, one snippet and guideline in total", () => {
    const { pi, tools } = fakePi();
    register(pi, recorder([]).transport);
    assert.deepEqual(tools.map((t) => t.name), ["outfitter_tapes", "outfitter_environments", "outfitter_sessions"]);
    assert.equal(tools.filter((t) => t.promptSnippet).length, 1);
    assert.equal(tools.flatMap((t) => t.promptGuidelines ?? []).length, 1);
  });

  test("token budget: every definition together stays under ~1.5k tokens (4 chars per token)", () => {
    const { pi, tools } = fakePi();
    register(pi, recorder([]).transport);
    const chars = tools
      .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines }))
      .join("").length;
    assert.ok(chars / 4 <= 1500, `definitions are ~${Math.round(chars / 4)} tokens`);
    for (const t of tools) assert.ok(t.description.length <= 160, `${t.name} description is ${t.description.length} chars`);
  });

  test("adminTransport: socket wins, then a Dongle, else none", () => {
    assert.equal(adminTransport({ OUTFITTER_ADMIN_SOCKET: "/run/a.sock", OUTFITTER_API: "https://x", OUTFITTER_TOKEN: "t" })?.kind, "drive");
    assert.equal(adminTransport({ OUTFITTER_API: "https://x", OUTFITTER_TOKEN: "t" })?.kind, "laptop");
    assert.equal(adminTransport({ OUTFITTER_API: "https://x" }), undefined);
    assert.equal(adminTransport({}), undefined);
  });
});

describe("runTool", () => {
  test("maps action and fields to the op, and passes the text through", async () => {
    const { transport, calls } = recorder([{ ok: true, text: "created reviewer" }]);
    const res = await runTool(tapes, { action: "create", id: "reviewer", fields: { name: "Reviewer", model: "a/b" } }, transport);
    assert.deepEqual(calls, [{ op: "tapes.create", args: { id: "reviewer", name: "Reviewer", model: "a/b" }, confirmed: undefined }]);
    assert.deepEqual(res, { content: [{ type: "text", text: "created reviewer" }] });
  });

  test("an unknown action is a one-line error, with no call", async () => {
    const { transport, calls } = recorder([]);
    const res = await runTool(tapes, { action: "nuke" }, transport);
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, "action must be one of: list, get, meta, create, update, delete");
    assert.equal(calls.length, 0);
  });

  test("laptop delete: asks, then resends confirmed", async () => {
    const { transport, calls } = recorder([{ ok: false, error: "needs approval", needsApproval: true }, { ok: true, text: "deleted old" }]);
    const asked: string[] = [];
    const res = await runTool(tapes, { action: "delete", id: "old" }, transport, async (title) => (asked.push(title), true));
    assert.deepEqual(asked, ["Outfitter: tapes.delete old?"]);
    assert.deepEqual(calls.map((c) => c.confirmed), [undefined, true]);
    assert.equal(res.content[0].text, "deleted old");
  });

  test("laptop delete declined, or nobody to ask", async () => {
    const declined = recorder([{ ok: false, error: "needs approval", needsApproval: true }]);
    const res = await runTool(tapes, { action: "delete", id: "old" }, declined.transport, async () => false);
    assert.equal(res.content[0].text, "the user declined");
    assert.equal(declined.calls.length, 1);

    const headless = recorder([{ ok: false, error: "needs approval", needsApproval: true }]);
    const res2 = await runTool(tapes, { action: "delete", id: "old" }, headless.transport);
    assert.match(res2.content[0].text, /^needs approval/);
    assert.equal(headless.calls.length, 1);
  });

  test("a Drive never resends confirmed", async () => {
    const { transport, calls } = recorder([{ ok: false, error: "the owner declined", needsApproval: true }], "drive");
    const res = await runTool(tapes, { action: "delete", id: "old" }, transport, async () => true);
    assert.equal(calls.length, 1);
    assert.match(res.content[0].text, /^needs approval/);
  });
});

describe("httpTransport", () => {
  test("POSTs {op,args} with the Dongle, confirmed only when asked", async () => {
    const seen: any[] = [];
    const fetchFn = (async (url: string, init: any) => {
      seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => ({ ok: true, text: "ok" }) } as Response;
    }) as typeof fetch;
    const t = httpTransport("https://link.example.com/", "outf_x", fetchFn);
    assert.deepEqual(await t.call("tapes.list", {}), { ok: true, text: "ok" });
    await t.call("tapes.delete", { id: "a" }, { confirmed: true });
    assert.equal(seen[0].url, "https://link.example.com/api/admin/ops");
    assert.equal(seen[0].auth, "Bearer outf_x");
    assert.deepEqual(seen[0].body, { op: "tapes.list", args: {} });
    assert.deepEqual(seen[1].body, { op: "tapes.delete", args: { id: "a" }, confirmed: true });
  });

  test("401 and 404 become actionable one-liners", async () => {
    const status = (code: number) => (async () => ({ status: code, ok: false, json: async () => ({}) }) as Response) as typeof fetch;
    assert.match((await httpTransport("https://x", "t", status(401)).call("tapes.list", {}) as any).error, /OUTFITTER_TOKEN was rejected/);
    assert.match((await httpTransport("https://x", "t", status(404)).call("tapes.list", {}) as any).error, /newer release/);
  });
});

describe("socketTransport", () => {
  async function server(handle: (frame: any, sock: import("node:net").Socket, n: number) => void): Promise<{ path: string; srv: Server; frames: any[] }> {
    const path = join(mkdtempSync(join(tmpdir(), "adm-")), "a.sock");
    const frames: any[] = [];
    const srv = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const frame = JSON.parse(buf.slice(0, nl));
        frames.push(frame);
        handle(frame, sock, frames.length);
      });
    });
    await new Promise<void>((r) => srv.listen(path, r));
    return { path, srv, frames };
  }

  test("a read: one frame, no idempotency key; a write carries one", async () => {
    const { path, srv, frames } = await server((f, sock) => sock.write(`${JSON.stringify({ t: "admin.result", reqId: f.reqId, ok: true, text: "x" })}\n`));
    const t = socketTransport(path);
    assert.deepEqual(await t.call("tapes.list", {}), { ok: true, text: "x" });
    await t.call("tapes.create", { name: "n" });
    assert.equal(frames[0].t, "admin.request");
    assert.equal(frames[0].idempotencyKey, undefined);
    assert.equal(typeof frames[1].idempotencyKey, "string");
    srv.close();
  });

  test("a read is retried once after the socket closes; a write is not", async () => {
    const { path, srv, frames } = await server((f, sock, n) => {
      if (n === 1 || f.op === "tapes.create") return sock.end();
      sock.write(`${JSON.stringify({ t: "admin.result", reqId: f.reqId, ok: true, text: "second" })}\n`);
    });
    const t = socketTransport(path);
    assert.deepEqual(await t.call("tapes.get", { id: "a" }), { ok: true, text: "second" });
    const write = await t.call("tapes.create", { name: "n" });
    assert.equal(write.ok, false);
    assert.equal(frames.filter((f) => f.op === "tapes.create").length, 1);
    srv.close();
  });

  test("needsApproval and a mismatched reqId", async () => {
    const { path, srv } = await server((f, sock) =>
      sock.write(`${JSON.stringify({ t: "admin.result", reqId: f.op === "tapes.get" ? "other" : f.reqId, ok: false, error: "denied", needsApproval: true })}\n`),
    );
    const t = socketTransport(path);
    assert.deepEqual(await t.call("tapes.delete", { id: "a" }), { ok: false, error: "denied", needsApproval: true });
    assert.equal((await t.call("tapes.get", { id: "a" })).ok, false);
    srv.close();
  });
});
