/**
 * scripts/release.sh against a throwaway git repo (with a bare `origin`) and a fake `gh`: the next
 * version is worked out from the published releases (numerically, skipping pre-releases and junk
 * tags such as vX.Y.Z), the notes list only kernal/ commits, and every refusal happens before
 * anything is published. No network.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "scripts", "release.sh");

const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "release list")
    [[ -z "\${FAKE_GH_FAIL:-}" ]] || { echo "HTTP 401" >&2; exit 1; }
    printf '%s\\n' "\${FAKE_TAGS}" ;;
  "release create")
    { printf '%s\\n' "$*"; cat; } >"\${FAKE_GH_LOG}" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

let work = "";
let repo = "";
let bin = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
}

function commit(path: string, subject: string): string {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), `${subject}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

function run(env: Record<string, string> = {}, ...args: string[]) {
  const log = join(work, `gh-${Math.random().toString(36).slice(2)}.log`);
  const r = spawnSync("bash", [join(repo, "kernal", "scripts", "release.sh"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: work,
      FAKE_GH_LOG: log,
      FAKE_TAGS: "v0.3.9\nv0.3.15\nvX.Y.Z\nv0.4.0-rc.1\nv0.2.0",
      ...env,
    },
  });
  return { ...r, out: r.stdout + r.stderr, created: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("scripts/release.sh", () => {
  before(() => {
    work = mkdtempSync(join(tmpdir(), "kernal-release-"));
    const origin = join(work, "origin.git");
    repo = join(work, "repo");
    bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    git(work, "init", "-q", "--bare", origin);
    git(work, "init", "-q", repo);
    mkdirSync(join(repo, "kernal", "scripts"), { recursive: true });
    cpSync(source, join(repo, "kernal", "scripts", "release.sh"));
    commit("kernal/README.md", "kernal: first");
    git(repo, "tag", "v0.3.15");
    commit("kernal/.pi/x.ts", "kernal: a skill fix");
    commit("outfitter/y.ts", "outfitter: not in kernal");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main", "--tags");
  });

  test("DRY_RUN: the next patch after the highest vX.Y.Z, numerically; junk named; nothing published", () => {
    const r = run({ DRY_RUN: "1" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /== v0\.3\.16 \(after v0\.3\.15\)/, "v0.3.15 > v0.3.9, and the rc and vX.Y.Z are not the latest");
    assert.match(r.out, /releases whose tag isn't a version: vX\.Y\.Z/);
    assert.match(r.out, /gh release delete vX\.Y\.Z --repo cognitio-org\/mgm-pi --cleanup-tag --yes/);
    assert.doesNotMatch(r.out, /v0\.4\.0-rc\.1.*isn't a version/, "a pre-release is not junk");
    assert.match(r.out, /- kernal: a skill fix/);
    assert.doesNotMatch(r.out, /- outfitter: not in kernal/, "only kernal/ commits are listed in the notes");
    assert.match(r.out, /DRY_RUN: nothing published/);
    assert.equal(r.created, "");
  });

  test("minor, major and an explicit version", () => {
    assert.match(run({ DRY_RUN: "1" }, "minor").out, /== v0\.4\.0 /);
    assert.match(run({ DRY_RUN: "1" }, "major").out, /== v1\.0\.0 /);
    assert.match(run({ DRY_RUN: "1" }, "0.3.20").out, /== v0\.3\.20 /);
    assert.match(run({ DRY_RUN: "1" }, "v0.3.21").out, /== v0\.3\.21 /);
  });

  test("refuses an older or equal version, and a version that isn't one", () => {
    for (const v of ["0.3.10", "0.3.15", "X.Y.Z", "0.3", "patchy"]) {
      const r = run({ DRY_RUN: "1" }, v);
      assert.notEqual(r.status, 0, v);
      assert.equal(r.created, "", v);
    }
  });

  test("publishes with YES=1: the tag, origin/main's commit, the title and the notes", () => {
    const head = git(repo, "rev-parse", "origin/main");
    const r = run({ YES: "1" });
    assert.equal(r.status, 0, r.out);
    const [args, ...notes] = r.created.split("\n");
    assert.equal(args, `release create v0.3.16 --repo cognitio-org/mgm-pi --target ${head} --title kernal 0.3.16 --notes-file -`);
    assert.match(notes.join("\n"), /Changes since v0\.3\.15:\n- kernal: a skill fix/);
  });

  test("without a terminal and without YES=1, nothing is published", () => {
    const r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.out, /set YES=1/);
    assert.equal(r.created, "");
  });

  test("a failed release listing stops before guessing a version", () => {
    const r = run({ YES: "1", FAKE_GH_FAIL: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /couldn't list/);
    assert.equal(r.created, "");
  });

  test("nothing under kernal/ since the latest release: refused unless FORCE=1", () => {
    git(repo, "tag", "v0.3.16", "HEAD~1");
    git(repo, "push", "-q", "origin", "--tags");
    commit("outfitter/z.ts", "outfitter: still not kernal");
    git(repo, "push", "-q", "origin", "main");
    const tags = "v0.3.16\nv0.3.15";
    const r = run({ YES: "1", FAKE_TAGS: tags });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nothing under kernal\/ changed since v0\.3\.16/);
    assert.equal(r.created, "");
    assert.match(run({ DRY_RUN: "1", FORCE: "1", FAKE_TAGS: tags }).out, /== v0\.3\.17 /);
  });

  test("an existing tag for the next version is refused (a deleted release can leave its tag)", () => {
    git(repo, "tag", "v0.3.17");
    git(repo, "push", "-q", "origin", "--tags");
    const r = run({ DRY_RUN: "1", FORCE: "1", FAKE_TAGS: "v0.3.16" });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /tag v0\.3\.17 already exists/);
  });

  test("nothing in it needs more than macOS's bash 3.2", () => {
    const text = readFileSync(source, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(text, /\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)/, "no bash 4 case changes");
    assert.doesNotMatch(text, /\b(mapfile|readarray|declare -A|local -n)\b/, "no bash 4 builtins");
    for (const m of text.matchAll(/\{(\d*),?(\d+)\}/g)) assert.ok(Number(m[2]) <= 255, `regex count ${m[0]} over 255`);
  });
});
