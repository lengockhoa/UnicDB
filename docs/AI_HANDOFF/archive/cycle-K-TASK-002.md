# TASK-002 — SQL read-only executor tool + schema→context formatter

## Goal
A `run_sql` tool that allows only SELECT/SHOW/EXPLAIN (plus a clean WITH), blocks everything else at the tool layer; plus a formatter that turns introspection output into budget-capped system-prompt context.

## Target Files
- `src/ai/tools/sqlTool.ts` (new)
- `src/ai/tools/schemaContext.ts` (new)
- `src/ai/tools/__tests__/sqlTool.test.ts`, `src/ai/tools/__tests__/schemaContext.test.ts` (new)

## Spec (frozen)
```ts
import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types"; // async — frozen file, do NOT recreate
export function createSqlTool(f: AdapterFactory): AgentTool // name "run_sql", args {sql: string}; registry-level add: caller register(createSqlTool(f)) alongside createDbTools
export function isReadOnlySql(sql: string): { ok: boolean; reason?: string }
// schemaContext.ts
import type { TableInfo, TableDetail } from "../../adapters/types";
export function formatSchemaContext(tables: TableInfo[], details: TableDetail[], budgetChars: number): string
```
- **Cursor consumption (F1 — mandatory)**: PG single-SELECT through `adapter.runQuery()` returns `results: []` + cursor (postgres.ts:156-169). `run_sql` MUST: `const run = await adapter.runQuery(sql);`, then if `run.cursor` exists → `await run.cursor.fetchBatch(50)` to fetch columns+rows + `run.cursor.close()` (in finally); fall back to `run.results` only when no cursor exists (fake adapters/tests). Skipping this leaves the real PG path empty.
- `isReadOnlySql`: trim + strip leading comments (`-- …\n`, `/* */`) before checking; lowercase; OK iff **exactly 1 statement** (no `;` other than a possible trailing one) AND the first keyword ∈ {select, show, explain, with} AND **no writable CTE**: if the first keyword is with → the body MUST NOT contain word-boundary `insert|update|delete|merge` anywhere (WITH x AS (INSERT…) SELECT must reject). The `into` scan is unconditional (word-boundary) — SELECT…INTO is rejected in every branch. Reasons: `"Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)"`, `"Multiple statements are not allowed"`, `"Read-only violation: INTO"`, `"Read-only violation: writable CTE (INSERT/UPDATE/DELETE/MERGE)"`.
- `run_sql` flow: factory resolve null → no-connection message; `!isReadOnlySql().ok` → reason string; otherwise cursor flow above → slice to 50 rows → JSON `{columns, rows, rowCount, truncated}`. Adapter/cursor throw → `"Tool failed: <msg>"`.
- `formatSchemaContext`: render `schema.table` + columns (`name type null?`) + PK/FK one line per constraint; if total exceeds budgetChars: prefer tables in input order, cut at table boundaries, end with `… (+N more tables omitted)`; budget ≤ 0 → "".
- No vscode import.

## Test Cases
| # | Type | Name | Expected |
|---|------|-----|----------|
| 1 | happy | Valid SELECT through fake adapter WITH cursor | fetchBatch(50) is called, cursor.close() is always called, JSON correct |
| 1b | happy | Fake adapter WITHOUT cursor → fallback to run.results | JSON correct from results |
| 2 | happy | formatSchemaContext renders fully within budget | String contains every table + column, no truncation marker |
| 3 | edge (DML guard) | INSERT/UPDATE/DELETE/DROP/TRUNCATE → reject | ok=false, reason read-only; tool returns the reason |
| 4 | edge (other-guard) | multi-statement `SELECT 1; DROP TABLE x`, `SELECT * INTO t2 FROM t`, AND `WITH x AS (INSERT INTO a VALUES(1) RETURNING *) SELECT * FROM x` | all 3 cases reject with their respective reasons (separate writable-CTE reason) |
| 5 | edge (masking) | leading `-- comment\n` before SELECT | ok=true (comment stripped) |
| 6 | edge (budget) | schema too large for budget → cuts whole tables + trailing "(+N more tables omitted)" | Does not exceed budgetChars; first table remains intact |
| 7 | edge (factory/throw) | factory null; adapter throws; cursor.fetchBatch throws (close still runs) | No-connection message; "Tool failed: …"; "Tool failed: …" |
| 8 | regression | truncation >50 rows | JSON `truncated:true`, rows.length==50 |

