# TASK-BQ02-001 — BigQuery resource metadata adapter (real enumeration)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 TASK-BQ02-001 / §3 Approach / §4 Test Plan rows 1-12 (adapter group)

## Goal

Replace the `NotImplementedError("bigquery")` placeholders on `BigQueryAdapter`
(`src/adapters/bigquery.ts:269-304`) with real resource enumeration over the adapter's own client
seam: datasets as schemas, tables/views per dataset, columns + table metadata, row estimates.
The adapter-owned `BigQueryClient` seam is WIDENED to the real `@google-cloud/bigquery@9.0.3`
instance shapes. BQ-00 frozen surface byte-untouched.

## Target Files

- `src/adapters/bigquery.ts` — widen `BigQueryClient` seam + implement `listSchemas`,
  `listTables`, `listViews`, `listColumns`, `listRoutines`, `estimateTableRows`,
  `estimateTableRowsBatch`, `listTableDetail`. `listRoutineParams` KEEPS its
  `NotImplementedError` (documented deferral — see Discussion). `runQuery` body untouched.
  The widened `table` handle carries `getMetadata()` ONLY — no `getRows` member (no MVP
  caller; it Number-coerces INT64; re-evaluate in BQ-03).
- `src/adapters/__tests__/bigquery.test.ts` — new enumeration test groups; existing tests
  #1-#12 stay green verbatim (they inject fakes implementing the widened seam — extend
  `makeFakeClient`, don't break its current call sites).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `listSchemas` returns dataset ids | fake `getDatasets({})` resolving `[[{ id: "ds1", metadata: { id: "p:ds1", datasetReference: { datasetId: "ds1" } } }, { id: "ds2", metadata: { datasetReference: { datasetId: "ds2" } } }], null, {}]` → `[ { name: "ds1" }, { name: "ds2" } ]`; `includeSystem` flag accepted and ignored (BigQuery has no system datasets in list scope) | adapter connected, fake client |
