// GA-2 (#492): the router's gcloud MCP server is admitted to operators' keys only, through
// object_permission.mcp_servers on /key/generate. LiteLLM is the fake management API; nothing here
// reaches a router.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_MCP_SERVERS,
  GATED_MCP_SERVERS,
  GCLOUD_MCP_SERVER,
  deliveredMcpServers,
  deviceKeyMcpServers,
  deviceKeyMcpToolsets,
  mcpEnableList,
  runKeyMcpToolsets,
  gcloudRun,
  mcpEnableFor,
  reconcileOperatorKeys,
  runKeyMcpServers,
} from "../src/central/gcloud-mcp.ts";
import { createLitellmKeys, mintDeviceRouterKey, routerKeyLimits } from "../src/central/litellm-keys.ts";
import { RunKeys } from "../src/central/run-keys.ts";
import { defaultFleetSettings } from "../src/fleet-settings.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { FakeLitellm } from "./fake-litellm.ts";

const CONFIG = { litellmBaseUrl: "https://router.test/v1", litellmAdminKey: "sk-admin-test" };
const OPERATORS = ["Sysop@Example.com"];
const OPERATOR = "sysop@example.com";
const PERSON = "person@example.com";
const WITH_GCLOUD = [...BASE_MCP_SERVERS, GCLOUD_MCP_SERVER];

function device(ownerEmail: string) {
  return { id: "dev_aaaabbbbccccdddd", userId: "u_0123456789abcdef01234567", ownerEmail, name: "mbp" };
}

describe("gcloud-mcp helpers", () => {
  test("a device key lists gcloud for an operator only, matched case-insensitively", () => {
    assert.deepEqual(deviceKeyMcpServers(OPERATOR, OPERATORS), WITH_GCLOUD);
    assert.equal(deviceKeyMcpServers(PERSON, OPERATORS), undefined);
    assert.equal(deviceKeyMcpServers(OPERATOR, []), undefined);
    assert.equal(deviceKeyMcpServers(OPERATOR, undefined), undefined);
  });

  test("a run needs the operator tape AND an operator owner, and never an A2A session", () => {
    assert.equal(gcloudRun({ adminTools: "operator" }, OPERATOR, OPERATORS, false), true);
    assert.equal(gcloudRun({ adminTools: "manage" }, OPERATOR, OPERATORS, false), false);
    assert.equal(gcloudRun({}, OPERATOR, OPERATORS, false), false);
    assert.equal(gcloudRun({ adminTools: "operator" }, PERSON, OPERATORS, false), false);
    assert.equal(gcloudRun({ adminTools: "operator" }, undefined, OPERATORS, false), false);
    assert.equal(gcloudRun({ adminTools: "operator" }, OPERATOR, OPERATORS, true), false);
    assert.equal(gcloudRun(null, OPERATOR, OPERATORS, false), false);
    assert.deepEqual(runKeyMcpServers(true), WITH_GCLOUD);
    assert.equal(runKeyMcpServers(false), undefined);
  });
});

describe("device keys", () => {
  async function mint(email: string) {
    const fake = new FakeLitellm();
    const keys = createLitellmKeys(CONFIG, new MemoryStore(), { fetch: fake.fetch })!;
    await mintDeviceRouterKey(keys, device(email), { litellmBaseUrl: CONFIG.litellmBaseUrl, operators: OPERATORS }, routerKeyLimits(defaultFleetSettings()).device);
    return fake.callsTo("/key/generate")[0]!.body;
  }

  test("an operator's key is admitted to gcloud and keeps the servers every key uses", async () => {
    const body = await mint(OPERATOR);
    assert.deepEqual(body.object_permission, { mcp_servers: WITH_GCLOUD });
  });

  test("a non-operator's key carries no MCP list at all, as before", async () => {
    const body = await mint(PERSON);
    assert.ok(!("object_permission" in body));
    assert.ok(!JSON.stringify(body).includes(GCLOUD_MCP_SERVER));
  });
});

describe("run keys", () => {
  async function mint(gcloud: boolean | undefined) {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    const runKeys = new RunKeys({ keys, store, config: { runKeyFallback: false }, limits: async () => routerKeyLimits(defaultFleetSettings()) });
    await runKeys.keyForRun({
      run: { id: "r1", state: "provisioning" },
      session: { id: "s1", ownerEmail: OPERATOR },
      specSent: "no",
      sharedKey: "sk-shared",
      a2a: false,
      ...(gcloud === undefined ? {} : { gcloud }),
    });
    return fake.callsTo("/key/generate")[0]!.body;
  }

  test("a gcloud run's key is admitted to gcloud", async () => {
    assert.deepEqual((await mint(true)).object_permission, { mcp_servers: WITH_GCLOUD });
  });

  test("any other run's key carries no MCP list", async () => {
    for (const flag of [false, undefined]) assert.ok(!("object_permission" in (await mint(flag))));
  });
});

