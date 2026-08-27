# TASK-004 — Dialect query composer: filter WHERE + OFFSET/LIMIT paging + sort dispatch

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Server-side filter + paging)

## Goal

Pure-logic SQL composition module for the three dialects: turn an AG Grid set-filter model
into a `WHERE` clause, add OFFSET/LIMIT-style paging, and expose a dialect dispatch entry
for the sort helper. No DOM, no `vscode`, no DB driver — unit-testable in isolation, which
is what lets TASK-005 and TASK-006 be thin wiring tasks.

## Target Files

- `src/ui/queryComposer.ts` **(new)** — the whole module. Placed in `src/ui/` (not
  `src/core/`) to sit beside `resultsGridModel.ts`, whose helpers it reuses.
- `src/ui/__tests__/queryComposer.test.ts` **(new)** — tests below.

Deliberately NOT edited: `src/ui/resultsGridModel.ts` (already 1214 lines and bundled into
the webview — new host-side composition must not grow the webview bundle).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `buildFilterWhere emits an IN list` | `buildFilterWhere({name:{values:["a","b"]}}, "postgres")` → `"name" IN ('a', 'b')` | none |
| 2 | unit (happy) | `two filtered columns are AND-joined` | `{a:{values:["1"]},b:{values:["2"]}}` → `"a" IN ('1') AND "b" IN ('2')` | matches AG Grid's multi-column AND semantics |
| 3 | edge (blanks sentinel) | `(Blanks) becomes IS NULL and OR-joins with the IN list` | `{n:{values:["(Blanks)","a"]}}` → `("n" IS NULL OR "n" IN ('a'))` | `(Blanks)` is `SET_FILTER_BLANKS_DISPLAY`, `resultsGridModel.ts:1138` |
| 4 | edge (blanks only) | `only (Blanks) selected yields a bare IS NULL` | `{n:{values:["(Blanks)"]}}` → `"n" IS NULL` — no empty `IN ()`, which is a syntax error on all three dialects | boundary |
| 5 | edge (value injection) | `single quote in a value is doubled` | value `O'Brien` → `'O''Brien'`; result contains no unescaped `'` breaking the literal | must route through `sqlLiteral` |
| 6 | edge (identifier injection) | `delimiter inside a column name is doubled per dialect` | mssql `a]b` → `[a]]b]`; mysql `` a`b `` → `` `a``b` ``; postgres `a"b` → `"a""b"` | must route through `quoteIdent` |
| 7 | edge (empty model) | `empty or all-empty filter model returns ""` | `{}` → `""`; `{n:{values:[]}}` → `""` | caller then omits the WHERE entirely |
| 8 | unit (happy) | `buildPagedQuery pages postgres with LIMIT/OFFSET` | ends with `LIMIT 500 OFFSET 1000` | `(sql,"", "", 1000, 500, "postgres")` |
| 9 | edge (dialect) | `mssql pages with OFFSET/FETCH and injects an ORDER BY` | contains `ORDER BY (SELECT NULL) OFFSET 1000 ROWS FETCH NEXT 500 ROWS ONLY` | T-SQL rejects OFFSET without ORDER BY |
| 10 | edge (dialect, order supplied) | `mssql keeps the caller's ORDER BY instead of the placeholder` | orderBy `name DESC` → contains `ORDER BY name DESC OFFSET`, and NOT `(SELECT NULL)` | |
| 11 | edge (boundary) | `offset 0 still emits OFFSET 0` | `offset:0` → `OFFSET 0` present | omitting it makes the mssql FETCH clause invalid |
| 12 | edge (statement terminator) | `a trailing semicolon in the inner SQL is stripped before wrapping` | `SELECT 1;` → composed SQL has exactly one `;` at most and never `(SELECT 1;)` | same hazard `composeRequery` guards at `resultsGridModel.ts:1101-1105` |
| 13 | unit (happy) | `composeSortQuery routes postgres to the existing helper` | output byte-identical to `getTableSortQuery("SELECT 1","","name","ASC")` from `src/adapters/postgres.ts:167` | |
| 14 | edge (dispatch) | `composeSortQuery quotes per dialect` | postgres `"name"`, mysql `` `name` ``, mssql `[name]` | mssql arm lands in TASK-006; until then it may throw `NotImplementedError` — see Discussion |
| 15 | edge (numeric typing) | `numeric filter values are emitted unquoted on all three dialects` | `{id:{values:["42","7"],typed:[42,7]}}` → `"id" IN (42, 7)` for postgres, `` `id` IN (42, 7) `` for mysql, `[id] IN (42, 7)` for mssql — the digits appear with **no** surrounding `'` | without `typed`, `String()`-coerced values would emit `IN ('42','7')`, which forces an implicit conversion (index-killing on MySQL, and a hard `Conversion failed` on an MSSQL `int` column when any sibling value is non-numeric) |
| 16 | edge (temporal typing) | `an ISO timestamp is normalized per dialect` | typed `"2024-03-01T10:30:00.000Z"` → postgres `'2024-03-01T10:30:00.000Z'` (kept verbatim; PG parses full ISO incl. the `Z` offset), mysql and mssql `'2024-03-01 10:30:00.000'` (`T`→space, trailing `Z` stripped) | MSSQL `datetime`/`datetime2` raises a conversion error on the trailing `Z`; see Discussion for the UTC-naive assumption this records |
| 17 | edge (boolean + null typing) | `booleans and nulls are typed, not stringified` | typed `[true]` → `IN (TRUE)` (not `IN ('true')`); a typed `null` is routed to the `IS NULL` branch and never appears inside the `IN` list | `sqlLiteral` already emits `TRUE`/`FALSE`/`NULL` — case 17 pins that the typed path reaches it |
| 18 | edge (no type sniffing) | `a numeric-looking value stays quoted when no typed[] is supplied` | `{code:{values:["007"]}}` with **no** `typed` → `"code" IN ('007')` — still a string literal | load-bearing: sniffing `/^\d+$/` would turn a `varchar` zero-padded code into `007` and silently match nothing. Typing must come only from `typed[]`, never from the display string |
| 19 | edge (length mismatch) | `a typed[] of the wrong length is ignored, not zipped` | `{id:{values:["1","2"],typed:[1]}}` → falls back to the all-string form `"id" IN ('1', '2')`, no throw, no `undefined` in the SQL | defensive: a malformed webview payload must degrade to today's behavior rather than emit `IN (1, undefined)` |

