# Cycle AIC Plan — AI SQL Autocomplete

Base: `main` @ `f7a4055` (v1.14.0). Planning-only cycle; no source, package, or test file is changed by this cycle.

## §1 Intent

User request (verbatim):

> "Tôi có một ý tưởng và vẫn muốn implement vô hệ thống này.Chỗ cài đặt AI setting, hãy cho tôi thêm một model nữa, đó là model auto-complete. Model này sẽ dùng để suggest những câu query dựa trên data của mình.Tôi sẽ tự setting model riêng, và model này chạy cực kỳ nhanh, yên tâm là nó sẽ có tính năng auto-complete, nhưng mà vẫn dùng theo tính năng bình thường giống như AI, OpenAI Compatible. Những model này, thường tôi sẽ dùng những model free, ít tốn phí chứ chi phí nó cao nên là tôi sẽ thay đổi liên tục, không sử dụng cố định một model nào cả.Bên cạnh đó, hãy viết cho tôi tính năng autocomplete nữa. Nó sẽ tự success khi tôi gõ vào những câu query, để cho nó có thể autocomplete dựa trên database structure có sẵn của tôi."

Recorded planning answers (verbatim):

1. Completion surface: "SQL editor + Console (Recommended)"
2. Context: "Schema only (Recommended)"
3. Trigger: "Debounced automatic (Recommended)"

**Success definition:** Users can configure a third, free-form OpenAI-compatible `autocomplete` model ID in AI Settings and receive debounced ghost-text SQL suggestions in both `.sql` editors and the VSDB Console. Suggestions are derived only from bounded SQL cursor context and the active connection's schema metadata, respect the active dialect and connection, can be accepted through each surface's native inline-completion interaction, and never replace deterministic schema completion, query execution/results, or AI Chat.

Scope complexity: LOW

Detected systems: [AI settings and credential persistence, OpenAI-compatible provider transport, SQL editor completion, VSDB Console]

Decomposition: 1 module — AIC planned now; no modules queued.

## §2 Scope

**In scope**

- Add required `autocomplete` to the existing `AiModelRole`/`AiSettings.models` record, migrate saved two-role settings to a disabled-by-empty autocomplete ID, and preserve arbitrary user-entered model IDs without a fixed allowlist.
- Reuse the existing single `baseUrl`, `method`, `timeoutMs`, and `vsdb.ai.apiKey` SecretStorage value. This is deliberately one OpenAI-compatible provider configuration with three model roles, not a second provider or API key surface.
- Create a cancellable AI SQL suggestion service that sends schema only: dialect, active connection identity, schema/table/column metadata, and bounded prefix/suffix around the cursor. It must send no query results, table rows, values, passwords, API keys, or logs of request content.
- Add a VS Code `InlineCompletionItemProvider` for `.sql` files, alongside—not instead of—`SqlCompletionProvider`'s deterministic schema/keyword popup completion.
- Add equivalent ghost-text suggestion/accept behavior to the Console textarea while preserving its tabs, history, formatting, run/selection/run-statement flow, QueryRunner/results integration, and AI Chat coexistence.
- Debounce automatic requests; cancel superseded requests; suppress stale results; keep at most one active request per document/tab; add bounded cache, short cooldown/rate guard, low output-token limit, and silent cancellation/error behavior. Missing config has an unobtrusive, actionable status only; it must not repeatedly notify while typing.
- Wire lifecycle cleanup and active-connection changes so suggestions/caches cannot cross connections.

**Out of scope for this cycle**

- A separate autocomplete endpoint, method, timeout, or API key: rejected because the current architecture has one `AiConfigStore` and one `createProviderClient` transport; duplicate secrets/provider semantics are unjustified.
- Row/value sampling, query-result context, data export, embeddings/RAG, telemetry, prompt logging, model discovery, a fixed model allowlist, or automatic model switching.
- Replacing `SqlCompletionProvider`, changing SQL execution, AI Chat prompts/engines, package contribution changes, or adding dependencies.
- Inline suggestions for non-SQL documents or third-party editor surfaces.

**Wave constraint:** No two tasks in the same wave modify a shared file. Task AIC-001 owns the settings files; AIC-002 owns the new service; AIC-003 owns the new VS Code provider; AIC-004 owns Console files; AIC-005 alone owns extension wiring and its test.

## §3 Approach

0. **Shared service contract and hard bounds.** AIC-002 owns the single `SqlAutocompleteService` and exports/injects these tested constants: `DEBOUNCE_MS = 300`, `SQL_PREFIX_MAX_CHARS = 2_000`, `SQL_SUFFIX_MAX_CHARS = 500`, `SCHEMA_CONTEXT_MAX_CHARS = 12_000`, `MAX_OUTPUT_TOKENS = 64`, `CACHE_TTL_MS = 30_000`, `CACHE_MAX_ENTRIES = 100`, and `COOLDOWN_MS = 500`. The service—not either UI—performs the only debounce, owns one `AbortController` plus monotonic request sequence per caller scope, and owns an LRU cache keyed by `(connectionId, dialect, schemaFingerprint, cursorSqlPrefix, cursorSqlSuffix)`. A schema refresh or connection change invalidates relevant keys. Editor and Console share this service only; their rendering and caller scopes remain separate. The editor scope is document URI; Console scope is tab ID.

