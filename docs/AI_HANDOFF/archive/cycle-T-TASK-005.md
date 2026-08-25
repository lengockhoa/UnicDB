# TASK-005 — Adapters: cursor fast-path predicate, pg_catalog introspection, MSSQL columns, batch row estimate

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.9 (D4, D5, D6 + D2 API) — §7 Global Constraints applies by reference

## Goal

Cut per-query and per-table cost at the adapter layer, and add the batch API the schema tree
needs (TASK-010).

- **D5** — `PostgresAdapter.runQuery` (`src/adapters/postgres.ts:159-168`) routes to the cursor
  path only when `/^\s*SELECT\b/i.test(text) && !text.includes(";")`. A leading comment (which
  the splitter always keeps) or any `WITH … SELECT` CTE defeats it, and a `;` inside a string
  literal defeats it too. The fallthrough calls `pool.query`, which **materializes the whole
  result set** — no Load-More, no streaming, OOM risk. `mssql.ts:182` already accepts `WITH`;
  mirror that.
- **D4** — `PostgresAdapter.listColumns` (`postgres.ts:311-339`) issues 2 queries, joins
  `information_schema.columns` (per-column `has_column_privilege` DB-wide) and evaluates the
  `::regclass` cast three times. `INTROSPECT_COLUMNS_SQL` in `src/core/ddl/pgIntrospect.ts:36-57`
  is a strictly faster pure-`pg_catalog` equivalent — switch to it and fold PK detection into a
  single `pg_index` lookup that casts once.
- **D6** — `MssqlAdapter.listColumns` (`mssql.ts:274-292`) runs a correlated `EXISTS` over
  `sys.indexes ⋈ sys.index_columns` **per column**. Replace it with a single `LEFT JOIN` against
  the PK's `index_columns` so the PK flags come back in the same round trip.
  **Scope note (review round 1):** the `this.literal(...)` interpolation stays as-is. This adapter
  has **no parameter-binding path** — `newRequest(sql)` (`mssql.ts:474-476`) builds a bare
  `new Request(sql, cb)` with no `addParameter`, and `literal()` (`mssql.ts:728`) already escapes
  `'` → `''`, so the values are correctly quoted, not injectable. Introducing `TYPES`-based
  binding is a real adapter change with its own test surface; it does not belong in an
  unbreak-only cycle and is queued for cycle U. D6 here is the **cost** fix only.
- **D2 API** — add `estimateTableRowsBatch(schema, tables)` to `DbAdapter` so the tree can ask
  once per schema instead of N times against a `max: 1` pool.

## Target Files

- `src/adapters/types.ts`
- `src/adapters/postgres.ts`
- `src/adapters/mysql.ts`
- `src/adapters/mssql.ts`
- `src/adapters/__tests__/postgres.test.ts`
- `src/adapters/__tests__/adapterQueryShape.test.ts` (new)

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | plain SELECT | `SELECT * FROM t` → cursor path (`{results: [], batched}`) |
| Happy | batch estimate | `estimateTableRowsBatch("public", ["a","b","c"])` → **1** query issued, `Map` with 3 entries |
| Edge (comment) | leading comment | `-- note\nSELECT 1` → cursor path; today `pool.query` |
| Edge (CTE) | `WITH x AS (SELECT 1) SELECT * FROM x` | cursor path |
| Edge (literal) | `SELECT ';' AS a` | cursor path (the `;` is inside a literal, not a boundary) |
| Edge (must NOT batch) | `SELECT 1; SELECT 2;` | non-cursor path, 2 results |
| Edge (empty) | `estimateTableRowsBatch("public", [])` | no query issued, empty `Map` |
| Edge (missing) | table dropped between list and estimate | entry omitted from the `Map`, no throw |
| Edge (quoting) | MSSQL `listColumns("dbo", "O'Brien")` | emitted SQL contains `'O''Brien'` exactly once (the existing `literal()` escape is preserved by the rewrite, not lost) |
| R (D5) | leading-comment SELECT | today materializes the full result set (asserted via the non-cursor branch being taken) |
| R (D4) | PG `listColumns` output | identical `ColumnInfo[]` (names, types, nullability, PK flags) before/after, with `information_schema` no longer referenced |
| R (D6) | MSSQL `listColumns` | one round trip, no per-column `EXISTS` in the emitted SQL |

