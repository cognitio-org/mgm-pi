import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSnapshotUrl, snapshotHostAllowlist, isDevMode } from "../src/snapshot-url.js";

test("validateSnapshotUrl: accepts an https URL on an allowlisted host", () => {
  assert.doesNotThrow(() =>
    validateSnapshotUrl("https://storage.googleapis.com/bucket/snap.tar.gz", {
      allowlist: ["storage.googleapis.com"],
      devMode: false,
    }),
  );
});

test("validateSnapshotUrl: rejects an https URL on a non-allowlisted host (SSRF guard)", () => {
  assert.throws(() =>
    validateSnapshotUrl("http://169.254.169.254/computeMetadata/v1/", {
      allowlist: ["storage.googleapis.com"],
      devMode: false,
    }),
  );
});

test("validateSnapshotUrl: rejects a plain http:// URL even on an allowlisted host", () => {
  assert.throws(() =>
    validateSnapshotUrl("http://storage.googleapis.com/bucket/snap.tar.gz", {
      allowlist: ["storage.googleapis.com"],
      devMode: false,
    }),
  );
});

test("validateSnapshotUrl: rejects a file:// URL outside dev mode", () => {
  assert.throws(() => validateSnapshotUrl("file:///tmp/snap.tar.gz", { allowlist: [], devMode: false }));
});

test("validateSnapshotUrl: accepts a file:// URL in dev mode", () => {
  assert.doesNotThrow(() => validateSnapshotUrl("file:///tmp/snap.tar.gz", { allowlist: [], devMode: true }));
});

test("validateSnapshotUrl: accepts a plain local path in dev mode", () => {
  assert.doesNotThrow(() => validateSnapshotUrl("/tmp/snap.tar.gz", { allowlist: [], devMode: true }));
});

test("validateSnapshotUrl: rejects a plain local path outside dev mode", () => {
  assert.throws(() => validateSnapshotUrl("/tmp/snap.tar.gz", { allowlist: [], devMode: false }));
});

test("snapshotHostAllowlist: defaults to storage.googleapis.com", () => {
  assert.deepEqual(snapshotHostAllowlist({}), ["storage.googleapis.com"]);
});

test("snapshotHostAllowlist: parses a comma list from env", () => {
  assert.deepEqual(snapshotHostAllowlist({ SNAPSHOT_HOST_ALLOWLIST: "a.example, b.example" }), [
    "a.example",
    "b.example",
  ]);
});

test("isDevMode: only OUTFITTER_DEV=1 is dev mode", () => {
  assert.equal(isDevMode({ OUTFITTER_DEV: "1" }), true);
  assert.equal(isDevMode({ OUTFITTER_DEV: "0" }), false);
  assert.equal(isDevMode({}), false);
});
