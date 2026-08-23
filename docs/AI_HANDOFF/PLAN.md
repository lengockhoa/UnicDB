# PLAN — Cycle J (2026-08-23): AI Core — Config + Provider + Agent Foundation

## §1 Intent

VSDB needs one place to configure an OpenAI-compatible AI backend and a core that uses it —
the LÕI (kernel) every later AI-assist capability builds on. User requirements (verbatim
intent, from `queue/AI-CORE-spec.md`):

1. **AI config storage** — một chỗ config AI; data KHÔNG được public ra ngoài.
   `baseUrl`, `apiKey`, `method`: `responses` | `chat/completions`; 2 model roles:
   `work` (vision-capable, đọc được hình) + `smart` (deep reasoning).
2. **Reconfigurable** — user đổi toàn bộ config bất cứ lúc nào; agent luôn đọc config mới
   nhất lúc chạy, không cache stale.
3. **AI Agent foundation** — multi-turn tool-calling loop, config-driven model routing
   (role→model id), step budget. DB tools là cycle K+.

Success for this cycle = (a) user can store/edit AI settings + apiKey from one **AI Settings**
webview form (key in SecretStorage, never logged/serialized), (b) a pure provider client that
speaks BOTH `chat/completions` and `responses` against any OpenAI-compatible baseUrl with
timeout + error mapping, (c) a pure agent loop that re-reads config each run, routes
role→model, runs multi-turn tool calls with a budget cap, against an (empty) tool registry
seam, (d) all unit-tested with fake fetch/secret storage — no network, no PG container.

## §2 Scope

**In scope (this cycle)**
- `src/ai/settings.ts` — pure types + validation (`AiSettings`, `AiConfig`,
  `aiSettingsErrors`, `normalizeBaseUrl`, `defaultAiSettings`, `redactAiConfig`). No vscode
  import → importable from webview bundle.
- `src/ai/config.ts` — `AiConfigStore` (vscode): settings JSON in globalState, apiKey in
  SecretStorage key `vsdb.ai.apiKey`, fresh `loadConfig()` per call (no instance cache).
- `src/ai/provider.ts` — pure OpenAI-compatible client, injected `fetch`, method switch,
  exported pure body-builders/response-parsers, `ProviderError` (status/timeout/endpoint,
  apiKey-scrubbed snippet).
- `src/ai/agent.ts` — pure `runAgent` loop: config snapshot per run, role→modelId routing,
  tool registry seam (`EMPTY_TOOL_REGISTRY`), max-steps budget, vision guard.
- `src/ui/aiSettingsForm.ts` + `src/ui/aiSettingsFormMessages.ts` + `webview/aiSettingsFormMain.ts`
  (mirror ConnectionForm/NewTableForm pattern), esbuild entry, `vsdb.openAiSettings` command
  wiring in `package.json` + `src/extension.ts`, README privacy/egress section.
- Unit tests only (vitest; fake vscode / fake fetch / fake registry). No integration tests.

**Out of scope (cycle J)** — scope guard table:

| Guard | Rule |
|---|---|
| DB tools | NO DB tools. `ToolRegistry` interface + `EMPTY_TOOL_REGISTRY` only; DB-aware tools = cycle K+ |
| Streaming | NO streaming. Single-shot request/response per provider call |
| Chat panel UI | NO chat/assistant panel. Only the settings form; agent consumed programmatically |
| Non-OpenAI protocols | NO Anthropic/native protocols. `method` enum is exactly `'responses' \| 'chat/completions'` |
| Model roles | Exactly 2: `work` (vision flag default true) + `smart`. No extra roles |
| Live network in tests | Fake fetch only; real-endpoint compat is user-verified via the form's Test button |
| DB/container | No PG dependency this cycle (independent subsystem) |

**Backlog (queued cycles):** DB-aware tools + "Add to AI Prompt" (cycle K+), streaming +
chat panel (sau khi core ổn), Anthropic protocol (not requested).

**File-wave constraint:** same-wave tasks share NO target file (§7 table authoritative).

## §3 Approach

**Architecture — three pure modules under `src/ai/` + one webview form (established patterns):**