## Test Files

- `src/adapters/__tests__/postgres.test.ts` (extend — D4 shape parity)
- `src/adapters/__tests__/adapterQueryShape.test.ts` (new — D5 routing predicate, D6 emitted SQL, batch estimate for all three drivers)

## Verification Commands

```bash
npm run typecheck
npm test -- src/adapters/__tests__/postgres.test.ts
npm test -- src/adapters/__tests__/adapterQueryShape.test.ts
npm test -- src/adapters/__tests__/factory.test.ts
npm test -- src/adapters/__tests__/schemas.test.ts
npm test -- src/core/__tests__/pgIntrospect.test.ts
npm test -- src/core/__tests__/resultBatcher.test.ts
```

Live-database verification (run once, separately — requires a reachable Postgres/MySQL/MSSQL; not
part of the per-task gate):

```bash
npm run test:integration
```

## Acceptance Criteria

- [ ] All 12 cases pass; each regression case confirmed failing on `main` first (output in report).
- [ ] The cursor-routing decision lives in one named, exported-for-test helper (e.g.
      `shouldUseCursor(text: string): boolean`) rather than inline regexes, and is covered by the
      comment / CTE / literal / multi-statement cases above.
- [ ] `PostgresAdapter.listColumns` references `pg_catalog` only — zero `information_schema`
      references — and casts `::regclass` at most once per call.
- [ ] `MssqlAdapter.listColumns` issues **one** query with **zero** correlated `EXISTS`
      subqueries, and returns the same `ColumnInfo[]` (names, types, nullability, PK flags) as
      today. `this.literal(...)` stays — see the D6 scope note; parameter binding is cycle U.
- [ ] `estimateTableRowsBatch` is implemented on **all three** adapters and declared on
      `DbAdapter`; MySQL's implementation does not force per-table statistics collection.
- [ ] Existing `estimateTableRows` stays for single-table callers (no breaking removal).
- [ ] `npm run typecheck` clean; `npm run test:integration` green on a live Postgres.

## Dependencies

- (none)

## Interfaces

- Consumes: `INTROSPECT_COLUMNS_SQL(_schema: string, _table: string): string` from
  `src/core/ddl/pgIntrospect.ts:36` (binds `$1` = schema, `$2` = table); `splitStatements(sql)`
  from `src/core/statementParser.ts:278` (keep the 1-argument call form — TASK-004 owns that file
  and only adds an optional 2nd parameter).
- Produces:

```ts
// src/adapters/types.ts
export interface DbAdapter {
  runQuery(sql: string): Promise<RunResult>;               // unchanged
  estimateTableRows(schema: string, table: string): Promise<number | null>;   // unchanged
  /** NEW (D2): one round trip for many tables. Missing/dropped tables are
   *  omitted from the map rather than mapped to null. */
  estimateTableRowsBatch(
    schema: string,
    tables: readonly string[],
  ): Promise<Map<string, number | null>>;
}

export interface RunResult { results: QueryResult[]; batched?: BatchedQuery; }  // unchanged
```

`estimateTableRowsBatch` is consumed by `src/ui/schemaTree.ts` (TASK-010, wave 2).

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

`RunResult`'s contract is load-bearing for two other tasks this cycle: TASK-009 fixes a host
consumer that assumed `results[0]` always exists. Do **not** "helpfully" also populate
`results[0]` on the batched path — that would paper over the bug TASK-009 is fixing and silently
double-read the cursor.

