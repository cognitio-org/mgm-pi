// E9 §5.1 the A2A v1.0 server on the link role (and "all"): the public Agent Card and JSON-RPC at
// /a2a. Outside /api/*, so server.ts's auth preHandler never runs here; this plugin authenticates
// with an A2A key itself (auth.ts's verifyApiToken, kind "a2a": a Dongle gets 401 here, and an A2A
// key gets 401 on /api/*). The SDK's JsonRpcTransportHandler parses and serialises; our handler
// (a2a/handler.ts) works on the a2aTasks store.
//
// Wire contract the Agent Engine client depends on (integrations/agent-engine/README.md "What the
// server must do"): auth failures are HTTP 401, the rate limit HTTP 429, never JSON-RPC errors.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgentCard, Extensions, HTTP_EXTENSION_HEADER, SSE_HEADERS, formatSSEErrorEvent, formatSSEEvent } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import { ContentTypeNotSupportedError } from "@a2a-js/sdk/errors";
import type { RouteContext } from "./context.ts";
import { bearerFromHeader, verifyApiToken } from "../auth.ts";
import { TOKEN_PREFIX } from "../tokens.ts";
import { A2AKeyUser, OutfitterA2AHandler } from "../a2a/handler.ts";
import { a2aKeyOf, type A2AKey } from "../a2a/tasks.ts";

/** §5.2: request body cap; bigger is HTTP 413. */
export const A2A_BODY_LIMIT = 64 * 1024;
const CARD_PATH = "/.well-known/agent-card.json";
const JSON_TYPES = ["application/json", "application/a2a+json"];

type RpcError = { code: number; message: string; data?: unknown };

function rpcError(id: unknown, error: RpcError) {
  return { jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error };
}

function requestId(req: FastifyRequest): unknown {
  const body = req.body as { id?: unknown } | undefined;
  return body && typeof body === "object" ? body.id : null;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** §3.6.1: the version as a header or a query parameter. The SDK reads only the header. */
function requestedVersion(req: FastifyRequest): string | undefined {
  const fromHeader = header(req, "a2a-version");
  if (fromHeader) return fromHeader.trim();
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.["A2A-Version"] ?? query?.["a2a-version"];
  return typeof fromQuery === "string" && fromQuery ? fromQuery.trim() : undefined;
}

class RpcParseError extends Error {}
class RpcContentTypeError extends Error {}

export async function registerA2ARoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const handler = new OutfitterA2AHandler({ store: ctx.store, config: ctx.config, tasks: ctx.a2a });
  const rpc = new JsonRpcTransportHandler(handler);
  const card = await handler.getAgentCard();
  const cardBody = JSON.stringify(AgentCard.toJSON(card));
  const etag = `"${createHash("sha256").update(cardBody).digest("base64url").slice(0, 27)}"`;
  const lastModified = new Date().toUTCString();

  // Public and unauthenticated: an Authorization header is ignored here (the Agent Engine client
  // sends its key on every request from the same httpx client).
  app.get(CARD_PATH, async (req, reply) => {
    reply
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .header("etag", etag)
      .header("last-modified", lastModified);
    if (header(req, "if-none-match") === etag) return reply.code(304).send();
    return reply.type("application/json").send(cardBody);
  });

  await app.register(async (a2a) => {
    // Only JSON is a request; every other type is -32005, and a syntax error -32700 rather than
    // Fastify's 400. Fastify's own JSON parser still does the parsing, so a __proto__ or
    // constructor key is refused as it is everywhere else.
    a2a.removeAllContentTypeParsers();
    const parseJson = a2a.getDefaultJsonParser("error", "error");
    a2a.addContentTypeParser(JSON_TYPES, { parseAs: "string", bodyLimit: A2A_BODY_LIMIT }, (req, body, done) => {
      parseJson(req, String(body), (err, value) => (err ? done(new RpcParseError("parse"), undefined) : done(null, value)));
    });
    a2a.addContentTypeParser("*", (_req, _payload, done) => done(new RpcContentTypeError("content type"), undefined));

    a2a.setErrorHandler((err: Error & { code?: string; statusCode?: number }, req, reply) => {
      if (err instanceof RpcParseError) return reply.code(200).send(rpcError(null, { code: -32700, message: "Invalid JSON payload" }));
      if (err instanceof RpcContentTypeError || err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        const mapped = JsonRpcTransportHandler.mapToJSONRPCError(
          new ContentTypeNotSupportedError("Content-Type must be application/json"),
        );
        return reply.code(200).send(rpcError(null, mapped));
      }
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) {
        return reply.code(413).send(rpcError(null, { code: -32600, message: `request body is over ${A2A_BODY_LIMIT} bytes` }));
      }
      req.log.warn({ err }, "a2a request failed");
      return reply.code(500).send(rpcError(requestId(req), { code: -32603, message: "Internal error" }));
    });

    const route = (req: FastifyRequest, reply: FastifyReply) => handle(req, reply);
    // The TCK posts to /a2a/, the card's URL (and the Agent Engine client) to /a2a.
    a2a.post("/a2a", { bodyLimit: A2A_BODY_LIMIT }, route);
    a2a.post("/a2a/", { bodyLimit: A2A_BODY_LIMIT }, route);
  });

  async function authenticate(req: FastifyRequest): Promise<A2AKey | undefined> {
    const bearer = bearerFromHeader(req);
    if (!bearer?.startsWith(TOKEN_PREFIX)) return undefined;
    try {
      return a2aKeyOf(await verifyApiToken(bearer, ctx.store, "a2a"));
    } catch {
      return undefined;
    }
  }

  async function handle(req: FastifyRequest, reply: FastifyReply) {
    const key = await authenticate(req);
    if (!key) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="outfitter-a2a"')
        .send(rpcError(requestId(req), { code: -32600, message: "an A2A key is required" }));
    }

    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const count = await ctx.store.a2aTasks.countRequest(key.id, String(window), new Date((window + 2) * 60_000).toISOString());
    // §5.2: per key, counted in fixed one-minute windows shared by every link instance.
    const limit = ctx.config.a2aRequestsPerMinute;
    if (count > limit) {
      return reply
        .code(429)
        .header("retry-after", String(Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000))))
        .send(rpcError(requestId(req), { code: -32600, message: `over ${limit} requests a minute for this key` }));
    }

    if (req.body === undefined || req.body === null || typeof req.body !== "object") {
      return reply.code(200).send(rpcError(null, { code: -32600, message: "Invalid Request" }));
    }

    const callContext = new ServerCallContext({
      requestedExtensions: Extensions.parseServiceParameter(header(req, "a2a-extensions")),
      user: new A2AKeyUser(key),
      requestedVersion: requestedVersion(req),
    });
    try {
      // A missing version means 0.3, which the card doesn't list: VersionNotSupported (-32009).
      validateVersion(callContext.requestedVersion, card, "JSONRPC");
    } catch (err) {
      return reply.code(200).send(rpcError(requestId(req), JsonRpcTransportHandler.mapToJSONRPCError(err)));
    }

    const out = await rpc.handle(req.body as Record<string, unknown>, callContext);
    const activated = callContext.activatedExtensions;
    const extHeader = activated && activated.length > 0 ? Extensions.toServiceParameter(activated) : undefined;
    if (typeof (out as AsyncGenerator)[Symbol.asyncIterator] !== "function") {
      if (extHeader) reply.header(HTTP_EXTENSION_HEADER, extHeader);
      const response = out as { error?: RpcError };
      return reply.code(response.error?.code === -32603 ? 500 : 200).send(out);
    }
    return streamOut(req, reply, out as AsyncGenerator<unknown, void, undefined>, extHeader);
  }
}

