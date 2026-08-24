# TASK-002 — Full-DB context injection vào buildMessages

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D1, §4 T2

## Goal

`buildMessages` (src/ui/aiChatPanel.ts:112-142) thay schema-context 30-bảng-public bằng full-DB DDL context: mọi user schema + tables + views, render bằng `buildDatabaseStructure`, budget 12_000 chars cut-at-block-boundary, footer hướng model gọi tool `export_structure`.

## Target Files

- `src/ui/aiChatPanel.ts` — CHỈ region imports (lines ~37-64) + `buildMessages` (lines ~111-142) + constants `SCHEMA_CONTEXT_BUDGET`/`SCHEMA_CONTEXT_TABLE_LIMIT` (lines 68-69) + 1 dòng register tool trong `runBuiltinTurn` (line ~333). KHÔNG đụng gì khác trong file (TASK-003 owns handleClear/handleSend/handleReady, chạy sau task này).
- `src/ui/__tests__/aiChatPanel.test.ts` — append describe "buildMessages — full-DB context" (#1, #3, #4, #5).
- `src/ui/__tests__/aiChatE2e.test.ts` — append describe "E2E full-DB context" (#2, #6).

## Spec

```ts
// src/ui/aiChatPanel.ts — SỬA:
const SCHEMA_CONTEXT_BUDGET = 12_000; // chars (tăng từ 8000)
const SCHEMA_CONTEXT_TABLE_LIMIT = 200; // objects (tăng từ 30)

// buildMessages giữ NGUYÊN signature (caller không đổi):
async function buildMessages(
  factory: AdapterFactory,
  history: ChatMessage[],
  userMsg: ChatMessage,
  opts?: { contextBudgetChars?: number; contextTableLimit?: number }, // injectable cho tests (review #2)

// Thân hàm MỚI:
// 1. adapter = await factory(); null → context = "" (giữ hành vi cũ)
// 2. Thu thập full-DB (try/catch toàn bộ — introspection fail → context=""):
//      schemas = await adapter.listSchemas(false)   // bỏ system schemas
//      tables/views flatten = for mỗi schema: listTables(s.name), listViews(s.name)
//        — lỗi 1 schema: skip schema đó (try/catch per-schema), tiếp tục
//      cap tổng objects (tables+views) = SCHEMA_CONTEXT_TABLE_LIMIT: giữ thứ tự
//        schema→object, dư bị drop + đếm dropped
//      columns: listColumns(name, schema) per object, try/catch per-object
//        → missing = [] (map sang ExportColumn {name,dataType,nullable,isPrimaryKey})
//      (listTableDetail KHÔNG dùng nữa; NotImplementedError từ driver ≠ PG
//       (listSchemas/listColumns mysql-mssql-compatible nhưng DB này dùng
//       listSchemas-based flow) — mọi throw mức adapter → context="")
// 3. ddl = buildDatabaseStructure({schemas, tables, views, columns})
// 4. Budget: effectiveBudget = opts?.contextBudgetChars ?? SCHEMA_CONTEXT_BUDGET
//    (MỘT nguồn duy nhất — const production 12_000; tests inject giá trị nhỏ).
//    ddl.length > effectiveBudget → cắt theo BLOCK boundary
//    (block = text giữa 2 blank lines — mỗi object là 1 block; tables VÀ views
//     CHUNG một budget pool theo thứ tự render), giữ blocks đầu cho tới khi
//    thêm block kế vượt budget; KHÔNG cắt giữa 1 object.
//    Block ĐẦU vượt budget một mình (table khổng lồ) → vẫn giữ block đầu
//    (context không rỗng khi DB có object), các block sau drop vào omitted.
//    Footer (chỉ khi dropped > 0 và footer vừa budget, else bỏ footer):
//    `\n\n-- (+N more objects omitted — call export_structure for full context)`
// 5. runBuiltinTurn: sau dòng `registry.register(createSqlTool(...))` THÊM:
//    registry.register(createExportStructureTool(this.options.adapterFactory));
//    (import từ "../ai/tools/schemaTools")
// 6. System prompt: context !== "" →
//    `You are VSDB's AI assistant. Help the user explore and query their database.\n\nDatabase structure (DDL):\n${context}\n\nYou can call the export_structure tool for the complete structure when truncated.`
//    context === "" → giữ nguyên prompt cũ (line ~139 hiện tại).
```

Import mới: `createExportStructureTool` từ `../ai/tools/schemaTools`; import `formatSchemaContext` XÓA khỏi file này (module src/ai/tools/schemaContext.ts vẫn giữ nguyên — KHÔNG xóa module, các test của nó vẫn pass).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | multi-schema PG: context chứa tables mọi schema + views | system message chứa `Database structure (DDL):`, `CREATE TABLE public.users`, `CREATE TABLE sales.deals`, `-- View structure: public.v_users` | fake adapter: listSchemas→[public,sales], listTables/listViews/listColumns mock; assert qua deps.complete spy bắt ProviderRequest.messages[0] |
| 2 | happy | E2E: system prompt có DDL → model answer cuối | fake fetch call 1 trả text answer; request body messages[0] chứa `CREATE TABLE public.users`; assistant bubble posted + done | pattern aiChatE2e.test.ts makeDepsWithFetch + fake adapter có data |
| 3 | edge | budget cut at block boundary (injected, review #2) | inject `{contextBudgetChars: 2000}` qua opts; DB nhiều tables → context ≤ 2000 + footer `-- (+N more objects omitted — call export_structure for full context)`; mỗi block `CREATE TABLE` nguyên vẹn kết thúc `);` — KHÔNG đụng hằng số production 12_000 | fake adapter nhiều table, buildMessages(..., {contextBudgetChars:2000}) |
| 4 | edge | no active connection → prompt cũ | factory resolves null → system prompt === `"You are VSDB's AI assistant. Help the user explore and query their database."` (không "Database structure"), messages vẫn [system,...history,user] | factory null |
| 5 | edge | 1 schema introspection throw → skip schema | listTables("sales") rejects Error, "public" OK → context có public tables, KHÔNG có sales tables, không throw | per-schema reject mock |
| 6 | regression | E2E tool-loop cũ không vỡ + export_structure đã đăng ký | test hiện có "E2E happy 2-step" vẫn pass; thêm assert: request tools array chứa def `{name:"export_structure"}` | fake fetch 2-step như hiện có |
| 7 | edge | single table DDL > budget (oversize block, review #4) | inject `{contextBudgetChars: 300}` + table DDL ~800 chars → block đầu vẫn giữ nguyên (vượt budget), omitted-count đúng, context KHÔNG rỗng, KHÔNG block CREATE TABLE cắt dở | fake adapter: 1 table lớn + 1 table nhỏ |

## Test Files

- `src/ui/__tests__/aiChatPanel.test.ts` — #1, #3, #4, #5, #7 (pattern panel harness + fake adapter + spy deps.complete).
- `src/ui/__tests__/aiChatE2e.test.ts` — #2, #6 (pattern createFakeAdapter/makeDepsWithFetch có sẵn lines 151-262).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatE2e.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước trên code cũ với budget/marker mới).
- [ ] System prompt chứa DDL mọi user schema (không chỉ public), gồm views.
- [ ] Context không vượt 12_000 chars; cắt nguyên block; footer chỉ khi có drop.
- [ ] Factory null / introspection fail → prompt cũ, không crash.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (tiêu thụ `buildDatabaseStructure` + `createExportStructureTool`).

## Interfaces

- Consumes: `buildDatabaseStructure(db: DatabaseStructureInput): string`, `DatabaseStructureInput { schemas; tables; views; columns: Record<string, ExportColumn[]> }`, `createExportStructureTool(f: AdapterFactory): AgentTool` (TASK-001 produces). Hiện có: `AdapterFactory`, `ChatMessage`, `createDbTools`, `createSqlTool`.
- Produces: buildMessages behavior mới (signature giữ nguyên); system prompt marker `Database structure (DDL):` + `export_structure` tool trong builtin registry. TASK-003 các test về clear/recovery KHÔNG phụ thuộc marker này (chỉ dep same-file ordering).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
TASK-003 đụng cùng file nhưng khác region (handleClear/handleSend/handleReady + webview files). T3 dep T2 → serial, không simultaneous edit. Dòng import T2 thêm (createExportStructureTool) không giao dòng nào T3 thêm.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
