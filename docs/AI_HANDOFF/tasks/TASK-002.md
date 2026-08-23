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
