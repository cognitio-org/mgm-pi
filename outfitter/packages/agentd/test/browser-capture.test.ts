import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureListener,
  captureDownloadError,
  peerUidFromProcNet,
} from "../src/browser-capture.js";
import outfitterBrowser from "../pi-extension/outfitter-browser.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function procTable(): string {
  // Server port 8080 (0x1F90) uid 0, client port 50000 (0xC350) uid 1000. Both loopback.
  return [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000 0 0 111 1 00000000 20 4 30 10 -1",
    "   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000 1000 0 222 1 00000000 20 4 30 10 -1",
  ].join("\n");
}

test("peerUidFromProcNet reads the client socket, not the server's", () => {
  assert.equal(peerUidFromProcNet(procTable(), 8080, 50000), 1000);
  assert.equal(peerUidFromProcNet(procTable(), 8080, 9), undefined);
});

test("the capture listener binds loopback, refuses other callers, and writes the jpeg", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-capture-"));
  let requested: string | undefined;
  const listener = new CaptureListener({
    workspace,
    waitMs: 300,
    download: async () => JPEG,
    sendRequest: (requestId) => {
      requested = requestId;
      listener.deliver({
        t: "browser.capture.result",
        requestId,
        captureId: "cap1",
        title: "Docs",
        url: "https://example.test/docs",
      });
    },
  });
  await listener.start();
  try {
    const address = listener.port;
    assert.ok(address);
    const refused = await fetch(`http://127.0.0.1:${address}/browser/capture`);
    assert.equal(refused.status, 403);
    const otherPath = await fetch(`http://127.0.0.1:${address}/other`, {
      headers: { "x-outfitter-browser-token": listener.token },
    });
    assert.equal(otherPath.status, 404);

    const res = await fetch(`http://127.0.0.1:${address}/browser/capture`, {
      headers: { "x-outfitter-browser-token": listener.token },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { title: string; url: string; path: string };
    assert.equal(body.title, "Docs");
    assert.equal(body.url, "https://example.test/docs");
    assert.equal(body.path, join(workspace, ".outfitter", "captures", "cap1.jpg"));
    assert.equal(requested !== undefined, true);
    const file = await stat(body.path);
    const dir = await stat(join(workspace, ".outfitter", "captures"));
    const parent = await stat(join(workspace, ".outfitter"));
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(dir.mode & 0o777, 0o700);
    assert.equal(parent.mode & 0o777, 0o700);

    let tool: any;
    outfitterBrowser(
      {
        registerTool: (registered) => {
          tool = registered;
        },
      },
      { OUTFITTER_BROWSER_PORT: String(address), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    // The listener above already consumed one call inside sendRequest via deliver-before-wait.
    // A second call delivers from sendRequest the same way.
    const result = await tool!.execute("call-1", {});
    assert.match(result.content[0].text ?? "", /title: Docs/);
    assert.match(result.content[0].text ?? "", new RegExp(body.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const image = result.content.find((block: { type: string }) => block.type === "image");
    assert.ok(image);
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.data, JPEG.toString("base64"));
    assert.equal(result.content.some((block: { type: string }) => block.type !== "text" && block.type !== "image"), false);
  } finally {
    await listener.stop();
  }
});

test("a capture error is text, and a different uid cannot open the listener", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-capture-"));
  const listener = new CaptureListener({
    workspace,
    waitMs: 200,
    download: async () => {
      throw captureDownloadError("too_large");
    },
    sendRequest: (requestId) => {
      listener.deliver({ t: "browser.capture.result", requestId, error: "skipped" });
    },
  });
  await listener.start();
  try {
    let tool: any;
    outfitterBrowser(
      { registerTool: (registered) => { tool = registered; } },
      { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    const skipped = await tool.execute("call-1", {});
    assert.equal(skipped.content[0].text, "skipped");
    assert.equal(skipped.content.length, 1);
  } finally {
    await listener.stop();
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const closed = new CaptureListener({
    workspace,
    waitMs: 200,
    peerUid: uid + 1,
    download: async () => JPEG,
    sendRequest: () => {
      throw new Error("a refused peer must not ask for a capture");
    },
  });
  await closed.start();
  try {
    const res = await fetch(`http://127.0.0.1:${closed.port}/browser/capture`, {
      headers: { "x-outfitter-browser-token": closed.token },
    });
    assert.equal(res.status, 403);
  } finally {
    await closed.stop();
  }
});

test("the tool times out as text when the listener never answers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-capture-"));
  const listener = new CaptureListener({
    workspace,
    waitMs: 50,
    download: async () => JPEG,
    sendRequest: () => {},
  });
  await listener.start();
  try {
    let tool: any;
    outfitterBrowser(
      { registerTool: (registered) => { tool = registered; } },
      { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    const result = await tool.execute("call-1", {});
    assert.equal(result.content[0].text, "timeout");
  } finally {
    await listener.stop();
  }
});

test("the tool returns the other capture errors as text", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-capture-"));
  const errors = ["permission_denied", "tab_gone", "too_large"];
  const listener = new CaptureListener({
    workspace,
    waitMs: 200,
    download: async () => JPEG,
    sendRequest: (requestId) => {
      const error = errors.shift() ?? "too_large";
      listener.deliver({ t: "browser.capture.result", requestId, error });
    },
  });
  await listener.start();
  try {
    let tool: any;
    outfitterBrowser(
      { registerTool: (registered) => { tool = registered; } },
      { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    assert.equal((await tool.execute("a", {})).content[0].text, "permission_denied");
    assert.equal((await tool!.execute("b", {})).content[0].text, "tab_gone");
    assert.equal((await tool!.execute("c", {})).content[0].text, "too_large");
  } finally {
    await listener.stop();
  }
});