1. **Settings and migration.** `AiSettings` currently declares `models: Record<AiModelRole, AiModelConfig>` where `AiModelRole = "work" | "smart"`; `AiConfigStore` persists settings in globalState and `KEY_AI_API_KEY = "vsdb.ai.apiKey"` in SecretStorage. Extend the role union to include `"autocomplete"`, use `{ modelId: "", vision: false }` as its default, and normalize a missing autocomplete role on every `loadConfig()` before validation (no schema-version flag). This normalization never repairs or relaxes invalid work/smart settings. Model IDs are trimmed; empty-after-trim autocomplete means disabled, while work/smart remain required. The webview uses a plain text input so the model ID remains free-form and changeable.
2. **Transport and privacy boundary.** Add `src/ai/sqlAutocomplete.ts` (new), a VS Code-free orchestration service consuming `AiConfigStore.loadConfig()`, schema access through the existing `SchemaCache`/adapter methods, and an injected OpenAI-compatible completion function. It uses the existing chat/completions-shaped `createProviderClient(...).complete()` semantic with the free-form autocomplete role ID and current endpoint/key/method/timeout. It constructs a narrowly specified schema-only request and sanitizes the returned suffix into a single safe SQL insertion. No logger or helper may receive prompt text or a response suffix; API keys never appear in errors, status text, or host/webview messages.
3. **Editor integration.** Add `AiSqlInlineCompletionProvider` (new) implementing the real VS Code signature `provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList>`. It forwards that `CancellationToken` as the AIC-002 service signal and returns one `vscode.InlineCompletionItem` at the cursor only when the returned suffix is current and non-empty; it owns neither another debounce nor another cache/controller. Existing `SqlCompletionProvider.provideCompletionItems(...)` remains registered and untouched.
4. **Console integration.** Editor and Console share AIC-002 only, not rendering. Extend the current Console host/webview message protocol and `ConsolePanelOptions` with an injected autocomplete seam. The webview fires input changes to the host without its own debounce, displays an escaped positioned overlay/span rather than changing textarea `value`, and accepts one suffix through one atomic postMessage. Tab or right-arrow accepts only when the caret is at the end of an empty selection; otherwise existing textarea/browser behavior wins. The host keeps per-tab request sequence/cancellation state and obtains only the active connection's dialect/schema context via the shared service. It never sends a Console history item or SQL result as prompt context.
5. **Final wiring.** AIC-005 creates one schema cache/service per extension activation, invalidates/cancels it on `mgr.onDidChangeActive`, posts a Console clear-ghost outcome for every open panel/tab, registers the existing `registerInlineCompletionItemProvider({ scheme: "file", language: "sql" }, provider)`, and passes a Console callback. It owns one passive status-bar affordance for missing autocomplete configuration (opens AI Settings; never a modal/notification or per-keystroke prompt). It must add clean disposals and retain current editor completion, semantic tokens, console runner, results panel, and AI Chat behavior.

**Alternatives rejected**

- A dedicated provider config and secret for autocomplete: increases secret leakage/configuration failure surface; reuse is coherent with `AiConfigStore.loadConfig(): Promise<AiConfig | null>` and `createProviderClient({ baseUrl, apiKey, method, timeoutMs })`.
- Reusing popup completion for AI text: rejected because user selected automatic autocomplete and VS Code has native ghost-text support; deterministic popup completion is retained as an additive fallback.
- Sending rows/results to improve relevance: rejected by the schema-only answer and privacy contract.
- Streaming suggestions: rejected for the first version; bounded, non-streaming completion simplifies cancellation/stale suppression and is appropriate for the stated fast model.

## §4 Test Plan