- **Storage split (mirrors `src/core/connectionManager.ts`):** non-secret settings JSON →
  globalState key `vsdb.ai.settings`; apiKey → SecretStorage key `vsdb.ai.apiKey` (never in
  globalState, logs, errors, telemetry, or test snapshots beyond the store itself). AI config
  is machine-global, not per-workspace — one chỗ cho toàn extension. `save()` validates via
  `aiSettingsErrors` FIRST, stores the secret, then the settings (secret failure ⇒ nothing
  persisted, throw). `loadConfig()` always reads both stores — no caching anywhere, which is
  how "reconfigurable, never stale" is guaranteed structurally.
- **Provider = pure module, injected fetch (style of `src/core/ddl/*`):** no vscode import,
  no global fetch call — `createProviderClient({baseUrl, apiKey, method, timeoutMs, fetch?})`
  returns `{complete(req)}`. Method switch isolated in EXPORTED pure functions
  (`buildChatCompletionsBody`, `buildResponsesBody`, `parseChatCompletionsResponse`,
  `parseResponsesResponse`) so each mapping is unit-testable without fetch. Agent messages
  use the chat shape (`ChatMessage`); the `responses` mapping (system→`instructions`,
  user/assistant/tool→`input` items, `function_call_output`) lives ONLY in the provider —
  agent stays method-agnostic. Timeout via `AbortController`; non-2xx / network / bad-JSON →
  `ProviderError {status?, timeout, endpoint, bodySnippet}` where `bodySnippet` is scrubbed
  of the apiKey (evil-server echo case). Vision = message content parts
  (`image_url` data URL / `input_image`) — provider maps, agent attaches.
- **Agent = pure loop, everything injected:** `runAgent(input, deps)` with
  `deps.loadConfig()` (bound `AiConfigStore.loadConfig`) + `deps.complete(cfg, role, req)` +
  optional `registry`. Per RUN: load config once (fresh snapshot; null → throw
  "AI is not configured"), vision-guard, then loop: complete → record step → execute tool
  calls via registry (unknown tool / throwing tool ⇒ error-string tool result, loop
  CONTINUES so the model can recover) → append tool results → repeat. Stop when a call
  returns no tool calls (`stoppedOnBudget:false`) or after `cfg.maxSteps` provider calls
  (`stoppedOnBudget:true`). Role→model routing: agent sets `req.modelId =
  cfg.models[role].modelId`; run-level role (default `work`), `complete` seam is per-call so
  a later cycle can route mid-run (multi-model). `deps` injection keeps the loop testable
  with fakes exactly like the DDL generators.
- **Settings form (mirrors `src/ui/connectionForm.ts` + `newTableForm.ts`):** host panel +
  typed message protocol (`aiSettingsFormMessages.ts`, `newTableFormMessages.ts` style) +
  vanilla DOM webview entry bundled by esbuild (`dist/aiSettingsForm.js`), strict CSP,
  `retainContextWhenHidden`, single instance, reveal-on-reshow. Validation runs webview-side
  using the SAME pure `aiSettingsErrors` (imported from `src/ai/settings.ts` into the bundle
  — no vscode import there) and is re-checked host-side (authoritative). The host NEVER
  sends the apiKey to the webview — only `hasApiKey: boolean`; a submitted empty key with an
  existing stored key reuses the stored one. Test button builds a throwaway provider from
  the entered values and fires a minimal completion (work model, "Reply with: ok",
  maxOutputTokens 8), reporting ok/latency/error.
- **Privacy ("data KHÔNG được public"):** all AI traffic goes exclusively to the
  user-configured baseUrl; no third-party endpoints, no telemetry; apiKey SecretStorage
  only. Documented in README (AI section) as the egress contract.

**Interface freeze list** (executors MUST match exactly; `TASK-xxx` files carry full
signatures):