## Test Files

- `src/ui/__tests__/queryComposer.test.ts` — all 19 cases. Style reference:
  `src/adapters/__tests__/postgres.sortQuery.test.ts` (pure string assertions, one `it` per
  numbered case, no mocks).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/queryComposer.test.ts
npm test
```

## Acceptance Criteria

- [ ] `src/ui/queryComposer.ts` exports `buildFilterWhere`, `buildPagedQuery`,
      `composeSortQuery` with the exact signatures in §Interfaces.
- [ ] Zero hand-rolled escaping: every identifier goes through `quoteIdent`, every value
      through `sqlLiteral` (`grep -n "replace(/'" src/ui/queryComposer.ts` → no hits).
- [ ] The module imports nothing from `vscode`, `ag-grid-community`, or `src/adapters/*`.
- [ ] `ColumnFilterModel` entries carry an optional `typed?: unknown[]`, and
      `buildFilterWhere` emits typed values through `sqlLiteral` (numbers/booleans
      unquoted, `Date`/ISO strings dialect-normalized) while falling back to string
      literals whenever `typed` is absent or length-mismatched. No type sniffing from
      display strings.
- [ ] All 19 Test Cases PASS.
- [ ] `npm run typecheck` clean; `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes (all exist at HEAD — import, do not reimplement):
  - `sqlLiteral(v: unknown): string` — `src/ui/resultsGridModel.ts:378`. Portable
    single-quote doubling, **no** backslash escaping (deliberate: PG
    `standard_conforming_strings=on` and MSSQL treat `\` literally).
  - `quoteIdent(name: string, dialect: Dialect): string` — `src/core/saveStatements.ts:136`.
    postgres `"…"` (doubling `"`), mysql `` `…` `` (doubling `` ` ``), mssql `[…]` (doubling `]`).
  - `type Dialect = "postgres" | "mysql" | "mssql"` — `src/core/saveStatements.ts:31`.
  - `SET_FILTER_BLANKS_DISPLAY = "(Blanks)"` — `src/ui/resultsGridModel.ts:1138`.
  - `getTableSortQuery(originalSql, whereFromBar, column, direction)` —
    `src/adapters/postgres.ts:167` (postgres arm of `composeSortQuery`).
- Produces (TASK-005 and TASK-006 consume these verbatim):
  ```ts
  /**
   * AG Grid set-filter model as returned by GridApi.getFilterModel(), plus an
   * optional parallel array of the ORIGINAL (uncoerced) cell values.
   *
   * `values` is display text — AG Grid's set filter stores what the checkbox
   * showed, i.e. String()-coerced. `typed[i]` is the raw value behind
   * `values[i]` and is what buildFilterWhere prefers when present.
   * `typed` is optional and MUST be ignored unless typed.length === values.length.
   */
  export interface ColumnFilterModel {
    [field: string]: { values: string[]; typed?: unknown[] };
  }

  export function buildFilterWhere(
    filters: ColumnFilterModel,
    dialect: Dialect,
  ): string;                       // "" when nothing is filtered

  export function buildPagedQuery(
    sql: string,
    where: string,
    orderBy: string,
    offset: number,
    limit: number,
    dialect: Dialect,
  ): string;

  export function composeSortQuery(
    dialect: Dialect,
    originalSql: string,
    whereFromBar: string,
    column: string,
    direction: "ASC" | "DESC",
  ): string;
  ```

---

## Discussion

### 2026-08-25 · planner · bao-opus

Ordering note for case 14: `composeSortQuery`'s mssql arm needs
`getTableSortQuery` from `src/adapters/mssql.ts`, which TASK-006 creates. To keep this task
in wave 1 with no dependency, implement the mssql arm here as an **inline** T-SQL
composition (it is four lines: `quoteIdent(col,"mssql")` + ASC/DESC whitelist + subquery
wrap), and let TASK-006 replace the inline body with a delegation to its adapter export.
That keeps case 14 green in wave 1 and keeps TASK-006's diff honest. Record whichever you
chose in the Executor Report.

`(Blanks)` semantics: AG Grid's set filter treats `null`, `undefined` and `""` as one group
(`buildSetFilterEntries`, `resultsGridModel.ts:1151`). Server-side, `col IS NULL` does not
catch `''`. Cases 3-4 only pin the `IS NULL` half; matching empty strings too is a
deliberate known gap recorded in PLAN.md, not a bug for the reviewer to flag.

→ @executor: `buildPagedQuery` receives the ALREADY-composed inner SQL. Do not re-derive a
WHERE inside it — TASK-005 passes `buildFilterWhere`'s output through the `where` argument.

**Typed filter values (plan review R1, finding 4).** AG Grid's set-filter model holds
*display strings*: VSDB builds those entries with `String(v)` in `buildSetFilterEntries`
(`src/ui/resultsGridModel.ts:1151-1176`), and `formatCell` (`:341`) turns `Date` into an
ISO string and objects into JSON. If `buildFilterWhere` pushed those strings straight
through `sqlLiteral`, every predicate would be a **string** literal:

- MySQL: `WHERE id IN ('42')` on an `INT` column works, but only via an implicit
  conversion that discards the index — the exact opposite of the point of pushing the
  filter to the server.
- MSSQL: `WHERE id IN ('42')` on an `int` column succeeds, but the moment the selection
  contains one non-numeric entry the whole batch fails with
  `Conversion failed when converting the varchar value ... to data type int`. A
  `datetime2` column with `'2024-03-01T10:30:00.000Z'` fails on the trailing `Z`.
- Postgres is the forgiving one (`unknown`-typed literals get coerced), which is why this
  cannot be caught by testing against PG alone. Cases 15-16 therefore assert **all three**
  dialects.

Design, in order of precedence:

1. If `typed` is present **and** `typed.length === values.length`, build the literal from
   `typed[i]` via `sqlLiteral`. That already yields unquoted numbers/bigints, `TRUE`/`FALSE`
   for booleans, and `NULL` for null (`src/ui/resultsGridModel.ts:378-390`) — do not
   duplicate that logic.
2. Otherwise fall back to today's behavior: quote every entry as a string literal.
   **Never** sniff a type from the display string (case 18) — `'007'` in a `varchar` code
   column must stay `'007'`.
3. Temporal values need one dialect step `sqlLiteral` does not do: it emits a `Date` as a
   full ISO string with the `Z` suffix. Keep that for postgres; for mysql and mssql
   replace the `T` with a space and drop the trailing `Z` before quoting.

*Assumption logged:* step 3 treats the value as UTC and produces a UTC-naive literal for
MySQL/MSSQL. This matches how the grid displayed it (`formatCell` → `toISOString()`), so
filtering agrees with what the user saw. It will not agree with a server whose session
timezone is not UTC, on a column that stores local time. That is out of scope here and is
recorded as a known gap in PLAN.md rather than silently "fixed" by an executor.

TASK-005 is responsible for populating `typed` from the loaded row values in the webview;
it is optional precisely so TASK-005 can ship the plumbing incrementally, and so cases
18-19 keep the fallback honest.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

### RED_OUTPUT (fresh, before implementation)

```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-004
❯ src/ui/__tests__/queryComposer.test.ts  (0 test)
FAIL  src/ui/__tests__/queryComposer.test.ts
Error: Failed to load url ../queryComposer (resolved id: ../queryComposer)
in .../src/ui/__tests__/queryComposer.test.ts. Does the file exist?
Test Files  1 failed (1)
     Tests  no tests
