# TASK-BQ02-003 — Schema Explorer bigquery wiring (datasets, icons, row-count suppression)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 TASK-BQ02-003 / §3 Approach / §4 Test Plan rows 19-22 (tree group)

## Goal

Make the existing Schema Explorer render BigQuery correctly now that
`BigQueryAdapter` enumerates real resources (TASK-BQ02-001): dataset nodes must not be labeled
with the PostgreSQL host:port tooltip, the BigQuery connection gets its own icon, and the
fire-and-forget row-count batcher must not fire for bigquery (no `capabilities` declaration on
`BigQueryAdapter` means `estimateTableRowsBatch` is implemented but the adapter is NOT a catalog
adapter — the suppression must be explicit and pinned, because a spurious batch query per
dataset expand violates the cost-safety posture). The browse gesture already flows through
`vsdb.browseTableData` (TASK-BQ02-002) — this task only touches the tree side.

## Target Files

- `src/ui/schemaTree.ts` — (a) `DRIVER_ICONS` gains `bigquery: "cloud"` (vscode codicon; any existing theme icon id is acceptable if `"cloud"` is unavailable — pin whatever you choose in the test); (b) `connectionNode()` tooltip branches for `driver === "bigquery"`: `"<name>\nbigquery@<billingProject>[/<location>]\nClick để đổi active connection"` instead of `driver@host:port/database` (host/port/database are empty strings for bigquery — the current format renders `bigquery@:0/`); (c) `getCategoryChildren()` row-count batch guard: skip `fetchRowCountsBatch` when `conn.driver === "bigquery"` (cheap driver check — capability-based suppression is already implied since `BigQueryAdapter` declares no `capabilities`, but the driver guard makes the cost intent explicit and testable); (d) schema-node tooltip for bigquery datasets reads `"<conn.name> / dataset <ds>"` (not the pg-style implication that a dataset is a schema namespace).
- `src/ui/__tests__/schemaTree.test.ts` — new bigquery describe-block; existing suites green verbatim.
- `src/ui/__tests__/schemaTreeCatalog.test.ts` — one pin added: catalog categories (Indexes/Constraints/Triggers/Sequences) never render for bigquery (adapter without `capabilities` — `hasAdapterCapability` fail-closed already covers it; the test PINS it against accidental future capability declaration without a real catalog).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | bigquery connection expands to dataset nodes | connection cfg `driver: "bigquery"`, mocked adapter `listSchemas` → `[{ name: "ds1" }, { name: "ds2" }]` → `getChildren(connectionNode)` returns 2 schema nodes labeled `ds1`/`ds2`, `contextValue: "schema"` | `setupTree`-style harness with bigquery cfg (reuse the existing fake-adapter + ConnectionManager harness pattern) |
| 2 | happy | bigquery connection node icon + tooltip | `getTreeItem` on the connection node → icon resolved from the bigquery `DRIVER_ICONS` entry; tooltip matches `/<name>\nbigquery@proj-billing(\/US)?\nClick/` (host/port/database absent) | bigquery cfg with `bigquery: { billingProject: "proj-billing", location: "US" }` |
| 3 | edge (labeling) | dataset tooltip does not imply pg schema | schema node tooltip for bigquery contains `dataset ds1`; for postgres it stays `"<conn> / <schema>"` (existing behavior untouched) | both drivers in one test or two |
| 4 | edge (error) | dataset listing rejection renders error node | mocked `listTables` rejects → Tables category children = `[<error node>]` with label starting `Failed to load`/`Connect failed`; `getChildren` does not throw | throwing fake adapter |
| 5 | edge (cost) | row-count batch never fires for bigquery | expand a Tables category with 2 bigquery tables → mocked `estimateTableRowsBatch` call count === 0; table descriptions keep the dataset fallback; same fixture with postgres driver fires the batch (differential pin) | spy-counted fake adapter, both drivers |
| 6 | regression | postgres/mysql/mssql tree behavior unchanged | existing `schemaTree.test.ts` + `schemaTreeCatalog.test.ts` suites pass verbatim (row-count batching, filter, folder grouping, reveal) | existing files, zero assertion edits |
| 7 | edge (capability pin) | catalog categories absent for bigquery | `getChildren` on a bigquery table node → no Indexes/Constraints/Triggers categories; only column children | fake adapter without `capabilities`, columns fixture |
| 8 | happy | bigquery table/view nodes stay wired to `vsdb.browseTableData` | `getTreeItem` on a bigquery table node AND a view node → `command.command === "vsdb.browseTableData"` with `command.arguments[0]` whose `meta` resolves `{ schema: "ds", objectName: "tbl" }` (the same node contract TASK-BQ02-002's #7 drives) — assert the node wiring only; the SQL/builder and runner are 002-owned and NOT edited by this task | node factory pin |

## Test Files

- `src/ui/__tests__/schemaTree.test.ts` — tests #1-#6, #8 (new describe-block reusing the file's `setupTree`/`makeFakeAdapter` harness; extend the harness's cfg helper for bigquery — a bigquery `ConnectionConfig` needs `bigquery: { billingProject }` to satisfy `validateBigQueryConnection`).
- `src/ui/__tests__/schemaTreeCatalog.test.ts` — test #7 (one new case, existing cases untouched).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/schemaTree.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts
npm run typecheck
npm run compile
```

(`npm run typecheck` is the static gate — **no lint script exists**. Resolution per RULES.md:
`src/ui/schemaTree.ts → ["src/ui/__tests__/schemaTree.test.ts","src/ui/__tests__/schemaTreeCatalog.test.ts"]`
from `.cache/index/tests-map.json`. Non-empty floor satisfied; do NOT default to the full suite.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; existing suites in both files green verbatim.
- [ ] BigQuery connections render `bigquery@<billingProject>` tooltips (no `:0/` artifacts from empty host/port/database).
- [ ] Dataset nodes' copy never labels them PostgreSQL-style schemas (test #3).
- [ ] `estimateTableRowsBatch` is provably never called on the bigquery path (test #5) — zero cost-accident surface per expand.
- [ ] No Indexes/Constraints/Triggers/Sequences categories for bigquery (test #7).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] `src/ui/browseCommands.ts` and `src/adapters/*` NOT touched by this task (file-disjoint from wave-1 tasks).

## Dependencies

- TASK-BQ02-001 must complete first — this task's fixtures mock the ADAPTER INTERFACE, but the
  differential row-count pin (#5) needs `BigQueryAdapter`'s real `listTables`/columns behavior
  to exist so the tree's table-node path is exercised against an interface that no longer
  throws `NotImplementedError` (otherwise the fixture adapter and the real adapter can drift).
  TASK-BQ02-002 is NOT a dependency (this task pins the node contract only).

## Interfaces

- Consumes: `BigQueryAdapter` enumeration methods from TASK-BQ02-001 — `listSchemas(): Promise<SchemaInfo[]>`, `listTables(schema?: string): Promise<TableInfo[]>`, `listViews(schema?: string): Promise<ViewInfo[]>`, `listColumns(table: string, schema?: string): Promise<ColumnInfo[]>` (same `DbAdapter` signatures as postgres/mysql/mssql — the tree consumes through `DbAdapter`, no bigquery-specific import); `hasAdapterCapability` (adapters/types.ts:208, existing fail-closed predicate); `VsdbNode.meta` contract (`connection`, `schema`, `objectName`, `objectKey`) and the `vsdb.browseTableData` node-argument contract from TASK-BQ02-002 (command carries the whole node as `arguments[0]`).
- Produces: `DRIVER_ICONS.bigquery` entry + bigquery tooltip format in `schemaTree.ts`; the pinned invariant that bigquery tree expansion issues ZERO `estimateTableRowsBatch` calls. No new exports; no signature changes.

---

## Discussion

### 2026-09-03 · planner · unic-smart
1. The tree consumes `DbAdapter` — no `bigquery` symbol appears in `schemaTree.ts` except the
   `DRIVER_ICONS` key and the two driver-string checks (`"bigquery"`), matching how `mssql`
   gets its `"azure"` icon today. Keep it that way: the roadmap's acceptance line is "the tree
   does not label BigQuery datasets as PostgreSQL schemas where that would imply unsupported
   behavior" — tooltip copy is the deliverable, not a type fork.
2. `ConnectionManager.getAdapterFor` already handles bigquery password-less admission
   (connectionManager.ts:417-421) — tree expansion of a NON-active bigquery connection works
   through the existing passive-adapter cache. Nothing in this task touches
   `connectionManager.ts`.
3. The row-count suppression is deliberately a DRIVER check, not a capability check: 
   `estimateTableRowsBatch` is implemented on `BigQueryAdapter` (TASK-BQ02-001) but costs a
   `tables.get` metadata round trip per table. DataGrip-style counts are nice-to-have; cost
   safety wins for MVP. If BQ-05+ adds free-count metadata, revisit with a capability
   declaration. Test #5's differential (postgres fires / bigquery doesn't) is the pin that
   survives both.
4. Icon id: `"cloud"` exists in the vscode codicon set (`cloud`, `cloud-upload`, …). If
   typecheck rejects the string in your environment, use `"azure"`'s neighbor `"server"` as
   fallback and PIN the chosen id in test #2 — the test must fail if the icon mapping is
   removed.
5. Harness: the existing fake-adapter helper in `schemaTree.test.ts` returns
   `estimateTableRowsBatch: () => Map()` — wrap it in `vi.fn()` (if not already) so test #5 can
   count calls without changing the postgres assertions.
6. RED-first: tests #2, #3, #5 fail at base (tooltip format renders `bigquery@:0/`, no icon
   entry, batch fires for any driver with tables). Write them first.

## Executor Report

(pending)

---

## Reviewer Verdict

(pending)
