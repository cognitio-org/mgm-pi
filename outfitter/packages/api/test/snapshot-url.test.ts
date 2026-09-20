import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSnapshotUrl, snapshotHostAllowlist, isDevMode } from "../src/snapshot-url.ts";

test("validateSnapshotUrl: accepts an https URL on an allowlisted host", () => {
  assert.doesNotThrow(() =>
    validateSnapshotUrl("https://storage.googleapis.com/bucket/snap.tar.gz", {
      allowlist: ["storage.googleapis.com"],
      devMode: false,
    }),
  );
});

test("validateSnapshotUrl: rejects the GCE metadata server (SSRF guard)", () => {
  assert.throws(() =>
    validateSnapshotUrl("http://169.254.169.254/computeMetadata/v1/", {
      allowlist: ["storage.googleapis.com"],
      devMode: false,
    }),
  );
});

test("validateSnapshotUrl: rejects an https URL on a non-allowlisted host", () => {
  assert.throws(() =>
    validateSnapshotUrl("https://evil.example/snap.tar.gz", { allowlist: ["storage.googleapis.com"], devMode: false }),
  );
});

test("validateSnapshotUrl: rejects a file:// URL outside dev mode", () => {
  assert.throws(() => validateSnapshotUrl("file:///tmp/snap.tar.gz", { allowlist: [], devMode: false }));
});

test("validateSnapshotUrl: accepts a file:// URL in dev mode", () => {
  assert.doesNotThrow(() => validateSnapshotUrl("file:///tmp/snap.tar.gz", { allowlist: [], devMode: true }));
});

test("snapshotHostAllowlist: defaults to storage.googleapis.com", () => {
  assert.deepEqual(snapshotHostAllowlist({}), ["storage.googleapis.com"]);
});

test("isDevMode: only OUTFITTER_DEV=1 is dev mode", () => {
  assert.equal(isDevMode({ OUTFITTER_DEV: "1" }), true);
  assert.equal(isDevMode({}), false);
});
