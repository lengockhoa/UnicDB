# PLAN — Cycle K: AI DB-assist

## §1 Intent

Đưa AI core (cycle J) xuống đất: agent có thể **đọc** schema và chạy **SQL read-only** trên DB đã connect, và user có nơi nói chuyện với agent — chat panel trong extension. Quyết định binding (autonomy — không hỏi lại):

- Read-only tuyệt đối ở tool layer: chỉ SELECT/SHOW/EXPLAIN/WITH…SELECT; chặn multi-statement và `INTO`.
- Tools nhận adapter qua **injected factory** (hàm lấy adapter đang chọn từ ConnectionManager) — không global state.
- Không streaming (render markdown final text); Stop qua AbortController.
- PG-only runtime; mysql/mssql thiếu method → tool trả error message rõ ràng, không crash.
- Privacy không đổi: mọi request chỉ tới baseUrl user cấu hình; apiKey không rời SecretStorage.

## §2 Scope

In: `src/ai/tools/` (registry + introspection tools + SQL tool + schema-context formatter), `src/ui/aiChatPanel*.ts` + `webview/aiChatPanelMain.ts` (house webview pattern như newTableForm), wiring `src/extension.ts` + `package.json` (command `vsdb.aiChat` + editor/title menu), README AI DB-assist + guardrails section, tests unit (fake adapter + fake provider) — không cần PG container (adapter thật đã có integration test riêng ở cycle I).

Out: streaming UI, DML/DDL bất kỳ dạng nào, write tools, mysql/mssql introspection implementation, telemetry, Anthropic protocol, multi-connection chat sessions.

## §3 Approach — interface freeze (match src/ai/agent.ts + adapters/types.ts hiện có, NGUYÊN VĂN)

- `AgentTool` (frozen cycle J): `{ name: string; description: string; parameters: JSONSchema; execute(args): Promise<string> }` — tools mới implement đúng shape này.
- `ToolRegistry` (frozen): `{ list(): AgentTool[]; get(name): AgentTool|undefined }`.
- `runAgent(input: AgentInput, deps: AgentDeps, callbacks?)` — dùng nguyên vẹn; Cycle K chỉ truyền registry thật thay vì `EMPTY_TOOL_REGISTRY`.

New (Cycle K sở hữu):

```ts
export type AdapterFactory = () => Promise<DbAdapter | null>  // async: ConnectionManager.getAdapter() async-lazy (F2)
// src/ai/tools/registry.ts
export class DbToolRegistry implements ToolRegistry            // register(tool), list(), get(name)
export function createDbTools(adapterFactory: AdapterFactory): DbToolRegistry
// src/ai/tools/sqlTool.ts
export function createSqlTool(adapterFactory: AdapterFactory): AgentTool   // name: "run_sql" — consumes runQuery cursor (F1)
export function isReadOnlySql(sql: string): { ok: boolean; reason?: string }
// src/ai/tools/schemaTools.ts
export function createListTablesTool(adapterFactory): AgentTool            // "list_tables"
export function createDescribeTableTool(adapterFactory): AgentTool         // "describe_table"
// src/ai/tools/schemaContext.ts
export function formatSchemaContext(tables: TableInfo[], details: TableDetail[], budgetChars: number): string
// src/ui/aiChatPanel.ts
export interface ChatAbortToken { aborted: boolean }                       // F4: token, không AbortController
export class AiChatPanel { constructor(ctx, deps: AgentDeps, adapterFactory: AdapterFactory, style?); show(): void; dispose(): void }
```

Luồng: user mở panel → gõ câu hỏi → host build system prompt (schema context qua formatter, budget ~8k chars) → `runAgent({messages, tools: createDbTools(adapterFactory)}, deps, callbacks)` (**tools trên AgentInput** — agent.ts:100-103) → onStep đẩy "thinking/tool" bubbles → finalText render markdown (bỏ qua nếu token.aborted). Stop = ChatAbortToken. `run_sql` consume `runQuery().cursor.fetchBatch(50)+close()` vì PG single-SELECT trả results:[] (postgres.ts:156-169).
Mỗi task có bảng test riêng (xem task file). Tổng: happy path mỗi tool; ≥2 edge khác loại (guard: DML/multi-statement/INTO; factory null; budget cắt; args JSON sai; adapter throw → error string); regression (runAgent vẫn chạy được với registry thật 2 tool + fake provider loop tool-call 2 bước rồi trả lời — integration seam của cả cycle J+K).

## §5 Verification Commands

