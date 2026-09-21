# TASK-DBX08-002 — Gate catalog navigation and object DDL by declaration

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX08.md` §1–§3

## Goal

Make catalog tree/cache/resolver behavior and virtual-object DDL retrieval depend on the explicit DBX-08 declaration rather than PostgreSQL driver identity or optional-object presence. Preserve all existing generic metadata navigation and PostgreSQL catalog behavior.

## Target Files

- `src/ui/schemaCache.ts` — make `hasCatalog`, catalog list methods, and object-DDL cache admission use the declared capabilities before an optional catalog API call.
- `src/ui/schemaTree.ts` — make catalog categories/exact row-count selection depend on declared catalog support while retaining column and estimate-batch fallback.
- `src/ui/sqlCatalog.ts` — replace `CatalogResolverOptions.isPostgres` with a declared-capability predicate and preserve empty/undefined short-circuits.
- `src/ui/ddlView.ts` — gate `CatalogApi.objectDdl` by declared `objectDdl`, with an accurate unsupported-capability document and defensive missing-API result.
- `src/ui/__tests__/schemaCache.test.ts` — cover cache capability admission and no catalog API calls when unsupported.
- `src/ui/__tests__/schemaTreeCatalog.test.ts` — cover declared supported catalog categories and the generic non-catalog fallback.
- `src/ui/__tests__/sqlCatalog.test.ts` — cover resolver declarations, no cache catalog calls when false/missing, and the existing PostgreSQL result contract.
- `src/ui/__tests__/ddlView.test.ts` — cover supported retrieval, unsupported document/no retrieval side effect, and missing-api defense.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `declared PostgreSQL catalog support preserves tree rows and resolver results` | A true `catalog` declaration plus real-shaped `CatalogApi` yields existing Indexes/Constraints/Triggers/Sequences, exact catalog row-count path, requested FK rows, and `getDefinition` output. | Existing schema-tree and resolver fixtures amended with explicit capabilities. |
| 2 | edge — missing/false declaration | `catalog consumers fail closed without catalog/cache calls` | An adapter/cache with false or absent declaration yields no catalog categories, resolver `[]`/`undefined`, and zero `listIndexes`, `listConstraints`, `listTriggers`, `listSequences`, `rowCount`, `getConstraints`, `getSequences`, or `getObjectDdl` calls. | MySQL/MSSQL-shaped adapter; also a structural catalog object with missing declaration. |
| 3 | edge — fallback behavior | `generic navigation and estimate batching remain available without catalog` | A false catalog declaration still renders Tables/Views/Routines/Columns and calls `estimateTableRowsBatch(schema, tables)` for table descriptions; it never attempts exact `catalog.rowCount`. | Existing mysql-style schema tree fixture with row estimates. |
| 4 | edge — malformed declaration/API mismatch | `Open DDL reports unsupported object DDL without throwing` | A false/missing `objectDdl` declaration, or a true declaration with no callable `catalog.objectDdl`, caches a stable document explaining that object DDL is unsupported/unavailable and invokes no DDL method. | DDL-view node with an adapter fixture per mismatch case. |
| 5 | regression | `catalog stale/error handling remains green` | Existing cache stale result, resolver stale definition, and catalog row-count rejection tests keep their current fallbacks. | Existing focused test fixtures. |

## Test Files

- `src/ui/__tests__/schemaCache.test.ts` — mapped test for `src/ui/schemaCache.ts`.
- `src/ui/__tests__/schemaTreeCatalog.test.ts` — mapped test for `src/ui/schemaTree.ts`.
- `src/ui/__tests__/sqlCatalog.test.ts` — mapped test for `src/ui/sqlCatalog.ts`.
- `src/ui/__tests__/ddlView.test.ts` — mapped test for `src/ui/ddlView.ts`.

## Verification Commands

```bash
npm test -- src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/sqlCatalog.test.ts src/ui/__tests__/ddlView.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] Catalog and object-DDL admission uses `hasAdapterCapability`, never `driver === "postgres"` or optional API presence alone.
- [ ] False/missing declarations make no catalog/cache retrieval call and preserve generic navigation plus estimate fallback.
- [ ] `DdlViewProviderImpl` calls `catalog.objectDdl(kind, name, schema)` only when the adapter declares `objectDdl` and exposes a callable implementation; unsupported documents are accurate and stable.
- [ ] The existing PostgreSQL catalog/tree/resolver results and stale/error fallback behavior remain green.
- [ ] The test cases and verification commands pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DBX08-001

