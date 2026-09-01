# TASK-AIX03-101 — Parser hardening (row-lock clause) + row-cap/sentinel pin

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX03.md` §3 (parser axis), §3 (rows/secrets axis)

## Goal

Close the ONE residual parser bypass that survives both guards: PostgreSQL
row-locking clauses that do not contain the `update` keyword (`FOR SHARE`,
`FOR KEY SHARE`) are accepted by both `parseReadonly` (dbAwareTools) and
`isReadOnlySql` (sqlTool), letting a read-only copilot take share row locks.
Pin the exact row-cap literals + a sentinel non-leak so the cap boundary
cannot regress.

## Target Files

- `src/ai/tools/readonlySqlParser.ts` — add a `FOR <lockmode>` clause scan in `parseReadonly` (reject `non_select`).
- `src/ai/tools/sqlTool.ts` — add a `FOR <lockmode>` rejection to `isReadOnlySql` (new reason literal); keep `executeReadOnly`/`ROW_LIMIT` cap unchanged.
- `src/ai/tools/dbAwareTools.ts` — no behavior change; add the `QUERY_MAX_ROWS` cap-edge + sentinel tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `parseReadonly("SELECT 1")` | `{ ok: true, kind: "select" }` | plain SELECT |
| 2 | edge (row-lock) | `parseReadonly("SELECT * FROM t FOR SHARE")` | `{ ok: false, reason: "non_select" }` | RED today (accepted) |
| 3 | edge (row-lock) | `parseReadonly("SELECT * FROM t FOR KEY SHARE")` | `{ ok: false, reason: "non_select" }` | RED today |
| 4 | edge (row-lock) | `isReadOnlySql("SELECT * FROM t FOR SHARE")` | `{ ok: false, reason: "Read-only violation: FOR UPDATE/SHARE" }` | RED today |
| 4b | edge (row-lock variant) | `isReadOnlySql("SELECT * FROM t FOR KEY SHARE")` | `{ ok: false, reason: "Read-only violation: FOR UPDATE/SHARE" }` | RED today (no test covers this sqlTool branch today) — make case 4 table-driven over FOR SHARE + FOR KEY SHARE to lock both clauses |
| 5 | edge (row-lock/defense) | `parseReadonly("SELECT * FROM t FOR UPDATE")` | `{ ok: false, reason: "non_select" }` | GREEN today (caught by `update` keyword) — pin |
| 6 | edge (cap boundary) | `executeReadOnly` cursor returns 120 rows | `rows.length === 50`, `truncated === true`, `rowCount === 120` | cursor adapter, `emptyResults: true` |
| 7 | edge (cap boundary) | `run_readonly_query` with `maxRows: 99999` | exactly 1000 data rows | 1200-row adapter |
| 8 | edge (sentinel/cursor batch) | row index `QUERY_DEFAULT_MAX_ROWS` (100, zero-based) in a `DEFAULT_BATCH_SIZE` (500) Postgres cursor batch carries `"SENTINEL-leak"` | with `maxRows: QUERY_DEFAULT_MAX_ROWS` (100), output does NOT contain `"SENTINEL-leak"` and contains exactly `-- truncated: showing 100 of 500 rows` | `fetchBatch()` returns exactly 500 rows, matching `src/adapters/postgres.ts:98` `DEFAULT_BATCH_SIZE = 500`, then EOF |

## Test Files

- `src/ai/tools/__tests__/readonlySqlParser.test.ts` — cases 1–3, 5.
- `src/ai/tools/__tests__/sqlTool.test.ts` — cases 4, 6.
- `src/ai/tools/__tests__/dbAwareTools.test.ts` — cases 7–8.

## Verification Commands

```bash
npx vitest run src/ai/tools/__tests__/readonlySqlParser.test.ts src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/dbAwareTools.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] `parseReadonly` returns `{ ok: false, reason: "non_select" }` for
      `FOR SHARE` and `FOR KEY SHARE` (and still rejects `FOR UPDATE` /
      `FOR NO KEY UPDATE` via the `update` keyword).
- [ ] `isReadOnlySql` returns `{ ok: false, reason: "Read-only violation: FOR UPDATE/SHARE" }`
      for the same clauses (pinned new reason literal).
- [ ] `sqlTool` still truncates to `ROW_LIMIT = 50` with `truncated: true` and
      full `rowCount`.
- [ ] `dbAwareTools` caps `run_readonly_query` at `QUERY_MAX_ROWS = 1000`; its
      deterministic sentinel fixture uses Postgres `DEFAULT_BATCH_SIZE = 500`
      with `maxRows: QUERY_DEFAULT_MAX_ROWS = 100`, so the dropped sentinel
      never appears and the exact truncation line is present.
- [ ] `npm run typecheck` → 0 errors.

## Dependencies

- (none)

## Interfaces