- TASK-001/002: `npx vitest run src/ai/tools/__tests__/<file>.test.ts && npx tsc --noEmit`
- TASK-003/004: `npm run compile && npx vitest run src/ui/__tests__/aiChatPanel*.test.ts <wiring tests> && npx tsc --noEmit`
- Wave boundary (orchestrator): full `npx vitest run` + `npm run compile`.

## §4 Test Plan (TDD)

Mỗi task có bảng test riêng (xem task file). Tổng: happy path mỗi tool; ≥2 edge khác loại (guard: DML/multi-statement/INTO/writable-CTE; factory null; budget cắt; adapter throw → error string); regression (runAgent chạy với registry thật 2 tool + fake provider tool-loop 2 bước — seam cycle J+K; run_sql DROP TABLE không bao giờ tới adapter).

## §6 Acceptance

- Chat panel mở từ command palette, hỏi schema → agent gọi list_tables/describe_table, trả lời có thật từ fake adapter trong test.
- `run_sql` với INSERT/UPDATE/DELETE/DROP/; /INTO bị chặn tại tool layer với reason.
- Không active connection → agent trả lời "no active connection", không crash.
- Full suite xanh + tsc sạch; README có section guardrails; không telemetry; apiKey không xuất hiện trong bất kỳ message/log mới nào.

## §7 Task split

Theo INDEX.md đã scaffold: T1 registry+introspection tools (wave 1) · T2 sql tool + context formatter (wave 1) · T3 chat panel webview (wave 2) · T4 integration + guardrails + README (wave 3). Dependencies: T3 sau T1+T2; T4 sau T3.

## Planner Self-Audit

- Freeze list so từng ký tự với src/ai/agent.ts:16-62 và adapters/types.ts:89-114 — đọc trực tiếp, không từ trí nhớ.
- Registry thật là consumers của EMPTY_TOOL_REGISTRY seam — cycle J test #empty-registry vẫn pass (không sửa file cycle J).
- Read-only guard ở tool layer (không phải adapter) vì adapter.runQuery là đường产品 cho user; AI path phải có chốt riêng.
- Budget cap formatter chống prompt blowup với schema lớn.
- Không hỏi user thêm — mọi quyết định nằm ở §1.

## Plan Review Log

### Round 1 — 2026-08-23 · unic/unic-smart (PlanRev-K, independent context)

Status: **Issues Found** — 2 Critical / 5 Important / 2 Minor. The frozen §3 declarations that mirror existing source (`AgentTool`/`ToolRegistry`/`AgentInput`/`AgentDeps`/`runAgent`, `DbAdapter.listTables/listTableDetail`, `TableInfo`/`TableDetail`) match `src/ai/agent.ts` and `src/adapters/types.ts` verbatim — no drift there. Findings below are where the plan diverges from real runtime behavior or hides cross-wave rework.

COMPLETENESS:
  - none (every task has Target Files / frozen Spec / happy + ≥2 distinct-class edges + regression / Test Files / Verification Commands incl. `npx tsc --noEmit` — project has no lint script, typecheck covers it — / Acceptance / Interfaces Consumes-Produces)
CONSISTENCY:
  - F2 (AbortController claim vs token design), F7 (runAgent call shape vs frozen signature)
CLARITY:
  - F3 (wiring symbols), F6 (INTO-scan scope)
SCOPE:
  - none (read-only tool-layer guard, PG-only, no streaming/DML/telemetry; no cycle J file appears in any Target Files)
YAGNI:
  - none

FINDINGS (numbered):

Critical:
1. **run_sql reads rows from `runQuery()` but PostgresAdapter routes single SELECT through a server cursor and returns `results: []` + `batched`** — src/adapters/postgres.ts:156-169: "Statement đơn, bắt đầu bằng SELECT, không có `;` → DECLARE CURSOR, trả về QueryResult rỗng + BatchedQuery". TASK-002's flow (`adapter.runQuery(sql)` → slice 50 → `{columns, rows, rowCount, truncated}`) returns an empty payload for the cycle's PRIMARY path: every real PG SELECT. Tests won't catch it — fake adapters return inline rows. Fix: spec run_sql to consume `RunResult`: if `batched` present, `fetchBatch()` until ≥50 rows or EOF, then ALWAYS `close()`; else read `results[0]`. Add edge test "cursor-shaped RunResult → tool still returns columns/rows".
2. **`AdapterFactory = () => DbAdapter | null` (sync) is unwirable against the real ConnectionManager.** No `getActiveAdapter()` exists; the only accessors are `getActive(): ConnectionConfig | null` (connectionManager.ts:182) and async lazy `getAdapter(): Promise<DbAdapter>` (:274-309). The cached `currentAdapter` is private AND nulled by the 10-min idle timer while `currentActiveId` persists — a sync snapshot can hand the agent a closed adapter. TASK-004's "getActiveAdapter() nếu có" references a nonexistent method. Fix before wave 1: freeze `type AdapterFactory = () => Promise<DbAdapter | null>`; tools await it inside `execute`; no-connection = null (or getAdapter rejection) → "No active connection…" string.

