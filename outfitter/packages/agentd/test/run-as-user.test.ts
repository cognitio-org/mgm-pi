import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRunAsUser, chownRecursive } from "../src/run-as-user.js";

test("resolveRunAsUser: returns undefined (no privilege to drop) when agentd is not root", async () => {
  const result = await resolveRunAsUser({ currentUid: 501, onLog: () => {} });
  assert.equal(result, undefined);
});

test("resolveRunAsUser: as root, resolves PI_RUN_AS_USER's uid/gid via the injected id runner", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const result = await resolveRunAsUser({
    currentUid: 0,
    targetUser: "agent",
    execFn: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "getent") return { stdout: "agent:x:1000:1000::/home/agent:/usr/sbin/nologin\n", code: 0 };
      if (args[0] === "-u") return { stdout: "1000\n", code: 0 };
      return { stdout: "1000\n", code: 0 };
    },
  });
  assert.deepEqual(result, { uid: 1000, gid: 1000, user: "agent", home: "/home/agent" });
  assert.ok(calls.some((c) => c.cmd === "getent" && c.args[1] === "agent"));
  assert.ok(calls.some((c) => c.cmd === "id" && c.args[0] === "-u" && c.args[1] === "agent"));
  assert.ok(calls.some((c) => c.cmd === "id" && c.args[0] === "-g" && c.args[1] === "agent"));
});

test("resolveRunAsUser: as root, throws if the target user can't be resolved", async () => {
  await assert.rejects(() =>
    resolveRunAsUser({
      currentUid: 0,
      targetUser: "no-such-user",
      execFn: async () => ({ stdout: "", code: 1 }),
    }),
  );
});

test("chownRecursive: runs `chown -R uid:gid path` and throws on non-zero exit", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  await chownRecursive("/workspace", 1000, 1000, async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: "", code: 0 };
  });
  assert.deepEqual(calls, [{ cmd: "chown", args: ["-R", "1000:1000", "/workspace"] }]);

  await assert.rejects(() => chownRecursive("/workspace", 1000, 1000, async () => ({ stdout: "", code: 1 })));
});
