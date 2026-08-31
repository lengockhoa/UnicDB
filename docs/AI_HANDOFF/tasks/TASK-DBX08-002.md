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
