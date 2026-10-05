import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  discoverLocalModels, probeServer, defaultTargets, OLLAMA_SHOW_CONCURRENCY, serverRoot, classify, snapshotKey, parseLmStudioNative, parseOllama, parseOpenAiModels,
  type DiscoverySnapshot,
} from "../.pi/extensions/_shared/local-discovery.ts";
import { lmStudioMeta, normalizeBaseUrl, parseLmStudioModels } from "../.pi/extensions/connect/lib.ts";

// ---------- recorded responses, one per server type ----------
const LMSTUDIO_NATIVE = { object: "list", data: [
  { id: "qwen/qwen3.6-35b-a3b", object: "model", type: "vlm", publisher: "qwen", arch: "qwen3_moe", compatibility_type: "mlx", quantization: "4bit", state: "loaded", max_context_length: 262144, loaded_context_length: 183296, capabilities: ["tool_use"] },
  { id: "google/gemma-4-e4b", object: "model", type: "llm", publisher: "google", arch: "gemma4", compatibility_type: "gguf", quantization: "Q4_K_M", state: "not-loaded", max_context_length: 131072 },
  { id: "text-embedding-nomic-embed-text-v1.5", object: "model", type: "embeddings", publisher: "nomic-ai", state: "not-loaded", max_context_length: 2048 },
] };
const LMSTUDIO_V1 = { object: "list", data: [
  { id: "qwen/qwen3.6-35b-a3b", object: "model", owned_by: "organization_owner" },
  { id: "text-embedding-nomic-embed-text-v1.5", object: "model", owned_by: "organization_owner" },
] };
const OLLAMA_TAGS = { models: [
  { name: "llama3.2:latest", model: "llama3.2:latest", size: 2019393189, details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" } },
  { name: "llava:7b", model: "llava:7b", size: 4733363377, details: { family: "llama", quantization_level: "Q4_0" } },
  { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", size: 274302450, details: { family: "nomic-bert", quantization_level: "F16" } },
] };
const OLLAMA_PS = { models: [{ name: "llama3.2:latest", model: "llama3.2:latest", size: 3500000000, size_vram: 3500000000, context_length: 8192, expires_at: "2026-10-05T12:00:00Z" }] };
const OLLAMA_SHOW: Record<string, any> = {
  "llama3.2:latest": { capabilities: ["completion", "tools"], model_info: { "general.architecture": "llama", "llama.context_length": 131072 } },
  "llava:7b": { capabilities: ["completion", "vision"], model_info: { "llama.context_length": 32768 } },
  "nomic-embed-text:latest": { capabilities: ["embedding"], model_info: { "nomic-bert.context_length": 2048 } },
};
const LLAMACPP_V1 = { object: "list", data: [{ id: "gemma-3-4b-it-Q4_K_M.gguf", object: "model", created: 1, owned_by: "llamacpp", meta: { n_ctx_train: 131072, size: 2489757856 } }] };
const LLAMACPP_PROPS = { default_generation_settings: { n_ctx: 16384 }, modalities: { vision: true } };
const MLX_V1 = { object: "list", data: [{ id: "mlx-community/Qwen3-4B-4bit", object: "model", created: 1 }, { id: "mlx-community/gemma-3-1b-it-4bit", object: "model", created: 1 }] };
const VLLM_V1 = { object: "list", data: [{ id: "Qwen/Qwen3-8B", object: "model", created: 1, owned_by: "vllm", root: "Qwen/Qwen3-8B", max_model_len: 40960 }] };

type Route = (body: any) => unknown | Response | Promise<unknown>;
/** A fetch that answers from `routes` by full URL; anything else is refused like a closed port. */
function stubFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[url];
    if (!route) { const e: any = new TypeError("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; }
    const out = await route(init?.body ? JSON.parse(init.body) : undefined);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
/** A fetch that never answers until aborted, as a hung server does. */
const hang: Route = () => new Promise(() => {});
function withHang(routes: Record<string, Route>): typeof fetch {
  const base = stubFetch(routes);
  return (async (input: any, init?: any) => {
    if (routes[String(input)] !== hang) return base(input, init);
    return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }) as typeof fetch;
}

const LM = "http://localhost:1234", OL = "http://localhost:11434", P8080 = "http://localhost:8080", P8000 = "http://localhost:8000";
const ALL: Record<string, Route> = {
  [`${LM}/api/v0/models`]: () => LMSTUDIO_NATIVE, [`${LM}/v1/models`]: () => LMSTUDIO_V1,
  [`${OL}/api/tags`]: () => OLLAMA_TAGS, [`${OL}/api/ps`]: () => OLLAMA_PS, [`${OL}/api/show`]: (b) => OLLAMA_SHOW[b.model] ?? new Response("{}", { status: 404 }),
  [`${P8080}/v1/models`]: () => LLAMACPP_V1, [`${P8080}/props`]: () => LLAMACPP_PROPS,
  [`${P8000}/v1/models`]: () => VLLM_V1,
};

describe("where to look", () => {
  test("serverRoot normalises what people type", () => {
    assert.equal(serverRoot("http://localhost:1234/v1"), "http://localhost:1234");
    assert.equal(serverRoot("localhost:1234/"), "http://localhost:1234");
    assert.equal(serverRoot("http://127.0.0.1:11434/api"), "http://127.0.0.1:11434");
    assert.equal(serverRoot("0.0.0.0", 11434), "http://127.0.0.1:11434", "OLLAMA_HOST's bind-all means loopback here");
    assert.equal(serverRoot("0.0.0.0:11500", 11434), "http://127.0.0.1:11500");
    assert.equal(serverRoot("https://mac.example.ts.net/lmstudio/v1"), "https://mac.example.ts.net/lmstudio", "a path prefix is kept");
    assert.equal(serverRoot(""), undefined);
    assert.equal(serverRoot("http://"), undefined);
  });
  test("a bare host gets connect's scheme: http when local or private, https otherwise; OLLAMA_HOST stays http", () => {
    for (const [typed, root] of [["mac.example.ts.net:1234", "https://mac.example.ts.net:1234"], ["192.168.1.5:1234", "http://192.168.1.5:1234"], ["10.0.0.2:1234/v1", "http://10.0.0.2:1234"], ["[::1]:1234", "http://[::1]:1234"]]) {
      assert.equal(serverRoot(typed), root, typed);
      assert.equal(normalizeBaseUrl(typed, ""), `${root}/v1`, `connect reaches ${typed} at the same place`);
    }
    assert.equal(defaultTargets({ LMSTUDIO_BASE_URL: "mac.example.ts.net:1234" })[0].url, "https://mac.example.ts.net:1234");
    assert.equal(defaultTargets({ OLLAMA_HOST: "gpu-box:11434" }).find((x) => x.kind === "ollama")!.url, "http://gpu-box:11434", "Ollama reads a bare OLLAMA_HOST as http");
  });
  test("defaults are localhost's usual ports only", () => {
    assert.deepEqual(defaultTargets({}).map((t) => `${t.kind} ${t.url}`), ["lmstudio http://localhost:1234", "ollama http://localhost:11434", "auto http://localhost:8080", "auto http://localhost:8000"]);
  });
  test("LMSTUDIO_BASE_URL and OLLAMA_HOST replace their defaults; the others add servers; duplicates collapse", () => {
    const t = defaultTargets({
      LMSTUDIO_BASE_URL: "http://192.168.1.5:1234/v1", OLLAMA_HOST: "0.0.0.0", LLAMACPP_BASE_URL: "http://localhost:8080",
      MLX_LM_BASE_URL: "localhost:8090", VLLM_BASE_URL: "", KERNAL_LOCAL_SERVERS: "vllm=http://localhost:8001, http://localhost:9000 ,bogus=localhost:9001",
    });
    assert.deepEqual(t.map((x) => `${x.kind} ${x.url}`), [
      "lmstudio http://192.168.1.5:1234", "ollama http://127.0.0.1:11434", "llamacpp http://localhost:8080", "mlx-lm http://localhost:8090",
      "vllm http://localhost:8001", "auto http://localhost:9000", "auto http://localhost:8000",
    ], "an entry naming an unknown kind is skipped");
    assert.equal(t.find((x) => x.url === "http://localhost:8080")!.kind, "llamacpp", "the configured kind wins over the 8080 auto probe");
    assert.ok(!t.some((x) => x.url === "http://localhost:1234"), "LMSTUDIO_BASE_URL replaces :1234");
    assert.equal(t.find((x) => x.kind === "ollama")!.url, "http://127.0.0.1:11434");
    assert.equal(t.find((x) => x.url === "http://localhost:8001")!.kind, "vllm");
    assert.equal(t.find((x) => x.url === "http://localhost:9000")!.kind, "auto");
    assert.equal(defaultTargets({ OLLAMA_BASE_URL: "http://localhost:11500/v1" }).find((x) => x.kind === "ollama")!.url, "http://localhost:11500");
  });
});

describe("per-server parsing", () => {
  test("LM Studio: every downloaded model with state, served vs max context, type and tool use", () => {
    const m = parseLmStudioNative(LMSTUDIO_NATIVE, LM);
    assert.deepEqual(m[0], { id: "qwen/qwen3.6-35b-a3b", server: LM, kind: "lmstudio", loaded: true, contextLength: 183296, maxContextLength: 262144, loadedContextLength: 183296, type: "vlm", vision: true, toolUse: true, quantization: "4bit" });
    assert.deepEqual(m[1], { id: "google/gemma-4-e4b", server: LM, kind: "lmstudio", loaded: false, contextLength: 131072, maxContextLength: 131072, type: "llm", vision: false, quantization: "Q4_K_M" });
    assert.equal(m[2].type, "embeddings");
  });
  test("connect's LM Studio meta is unchanged: chat models only, served window when loaded", () => {
    assert.deepEqual([...parseLmStudioModels(LMSTUDIO_NATIVE)], [
      ["qwen/qwen3.6-35b-a3b", { contextWindow: 183296, loaded: true, vision: true, toolUse: true }],
      ["google/gemma-4-e4b", { contextWindow: 131072, loaded: false, vision: false, toolUse: undefined }],
    ]);
    assert.equal(parseLmStudioModels({ data: [{ id: "x", type: "audio", max_context_length: 10 }] }).size, 0, "an unknown type is skipped, as before");
    assert.equal(parseLmStudioModels({ data: [{ id: "x", max_context_length: 10 }] }).get("x")!.vision, false, "no type: not vision, as before");
    assert.equal(lmStudioMeta([{ id: "y", server: LM, kind: "lmstudio", listed: true }]).size, 0, "a /v1-only id has no window to report");
  });
  test("Ollama: pulled models, loaded from /api/ps, capabilities and ceiling from /api/show", () => {
    const m = parseOllama(OL, OLLAMA_TAGS, OLLAMA_PS, OLLAMA_SHOW);
    assert.deepEqual(m[0], { id: "llama3.2:latest", server: OL, kind: "ollama", loaded: true, contextLength: 8192, maxContextLength: 131072, loadedContextLength: 8192, type: "llm", vision: false, toolUse: true, quantization: "Q4_K_M", sizeBytes: 2019393189 });
    assert.deepEqual(m[1], { id: "llava:7b", server: OL, kind: "ollama", loaded: false, contextLength: 32768, maxContextLength: 32768, type: "vlm", vision: true, toolUse: false, quantization: "Q4_0", sizeBytes: 4733363377 });
    assert.equal(m[2].type, "embeddings");
    const bare = parseOllama(OL, OLLAMA_TAGS);
    assert.deepEqual(bare[1], { id: "llava:7b", server: OL, kind: "ollama", loaded: false, quantization: "Q4_0", sizeBytes: 4733363377 }, "without /api/show: no guesses");
  });
  test("llama.cpp: its one model is loaded, served n_ctx from /props, ceiling n_ctx_train; router mode reads status", () => {
    const [m] = parseOpenAiModels(LLAMACPP_V1, P8080, "llamacpp", LLAMACPP_PROPS);
    assert.deepEqual(m, { id: "gemma-3-4b-it-Q4_K_M.gguf", server: P8080, kind: "llamacpp", loaded: true, contextLength: 16384, maxContextLength: 131072, loadedContextLength: 16384, vision: true, sizeBytes: 2489757856 });
    const router = parseOpenAiModels({ data: [{ id: "a", owned_by: "llamacpp", status: { value: "loaded" } }, { id: "b", owned_by: "llamacpp", status: { value: "unloaded" } }] }, P8080, "llamacpp");
    assert.deepEqual(router.map((x) => [x.id, x.loaded]), [["a", true], ["b", false]]);
  });
  test("vLLM serves what it lists; mlx-lm and generic servers don't say what is loaded", () => {
    assert.deepEqual(parseOpenAiModels(VLLM_V1, P8000, "vllm")[0], { id: "Qwen/Qwen3-8B", server: P8000, kind: "vllm", loaded: true, contextLength: 40960, maxContextLength: 40960 });
    assert.deepEqual(parseOpenAiModels(MLX_V1, P8080, "mlx-lm")[0], { id: "mlx-community/Qwen3-4B-4bit", server: P8080, kind: "mlx-lm" });
  });
  test("classify reads owned_by", () => {
    assert.equal(classify(LLAMACPP_V1), "llamacpp");
    assert.equal(classify(VLLM_V1), "vllm");
    assert.equal(classify(LMSTUDIO_V1), "lmstudio");
    assert.equal(classify({ data: [{ id: "x", owned_by: "library" }] }), "ollama");
    assert.equal(classify(MLX_V1), "mlx-lm");
    assert.equal(classify({ data: [{ id: "x", owned_by: "someone" }] }), "openai");
    assert.equal(classify({ data: [] }), "openai");
  });
});

describe("probing", () => {
  test("LM Studio: native and /v1 lists merged; `listed` says which ids it accepts now", async () => {
    const calls: string[] = [];
    const { server, models } = await probeServer({ kind: "lmstudio", url: `${LM}/v1`, apiKey: "lm-studio" }, { fetch: stubFetch(ALL, calls) });
    assert.deepEqual(server, { id: LM, kind: "lmstudio", baseUrl: `${LM}/v1`, ok: true, endpoints: ["/api/v0/models", "/v1/models"], models: 3 });
    assert.deepEqual(models.map((m) => [m.id, m.loaded, m.listed]), [["google/gemma-4-e4b", false, false], ["qwen/qwen3.6-35b-a3b", true, true], ["text-embedding-nomic-embed-text-v1.5", false, true]]);
    assert.deepEqual(calls.sort(), [`GET ${LM}/api/v0/models`, `GET ${LM}/v1/models`]);
  });
  test("LM Studio sends its key when one is given (a tunnelled server)", async () => {
    const seen: string[] = [];
    const f = (async (_u: any, init: any) => { seen.push(init.headers.authorization); return new Response(JSON.stringify({ data: [] })); }) as typeof fetch;
    await probeServer({ kind: "lmstudio", url: LM, apiKey: "lm-studio" }, { fetch: f });
    assert.deepEqual(seen, ["Bearer lm-studio", "Bearer lm-studio"]);
  });
  test("an older LM Studio without /api/v0 still lists its /v1 ids", async () => {
    const { server, models } = await probeServer({ kind: "lmstudio", url: LM }, { fetch: stubFetch({ [`${LM}/api/v0/models`]: () => new Response("nope", { status: 404 }), [`${LM}/v1/models`]: () => LMSTUDIO_V1 }) });
    assert.equal(server.ok, true);
    assert.deepEqual(server.endpoints, ["/v1/models"]);
    assert.deepEqual(models, [{ id: "qwen/qwen3.6-35b-a3b", server: LM, kind: "lmstudio", listed: true }, { id: "text-embedding-nomic-embed-text-v1.5", server: LM, kind: "lmstudio", listed: true }]);
  });
  test("Ollama: tags, ps and one show per model, sent as POST {model}", async () => {
    const calls: string[] = [];
    const { server, models } = await probeServer({ kind: "ollama", url: OL }, { fetch: stubFetch(ALL, calls) });
    assert.deepEqual(server.endpoints, ["/api/tags", "/api/ps"]);
    assert.equal(models.length, 3);
    assert.equal(calls.filter((c) => c === `POST ${OL}/api/show`).length, 3);
  });
  test("Ollama with /api/ps and /api/show failing still lists what is pulled", async () => {
    const { server, models } = await probeServer({ kind: "ollama", url: OL }, { fetch: stubFetch({ [`${OL}/api/tags`]: () => OLLAMA_TAGS }) });
    assert.equal(server.ok, true);
    assert.deepEqual(models.map((m) => [m.id, m.loaded]), [["llama3.2:latest", false], ["llava:7b", false], ["nomic-embed-text:latest", false]]);
  });
  test("auto on 8080 recognises llama.cpp and asks /props; mlx-lm needs no /props", async () => {
    const calls: string[] = [];
    const lc = await probeServer({ kind: "auto", url: P8080 }, { fetch: stubFetch(ALL, calls) });
    assert.equal(lc.server.kind, "llamacpp");
    assert.deepEqual(lc.server.endpoints, ["/v1/models", "/props"]);
    assert.equal(lc.models[0].loadedContextLength, 16384);
    calls.length = 0;
    const mlx = await probeServer({ kind: "auto", url: P8080 }, { fetch: stubFetch({ [`${P8080}/v1/models`]: () => MLX_V1 }, calls) });
    assert.equal(mlx.server.kind, "mlx-lm");
    assert.deepEqual(calls, [`GET ${P8080}/v1/models`]);
  });
  test("auto hands an LM Studio or Ollama on an unusual port to its own probe", async () => {
    const lm = await probeServer({ kind: "auto", url: "http://localhost:9000" }, { fetch: stubFetch({ "http://localhost:9000/v1/models": () => LMSTUDIO_V1, "http://localhost:9000/api/v0/models": () => LMSTUDIO_NATIVE }) });
    assert.equal(lm.server.kind, "lmstudio");
    assert.equal(lm.models.find((m) => m.id === "qwen/qwen3.6-35b-a3b")!.loadedContextLength, 183296);
    const ol = await probeServer({ kind: "auto", url: "http://localhost:9001" }, { fetch: stubFetch({ "http://localhost:9001/v1/models": () => ({ data: [{ id: "llama3.2:latest", owned_by: "library" }] }), "http://localhost:9001/api/tags": () => OLLAMA_TAGS }) });
    assert.equal(ol.server.kind, "ollama");
    assert.equal(ol.models.length, 3);
  });
  test("failures come back as short reasons, never as throws", async () => {
    assert.deepEqual((await probeServer({ kind: "auto", url: P8000 }, { fetch: stubFetch({}) })).server, { id: P8000, kind: "openai", baseUrl: `${P8000}/v1`, ok: false, error: "refused", endpoints: [], models: 0 });
    const notJson = stubFetch({ [`${P8000}/v1/models`]: () => new Response("<html>", { status: 200 }) });
    assert.equal((await probeServer({ kind: "vllm", url: P8000 }, { fetch: notJson })).server.error, "bad response");
    const http500 = stubFetch({ [`${OL}/api/tags`]: () => new Response("x", { status: 500 }) });
    assert.equal((await probeServer({ kind: "ollama", url: OL }, { fetch: http500 })).server.error, "HTTP 500");
    const weird = stubFetch({ [`${P8000}/v1/models`]: () => ({ data: "not a list" }) });
    assert.deepEqual((await probeServer({ kind: "vllm", url: P8000 }, { fetch: weird })).models, []);
    const bun = (async () => { throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }); }) as unknown as typeof fetch;
    assert.equal((await probeServer({ kind: "vllm", url: P8000 }, { fetch: bun })).server.error, "refused", "Bun's fetch, as release bundles run");
  });
  test("auto on a shared port needs a real model list: a dev API's {} or {error} with a 200 is no model server", async () => {
    for (const body of [{}, { error: "not found" }, { models: [] }]) {
      const { server, models } = await probeServer({ kind: "auto", url: P8000 }, { fetch: stubFetch({ [`${P8000}/v1/models`]: () => body }) });
      assert.deepEqual(server, { id: P8000, kind: "openai", baseUrl: `${P8000}/v1`, ok: false, error: "bad response", endpoints: [], models: 0 }, JSON.stringify(body));
      assert.deepEqual(models, []);
    }
    assert.equal((await probeServer({ kind: "auto", url: P8000 }, { fetch: stubFetch({ [`${P8000}/v1/models`]: () => ({ object: "list", data: [] }) }) })).server.ok, true, "an empty but real list is a server");
  });
  test("a hung server times out quickly", async () => {
    const t0 = Date.now();
    const { server } = await probeServer({ kind: "vllm", url: P8000 }, { fetch: withHang({ [`${P8000}/v1/models`]: hang }), timeoutMs: 50 });
    assert.equal(server.error, "timeout");
    assert.ok(Date.now() - t0 < 1000, "bounded by the timeout");
  });
});

describe("discoverLocalModels", () => {
  test("probes every default server in parallel and returns every downloaded model", async () => {
    const snap = await discoverLocalModels({ env: {}, fetch: stubFetch(ALL) });
    assert.deepEqual(snap.servers.map((s) => [s.id, s.kind, s.ok, s.models]), [[OL, "ollama", true, 3], [LM, "lmstudio", true, 3], [P8000, "vllm", true, 1], [P8080, "llamacpp", true, 1]]);
    assert.equal(snap.models.length, 8);
    assert.ok(snap.models.some((m) => m.id === "google/gemma-4-e4b" && m.loaded === false), "not-loaded models are included");
    assert.match(snap.key, /^[0-9a-f]{16}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, "plain JSON");
  });
  test("one server hanging or down doesn't hide the others, and the whole scan stays short", async () => {
    const t0 = Date.now();
    const snap = await discoverLocalModels({ env: {}, timeoutMs: 80, fetch: withHang({ ...ALL, [`${OL}/api/tags`]: hang, [`${OL}/api/ps`]: hang, [`${P8000}/v1/models`]: hang, [`${P8080}/v1/models`]: () => new Response("", { status: 503 }) }) });
    assert.ok(Date.now() - t0 < 1500, `parallel, bounded: ${Date.now() - t0}ms`);
    assert.deepEqual(snap.servers.map((s) => [s.id, s.ok, s.error ?? ""]), [[OL, false, "timeout"], [LM, true, ""], [P8000, false, "timeout"], [P8080, false, "HTTP 503"]]);
    assert.equal(snap.models.length, 3);
  });
  test("contacts only the default localhost ports and configured URLs", async () => {
    const calls: string[] = [];
    await discoverLocalModels({ env: { LMSTUDIO_BASE_URL: "http://10.0.0.2:1234/v1" }, fetch: stubFetch({}, calls) });
    const hosts = new Set(calls.map((c) => new URL(c.split(" ")[1]).host));
    assert.deepEqual([...hosts].sort(), ["10.0.0.2:1234", "localhost:11434", "localhost:8000", "localhost:8080"]);
  });
  test("explicit targets replace the defaults", async () => {
    const calls: string[] = [];
    const snap = await discoverLocalModels({ targets: [{ kind: "vllm", url: P8000 }], fetch: stubFetch(ALL, calls) });
    assert.deepEqual(calls, [`GET ${P8000}/v1/models`]);
    assert.equal(snap.models.length, 1);
  });
});

describe("Ollama /api/show: bounded and reusable", () => {
  const MANY = { models: Array.from({ length: 12 }, (_, i) => ({ name: `m${i}:latest`, model: `m${i}:latest`, digest: `d${i}`, size: 1, details: {} })) };
  const SHOW = { capabilities: ["completion", "tools"], model_info: { "llama.context_length": 8192 } };
  test("at most OLLAMA_SHOW_CONCURRENCY calls in flight", async () => {
    let now = 0, peak = 0;
    const show: Route = async () => { peak = Math.max(peak, ++now); await new Promise((r) => setTimeout(r, 5)); now--; return SHOW; };
    const { models } = await probeServer({ kind: "ollama", url: OL }, { fetch: stubFetch({ [`${OL}/api/tags`]: () => MANY, [`${OL}/api/show`]: show }) });
    assert.equal(models.length, 12);
    assert.ok(models.every((m) => m.toolUse === true), "every model still gets its capabilities");
    assert.equal(peak, OLLAMA_SHOW_CONCURRENCY);
  });
  test("a cached answer is reused: a /api/show failing on a later scan doesn't change the key", async () => {
    const cache = new Map<string, any>();
    const calls: string[] = [];
    let fail = "";
    const routes: Record<string, Route> = { [`${OL}/api/tags`]: () => MANY, [`${OL}/api/show`]: (b) => (b.model === fail ? new Response("", { status: 500 }) : SHOW) };
    const scan = () => discoverLocalModels({ targets: [{ kind: "ollama", url: OL }], fetch: stubFetch(routes, calls), ollamaShowCache: cache });
    const first = await scan();
    assert.equal(calls.filter((c) => c.endsWith("/api/show")).length, 12);
    assert.equal(first.models[0].digest, "d0");
    calls.length = 0; fail = "m3:latest";
    const second = await scan();
    assert.equal(calls.filter((c) => c.endsWith("/api/show")).length, 0, "nothing re-read for an unchanged digest");
    assert.equal(second.key, first.key);
    assert.deepEqual(second, first);
    // Without the cache the same failure would have flapped the key: that is what the cache prevents.
    const uncached = await discoverLocalModels({ targets: [{ kind: "ollama", url: OL }], fetch: stubFetch(routes) });
    assert.notEqual(uncached.key, first.key);
  });
  test("a new digest is asked again, and models gone from the server leave the cache", async () => {
    const cache = new Map<string, any>([["http://other:11434 x@y", SHOW]]);
    const calls: string[] = [];
    let tags: any = MANY;
    const fetch = stubFetch({ [`${OL}/api/tags`]: () => tags, [`${OL}/api/show`]: () => SHOW }, calls);
    await probeServer({ kind: "ollama", url: OL }, { fetch, ollamaShowCache: cache });
    tags = { models: [{ ...MANY.models[0], digest: "new" }, MANY.models[1]] };
    calls.length = 0;
    await probeServer({ kind: "ollama", url: OL }, { fetch, ollamaShowCache: cache });
    assert.deepEqual(calls.filter((c) => c.endsWith("/api/show")), [`POST ${OL}/api/show`], "only the re-pulled model");
    assert.deepEqual([...cache.keys()].sort(), [`${OL} m0:latest@new`, `${OL} m1:latest@d1`, "http://other:11434 x@y"], "another server's entries are left alone");
  });
  test("without a digest nothing is cached", async () => {
    const cache = new Map<string, any>();
    await probeServer({ kind: "ollama", url: OL }, { fetch: stubFetch(ALL), ollamaShowCache: cache });
    assert.equal(cache.size, 0);
  });
});

describe("change detection", () => {
  const scan = (routes: Record<string, Route>) => discoverLocalModels({ env: {}, fetch: stubFetch(routes) });
  test("the same state gives the same key and an identical snapshot, whatever order answers arrive in", async () => {
    const a = await scan(ALL);
    const slow = (r: Route): Route => async (b) => { await new Promise((res) => setTimeout(res, 15)); return r(b); };
    const b = await scan({ ...ALL, [`${LM}/api/v0/models`]: slow(ALL[`${LM}/api/v0/models`]), [`${OL}/api/tags`]: slow(ALL[`${OL}/api/tags`]) });
    assert.deepEqual(b, a);
  });
  test("loading a model, downloading one, or a server going away changes the key", async () => {
    const base = (await scan(ALL)).key;
    const loaded = { data: LMSTUDIO_NATIVE.data.map((m) => (m.id === "google/gemma-4-e4b" ? { ...m, state: "loaded", loaded_context_length: 32768 } : m)) };
    assert.notEqual((await scan({ ...ALL, [`${LM}/api/v0/models`]: () => loaded })).key, base, "newly loaded");
    const pulled = { models: [...OLLAMA_TAGS.models, { name: "qwen3:8b", model: "qwen3:8b", size: 1, details: {} }] };
    assert.notEqual((await scan({ ...ALL, [`${OL}/api/tags`]: () => pulled })).key, base, "newly downloaded");
    const { [`${P8000}/v1/models`]: _gone, ...noVllm } = ALL;
    assert.notEqual((await scan(noVllm)).key, base, "server stopped");
  });
  test("a dead server's changing error doesn't change the key", async () => {
    const { [`${P8000}/v1/models`]: _gone, ...noVllm } = ALL;
    const refused = await scan(noVllm);
    const errored = await scan({ ...noVllm, [`${P8000}/v1/models`]: () => new Response("", { status: 502 }) });
    assert.notEqual(refused.servers.find((s) => s.id === P8000)!.error, errored.servers.find((s) => s.id === P8000)!.error);
    assert.equal(errored.key, refused.key);
  });
  test("snapshotKey ignores field order", () => {
    const m1 = { id: "a", server: LM, kind: "lmstudio" as const, loaded: true };
    const m2 = { loaded: true, kind: "lmstudio" as const, server: LM, id: "a" };
    const s = (m: any): Pick<DiscoverySnapshot, "servers" | "models"> => ({ servers: [{ id: LM, kind: "lmstudio", baseUrl: `${LM}/v1`, ok: true, endpoints: [], models: 1 }], models: [m] });
    assert.equal(snapshotKey(s(m1)), snapshotKey(s(m2)));
  });
});