D5 widens what goes down the cursor path. Anything newly routed there must still be closed by the
existing batcher; check `src/core/resultBatcher.ts` and its test stay green.

For MySQL's batch estimate, prefer `SHOW TABLE STATUS` filtered by schema, or a single
`information_schema.TABLES` query with `WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (…)` — the
current per-table form at `mysql.ts:254-258` is the shape that forces statistics collection.

### 2026-08-25 · executor · claude-sonnet-5

Scope decisions recorded (no ambiguity required asking anyone):

- D5's `shouldUseCursor` helper is scoped to `PostgresAdapter` only, per the defect description
  ("`PostgresAdapter.runQuery` routes..."). `mysql.ts`'s existing (also-buggy) routing regex and
  `mssql.ts`'s existing (already `WITH`-aware) routing regex were left untouched — not in this
  task's Target Files, and no Test Case in the table requires cross-adapter sharing.
- Old `!text.includes(";")` guard in the Postgres predicate was dropped entirely, not patched: by
  the time `runQuery` sees `statements[0].text`, `splitStatements()` has already isolated real
  statement boundaries, so any `;` still present is guaranteed to be inside a string/comment —
  the check was redundant at best, a false-negative source at worst (Edge literal case).
- `tsconfig.json` excludes `**/*.test.ts` from `tsc --noEmit`, and vitest transpiles via esbuild
  (no type-check pass), so pre-existing `DbAdapter`-typed fixture literals in unrelated test files
  (`resultsPanelRequery.test.ts`, `sqlTool.test.ts`, `hostTools.test.ts`, `schemaTree.test.ts`,
  `tableCommands.test.ts`, `aiChatE2e.test.ts`) do not need an `estimateTableRowsBatch` stub added
  — confirmed by a clean `npm run typecheck` after the interface change, no scope creep into files
  outside Target Files.

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-5
EXECUTOR_SUBAGENT: -
SUMMARY: Fixed D5 (Postgres cursor-routing predicate defeated by comments/CTEs/literal `;`),
D4 (`PostgresAdapter.listColumns` rewritten onto pure `pg_catalog`, single `::regclass` cast),
D6 (`MssqlAdapter.listColumns` correlated `EXISTS`-per-column replaced with one `LEFT JOIN`,
`literal()` escaping preserved unchanged), and added `estimateTableRowsBatch(schema, tables)` to
`DbAdapter` + all three adapter implementations (Postgres/MySQL/MSSQL), each one round trip.

TEST_PLAN_FOLLOWED: task §Test Cases (12 rows) — followed exactly; all 12 cases covered by the
21 tests in `adapterQueryShape.test.ts` (new) plus 2 shape-parity tests appended to
`postgres.test.ts`.

FILES_CHANGED:
  - src/adapters/types.ts: added `estimateTableRowsBatch(schema, tables)` to `DbAdapter` interface
    (D2 API), doc comment specifies omit-on-missing / empty-array-no-query contract.
  - src/adapters/postgres.ts: added exported `shouldUseCursor(text)` pure helper + private
    `stripLeadingCommentsAndWhitespace` (D5); `runQuery`'s `singleSelect` now calls
    `shouldUseCursor` instead of the old `/^\s*SELECT\b/.test() && !text.includes(";")` guard;
    rewrote `listColumns` onto `INTROSPECT_COLUMNS_SQL` + a single-cast `pg_index` PK lookup (D4,
    2 queries total, was `information_schema.columns` join with 3× `::regclass`); added
    `estimateTableRowsBatch` (D2, `pg_class`/`pg_namespace`, one query, `relname = ANY($2)`).
  - src/adapters/mysql.ts: added `estimateTableRowsBatch` (D2) — single
    `information_schema.TABLES ... TABLE_NAME IN (...)` query, `TABLE_TYPE = 'BASE TABLE'` filter
    avoids forcing statistics collection. D5 routing regex in this file intentionally untouched
    (out of scope — task targets `PostgresAdapter.runQuery` only).
  - src/adapters/mssql.ts: rewrote `listColumns` (D6) — `sys.tables`/`sys.columns`/`sys.types`
    joined with one `LEFT JOIN` subquery over `sys.indexes`/`sys.index_columns` (`is_primary_key =
    1`) instead of a correlated `EXISTS` per column; `this.literal(...)` interpolation kept as-is
    per the D6 scope note. Added `estimateTableRowsBatch` (D2) — one query over
    `sys.partitions`/`sys.tables`/`sys.schemas`, `p.index_id IN (0,1)`, `GROUP BY t.name`.
  - src/adapters/__tests__/postgres.test.ts: extended — new
    `describe("PostgresAdapter — listColumns shape parity (TASK-005 D4)")` block, 2 tests (happy
    with PK flag, edge with no PK), using the file's existing `queue`-based `vi.mock("pg")`
    pattern; asserts identical `ColumnInfo[]` shape round-tripping through the real mocked
    `pool.query(sql, params)` call path (not a monkeypatched private method).

