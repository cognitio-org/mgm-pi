// #503: the client's Auto-fix CI switch (the Changes pane wires the toggle to it).

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/api/client.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.setAutofix", () => {
  test("PUTs { on } to the session's autofix route and returns the state", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ autofixCi: true, autofix: { on: true } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await api.setAutofix("s1", true);
    expect(result).toEqual({ autofixCi: true, autofix: { on: true } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/autofix");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ on: true });
  });
});
