import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRunSettings, RUN_SETTINGS_ENV, settingValues } from "../src/settings.js";
import { renderGuru } from "../src/guru.js";
import type { DownRunSpec, RunSpecSettings } from "../src/protocol.js";

function spec(guru: Partial<DownRunSpec["guru"]> = {}, settings?: unknown): DownRunSpec {
  return {
    t: "run.spec",
    session: { id: "s1", name: "s1", cwd: "/workspace" },
    guru: { model: "litellm/tape-model", ...guru },
    snapshot: {},
    secrets: {},
    ...(settings !== undefined ? { settings: settings as RunSpecSettings } : {}),
    idleStopSeconds: 600,
    checkpointEvery: "turn",
  };
}

const SETTINGS: RunSpecSettings = {
  schemaVersion: 1,
  profile: "work",
  values: {
    "model.default": { value: "litellm/claude-auto-llm", source: "profile", sourceName: "work" },
    "model.thinking": { value: "high", source: "user" },
    "compaction.summaryModel": { value: "litellm/gpt-5.4-nano", source: "user" },
    "compaction.masking": { value: false, source: "user" },
    "memory.mode": { value: "auto", source: "user" },
    "voice.language": { value: "en", source: "default" },
  },
};

test("settings: no settings, or an empty set, leaves the spec untouched", () => {
  const plain = spec();
  assert.equal(applyRunSettings(plain), plain);
  const empty = spec({}, { schemaVersion: 1, profile: null, values: {} });
  assert.equal(applyRunSettings(empty), empty);
  const malformed = spec({}, "nonsense");
  assert.equal(applyRunSettings(malformed), malformed);
});

test("settings: the tape's own model, thinking and summarizer win", () => {
  const out = applyRunSettings(spec({ thinking: "low", env: { KERNAL_SUMMARY_MODEL: "litellm/tape-summarizer" } }, SETTINGS));
  assert.equal(out.guru.model, "litellm/tape-model");
  assert.equal(out.guru.thinking, "low");
  assert.equal(out.guru.env?.KERNAL_SUMMARY_MODEL, "litellm/tape-summarizer");
});

test("settings: fill the gaps the tape leaves (model, thinking, summarizer), and log key names only", () => {
  const lines: string[] = [];
  const input = spec({ model: " " }, SETTINGS);
  const out = applyRunSettings(input, (line) => lines.push(line));
  assert.equal(out.guru.model, "litellm/claude-auto-llm");
  assert.equal(out.guru.thinking, "high");
  assert.equal(out.guru.env?.KERNAL_SUMMARY_MODEL, "litellm/gpt-5.4-nano");
  // The input spec is not mutated.
  assert.equal(input.guru.model, " ");
  assert.equal(input.guru.env, undefined);
  assert.deepEqual(lines, ["settings: applied model.default, model.thinking, compaction.summaryModel from the owner's settings"]);
  assert.ok(!lines.join("").includes("claude-auto-llm"));
});

test("settings: memory.mode never turns Agent Engine memory on in a Drive", () => {
  const out = applyRunSettings(spec({}, SETTINGS));
  assert.equal(out.guru.memory, undefined);
  const tape = applyRunSettings(spec({ memory: "tool" }, SETTINGS));
  assert.equal(tape.guru.memory, "tool");
});

test("settings: the whole set goes to Kernal as KERNAL_RUN_SETTINGS, values and their levels", () => {
  const out = applyRunSettings(spec({ env: { FOO: "bar" } }, SETTINGS));
  assert.equal(out.guru.env?.FOO, "bar");
  const parsed = JSON.parse(out.guru.env![RUN_SETTINGS_ENV]!);
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    profile: "work",
    values: {
      "model.default": "litellm/claude-auto-llm",
      "model.thinking": "high",
      "compaction.summaryModel": "litellm/gpt-5.4-nano",
      "compaction.masking": false,
      "memory.mode": "auto",
      "voice.language": "en",
    },
    sources: {
      "model.default": "profile",
      "model.thinking": "user",
      "compaction.summaryModel": "user",
      "compaction.masking": "user",
      "memory.mode": "user",
      "voice.language": "default",
    },
  });
  // It survives renderGuru (not a denylisted key) into pi's environment.
  const rendered = renderGuru(out.guru, { piBin: "pi", sessionFile: "/s.jsonl" });
  assert.equal(rendered.env[RUN_SETTINGS_ENV], out.guru.env![RUN_SETTINGS_ENV]);
  // A tape that sets it itself keeps its own.
  const own = applyRunSettings(spec({ env: { [RUN_SETTINGS_ENV]: "{}" } }, SETTINGS));
  assert.equal(own.guru.env?.[RUN_SETTINGS_ENV], "{}");
});

test("settings: values of the wrong type and unknown thinking levels are ignored", () => {
  const out = applyRunSettings(
    spec({ model: "" }, {
      schemaVersion: 2,
      profile: null,
      values: {
        "model.default": { value: 42, source: "user" },
        "model.thinking": { value: "ludicrous", source: "user" },
        "compaction.summaryModel": { value: "", source: "user" },
        "future.key": { value: { nested: true }, source: "user" },
        broken: "not an entry",
        "some.number": { value: Number.NaN, source: "user" },
      },
    }),
  );
  assert.equal(out.guru.model, "");
  assert.equal(out.guru.thinking, undefined);
  assert.equal(out.guru.env?.KERNAL_SUMMARY_MODEL, undefined);
  assert.deepEqual(JSON.parse(out.guru.env![RUN_SETTINGS_ENV]!), { schemaVersion: 2, profile: null, values: { "model.default": 42, "model.thinking": "ludicrous", "compaction.summaryModel": "" }, sources: { "model.default": "user", "model.thinking": "user", "compaction.summaryModel": "user", "future.key": "user", "some.number": "user" } });
});

test("settingValues: only well-formed entries", () => {
  assert.equal(settingValues(undefined), undefined);
  assert.equal(settingValues({ values: [] }), undefined);
  assert.deepEqual(settingValues({ values: { a: { value: true }, b: { value: "x" }, c: { nope: 1 } } }), { a: true, b: "x" });
});
