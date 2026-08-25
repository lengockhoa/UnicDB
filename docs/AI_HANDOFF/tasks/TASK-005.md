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

---