| Type | Test Name | Expected | Task |
|---|---|---|---|
| happy | settings save/load includes free-form autocomplete ID | `"vendor/free-fast-sql"` round-trips in globalState; `apiKey` remains only in SecretStorage | AIC-001 |
| edge — migration | two-role legacy settings load | missing `models.autocomplete` is normalized to `{ modelId: "", vision: false }`, while work/smart stay usable | AIC-001 |
| edge — validation | trimmed/blank autocomplete vs blank work | free-form ID is trimmed; empty-after-trim autocomplete is valid/disabled, while blank work still returns `Model is required for role: work` | AIC-001 |
| happy | schema-only service request | configured active PostgreSQL connection produces one bounded request with autocomplete model ID, dialect and table/column names; result suffix is returned | AIC-002 |
| edge — privacy | rows/secrets/logging excluded | sent JSON excludes sentinel row values, API key, and query-history text; no row-reading method is called; mocked logger/helper receives neither prompt text nor response suffix | AIC-002 |
| edge — concurrency | superseded request cancellation | second request aborts first; late first response produces no completion; only current sequence returns suffix | AIC-002 |
| edge — boundary | prompt/cache/rate bounds | prefix/suffix and schema budget are capped; equivalent request is cache-hit; cooldown prevents another provider call | AIC-002 |
| happy | SQL editor inline ghost text | provider returns one `InlineCompletionItem` with exact suffix at cursor after service resolution | AIC-003 |
| edge — cancellation | VS Code token cancellation | cancelled token returns `[]` and aborts/does not publish an in-flight result | AIC-003 |
| edge — unavailable | no autocomplete model/no connection | provider returns `[]`, leaves deterministic `SqlCompletionProvider` behavior unchanged, and does not throw | AIC-003 |
| happy | Console ghost suggestion acceptance | textarea input obtains ghost suffix; Tab accepts it into only active tab's buffer and posts one buffer update | AIC-004 |
| edge — stale lifecycle | Console tab switch/edit | late response after a newer input or tab switch is ignored; ghost text is cleared and not inserted | AIC-004 |
| edge — error path | Console unavailable/failed request | no ghost text or intrusive error; Run/Format/History controls keep their existing behavior | AIC-004 |
| regression | extension registers both completion kinds | activation keeps `registerCompletionItemProvider` and also registers one SQL inline provider; dispose unregisters both | AIC-005 |
| regression — multi-connection | connection change isolates context | `mgr.onDidChangeActive` cancels/invalidate old request/cache; new suggestion uses only new connection schema/dialect | AIC-005 |
| edge — configuration lifecycle | model disabled mid-session clears state | saving an empty-after-trim autocomplete ID cancels pending service work, clears editor/Console ghosts and caches, and makes no provider call until re-enabled | AIC-005 |
| edge — coexistence | Console run and AI Chat unchanged | autocomplete wiring does not invoke QueryRunner/AI Chat while merely typing and existing command registration remains intact | AIC-005 |

## §5 Verification

Per task, run its exact focused `npx vitest run ...` command from the task file, then:

```bash
npm run typecheck
```

`package.json` defines `compile`, `test`, `test:integration`, `typecheck`, and `package`; it defines **no lint script**, so `npm run typecheck` is the mandatory static check. The test-map at `.cache/index/tests-map.json` supplies the existing target test paths; new production files receive named new test files. This npm repository has no `test:release-core` command, so no unavailable yarn fallback is listed.

At each completed wave and at cycle end:

```bash
npm test
npm run typecheck
npm run compile
```

Manual smoke after the final wave:

1. Configure a free-form autocomplete model ID, retain a stored key, and save/reopen settings; verify the third field persists and work/smart values are unchanged.
2. With PostgreSQL connection A active, type `SELECT * FROM us` in a `.sql` editor; verify ghost text appears after the 300ms service debounce, accept it using VS Code inline-completion acceptance, and deterministic popup suggestions still appear when invoked.
3. Open Console, type equivalent SQL, visually confirm the escaped ghost suffix is correctly aligned without changing textarea content, then accept it. Switch to connection B/tab before a response returns and verify no A suggestion appears in B/tab.
4. Run a Console query and open AI Chat; verify normal results and chat remain independent from autocomplete.

## §6 Acceptance

- [ ] A third `autocomplete` model role is separately editable as a free-form OpenAI-compatible model ID, legacy settings migrate safely, and user keys remain exclusively in SecretStorage. (AIC-001)
- [ ] Autocomplete reuses current endpoint/key/method/timeout provider semantics; it adds no second secret or fixed model allowlist. (AIC-001, AIC-002)
- [ ] Each request contains schema-only context plus bounded cursor prefix/suffix, dialect, and connection/schema identity—never rows, results, values, secrets, or logs. (AIC-002)
- [ ] Debounce, cancellation, stale suppression, one-request-per-surface concurrency, cache/cooldown, and bounded output protect responsiveness and cost. (AIC-002, AIC-003, AIC-004)
- [ ] SQL editor offers native inline ghost text without replacing existing deterministic completion. (AIC-003, AIC-005)
- [ ] Console offers matching ghost-text acceptance without changing tab, runner, results, history, or format behavior. (AIC-004, AIC-005)
- [ ] Connection changes and surface disposal cannot leak old connection suggestions. (AIC-002, AIC-004, AIC-005)
- [ ] Missing model/config and cancelled/failed calls are quiet, actionable through one status-bar AI Settings affordance where appropriate, and never disruptive while typing. (AIC-002, AIC-003, AIC-004, AIC-005)
- [ ] No telemetry or logger receives autocomplete prompt text or response suffix; no API key appears in persistence, errors, status text, or webview messages. (AIC-001, AIC-002, AIC-005)
- [ ] All task reports have fresh focused tests plus `npm run typecheck`; every wave/cycle boundary passes `npm test`, `npm run typecheck`, and `npm run compile`. (AIC-001–005)

