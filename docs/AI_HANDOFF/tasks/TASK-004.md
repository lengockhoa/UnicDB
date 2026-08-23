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

## Interfaces
- Consumes: tất cả T1-T3 productions; `AiConfigStore.loadConfig()` + flat `AiConfig` fields + `createProviderClient` (frozen cycle J); `AdapterFactory` async (src/ai/tools/types.ts).
- Produces: `(none)` — final consumer. README contract cho QA.
