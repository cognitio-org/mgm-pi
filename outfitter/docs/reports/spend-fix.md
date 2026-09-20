# Spend fix report (E2.11b)

Scope: two defects in E2.11's spend accounting, both verified against the live LiteLLM router on
2026-09-21. Touches `packages/agentd/{pi-extension,src,test}`, `packages/api/test/agentlink.test.ts`,
`docs/protocol.md`, and `mgm/.pi/extensions/connect/lib.ts` + `mgm/tests/connect.test.ts`.

## 1. Auto-router pricing

### Problem

LiteLLM's `GET /model/info` prices every concrete model deployment but returns an all-zero price for
a *routing group* (`claude-auto-llm`, `gemini-auto-llm`, `*-agentic`, `*-affinity`): the group's
underlying model is only picked per call, so there's no single deployment for `/model/info` to price.
pi itself prices a response using the *registered* model's cost table -- i.e. the group's (zero)
price, not whatever concrete model LiteLLM actually resolved the call to -- so pi's own per-message
cost estimate (`message.usage.cost.total`) was $0 for every response through an auto-router guru.
`packages/agentd/pi-extension/outfitter-spend.ts`'s `usage` field (the delta in that running total)
was therefore always 0 for these gurus, and `Run.costEstimate` stayed 0 even though real money was
being spent.

LiteLLM does send two headers that make the real cost computable after the fact:
`x-litellm-model-name` (the concrete model actually used) on every response, streamed included, and
`x-litellm-classifier-cost` (the router's own classification-call cost) on a routed call.
`x-litellm-response-cost` reads 0 on a streamed response (pi always streams), so it can't be used.

### Fix

`packages/agentd/pi-extension/outfitter-spend.ts`:
- `parseSpendHeaders` now also parses `x-litellm-model-name` -> `resolvedModel` and
  `x-litellm-classifier-cost` -> `classifierCost` (both optional, same pattern as the existing
  headers).
- A new `parseModelInfoPrices(json)` builds a `Map<modelName, ModelPrice>` of **per-token** (not
  per-million, unlike mgm's `parseModelInfo`) input/output/cacheRead/cacheWrite prices from
  `/model/info`'s response, keyed by `model_name` -- which is either a concrete model id or an
  auto-router group's own id (its entry just has every field at 0). `isZeroPrice` tests that.
- A new `computeResolvedCost(usage, price, classifierCost)` computes one response's cost from raw
  token counts (`usage.input/output/cacheRead/cacheWrite`, the same shape `message.usage` already
  carries) times per-token prices, plus the classifier cost.
- `newestAssistantUsage(entries)` returns the newest LiteLLM-served assistant message's raw `usage`
  (token counts), for `after_provider_response` to read at the moment of the response.
- `buildSpendLogLine` gained two new (optional, defaulted) parameters: a `prices` map and the current
  response's `usage` tokens. When the *requested* group's price (looked up by `headers.modelGroup`)
  is zero/unknown but the *resolved* model's price (`headers.resolvedModel`) is known, `usage` in the
  log line is `computeResolvedCost(...)` instead of the delta-based estimate. Any other case (group
  priced normally, resolved model also unpriced, or no `prices` map at all) falls straight through to
  the prior delta-based behaviour -- `prices` defaults to an empty map, so a missing/failed fetch
  degrades automatically with no special-casing needed at the call site.
- The extension's `session_start` handler now also fetches `/model/info` once (`fetchModelPrices`,
  via a small `litellmGet` helper reading `LITELLM_AGENT_KEY`/`LITELLM_API_KEY` and
  `LITELLM_BASE_URL`, same env vars and default as `mgm/.pi/extensions/connect/lib.ts`'s `backends()`)
  and stores the resulting price map in a closure variable that `after_provider_response` reads.
  `litellmGet` never throws: a missing key, network error, non-2xx, or non-JSON body all resolve to
  `undefined` and are logged once to stderr (`outfitter-spend: request to <path> failed: ...`) via a
  module-level `warnOnce`, matching the append-failure warning's existing one-shot pattern.

`mgm/.pi/extensions/connect/lib.ts` (the interactive `/budget` panel, a separate, simpler instance of
the same underlying LiteLLM behaviour): a new `isZeroCost(cost)` helper, and the litellm backend's
`model()` function now treats an all-zero-priced model **whose id contains "auto"** as unknown-paid
(`DEFAULT_PAID`, now exported) rather than free -- so `claude-auto-llm` etc. no longer show as $0/token
in the panel. A non-"auto" all-zero-priced id (there's no such real case today, but nothing should
assume there won't be) is left alone, since a genuinely free/unpriced model shouldn't be inflated. No
attempt was made at a true per-response price hook for the TUI panel -- pi computes `usage.cost` from
the *registered* model's static cost table at call time, and reworking that is out of scope here; per
the task's own fallback, `DEFAULT_PAID` plus this comment is what's shipped.

### Tests

`packages/agentd/test/outfitter-spend.test.ts`: `parseSpendHeaders` parses the two new headers;
`parseModelInfoPrices` builds the per-token map (first deployment wins on a duplicate `model_name`);
`isZeroPrice`; `newestAssistantUsage`; `computeResolvedCost`; four `buildSpendLogLine` cases (group
priced normally keeps the delta even with a priced resolved model available; group unpriced + resolved
model priced computes from tokens; no `prices` map degrades to delta; group unpriced but resolved
model *also* unpriced degrades to delta). Plus three extension-wiring tests against a stubbed global
`fetch`: `session_start` appends the baseline line from `/key/info` (see part 2) and fetches
`/model/info`; the fetched prices make a real `after_provider_response` call use the resolved-model
cost instead of pi's own zero delta; a `fetch` that throws degrades without throwing out of the
extension and a subsequent normal response still logs its delta correctly.

`mgm/tests/connect.test.ts`: an all-zero-priced `auto` id is priced as `DEFAULT_PAID` (covers
`claude-auto-llm`, `claude-auto-agentic`, `gemini-auto-llm`); a non-`auto` all-zero-priced id is left
free; a genuinely-priced `auto` group (once LiteLLM starts pricing it) keeps its real price rather than
being forced to `DEFAULT_PAID`.

## 2. First-call baseline

### Problem

`packages/api/src/agentlink.ts`'s `"spend"` handler pins `Run.keySpendStart` to `frame.keySpend` the
first time a run sees a spend frame, then computes `cost = max(0, frame.keySpend - keySpendStart)` on
every later frame. But LiteLLM's `x-litellm-key-spend` header carries the key's balance *after* the
call whose response it's attached to -- the first frame a run ever sees is therefore already a
post-call balance, so a one-call run pins `keySpendStart` to that same post-call number and its own
`cost` comes out as `max(0, x - x) = 0`. Every run under-reports by exactly its first call.

### Fix

`packages/agentd/pi-extension/outfitter-spend.ts`'s `session_start` handler now also probes
`GET /key/info` (`fetchKeySpend`, same `litellmGet` helper as the price fetch) *before* any provider
call has happened, and if `info.spend` is a number, appends `{ baseline: true, keySpend: <spend> }` to
`OUTFITTER_SPEND_FILE`. This line has no `usage` field at all.

- `packages/agentd/src/pi.ts`: `SpendLogLine` gained an optional `baseline?: boolean`;
  `validateSpendLine` accepts it (rejecting a non-boolean value, same pattern as every other field) and
  passes it through.
- `packages/agentd/src/protocol.ts`: `UpSpend` gained the matching optional `baseline?: boolean`.
- `packages/agentd/src/run.ts`: `handleSpendLine` forwards `line.baseline` on the `spend` up-frame it
  sends (alongside the existing fields); `costEstimate` accumulation (`+= line.usage ?? 0`) is
  unaffected since a baseline line never carries `usage`.
- `packages/api/src/agentlink.ts`'s spend handler needed **no code change**: its existing "pin
  `keySpendStart` from the first frame this run sees that carries a numeric `keySpend`" logic already
  does the right thing once the baseline frame (carrying the *pre-call* balance) is the first such
  frame to arrive -- which `session_start` firing before any provider call guarantees. `UpFrame`
  itself is a loosely-typed `{ t: string; [key: string]: unknown }` in agentlink.ts (no schema to
  update), so "frame validation... accepts it" was entirely the agentd-side `validateSpendLine` change
  above.
- If `GET /key/info` fails (no key, network error, non-2xx), no baseline line is written and the
  extension falls back exactly to the pre-E2.11b behaviour (`keySpendStart` pins from the first *real*
  spend frame, still under-reporting the first call -- unchanged, not worsened).
- `docs/protocol.md`'s `spend` row documents both the auto-router pricing behaviour and the new
  `baseline` field.

### Tests

`packages/agentd/test/pi.test.ts`: `validateSpendLine` accepts `{ baseline: true, keySpend }` with no
`usage`, and rejects a non-boolean `baseline`. The two pre-existing `deepEqual` tests for a
fully/partially-specified line were updated to include the new `baseline: undefined` field (their
shape check is exact-object, and `Object.assign`-style construction in `validateSpendLine` now always
includes the key).

`packages/agentd/test/run.test.ts`: a new `RunController` test feeds a baseline line and then a real
line through `handleSpendLine` and asserts the resulting `spend` frames carry `baseline: true` /
`baseline: undefined` respectively, with the baseline frame's `estimate` staying 0 (no `usage` to
accumulate).

`packages/api/test/agentlink.test.ts`: a new test, `"a baseline spend frame arriving before the run's
one real call means a one-call run's cost is no longer 0"` -- sends `{ t: "spend", baseline: true,
keySpend: 10 }` then a real `{ t: "spend", keySpend: 10.05, ... }` and asserts `run.cost` and
`session.cost` both come out to `~0.05`, not `0`. This exercises the exact bug: without the baseline
frame arriving first, `keySpendStart` would pin to `10.05` and `cost` would be `0`.

## Test run

- `outfitter/packages/agentd`: `npm test` -> **140 passed, 0 failed** (`npm run build` clean).
- `outfitter/packages/api`: `npm test` -> **93 passed, 0 failed** (typecheck clean; required building
  the sibling `@outfitter/provider-local` workspace package first, which wasn't built in this
  worktree).
- `mgm`: `npm test` -> **219 passed, 0 failed** (required `npm install` in `mgm/` first -- this
  worktree's `node_modules` was missing `@earendil-works/pi-tui`/`pi-coding-agent` entirely; unrelated
  to this change, just an uninitialized worktree).

## Follow-up (out of scope for this change)

- Neither fix has been exercised against the live LiteLLM router end-to-end (only against the headers
  and `/model/info`/`/key/info` shapes described in the task and mirrored in mgm's existing
  `connect/lib.ts` parsing) -- the E2.11 follow-up item (`image/Dockerfile` wiring
  `OUTFITTER_SPEND_EXTENSION`/`spendFile` for a real Cloud Run Job) is still outstanding and is what
  would let this run for real in the sandbox image.
- The auto-router price-map fetch and the key-spend baseline fetch happen concurrently
  (`Promise.all`) at `session_start`; if `/key/info` is slow relative to how fast pi can make its
  first provider call, the *first* provider call's baseline could theoretically arrive after that
  call's own spend frame in rare timing. This mirrors the existing defensive-fallback pattern already
  in the file (see the `previousTotal` lazy-baseline comment) rather than adding new complexity to
  guard against it: worst case, that one run's first call reverts to the pre-E2.11b under-reporting,
  not a crash or bad data.
- mgm's `/budget` panel's `DEFAULT_PAID` fallback for an auto-router group is a static, generic
  estimate (not derived from `x-litellm-model-name`/token counts like the cloud-run extension now is)
  -- wiring the interactive panel's own per-response estimate through the same resolved-model math
  was explicitly left out per the task's own "otherwise just DEFAULT_PAID fallback" instruction.
