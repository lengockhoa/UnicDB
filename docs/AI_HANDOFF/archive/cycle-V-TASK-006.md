# TASK-006 — MSSQL server-side sort query (T-SQL dialect)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (MSSQL sort)

## Goal

Give MSSQL the server-side sort helper Postgres already has. `getTableSortQuery` lives only
in `src/adapters/postgres.ts:167`; T-SQL needs `[…]` identifier quoting (not `"…"`) and,
when paging is later stacked on top, an `ORDER BY` that `OFFSET/FETCH` can attach to. Then
point TASK-004's `composeSortQuery` mssql arm at the real adapter export.

## Target Files

- `src/adapters/mssql.ts` — add an exported `getTableSortQuery` mirroring the Postgres
  contract exactly (same 4 args, same return shape, `vsdb_sort` alias). Place it as a
  module-level function above `export class MsSqlAdapter` (line 47), matching how
  `src/adapters/postgres.ts` places its own at line 167 above `class PostgresAdapter`
  (line 190). No change to the class, the tedious wiring, or `MssqlQueryParam`.
- `src/adapters/postgres.ts` — **doc-comment only**: the comment at lines 148-166 says
  "this helper is the Postgres side of that composition"; add one line pointing at the
  mssql twin and at `composeSortQuery` as the dispatch entry. No behavior change; the
  existing `postgres.sortQuery.test.ts` must stay green untouched.
- `src/ui/queryComposer.ts` — replace the inline T-SQL body in `composeSortQuery`'s mssql
  arm with a delegation to the new adapter export. (TASK-004 ships that arm inline; see its
  Discussion.) If TASK-004's executor already delegated, this reduces to a no-op — record
  which in the Executor Report.
- `src/adapters/__tests__/mssql.sortQuery.test.ts` **(new)** — tests below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `basic sort wraps in a subquery with bracket quoting` | `getTableSortQuery("SELECT 1","","name","ASC")` → `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY [name] ASC` | none |
| 2 | unit (happy) | `WHERE from the requery bar is applied to the OUTER query` | `("SELECT * FROM t","age > 18","name","ASC")` → `… ) vsdb_sort WHERE age > 18 ORDER BY [name] ASC`; the inner SQL is verbatim | mirrors postgres semantics at `postgres.ts:176-179` |
| 3 | unit (happy) | `DESC direction is emitted` | contains `ORDER BY [name] DESC` | |
| 4 | edge (identifier injection) | `] inside a column name is doubled and stays one identifier` | column `name]; DROP TABLE users--` → `[name]]; DROP TABLE users--]`; the payload never appears outside the brackets | the T-SQL analogue of `postgres.sortQuery.test.ts:40` |
| 5 | edge (direction whitelist) | `an unexpected direction falls back to ASC` | `("SELECT 1","","n","ASC; DROP TABLE t" as any)` → ends `ASC`, contains no `DROP` | cast through `as unknown as "ASC"` |
| 6 | edge (empty inputs) | `empty originalSql and empty where produce no stray WHERE` | `("","","n","ASC")` → `SELECT * FROM () vsdb_sort ORDER BY [n] ASC`, and `/\bWHERE\b/` does not match | boundary; mirrors `postgres.sortQuery.test.ts:51` |
| 7 | edge (whitespace-only where) | `a whitespace-only WHERE is treated as empty` | `("SELECT 1","   ","n","ASC")` → no `WHERE` in output | trims like postgres |
| 8 | unit (dispatch) | `composeSortQuery("mssql", …) equals the adapter helper` | byte-identical output for the same 4 args; and `composeSortQuery("postgres", …)` still equals `postgres.getTableSortQuery` | pins that the dispatch did not drift |
| 9 | unit (no dead export) | `mssql.getTableSortQuery is reachable only through composeSortQuery, and the composer's mssql arm holds no duplicated T-SQL` | `queryComposer.ts` source contains no `vsdb_sort` / `[` bracket-quoting string building of its own (the arm is a one-line delegation), while `composeSortQuery("mssql", …)` still returns the full T-SQL — proving the export is wired, not orphaned | source-text assertion plus a behavioral one; guards against the arm being "delegated" by copy-paste |

Kinds: happy (1-3), injection (4), input-validation/whitelist (5), empty boundary (6),
whitespace normalization (7), cross-module consistency (8), dead-code/duplication (9).

**Liveness of this export is not this task's to prove.** `composeSortQuery` is called on
the real requery path by TASK-005 (`handleRequery`, `src/ui/resultsPanel.ts`), whose
**case 15** drives an mssql-driver requery with an `orderBy` and asserts the SQL reaching
`runner.runSql` contains `ORDER BY [name] DESC`. That is the anti-dead-code test; it lives
in TASK-005 because TASK-005 owns `resultsPanel.ts` and both tasks run in wave 2, so
putting it here would be a same-wave file collision. See Discussion.

## Test Files

