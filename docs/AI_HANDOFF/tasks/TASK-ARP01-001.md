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

### 2026-08-31 · executor · claude-code/unic-code

@reviewer — Advisory Round-1 follow-ups handled: (1) fix path = masking-seam in
`dangerousStatement.ts` (rationale in Executor Report); its own test file re-run green
(29/29). (2) MSSQL `[insert]` false positive probed and DEFERRED — evidence + rationale
in Executor Report ISSUES; recommend a follow-up task rather than expanding this one's
scope (task Goal scopes exactly the one known backtick false positive; Test Cases table
has no bracket case; T-SQL needs its own `]`-doubling escape decision). Note:
`useBackslashEscape` (dialect==="mysql") doubles as the backtick gate — correct today,
but a future refactor could rename it `isMysqlDialect` if bracket masking ever lands
alongside.

---

## Executor Report

```
STATUS: PASS
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
TEST_PLAN_FOLLOWED: task §Test Cases — cases 3-6 added; cases 1, 2, 7 pre-existing,
  kept intact (file diff is purely additive inside the existing describe block).
FIX_PATH_CHOSEN: masking-seam in dangerousStatement.ts maskLiteralsAndComments — the
  task's expected target. Rationale: single masking seam shared by readOnlyIntent and
  postgres.ts:shouldUseCursor, and it mirrors how the `"-identifier branch already
  solves the same bug class for postgres. The readOnlyIntent-local alternative was NOT
  used (one fix path only, per task).
RED_OUTPUT:
  command: npx vitest run src/core/__tests__/readOnlyIntent.test.ts (before implementation)
  result: 20 tests | 1 failed — exactly the backtick case; 19 passed.
    FAIL  src/core/__tests__/readOnlyIntent.test.ts > readOnlyIntent > MySQL backtick-quoted keyword identifier is not a mutation
    AssertionError: expected true to be false // Object.is equality
    - Expected
    + Received
    - false
    + true
    ❯ src/core/__tests__/readOnlyIntent.test.ts:83:62
      83|     expect(isMutationSql("SELECT `insert` FROM t", "mysql")).toBe(fals…
    Test Files  1 failed (1)
    Tests  1 failed | 19 passed (20)
  (RED validity: the three owned files were byte-identical to base a948b3f at RED
   time — verified with `git diff a948b3f HEAD` on them: empty.)
TESTS_ADDED:
  - src/core/__tests__/readOnlyIntent.test.ts:
    - "MySQL backtick-quoted keyword identifier is not a mutation" (case 3, RED→GREEN;
      asserts `insert`, `update`, `delete` variants → false)
    - "Transaction-control statements are not mutations" (case 4: COMMIT, ROLLBACK,
      BEGIN, START TRANSACTION, SAVEPOINT → false; pins the decision)
    - "Core DML classifies identically across postgres/mysql/mssql" (case 5:
      DELETE FROM t / UPDATE t SET a=1 / INSERT INTO t VALUES(1) × 3 dialects → true)
    - "Batch with transaction-control + safe SELECT stays clean; one real DML still
      listed" (case 6: mutationStatements("COMMIT; SELECT 1") → [];
      mutationStatements("SELECT 1; COMMIT; DELETE FROM t") → ["DELETE FROM t"])
FILES_CHANGED:
  - src/core/dangerousStatement.ts: added a dialect-gated MySQL backtick-identifier
    masking branch to maskLiteralsAndComments (placed after the `"-identifier
    branch); doubling escape (`` `` ``) only, mirroring the `"` branch; gated on
    dialect==="mysql" so postgres/mssql masking stays byte-identical (probe-verified);
    header algorithm comment updated.
  - src/core/readOnlyIntent.ts: doc comments only, no logic change —
    transaction-control decision (COMMIT/ROLLBACK/BEGIN/START TRANSACTION/SAVEPOINT
    are NOT mutations, and why) documented at MUTATION_KEYWORDS; dialect candidates
    (postgres|mysql|mssql) and the "keyword classification dialect-agnostic, split/
    mask dialect-driven" contract documented on isMutationSql.
  - src/core/__tests__/readOnlyIntent.test.ts: 4 new cases appended; nothing removed.
VERIFICATION:
  command: npx vitest run src/core/__tests__/readOnlyIntent.test.ts
  result: exit 0 — Test Files 1 passed (1); Tests 20 passed (20)
  command: npx vitest run src/core/__tests__/dangerousStatement.test.ts
    (advisory Round-1 follow-up, run because dangerousStatement.ts changed)
  result: exit 0 — Test Files 1 passed (1); Tests 29 passed (29)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit, clean)
  command: npm run compile
  result: exit 0 (esbuild: build complete)
ISSUES:
  - MSSQL bracket identifier [insert] — PROBED, DEFERRED (advisory Round-1). Probe on
    this branch: isMutationSql("SELECT [insert] FROM t", "mssql") === true — same
    false-positive class as the backtick bug;
    maskLiteralsAndComments("SELECT [insert] FROM t", "mssql") leaves brackets
    untouched. Deferral rationale: the task Goal scopes exactly the ONE known false
    positive (backtick); the Test Cases table has no bracket case; a bracket branch
    needs its own dialect-gating + T-SQL `]`-doubling escape decision and matrix
    entries — new task material, not scope drift inside this one. Bug direction is a
    false POSITIVE (over-blocking) — safe direction for a read-only guard. Recommend
    a follow-up task in the next ARP-01 wave.
  - No lint script exists in package.json (task §Verification already documents
    this); typecheck + compile are the static gates, both green.
HANDOFF_TO_REVIEWER: yes — reviewer unic-smart picks up pending_review.
NEXT: reviewer verdict; optional follow-up task for MSSQL [identifier] masking.
```

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/dangerousStatement.test.ts && npm run typecheck && npm run compile
  result: 49 pass / 0 fail; typecheck + compile clean
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical: none
  important: none
  minor:
    - src/core/dangerousStatement.ts:188 — MySQL backslash-escape inside a backtick identifier (e.g. "SELECT `\`insert` FROM t", mysql) stops the mask at the escaped backtick, leaking "insert" into the depth-scan → over-blocking false positive. Documented in the branch comment; safe direction for a read-only guard (never under-blocks). Acceptable today; handle `\`` if such identifiers become real input.
    - src/core/dangerousStatement.ts:94 — `useBackslashEscape` doubles as the mysql dialect gate for the backtick branch; overloaded name. Already flagged in Discussion; consider renaming to `isMysqlDialect` if bracket masking lands.
NEXT_STATUS_FOR_INDEX: done
NOTES: Model isolation OK (executor unic-code != reviewer unic-smart). RED proof real (1 fail/19 pass pre-fix). postgres/mssql masking byte-identical (probe-verified). MSSQL [insert] deferred by executor, consistent with task scope.
