# Gurus page and session header (E3.7 / E3.8)

## What

**E3.7 — Gurus page** (`/gurus`, nav link "Gurus", any signed-in user; org-shared, same visibility
policy as everything else in Outfitter per EPIC.md's "Session visibility" decision):

- Lists gurus: name, model, thinking, updated.
- Create/edit form (`GuruForm.tsx`, shared by both) with name, model, fallback model, thinking
  level, system prompt, append system prompt, tools, exclude tools, and env key/value rows.
- Model and fallback-model pickers (`ModelPicker.tsx`) are a filterable list of the LiteLLM
  router's models, sourced from a new `GET /api/models`, plus free text (a guru may name any
  `provider/id`, including one this deployment's router doesn't currently list).
- "New session with this guru" opens the existing `NewSessionDialog`, now accepting an
  `initialGuruId` prop to preselect the dropdown.
- `DELETE /api/gurus/:id`: 404 if the guru doesn't exist, 400 for the reserved `default` id, 409
  with `{count}` if any session still references it, else 204.

**E3.8 — Session header**: the session page's header now shows the model actually in use, the
thinking level, and context use (tokens / window, as a percentage bar), derived from the
transcript entries the page already has -- **zero protocol change**.

## Where

API:
- `packages/api/src/models.ts` — `ModelsService` (fetch LiteLLM `/model/info`, 5 min in-memory
  cache, single-flight, merges `config.localModels`), plus the pure `rowsFromModelInfoMeta`,
  `isAutoRouterGroupName`, `mergeLocalModels`.
- `packages/api/src/routes/models.ts` — `GET /api/models` (thin wrapper over `ModelsService`).
- `packages/api/src/routes/gurus.ts` — exported `DENYLISTED_GURU_ENV_KEYS` /
  `DENYLISTED_GURU_ENV_PREFIXES`, `THINKING_LEVELS`, `isValidModelRef`/`isValidThinkingLevel`;
  `GET /api/gurus/meta`; `model`/`fallbackModel`/`thinking` validation on POST and PUT;
  `DELETE /api/gurus/:id`.
- `packages/api/src/store/types.ts`, `store/memory.ts`, `store/mongo.ts` — `GurusCollection.delete`.
- `packages/api/src/providers-status.ts` — exported `fetchJson` and `DEFAULT_TIMEOUT_MS` so
  `models.ts` reuses the same bounded-GET helper instead of a second implementation.
- `packages/api/src/routes/context.ts`, `server.ts`, `routes/index.ts` — wire `modelsService`
  through `RouteContext`, built once in `server.ts` sharing the same LiteLLM key resolver
  (`config.litellmAdminKey || secretsBroker.defaultLitellmKey()`) the E2.10 provider status
  service already uses.
- Tests: `packages/api/test/models.test.ts` (service + route), additions to
  `packages/api/test/gurus.test.ts` (validation, meta, delete rules).

Web:
- `packages/web/src/lib/session-header.ts` — `deriveSessionHeader`, the pure E3.8 derivation, plus
  `packages/web/test/session-header.test.ts`.
- `packages/web/src/lib/model-filter.ts` — `filterModels`, the pure filter `ModelPicker` uses, plus
  `packages/web/test/model-filter.test.ts` (this package has no React Testing Library set up, so
  the filtering logic is split out and tested directly, same pattern as `entry-view.ts` /
  `session-stream.ts`'s `mergeEntries`).
- `packages/web/src/components/ModelPicker.tsx`, `GuruForm.tsx` — new.
- `packages/web/src/pages/GurusPage.tsx` — new, registered in `App.tsx` with a "Gurus" nav link.
- `packages/web/src/components/NewSessionDialog.tsx` — additive `initialGuruId?` prop.
- `packages/web/src/api/client.ts` — `ModelRow`, `GuruMeta`, `GuruInput` types; `models()`,
  `guruMeta()`, `createGuru()`, `updateGuru()`, `deleteGuru()`.
- `packages/web/src/pages/SessionPage.tsx` — fetches `GET /api/models` once per visit, calls
  `deriveSessionHeader(entries, windowFor)`, renders model/thinking/context-bar in the header.
- `packages/web/src/style.css` — `.meter` (context bar, mirroring the visual language of
  `mgm/.pi/extensions/mgm-admin/app.ts`'s Overview context meter: warn ≥50%, error ≥80%),
  `.model-picker*`, `.env-row`, `.mono`.
- Tests: `packages/web/test/client.test.ts` additions for the new client calls.

## Choices and why

- **`GET /api/gurus/meta` as a separate route, not folded into `/api/models`.** `/api/models` is
  model data (id, price, context window); the env denylist and thinking levels are guru-domain
  form data with nothing to do with LiteLLM. Keeping them apart means a caller of one never has to
  ignore fields it doesn't care about, and `/api/gurus/meta` has room to grow with future
  guru-level limits without touching the models endpoint's shape.
- **Auto-router marking.** `isAutoRouterGroupName` matches the E2.11b-documented group names
  (`claude-auto-*`, `gemini-auto-*`, `*-agentic`, `*-affinity`) *and* requires the LiteLLM-reported
  price to be exactly zero before marking a row `auto: true` — a model that happens to share the
  naming convention but is actually priced is never mis-marked.
- **`GET /api/models` never throws on a LiteLLM failure** (no key configured, network error,
  non-2xx): it resolves to `[]` for the LiteLLM part and still returns `config.localModels` rows.
  The Gurus page's model picker still works (as free text, or against local models) even with
  LiteLLM entirely unreachable.
- **Model/thinking validation lives in `routes/gurus.ts`, matching agentd's own denylist/format
  expectations.** `isValidModelRef` requires the pi `provider/id` shape (`rpc.md`'s `--model`
  flag); `THINKING_LEVELS` is the literal list pi's `thinking-selector.js` (`LEVEL_DESCRIPTIONS`)
  offers — `off, minimal, low, medium, high, xhigh, max` — there is no `--help` enumeration of
  this in pi, so it's transcribed here with a comment pointing at the source. A regex mistake
  would otherwise reach agentd (`guru.ts`'s `renderModelArg`) and fail deep inside the sandbox
  instead of at save time.
- **`default` guru undeletable.** There is no seed script creating an `id: "default"` guru yet
  (that's a later story, likely alongside E5.1's YAML gurus) — the id is reserved now, in the
  delete route, so an operator who does create one later doesn't inherit a footgun. The check is a
  plain id comparison, not a `name` check, matching how the codebase already treats ids as the
  stable identity and names as display-only.
- **E3.8's derivation adds no protocol field.** `docs/protocol.md`'s `entry` frames already carry
  everything needed: `model_change` (`provider`, `modelId`), `thinking_level_change`
  (`thinkingLevel`), and an assistant `message` entry's own `provider`/`model`/`usage` — these are
  pi's own JSONL entry shapes (`session-manager.js`'s `appendModelChange` /
  `appendThinkingLevelChange` / `appendMessage`), unchanged since agentd already forwards every
  `entry` frame verbatim. `calculateContextTokens`'s exact formula (`totalTokens` or the four-field
  sum) and `getContextUsage`'s aborted/error-skip rule were read directly from
  `@earendil-works/pi-coding-agent`'s compiled source (`dist/core/compaction/compaction.js`,
  `dist/core/agent-session.js`) to make sure `deriveSessionHeader` matches pi's own number instead
  of drifting from it.
- **"Newest of either" for model.** The task text was "model from the newest `model_change` entry
  or the newest assistant message's `provider/model`". Implemented as: walk entries in order,
  overwrite `model` on *either* a `model_change` entry or an assistant message carrying
  `provider`+`model`, so by the end `model` reflects whichever type's entry is more recent in the
  transcript — not "prefer model_change, else fall back to the assistant message" (that would go
  stale after a mid-session `/model` switch that pi logs only as an assistant-message field change,
  if it ever does that instead of a dedicated `model_change` entry).

## What's left

- **ModelPicker has no component-level test.** This web package has no React Testing Library
  dependency installed; the filtering logic itself is unit-tested (`model-filter.test.ts`), but the
  dropdown/keyboard/blur behavior is only exercised by hand. Adding RTL (or a lighter DOM-assertion
  approach) is a separate, cross-cutting call for the whole `packages/web` test setup, not scoped
  to this story.
- **No guru YAML / repo-local `.outfitter/gurus/*.yaml` discovery.** That's E5.1, explicitly out of
  scope here; the Gurus page only talks to the existing `GET/POST/PUT/DELETE /api/gurus` REST
  routes.
- **No seed script for the `default` guru.** The delete route reserves the id; nothing creates one
  yet in a fresh deployment. A deployment with no gurus at all still works today (the Fleet page's
  "No gurus configured" / Gurus page's "No gurus yet" states already handle it) — this is a
  product decision for whoever adds guru seeding, not a bug here.
- **Free-text model entry has no client-side format check beyond the API's own 400.** The
  `ModelPicker` accepts anything typed; `isValidModelRef`'s `provider/id` check runs server-side on
  save and its message is shown inline (`GuruForm`'s `error` state), same pattern as
  `NewSessionDialog`. A live client-side hint (red border while typing an invalid shape) would be a
  small follow-up but wasn't requested.
- **`GET /api/models`'s 5-minute cache is per-process**, same caveat `ProviderStatusService` already
  has documented for its own poll: a fresh Cloud Run instance has no shared view of another
  instance's cache, so a cold instance always fetches once. Not a problem at this scale (the whole
  point of the cache is to spare LiteLLM repeated `/model/info` calls from the same warm instance
  during a session of guru editing).
