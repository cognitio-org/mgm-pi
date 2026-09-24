/**
 * Local browser_tabs and browser_capture. The socket tests use a temp directory, never ~/.kernal.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserCapture,
  browserTabs,
  chromeSocketPath,
  formatCapture,
  formatShareList,
  NOT_RUNNING,
  NOT_SHARED,
  parseTabId,
} from "../.pi/extensions/kernal-chrome/lib.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function temp(): string {
  return mkdtempSync(join(tmpdir(), "kernal-chrome-tool-"));
}

function listen(path: string, onLine: (line: string, socket: Socket) => void): Promise<Server> {
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line.trim()) onLine(line, socket);
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

describe("chrome socket path", () => {
  const readMissing = () => { throw new Error("ENOENT"); };

  test("the install record wins, otherwise the socket is <home>/chrome.sock", () => {
    const home = "/home/person";
    assert.equal(chromeSocketPath({ env: {}, home, readFile: readMissing }), join(home, ".kernal", "chrome.sock"));
    assert.equal(
      chromeSocketPath({ env: { KERNAL_HOME: "/opt/kernal" }, home, readFile: readMissing }),
      "/opt/kernal/chrome.sock",
    );
    assert.equal(
      chromeSocketPath({ env: { MGM_HOME: join(home, ".mgm") }, home, readFile: readMissing }),
      join(home, ".kernal", "chrome.sock"),
    );
    assert.equal(
      chromeSocketPath({ env: { MGM_HOME: "/custom/mgm" }, home, readFile: readMissing }),
      "/custom/mgm/chrome.sock",
    );
    const record = (file: string) => {
      assert.equal(file, "/opt/kernal/chrome/host/socket-path");
      return "/opt/kernal/chrome.sock\n";
    };
    assert.equal(chromeSocketPath({ env: { KERNAL_HOME: "/opt/kernal" }, home, readFile: record }), "/opt/kernal/chrome.sock");
    assert.equal(
      chromeSocketPath({ env: { KERNAL_HOME: "/opt/kernal" }, home, readFile: () => "relative/chrome.sock" }),
      "/opt/kernal/chrome.sock",
    );
  });

  test("tab ids are non-negative integers, and the text names the fields", () => {
    assert.equal(parseTabId(4), 4);
    assert.equal(parseTabId("4"), 4);
    assert.equal(parseTabId(-1), null);
    assert.equal(parseTabId("4abc"), null);
    assert.equal(formatShareList([]), "No tabs are shared.");
    assert.match(formatShareList([{ tabId: 4, title: "Spec", url: "https://example.com", sessionId: "s" }]), /tabId: 4/);
    assert.equal(formatCapture({ title: "Spec", url: "https://example.com", path: "chrome-captures/4.jpg" }), "title: Spec\nurl: https://example.com\npath: chrome-captures/4.jpg");
  });
});

describe("browser tools over the socket", () => {
  test("a missing socket says the companion is not running and does not throw", async () => {
    const dir = temp();
    const env = { KERNAL_HOME: dir };
    try {
      const listed = await browserTabs({ env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(listed.isError, true);
      assert.equal(listed.text, NOT_RUNNING);
      const captured = await browserCapture(4, dir, { env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(captured.isError, true);
      assert.equal(captured.text, NOT_RUNNING);
      assert.equal(captured.image, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown tab says it is not shared, and a capture copies the jpeg", async () => {
    const dir = temp();
    const cwd = join(dir, "workspace");
    mkdirSync(cwd);
    const sock = join(dir, "chrome.sock");
    const jpeg = join(dir, "4.jpg");
    writeFileSync(jpeg, JPEG);
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "nope");
    const link = join(dir, "9.jpg");
    symlinkSync(secret, link);
    const env = { KERNAL_HOME: dir };
    const server = await listen(sock, (line, socket) => {
      const msg = JSON.parse(line) as { t: string; tabId?: number };
      if (msg.t === "list") {
        socket.write(`${JSON.stringify({ t: "share", tabId: 1, title: "noise", url: "https://n", sessionId: "n" })}\n`);
        socket.write(`${JSON.stringify({ t: "shares", shares: [{ tabId: 4, title: "Spec", url: "https://example.com/a", sessionId: "floppy" }] })}\n`);
        return;
      }
      if (msg.t === "capture" && msg.tabId === 4) {
        socket.write(`${JSON.stringify({ t: "captured", tabId: 4, title: "Spec", url: "https://example.com/a", path: jpeg })}\n`);
        return;
      }
      if (msg.t === "capture" && msg.tabId === 9) {
        socket.write(`${JSON.stringify({ t: "captured", tabId: 9, title: "x", url: "https://x", path: link })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ t: "error", error: "tab is not shared" })}\n`);
    });
    try {
      const listed = await browserTabs({ env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(listed.isError, false);
      assert.match(listed.text, /tabId: 4/);
      assert.match(listed.text, /https:\/\/example.com\/a/);
      assert.doesNotMatch(listed.text, /noise/);

      const missing = await browserCapture(3, cwd, { env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(missing.text, NOT_SHARED);
      assert.equal(missing.isError, true);

      const badId = await browserCapture("nope", cwd, { env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(badId.text, NOT_SHARED);

      const shot = await browserCapture(4, cwd, { env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(shot.isError, false);
      assert.match(shot.text, /^title: Spec\nurl: https:\/\/example.com\/a\npath: chrome-captures\/4\.jpg$/);
      const copied = join(cwd, "chrome-captures", "4.jpg");
      assert.deepEqual(readFileSync(copied), JPEG);
      assert.equal(lstatSync(copied).mode & 0o777, 0o600);
      assert.ok(shot.image);
      assert.deepEqual(shot.image, JPEG);

      const linked = await browserCapture(9, cwd, { env, readFile: () => { throw new Error("ENOENT"); } });
      assert.equal(linked.isError, true);
      assert.equal(linked.image, undefined);
      assert.equal(readFileSync(secret, "utf8"), "nope");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a symlink destination is refused and the link target is not written", async () => {
    const dir = temp();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const target = join(outside, "4.jpg");
    writeFileSync(target, "do-not-touch");
    const jpeg = join(dir, "4.jpg");
    writeFileSync(jpeg, JPEG);
    const env = { KERNAL_HOME: dir };
    const server = await listen(join(dir, "chrome.sock"), (line, socket) => {
      const msg = JSON.parse(line) as { t: string; tabId?: number };
      if (msg.t !== "capture" || msg.tabId !== 4) return;
      socket.write(`${JSON.stringify({ t: "captured", tabId: 4, title: "Spec", url: "https://example.com/a", path: jpeg })}\n`);
    });
    const opts = { env, readFile: () => { throw new Error("ENOENT"); } };
    try {
      const cwdDir = join(dir, "dir-link");
      mkdirSync(cwdDir);
      const dirLink = join(cwdDir, "chrome-captures");
      symlinkSync(outside, dirLink);
      const viaDir = await browserCapture(4, cwdDir, opts);
      assert.equal(viaDir.isError, true);
      assert.equal(viaDir.image, undefined);
      assert.equal(viaDir.text, "The Chrome companion did not return a capture file.");
      assert.equal(lstatSync(dirLink).isSymbolicLink(), true);
      assert.equal(readFileSync(target, "utf8"), "do-not-touch");

      const cwdFile = join(dir, "file-link");
      mkdirSync(join(cwdFile, "chrome-captures"), { recursive: true });
      const fileLink = join(cwdFile, "chrome-captures", "4.jpg");
      symlinkSync(target, fileLink);
      const viaFile = await browserCapture(4, cwdFile, opts);
      assert.equal(viaFile.isError, true);
      assert.equal(viaFile.image, undefined);
      assert.equal(viaFile.text, "The Chrome companion did not return a capture file.");
      assert.equal(lstatSync(fileLink).isSymbolicLink(), true);
      assert.equal(readFileSync(target, "utf8"), "do-not-touch");

      const cwdOk = join(dir, "real");
      const realDir = join(cwdOk, "chrome-captures");
      mkdirSync(realDir, { recursive: true });
      const real = join(realDir, "4.jpg");
      writeFileSync(real, Buffer.from("old"), { mode: 0o644 });
      const replaced = await browserCapture(4, cwdOk, opts);
      assert.equal(replaced.isError, false);
      assert.deepEqual(readFileSync(real), JPEG);
      assert.equal(lstatSync(real).isSymbolicLink(), false);
      assert.equal(lstatSync(real).mode & 0o777, 0o600);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the tool definition itself", () => {
  test("registers browser_tabs and browser_capture, and a missing socket does not throw", async () => {
    const tools: any[] = [];
    const mod = await import("../.pi/extensions/kernal-chrome/index.ts");
    mod.default({ registerTool: (tool: any) => { tools.push(tool); } } as any);
    assert.deepEqual(tools.map((tool) => tool.name), ["browser_tabs", "browser_capture", "browser_action"]);
    for (const tool of tools) {
      assert.equal(typeof tool.execute, "function");
      assert.ok(tool.description.length > 20);
      for (const line of tool.promptGuidelines) assert.match(line, /browser_/);
    }
    const src = readFileSync(new URL("../.pi/extensions/kernal-chrome/lib.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(|from "node:http"|http\.request/);

    const dir = temp();
    const previous = process.env.KERNAL_HOME;
    process.env.KERNAL_HOME = dir;
    try {
      const listed = await tools[0].execute("1", {}, undefined, undefined, { cwd: dir });
      assert.equal(listed.isError, true);
      assert.equal(listed.content[0].text, NOT_RUNNING);
      assert.equal(listed.content.length, 1);
      const captured = await tools[1].execute("2", { tabId: 4 }, undefined, undefined, { cwd: dir });
      assert.equal(captured.isError, true);
      assert.equal(captured.content[0].text, NOT_RUNNING);
      const acted = await tools.find((tool) => tool.name === "browser_action").execute("3", { tabId: 4, kind: "click", selector: "#go" });
      assert.equal(acted.isError, true);
      assert.equal(acted.content[0].text, NOT_RUNNING);
      assert.equal(captured.content.some((block: { type: string }) => block.type === "image"), false);
    } finally {
      if (previous === undefined) delete process.env.KERNAL_HOME;
      else process.env.KERNAL_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("browser_capture attaches the jpeg when the host returns one", async () => {
    const dir = temp();
    const cwd = join(dir, "workspace");
    mkdirSync(cwd);
    const jpeg = join(dir, "4.jpg");
    writeFileSync(jpeg, JPEG);
    chmodSync(jpeg, 0o600);
    const server = await listen(join(dir, "chrome.sock"), (line, socket) => {
      const msg = JSON.parse(line) as { t: string };
      if (msg.t === "capture") {
        socket.write(`${JSON.stringify({ t: "captured", tabId: 4, title: "Spec", url: "https://example.com/a", path: jpeg })}\n`);
      }
    });
    const tools: any[] = [];
    const mod = await import("../.pi/extensions/kernal-chrome/index.ts");
    mod.default({ registerTool: (tool: any) => { tools.push(tool); } } as any);
    const previous = process.env.KERNAL_HOME;
    process.env.KERNAL_HOME = dir;
    try {
      const captured = await tools.find((tool) => tool.name === "browser_capture").execute("1", { tabId: 4 }, undefined, undefined, { cwd });
      assert.equal(captured.isError, false);
      assert.match(captured.content[0].text, /path: chrome-captures\/4\.jpg/);
      const image = captured.content.find((block: { type: string }) => block.type === "image");
      assert.equal(image.mimeType, "image/jpeg");
      assert.equal(image.type, "image");
      assert.deepEqual(Buffer.from(image.data, "base64"), JPEG);
      await new Promise((resolve) => server.close(() => resolve(undefined)));

      const action = tools.find((tool) => tool.name === "browser_action");
      let asked: { t?: string; tabId?: number; kind?: string; selector?: string; text?: string } | undefined;
      const actionServer = await listen(join(dir, "chrome.sock"), (line, socket) => {
        const msg = JSON.parse(line) as { t: string; tabId?: number };
        asked = msg;
        if (msg.t === "action" && msg.tabId === 9) socket.write(`${JSON.stringify({ t: "error", error: "tab is not shared" })}\n`);
        else if (msg.t === "action") socket.write(`${JSON.stringify({ t: "error", error: "denied" })}\n`);
      });
      try {
        const unknown = await action.execute("2", { tabId: 9, kind: "click", selector: "#go" }, undefined, undefined, { cwd });
        assert.equal(unknown.isError, true);
        assert.equal(unknown.content[0].text, NOT_SHARED);
        assert.equal(asked?.tabId, 9);
        const denied = await action.execute("3", { tabId: 4, kind: "click", selector: "#go" }, undefined, undefined, { cwd });
        assert.equal(denied.isError, true);
        assert.equal(denied.content[0].text, "denied");
        const bad = await action.execute("4", { tabId: 4, kind: "click", selector: "javascript:alert(1)" });
        assert.equal(bad.content[0].text, "rejected");
      } finally {
        actionServer.close();
      }
    } finally {
      if (previous === undefined) delete process.env.KERNAL_HOME;
      else process.env.KERNAL_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
