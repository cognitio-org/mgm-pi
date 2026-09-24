// OUTFITTER_ROLE (src/config.ts, src/server.ts, src/routes/index.ts): which routes a process
// registers. See docs/protocol.md "Two origins" for why this exists — IAP on a Cloud Run service
// is service-wide, so the browser routes (behind IAP) and the agent WebSocket / ngrok webhook
// (unauthenticated at the Cloud Run layer, self-authenticating) must live on separate services.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildTestApp } from "./helpers.ts";

describe("OUTFITTER_ROLE=web", () => {
  test("registers browser routes but not /agent/ws", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "web" });

    const sessions = await app.fastify.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(sessions.statusCode, 200);

    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/agent/ws" }), false);

    await app.fastify.close();
  });
});

describe("OUTFITTER_ROLE=link", () => {
  // E4.1b plus the Chrome companion: teleport, the side-panel session routes, and the browser
  // share/capture routes. Still gated by a personal-API-token preHandler instead of IAP -- see
  // tokens.test.ts for the token-auth specifics and browser.test.ts for the route list.
  test("registers the teleport session routes, but rejects a request with no bearer token", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link" });

    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(res.statusCode, 401);

    await app.fastify.close();
  });

  test("does not register web-only routes like POST /api/sessions, /api/gurus, or /api/operator", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link" });

    assert.equal(app.fastify.hasRoute({ method: "POST", url: "/api/sessions" }), false);
    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/api/gurus" }), false);
    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/api/operator/settings" }), false);
    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/api/me/tokens" }), false);
    // The side panel's transcript read is on the link role now (chrome companion §9.1).
    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/api/sessions/:id/entries" }), true);
    assert.equal(app.fastify.hasRoute({ method: "POST", url: "/api/sessions/:id/wake" }), true);

    await app.fastify.close();
  });

  test("serves /api/hooks/ngrok with no IAP check, even with IAP unconfigured and devMode off", async () => {
    const secret = "link-role-secret";
    // devMode off + no iapAudience: identityFromRequest would throw for any /api/* route the IAP
    // preHandler actually ran against. This route must succeed anyway, proving the preHandler
    // isn't installed for role=link at all (not just that this one path is carved out of it).
    const app = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0", NGROK_WEBHOOK_SECRET: secret });

    const body = JSON.stringify({ event_type_id: "agent_session_start.v0" });
    const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": signature },
      payload: body,
    });

    assert.equal(res.statusCode, 204);
    await app.fastify.close();
  });
});

describe("OUTFITTER_ROLE unset (default \"all\")", () => {
  test("registers both browser routes and /agent/ws, matching pre-split behavior", async () => {
    const app = await buildTestApp();

    const sessions = await app.fastify.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(sessions.statusCode, 200);

    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/agent/ws" }), true);

    await app.fastify.close();
  });
});