## Test Files
`src/ai/tools/__tests__/sqlTool.test.ts`, `src/ai/tools/__tests__/schemaContext.test.ts`

## Verification Commands
```
npx vitest run src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/schemaContext.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 10 tests PASS RED→GREEN (real output pasted)
- [ ] Guard does not use prefix-only matching: comment-led SELECT passes; `WITH … INSERT …` fails; `SELECT 1;SELECT 2` fails
- [ ] Cursor path: close() is called even if fetchBatch throws
- [ ] No vscode import; no edits to cycle J files; no edits to src/ai/tools/types.ts
- [ ] `npx tsc --noEmit` clean

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
 RUN  v1.4.x /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-002

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
    - file: src/ai/tools/sqlTool.ts:92-106 — `EXPLAIN ANALYZE <writable stmt>` BYPASSES the guard. Verified by calling the real isReadOnlySql: `EXPLAIN ANALYZE DELETE FROM t`, `EXPLAIN ANALYZE UPDATE t SET a=1`, `EXPLAIN ANALYZE CREATE TABLE t2 AS SELECT * FROM t`, and `EXPLAIN ANALYZE REFRESH MATERIALIZED VIEW mv` all return ok:true. PG semantics: ANALYZE causes the statement to actually EXECUTE (postgresql.org/docs/current/sql-explain.html: "ANALYZE ... causes the statement to be actually executed"), so this is a real write path (DML executed / table created / MV rebuilt), violating the task goal "block everything else at the tool layer". Fix: when the first keyword is explain, strip optional `ANALYZE|ANALYSE [ ( options... ) ]`, then require the next keyword ∈ {select, show, with} (WITH still subject to the writable-CTE + INTO scans). Add regression tests for the 4 payloads above.
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

## Reviewer Verdict (re-review round 1)

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (FixK-T002)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/schemaContext.test.ts && npx tsc --noEmit
  result: 40 pass / 0 fail; tsc exit 0 (fresh rerun at 26302db)
ROUND1_FINDING_RESOLUTION: resolved — EXPLAIN ANALYZE/ANALYSE/VERBOSE + parenthesized-options wrapping DELETE/UPDATE/INSERT/CREATE TABLE AS/REFRESH MV/DROP/TRUNCATE/MERGE/COPY/GRANT, and writable-CTE / SELECT…INTO behind EXPLAIN, all now reject (verified by direct adversarial probe of the real guard, 26 vectors, plus 23 regression tests). EXPLAIN SELECT/WITH-clean/(FORMAT, COSTS)/SHOW/comment-prefixed still pass — no over-blocking.
TEST_PLAN_COVERAGE: all-followed (17 pre-existing + 23 new EXPLAIN its; real expect()s)
FINDINGS:
  critical: none
  important: none
  minor:
    - file: src/ai/tools/sqlTool.ts:150-186 — nested `EXPLAIN EXPLAIN ANALYZE DELETE FROM t` is accepted by the guard (verified by probe) but is a parse error in PostgreSQL itself (gram.y ExplainableStmt has no ExplainStmt alternative) — never executes on PG; on MySQL/MSSQL EXPLAIN is not an allowed first keyword in that shape either. Cosmetic fail-closed gap, no write path; optionally reject "explain" as inner keyword in a future round.
    - file: src/ai/tools/sqlTool.ts:36-49 — dollar-quote `SELECT $$into$$` still false-rejects INTO (fail-closed); documented, acceptable.
    - file: src/ai/tools/sqlTool.ts:99-130 — side-effecting SELECT functions (pg_terminate_backend) pass; out of scope for this guard (T4 guardrails/agent policy).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Blocking round-1 hole verified closed with grammar evidence; attack suite found no new write path. Handoff allowed.
