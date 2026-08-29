# TASK-DBX02-001 — Cached catalog rows and vscode-free resolver

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX02.md` §3

## Goal

Write RED tests first, then extend the established cache and add a vscode-free catalog resolver. It must return typed rows for a requested table's foreign keys, view definitions, routine bodies, and sequences through PostgreSQL's existing adapter contracts, with TTL/stale-on-error behavior and no eager table-wide constraint scan.

## Target Files

- `src/ui/schemaCache.ts` — cache `listViews`, `listRoutines`, table-scoped `catalog.listConstraints`, `catalog.listSequences`, and object-scoped `catalog.objectDdl` consistently with existing `getTables`/`getColumns`.
- `src/ui/sqlCatalog.ts` **(new)** — vscode-free discriminated catalog-row types and resolver/loader only; no adapter calls outside `SchemaCache`.
- `src/ui/__tests__/schemaCache.test.ts` — extend cache tests using typed fake catalog capabilities.
- `src/ui/__tests__/sqlCatalog.test.ts` **(new)** — pure resolver contract tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | RED→GREEN unit | loads requested FK, view definition, routine body, and sequence rows | `CatalogRow[]` has exact kind/schema/name/columns/body fixture values | `public.orders.user_id → public.users.id`, view/routine DDL, one sequence |
| 2 | edge—PostgreSQL capability gate | `isPostgres()` is false or `adapter.catalog` is undefined | every DBX-02 catalog resolver method returns `[]`/`undefined`, including views/routines, and calls no catalog method | MySQL/MSSQL-like active driver; PostgreSQL-like adapter with no `catalog` |
| 3 | edge—stale refresh | expired cached DDL/constraints refresh rejects | returns the original cached value/reference after the rejected refresh | `ttlMs: 0`, first success then rejection |
| 4 | edge—lazy scope | resolving `public.orders` while `public.audit_log` is known | calls constraints only for `orders`, never for `audit_log` | per-table catalog spies and two listed tables |

## Test Files

- `src/ui/__tests__/schemaCache.test.ts` — cache TTL, invalidation, absent-capability, and stale fallback coverage.
- `src/ui/__tests__/sqlCatalog.test.ts` **(new)** — pure catalog-row projection and lazy table-scope coverage.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/sqlCatalog.test.ts
npm run typecheck
npm run compile
```

`package.json` has no lint script. The existing cache test is selected by `.cache/index/tests-map.json`; the new resolver test is the explicit non-empty selection for the new source file.

## Acceptance Criteria

- [ ] RED output is recorded before implementation; both test files are green afterward.
- [ ] Catalog resolver imports no `vscode` module and uses no `as any`/`: any`.
- [ ] `SchemaCache.invalidate()` clears every new entry; unavailable/failed catalog access follows its established stale-or-empty contract.
- [ ] `CatalogResolver` returns no DBX-02 catalog rows unless `isPostgres()` is true **and** the resolved adapter exposes `catalog`; existing non-catalog completion remains outside this resolver.
- [ ] Rows include requested-table FK target columns, view/routine DDL text, and sequence metadata without inventing a new `DbAdapter` API.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: existing `DbAdapter.listViews(schema?: string): Promise<ViewInfo[]>`; `DbAdapter.listRoutines(schema?: string): Promise<RoutineInfo[]>`; `CatalogApi.listConstraints(schema: string, table: string): Promise<TableConstraintInfo[]>`; `CatalogApi.listSequences(schema: string): Promise<SequenceInfo[]>`; `CatalogApi.objectDdl(kind: "view" | "routine" | "trigger", name: string, schema?: string): Promise<string>` from `src/adapters/types.ts`.
- Produces: additive `SchemaCache` methods `hasCatalog(): Promise<boolean>`, `getViews(schema?: string): Promise<ViewInfo[]>`, `getRoutines(schema?: string): Promise<RoutineInfo[]>`, `getConstraints(schema: string, table: string): Promise<TableConstraintInfo[]>`, `getSequences(schema: string): Promise<SequenceInfo[]>`, and `getObjectDdl(kind: "view" | "routine", schema: string, name: string): Promise<string | undefined>`.
- Produces: exact vscode-free row types from `src/ui/sqlCatalog.ts`: `interface CatalogViewRow { readonly kind: "view"; readonly schema: string; readonly name: string }`; `interface CatalogRoutineRow { readonly kind: "routine"; readonly schema: string; readonly name: string; readonly routineKind: "function" | "procedure" }`; `interface CatalogSequenceRow { readonly kind: "sequence"; readonly schema: string; readonly name: string; readonly dataType: string; readonly lastValue?: string }`; `interface CatalogForeignKeyRow { readonly kind: "foreignKey"; readonly schema: string; readonly table: string; readonly name: string; readonly columns: readonly string[]; readonly target: { readonly schema?: string; readonly table: string; readonly columns: readonly string[] } }`; and `type CatalogRootRow = CatalogViewRow | CatalogRoutineRow | CatalogSequenceRow`.
- Produces: `CatalogResolver` and `createCatalogResolver(cache: SchemaCache, options: { isPostgres: () => boolean }): CatalogResolver` from `src/ui/sqlCatalog.ts`. `CatalogResolver` has exact methods: `listRootRows(): Promise<readonly CatalogRootRow[]>`; `listForeignKeys(schema: string, table: string): Promise<readonly CatalogForeignKeyRow[]>`; `getDefinition(kind: "view" | "routine", schema: string, name: string): Promise<string | undefined>`. Each returns no catalog data unless `options.isPostgres()` and `cache.hasCatalog()` are true. `listForeignKeys` is table-scoped and is the sole FK input for TASK-DBX02-002/003/004.

---

## Discussion

### 2026-08-30 · planner · unic/unic-smart
`src/core/schemaIntrospect.ts` does not exist. The verified PostgreSQL catalog source is `src/core/ddl/pgCatalog.ts`; do not add a parallel introspector or modify `DbAdapter`.

---