TESTS_ADDED:
  - src/adapters/__tests__/adapterQueryShape.test.ts (new, 21 tests):
    - `shouldUseCursor — pure predicate (D5)`: plain SELECT, leading line comment, leading block
      comment, WITH CTE, literal semicolon, non-SELECT statement (6 tests).
    - `PostgresAdapter.runQuery — cursor routing (D5)`: Happy plain SELECT, Edge comment / R(D5)
      regression, Edge CTE, Edge literal, Edge must-NOT-batch (5 tests).
    - `PostgresAdapter.listColumns — pg_catalog rewrite (D4)`: no `information_schema`, ≤1
      `::regclass` cast, correct shape (1 test).
    - `PostgresAdapter.estimateTableRowsBatch (D2)`: happy 3-tables/1-query, empty/no-query,
      missing-table-omitted (3 tests).
    - `MySqlAdapter.estimateTableRowsBatch (D2)`: happy, empty (2 tests).
    - `MsSqlAdapter.listColumns — single round trip, no correlated EXISTS (D6)`: shape + one-query
      + no-EXISTS + has-LEFT-JOIN; Edge quoting `'O''Brien'` exactly once (2 tests).
    - `MsSqlAdapter.estimateTableRowsBatch (D2)`: happy, empty (2 tests).
  - src/adapters/__tests__/postgres.test.ts (extended, +2 tests): D4 shape-parity happy/edge
    cases through the real `vi.mock("pg")` client/pool path.

RED (captured before implementation, `npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts`):
```
18 failed | 3 passed (21)

 ❯ shouldUseCursor — pure predicate (D5) — 6 tests
   TypeError: shouldUseCursor is not a function
   (plain SELECT / leading line comment / leading block comment / WITH CTE /
   literal semicolon / non-SELECT — all 6, function did not exist yet)

 ❯ PostgresAdapter.runQuery — cursor routing (D5)
   AssertionError: expected undefined not to be undefined
   (Edge comment / Edge CTE / Edge literal — 3 cases: old regex fell through to
   pool.query, result.batched stayed undefined instead of being set)

 ❯ PostgresAdapter.listColumns — pg_catalog rewrite (D4)
   AssertionError: expected 'SELECT c.column_name, ... information_schema.columns ...'
   not to match /information_schema/i
   (old query still joined information_schema.columns)

 ❯ *.estimateTableRowsBatch (D2) — Postgres/MySQL/MSSQL — 7 tests
   TypeError: adapter.estimateTableRowsBatch is not a function
   (method did not exist on any of the three adapters yet)

 ❯ MsSqlAdapter.listColumns — no correlated EXISTS (D6)
   AssertionError: expected 'SELECT c.name AS name, ... EXISTS (...) ...'
   not to match /EXISTS/i
   (old query still had the correlated EXISTS per column)
```
All failures were for the expected reason (missing implementation / old buggy SQL still
in place) — no test was wrong or trivially passing.

