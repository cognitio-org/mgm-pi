/**
 * Guards on scripts/install.sh. It is shell, so these are structural assertions on the parts that
 * have already gone wrong once: a bundle lives in a versioned directory, so anything user-owned
 * written inside it is stranded by the next upgrade. Sessions were lost that way, and
 * `--session <id>` only searches the current agent dir, so the history looked deleted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install.sh"), "utf8");

describe("install.sh", () => {
  test("user-owned state lives outside the versioned bundle and is linked in", () => {
    assert.match(script, /STATE="\$\{MGM_STATE:-\$HOME_DIR\/state\}"/, "one state directory, overridable");
    for (const name of ["sessions", "bug-reports"]) {
      assert.ok(script.includes(name), `${name} is handled`);
    }
    assert.match(script, /ln -sfn "\$STATE\/\$name" "\$HOME_DIR\/current\/\.pi\/\$name"/, "directories are symlinked into the bundle");
    assert.match(script, /ln -sf "\$STATE\/\$name" "\$HOME_DIR\/current\/\.pi\/\$name"/, "files too");
    for (const file of ["auth.json", "trust.json", "models-store.json", "mcp-cache.json"]) {
      assert.ok(script.includes(file), `${file} is carried over rather than lost`);
    }
  });

  test("existing state is gathered from older bundles, and never overwritten", () => {
    assert.match(script, /for old_dir in "\$HOME_DIR"\/mgm-\*-"\$platform"/, "older bundles are searched");
    assert.match(script, /\[\[ ! -f "\$target\/\$\(basename "\$f"\)" \]\]/, "a session already in state is left alone");
    assert.match(script, /! -L "\$old_dir\/\.pi\/sessions"/, "an already-linked bundle is not copied from itself");
  });

  test("the user's .env still survives an upgrade", () => {
    assert.match(script, /keep_env=\$\(cat "\$HOME_DIR\/current\/\.env"\)/);
    assert.match(script, /grep -q "\^\$k=\." "\$HOME_DIR\/current\/\.env"/, "shipped keys are added, never replacing yours");
  });

  test("bash 3.2 safety: every array expansion carries the guard macOS needs", () => {
    // macOS ships bash 3.2, where an empty array is "unbound" under set -u. This broke a real
    // install: `auth[@]: unbound variable` on the first download.
    const uses = script.split("\n").filter((l) => l.includes("auth[@]") && !l.trim().startsWith("#"));
    assert.ok(uses.length >= 3, "the array is still used");
    for (const line of uses) {
      assert.ok(line.includes('${auth[@]+"${auth[@]}"}'), `unguarded expansion: ${line.trim().slice(0, 70)}`);
    }
  });
});