## Interfaces

- Consumes: `hasAdapterCapability(adapter, "catalog" | "objectDdl"): boolean` and `DbAdapter.capabilities?: AdapterCapabilities` from TASK-DBX08-001; `CatalogApi.objectDdl(kind: "view" | "routine" | "trigger", name: string, schema?: string): Promise<string>`; `SchemaCache.getConstraints(schema: string, table: string): Promise<TableConstraintInfo[]>`, `SchemaCache.getSequences(schema: string): Promise<SequenceInfo[]>`, and `SchemaCache.getObjectDdl(kind: "view" | "routine", schema: string, name: string): Promise<string | undefined>`.
- Produces: a capability-driven `CatalogResolverOptions` predicate consumed in `src/extension.ts` by a later integration task outside this file set; capability-driven catalog/cache/tree/DDL behavior with the existing public `CatalogResolver` and `DdlViewProvider` signatures unchanged.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Use the explicit declaration as the authorization decision and the optional `catalog` object only as a defensive execution check. Do not delete the generic `listViews`, `listRoutines`, `listColumns`, or `estimateTableRowsBatch` paths: MySQL/MSSQL implement them and their current navigation must remain useful.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:

```
# npx vitest run (4 focused files) against pre-task implementation:
 Test Files  4 failed (4)
      Tests  13 failed | 26 passed (39)

schemaCache.test.ts (2 failed):
  FAIL ... > false/absent declaration admits nothing and makes no catalog calls
    AssertionError: expected true to be false // Object.is equality
    (hasCatalog() returned true for a structural catalog object with no/false declaration)
  FAIL ... > objectDdl declaration false skips catalog.objectDdl even when catalog is declared
    AssertionError: expected 'CREATE OBJECT ...' to be undefined
    (getObjectDdl ran catalog.objectDdl with objectDdl declared false)

schemaTreeCatalog.test.ts (1 failed):
  FAIL ... > catalog consumers fail closed without catalog calls (false/missing declaration)
    AssertionError: expected "spy" to not be called at all, but actually been called 1 times
    1st spy call: Array ["public", "users"]
    (getCategoriesForSchema/getTableChildren probed catalog.listSequences/listIndexes
     despite capabilities.catalog === false / absent)

sqlCatalog.test.ts (6 failed — all tests):
  TypeError: options.isPostgres is not a function
  (resolver option renamed to declaresCatalog in tests; production still required isPostgres)

ddlView.test.ts (4 failed):
  FAIL Test #9 — objectDdl not declared → ...
    AssertionError: expected 'Postgres-only feature\n\n"Open DDL" r…' to contain 'object DDL'
  FAIL false declaration →
    AssertionError: expected 'create view v_mysql;' to contain 'object ddl'
    (openDdl RETRIEVED DDL with objectDdl declared false)
  FAIL missing declaration →
    AssertionError: expected 'CREATE VIEW v AS SELECT 1;' to contain 'object DDL'
    (legacy adapter with structural catalog but no capabilities retrieved DDL)
  FAIL declared objectDdl with missing callable API →
    AssertionError: expected '-- UnicDB-ddl: failed to load ddl\n-- c…' to contain 'unavailable'
    (defensive path routed into the generic catalog error document instead of an
     accurate unavailable document)
```

Verification Output:

```
# 1. npx vitest run src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/sqlCatalog.test.ts src/ui/__tests__/ddlView.test.ts
 ✓ src/ui/__tests__/sqlCatalog.test.ts  (6 tests) 4ms
 ✓ src/ui/__tests__/ddlView.test.ts  (9 tests) 3ms
 ✓ src/ui/__tests__/schemaCache.test.ts  (14 tests) 7ms
 ✓ src/ui/__tests__/schemaTreeCatalog.test.ts  (10 tests) 18ms
 Test Files  4 passed (4)
      Tests  39 passed (39)
 Start at  03:56:35    Duration  319ms

# 2. npm run typecheck
 > UnicDB@1.28.0 typecheck
 > tsc --noEmit
 (exit 0, no output)

# 3. npm run compile
 ⚡ Done in 142ms
 esbuild: build complete

# 4. npx vitest run src/adapters/__tests__/capabilities.test.ts  (regression net)
 ✓ src/adapters/__tests__/capabilities.test.ts  (3 tests) 1ms
 Test Files  1 passed (1)
      Tests  3 passed (3)

# 5. Wider regression net (beyond required minimum):
 npx vitest run src/ui/__tests__/sqlCompletionProvider.test.ts src/ui/__tests__/sqlNavigationProvider.test.ts src/ui/__tests__/schemaTree.test.ts src/extension.test.ts
 ✓ 4 files, 152 passed (152)

 npm test  (full suite)
 Test Files  213 passed | 1 skipped (214)
      Tests  2793 passed | 2 skipped (2795)
 (skip count is pre-existing on main)
```

