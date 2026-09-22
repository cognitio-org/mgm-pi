import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { api, ApiError } from "../src/api/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Node's own global `localStorage` (unrelated to the DOM Storage API; needs --localstorage-file)
// shadows jsdom's window.localStorage under vitest's jsdom environment, so tests stub the global
// directly with a minimal in-memory Storage rather than relying on either.
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends credentials: same-origin and no Authorization header when no dev token is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ email: "dev@localhost" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.me();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("attaches a bearer header when a dev token is stashed in localStorage", async () => {
    localStorage.setItem("outfitterDevToken", "secret-token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ email: "dev@localhost" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.me();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer secret-token");
  });

  it("resolves providers() to [] on a 404 instead of throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.providers()).resolves.toEqual([]);
  });

  it("returns the providers array when the endpoint responds 200", async () => {
    const rows = [{ id: "p1", kind: "ngrok", name: "laptop", status: "up", checkedAt: "2026-09-21T00:00:00.000Z" }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ providers: rows }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.providers()).resolves.toEqual(rows);
  });

  it("throws ApiError with the server's error message on a non-2xx, non-404 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "guruId and prompt are required" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.createSession({ guruId: "", prompt: "" }),
    ).rejects.toMatchObject(new ApiError(400, "guruId and prompt are required"));
  });

  it("sends runState (not status) for the fleet page's run-state filter (code review M1)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await api.sessions({ runState: "running", guru: "g1" });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sessions?guru=g1&runState=running");
  });

  it("sends a JSON body with Content-Type for POST requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run: { id: "r1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.sendMessage("s1", "hello", "steer");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sessions/s1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ text: "hello", behavior: "steer" });
  });

  it("me() surfaces linkOrigin from the API response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ email: "dev@localhost", linkOrigin: "https://outfitter-link.run.app" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).resolves.toEqual({ email: "dev@localhost", linkOrigin: "https://outfitter-link.run.app" });
  });

  it("createToken POSTs the name and returns the plaintext token plus record", async () => {
    const record = { id: "t1", ownerEmail: "dev@localhost", name: "laptop", prefix: "outf_ab1", createdAt: "now" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: "outf_abc123", record }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.createToken("laptop");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me/tokens");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "laptop" });
    expect(result).toEqual({ token: "outf_abc123", record });
  });

  it("listTokens GETs /api/me/tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await api.listTokens();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me/tokens");
  });

  it("revokeToken DELETEs /api/me/tokens/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ record: { id: "t1", revokedAt: "now" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.revokeToken("t1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me/tokens/t1");
    expect(init.method).toBe("DELETE");
  });

  it("models() GETs /api/models and unwraps the models array", async () => {
    const rows = [{ id: "litellm/claude-auto-llm", auto: true }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ models: rows }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.models()).resolves.toEqual(rows);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/models");
  });

  it("guruMeta() GETs /api/gurus/meta", async () => {
    const meta = { envDenylist: ["PATH"], thinkingLevels: ["off", "low"] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meta));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.guruMeta()).resolves.toEqual(meta);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/gurus/meta");
  });

  it("createGuru POSTs the guru body to /api/gurus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "g1" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await api.createGuru({ name: "test", model: "litellm/claude-auto-llm" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/gurus");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "test", model: "litellm/claude-auto-llm" });
  });

  it("updateGuru PUTs the patch to /api/gurus/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "g1", thinking: "high" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.updateGuru("g1", { thinking: "high" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/gurus/g1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ thinking: "high" });
  });

  it("deleteGuru DELETEs /api/gurus/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteGuru("g1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/gurus/g1");
    expect(init.method).toBe("DELETE");
  });

  it("deleteGuru surfaces the API's 409 message (referenced by sessions)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "guru is referenced by 2 sessions" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteGuru("g1")).rejects.toMatchObject(new ApiError(409, "guru is referenced by 2 sessions"));
  });

  it("me() surfaces the operator flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ email: "operator@mgms.eu", operator: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).resolves.toEqual({ email: "operator@mgms.eu", operator: true });
  });

  it("operatorSettings GETs /api/operator/settings", async () => {
    const settings = {
      litellmBaseUrl: "https://litellm.example.com/v1",
      sandboxProvider: "cloudrun",
      cloudRunJob: "outfitter-agent",
      tunnelDomain: "mgm-lmstudio.ngrok.app",
      operators: ["mgm@mgms.eu"],
      secrets: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(settings));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.operatorSettings()).resolves.toEqual(settings);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/operator/settings");
  });

  it("putOperatorSecret PUTs the value and URL-encodes the secret name", async () => {
    const row = { id: "outfitter-github-pat", secretName: "outfitter-github-pat", label: "x", purpose: "y", set: true, appliesAt: "next deploy" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(row));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.putOperatorSecret("outfitter-github-pat", "a-value");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/operator/secrets/outfitter-github-pat");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ value: "a-value" });
    expect(result).toEqual(row);
  });

  it("disableOperatorSecret DELETEs /api/operator/secrets/:name", async () => {
    const row = { id: "outfitter-github-pat", secretName: "outfitter-github-pat", label: "x", purpose: "y", set: false, appliesAt: "next deploy" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(row));
    vi.stubGlobal("fetch", fetchMock);

    await api.disableOperatorSecret("outfitter-github-pat");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/operator/secrets/outfitter-github-pat");
    expect(init.method).toBe("DELETE");
  });

  it("testOperatorSecret POSTs an explicit value when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.testOperatorSecret("outfitter-github-pat", "a-value");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/operator/secrets/outfitter-github-pat/test");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ value: "a-value" });
  });

  it("testOperatorSecret POSTs an empty body to test the stored value when no value is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, detail: "no value set" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.testOperatorSecret("outfitter-github-pat");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({});
  });
});