- Consumes:
  - `parseReadonly(sql: string): ParseResult` — `ParseResult = { ok: true; kind: "select" | "with" } | { ok: false; reason: ParseFailReason }`, `ParseFailReason = "non_select" | "multi_statement" | "empty" | "unbalanced_parens"` (real signatures from `readonlySqlParser.ts`).
  - `containsForbidden(text: string): boolean` (exported).
  - `isReadOnlySql(sql: string): ReadOnlyCheck` — `ReadOnlyCheck = { ok: boolean; reason?: string }` (real signature from `sqlTool.ts`).
  - `SqlResult = { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }`; `ROW_LIMIT = 50` (`sqlTool.ts`).
  - `QUERY_MAX_ROWS = 1000`, `QUERY_DEFAULT_MAX_ROWS = 100` (`dbAwareTools.ts`).
  - Postgres `DEFAULT_BATCH_SIZE = 500` (`src/adapters/postgres.ts:98`); the
    sentinel test's fake `BatchedQuery.fetchBatch()` returns exactly this one
    batch before EOF, so `renderTable` deterministically sees 500 total rows.
- Produces:
  - Pinned row-lock clause regex (used by both guards):
    `/\bfor\s+(no\s+key\s+update|no\s+key\s+share|key\s+share|update|share)\b/i`
  - New reason literal in `sqlTool.ts`: `"Read-only violation: FOR UPDATE/SHARE"`.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Source-grounding note for the executor/reviewer: most of the portfolio brief's
enumerated parser cases are ALREADY closed at HEAD — stacked statements
(`multi_statement`), trailing semicolons (single trailing accepted), EXPLAIN
ANALYZE (`guardSql` + `isReadOnlySql`), `COPY`/`MERGE`/`INSERT`/`CALL`/`EXEC`
(forbidden RE), writable CTEs (WCTE + `containsForbidden`), dollar-quoted DO
blocks and function bodies (first-keyword `non_select` + `create` keyword).
The residual bypass is the row-locking clause WITHOUT the `update` keyword —
`FOR SHARE` / `FOR KEY SHARE` — which both `parseReadonly` and `isReadOnlySql`
accept today. Do NOT widen `FORBIDDEN_RE` with `VACUUM`/`REFRESH`/etc.; those
are already first-keyword-rejected and adding them is over-rejection scope creep.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 FAIL  src/ai/tools/__tests__/readonlySqlParser.test.ts > parseReadonly — row-lock clause rejection (TASK-AIX03-101) > rejects FOR SHARE (no update keyword) with reason non_select
   { ok: true, kind: 'select' } !== { ok: false, reason: 'non_select' }
 FAIL  src/ai/tools/__tests__/readonlySqlParser.test.ts > parseReadonly — row-lock clause rejection (TASK-AIX03-101) > rejects FOR KEY SHARE with reason non_select
   { ok: true, kind: 'select' } !== { ok: false, reason: 'non_select' }
 FAIL  src/ai/tools/__tests__/readonlySqlParser.test.ts > parseReadonly — row-lock clause rejection (TASK-AIX03-101) > rejects FOR NO KEY SHARE
   { ok: true, kind: 'select' } !== { ok: false, reason: 'non_select' }
 FAIL  src/ai/tools/__tests__/readonlySqlParser.test.ts > parseReadonly — row-lock clause rejection (TASK-AIX03-101) > rejects row-lock clause case-insensitively
   undefined !== 'non_select'
 FAIL  src/ai/tools/__tests__/sqlTool.test.ts > isReadOnlySql > rejects row-lock clause SELECT * FROM t FOR SHARE
   { ok: true } !== { ok: false, reason: 'Read-only violation: FOR UPDATE/SHARE' }
 FAIL  src/ai/tools/__tests__/sqlTool.test.ts > isReadOnlySql > rejects row-lock clause SELECT * FROM t FOR KEY SHARE
 FAIL  src/ai/tools/__tests__/sqlTool.test.ts > isReadOnlySql > rejects row-lock clause SELECT * FROM t for key share
 FAIL  src/ai/tools/__tests__/sqlTool.test.ts > isReadOnlySql > rejects row-lock clause SELECT * FROM t For Key Share
 Test Files  3 failed (3)
      Tests  9 failed | 103 passed (112)
```

Verification Output:
- `npx vitest run src/ai/tools/__tests__/readonlySqlParser.test.ts src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/dbAwareTools.test.ts` → 3 files passed, 112/112 tests pass.
- `npm run typecheck` → 0 errors.

Status: PASS
Note: Closed row-lock bypass via shared `ROW_LOCK_RE` regex; sentinel non-leak pinned to Postgres `DEFAULT_BATCH_SIZE=500` + `QUERY_DEFAULT_MAX_ROWS=100`; pre-existing dist-bundle failures in `extension.test.ts` / `agGridSmoke.test.ts` / `consolePanelBundle.test.ts` are unrelated and reproduced on `808000c` HEAD.