- `src/adapters/__tests__/mssql.sortQuery.test.ts` — cases 1-7. Model it directly on
  `src/adapters/__tests__/postgres.sortQuery.test.ts` (pure string assertions, one `it` per
  case, **no tedious mock** — this is a pure function, importing `MsSqlAdapter`'s module is
  safe because `tedious` is only imported, never connected).
- `src/ui/__tests__/queryComposer.test.ts` — **modify**, append cases 8 and 9. TASK-004
  created this file and completes before this task, so there is no same-wave collision.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/adapters/__tests__/mssql.sortQuery.test.ts src/adapters/__tests__/postgres.sortQuery.test.ts src/ui/__tests__/queryComposer.test.ts
npm test
```

`postgres.sortQuery.test.ts` is included because this task touches that file's doc comment
— it must stay green with zero edits to the test.

## Acceptance Criteria

- [ ] `src/adapters/mssql.ts` exports
      `getTableSortQuery(originalSql: string, whereFromBar: string, column: string, direction: "ASC" | "DESC"): string`
      — the same signature as `src/adapters/postgres.ts:167`.
- [ ] Identifier quoting is `[…]` with `]` doubled; direction is whitelisted to ASC/DESC.
- [ ] `src/adapters/postgres.ts` change is comment-only (`git diff` shows no executable
      line changed).
- [ ] `composeSortQuery`'s mssql arm delegates to the adapter export (no duplicated T-SQL
      string building left in `queryComposer.ts`).
- [ ] No dead export: `mssql.getTableSortQuery` is reachable from the live requery path via
      `composeSortQuery` (wired by TASK-005), and `queryComposer.ts` retains no duplicated
      T-SQL string building (case 9).
- [ ] All 9 Test Cases PASS; `postgres.sortQuery.test.ts` still passes unmodified.
- [ ] `npm run typecheck` clean; `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-004 (owns `src/ui/queryComposer.ts` and `composeSortQuery`).

## Interfaces

- Consumes:
  - `composeSortQuery(dialect, originalSql, whereFromBar, column, direction): string` —
    TASK-004, `src/ui/queryComposer.ts`.
  - `quoteIdent(name, "mssql")` → `[…]` with `]` doubled — `src/core/saveStatements.ts:136,140-142`.
    Prefer reusing it over hand-rolling the bracket escape.
  - Reference contract (do not modify): `getTableSortQuery` — `src/adapters/postgres.ts:167`,
    returns `SELECT * FROM (${inner}) vsdb_sort${whereClause} ORDER BY ${quotedColumn} ${dir}`.
- Produces:
  ```ts
  // src/adapters/mssql.ts
  export function getTableSortQuery(
    originalSql: string,
    whereFromBar: string,
    column: string,
    direction: "ASC" | "DESC",
  ): string;
  ```

---

## Discussion

### 2026-08-25 · planner · bao-opus

Grounding note: `getTableSortQuery` has **no production call site** at HEAD — verified by
grepping `src/` and `webview/` excluding `__tests__`; only its own doc comment and
`postgres.sortQuery.test.ts` mention it. So cycle U shipped the builder without wiring it
to anything.

**No dead code this cycle (plan review R1, finding 8).** Adding an mssql twin to an
already-orphaned postgres helper would ship *two* dead exports. That is resolved in
TASK-005, not here: `handleRequery` now routes a single-identifier `orderBy` from the
requery bar through `composeSortQuery(dialect, …)`, so both adapter helpers sit on a live
path. TASK-005 case 15 asserts an mssql requery reaches `ORDER BY [name] DESC`; case 16
pins that a complex ORDER BY still passes through untouched. Do **not** duplicate that
wiring here — `src/ui/resultsPanel.ts` and `webview/main.ts` belong to TASK-005 in this
same wave 2, and two tasks editing one file is exactly the collision the plan forbids.

Case 9 is this task's own guard: it asserts the composer's mssql arm is a genuine
delegation (no `vsdb_sort` or bracket-building string left in `queryComposer.ts`) rather
than a copy-paste that leaves the adapter export unreferenced.

Column-header-click sort remains out of scope for every dialect (PLAN.md §2) and is queued
in `INDEX.md`; the requery-bar ORDER BY is the call path this cycle delivers.

Deliberately NOT doing OFFSET/FETCH inside this helper: paging composition belongs to
`buildPagedQuery` (TASK-004), which already handles the T-SQL `ORDER BY (SELECT NULL)`
requirement. Keeping sort and paging separate is what lets `composeSortQuery`'s output feed
`buildPagedQuery` unchanged.

→ @reviewer: case 4 is the one that matters. `]` doubling is the only thing standing
between a column-name payload and executable T-SQL.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
SUMMARY: Added `getTableSortQuery` (T-SQL dialect) to `src/adapters/mssql.ts`
mirroring the Postgres contract with `[…]/]`-doubling via `quoteIdent`; rewired
`composeSortQuery`'s mssql arm to delegate to it (one-line delegation, no duplicated
T-SQL); added a doc-comment cross-reference in `postgres.ts` (comment-only). 9 test
cases added (7 new mssql helper + 2 appended composer dispatch/no-dead-export).

