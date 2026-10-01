import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentry's real init() reaches the network (and would actually start reporting), so these tests
// drive lib/sentry.ts against a mock @sentry/react instead -- asserting the options this app
// configures (DSN selection, sample rates, integrations) without a live SDK.
const initMock = vi.fn();
const browserTracingIntegrationMock = vi.fn(() => ({ name: "BrowserTracing" }));
const replayIntegrationMock = vi.fn(() => ({ name: "Replay" }));

vi.mock("@sentry/react", () => ({
  init: (options: unknown) => initMock(options),
  browserTracingIntegration: () => browserTracingIntegrationMock(),
  replayIntegration: () => replayIntegrationMock(),
}));

const DEFAULT_DSN = "https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224";

describe("initSentry", () => {
  beforeEach(() => {
    initMock.mockClear();
    browserTracingIntegrationMock.mockClear();
    replayIntegrationMock.mockClear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes with the default DSN when VITE_SENTRY_DSN is unset", async () => {
    vi.resetModules();
    const { initSentry, isSentryInitialized } = await import("../src/lib/sentry.ts");
    initSentry();
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0]?.[0]).toMatchObject({ dsn: DEFAULT_DSN });
    expect(isSentryInitialized()).toBe(true);
  });

  it("prefers VITE_SENTRY_DSN over the default DSN when set", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://example@o0.ingest.sentry.io/1");
    vi.resetModules();
    const { initSentry } = await import("../src/lib/sentry.ts");
    initSentry();
    expect(initMock.mock.calls[0]?.[0]).toMatchObject({ dsn: "https://example@o0.ingest.sentry.io/1" });
  });

  it("configures the free-tier error-only replay sample rates and a low trace sample rate", async () => {
    vi.resetModules();
    const { initSentry } = await import("../src/lib/sentry.ts");
    initSentry();
    expect(initMock.mock.calls[0]?.[0]).toMatchObject({
      tracesSampleRate: 0.05,
      replaysSessionSampleRate: 0.0,
      replaysOnErrorSampleRate: 1.0,
    });
  });

  it("registers browser tracing and replay integrations", async () => {
    vi.resetModules();
    const { initSentry } = await import("../src/lib/sentry.ts");
    initSentry();
    expect(browserTracingIntegrationMock).toHaveBeenCalledTimes(1);
    expect(replayIntegrationMock).toHaveBeenCalledTimes(1);
    const integrations = initMock.mock.calls[0]?.[0]?.integrations;
    expect(integrations).toEqual([{ name: "BrowserTracing" }, { name: "Replay" }]);
  });
});
