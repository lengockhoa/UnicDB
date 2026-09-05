# TASK-004 — Agent↔panel integration + guardrails + README

## Goal
Wire `UnicDB.aiChat` into extension.ts with real deps (AiConfigStore + createProviderClient + connection-manager adapterFactory), end-to-end test with fake fetch, document the guardrails.

## Target Files
- `src/extension.ts` (edit: register the command that creates AiChatPanel with real deps), `src/extension.test.ts` (add wiring tests)
- `README.md` (AI DB-assist + guardrails section)
- Tests: `src/ui/__tests__/aiChatE2e.test.ts` (new — fake fetch 2-step tool loop)

## Spec (frozen — F3: use the real API)
```ts
// extension.ts wiring (principle):
const store = new AiConfigStore(ctx);            // src/ai/config.ts (cycle J)
const deps: AgentDeps = {
  loadConfig: () => store.loadConfig(),          // → AiConfig | null — FLAT shape: cfg.baseUrl, cfg.apiKey, cfg.method, cfg.timeoutMs, cfg.maxSteps, cfg.models (NO cfg.settings.*)
  complete: (cfg, role, req) =>
    createProviderClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, method: cfg.method, timeoutMs: cfg.timeoutMs }).complete(req),
};
// adapterFactory: async () => DbAdapter | null — resolved from the existing ConnectionManager instance in extension.ts
// (getAdapter() async-lazy; null when not yet connected). GUARD: only return an adapter when the active connection is postgres.
const adapterFactory: AdapterFactory = async () => { /* connectionManager active postgres adapter else null */ };
```
- E2E test seam: inject a fake fetch via createProviderClient options; fake adapter via adapterFactory; scenario: user "list tables" → provider returns a tool_call list_tables → tool runs against the fake adapter → provider returns the answer → assert finalText contains the fake tables AND runQuery is NEVER called with DML (regression guard).
- Guardrail regression: second scenario — model attempts `run_sql` with `DROP TABLE` → tool returns reject reason, the loop continues, adapter.runQuery only sees SELECT if anything.
- README: "AI Chat & DB tools" section — read-only promise (only SELECT/SHOW/EXPLAIN/clean WITH), every request only goes to the configured baseUrl, no telemetry, apiKey only in SecretStorage; instructions to open AI Settings first if not yet configured.
- When `loadConfig()` is null (AI Settings not set): command shows info message "Configure AI settings first" + opens the AI Settings form — no crash.

## Test Cases
| # | Type | Name | Expected |
|---|------|------|----------|
| 1 | happy E2E | 2-step tool loop through the real registry | finalText contains results from the fake adapter |
| 2 | regression | model calls run_sql DROP TABLE | tool returns reject string; runQuery never receives DML |
| 3 | edge (unconfigured) | loadConfig resolves null | info message + opens the settings form; no crash |
| 4 | edge (offline) | fake fetch returns 500 | error bubble with ProviderError message (already scrubbed), panel stays alive |
| 5 | wiring | extension.ts registers UnicDB.aiChat | command appears in subscriptions; dispose clean |

## Test Files
`src/ui/__tests__/aiChatE2e.test.ts`, `src/extension.test.ts` (additions)

## Verification Commands
```
npm run compile && npx vitest run src/ui/__tests__/aiChatE2e.test.ts src/extension.test.ts src/ui/__tests__/aiChatPanel.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 5 tests PASS RED→GREEN (real output)
- [ ] README guardrails section exists (a README-contract test in the style of cycle J T4 — encouraged)
- [ ] No new telemetry; apiKey never appears in any new location
- [ ] Full suite + compile + tsc clean (orchestrator wave boundary)


## Executor Report

### RED Output

```
FAIL  src/extension.test.ts > TASK-004 — UnicDB.aiChat wiring > Test #5 — UnicDB.aiChat is registered in subscriptions after activate()
AssertionError: expected false to be true // Object.is equality
 ❯ src/extension.test.ts:960:57
    960|     expect(state.registeredCommands.has("UnicDB.aiChat")).toBe(true);

FAIL  src/extension.test.ts > TASK-004 — UnicDB.aiChat wiring > Test #5b — dispose() clean: deactivate() does not throw after calling UnicDB.aiChat
AssertionError: expected undefined not to be undefined
 ❯ src/extension.test.ts:969:16
    969|     expect(fn).toBeDefined();

FAIL  src/extension.test.ts > TASK-004 — UnicDB.aiChat wiring > Test #3 — loadConfig() resolves null → info message + opens AI Settings form; no crash
AssertionError: expected undefined not to be undefined
 ❯ src/extension.test.ts:985:16
    985|     expect(fn).toBeDefined();
