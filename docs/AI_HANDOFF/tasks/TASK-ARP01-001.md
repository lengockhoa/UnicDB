# TASK-ARP01-001 — Classifier matrix: formalize read-only classification by dialect

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP01.md` §3, §4 (ARP-01.1)

## Goal

Formalize the read-only SQL classifier behavior by dialect and fix its one known false
positive. Deliverables: (1) MySQL backtick-quoted identifiers no longer leak fake
mutation keywords into the depth-scan (confirmed RED: `isMutationSql("SELECT \`insert\` FROM t", "mysql")`
returns `true` on base a948b3f); (2) the transaction-control decision
(`BEGIN`/`COMMIT`/`ROLLBACK`/`START TRANSACTION`/`SAVEPOINT` are NOT mutations) is pinned by
tests, not incidental; (3) the dialect candidates (`postgres`/`mysql`/`mssql`) and their
role are documented on the classifier. The mutation-keyword scan itself
(`statementIsMutation`) stays dialect-agnostic — only split/mask are dialect-driven.

## Target Files

- `src/core/readOnlyIntent.ts` — document dialect candidates + transaction-control decision.
- `src/core/dangerousStatement.ts` — **expected** fix target: add a MySQL backtick masking
  branch to `maskLiteralsAndComments` (line 89, after the `"`-identifier branch ~159-175).
  Not owned by any other ARP-01 task, so the wave stays disjoint. ALTERNATIVE (only if you
  prefer to keep the diff inside `readOnlyIntent.ts`): a local backtick-blanking pre-pass in
  `mutationStatements` when `dialect === "mysql"` — then `dangerousStatement.ts` must remain
  untouched. Pick one; do not do both.
- `src/core/__tests__/readOnlyIntent.test.ts` — new dialect + transaction-control matrix.
  `(new)` — NO. Existing file; ADD cases (keep existing :10-75 intact).

## Test Cases (REQUIRED — TDD)

RED-first: write the failing backtick test FIRST, run it, paste the RED output, then
implement the fix. The `COMMIT`/dialect-threading/batch cases are expected GREEN (they pin
decisions); the backtick case is the RED that drives the change.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | Safe SELECT not a mutation (postgres default) | `isMutationSql("SELECT * FROM t")` → `false` | existing `readOnlyIntent.test.ts` |
| 2 | happy | CTE SELECT not a mutation | `isMutationSql("WITH x AS (SELECT 1) SELECT * FROM x")` → `false` | same |
| 3 | edge: identifier masking | MySQL backtick-quoted keyword identifier | `isMutationSql("SELECT \`insert\` FROM t", "mysql")` → `false`. **RED on a948b3f** (returns `true`) → flips GREEN after fix. Also assert `` `update` ``, `` `delete` `` variants → `false` | new |
| 4 | edge: transaction control | Transaction-control statements are not mutations | `COMMIT`, `ROLLBACK`, `BEGIN`, `START TRANSACTION`, `SAVEPOINT x` each → `false` (decision pinned; no data/schema/permission change) | new |
| 5 | edge: dialect threading | Core DML classified identically across all three dialects | `isMutationSql(sql, d)` → `true` for `d` in `postgres`/`mysql`/`mssql` with `DELETE FROM t`, `UPDATE t SET a=1`, `INSERT INTO t VALUES (1)` | new |
| 6 | edge: batch composition | Transaction-control + safe SELECT batch stays clean; one real DML still listed | `mutationStatements("COMMIT; SELECT 1")` → `[]`; `mutationStatements("SELECT 1; COMMIT; DELETE FROM t")` → `["DELETE FROM t"]` | new |
| 7 | regression | Writable CTE / EXPLAIN ANALYZE / admin DCL still blocked | existing assertions at `readOnlyIntent.test.ts:30-33, 61-74` remain green unchanged | existing |

## Test Files

- `src/core/__tests__/readOnlyIntent.test.ts` — ADD cases 3–6 inside the existing
  `describe("readOnlyIntent")` block; cases 1, 2, 7 already exist.

## Verification Commands

```bash
npx vitest run src/core/__tests__/readOnlyIntent.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `readOnlyIntent.ts` resolves via `.cache/index/tests-map.json` to
`readOnlyIntent.test.ts` — verified. No lint script exists; typecheck + compile are the
static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: `isMutationSql("SELECT \`insert\` FROM t", "mysql")` fails on
      base a948b3f BEFORE the fix (test run output captured in the Executor Report).
- [ ] After fix: case 3 GREEN — backtick-quoted keyword identifiers (`insert`/`update`/
      `delete`) in MySQL dialect no longer false-positive.
- [ ] Transaction-control decision documented in `readOnlyIntent.ts` (a comment near
      `MUTATION_KEYWORDS` ~:31-44) AND pinned by case 4.
- [ ] Dialect candidates documented: a doc comment enumerating `postgres`/`mysql`/`mssql`
      and stating that keyword classification is dialect-agnostic while split/mask are
      dialect-driven.
- [ ] One fix path only — either the `maskLiteralsAndComments` backtick branch
      (`dangerousStatement.ts`) OR a `readOnlyIntent.ts`-local mask; never both. The choice
      and rationale recorded in the Executor Report.
- [ ] If `dangerousStatement.ts` was changed, its own test file
      `src/core/__tests__/dangerousStatement.test.ts` still passes (run it).
- [ ] All existing `readOnlyIntent.test.ts` cases (1, 2, 7) still green — no behavior
      removed, only additive.
- [ ] `npx vitest run src/core/__tests__/readOnlyIntent.test.ts`, `npm run typecheck`,
      `npm run compile` all exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `none` (wave 1, runs in parallel with TASK-ARP01-002).

## Interfaces

- Consumes:
  - `maskLiteralsAndComments(sql: string, dialect?: SqlDialect): string` —
    `src/core/dangerousStatement.ts:89`.
  - `splitStatements(sql: string, dialect?: SqlDialect): Array<{ text: string }>`,
    `SqlDialect = "postgres" | "mysql" | "mssql"` — `src/core/statementParser.ts:21`.
- Produces (all consumed by `TASK-ARP01-002`'s transaction guard):
  - `isMutationSql(sql: string, dialect?: SqlDialect): boolean` — behavior now dialect-correct.
  - `mutationStatements(sql: string, dialect?: SqlDialect): string[]` — unchanged signature.
  - `ReadOnlyViolation` — unchanged.

## Discussion

(no comments yet)

---

## Executor Report

```
STATUS:
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY:
TEST_PLAN_FOLLOWED:
RED_FIRST:
  command: npx vitest run src/core/__tests__/readOnlyIntent.test.ts (new backtick case)
  result: <paste RED here — must be present before implementation>
FILES_CHANGED:
TESTS_ADDED:
VERIFICATION:
  command: npx vitest run src/core/__tests__/readOnlyIntent.test.ts
  result:
  command: npm run typecheck
  result:
  command: npm run compile
  result:
ISSUES:
HANDOFF_TO_REVIEWER:
NEXT:
```

## Reviewer Verdict

REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERDICT:
VERIFICATION_RERUN:
TEST_PLAN_COVERAGE:
FINDINGS:
NOTES:
