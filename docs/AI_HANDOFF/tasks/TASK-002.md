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

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/schemaContext.test.ts && npx tsc --noEmit
  result: 17 pass / 0 fail; tsc exit 0 (fresh rerun by reviewer)
TEST_PLAN_COVERAGE: all-followed (8 rows → 17 its, real expect()s; RED output is real module-not-found)
FINDINGS:
  critical: none
  important:
    - file: src/ai/tools/sqlTool.ts:92-106 — `EXPLAIN ANALYZE <writable stmt>` BYPASSES the guard. Verified by calling the real isReadOnlySql: `EXPLAIN ANALYZE DELETE FROM t`, `EXPLAIN ANALYZE UPDATE t SET a=1`, `EXPLAIN ANALYZE CREATE TABLE t2 AS SELECT * FROM t`, and `EXPLAIN ANALYZE REFRESH MATERIALIZED VIEW mv` all return ok:true. PG semantics: ANALYZE causes the statement to actually EXECUTE (postgresql.org/docs/current/sql-explain.html: "ANALYZE ... causes the statement to be actually executed"), so this is a real write path (DML executed / table created / MV rebuilt), violating the task goal "chặn mọi thứ khác ở tool layer". Fix: when first keyword is explain, strip optional `ANALYZE|ANALYSE [ ( options... ) ]`, then require the next keyword ∈ {select, show, with} (WITH still subject to the writable-CTE + INTO scans). Add regression tests for the 4 payloads above.
  minor:
    - file: src/ai/tools/sqlTool.ts:70-73 — single `$` toggles dollar-quote state, so `SELECT $$into$$` is falsely rejected as INTO (PG $$...$$ quoted string content is skipped by src/core/statementParser.ts:278 but not here). False-positive only (fail-closed); acceptable to leave documented or align token rules.
    - file: src/ai/tools/sqlTool.ts:135 — fetchBatch() takes no arg (interface frozen), spec prose said fetchBatch(50); 50-row cap applied after fetch (slice). Executor documented; no action.
    - file: src/ai/tools/sqlTool.ts:92-95 — SELECT of side-effecting functions (e.g. `SELECT pg_terminate_backend(1)`) is inherently passable in any SELECT-only guard; leave to T4 guardrails/agent policy, note only.
POSITIVE: multi-statement, comment-stripping, case, writable-CTE, unconditional INTO, cursor close-in-finally (incl. fetchBatch throw), fallback path, 50-row truncation, budget cut at table boundary (footer+separator accounting verified correct) — all verified clean by adversarial run. No vscode import. Cycle-J files untouched (git diff c890557..HEAD empty on src/ai/{settings,config,provider,agent}.ts). src/ai/tools/types.ts untouched.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: One blocking guard bypass (EXPLAIN ANALYZE + write statement); schemaContext half is clean and shippable as-is.

## Executor Report (fix round 1)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: FixK-T002
SUMMARY: Closed the EXPLAIN ANALYZE / CREATE TABLE AS / REFRESH MV bypass in `isReadOnlySql`. New helper `stripExplainPrefix` reduces an `EXPLAIN [ANALYZE|ANALYSE|VERBOSE] [(options)]` head to the inner statement; the inner is re-checked against the existing first-keyword / INTO / writable-CTE guards. EXPLAIN SELECT/WITH…SELECT/SHOW remain allowed; EXPLAIN ANALYZE wrapping DELETE/UPDATE/INSERT/CREATE/REFRESH/DROP/TRUNCATE/INSERT-in-CTE/SELECT…INTO all now reject. 23 new regression tests added (rejections + happy-parens-options + bare-EXPLAIN + comment-prefixed EXPLAIN); all 17 pre-existing tests stay green (40 total in the two files). Minor findings (dollar-quote INTO false-positive, side-effecting SELECT functions, frozen `fetchBatch(50)` signature): left as reviewer-documented.
TEST_PLAN_FOLLOWED: inline (test cases #1-#8 in §Test Cases — pre-existing 17 its untouched, +23 EXPLAIN-fix its appended inside the `isReadOnlySql` describe block in src/ai/tools/__tests__/sqlTool.test.ts)
FILES_CHANGED:
  - src/ai/tools/sqlTool.ts: `isReadOnlySql` EXPLAIN branch + new `stripExplainPrefix` helper
  - src/ai/tools/__tests__/sqlTool.test.ts: 23 new `it` blocks covering EXPLAIN ANALYZE/ANALYSE/VERBOSE write-verb rejection, parens-options form, comment-prefixed EXPLAIN, bare EXPLAIN, EXPLAIN-wrapping writable CTE / SELECT…INTO
TESTS_ADDED:
  - src/ai/tools/__tests__/sqlTool.test.ts (isReadOnlySql describe):
    accepts EXPLAIN SELECT
    accepts EXPLAIN ANALYZE SELECT
    accepts EXPLAIN ANALYSE SELECT (British spelling)
    accepts EXPLAIN WITH…SELECT
    accepts EXPLAIN ANALYZE (FORMAT JSON) SELECT (parens-options form)
    accepts EXPLAIN (FORMAT JSON, ANALYZE) SELECT (parens-first form)
    rejects EXPLAIN ANALYZE DELETE (PG actually executes the statement)
    rejects EXPLAIN ANALYZE UPDATE
    rejects EXPLAIN ANALYZE INSERT
    rejects EXPLAIN ANALYZE CREATE TABLE AS SELECT
    rejects EXPLAIN ANALYZE REFRESH MATERIALIZED VIEW
    rejects EXPLAIN (ANALYZE) DELETE (parenthesized options form)
    rejects EXPLAIN DELETE (without ANALYZE, still a write)
    rejects EXPLAIN UPDATE
    rejects EXPLAIN CREATE TABLE AS SELECT
    rejects EXPLAIN REFRESH MATERIALIZED VIEW
    rejects EXPLAIN DROP TABLE
    rejects EXPLAIN TRUNCATE
    rejects EXPLAIN VERBOSE DELETE
    rejects EXPLAIN ANALYZE WITH…INSERT…SELECT (writable CTE behind EXPLAIN)
    rejects EXPLAIN SELECT…INTO (SELECT INTO behind EXPLAIN)
    rejects bare EXPLAIN with no statement
    rejects EXPLAIN ANALYZE with -- comment wrapping a write
VERIFICATION:
  command: npx vitest run src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/schemaContext.test.ts
  result: 40 pass / 0 fail (exit 0)
  output_excerpt: |
    ✓ src/ai/tools/__tests__/schemaContext.test.ts  (4 tests) 2ms
    ✓ src/ai/tools/__tests__/sqlTool.test.ts  (36 tests) 6ms
    Test Files  2 passed (2)
         Tests  40 passed (40)
  command2: npx tsc --noEmit
  result2: exit 0 (no diagnostics)
ISSUES:
  - Minor (per reviewer): `SELECT $$into$$` is still rejected by the unconditional INTO scan; left as documented fail-closed (no dollar-quote skipping in `isReadOnlySql`).
  - Minor (per reviewer): SELECT of side-effecting functions (`SELECT pg_terminate_backend(1)`) passes; out of scope for this guard.
  - Minor (per reviewer): `BatchedQuery.fetchBatch()` interface takes no arg; 50-row cap is applied via `slice` after fetch — unchanged.
HANDOFF_TO_REVIEWER: yes
NEXT: pending_review (orchestrator: set INDEX row to `pending_review`, RevK-T002 picks up)
