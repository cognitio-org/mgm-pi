import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { originAllowed, parsePageMessage, pageReply, isSessionUrl, isDongle, linkOrigin } from "../extension/protocol.js";

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

const session = "550e8400-e29b-41d4-a716-446655440000";
const other = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function place(overrides = {}) {
  return {
    t: "place",
    sessionId: session,
    url: `https://app.kernal.one/sessions/${session}`,
    title: "Floppy",
    mode: "own",
    ...overrides,
  };
}

test("the page allowlist is ping, place, split, poll, and openPanel", () => {
  assert.deepEqual(parsePageMessage({ t: "ping" }), { ok: true, t: "ping" });
  assert.deepEqual(parsePageMessage({ t: "poll" }), { ok: true, t: "poll" });
  assert.deepEqual(parsePageMessage({ t: "openPanel" }), { ok: true, t: "openPanel" });
  assert.deepEqual(parsePageMessage(place()), {
    ok: true,
    t: "place",
    sessionId: session,
    href: `https://app.kernal.one/sessions/${session}`,
    title: "Floppy",
    mode: "own",
  });
  for (const mode of ["shared", "window"]) {
    assert.equal(parsePageMessage(place({ mode })).mode, mode);
  }
  assert.deepEqual(parsePageMessage({ t: "split", sessionId: session, otherSessionId: other }), {
    ok: true,
    t: "split",
    sessionId: session,
    otherSessionId: other,
  });
  // A title may contain the word tab. That is not a tab id, and it is not walked.
  assert.equal(parsePageMessage(place({ title: "see the tab" })).title, "see the tab");
  assert.equal(parsePageMessage(place({ url: `http://localhost:5173/sessions/${session}` })).ok, true);
  assert.equal(parsePageMessage(place({ url: `http://127.0.0.1:8080/sessions/${session}` })).ok, true);
});

test("closeTab, capture, a tabId field, and anything outside the allowlist are rejected", () => {
  const rejected = [
    { t: "closeTab", tabId: 4 },
    { t: "capture", tabId: 4 },
    { t: "ping", tabId: 4 },
    { t: "poll", tabId: 4 },
    { t: "openPanel", tabId: 1 },
    place({ tabId: 4 }),
    { t: "split", sessionId: session, otherSessionId: other, tabId: 9 },
    { t: "ping", tab: { id: 4 } },
    { tabId: 4 },
    { t: "place", sessionId: session, url: `https://app.kernal.one/sessions/${session}`, title: "F", mode: "nope" },
    { t: "place", sessionId: session, url: "https://evil.com/sessions/" + session, title: "F", mode: "own" },
    { t: "place", sessionId: session, url: `https://app.kernal.one/sessions/${session}/extra`, title: "F", mode: "own" },
    { t: "place", sessionId: "../x", url: "https://app.kernal.one/sessions/../x", title: "F", mode: "own" },
    { t: "split", sessionId: session, otherSessionId: session },
    { t: "split", sessionId: session },
    { t: "poll", sessionId: session },
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
    assert.equal(JSON.stringify(parsed).includes("tabId"), false);
  }
});

test("a session url is the allowlisted origin plus /sessions/<id>", () => {
  assert.equal(isSessionUrl(session, `https://app.kernal.one/sessions/${session}`), true);
  assert.equal(isSessionUrl(session, `https://app.kernal.one/sessions/${session}?x=1`), false);
  assert.equal(isSessionUrl(session, `https://not-kernal.one/sessions/${session}`), false);
});

test("a ping reply is ok, version, and id, and a rejection echoes nothing", () => {
  const id = "iodmmlkefenhggpbpcmhkajencapmcee";
  assert.deepEqual(pageReply({ t: "ping" }, "0.1.0", id), { ok: true, version: "0.1.0", id });
  // poll is accepted by the allowlist; the ping helper does not turn it into a ping reply.
  assert.equal(pageReply({ t: "poll" }, "0.1.0", id), null);
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
  assert.deepEqual(manifest.permissions, [
    "storage",
    "tabs",
    "tabGroups",
    "notifications",
    "contextMenus",
    "alarms",
    "nativeMessaging",
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
  assert.equal(JSON.stringify(manifest).includes("debugger"), false);
});

test("the service worker does not consult sender.url", () => {
  const source = read("../extension/background.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /sender\.url/);
  assert.doesNotMatch(source, /\.url\b/);
  assert.match(source, /originAllowed\(port\.sender\?\.origin\)/);
  assert.match(source, /originAllowed\(sender\?\.origin\)/);
  assert.doesNotMatch(source, /senderOrigin/);
  // Split checks createSplit before it can open anything, and it never opens an OS window.
  const splitAt = source.indexOf("async function performSplit");
  const openAt = source.indexOf("async function performOpenPanel");
  assert.ok(splitAt !== -1 && openAt > splitAt);
  const splitFn = source.slice(splitAt, openAt);
  assert.match(splitFn, /splitPlan\(/);
  assert.doesNotMatch(splitFn, /windows\.create/);
  assert.equal(source.includes("tabs.remove"), false);
});

test("the web package hardcodes chrome/extension-id", () => {
  const id = read("../extension-id").trim();
  const web = read("../../outfitter/packages/web/src/lib/chrome-companion.ts");
  assert.match(web, new RegExp(`CHROME_EXTENSION_ID = "${id}"`));
});

test("the options page does not log or copy a saved Dongle into the page", () => {
  const source = read("../extension/options.js");
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(source, /tokenInput\.value\s*=\s*[^"'\s]/);
});

test("a Dongle is outf_ plus 43 base64url characters", () => {
  const body = "0123456789abcdefghijklmnopqrstuvwxyzABCDE-_";
  assert.equal(body.length, 43);
  assert.equal(isDongle(`outf_${body}`), true);
  assert.equal(isDongle("outf_short"), false);
  assert.equal(isDongle(`outf_${"a".repeat(42)}`), false);
  assert.equal(isDongle(`token_${body}`), false);
  assert.equal(isDongle(body), false);
});

test("linkOrigin returns the origin of an http(s) URL with no userinfo", () => {
  assert.equal(linkOrigin("https://link.example.com/ignored"), "https://link.example.com");
  assert.equal(linkOrigin("http://localhost:5173/path"), "http://localhost:5173");
  assert.equal(linkOrigin("ftp://example.com"), null);
  assert.equal(linkOrigin("http://user:pass@localhost"), null);
});
