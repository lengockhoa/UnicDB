# PLAN — Cycle BQ-02: BigQuery resource explorer + table preview

Source spec: `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §4 "BQ-02 — BigQuery explorer and table preview" (P0, depends on BQ-01). Commissioned per roadmap §9: a NEW handoff cycle; no prior `docs/AI_HANDOFF` artifact overwritten (BQ-01 plan already archived with cycle history).
Base: `main @ e171d42` (post-CL-01, v1.48.0). Suite baseline: **3283 passed | 2 skipped**.

## §1 Intent

BQ-01 (v1.47.0) shipped the BigQuery connection foundation but deliberately deferred all resource
enumeration: every introspection method on `BigQueryAdapter` (`listSchemas`, `listTables`,
`listViews`, `listRoutines`, `listColumns`, `listRoutineParams`, `estimateTableRows`,
`estimateTableRowsBatch`, `listTableDetail`) currently throws `NotImplementedError("bigquery")`
(`src/adapters/bigquery.ts:269-304`). A user can add a BigQuery connection but expanding it in the
Schema Explorer yields an error node, and `vsdb.browseTableData` throws
`Unsupported driver: bigquery (BQ-02 wiring pending)` (`src/ui/browseCommands.ts:67`).

BQ-02 wires real implementations for the enumeration methods, keeps discovery lazy (project →
dataset → table/view), and makes the existing generic Schema Explorer + Browse Data flow work
end-to-end for BigQuery — mirroring the canonical `listSchemas/listTables/listColumns` shapes of
`postgres.ts`/`mysql.ts`/`mssql.ts` so no consumer (`schemaTree.ts`, `browseCommands.ts`,
`connectionManager.ts`) needs a BigQuery-specific fork.

**Success definition** (each verifiable in §6):
1. Expanding a BigQuery connection lists its datasets as schema nodes; expanding a dataset shows
   Tables/Views/Routines categories fed by the real client seam; expanding a table lists its
   columns from real table metadata.
2. Clicking/Enter on a BigQuery table or view node previews it: a bounded `SELECT * FROM ...`
   GoogleSQL statement runs through the existing `runner.run → panel.render` pipeline.
3. `BigQueryAdapter.listTableDetail` returns real columns + BigQuery metadata (partitioning,
   clustering, row/byte counts) without BigInt precision loss.
4. The BQ-00 frozen surface (`bigqueryTypes.ts`, `bigqueryAdc.ts`) stays byte-untouched.
5. Full suite ≥ 3283 passed, typecheck + compile exit 0.

**Scope check**: roadmap §4 scopes BQ-02 as ONE subsystem (explorer + preview). GoogleSQL query
jobs + paged grid (BQ-03) are a separately planned cycle — the preview path reuses the already-
working `runQuery` TUPLE path from BQ-01, so no shared-file conflict with BQ-03. No decomposition
needed; 4 tasks in one cycle.

## §2 Scope

**In-scope:**

| Task | Roadmap slice | Owns (no other task in its wave touches these) |
|---|---|---|
| TASK-BQ02-001 (w1) | Resource metadata adapter — real `listSchemas`/`listTables`/`listViews`/`listColumns`/`listRoutines`/`listRoutineParams`/`estimateTableRows(Batch)`/`listTableDetail` on `BigQueryAdapter` | `src/adapters/bigquery.ts`, `src/adapters/__tests__/bigquery.test.ts` |
| TASK-BQ02-002 (w1) | Pure preview SQL builder — `buildBigQueryPreviewSql` (bounded, backtick-quoted) + `buildBrowseSelect` bigquery arm | `src/ui/bigQueryPreview.ts` (new), `src/ui/__tests__/bigQueryPreview.test.ts` (new), `src/ui/browseCommands.ts` (arm swap only), `src/ui/__tests__/browseCommands.test.ts` (arm pins only) |
| TASK-BQ02-003 (w2) | Explorer wiring — bigquery metadata node labels/tooltip/icon parity + row-count batch suppression for bigquery + preview wiring check confined to `src/ui/schemaTree.ts` (verify bigquery table+view nodes stay wired to `vsdb.browseTableData`; the SQL itself ships in TASK-BQ02-002 — no `browseCommands.ts` edit in this task) | `src/ui/schemaTree.ts`, `src/ui/__tests__/schemaTree.test.ts`, `src/ui/__tests__/schemaTreeCatalog.test.ts` |
| TASK-BQ02-004 (w2) | User-facing copy + release gate — CHANGELOG entry, `package.json` version bump, release-hygiene suite green | `CHANGELOG.md`, `package.json` |

**Out-of-scope (deferred, per roadmap §4 + commissioning brief):**
- GoogleSQL query jobs + paged grid, `BatchedQuery` continuation, Load More (BQ-03).
- Bounded export (BQ-04), DML/DDL/cell editing (BQ-05+), service-account JSON / OAuth.
- Organization-wide project discovery; automatic cost calculation; saved/scheduled queries; GCS
  transfer; Storage Read API.
- `listRoutineParams` real implementation: BigQuery routines have no parameter-shaped surface in
  the MVP scope and no consumer path exists for bigquery (the only caller,
  `tableCommands.ts:652`, is guarded by `contextValue === "routine"` click flows the BQ tree
  does not enable). BQ-02 keeps the existing `NotImplementedError` throw for this one method,
  documented in TASK-BQ02-001's Discussion. Routines still list (names only) per roadmap
  ("routines may be visible as non-actionable metadata nodes").
- Routines/models as expandable nodes (roadmap: "visible but non-editable or deliberately
  deferred") — deferred; listed under Routines category only.
- `commandTag` sourcing for BQ results (carried BQ-01 minor) — needs the job-based path of BQ-03.

## §3 Approach

**Adapter enumeration via the existing client seam, no seam change.** The adapter-owned
`BigQueryClient` seam (`bigquery.ts:80-88`) already declares `listDatasets`, `getDataset`,
`getTable`, and `query`. BQ-02 implements the DbAdapter methods over exactly those seams:

- `listSchemas()` → `client.listDatasets()` (the ADC smoke already uses it; returns dataset ids).
- `listTables(schema)` / `listViews(schema)` → `client.getTable(datasetId, tableId)` is per-table;
  listing needs the dataset's `getTables()`. **Verified against the installed client 9.0.3**:
  the real instance has `getDatasets` (NOT `listDatasets`), `dataset(id)`, and
  `Dataset.prototype.getTables()` returning `PagedResponse<Table, …, ITableList>` where
  `ITableList.tables[]` carries `tableReference.tableId`, `type` ("TABLE" | "VIEW" |
  "MATERIALIZED_VIEW" | "EXTERNAL" | "SNAPSHOT"), `timePartitioning`, `clustering`,
  `requirePartitionFilter`, `labels`, `creationTime` (types.d.ts:5967-6050).
  **Critical grounding finding**: the current `BigQueryClient` seam method names
  (`listDatasets`, `getDataset`, `getTable`) do NOT match the real client instance surface
  (`getDatasets`, `dataset(id)`, `dataset(id).table(id)`) — the seam works today only because
  `runAdcSmoke` accepts a `BigQueryClientLike` cast and tests inject fakes. TASK-BQ02-001 must
  widen the adapter-owned seam (`BigQueryClient` in bigquery.ts — adapter-owned, NOT frozen) to
  carry the real client shapes (`getDatasets(opts?)`, `dataset(id)` → `{ getTables(opts?)… }`,
  `table` handle with `getMetadata()`; no `getRows` on the widened seam — no MVP caller, and it
  Number-coerces INT64 via `mergeSchemaWithRows_` (see rejected alternatives); re-evaluate in
  BQ-03 when the paged grid lands), keeping the default factory's cast surface truthful. The frozen BQ-00 `BigQueryClientLike` is untouched — `runAdcSmoke`'s structural
  contract (`listDatasets(projectId?)`) keeps working through the existing one-way cast.
- `listColumns(table, schema)` → `table.getMetadata()` → `ITable.schema.fields`
  (nested RECORD recursion already proven by `mapSchemaField` in bigqueryTypes.ts — reused via
  `BigQuerySchemaField`, import-only from the frozen module). Maps to `ColumnInfo { name,
  dataType (type + mode suffix for REPEATED/RECORD), nullable (mode !== "REQUIRED"),
  isPrimaryKey: false }` — BigQuery has no PKs. The fixture must cover REPEATED and RECORD
  (e.g. `STRING` REPEATED → `dataType: "STRING REPEATED"`, as pinned in §4), not only
  REQUIRED/NULLABLE.
- `listTableDetail(schema, table)` → same `getMetadata()` plus partition/clustering/row/byte
  metadata mapped into the `TableDetail` shape (`columns` half) with BigQuery-specific facts in
  the `constraints` half repurposed as key/value metadata rows — matching how the pg shape is
  consumed by `schemaDiff.ts` / `compareService.ts` (stringly-typed by contract).
- `estimateTableRows` / `estimateTableRowsBatch` → `ITable.numRows` (a string; parsed with a
  safe `Number()` only when ≤ MAX_SAFE_INTEGER, else `null` — "unknown"), no scan.
- `listRoutines(schema)` → `Dataset.getRoutines()` (client `getRoutines` exists on the real
  instance; returns `{ id?, routineReference? }` rows mapped to `RoutineInfo { name, kind:
  "function", schema }`).

**Preview via the generic browse path.** Rather than a new command surface, `vsdb.browseTableData`
gains a real bigquery arm: `buildBrowseSelect("bigquery", schema, table)` currently throws
(`browseCommands.ts:63-67`); TASK-BQ02-002 moves the quoting/bounding logic into a new pure module
`src/ui/bigQueryPreview.ts` (`buildBigQueryPreviewSql({ dataset, table, project?, limit })`) that
emits a backtick-quoted, LIMIT-capped (default 100, hard ceiling 1000) GoogleSQL SELECT; the
bigquery arm of `buildBrowseSelect` delegates to it. Full three-part references
`` `project`.`dataset`.`table` `` are used when the connection's `datasetProject` differs from
`billingProject`. `qualifyKeywordTables` is skipped for bigquery (PG keyword rules don't apply;
the SQL is always fully quoted anyway — same reasoning as the existing lazy no-op pin in
`browseCommands.test.ts` #11). Preview for views uses the identical SELECT (BigQuery views are
queryable) — no ctid-style wrapping, matching the TASK-001 PG read-path pin.

**Alternatives rejected:**
- *New `src/ui/bigQueryTree.ts` provider* (roadmap candidate): rejected — `schemaTree.ts` already
  parameterizes per-adapter through `DbAdapter`; a parallel tree would duplicate caching,
  filtering, folder grouping, and reveal plumbing for one driver. Roadmap itself marks this
  "choose after BQ-00 contract"; the contract proved the generic DbAdapter seam sufficient.
- *INFORMATION_SCHEMA queries for enumeration* (task brief's "listColumns on INFORMATION_SCHEMA"):
  rejected — BQ `INFORMATION_SCHEMA` views bill per query and are location-bound; the
  metadata/list APIs (`getTables`, `table.getMetadata`) are free, typed, and already paged. The
  brief's phrasing described the BQ-01 deferral, not a binding design choice; the client-metadata
  route satisfies the same contract with zero query cost.
- *DTO view of tables via `getRows` for preview*: rejected — `query()` with `skipParsing: true`
  is the proven precision-preserving path (BQ-01 R4.5); `getRows` runs `mergeSchemaWithRows_`
  (table.js:1001) which Number-coerces INT64.

**Wave logic**: TASK-001 (adapter) and TASK-002 (preview builder + browse arm) are independent —
different files, 002 consumes only the existing `runQuery`/`buildBrowseSelect` contracts. Wave 2:
TASK-003 (tree) consumes 001's real list methods through the `DbAdapter` interface (no symbol
import — mockable), and TASK-004 (release copy) consumes both. Same-wave file disjointness holds
(see §7 map).

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | adapter `listSchemas` returns dataset ids | fake client `getDatasets` resolving `[{ metadata: { id: "p:ds1" }, id: "ds1" }]` → `[{ name: "ds1" }]` |
| happy | adapter `listTables("ds")` filters `type === "TABLE"` | fake `getTables` with TABLE + VIEW + MATERIALIZED_VIEW rows → only the TABLE row, as `{ name: tableId, schema: "ds" }` |
| happy | adapter `listViews("ds")` returns VIEW + MATERIALIZED_VIEW | same fixture → both rows, `schema: "ds"` |
| happy | adapter `listColumns` maps schema fields incl. REPEATED/RECORD | fixture fields `[{name:"id",type:"INT64",mode:"REQUIRED"},{name:"v",type:"STRING",mode:"NULLABLE"},{name:"tags",type:"STRING",mode:"REPEATED"},{name:"r",type:"RECORD",mode:"NULLABLE",fields:[…]}]` → id/v as pinned, `tags → dataType "STRING REPEATED"` (type + mode suffix per §3), `r → dataType "RECORD"` with nested fields NOT flattened into the column list |
| edge (malformed input) | schema field missing `type`/`mode` | `{name:"x"}` → `dataType: ""` + `nullable: true` (no throw) — mirrors frozen `mapSchemaField` defaults |
| edge (empty) | empty dataset | `getTables` resolves `[[], null, {}]` → `listTables` returns `[]`, `listViews` returns `[]` |
| edge (permission) | dataset list rejects 403 | fake rejects `{ code: 403, errors:[{message:"access denied"}] }` → the adapter method REJECTS (error node path in tree), never returns `[]` |
| edge (boundary) | `estimateTableRows` with `numRows: "9007199254740993"` | returns `null` (past safe integer — unknown), not a rounded number |
| edge (boundary) | `estimateTableRowsBatch` with `numRows: "42"` | Map has `42` for that table; omitted row → absent from Map; empty `tables` array → empty Map, zero client calls |
| regression | not-connected guard composes with new methods | `listSchemas` before `connect()` → `BigQueryNotConnectedError`; after `close()` → `BigQueryClosedError` (pins CL-004 semantics on the new code) |
| happy | adapter `listTableDetail` carries partitioning/clustering, no count loss | fake `getMetadata` with `numRows: "1234567890123456789"` (beyond `MAX_SAFE_INTEGER`), `timePartitioning: { type: "DAY", field: "ts" }`, `clustering: { fields: ["a"] }` → `TableDetail.constraints` carries the partitioning/clustering facts AND the row count is never coerced/rounded (string kept verbatim or `null` for unknown) |
| happy | adapter `listRoutines` maps routine references | fake `getRoutines` rows `{ id, metadata: { routineReference: { routineId: "fn1" } } }` → `RoutineInfo { name: "fn1", kind: "function", schema: "ds" }` (name-only, hardcoded kind per §3) |
| happy | preview builder quoted + bounded | `buildBigQueryPreviewSql({dataset:"my ds", table:"tbl", limit:100})` → ``SELECT * FROM `my ds`.`tbl` LIMIT 100`` |
| happy | preview builder 3-part with datasetProject | `project:"proj-data"` → ``SELECT * FROM `proj-data`.`ds`.`tbl` LIMIT 100`` |
| edge (malformed input) | table id containing a backtick | `` `we``ird` `` doubling escape, never raw |
| edge (boundary) | limit clamped | `limit: 0` / `limit: -5` / `limit: 100000` → all emit `LIMIT 1000` (ceiling); omitted limit → `LIMIT 100` |
| happy | browse command bigquery arm | `buildBrowseSelect("bigquery","ds","tbl")` returns the same bounded SQL (no throw) |
| regression | pg/mysql/mssql arms byte-identical | existing `browseCommands.test.ts` #1-#4 pass verbatim |
| happy (tree) | bigquery connection expands to datasets | mocked adapter `listSchemas` → `[{"ds1"}]` → schema nodes labeled `ds1` with bigquery icon; NOT labeled as pg-style "schemas" tooltip |
| edge (tree) | listing rejection renders error node | mocked `listTables` rejects → category shows error node `Failed to load …`, tree does not crash |
| edge (tree) | row-count batch suppressed for bigquery | bigquery adapter WITHOUT `capabilities` declaration → `estimateTableRowsBatch` never called (no spurious count queries), descriptions keep dataset fallback |
| regression | postgres tree behavior unchanged | existing `schemaTree.test.ts` suites stay green verbatim |

Full-suite regression net: `npm test` at wave/cycle boundary (RULES.md policy) — baseline 3283|2
must hold with only additive growth.

## §5 Verification

```bash
# Per-task (executor, RED → GREEN):
npx vitest run src/adapters/__tests__/bigquery.test.ts            # TASK-BQ02-001
npx vitest run src/ui/__tests__/bigQueryPreview.test.ts src/ui/__tests__/browseCommands.test.ts  # TASK-BQ02-002
npx vitest run src/ui/__tests__/schemaTree.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts   # TASK-BQ02-003
npm run typecheck                                                  # static gate (no lint script exists)
npm run compile                                                    # bundle gate
npm run verify:release && git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # TASK-BQ02-004 release gate (full suite + typecheck + compile; frozen-surface diff MUST print nothing)