Important:
3. TASK-004 wiring sketch uses nonexistent `loadAiConfig` and wrong shape `cfg.settings.method`/`cfg.settings.timeoutMs`. Real: `AiConfigStore.loadConfig(): Promise<AiConfig|null>` (src/ai/config.ts:61); `AiConfig extends AiSettings` flat — use `cfg.baseUrl/apiKey/method/timeoutMs`. As sketched, wiring throws at command time (`cfg.settings` undefined → TypeError).
4. Stop overpromised: PLAN §1/§3 say "Stop qua AbortController" but `runAgent` takes no signal (callbacks = onStep/onError only). TASK-003's token is the implementable design — align PLAN wording. Also T3 spec must gate the FINAL assistant post on `!token.aborted` (currently only subsequent onStep is skipped); otherwise a late resolve posts a stale answer after Stop.
5. `AdapterFactory` lives in T1's registry.ts while T2 (same wave) imports it — tolerable as a type-only import, but combined with F2's forced signature change it is a cross-wave coordination hazard. Fix: move the type to `src/ai/tools/types.ts` (add to T1 Target Files as owner) so the F2 async change lands in one frozen file both waves import.
6. Read-only guard has a writable-CTE hole: `WITH x AS (INSERT … RETURNING *) SELECT …` starts with `with`, passes the first-keyword check, and executes DML — breaking §1 "Read-only tuyệt đối". Fix: for `with`-led statements reject if the body contains word-boundary `insert|update|delete|merge` (same class of scan as the existing `into` check); add an edge test. Also state explicitly that the ` into ` scan applies to ALL branches — the spec's parenthetical reads as with-only while test #4 (`SELECT * INTO t2`) implies unconditional.
7. PLAN §3 flow line `runAgent(msgs, deps, { tools: createDbTools(adapterFactory) })` puts `tools` in the callbacks slot — the real signature is `runAgent(input: AgentInput, deps, callbacks?)` with `tools` on `input` (agent.ts:100-103). TASK-003 already has the correct form; fix the PLAN line so an executor reading §3 isn't misled.

Minor:
8. TASK-003 package.json note "activationEvents main已有的 đủ (onCommand)" is garbled and contradicts house pattern (all 18 commands listed explicitly in activationEvents). Decide: add `"onCommand:vsdb.aiChat"` like its siblings.
9. PLAN §3 says budget "~8k chars" but TASK-003 never pins the constant the host passes to `formatSchemaContext` — pin `budgetChars = 8000` in the T3 spec so executors don't pick arbitrary values.

NOTES: Plan review only — no executor report, so no model-isolation check applies. F1/F2 are frozen-interface changes that must land in PLAN.md + TASK-001/002 before wave 1 starts; recommend one quick re-review after the planner applies them.

### Round 2 — disposition (planner, 2026-08-23)
- F1 (Critical) FIXED: TASK-002 spec giờ bắt buộc cursor flow (fetchBatch(50)+close trong finally), fallback run.results chỉ khi không có cursor; test #1/#1b/#7 cover.
- F2 (Critical) FIXED: AdapterFactory là async () => Promise<DbAdapter|null>, frozen trong src/ai/tools/types.ts (đã tạo sẵn — executors không tạo lại).
- F3 (Important) FIXED: TASK-004 wiring dùng new AiConfigStore(ctx).loadConfig() + flat cfg.baseUrl/apiKey/method/timeoutMs (không loadAiConfig, không cfg.settings.*).
- F4 (Important) FIXED: Stop = ChatAbortToken (export từ aiChatPanel.ts), gate assistant final post trên !token.aborted; TASK-003 spec + test #4 cập nhật.
- F5 (Important) FIXED: AdapterFactory sống ở src/ai/tools/types.ts — T1 và T2 import, không ai sở hữu chéo.
- F6 (Important) FIXED: isReadOnlySql chặn writable-CTE (with-body chứa insert|update|delete|merge word-boundary) + INTO scan unconditional; test #4 thêm case WITH…INSERT.
- F7 (Important) FIXED: PLAN §3 ghi đúng runAgent({messages, tools}, deps, callbacks) — tools trên AgentInput (agent.ts:100-103).
- Minor (2): chấp nhận — (a) comment trong TASK-001 "run_sql do TASK-002 register ở caller" đã explicit; (b) budget ~8k chars giữ nguyên như heuristic.
