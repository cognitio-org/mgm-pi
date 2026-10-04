import { beforeEach, describe, expect, it, vi } from "vitest";

// Sentry's real init() reaches the network (and would actually start reporting), so these tests
// drive lib/sentry.ts against a mock @sentry/react instead -- asserting that the fleet settings
// (GET /api/fleet-settings, passed in here as `load`) decide whether it starts and with what.
const initMock = vi.fn();
const browserTracingIntegrationMock = vi.fn(() => ({ name: "BrowserTracing" }));
const replayIntegrationMock = vi.fn(() => ({ name: "Replay" }));

vi.mock("@sentry/react", () => ({
  init: (options: unknown) => initMock(options),
  browserTracingIntegration: () => browserTracingIntegrationMock(),
  replayIntegration: () => replayIntegrationMock(),
}));

const DSN = "https://example@o0.ingest.sentry.io/1";
const on = async () => ({ telemetry: { sentry: { enabled: true as const, dsn: DSN, tracesSampleRate: 0.2 } } });
const off = async () => ({ telemetry: { sentry: { enabled: false as const } } });

async function freshModule() {
  vi.resetModules();
  return import("../src/lib/sentry.ts");
}

describe("initSentry", () => {
  beforeEach(() => {
    initMock.mockClear();
    browserTracingIntegrationMock.mockClear();
    replayIntegrationMock.mockClear();
  });

  it("starts with the fleet's DSN and trace rate when an operator turned Sentry on", async () => {
    const { initSentry, isSentryInitialized } = await freshModule();
    expect(await initSentry(on)).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0]?.[0]).toMatchObject({ dsn: DSN, tracesSampleRate: 0.2, environment: "development" });
    expect(isSentryInitialized()).toBe(true);
  });

  it("reports under the deploy's release the api names, and sets none without one", async () => {
    const { initSentry } = await freshModule();
    await initSentry(async () => ({ telemetry: { sentry: { enabled: true as const, dsn: DSN, tracesSampleRate: 0.2, release: "outfitter-v2026.10.04.1" } } }));
    expect(initMock.mock.calls[0]?.[0]).toMatchObject({ release: "outfitter-v2026.10.04.1" });
    const again = await freshModule();
    initMock.mockClear();
    await again.initSentry(on);
    expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty("release");
  });

  it("sends nothing while the fleet has Sentry off", async () => {
    const { initSentry, isSentryInitialized } = await freshModule();
    expect(await initSentry(off)).toBe(false);
    expect(initMock).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });

  it("a failed settings read (signed out, API down) means off, and never throws", async () => {
    const { initSentry } = await freshModule();
    expect(await initSentry(async () => Promise.reject(new Error("401")))).toBe(false);
    expect(initMock).not.toHaveBeenCalled();
  });

  it("keeps replay error-only whatever the trace rate", async () => {
    const { initSentry } = await freshModule();
    await initSentry(on);
    expect(initMock.mock.calls[0]?.[0]).toMatchObject({ replaysSessionSampleRate: 0.0, replaysOnErrorSampleRate: 1.0 });
    expect(initMock.mock.calls[0]?.[0]?.integrations).toEqual([{ name: "BrowserTracing" }, { name: "Replay" }]);
  });

  it("only the first successful call starts the SDK", async () => {
    const { initSentry } = await freshModule();
    await initSentry(on);
    await initSentry(on);
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});