describe("GB-3 google_cloud toolset", () => {
  const TOOLSET = "0b9f6c2e-1111-4222-8333-444455556666";
  const ENTRY = "google_cloud";
  const OP_CONFIG = { litellmBaseUrl: CONFIG.litellmBaseUrl, operators: OPERATORS, googleCloudToolsetId: TOOLSET };

  test("helpers: toolset only for operators and gcloud runs, only when configured", () => {
    assert.deepEqual(deviceKeyMcpToolsets(OPERATOR, OPERATORS, TOOLSET), [TOOLSET]);
    assert.equal(deviceKeyMcpToolsets(PERSON, OPERATORS, TOOLSET), undefined);
    assert.equal(deviceKeyMcpToolsets(OPERATOR, OPERATORS, ""), undefined);
    assert.equal(deviceKeyMcpToolsets(OPERATOR, OPERATORS, undefined), undefined);
    assert.deepEqual(runKeyMcpToolsets(true, ` ${TOOLSET} `), [TOOLSET]);
    assert.equal(runKeyMcpToolsets(false, TOOLSET), undefined);
    assert.deepEqual(mcpEnableList([TOOLSET]), [ENTRY]);
    assert.deepEqual(mcpEnableList(undefined), [GCLOUD_MCP_SERVER], "no toolset: the legacy entry name");
    assert.deepEqual(deliveredMcpServers(WITH_GCLOUD, [TOOLSET]), [...WITH_GCLOUD, ENTRY]);
    assert.deepEqual(deliveredMcpServers(WITH_GCLOUD, undefined), WITH_GCLOUD);
    assert.ok(GATED_MCP_SERVERS.includes(ENTRY));
  });

  test("an operator device key lists the toolset next to the servers; the delivery names google_cloud; the record stores the grant", async () => {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    const delivered = await mintDeviceRouterKey(keys, device(OPERATOR), OP_CONFIG, routerKeyLimits(defaultFleetSettings()).device);
    assert.deepEqual(fake.callsTo("/key/generate")[0]!.body.object_permission, { mcp_servers: WITH_GCLOUD, mcp_toolsets: [TOOLSET] });
    assert.deepEqual(delivered.mcpServers, [...WITH_GCLOUD, ENTRY]);
    const record = await store.routerKeys.findByAlias("kernal-device-dev_aaaabbbbccccdddd");
    assert.deepEqual(record?.mcpServers, WITH_GCLOUD);
    assert.deepEqual(record?.mcpToolsets, [TOOLSET]);
  });

  test("a non-operator's key never gets the toolset, nor does an operator's without a configured id", async () => {
    for (const [email, config] of [[PERSON, OP_CONFIG], [OPERATOR, { ...OP_CONFIG, googleCloudToolsetId: "" }]] as const) {
      const fake = new FakeLitellm();
      const keys = createLitellmKeys(CONFIG, new MemoryStore(), { fetch: fake.fetch })!;
      const delivered = await mintDeviceRouterKey(keys, device(email), config, routerKeyLimits(defaultFleetSettings()).device);
      const body = fake.callsTo("/key/generate")[0]!.body;
      assert.ok(!JSON.stringify(body).includes("mcp_toolsets"));
      assert.ok(!(delivered.mcpServers ?? []).includes(ENTRY));
    }
  });

  test("a gcloud run's key lists the toolset; any other run's key does not", async () => {
    for (const [gcloud, id] of [[true, TOOLSET], [true, ""], [false, TOOLSET]] as const) {
      const fake = new FakeLitellm();
      const store = new MemoryStore();
      const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
      const runKeys = new RunKeys({ keys, store, config: { runKeyFallback: false }, limits: async () => routerKeyLimits(defaultFleetSettings()) });
      await runKeys.keyForRun({ run: { id: "r1", state: "provisioning" }, session: { id: "s1", ownerEmail: OPERATOR }, specSent: "no", sharedKey: "sk-shared", a2a: false, gcloud, googleCloudToolsetId: id });
      const op = fake.callsTo("/key/generate")[0]!.body.object_permission;
      if (gcloud && id) assert.deepEqual(op, { mcp_servers: WITH_GCLOUD, mcp_toolsets: [TOOLSET] });
      else if (gcloud) assert.deepEqual(op, { mcp_servers: WITH_GCLOUD });
      else assert.equal(op, undefined);
    }
  });

  test("reconcileOperatorKeys revokes a former operator's toolset key even without the gcloud server on its record", async () => {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    await keys.ensureLitellmUser({ userId: "u_x", email: "former@example.com" });
    await keys.mintDeviceKey({ userId: "u_x", email: "former@example.com", deviceId: "dev_toolsetonly0000", deviceName: "x", mcpToolsets: [TOOLSET] });
    assert.deepEqual(await reconcileOperatorKeys(keys, store, OPERATORS), { revoked: 1, failed: 0 });
    assert.ok((await store.routerKeys.findByAlias("kernal-device-dev_toolsetonly0000"))?.deletedAt);
  });
});

describe("mcpEnableFor", () => {
  test("only an operator run whose spec carries the run's own non-empty key", () => {
    assert.equal(mcpEnableFor(true, { key: "sk-run", source: "run" }), true);
    assert.equal(mcpEnableFor(true, { key: "sk-shared", source: "shared" }), false, "fell back to the shared key");
    assert.equal(mcpEnableFor(true, { key: "", source: "run" }), false, "a reconnect spec sends no key");
    assert.equal(mcpEnableFor(true, undefined), false, "minting is off");
    assert.equal(mcpEnableFor(false, { key: "sk-run", source: "run" }), false);
  });
});

describe("the key record and reconcileOperatorKeys", () => {
  async function setup() {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    return { fake, store, keys };
  }
  async function mintFor(keys: Awaited<ReturnType<typeof setup>>["keys"], id: string, email: string, operators: string[]) {
    const d = { id: `dev_${id}`, userId: `u_${id}`, ownerEmail: email, name: id };
    return mintDeviceRouterKey(keys, d, { litellmBaseUrl: CONFIG.litellmBaseUrl, operators }, routerKeyLimits(defaultFleetSettings()).device);
  }

  test("the record stores the list, and the delivery tells the device (Kernal switches gcloud on from it)", async () => {
    const { store, keys } = await setup();
    const delivered = await mintFor(keys, "aaaabbbbccccdddd", OPERATOR, OPERATORS);
    assert.deepEqual(delivered.mcpServers, WITH_GCLOUD);
    assert.deepEqual((await store.routerKeys.findByAlias("kernal-device-dev_aaaabbbbccccdddd"))?.mcpServers, WITH_GCLOUD);
    const plain = await mintFor(keys, "eeeeffff00001111", PERSON, OPERATORS);
    assert.ok(!("mcpServers" in plain));
    assert.equal((await store.routerKeys.findByAlias("kernal-device-dev_eeeeffff00001111"))?.mcpServers, undefined);
  });

  test("a former operator's device key is deleted; a current operator's and a plain key are left", async () => {
    const { fake, store, keys } = await setup();
    await mintFor(keys, "aaaabbbbccccdddd", OPERATOR, OPERATORS);
    await mintFor(keys, "1111222233334444", "former@example.com", ["former@example.com"]);
    await mintFor(keys, "eeeeffff00001111", PERSON, OPERATORS);
    const result = await reconcileOperatorKeys(keys, store, OPERATORS);
    assert.deepEqual(result, { revoked: 1, failed: 0 });
    assert.ok((await store.routerKeys.findByAlias("kernal-device-dev_1111222233334444"))?.deletedAt);
    assert.equal((await store.routerKeys.findByAlias("kernal-device-dev_aaaabbbbccccdddd"))?.deletedAt, undefined);
    assert.equal((await store.routerKeys.findByAlias("kernal-device-dev_eeeeffff00001111"))?.deletedAt, undefined);
    assert.equal(fake.callsTo("/key/delete").length, 1);
    assert.deepEqual(await reconcileOperatorKeys(keys, store, OPERATORS), { revoked: 0, failed: 0 }, "idempotent");
  });

  test("with no operator list at all nothing is revoked, and without minting it is a no-op", async () => {
    const { store, keys } = await setup();
    await mintFor(keys, "aaaabbbbccccdddd", OPERATOR, OPERATORS);
    assert.equal(await reconcileOperatorKeys(keys, store, []), undefined);
    assert.equal(await reconcileOperatorKeys(undefined, store, OPERATORS), undefined);
    assert.equal((await store.routerKeys.findByAlias("kernal-device-dev_aaaabbbbccccdddd"))?.deletedAt, undefined);
  });
});

describe("the gated server list is the same everywhere", () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  const names = (text: string, re: RegExp) => JSON.parse(`[${(text.match(re) ?? [])[1] ?? "?"}]`.replace(/'/g, '"'));
  test("api, agentd, kernal and render-mcp.sh agree", () => {
    const want = [...GATED_MCP_SERVERS];
    const read = (p: string) => readFileSync(`${root}${p}`, "utf8");
    assert.deepEqual(names(read("outfitter/packages/agentd/src/mcp-gate.ts"), /GATED_MCP_SERVERS: readonly string\[\] = \[([^\]]*)\]/), want);
    assert.deepEqual(names(read("kernal/.pi/extensions/_shared/mcp-gate.ts"), /GATED_MCP_SERVERS: readonly string\[\] = \[([^\]]*)\]/), want);
    assert.deepEqual(names(read("outfitter/image/render-mcp.sh"), /const GATED = \[([^\]]*)\]/), want);
  });
});
