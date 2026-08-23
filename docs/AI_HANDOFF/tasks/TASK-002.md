# TASK-002 — SQL read-only executor tool + schema→context formatter

## Goal
Tool `run_sql` chỉ cho SELECT/SHOW/EXPLAIN (+WITH sạch), chặn mọi thứ khác ở tool layer; và formatter biến introspection thành system-prompt context có budget cap.

## Target Files
- `src/ai/tools/sqlTool.ts` (mới)
- `src/ai/tools/schemaContext.ts` (mới)
- `src/ai/tools/__tests__/sqlTool.test.ts`, `src/ai/tools/__tests__/schemaContext.test.ts` (mới)

## Spec (frozen)
```ts
import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types"; // async — frozen file, KHÔNG tạo lại
export function createSqlTool(f: AdapterFactory): AgentTool // name "run_sql", args {sql: string}; registry-level add: caller register(createSqlTool(f)) alongside createDbTools
export function isReadOnlySql(sql: string): { ok: boolean; reason?: string }
// schemaContext.ts
import type { TableInfo, TableDetail } from "../../adapters/types";
export function formatSchemaContext(tables: TableInfo[], details: TableDetail[], budgetChars: number): string
```
- **Cursor consumption (F1 — bắt buộc)**: PG single-SELECT qua `adapter.runQuery()` trả `results: []` + cursor (postgres.ts:156-169). `run_sql` MUST: `const run = await adapter.runQuery(sql);` rồi nếu `run.cursor` tồn tại → `await run.cursor.fetchBatch(50)` lấy cột+dòng + `run.cursor.close()` (finally); chỉ fall back sang `run.results` khi không có cursor (fake adapters/tests). Không làm vậy thì path PG thật rỗng.
- `isReadOnlySql`: trim + strip leading comments (`-- …\n`, `/* */`) trước khi check; lowercase; OK iff **đúng 1 statement** (không `;` ngoài possibly-cuối-câu) VÀ first keyword ∈ {select, show, explain, with} VÀ **không chứa writable-CTE**: nếu first keyword là with → body không được chứa `insert|update|delete|merge` word-boundary ở any vị trí (WITH x AS (INSERT…) SELECT phải reject). `into` scan là unconditional (word-boundary) — SELECT…INTO reject mọi trường hợp. Reasons: `"Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)"`, `"Multiple statements are not allowed"`, `"Read-only violation: INTO"`, `"Read-only violation: writable CTE (INSERT/UPDATE/DELETE/MERGE)"`.
- `run_sql` flow: factory resolve null → no-connection message; `!isReadOnlySql().ok` → reason string; else cursor-flow trên → rows slice 50 → JSON `{columns, rows, rowCount, truncated}`. Adapter/cursor throw → `"Tool failed: <msg>"`.
- `formatSchemaContext`: render `schema.table` + columns (`name type null?`) + PK/FK một dòng mỗi constraint; nếu tổng > budgetChars: ưu tiên bảng theo thứ tự input, cắt ở ranh giới bảng, kết thúc bằng `… (+N more tables omitted)`; budget ≤ 0 → "".
- Không import vscode.

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | SELECT hợp lệ qua fake adapter CÓ cursor | fetchBatch(50) được gọi, cursor.close() luôn gọi, JSON đúng |
| 1b | happy | fake adapter KHÔNG cursor → fallback run.results | JSON đúng từ results |
| 2 | happy | formatSchemaContext render đủ trong budget | Chuỗi chứa từng bảng + cột, không dấu cắt |
| 3 | edge (guard DML) | INSERT/UPDATE/DELETE/DROP/TRUNCATE → reject | ok=false, reason read-only; tool trả reason |
| 4 | edge (guard khác loại) | multi-statement `SELECT 1; DROP TABLE x`, `SELECT * INTO t2 FROM t`, VÀ `WITH x AS (INSERT INTO a VALUES(1) RETURNING *) SELECT * FROM x` | 3 case đều reject với reason tương ứng (writable-CTE reason riêng) |
| 5 | edge (masking) | leading `-- comment\n` trước SELECT | ok=true (comment bị strip) |
| 6 | edge (budget) | schema lớn vượt budget → cắt nguyên bảng + đuôi "(+N more tables omitted)" | Không vượt budgetChars; bảng đầu vẫn nguyên |
| 7 | edge (factory/throw) | factory null; adapter throw; cursor.fetchBatch throw (close vẫn gọi) | No-connection msg; "Tool failed: …"; "Tool failed: …" |
| 8 | regression | truncation >50 rows | JSON `truncated:true`, rows.length==50 |