## §7 Task Split and Global Constraints

| Task | Slice | Verified target ownership | Dependencies | Wave |
|---|---|---|---|---|
| TASK-AIC-001 | AI settings role, persistence migration, and settings form | `src/ai/settings.ts`, `src/ai/config.ts`, `src/ui/aiSettingsForm.ts`, `webview/aiSettingsFormMain.ts`, their existing tests | none | 1 |
| TASK-AIC-002 | Schema-only cancellable autocomplete service | `src/ai/sqlAutocomplete.ts` (new), `src/ai/__tests__/sqlAutocomplete.test.ts` (new) | TASK-AIC-001 | 2 |
| TASK-AIC-003 | Native SQL editor inline provider | `src/ui/aiSqlCompletionProvider.ts` (new), `src/ui/__tests__/aiSqlCompletionProvider.test.ts` (new) | TASK-AIC-002 | 3 |
| TASK-AIC-004 | Console ghost-text protocol and UX | `src/ui/consolePanel.ts`, `src/ui/consolePanelMessages.ts`, `webview/consolePanelMain.ts`, Console tests | TASK-AIC-002 | 3 |
| TASK-AIC-005 | Extension lifecycle and dual-surface wiring | `src/extension.ts`, `src/extension.test.ts` | TASK-AIC-003, TASK-AIC-004 | 4 |

**Global Constraints (inherited by every task)**

- Keep `engines.vscode` at `^1.75.0`; use the verified VS Code `InlineCompletionItemProvider` and `registerInlineCompletionItemProvider` APIs only.
- Add no npm dependency, configuration contribution, endpoint, secret key, telemetry, or prompt logger.
- Preserve `SqlCompletionProvider` deterministic completion, Console QueryRunner/results/history/format behavior, and AI Chat behavior; AI autocomplete is additive only.
- `AiConfigStore` retains `KEY_AI_API_KEY = "vsdb.ai.apiKey"`; API keys never enter settings persistence, host-to-webview messages, completion prompt text, status/error text, tests outside sentinel assertions, or logs.
- Prompt content is schema metadata only: no row/result values, credentials, SQL history, or arbitrary whole document. AIC-002's shared constants bind cursor prefix/suffix, schema text, output tokens, cache TTL/size, and request rate; it is the only debounce/cache/cancellation authority.
- No inline handlers in webviews; use existing CSP-safe DOM event listeners and escape untrusted suggestion text before HTML rendering. Console uses a ghost overlay, never a pre-acceptance textarea-value mutation.
- The only user-facing unavailable-model cue is the AIC-005 status-bar affordance; no per-keystroke notification, modal, or QuickPick is allowed.
- User-facing text follows existing VSDB bilingual/localized copy style; errors/cancellation must be silent or a single actionable status, never per-keystroke modal/toast spam.
- Every executor follows TDD RED→GREEN, records actual output, and runs exact verification commands; no task changes any file owned by a same-wave task.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: Moved Console implementation behind the shared service and isolated final extension edits into AIC-005, eliminating same-wave file collisions; recorded the verified absence of a lint and `test:release-core` script rather than inventing either.
Known gaps: Console is a `<textarea>`, not a VS Code text editor, so its ghost rendering and Tab/right-arrow acceptance require a custom DOM implementation rather than VS Code `InlineCompletionItem`. Visual ghost-text placement requires manual smoke in addition to jsdom tests; that check is required by AIC-004 and the cycle-end smoke list.

## Plan Review Log

### Round 1 — Issues Found (reviewer model: unic-code)
- Required shared explicit service bounds, every-load migration semantics, cancellation ownership, Console overlay/acceptance behavior, privacy logging assertions, concrete unavailable-model status, and lifecycle tests for disabling a model during a session.

### Round 2 — findings applied without re-review
- Added AIC-002-owned constants, caller scopes, schema-fingerprinted cache key, and single debounce/cancellation authority.
- Defined every-load legacy normalization without relaxing work/smart validation; model IDs trim and empty autocomplete disables.
- Pinned existing chat/completions `complete()` semantics and API-key/logging exclusions.
- Defined editor token forwarding, Console per-tab sequence/overlay/atomic acceptance, connection-change clearing, and status-bar ownership.
- Added tests for logging privacy, trimmed IDs, and disabling autocomplete mid-session; elevated visual Console smoke.
- Review cap reached after this revision; all Round-1 findings were applied directly.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Findings applied after independent unic-code Round 1
