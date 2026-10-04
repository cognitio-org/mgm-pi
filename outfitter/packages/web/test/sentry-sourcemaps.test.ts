// vite.config.ts's Sentry source-map switch (#423): off unless SENTRY_AUTH_TOKEN is set at build
// time, so dev, CI and tests build exactly as before; on, it writes hidden maps and deletes them
// after the upload.
import { describe, expect, it } from "vitest";
import { sentrySourceMaps } from "../vite.config.ts";

describe("sentrySourceMaps", () => {
  it("adds nothing and writes no source maps without a token", () => {
    expect(sentrySourceMaps({})).toEqual({ plugins: [], sourcemap: false });
    expect(sentrySourceMaps({ SENTRY_AUTH_TOKEN: "  ", SENTRY_ORG: "o", SENTRY_PROJECT: "p" })).toEqual({
      plugins: [],
      sourcemap: false,
    });
  });

  it("uses hidden maps and the Sentry plugin with a token", () => {
    const out = sentrySourceMaps({ SENTRY_AUTH_TOKEN: "sntrys_x", SENTRY_ORG: "o", SENTRY_PROJECT: "p" });
    expect(out.sourcemap).toBe("hidden");
    const flat = (out.plugins as unknown[]).flat(4) as Array<{ name?: unknown } | null | false>;
    const names = flat.map((p) => (p && typeof p === "object" ? String(p.name) : ""));
    expect(names.some((n) => n.startsWith("sentry"))).toBe(true);
  });
});