| Symbol | Home | Signature (frozen) |
|---|---|---|
| `AiCompletionMethod` | `src/ai/settings.ts` | `type AiCompletionMethod = "responses" \| "chat/completions"` |
| `AiModelRole` | `src/ai/settings.ts` | `type AiModelRole = "work" \| "smart"` |
| `AiModelConfig` | `src/ai/settings.ts` | `interface AiModelConfig { modelId: string; vision: boolean }` |
| `AiSettings` | `src/ai/settings.ts` | `interface AiSettings { baseUrl: string; method: AiCompletionMethod; timeoutMs: number; maxSteps: number; models: Record<AiModelRole, AiModelConfig> }` |
| `AiConfig` | `src/ai/settings.ts` | `interface AiConfig extends AiSettings { apiKey: string }` |
| pure fns | `src/ai/settings.ts` | `defaultAiSettings(): AiSettings` · `aiSettingsErrors(s: AiSettings): string[]` · `normalizeBaseUrl(url: string): string` · `redactAiConfig(cfg: AiConfig): AiSettings` |
| store | `src/ai/config.ts` | `class AiConfigStore { constructor(ctx: vscode.ExtensionContext); loadSettings(): Promise<AiSettings \| null>; loadApiKey(): Promise<string \| undefined>; loadConfig(): Promise<AiConfig \| null>; save(settings: AiSettings, apiKey: string): Promise<void>; clear(): Promise<void> }` + `KEY_AI_SETTINGS = "vsdb.ai.settings"`, `KEY_AI_API_KEY = "vsdb.ai.apiKey"` |
| provider types | `src/ai/provider.ts` | `FetchLike`, `ChatMessage`, `ChatContentPart`, `ToolCall`, `ToolDef`, `ProviderRequest`, `ProviderResult`, `ProviderError`, `ProviderOptions` (full shapes in TASK-002) |
| provider fns | `src/ai/provider.ts` | `createProviderClient(opts): { complete(req): Promise<ProviderResult> }` + the 4 pure builders/parsers |
| agent types | `src/ai/agent.ts` | `AgentTool`, `ToolRegistry`, `EMPTY_TOOL_REGISTRY`, `AgentInput`, `AgentDeps`, `AgentStep`, `AgentRunResult` |
| agent fn | `src/ai/agent.ts` | `runAgent(input, deps, callbacks?): Promise<AgentRunResult>` |

**Testability of each task** (why the split is unit-testable without network/vscode):
T1 pure validators + store behind fake vscode (established `connectionManager.test.ts`
pattern); T2 zero vscode — fake `fetch` returns canned bodies, fake timers for timeout;
T3 zero vscode — fake `loadConfig`/`complete`/registry drive the loop deterministically;
T4 host tests via fake vscode webview panel + jsdom bundle test over `dist/aiSettingsForm.js`
(`newTableFormBundle.test.ts` pattern).