# Wave/cycle boundary:
npm test            # full suite — baseline 3283 passed | 2 skipped, only additive growth
npm run typecheck && npm run compile
git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts   # MUST print nothing (frozen surface)
```

`package.json` scripts verified at HEAD: `test` (vitest run), `typecheck` (tsc --noEmit),
`compile` (node esbuild.js), `verify:fast`, `verify:release`. **No `lint` script exists** —
`npm run typecheck` is the static gate; never silently skipped. `test:integration` requires a real
GCP project — out of scope for CI, unchanged.

## §6 Acceptance

- [ ] All 4 tasks `approved`/`approved_minor` in INDEX.md. — all tasks
- [ ] `BigQueryAdapter` enumeration methods no longer throw `NotImplementedError` (except
      `listRoutineParams`, documented deferral): focused bigquery suite passes with the new
      enumeration tests. — TASK-BQ02-001
- [ ] `buildBrowseSelect("bigquery", …)` returns bounded quoted SQL; bigquery table/view node
      click drives `runner.run` with it; existing dialect arms unchanged. — TASK-BQ02-002
- [ ] Schema Explorer renders dataset → Tables/Views/Routines for bigquery with no
      PostgreSQL-schema labeling; listing errors render error nodes. — TASK-BQ02-003
- [ ] Row-count batching does not fire for bigquery (no `capabilities` declaration). — TASK-BQ02-003
- [ ] Full suite ≥ 3283 passed | 2 skipped; typecheck + compile exit 0. — cycle gate
- [ ] BQ-00 frozen surface byte-untouched (`git diff --stat` on the two files is empty). — cycle gate
- [ ] CHANGELOG entry under a new `[1.49.0]` heading + `package.json` version `1.49.0`. — TASK-BQ02-004
- [ ] No new external dependency; `@google-cloud/bigquery` stays `^9.0.3`. — all

## §7 Global Constraints

- Base `main @ e171d42`; 1 commit per wave; commit inside the executor worktree session before returning.
- **FROZEN**: `src/adapters/bigqueryTypes.ts`, `src/adapters/bigqueryAdc.ts` — import only, byte-untouched. Every task ends with `git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` empty.
- Extend, don't replace: `BigQueryClientFactory` and `BigQueryAdapter` are the only adapter seams; the adapter-owned `BigQueryClient` interface in `bigquery.ts` MAY be widened (it is BQ-01 surface, not frozen), but BQ-00's `BigQueryClientLike` contract must stay structurally satisfied by the default factory.
- No new external dependency; no `package.json` dependency change (version bump only in TASK-BQ02-004).
- No new vscode command id; `vsdb.browseTableData` is the only user-facing entry point. No `package.json` `contributes` changes.
- No lint script exists — `npm run typecheck` is the static gate; never silently skipped.
- New source modules must stay vitest-testable without the vscode module (pure modules or vscode-mocked tests, per existing `schemaTree.test.ts` / `browseCommands.test.ts` harness patterns).
- File ownership (same-wave disjointness):
  - Wave 1 — TASK-BQ02-001: `src/adapters/bigquery.ts`, `src/adapters/__tests__/bigquery.test.ts` ∥ TASK-BQ02-002: `src/ui/bigQueryPreview.ts` (new), `src/ui/__tests__/bigQueryPreview.test.ts` (new), `src/ui/browseCommands.ts`, `src/ui/__tests__/browseCommands.test.ts`
  - Wave 2 — TASK-BQ02-003: `src/ui/schemaTree.ts`, `src/ui/__tests__/schemaTree.test.ts`, `src/ui/__tests__/schemaTreeCatalog.test.ts` ∥ TASK-BQ02-004: `CHANGELOG.md`, `package.json`

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (round 2)

## Planner Self-Audit
Checklist: 12/12 pass
Re-audit (Round 1 fix pass, 2026-09-03): 12/12 pass. Caught during audit: (a) the listTableDetail/listRoutines insertion had accidentally REPLACED the "preview builder quoted + bounded" §4 row — restored, final table is 22 rows (adapter 1-12, preview 13-18, tree 19-22) and task-header row ranges were corrected to match; (b) §3's REPEATED example (INT64) differed from the pinned fixture (STRING) — aligned to STRING. `verify:release` confirmed real in package.json:630 before writing §5.
Fixed during audit: (1) Runtime-verified the real client 9.0.3 instance surface (`getDatasets`/`dataset()`/`Dataset.getTables`/`Table.getMetadata`; `listDatasets`/`getDataset`/`getTable` DO NOT exist on the instance) — the plan originally assumed the current seam names were truthful; TASK-BQ02-001 now explicitly widens the adapter-owned `BigQueryClient` seam, and this latent mismatch is recorded instead of silently inherited. (2) Dropped `listRoutines` real implementation from the seam-widening table, then re-added it after confirming `Dataset.getRoutines` exists at runtime and roadmap allows name-only listing. (3) Merged an initially-planned separate tree-icon task into TASK-BQ02-003 (same file). (4) Narrowed TASK-BQ02-002's `browseCommands.ts` edit to the arm swap + qualifier skip only, after confirming `qualifyKeywordTables` is already lazy (test #11 pins zero listTables calls) so the skip is a one-line guard.
Known gaps: (1) `listRoutineParams` stays `NotImplementedError` — no consumer path for bigquery routines in MVP; recorded in §2. (2) Preview runs through BQ-01 `runQuery`, so a >500-row table preview returns only the first page's rows with no Load More (paged grid is BQ-03); the LIMIT cap (≤1000) plus `batchSize` default 500 keeps this a correct bounded preview, not a truncated surprise. (3) Routines list names only, `kind` hardcoded `"function"` (BigQuery routines carry a `routineType` the MVP does not map — deferred with BQ-07b). (4) Manual smoke against a real GCP project (roadmap §7 "Controlled integration") is out of CI scope and deferred to the maintainer recipe in ADR 0004 §9. (5) `column.description`/`friendlyName`/`labels` are fetched in metadata but not yet surfaced in the tree tooltip beyond existing schema/name fields — UI polish deferred with BQ-06.

## Plan Review Log

### Round 1 — 2026-09-03 · unic-smart
Status: Issues Found

COMPLETENESS:
  - docs/AI_HANDOFF/PLAN.md §4 — no test row for `listTableDetail`, yet §1 Success definition 3 explicitly promises "real columns + BigQuery metadata (partitioning, clustering, row/byte counts) without BigInt precision loss" and §6 acceptance bullet 2 leans on "the new enumeration tests". As written, TASK-BQ02-001 can ship `listTableDetail` mapping completely untested, and a task-level reviewer checking "all §4 tests implemented" would pass it while success criterion 3 goes unverified. Fix: add a happy test — fake `getMetadata` carrying `timePartitioning`/`clustering`/`numRows: "1234567890123456789"` (string, beyond MAX_SAFE_INTEGER) → TableDetail carries the partition/clustering facts and the count stays non-lossy (string kept or `null`), never a coerced/rounded number.
  - docs/AI_HANDOFF/PLAN.md §4 — no test row for `listRoutines`, although §2/§3 promise name-only listing (`RoutineInfo { name, kind: "function", schema }` from `Dataset.getRoutines()`). Fix: add one happy test pinning that mapping.
  - docs/AI_HANDOFF/PLAN.md §5 — the per-task RED→GREEN block names commands for 001/002/003 but none for TASK-BQ02-004, whose only owned files are `CHANGELOG.md`/`package.json`. Fix: add its exact gate (e.g. `npm run verify:release`, or the specific release-hygiene vitest file) so the 004 executor has a runnable verification target like the others.
CLARITY:
  - docs/AI_HANDOFF/PLAN.md §2 (TASK-BQ02-003 row) — "preview command dispatch through `buildBigQueryPreviewSql`" reads as if wave-2 task 003 edits `src/ui/browseCommands.ts`, but §2 and §7 assign that file to TASK-BQ02-002 (wave 1) only. As written an executor can legitimately violate the ownership map. Fix: reword so 003's dispatch work is explicitly confined to `src/ui/schemaTree.ts` (tree-item command already targets `vsdb.browseTableData`; 003 only verifies bigquery table+view nodes stay wired), or explicitly add `browseCommands.ts` to 003's ownership if a real edit is needed.
  - docs/AI_HANDOFF/PLAN.md §4 (listColumns happy row) — fixture covers only REQUIRED/NULLABLE, but §3 promises `dataType` carries a "type + mode suffix for REPEATED/RECORD" and no test pins that new-code behavior. Fix: add a REPEATED and/or RECORD field to the listColumns fixture with the expected suffixed `dataType`.
CONSISTENCY:
  - none
SCOPE:
  - none
YAGNI:
  - docs/AI_HANDOFF/PLAN.md §3 (seam-widening bullet) — it adds `getRows` to the widened `table` handle, but the plan's own rejected-alternatives bullet says `getRows` Number-coerces INT64 via `mergeSchemaWithRows_` and no in-scope path calls it. Fix: drop `getRows` from the widened seam or name its caller; otherwise TASK-BQ02-001 is instructed to add and maintain dead seam surface.

NOTES: Structure is strong — all six mandatory sections are substantive, same-wave file disjointness holds (§7 map), the BQ-00 frozen surface has a runnable guard, edge cases span 4 different kinds (malformed/empty/permission/boundary), regression rows present, typecheck gate named with the no-lint justification. The blocking gap is §4 coverage: two of the nine implemented adapter methods — including the one success criterion with explicit BigInt-loss risk — have no planned tests. Fix §4/§5 and the two wording items; no rewrite of §1-§3 or the wave structure is needed.

### Round 1 — 2026-09-03 · unic-smart (Issues Found → fixed in planner pass)
Fixes applied:
- §4 + test row 1: listTableDetail happy test added with MAX_SAFE_INTEGER-overflow numRows + partitioning/clustering; row-count must never be coerced/rounded
- §4 + test row 2: listRoutines happy test asserting {name, kind:"function", schema} mapping
- §4 extra (review CLARITY #2, beyond the caller's list): listColumns happy row fixture extended with REPEATED (`STRING REPEATED` mode-suffix) + RECORD fields pinning the §3 dataType-suffix promise; §3 listColumns bullet now names the suffix example explicitly
- §5 + TASK-BQ02-004 gate: `npm run verify:release && git diff --stat -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` (must be empty)
- §2 TASK-BQ02-003 phrasing: "preview command dispatch through `buildBigQueryPreviewSql`" → confined to `src/ui/schemaTree.ts` (verify bigquery table+view nodes wire to `vsdb.browseTableData`); file ownership unchanged, browseCommands.ts stays 002-owned
- §3 seam-widening: dropped `getRows` from the BigQueryClient table handle (no MVP caller; re-evaluate in BQ-03 when paged grid lands)

Ready for re-review.

### Round 2 — 2026-09-03 · unic-smart
Verdict: Approved
Summary: All six Round-1 fixes verified landed; §4 table recounted at 22 rows (adapter 1-12, preview 13-18, tree 19-22) matching the planner self-audit; §5 gate commands spot-checked real in package.json (verify:release exists, no lint script).

COMPLETENESS:
  - none — listTableDetail happy row (§4 line 151) now pins numRows "1234567890123456789" + timePartitioning/clustering with a non-lossy count assertion, closing §1 Success-3; listRoutines happy row (line 152) pins the §3 name-only mapping; TASK-BQ02-004 has its exact gate (§5 line 176: npm run verify:release + frozen-surface diff must print nothing).
CONSISTENCY:
  - none — §2 TASK-BQ02-003 wording no longer conflicts with the §7 ownership map (schemaTree.ts only, browseCommands.ts stays 002-owned); §3's REPEATED example (STRING) now matches the §4 listColumns fixture verbatim.
CLARITY:
  - none
SCOPE:
  - none — BQ-03 paged grid remains cleanly fenced out; wave-1/wave-2 file disjointness intact.
YAGNI:
  - none — getRows dropped from the widened seam with rationale (mergeSchemaWithRows_ INT64 coercion, no MVP caller) and an explicit BQ-03 re-evaluation trigger.

NOTES: Ready for task creation. Minor non-blocking observation for later: §4 row 11 permits listTableDetail's row count as "string kept verbatim or null" while estimateTableRows mandates null past MAX_SAFE_INTEGER — both non-lossy, but TASK-BQ02-001's executor should pick one convention for consistency.