Status: PASS

Note:
- Implementation: schemaCache gates `hasCatalog`/`getConstraints`/`getSequences` on declared `catalog` and `getObjectDdl` on declared `objectDdl` (with defensive missing-API fallback), never `adapter.catalog !== undefined`. schemaTree gates the Sequences category, table catalog categories, all four leaf loaders, and the exact `catalog.rowCount` path on `hasAdapterCapability(adapter, "catalog")`; MySQL/MSSQL keep Tables/Views/Routines/Columns and `estimateTableRowsBatch`. ddlView's `resolveDdl` admits `catalog.objectDdl(kind, name, schema)` only on declared `objectDdl`; false/missing → stable "Object DDL is not supported by this connection's database" document; declared-but-missing API → "Object DDL is unavailable" document. sqlCatalog option renamed `isPostgres` → `declaresCatalog: () => boolean | Promise<boolean>` (awaited); both extension.ts call sites now resolve the active adapter and use `hasAdapterCapability(..., "catalog")` — that is the only extension.ts change (plus the one-line import).
- `sqlNavigationProvider.test.ts` was minimally amended (resolver option key in its fixture) because it constructs a real `createCatalogResolver` and would otherwise throw TypeError; it is not in the task's four mapped test files.
- No `lint` script exists in package.json (per task/plan); typecheck+compile cover static checks.
- Full-suite skip (1 file / 2 tests) is pre-existing on main @ b174ec9, not introduced here.
- No git add/commit/push performed; files left in the worktree.


---

## Review — Round 1

REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERDICT: CHANGES-REQUESTED

FINDINGS:
- important — `src/ui/sqlCatalog.ts:121` — `declaresCatalog` is explicitly allowed to return a `Promise<boolean>`, but a rejected predicate escapes each resolver method instead of failing closed. `SqlNavigationProvider` awaits `listRootRows()` without a catch (`src/ui/sqlNavigationProvider.ts:256`), so a rejected async predicate rejects the hover/definition request rather than returning the contract's `[]`/`undefined`; the extension wiring catches its own predicate today, but the exported resolver accepts any caller and is not safe by contract.

REQUIRED FIXES:
- Add one fail-closed predicate helper in `src/ui/sqlCatalog.ts` that catches a rejected `declaresCatalog()` and returns `false`; use it for all three resolver methods. Add a focused rejected-async-predicate test proving `listRootRows()`/`listForeignKeys()` return `[]`, `getDefinition()` returns `undefined`, and neither `cache.hasCatalog()` nor any cache catalog method is called.

VERIFICATION:
- `npx vitest run src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/sqlCatalog.test.ts src/ui/__tests__/ddlView.test.ts src/ui/__tests__/sqlNavigationProvider.test.ts` — PASS (5 files, 42 tests).
- `npm run typecheck` — PASS (exit 0).

NOTES: Capability admission is otherwise declaration-driven at every inspected catalog/object-DDL seam; MySQL/MSSQL generic navigation and estimate batching remain intact. The extension predicates catch their own adapter-resolution errors and the two lookups resolve the manager independently but do not duplicate a connection once it is cached.

## Fix — Round 1 (orchestrator, findings applied)

FIXER_MODEL: unic-code
- `src/ui/sqlCatalog.ts` — added fail-closed `admitted(options)` helper wrapping the awaited `declaresCatalog()` predicate (catch → false); all three resolver methods (`listRootRows`, `listForeignKeys`, `getDefinition`) now gate through it, so a rejected async predicate yields the contract's `[]`/`undefined` instead of escaping to `SqlNavigationProvider` callers.
- `src/ui/__tests__/sqlCatalog.test.ts` — new test `rejected async declaresCatalog predicate fails closed (review round 1)`: all three methods return empty/undefined AND zero cache calls (`hasCatalog` + every catalog method).
- Verification: focused sqlCatalog 7/7 GREEN; full DBX-08 net 204/204 across 11 files; typecheck + compile clean.