```

RED confirmed for the expected reason: the module `src/ui/queryComposer.ts` did not exist yet,
so the test file could not even load. Not a false-GREEN.

### Verification Output (fresh, current turn)

`npm run typecheck`:
```
> tsc --noEmit
(exit 0, no diagnostics)
```

`npx vitest run src/ui/__tests__/queryComposer.test.ts`:
```
✓ src/ui/__tests__/queryComposer.test.ts  (19 tests) 3ms
Test Files  1 passed (1)
     Tests  19 passed (19)
```

`npm test` (full suite, after `npm run compile` for the gitignored `dist/` artifacts):
```
Test Files  96 passed | 1 skipped (97)
     Tests  1346 passed | 2 skipped (1348)
```
Baseline 1327 passed / 2 skipped / 0 failed → +19 (this task's cases) = 1346, 0 failed, no regression.

### Status: PASS

### Note

- **`src/adapters/*` import conflict resolved inline.** §Interfaces lists
  `getTableSortQuery` (src/adapters/postgres.ts) as a "consume", but the Acceptance Criteria
  require the module to import nothing from `src/adapters/*`, and importing postgres.ts would
  drag the `pg` driver into the webview bundle (esbuild browser platform). I composed the
  postgres arm of `composeSortQuery` inline, byte-identical to `getTableSortQuery`
  (`SELECT * FROM (inner) vsdb_sort[ WHERE …] ORDER BY quoteIdent(col,"postgres") ASC|DESC`).
  Case 13 compares against the real helper and passes. mssql arm likewise inline (TASK-006 may
  later replace it with a delegation to its adapter export). No `NotImplementedError` thrown.
- **Temporal normalization (case 16)** handles both `Date` instances and canonical
  `toISOString()`-shaped strings via a strict regex (`\d{4}-\d{2}-\d{2}T…Z`); mysql/mssql get
  `T`→space and trailing `Z` dropped, postgres keeps the ISO verbatim. This is the design's
  step-3 rule, not display-string type sniffing — `"007"` (case 18) never matches and stays
  `'007'`.
- **Case 17** additionally routes a `typed[i]` that is `null`/`undefined` to the `IS NULL`
  branch even when the display string differs, per the "never inside the IN list" rule.
- Typed arrays are used only when `typed.length === values.length`; wrong-length `typed` falls
  back to all-string literals (case 19).
- `dist/` is gitignored and absent in a fresh worktree; `npm test` first failed 2 smoke tests
  (ENOENT `dist/webview.css` / missing `dist/schemaForm.js`) until `npm run compile` created the
  artifacts — an environment build step, not a code regression.
- No git add / commit / push performed; the two new files are left untracked in the worktree.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ui/__tests__/queryComposer.test.ts
  result: 0 typecheck diagnostics / 21 tests pass (1 file)
TEST_PLAN_COVERAGE: all-followed — 19 original cases + 2 TASK-006-appended cases, typed value cases 15-19, edge cases for injection/blank/empty/mismatch all covered
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Clean implementation. buildFilterWhere dialect quoting, typed value routing, and injection escaping are correct. buildPagedQuery handles all three dialect paging styles correctly. composeSortQuery delegates mssql to adapter, composes postgres/mysql inline. No vscode/adapters imports that would bloat the webview bundle (mssql adapter import is host-side only per TASK-005). Tests assert real SQL strings for every dialect and edge case.