**Alternatives rejected:** storing the whole config (incl. apiKey) as one secret JSON
(rejected: settings should be inspectable/debuggable and the JSON could be silently pasted
with a key inside — split storage + `aiSettingsErrors` apiKey-guard instead); provider as a
class with global fetch (untestable without network mocking of globals); agent with built-in
config caching (violates reconfigurable requirement); streaming now (spec: cycle sau); a chat
panel now (foundation first — user's explicit sequencing).

## §4 Test Plan

Per-task tables live in each TASK file (same coverage, file-scoped). Cycle-level:

| Type | Test Name | Expected |
|---|---|---|
| happy | save→loadConfig round-trip | apiKey from SecretStorage + settings from globalState merged into `AiConfig` |
| happy | chat/completions request+parse | POST `<base>/chat/completions`, Bearer key, body shape; `ProviderResult` text/toolCalls/finishReason/usage |
| happy | responses request+parse | POST `<base>/responses`, `instructions`+`input` items; output items → text + toolCalls |
| happy | vision content parts | image data-URL part survives both method mappings |
| happy | agent single-turn + tool loop | no-tool call ends run; tool call → tool result appended → next call sees `[user, assistant(tool_calls), tool]` |
| happy | role→model routing | run with `work` then `smart` → `req.modelId` = configured id per role |
| happy | settings form save/test | valid submit → store.save called; Test → provider fired, testResult posted |
| edge (validation) | invalid settings | `aiSettingsErrors` exact messages; save rejected, nothing persisted; OK disabled in form |
| edge (boundary) | timeoutMs/maxSteps bounds | out-of-range → error; exact bounds (1000/600000, 1/100) pass |
| edge (security) | apiKey never persisted in settings JSON / never in ProviderError | settings-with-apiKey rejected; error snippet scrubbed of key |
| edge (security/secret-failure) | SecretStorage.store rejects | save throws, settings NOT persisted (store-secret-first ordering) |
| edge (timing) | provider timeout | AbortController fires → `ProviderError.timeout === true`, message "timed out" |
| edge (malformed) | 200 non-JSON body; unknown tool name; throwing tool | ProviderError "Invalid JSON"; `{"error":"Unknown tool: …"}` tool result, loop continues |
| edge (state) | no stale config | mutate secret between loads → loadConfig reflects it; two agent runs see two configs, loadConfig called per run |
| edge (null/unconfigured) | loadConfig with nothing stored | returns `null` (no throw); runAgent rejects "AI is not configured" |
| edge (budget) | always-tool-calling model, maxSteps=3 | exactly 3 provider calls, `stoppedOnBudget === true` |
| edge (capability) | images + non-vision role | rejects "does not support vision", provider never called |
| edge (UI) | cancel/Escape; empty key with no stored key | panel disposed, save never called; "API key is required" |

Test selection rule (RULES.md): all target files are NEW under `src/` with no tests-map
entry → each task's own new test files are the selection (floor satisfied); never the full
suite per task. Wave-boundary full `npx vitest run` is the regression net (orchestrator).

## §5 Verification Commands

Verified against package.json `scripts`: `compile`, `typecheck`, `test`, `test:integration`.
There is NO `lint` script in this repo (stated explicitly, not omitted silently); the
typecheck gate is `npx tsc --noEmit` (identical to `npm run typecheck`).

- TASK-001: `npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts && npx tsc --noEmit`
- TASK-002: `npx vitest run src/ai/__tests__/provider.test.ts && npx tsc --noEmit`
- TASK-003: `npx vitest run src/ai/__tests__/agent.test.ts && npx tsc --noEmit`
- TASK-004: `npm run compile && npx vitest run src/ui/__tests__/aiSettingsForm.test.ts src/ui/__tests__/aiSettingsFormBundle.test.ts src/extension.test.ts && npx tsc --noEmit`

## §6 Acceptance

1. AI Settings form stores settings + apiKey; apiKey lands ONLY in SecretStorage
   (`vsdb.ai.apiKey`); settings JSON in globalState contains no key material. — T1, T4
2. `loadConfig()` is cache-free: any store change is visible on the next call. — T1
3. Provider speaks both methods against any baseUrl with timeout, error mapping, and
   apiKey-scrubbed errors; vision parts map on both. — T2
4. Agent loop: config snapshot per run, role→model routing, multi-turn tool calls, budget
   cap, vision guard, unknown/throwing tool recovery. — T3
5. `vsdb.openAiSettings` command opens the form; Test button validates the endpoint
   end-to-end (user-facing smoke for real-endpoint compat). — T4
6. All §5 commands PASS fresh; wave-boundary full `npx vitest run` green. — all
7. README documents the privacy/egress contract (key storage, single-endpoint egress, no
   telemetry). — T4

## §7 Global Constraints (inherited by every TASK file by reference)

- TypeScript strict; VS Code engine ^1.75.0; no new npm dependencies (global `fetch` /
  `AbortController` / `Response` are Node-18 globals — esbuild target node18).
- `src/ai/provider.ts` and `src/ai/agent.ts`: NO vscode import (pure, injected
  fetch/config/registry — unit-testable like `src/core/ddl/*`). `src/ai/settings.ts`: no
  vscode import (webview-importable). Only `src/ai/config.ts` and form wiring touch vscode.
- `method` enum is exactly `'responses' | 'chat/completions'`; roles exactly `work` + `smart`.
- Security (discover-security consulted): apiKey never logged, never serialized into
  settings JSON / errors / telemetry / README; SecretStorage only; validate at the earliest
  boundary (`aiSettingsErrors` before store; provider scrubs apiKey from `bodySnippet`).
- English UI strings; short Vietnamese header comments match house style.
- No DB tools, no streaming, no chat panel, no Anthropic protocol (§2 guard table).
- No PG container/network needed; unit tests only this cycle.
- Executor MUST NOT git commit/push (orchestrator commits per wave).
- No same-wave shared target files (table authoritative):

| Wave | Tasks | Disjoint target files |
|---|---|---|
| 1 | T1, T2 | T1: `src/ai/settings.ts`, `src/ai/config.ts`, `src/ai/__tests__/settings.test.ts`, `src/ai/__tests__/config.test.ts` — T2: `src/ai/provider.ts`, `src/ai/__tests__/provider.test.ts` (T2 imports NOTHING from `src/ai/*`) |
| 2 | T3 | `src/ai/agent.ts`, `src/ai/__tests__/agent.test.ts` (imports T1 settings + T2 provider) |
| 3 | T4 | `src/ui/aiSettingsForm.ts`, `src/ui/aiSettingsFormMessages.ts`, `webview/aiSettingsFormMain.ts`, `esbuild.js`, `package.json`, `src/extension.ts`, `src/extension.test.ts`, `README.md`, `src/ui/__tests__/aiSettingsForm*.test.ts` |

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: split TASK-001 into pure `src/ai/settings.ts` (validations, webview-importable — no vscode import) + vscode-bound `src/ai/config.ts`, which lets wave-1 TASK-002 stay fully standalone (provider.ts declares its own inline `method` union, zero `src/ai/*` imports) so the scaffolded wave-1 parallelism is genuinely collision-free; mandated store-secret-before-settings ordering + apiKey-scrubbed `bodySnippet` after walking the discover-security checklist; added explicit hasApiKey/empty-key-retention form semantics so the key never round-trips to the webview.
Known gaps: (1) no live-endpoint test — both method mappings are asserted against canned JSON fixtures; real-server drift (nonstandard OpenAI-compatible forks) is user-verified via the Test button, which is the designed smoke path; (2) `responses` mapping covers the subset this extension emits (system→instructions, text/image parts, function_call/function_call_output) — built-in server tools (web_search etc.) are not parsed, out of scope; (3) webview visual layout is verified via jsdom DOM assertions (house pattern), not screenshots; (4) run-level model role (per-call routing seam ready) is the recorded interpretation of "agent gọi liên tục tới cả 2 models" — mid-run role switching arrives with DB tools in cycle K+.

## Plan Review Log

### Round 1 — 2026-08-23 · unic/unic-smart
Status: Approved

Interface consistency: VERIFIED — one contract, no drift. T1 Produces (`AiSettings`, `AiConfig`, `AiConfigStore`, validators) ⊇ T3 Consumes (`AiConfig`, `AiModelRole`) ⊇ T4 Consumes (all named symbols present). T2 `ProviderOptions.method` inline union is structurally identical to T1 `AiCompletionMethod` (assignable both ways). T3 `AgentDeps.complete(cfg, role, req)` and T4 `AiSettingsFormOptions.complete(cfg, "work", req)` are distinct seams, never cross-assigned — no conflict. Wave table (§7) target files are genuinely disjoint; T2's zero-`src/ai/*`-import rule makes wave-1 parallelism real.

Test plans: TDD-viable. T1 #1–13, T2 #1–13, T3 #1–12, T4 #1–13 all assert observable behavior against the frozen contract (RED = import-missing / assertion fail before implementation). Edge floors exceeded: T1 6 distinct edge kinds (validation/boundary/security/secret-failure/null/state), T2 6 (timing/malformed/security/boundary/missing-data/network), T3 5 (budget/capability/state/malformed×2), T4 5 (security/validation/error/UI/README). Config `minTestsEdgeCase: 2` satisfied everywhere.

Verification commands: REAL — `npx vitest run` (vitest ^1.6.0 devDep, include covers `src/**/*.test.ts`), `npx tsc --noEmit` (= `npm run typecheck`, typescript ^5.4.5), `npm run compile` (= `node esbuild.js`); all script names exist in package.json. "No lint script" claim verified true (scripts: compile/watch/test/test:integration/typecheck/package/vscode:prepublish) — stated, not silently omitted, per `requireLintOrTypecheckInVerification`. jsdom ^29.1.1 present for bundle tests. `src/extension.test.ts` exists with registerCommand tracking (T4 #12 edit plausible). Referenced house patterns all exist: `src/core/__tests__/connectionManager.test.ts`, `src/ui/__tests__/newTableFormBundle.test.ts` (jsdom + skip-if-dist-missing), `connectionForm.test.ts`.

Spec compliance: apiKey → SecretStorage `vsdb.ai.apiKey` only, never in globalState JSON (T1 save ordering + test #5/#10), never logged, scrubbed from ProviderError snippets (T2 #10), never round-trips to webview (`hasApiKey` only — T4 #1). Re-read per run: T1 cache-free `loadConfig()` (test #12) + T3 `deps.loadConfig()` exactly-once-per-run (test #4). OpenAI-compatible only; method enum exactly `responses | chat/completions`; roles exactly `work`(vision default true) + `smart`. Privacy egress contract → README (T4 #13). Out-of-scope guard table covers DB tools/streaming/chat panel/Anthropic — honored in task acceptance criteria.

COMPLETENESS:
  - none — no TODO/TBD/placeholders; every task has Goal/Target Files/frozen contract/Test Cases/Test Files/Verification/Acceptance/Interfaces Consumes+Produces.
CONSISTENCY:
  - none blocking — all cross-task symbols match exactly (verified symbol-by-symbol above).
CLARITY:
  - minor — TASK-003.md loop semantics 3a lists `temperature` in `req` but no input field defines it (AgentInput/AiSettings have none); executor should read this as "omit/undefined". Tighten in a fix round if one happens anyway.
  - minor — TASK-004.md message protocol has no dedicated host→webview error type; save-guard errors ("API key is required") overload `{type:"testResult", ok:false}` (Spec `AiSettingsFormHostMessage` + test #5). Works and is normatively specified; semantically muddy — consider a `saveError` message in cycle K.
SCOPE:
  - none — three pure modules + one form, exactly the spec's foundation; guard table prevents creep.
YAGNI:
  - minor — no cycle-J production wiring exists for `runAgent` (no task binds the `(cfg, role, req) → createProviderClient` adapter; the form's Test button calls the provider directly). Intentional foundation scope, seam fully tested via fakes — carry as an explicit note into cycle K planning so the glue isn't rediscovered.

FINDINGS:
  critical: none
  important: none
  minor:
    - TASK-003.md (loop semantics 3a) — `temperature` in req has no defined source; specify "omitted" or wire an AgentInput field.
    - TASK-004.md (AiSettingsFormHostMessage) — save errors reuse the testResult channel; add a dedicated error type later.
    - PLAN.md §5 / all tasks — `npx tsc --noEmit` checks the whole `src/**` tree (tsconfig include), so wave-1 T1/T2 executors running in parallel may hit phantom type errors from each other's in-flight files; re-running at task end / wave-boundary gate absorbs it.
    - TASK-002.md (wire behavior, URL rule) — trailing-slash trimming must be re-implemented inline (cannot import `normalizeBaseUrl` from settings.ts due to the standalone-wave-1 rule); accepted trade-off, keep both behaviors in sync.
    - TASK-004.md (#9/#10/#11b) — bundle tests skip when `dist/aiSettingsForm.js` is absent, so they cannot be RED pre-implementation; host tests #1–#8 + #12 carry the RED evidence (house pattern, already acknowledged in the task).
    - PLAN.md (Planner Self-Audit, known gap 4) — "agent gọi liên tục tới cả 2 models" recorded as run-level role with per-call seam; acceptable interpretation, explicitly documented, interface supports mid-run switching later without change.

NOTES: Frozen interfaces are coherent end-to-end and every verification command is runnable against package.json as it exists. All findings are minor polish — none blocks Phase 2 task creation or executor pickup.