## Test Files
`src/ai/tools/__tests__/sqlTool.test.ts`, `src/ai/tools/__tests__/schemaContext.test.ts`

## Verification Commands
```
npx vitest run src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/schemaContext.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 10 test PASS RED→GREEN (output thật paste)
- [ ] Guard không dùng chỉ prefix-match: comment-led SELECT pass; `WITH … INSERT …` fail; `SELECT 1;SELECT 2` fail
- [ ] Cursor path: close() gọi cả khi fetchBatch throw
- [ ] Không import vscode; không sửa file cycle J; không sửa src/ai/tools/types.ts
- [ ] `npx tsc --noEmit` sạch

## Interfaces
- Consumes: `AgentTool` (frozen), `AdapterFactory` (src/ai/tools/types.ts — async, frozen), `DbAdapter.runQuery` + `BatchedQuery` (`fetchBatch`/`close`), `TableInfo`/`TableDetail`.
- Produces: `createSqlTool`, `isReadOnlySql`, `formatSchemaContext` (T3 system prompt, T4 consume).

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecK-T002
SUMMARY: Implemented `createSqlTool` + `isReadOnlySql` in src/ai/tools/sqlTool.ts and `formatSchemaContext` in src/ai/tools/schemaContext.ts per F1 cursor flow + read-only guard spec; 17 TDD tests covering all 9 task rows + sub-cases. Implementation branch: handoff/task-002 (worktree .worktrees/task-002).
TEST_PLAN_FOLLOWED: inline (test cases #1-#8 in §Test Cases split into 17 vitest `it` blocks — #4 split per-subcase, #7 split per-failure-mode)
FILES_CHANGED:
  - src/ai/tools/sqlTool.ts: new — AgentTool `run_sql` + `isReadOnlySql` guard
  - src/ai/tools/schemaContext.ts: new — budget-capped renderer
  - src/ai/tools/__tests__/sqlTool.test.ts: new — 13 tests
  - src/ai/tools/__tests__/schemaContext.test.ts: new — 4 tests
TESTS_ADDED:
  - src/ai/tools/__tests__/sqlTool.test.ts: 13 (isReadOnlySql×6, createSqlTool×7)
  - src/ai/tools/__tests__/schemaContext.test.ts: 4 (render, budget-cut+footer, empty-budget, PK/FK)
VERIFICATION:
  command: npx vitest run src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/schemaContext.test.ts
  result: 17 pass / 0 fail (exit 0)
  output_excerpt: |
    ✓ src/ai/tools/__tests__/schemaContext.test.ts  (4 tests) 2ms
    ✓ src/ai/tools/__tests__/sqlTool.test.ts  (13 tests) 4ms
    Test Files  2 passed (2)
         Tests  17 passed (17)
  command2: npx tsc --noEmit
  result2: exit 0 (no diagnostics)
ISSUES:
  - BatchedQuery.fetchBatch() in src/adapters/types.ts takes 0 args, but spec §F1 prose says `fetchBatch(50)`. Code calls fetchBatch() per interface; test asserts `toHaveBeenCalledWith()` (no arg). No change to frozen types.ts.
  - Guard ordering: writable-CTE check runs BEFORE unconditional INTO scan when first keyword is WITH, so `WITH x AS (INSERT INTO a …)` yields writable-CTE reason (more specific) instead of INTO. Spec accepts both reasons; test asserts writable-CTE.
  - Test #6 budget computed dynamically as `indexOf("\n\nTable: public.orders") + 30` (vs spec example which had internal inconsistency); kept first table block + footer, dropped 2.
HANDOFF_TO_REVIEWER: yes — files on handoff/task-002 worktree, awaiting orchestrator copy-back
NEXT: ready for review

### RED output (initial run, no implementation modules)
```
 RUN  v1.4.x /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002

 ❯ src/ai/tools/__tests__/schemaContext.test.ts  (0 test)
 ❯ src/ai/tools/__tests__/sqlTool.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/tools/__tests__/schemaContext.test.ts
Error: Failed to load url ../schemaContext (resolved id: ../schemaContext) ...

 FAIL  src/ai/tools/__tests__/sqlTool.test.ts
Error: Failed to load url ../sqlTool (resolved id: ../sqlTool) ...

 Test Files  2 failed (2)
      Tests  no tests
```

### GREEN output (fresh)
```
 ✓ src/ai/tools/__tests__/schemaContext.test.ts  (4 tests) 2ms
 ✓ src/ai/tools/__tests__/sqlTool.test.ts  (13 tests) 4ms
 Test Files  2 passed (2)
      Tests  17 passed (17)
 Start at  20:52:55
 Duration  172ms
```
tsc --noEmit: exit 0, no diagnostics.
