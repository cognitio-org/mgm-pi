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
});
