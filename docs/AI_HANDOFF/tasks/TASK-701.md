# TASK-701 — EXPLAIN ANALYZE prelude trong danger guard

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.1

## Goal

`EXPLAIN [ANALYZE] DELETE/TRUNCATE/DROP/UPDATE...` hiện classify `other` → tier `none` → confirm modal bị skip, dù ANALYZE **thực thi** lệnh. Bắt `explain` (+ modifiers) như prelude để kind + hasWhere tính theo statement thật bên trong.

## Target Files

- `src/core/dangerousStatement.ts` — `analyzeStatement`: skip-past `explain` prelude.
- `src/core/__tests__/dangerousStatement.test.ts` — append cases.

## Interfaces

- Consumes: `analyzeStatement(sql: string): StatementAnalysis` (existing, unchanged signature).
- Produces: same signature; behavior mới cho input bắt đầu `explain`.
- `(none)` cho task khác — pure function, không đụng extension.ts.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | explain delete no-where | kind=delete, hasWhere=false → tier red | `EXPLAIN DELETE FROM t` |
| 2 | unit | explain analyze delete | red | `EXPLAIN ANALYZE DELETE FROM t` |
| 3 | edge | parenthesized options | red | `EXPLAIN (ANALYZE, COSTS) UPDATE t SET a=1` |
| 4 | edge | CTE sau explain | kind=delete, hasWhere=true → amber | `EXPLAIN ANALYZE WITH c AS (SELECT 1) DELETE FROM t WHERE x=1` |
| 5 | unit | harmless sau explain | tier none | `EXPLAIN ANALYZE SELECT * FROM t` |
| 6 | regression | explain+update có where | none | `EXPLAIN ANALYZE UPDATE t SET a=1 WHERE id=2` |
| 7 | regression | không explain, không đổi | red | `DELETE FROM t` (existing behavior giữ nguyên) |

## Test Files

- `src/core/__tests__/dangerousStatement.test.ts`

## Verification Commands

```bash
npm run compile && npx vitest run src/core/__tests__/dangerousStatement.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] 7 test trên RED trước (case 1-6 fail với code hiện tại), GREEN sau
- [ ] Không thay đổi behavior câu không có EXPLAIN
- [ ] hasWhere vẫn tính trên full masked text

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec701
SUMMARY: analyzeStatement now skips past `EXPLAIN [ANALYZE|ANALYSE|VERBOSE] [(opts)]` prelude at depth 0; kind + hasWhere derive from the real inner statement. 7/7 new tests green, 15/15 total in file.
TEST_PLAN_FOLLOWED: task §4 — all 7 cases implemented verbatim
FILES_CHANGED:
  - src/core/dangerousStatement.ts: added sawExplain state + analyze/analyse/verbose skip + parenthesized options handled by existing depth tracking
  - src/core/__tests__/dangerousStatement.test.ts: appended describe("TASK-701") with 7 cases
TESTS_ADDED:
  - src/core/__tests__/dangerousStatement.test.ts: cases 1–7 (EXPLAIN DELETE, EXPLAIN ANALYZE DELETE, EXPLAIN (ANALYZE,COSTS) UPDATE, EXPLAIN+CTE DELETE WHERE, EXPLAIN SELECT, EXPLAIN UPDATE WHERE, regression)
VERIFICATION:
  command: cd .worktrees/task-701 && npm run compile && npx vitest run src/core/__tests__/dangerousStatement.test.ts && npm run typecheck
  result: esbuild OK; 15 passed (15); tsc --noEmit clean
  output_excerpt: |
    ✓ src/core/__tests__/dangerousStatement.test.ts  (15 tests) 4ms
    Test Files  1 passed (1)
         Tests  15 passed (15)
    > vsdb@1.5.0 typecheck
    > tsc --noEmit
RED_OUTPUT (5 of 7 failed before fix):
  - case 1: kind 'other' received, 'delete' expected
  - case 2: kind 'other' received, 'delete' expected
  - case 3: kind 'other' received, 'update' expected
  - case 4: kind 'other' received, 'delete' expected
  - case 6: kind 'other' received, 'update' expected
  - case 5 (EXPLAIN SELECT) and case 7 (no-EXPLAIN regression) passed pre-fix, as expected
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code (Exec701)
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/core/__tests__/dangerousStatement.test.ts && npm run typecheck (+ full npx vitest run, shared code)
  result: compile OK · 15/15 pass · tsc clean · full suite 453/453 pass
TEST_PLAN_COVERAGE: all-followed — 7/7 cases implemented verbatim with real assertions (kind + hasWhere + tier)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/core/dangerousStatement.ts:170 — comment typo: "`analyzeStatement` (Postgres)" should read "`ANALYZE`" (the EXPLAIN modifier keyword); current text confuses readers by naming a function that is not involved here.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: RED claims plausible: pre-fix first depth-0 token `explain` maps to no DML kind → cases 1,2,3,4,6 fail exactly as reported, 5 & 7 pass pre-fix. Non-EXPLAIN path untouched (sawExplain stays false; A1–A8 + 453-test suite green). hasWhere still derived from full masked text.