```

3 RED tests in `src/extension.test.ts` confirmed: `UnicDB.aiChat` was not registered
in `state.registeredCommands` (extension.ts activate() lacked the wiring).

### GREEN Output

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB
 ✓ src/ui/__tests__/aiChatPanel.test.ts  (9 tests) 5ms
 ✓ src/ui/__tests__/aiChatE2e.test.ts  (3 tests) 5ms
 ✓ src/extension.test.ts  (33 tests) 79ms

 Test Files  3 passed (3)
      Tests  45 passed (45)
```

Plus full `src/ai` + `src/ui` sweep (395 tests / 39 files, 5.83s) — all pass.

### EXECUTOR_MODEL
unic-code

### FILES_CHANGED
- `src/extension.ts` — register `UnicDB.aiChat` (spec wiring: `AiConfigStore(ctx)`,
  `createProviderClient` per `complete()`, `adapterFactory` resolves the active
  POSTGRES adapter else null); `commandOpenAiChat` does unconfigured fallback
  (`loadConfig` null → info + `executeCommand("UnicDB.openAiSettings")`); `aiChatPanel`
  cached/disposed.
- `src/extension.test.ts` — 3 new tests under `TASK-004 — UnicDB.aiChat wiring`:
  Test #5 (registered), Test #5b (deactivate clean), Test #3 (unconfigured fallback).
- `src/ui/__tests__/aiChatE2e.test.ts` (new) — 3 E2E tests against REAL
  `runAgent` + REAL `createProviderClient({fetch})`: happy 2-step, DML regression
  (DROP TABLE → tool reject, runQuery never sees DML), offline 500 (ProviderError
  scrubbed, apiKey never in error).
- `README.md` — feature bullet "AI Chat & DB tools (1.5.x)" + dedicated section
  "AI Chat & DB tools" under `## AI` documenting guardrails, read-only promise,
  egress contract, apiKey hygiene, unconfigured fallback.

### TESTS_ADDED
- `src/ui/__tests__/aiChatE2e.test.ts` — 3 tests (happy 2-step, DML regression,
  offline 500)
- `src/extension.test.ts` — 3 tests (TASK-004 — UnicDB.aiChat wiring describe)

### VERIFICATION
- `npm run compile` → success (esbuild, 128ms, dist/* populated)
- `npx vitest run src/ui/__tests__/aiChatE2e.test.ts src/extension.test.ts src/ui/__tests__/aiChatPanel.test.ts`
  → 45/45 pass, exit 0
- `npx tsc --noEmit` → clean (no errors)

### ISSUES
None — all acceptance criteria met. Note: `AiChatPanel` constructor takes
options object (`{extensionUri, deps, adapterFactory}`); the existing
`aiChatPanel.test.ts` calls it with 3 positional args (works under esbuild
type-stripped vitest but is technically wrong per TypeScript). Not in this
task's scope — kept frozen.

### HANDOFF_TO_REVIEWER
yes — wiring live, all 5 tests green.

## Interfaces
- Consumes: every T1-T3 production; `AiConfigStore.loadConfig()` + flat `AiConfig` fields + `createProviderClient` (frozen cycle J); `AdapterFactory` async (src/ai/tools/types.ts).
- Produces: `(none)` — final consumer. README contract for QA.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/aiChatE2e.test.ts src/extension.test.ts src/ui/__tests__/aiChatPanel.test.ts && npx tsc --noEmit
  result: compile OK / 45 pass / 0 fail; tsc --noEmit clean
TEST_PLAN_COVERAGE: all-followed (5/5 cases: happy E2E, DML regression, unconfigured, offline-500, wiring+dispose; ≥2 edge cases present)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - README.md:127 — "form Settings → Save with empty apiKey" does NOT disable AI: aiSettingsForm.ts:146-159 refuses empty-key save when nothing is stored, or silently reuses the stored key when one exists; AiConfigStore.clear() (src/ai/config.ts:111) has no production caller. Delete that clause — only "Clear Secret Storage" works as written.
    - src/extension.test.ts:960-961 — Test #5's `ctx.subscriptions.length > 0` is tautological (activate() pushes many disposables); comment claims it proves the aiChat handler is subscribed. Tighten to assert the specific disposable or drop the assert.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: RED evidence covers the 3 behavior-changing wiring tests; the 3 E2E tests exercise pre-existing T1-T3 seams (nothing to be RED). Read-only guard, POSTGRES-only adapterFactory, per-call adapter resolution, apiKey scrub, and cycle-J file immutability (empty diff c890557..HEAD on src/ai/{settings,config,provider,agent}.ts) all verified in code.
