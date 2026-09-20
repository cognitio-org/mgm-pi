// POST /api/hooks/ngrok: signature accept/reject and the laptopOnline flip it drives. See
// src/routes/hooks.ts. verifyNgrokSignature itself is exercised indirectly through the route so
// these tests also cover the route wiring (raw-body parsing, header lookup, status codes).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildTestApp } from "./helpers.ts";

const SECRET = "test-ngrok-secret";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

describe("POST /api/hooks/ngrok", () => {
  test("a correctly signed agent_session_stop.v0 is accepted and flips the probe offline", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    app.laptopProbe.setOnline(true);

    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": sign(body) },
      payload: body,
    });

    assert.equal(res.statusCode, 204);
    assert.equal(await app.laptopProbe.isOnline(), false);
    await app.fastify.close();
  });

  test("a correctly signed agent_session_start.v0 is accepted and flips the probe online", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    app.laptopProbe.setOnline(false);

    const body = JSON.stringify({ event_type_id: "agent_session_start.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": sign(body) },
      payload: body,
    });

    assert.equal(res.statusCode, 204);
    assert.equal(await app.laptopProbe.isOnline(), true);
    await app.fastify.close();
  });

  test("a wrong signature is rejected with 401 and the probe is untouched", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    app.laptopProbe.setOnline(true);

    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": "0".repeat(64) },
      payload: body,
    });

    assert.equal(res.statusCode, 401);
    assert.equal(await app.laptopProbe.isOnline(), true);
    await app.fastify.close();
  });

  test("a missing signature header is rejected with 401", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });

  test("an unconfigured secret rejects every delivery (never silently trusts an unsigned endpoint)", async () => {
    const app = await buildTestApp(); // NGROK_WEBHOOK_SECRET left unset
    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });
});
