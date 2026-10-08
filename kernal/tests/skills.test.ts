// Kernal's own skills (#290): kernal/skills ships in the bundle and the image, and settings.json
// loads it from ../skills (relative to .pi). pi's own loader must accept every SKILL.md there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSkillsFromDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";

const root = new URL("..", import.meta.url).pathname;

test("settings.json loads kernal/skills", () => {
  const settings = JSON.parse(readFileSync(`${root}.pi/settings.json`, "utf8"));
  assert.ok(settings.skills?.includes("../skills"));
});

test("every skill loads with pi's own loader, with a short description", () => {
  const result = loadSkillsFromDir({ dir: `${root}skills`, source: "settings" } as never) as { skills: Array<{ name: string; description: string }>; diagnostics: unknown[] };
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.skills.some((s) => s.name === "outfitter-admin"));
  for (const s of result.skills) assert.ok(s.description.length <= 300, `${s.name}: ${s.description.length} chars is paid on every turn`);
});

test("GA-3 (#493): the gcloud skill carries the server's usage rules", () => {
  const text = readFileSync(`${root}skills/gcloud-mcp/SKILL.md`, "utf8");
  for (const rule of ["`=` in flags", "--async", "--limit", "project explicitly", "iam service-accounts", "billing", "alpha", "/mcp-auth google_cloud", "run_gcloud_command", "cloudrun-", "Secret Manager"]) {
    assert.ok(text.includes(rule), `missing: ${rule}`);
  }
});

test("GB-4 (#540): mcp.json routes the google_cloud toolset through the router like sentry, lazily, replacing gcloud", () => {
  const { mcpServers } = JSON.parse(readFileSync(`${root}.pi/mcp.json`, "utf8"));
  const { sentry, google_cloud: gcloud } = mcpServers;
  assert.equal(mcpServers.gcloud.url, "https://router.kernal.one/gcloud/mcp", "gcloud stays as the fallback until the toolset is delivered");
  assert.equal(mcpServers.gcloud.disabled, true);
  assert.equal(mcpServers.gcloud.approveTools, true);
  assert.equal(gcloud.disabled, true);
  assert.equal(gcloud.approveTools, true);
  assert.equal(gcloud.url, "https://router.kernal.one/google_cloud/mcp");
  assert.equal(gcloud.auth, "oauth");
  assert.deepEqual(gcloud.headers, sentry.headers);
  assert.equal(gcloud.lifecycle, "lazy", "non-operators never connect at start-up; the router hides the server from them");
});

test("the release bundle and the image copy kernal/skills", () => {
  assert.match(readFileSync(`${root}scripts/package.sh`, "utf8"), /cp -R "\$ROOT\/skills" "\$STAGE\/skills"/);
  assert.match(readFileSync(`${root}../outfitter/image/Dockerfile`, "utf8"), /COPY kernal\/skills\/ \.\/skills\//);
});
