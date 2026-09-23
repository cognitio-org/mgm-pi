import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { originAllowed, parsePageMessage, pageReply } from "../extension/protocol.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the three allowlisted origins pass", () => {
  for (const origin of ["https://app.kernal.one", "http://localhost", "http://127.0.0.1"]) {
    assert.equal(originAllowed(origin), true, origin);
  }
  // Match patterns name no port, so a dev server on those hosts is the same site.
  assert.equal(originAllowed("http://localhost:5173"), true);
  assert.equal(originAllowed("http://127.0.0.1:8080"), true);
  assert.equal(originAllowed("https://app.kernal.one:8443"), true);
});

test("a lookalike origin fails", () => {
  const lookalikes = [
    "https://app.kernal.one.evil.com",
    "https://evil.app.kernal.one",
    "https://app.kernal.one.attacker.com",
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://app.kernal.one",
    "https://localhost",
    "https://127.0.0.1",
    "http://127.0.0.2",
    "https://not-kernal.one",
    "http://localhost.",
    "https://app.kernal.one/sessions/1",
    "http://localhost/sessions/1",
    "http://user:pass@localhost",
    "https://app.kernal.one/",
    "HTTP://localhost",
  ];
  for (const origin of lookalikes) assert.equal(originAllowed(origin), false, origin);
});

test("a missing origin fails", () => {
  assert.equal(originAllowed(undefined), false);
  assert.equal(originAllowed(null), false);
  assert.equal(originAllowed(""), false);
  assert.equal(originAllowed(0), false);
});

test("only a plain object whose single key is t: ping is accepted", () => {
  assert.deepEqual(parsePageMessage({ t: "ping" }), { ok: true, t: "ping" });
  const rejected = [
    { t: "place", sessionId: "s", url: "https://app.kernal.one/sessions/s", title: "F", mode: "own" },
    { t: "split", sessionId: "a", otherSessionId: "b" },
    { t: "poll" },
    { t: "openPanel" },
    { t: "closeTab", tabId: 4 },
    { t: "capture", tabId: 4 },
    { t: "ping", tabId: 4 },
    { t: "ping", tab: { id: 4 } },
    { tabId: 4 },
    null,
    "ping",
    ["ping"],
    {},
    { t: "ping", extra: true },
  ];
  for (const message of rejected) {
    const parsed = parsePageMessage(message);
    assert.equal(parsed.ok, false, JSON.stringify(message));
    assert.equal(parsed.error, "rejected");
  }
});

test("a ping reply is ok, version, and id, and a rejection echoes nothing", () => {
  const id = "iodmmlkefenhggpbpcmhkajencapmcee";
  assert.deepEqual(pageReply({ t: "ping" }, "0.1.0", id), { ok: true, version: "0.1.0", id });
  const rejected = pageReply({ t: "capture", tabId: 9, token: "outf_secret" }, "0.1.0", id);
  assert.deepEqual(rejected, { ok: false, error: "rejected" });
  assert.equal(JSON.stringify(rejected).includes("9"), false);
  assert.equal(JSON.stringify(rejected).includes("outf_"), false);
});

test("the manifest key is the pinned extension id", () => {
  const manifest = JSON.parse(read("../extension/manifest.json"));
  const idFile = read("../extension-id");
  const der = Buffer.from(manifest.key, "base64");
  const hex = createHash("sha256").update(der).digest().subarray(0, 16).toString("hex");
  const id = [...hex].map((nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16))).join("");
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(idFile, `${id}\n`);
  assert.deepEqual(manifest.externally_connectable.matches, [
    "https://app.kernal.one/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ]);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
  assert.equal(JSON.stringify(manifest).includes("nativeMessaging"), false);
  assert.equal(JSON.stringify(manifest).includes("debugger"), false);
});

test("the service worker does not consult sender.url", () => {
  const source = read("../extension/background.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /sender\.url/);
  assert.doesNotMatch(source, /\.url\b/);
  assert.match(source, /originAllowed\(port\.sender\?\.origin\)/);
  assert.match(source, /originAllowed\(sender\?\.origin\)/);
  assert.doesNotMatch(source, /senderOrigin/);
});

test("the options page does not log or copy a saved Dongle into the page", () => {
  const source = read("../extension/options.js");
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(source, /tokenInput\.value\s*=\s*[^"'\s]/);
});
