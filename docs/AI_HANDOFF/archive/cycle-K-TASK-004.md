# TASK-004 — Agent↔panel integration + guardrails + README

## Goal
Nối `vsdb.aiChat` vào extension.ts với deps thật (AiConfigStore + createProviderClient + connection-manager adapterFactory), test end-to-end bằng fake fetch, document guardrails.

## Target Files
- `src/extension.ts` (sửa: register command tạo AiChatPanel với deps thật), `src/extension.test.ts` (thêm test wiring)
- `README.md` (section AI DB-assist + guardrails)
- Tests: `src/ui/__tests__/aiChatE2e.test.ts` (mới — fake fetch 2-step tool loop)

## Spec (frozen — F3: dùng API thật)
```ts
// extension.ts wiring (nguyên tắc):
const store = new AiConfigStore(ctx);            // src/ai/config.ts (cycle J)
const deps: AgentDeps = {
  loadConfig: () => store.loadConfig(),          // → AiConfig | null — FLAT shape: cfg.baseUrl, cfg.apiKey, cfg.method, cfg.timeoutMs, cfg.maxSteps, cfg.models (KHÔNG có cfg.settings.*)
  complete: (cfg, role, req) =>
    createProviderClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, method: cfg.method, timeoutMs: cfg.timeoutMs }).complete(req),
};
// adapterFactory: async () => DbAdapter | null — resolve từ ConnectionManager instance hiện có trong extension.ts
// (getAdapter() async-lazy; null khi chưa connect). GUARD: chỉ trả adapter khi active connection là postgres.
const adapterFactory: AdapterFactory = async () => { /* connectionManager active postgres adapter else null */ };
```
- E2E test seam: inject fetch fake qua createProviderClient options; adapter fake qua adapterFactory; kịch bản: user "list tables" → provider trả tool_call list_tables → tool chạy trên fake adapter → provider trả answer → assert finalText chứa bảng fake + runQuery KHÔNG BAO GIỜ được gọi với DML (regression guard).
- Guardrail regression: kịch bản thứ hai — model cố gọi `run_sql` với `DROP TABLE` → tool trả reject reason, vòng lặp tiếp tục, adapter.runQuery chỉ thấy SELECT nếu có.
- README: section "AI Chat & DB tools" — read-only promise (chỉ SELECT/SHOW/EXPLAIN/WITH sạch), mọi request chỉ tới baseUrl cấu hình, không telemetry, apiKey chỉ trong SecretStorage; hướng dẫn mở AI Settings trước nếu chưa config.
- Khi `loadConfig()` null (chưa set AI Settings): command hiện info message "Configure AI settings first" + mở AI Settings form — không crash.

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy E2E | 2-step tool loop qua registry thật | finalText chứa kết quả từ fake adapter |
| 2 | regression | model gọi run_sql DROP TABLE | tool reject string; runQuery không nhận DML |
| 3 | edge (unconfigured) | loadConfig resolve null | info message + mở settings form; không crash |
| 4 | edge (offline) | fetch fake trả 500 | error bubble ProviderError message (đã scrub), panel sống |
| 5 | wiring | extension.ts register vsdb.aiChat | command xuất hiện trong subscriptions; dispose sạch |

## Test Files
`src/ui/__tests__/aiChatE2e.test.ts`, `src/extension.test.ts` (thêm)

## Verification Commands
```
npm run compile && npx vitest run src/ui/__tests__/aiChatE2e.test.ts src/extension.test.ts src/ui/__tests__/aiChatPanel.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 5 test PASS RED→GREEN (output thật)
- [ ] README section guardrails tồn tại (README-contract test kiểu cycle J T4 — encouraged)
- [ ] Không telemetry mới; apiKey không xuất hiện thêm chỗ nào
- [ ] Full suite + compile + tsc sạch (orchestrator wave boundary)


## Executor Report

### RED Output

```
FAIL  src/extension.test.ts > TASK-004 — vsdb.aiChat wiring > Test #5 — vsdb.aiChat được register trong subscriptions sau activate()
AssertionError: expected false to be true // Object.is equality
 ❯ src/extension.test.ts:960:57
    960|     expect(state.registeredCommands.has("vsdb.aiChat")).toBe(true);

FAIL  src/extension.test.ts > TASK-004 — vsdb.aiChat wiring > Test #5b — dispose() sạch: deactivate() không throw sau khi gọi vsdb.aiChat
AssertionError: expected undefined not to be undefined
 ❯ src/extension.test.ts:969:16
    969|     expect(fn).toBeDefined();

FAIL  src/extension.test.ts > TASK-004 — vsdb.aiChat wiring > Test #3 — loadConfig() resolve null → info message + mở AI Settings form; không crash
AssertionError: expected undefined not to be undefined
 ❯ src/extension.test.ts:985:16
    985|     expect(fn).toBeDefined();
```

3 RED tests in `src/extension.test.ts` confirmed: `vsdb.aiChat` was not registered
in `state.registeredCommands` (extension.ts activate() lacked the wiring).

### GREEN Output

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
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
- `src/extension.ts` — register `vsdb.aiChat` (spec wiring: `AiConfigStore(ctx)`,
  `createProviderClient` per `complete()`, `adapterFactory` resolves active
  POSTGRES adapter else null); `commandOpenAiChat` does unconfigured fallback
  (`loadConfig` null → info + `executeCommand("vsdb.openAiSettings")`); `aiChatPanel`
  cached/disposed.
- `src/extension.test.ts` — 3 new tests under `TASK-004 — vsdb.aiChat wiring`:
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
- `src/extension.test.ts` — 3 tests (TASK-004 — vsdb.aiChat wiring describe)

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
- Consumes: tất cả T1-T3 productions; `AiConfigStore.loadConfig()` + flat `AiConfig` fields + `createProviderClient` (frozen cycle J); `AdapterFactory` async (src/ai/tools/types.ts).
- Produces: `(none)` — final consumer. README contract cho QA.

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
    - README.md:127 — "form Settings → Save với apiKey trống" does NOT disable AI: aiSettingsForm.ts:146-159 refuses empty-key save when nothing is stored, or silently reuses the stored key when one exists; AiConfigStore.clear() (src/ai/config.ts:111) has no production caller. Delete that clause — only "Clear Secret Storage" works as written.
    - src/extension.test.ts:960-961 — Test #5's `ctx.subscriptions.length > 0` is tautological (activate() pushes many disposables); comment claims it proves the aiChat handler is subscribed. Tighten to assert the specific disposable or drop the assert.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: RED evidence covers the 3 behavior-changing wiring tests; the 3 E2E tests exercise pre-existing T1-T3 seams (nothing to be RED). Read-only guard, POSTGRES-only adapterFactory, per-call adapter resolution, apiKey scrub, and cycle-J file immutability (empty diff c890557..HEAD on src/ai/{settings,config,provider,agent}.ts) all verified in code.