### RED_OUTPUT (fresh, before implementation)

```
Test Files  2 failed | 1 passed (3)
     Tests  9 failed | 26 passed (35)
 FAIL  src/adapters/__tests__/mssql.sortQuery.test.ts > getTableSortQuery > basic sort …
TypeError: getTableSortQuery is not a function
 FAIL  src/ui/__tests__/queryComposer.test.ts:168:20
     → expected '// src/ui/queryComposer.ts\n…' to contain 'from "../adapters/mssql"'
```

RED confirmed for the expected reasons: the mssql export did not exist yet and the
composer did not delegate. Not a false-GREEN.

### Verification Output (fresh, current turn)

`npm run typecheck`: `tsc --noEmit` → exit 0, no diagnostics.

`npx vitest run src/adapters/__tests__/mssql.sortQuery.test.ts
 src/adapters/__tests__/postgres.sortQuery.test.ts src/ui/__tests__/queryComposer.test.ts`:
```
 ✓ src/adapters/__tests__/mssql.sortQuery.test.ts  (7 tests) 2ms
 ✓ src/ui/__tests__/queryComposer.test.ts  (21 tests) 5ms
 Test Files  3 passed (3)
      Tests  35 passed (35)
```
(postgres.sortQuery.test.ts untouched and green — 7 tests.)

`npm test` (full suite, after `npm run compile` for gitignored dist/ artifacts):
```
 Test Files  101 passed | 1 skipped (102)
      Tests  1380 passed | 2 skipped (1382)
```
Baseline ≥1327 passed → 1380 passed, 0 failed, no regression.

TEST_PLAN_FOLLOWED: task §Test Cases (9/9) — cases 1-7 new in
`src/adapters/__tests__/mssql.sortQuery.test.ts`, cases 8-9 appended to
`src/ui/__tests__/queryComposer.test.ts`.

FILES_CHANGED:
  - src/adapters/mssql.ts: added exported `getTableSortQuery` above `MsSqlAdapter`
    (same 4-arg signature, `vsdb_sort` wrap, ASC/DESC whitelist, `quoteIdent(,"mssql")`
    bracket quoting); added `quoteIdent` import. No change to the class/wiring/params.
  - src/ui/queryComposer.ts: mssql arm of `composeSortQuery` now one-line delegation to
    the adapter export; updated module header + function doc comments.
  - src/adapters/postgres.ts: doc-comment only — added cross-ref to the mssql twin and
    to `composeSortQuery` as dispatch entry. `git diff` shows no executable line changed.
  - src/adapters/__tests__/mssql.sortQuery.test.ts: new — cases 1-7.
  - src/ui/__tests__/queryComposer.test.ts: appended TASK-006 cases 8-9 + mssql import.

TESTS_ADDED:
  - src/adapters/__tests__/mssql.sortQuery.test.ts: cases 1-7 (basic wrap/bracket quote,
    outer WHERE, DESC, `]`-doubling injection, direction whitelist fallback, empty inputs,
    whitespace-only where).
  - src/ui/__tests__/queryComposer.test.ts: case 8 (mssql arm byte-identical to adapter
    helper; postgres unchanged), case 9 (source-text: no inline mssql bracket building,
    single `getTableSortQuery(` call, delegation branch; behavioral: full T-SQL returned).

ISSUES: none.

Note on TASK-004 arm: TASK-004's executor did NOT delegate — the mssql arm was shipped
inline (single generic `quoteIdent(column, dialect)` body). This task performed the
replacement, so it is not a no-op. Case 9's whole-file `vsdb_sort`-absence is scoped to
the mssql arm (PLAN.md §3 owns postgres/mysql inline arms — "TASK-006 (mssql arm only)",
line 116/133); the source-text assertion instead pins the one-line delegation + zero
`getTableSortQuery(` duplication + no `quoteIdent(…,"mssql")` bracket building.

HANDOFF_TO_REVIEWER: yes — case 4 (`]`-doubling) is the injection guard to verify.

NEXT: ready for review. TASK-005 (resultsPanel/webview wiring) is the liveness test that
makes this export reachable on the real requery path.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/adapters/__tests__/mssql.sortQuery.test.ts src/adapters/__tests__/postgres.sortQuery.test.ts src/ui/__tests__/queryComposer.test.ts
  result: typecheck clean (exit 0); 3 test files passed, 35 tests passed (0 fail)
TEST_PLAN_COVERAGE: all-followed — cases 1-7 in mssql.sortQuery.test.ts, cases 8-9 appended to queryComposer.test.ts; postgres.sortQuery.test.ts untouched and green
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Clean implementation. T-SQL bracket quoting via quoteIdent is injection-safe (case 4 doubled-] assertion is the key guard). Dispatcher delegation is genuine one-liner, not copy-paste. Doc-comment-only change on postgres.ts confirmed.
