// GA-2 (#492): the router's gcloud MCP server is admitted to operators' keys only, through
// object_permission.mcp_servers on /key/generate. LiteLLM is the fake management API; nothing here
// reaches a router.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BASE_MCP_SERVERS, GCLOUD_MCP_SERVER, deviceKeyMcpServers, gcloudRun, runKeyMcpServers } from "../src/central/gcloud-mcp.ts";
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