VERIFICATION (all commands run fresh in this turn, in order, from the task's Verification
Commands section):
  command: npm run typecheck
  result: clean, exit 0, no output beyond the npm script banner

  command: npm test -- src/adapters/__tests__/postgres.test.ts
  result: 12 passed (12), 1 file passed

  command: npm test -- src/adapters/__tests__/adapterQueryShape.test.ts
  result: 21 passed (21), 1 file passed

  command: npm test -- src/adapters/__tests__/factory.test.ts
  result: 4 passed (4), 1 file passed

  command: npm test -- src/adapters/__tests__/schemas.test.ts
  result: 9 passed (9), 1 file passed

  command: npm test -- src/core/__tests__/pgIntrospect.test.ts
  result: 14 passed (14), 1 file passed

  command: npm test -- src/core/__tests__/resultBatcher.test.ts
  result: 8 passed (8), 1 file passed

  command: npm test  (full suite, fresh in this turn, after `npm run compile` regenerated the
    worktree's missing `dist/` build artifacts — the worktree had never been built, which is
    what caused 2 unrelated pre-existing dist-dependent tests, `extension.test.ts` "npm run
    compile emits dist/schemaForm.js" and `agGridSmoke.test.ts` "dist/webview.css", to fail on
    the first full-suite run; neither file is in this task's Target Files and neither test
    touches adapters — confirmed environment artifact, not a regression, by re-running clean
    after `npm run compile`)
  result: 1067 passed, 2 skipped (1069 total) across 82 passed files + 1 skipped file (83).
    Baseline was 1044 passed / 2 skipped / 81 files passed. Delta is exactly +23 passed tests
    (21 in adapterQueryShape.test.ts + 2 appended to postgres.test.ts) and +1 file — an exact
    superset of baseline, zero regressions, skip count unchanged.
  output_excerpt: |
    Test Files  82 passed | 1 skipped (83)
         Tests  1067 passed | 2 skipped (1069)
      Duration  6.94s

  command: npm run test:integration  (live-DB verification — explicitly separate from the
    per-task gate per the task file, run for completeness against Acceptance Criteria's
    "green on a live Postgres" line)
  result: 4 files skipped, 27 tests skipped — 0 run. `VSDB_IT` env var is unset (tests self-gate
    on `process.env.VSDB_IT === "1"`), and the fixture port these tests target (Postgres 5433,
    MSSQL 1434) is not reachable in this sandbox (port 5433 closed; only an unrelated port-5432
    Postgres was reachable, not the docker-compose fixture these tests expect). This is an
    out-of-repo blocker (no live DB fixture available in this environment), not a code defect —
    documented per Handoff-mode rule rather than silently skipped.

ISSUES: `npm run test:integration` could not be exercised live in this sandbox (no reachable
docker-compose DB fixture, `VSDB_IT` unset) — this is explicitly listed in the task file as
separate from the per-task verification gate, but is called out here since the Acceptance
Criteria checklist also references it. All other Acceptance Criteria checkboxes are satisfied:
one named exported helper (`shouldUseCursor`) covers all D5 cases; `listColumns` (Postgres) is
`pg_catalog`-only with ≤1 `::regclass` cast; `listColumns` (MSSQL) is one query, zero `EXISTS`,
`literal()` preserved; `estimateTableRowsBatch` implemented on all three adapters and declared on
`DbAdapter`; `estimateTableRows` (singular) untouched; `npm run typecheck` clean.

HANDOFF_TO_REVIEWER: yes — Handoff mode, STATUS: DONE, per §7 the next session should pick this
up as `pending_review`.

NEXT: ready for review. Reviewer should double check the D6 scope boundary (literal()
interpolation preserved, not hardened) matches the review-round-1 note in this file's Discussion
section, and that TASK-010 (schemaTree.ts, wave 2) can consume `estimateTableRowsBatch` as typed
here without further interface changes.

---