/**
 * SSE for SendStreamingMessage/SubscribeToTask. The first event is pulled before committing to
 * SSE, so an early error (PR5: both methods are UnsupportedOperation) goes back as plain JSON.
 * PR6's polling streams use the rest.
 */
async function streamOut(req: FastifyRequest, reply: FastifyReply, out: AsyncGenerator<unknown, void, undefined>, extHeader: string | undefined) {
  const it = out[Symbol.asyncIterator]();
  let first: IteratorResult<unknown, void>;
  try {
    first = await it.next();
  } catch (err) {
    return reply.code(200).send(rpcError(requestId(req), JsonRpcTransportHandler.mapToJSONRPCError(err)));
  }
  const firstValue = first.value as { error?: unknown } | undefined;
  if (first.done || firstValue?.error) {
    if (extHeader) reply.header(HTTP_EXTENSION_HEADER, extHeader);
    return reply.code(200).send(first.value ?? rpcError(requestId(req), { code: -32603, message: "empty stream" }));
  }
  reply.hijack();
  const raw = reply.raw;
  if (extHeader) raw.setHeader(HTTP_EXTENSION_HEADER, extHeader);
  raw.writeHead(200, SSE_HEADERS);
  let closed = false;
  raw.on("close", () => {
    closed = true;
    void it.return?.(undefined);
  });
  try {
    raw.write(formatSSEEvent(first.value));
    for (let n = await it.next(); !n.done && !closed; n = await it.next()) raw.write(formatSSEEvent(n.value));
  } catch (err) {
    if (!closed) raw.write(formatSSEErrorEvent(rpcError(requestId(req), JsonRpcTransportHandler.mapToJSONRPCError(err))));
  } finally {
    if (!raw.writableEnded) raw.end();
  }
}