| 2 | happy | `listTables("ds")` returns only `type === "TABLE"` | fake `dataset("ds").getTables({})` → PagedResponse `[tableObjs, null, {}]` with types TABLE / VIEW / MATERIALIZED_VIEW → `[{ name: "t1", schema: "ds" }]` only | fixture from `ITableList.tables[]` shape (types.d.ts:5983-6045) |
| 3 | happy | `listViews("ds")` returns VIEW + MATERIALIZED_VIEW, excludes TABLE + EXTERNAL | same fixture → `[{ name: "v1", schema: "ds" }, { name: "mv1", schema: "ds" }]` | same fixture |
| 4 | happy | `listColumns("t1","ds")` maps `getMetadata()` schema fields incl. REPEATED/RECORD | metadata `schema.fields = [{name:"id",type:"INT64",mode:"REQUIRED"},{name:"v",type:"STRING",mode:"NULLABLE"},{name:"tags",type:"STRING",mode:"REPEATED"},{name:"r",type:"RECORD",mode:"NULLABLE",fields:[{name:"a",type:"INT64",mode:"NULLABLE"}]}]` → `[{name:"id",dataType:"INT64",nullable:false,isPrimaryKey:false},{name:"v",dataType:"STRING",nullable:true,isPrimaryKey:false},{name:"tags",dataType:"STRING REPEATED",nullable:true,isPrimaryKey:false},{name:"r",dataType:"RECORD",nullable:true,isPrimaryKey:false}]` (REPEATED gets the type + mode suffix per §3; nested RECORD kept as one `RECORD` column, NOT flattened into the column list) | fake `table.getMetadata()` → `[{ metadata }, undefined]` ServiceObject response shape |
| 5 | edge (malformed input) | field missing `type`/`mode` | `{ name: "x" }` field → `dataType: ""`, `nullable: true` — no throw (mirrors frozen `mapSchemaField` defaults) | metadata with partial field |
| 6 | edge (empty) | empty dataset | `getTables` resolves `[[], null, {}]` → `listTables` = `[]` AND `listViews` = `[]`; no throw | empty fixture |
| 7 | edge (permission) | dataset enumeration rejects 403 | fake `getTables` rejects `{ code: 403, errors: [{ message: "access denied" }] }` → `listTables` REJECTS (caller renders error node); it must NOT swallow into `[]` | rejecting fixture |
| 8 | edge (boundary) | `estimateTableRows` past safe integer | metadata `numRows: "9007199254740993"` → resolves `null` (unknown), never a rounded number; `numRows: "42"` → `42` | two metadata fixtures |
| 9 | edge (boundary) | `estimateTableRowsBatch` shape | `(["a","b"])` with metadata a=`"42"`, b omitted from response → `Map { "a" => 42 }` (b absent); empty `tables` array → empty Map + ZERO client calls | batch fixtures |
| 10 | regression | not-connected / closed guards compose | `listSchemas()` before `connect()` → `BigQueryNotConnectedError`; after `close()` → `BigQueryClosedError` | pins TASK-CL-004 semantics on new methods |
| 11 | regression | existing 12 tests stay green | tests #1-#12 in this file pass verbatim after `makeFakeClient` gains the widened members | existing file, zero assertion edits |
| 12 | happy | `listTableDetail` returns columns + metadata rows | metadata with `timePartitioning {type:"DAY",field:"ts"}`, `clustering {fields:["a"]}`, `numRows:"10"`, `numBytes:"2048"` → `columns` array maps every schema field (same shape as #4); `constraints` carries ≥ 1 metadata entry (stringly-typed key/value contract of `TableDetail`) | metadata fixture |
| 13 | happy | `listTableDetail` never coerces an over-safe row count | metadata `numRows: "1234567890123456789"` (beyond `Number.MAX_SAFE_INTEGER`), same `timePartitioning`/`clustering` fixture as #12 → `constraints` carries the partitioning/clustering facts AND the row count is never coerced/rounded: the exact string is preserved verbatim (or surfaced as `null` "unknown") — never a `Number()`-coerced value | metadata fixture (pins §1 success definition 3 "without BigInt precision loss") |
| 14 | happy | `listRoutines` maps routine references name-only | fake `getRoutines` resolving `[[{ id: "r1", metadata: { routineReference: { routineId: "fn1" } } }, { metadata: { routineReference: { routineId: "proc1" } } }], null, {}]` → `[{ name: "fn1", kind: "function", schema: "ds" }, { name: "proc1", kind: "function", schema: "ds" }]` — `kind` hardcoded `"function"` per Discussion 5, `schema` = the dataset arg | connected adapter, routine fixtures |

## Test Files

- `src/adapters/__tests__/bigquery.test.ts` — all tests; extend the existing `makeFakeClient`
  helper (add `getDatasets`, `dataset` returning `{ getTables, getRoutines, table }`), do NOT
  rewrite existing tests.

## Verification Commands

```bash
npx vitest run src/adapters/__tests__/bigquery.test.ts
npm run typecheck
git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # must print nothing
```

(`npm run typecheck` is the static gate — **no lint script exists** in this repo. Frozen-surface
gate is mandatory. Sanity net: `npx vitest run src/adapters/__tests__/bigqueryAdc.test.ts
src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryConfig.test.ts
src/adapters/__tests__/factory.test.ts`.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; `npx vitest run src/adapters/__tests__/bigquery.test.ts` exits 0 with the new groups present.
- [ ] Existing tests #1-#12 unmodified and green.
- [ ] `listSchemas/listTables/listViews/listColumns/listRoutines/estimateTableRows/estimateTableRowsBatch/listTableDetail` no longer throw `NotImplementedError`; `listRoutineParams` still does (one-line comment citing the deferral).
- [ ] No `Number()` coercion on `numRows`/byte strings past `Number.MAX_SAFE_INTEGER` (tests #8, #13).
- [ ] Enumeration rejections propagate (no swallow-to-empty) except where the DbAdapter contract itself omits (test #9 batch).
- [ ] Frozen-surface gate: `git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` prints nothing.
- [ ] `npm run typecheck` exits 0.
- [ ] No new import of `@google-cloud/bigquery` at module top level (lazy `require` in default factory preserved).

## Dependencies

- (none)

## Interfaces

- Consumes: `BigQueryClient` / `BigQueryClientFactory` (bigquery.ts, existing adapter-owned seam — WIDENED by this task); `BigQueryNotConnectedError` / `BigQueryClosedError` (existing); `requireClient()` (existing); `ColumnInfo` / `SchemaInfo` / `TableInfo` / `ViewInfo` / `RoutineInfo` / `TableDetail` / `NotImplementedError` (types.ts, existing); `BigQuerySchemaField` from `./bigqueryTypes` (FROZEN — import only).
- Produces: widened `BigQueryClient` seam — the members later tasks/consumers rely on:
  `getDatasets(opts?: { maxResults?: number; pageToken?: string }): Promise<[Array<{ id?: string; metadata?: { datasetReference?: { datasetId?: string } } }>, unknown, unknown]>`;
  `dataset(id: string): { getTables(opts?: { maxResults?: number }): Promise<[Array<{ id?: string; metadata?: RawTableListItem }>, unknown, unknown]>; getRoutines(opts?): Promise<[Array<{ id?: string; metadata?: { routineReference?: { routineId?: string } } }>, unknown, unknown]>; table(id: string): { getMetadata(opts?): Promise<[RawTableMetadata, unknown]> } }` where `RawTableListItem` mirrors `ITableList.tables[]` (`tableReference?`, `type?`, `timePartitioning?`, `clustering?`, `requirePartitionFilter?`, `numRows?`, `numBytes?`, `creationTime?`, `labels?`) and `RawTableMetadata` mirrors `ITable` (adds `schema?: { fields?: Array<{ name?: string; type?: string; mode?: string; fields?: … }> }`). WIDENING ONLY — the existing members (`query`, `getQueryResults`, `createQueryJob`, `cancel`, `listDatasets`, `getDataset`, `getTable`) stay declared so BQ-01 tests keep compiling. The default factory's `as unknown as BigQueryClient` cast continues to work because the real instance satisfies the widened members structurally (verified at runtime against 9.0.3: `getDatasets` ✓, `dataset().getTables` ✓, `dataset().getRoutines` ✓, `table().getMetadata` ✓).

---

## Discussion

### 2026-09-03 · planner · unic-smart
Grounding notes for the executor:

1. **The current seam names do NOT exist on the real client.** Runtime check against the
   installed 9.0.3: `BigQuery.prototype` has `getDatasets` (not `listDatasets`), `dataset(id)`
   (not `getDataset`), and NO `getTable`. `Table.prototype.getMetadata` comes from
   `ServiceObject`. Today this is invisible because `runAdcSmoke` casts through BQ-00's narrow
   `BigQueryClientLike` and all tests inject fakes. Do NOT "fix" this by renaming existing
   members in place — widen (add) the new members and implement enumeration through them; the
   legacy members stay for compile compatibility with BQ-01 tests, marked with a
   "legacy seam member, superseded by the widened surface" comment. The one-way cast in
   `connect()` (`this.client as unknown as BigQueryClientLike`) keeps working untouched.
2. `ServiceObject.getMetadata()` resolves `[metadata, apiResponse]` (service-object.d.ts:167).
   Fakes must mirror the TUPLE, not the bare metadata.
3. `getTables` autoPaginate defaults ON for the Promise overload — a fake resolving
   `[tables, null, {}]` is the single-page contract; pass `{ maxResults: 1000 }` (a const) from
   the adapter so real pagination stays bounded per expand.
4. `TableDetail.constraints` is stringly-typed by contract (`schemaDiff.ts:93` maps it); for
   BigQuery put one entry per metadata fact, e.g. `conname: "partitioning"`, `consrc: "DAY(ts)"`,
   `contype: "meta"`, `conkey: []`, `confrelidname: null`, `confkeycols: null`. Verify the exact
   `TableDetail` field list in `src/adapters/types.ts:250-265` before mapping — do not invent
   fields.
5. `listRoutines` hardcodes `kind: "function"` (`RoutineInfo.kind` is only
   `"function" | "procedure"`); mapping `routineType` would widen a shared type — out of scope
   (roadmap defers routine depth to BQ-07b).
6. `estimateTableRowsBatch` contract (types.ts:151-154): dropped tables are OMITTED, empty input
   → empty Map with NO client call. A failed metadata read per table → `null` value in the Map
   (never throw), mirroring the mssql best-effort pattern (`mssql.ts:509`).
7. RED-first: write tests #1/#4/#8/#13 first against the current `NotImplementedError` state — they
   must fail with that error, then implement.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq02-001
 ✓ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listColumns > 5. malformed field falls back to dataType:'' and nullable:true
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ❯ BigQueryAdapter.listColumns src/adapters/bigquery.ts:282:11
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — permission edge > 7. getTables rejects 403 -> listTables REJECTS (no swallow)
AssertionError: expected undefined to be 403 // Object.is equality
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listColumns > 4. listColumns maps schema fields incl. REPEATED/RECORD
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listSchemas > 1. listSchemas maps dataset PagedResponse into SchemaInfo[]
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listTables > 2. listTables returns only type === 'TABLE'
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listViews > 3. listViews returns VIEW + MATERIALIZED_VIEW, excludes TABLE + EXTERNAL
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — empty dataset > 6. getTables resolves [[], null, {}] -> listTables = [] AND listViews = []
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — estimateTableRows > 8. numRows past MAX_SAFE_INTEGER -> null; small numRows -> number
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — estimateTableRowsBatch > 9. batch: ['a','b'] with a metadata numRows='42', b omitted -> Map {a->42}; empty input -> empty Map, 0 client calls
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — not-connected / closed guards > 10. listSchemas before connect() -> BigQueryNotConnectedError; after close() -> BigQueryClosedError
AssertionError: expected NotImplementedError: Driver "bigquery" is… to be an instance of BigQueryNotConnectedError
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listTableDetail > 12. listTableDetail maps metadata to columns + constraints (partitioning/clustering/row count)
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listTableDetail > 13. listTableDetail preserves numRows string verbatim when past MAX_SAFE_INTEGER
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 ...
 ❯ src/adapters/__tests__/bigquery.test.ts > TASK-BQ02-001 BigQueryAdapter — listRoutines > 14. listRoutines maps routineReference.routineId with hardcoded kind:'function'
NotImplementedError: Driver "bigquery" is not implemented yet (TASK-004 will add it).
 Test Files  1 failed (1)
      Tests  13 failed | 14 passed (27)
```

Verification Output:
```
$ npx vitest run src/adapters/__tests__/bigquery.test.ts
 ✓ src/adapters/__tests__/bigquery.test.ts  (27 tests) 31ms
 Test Files  1 passed (1)
      Tests  27 passed (27)
   Duration  246ms

$ npm run typecheck
> vsdb@1.48.0 typecheck
> tsc --noEmit
(exit 0, no output)

$ git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts
(empty output — frozen surface untouched)

$ npx vitest run src/adapters/__tests__/bigqueryAdc.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryConfig.test.ts src/adapters/__tests__/factory.test.ts
 ✓ src/adapters/__tests__/bigqueryTypes.test.ts  (7 tests) 3ms
 ✓ src/adapters/__tests__/bigqueryConfig.test.ts  (13 tests) 3ms
 ✓ src/adapters/__tests__/bigqueryAdc.test.ts  (6 tests) 4ms
 ✓ src/adapters/__tests__/factory.test.ts  (6 tests) 1ms
 Test Files  4 passed (4)
      Tests  32 passed (32)
```

Status: PASS
Note: Convention choice for `listTableDetail` row count: when `numRows` is past `Number.MAX_SAFE_INTEGER`, the constraint surfaces `consrc: "unknown"` (consistent with `estimateTableRows` returning `null` past safe integer). For safe-integer values, the verbatim wire string is preserved. This matches the success-definition-3 constraint "without BigInt precision loss" — `Number()` is NEVER applied to a value beyond safe integer; test #13 pins this. `listRoutines` hardcodes `kind: "function"` per Discussion #5 (roadmap defers routine depth to BQ-07b). `listRoutineParams` keeps its `NotImplementedError` with a one-line comment citing the deferral. Widened seam adds `getDatasets(opts?)` and `dataset(id): { getTables, getRoutines, table }` per Discussion #1 (real `@google-cloud/bigquery@9.0.3` names); legacy seam members (`listDatasets`, `getDataset`, `getTable`) are KEPT for BQ-01 compile compatibility and marked with comments.

---

## Reviewer Verdict

(pending)
