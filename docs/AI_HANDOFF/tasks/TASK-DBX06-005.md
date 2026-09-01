# TASK-DBX06-005 — Expanded PostgreSQL rename catalog and typed plan

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX06.md` §3

## Goal

Extend the existing pure rename analysis/catalog and PostgreSQL adapter seam so table and column rename previews report trigger/index usage in addition to current view/FK/routine/collision data. Add an additive typed, ordered rename-step list that preserves the current single-rename SQL while allowing a reviewed multi-rename plan.

## Target Files

- `src/core/ddl/renameAnalysis.ts` — extend rename catalog/report types and usage aggregation for typed trigger and index rows.
- `src/core/ddl/renameCatalog.ts` — add bound trigger/index SQL templates and `RenamePlan.steps` generation while preserving the existing `statements` surface.
- `src/adapters/types.ts` — extend `RenameUsageApi` with typed trigger/index lookup signatures.
- `src/adapters/postgres.ts` — implement the two lookup methods through `this.query<T>(sql, params)` and map database row names to the public camel-case types.
- `src/core/ddl/__tests__/renameAnalysis.test.ts` — extend pure usage-report assertions.
- `src/core/ddl/__tests__/renameCatalog.test.ts` — pin SQL parameterization and typed step/statement behavior.
- `src/adapters/__tests__/postgresCatalog.test.ts` — extend the existing `pg` mock style with `PostgresAdapter.renameUsage` parameter-array and mapped-record assertions.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy / pure | expanded table rename plan renders one executable step | `buildRenamePlan({ kind: "table", schema: "public", table: "users", oldName: "users", newName: "customers", ... })` returns the exact `ALTER TABLE "public"."users" RENAME TO "customers";`; exactly one `steps` item is executable with kind `rename`, and populated trigger/index/view/FK/routine records each produce a non-executable review step. | Valid catalog rows containing one record of each dependency type and no collision. |
| 2 | happy / adapter | trigger/index APIs always bind three values and map rows | Table-mode `renameUsage.triggers("public", "users", "")` and `.indexes("public", "users", "")` call the mocked pool with the template plus exactly `['public', 'users', '']`; column mode uses exactly `['public', 'users', 'full_name']`; both map snake-case fixture fields to `{ name, event, timing }` / `{ name, isPrimary, isUnique, columns }`. | Connected mocked `PostgresAdapter`; queue probe then trigger/index query rows. |
| 3 | edge / membership | column trigger/index inclusion follows pinned catalog fields | Both templates include `$1`, `$2`, `$3`; the trigger template includes `tgattr` and `pg_get_expr(t.tgqual, t.tgrelid)`, while the index template includes `indkey`, `pg_get_expr(i.indexprs, i.indrelid)`, and `pg_get_expr(i.indpred, i.indrelid)`, each using `\m`/`\M` word boundaries around `$3`; neither template references `pg_proc`, `prosrc`, or `pg_get_functiondef`. | Direct-column, expression, predicate, and function-body-only fixtures for `full_name`. |
| 4 | edge / collision | collision blocks every plan step and statement | A collision of `customers (table)` returns `steps: []`, `statements: []`, and the exact error `Name collision — target already exists: customers (table).`. | Valid table request, `collisions: ['customers (table)']`. |
| 5 | regression / ordered partial plan | dependent rename operations preserve order | A request with ordered operations table `users` → `customers`, then column `customers.name` → `full_name`, returns exactly two executable `steps` and exactly the corresponding two ordered `statements`; review steps do not enter `statements`. | Collision-free catalog fixture and two valid dependent operations. |

## Test Files

- `src/core/ddl/__tests__/renameAnalysis.test.ts` — expanded usage report fixture/assertions.
- `src/core/ddl/__tests__/renameCatalog.test.ts` — catalog SQL, collision, step, and quoted SQL contracts.
- `src/adapters/__tests__/postgresCatalog.test.ts` — PostgreSQL adapter parameter/mapping contract, using the existing `pg` mock queue.

## Verification Commands

```bash
npx vitest run src/core/ddl/__tests__/renameAnalysis.test.ts src/core/ddl/__tests__/renameCatalog.test.ts src/adapters/__tests__/postgresCatalog.test.ts
npm run typecheck
npm run compile
```

`package.json` has no lint script. `npm run typecheck` is the required static check.

## Acceptance Criteria

- [ ] `RenameCatalogRows` and `RenameReport` represent typed trigger/index records and usage aggregation includes them in the reviewable report/count.
- [ ] Trigger/index catalog SQL is pure, uses only `$n` target parameters, and never interpolates schema/table/column values into a filter; both methods always bind `[schema, table, column]`, with `column === ""` in table mode.
- [ ] Column lookup includes trigger `tgattr` direct references and `tgqual` predicate word-boundary references, plus index `indkey` direct references, `indexprs` expression references, and `indpred` predicate references; it excludes all trigger-function/function-body source.
- [ ] `RenameUsageApi` exposes `triggers(schema, table, column: string)` and `indexes(schema, table, column: string)`; `PostgresAdapter.renameUsage` maps both through its bound query pathway.
- [ ] `RenamePlan.steps` is additive and ordered: one or more executable rename steps correspond to declared operations, review steps are non-executable, and `statements` retains exactly the executable SQL in that order.
- [ ] Collision and same-name conditions retain zero executable SQL and the pinned collision diagnostic.
- [ ] All listed focused tests, `npm run typecheck`, and `npm run compile` pass.

## Dependencies

- none

## Interfaces

- Consumes: `export function buildRenamePlan(req: RenamePlanRequest): RenamePlan`; `export function analyzeUsage(rows: RenameCatalogRows): RenameUsageSummary`; `export function quoteIdent(name: string): string`; `export function hasAdapterCapability(adapter: Pick<DbAdapter, "capabilities"> | null | undefined, capability: AdapterCapability): boolean`; `PostgresAdapter` private query signature `private async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }>`.
- Produces: `RenameCatalogRows` / `RenameReport` including `triggers: Array<{ name: string; event: string; timing: string }>` and `indexes: Array<{ name: string; isPrimary: boolean; isUnique: boolean; columns: string[] }>`; `RenameOperation { kind: RenameKind; schema: string; table: string; oldName: string; newName: string }`; `RenamePlanRequest.operations?: RenameOperation[]`; ordered `RenamePlan.steps: RenamePlanStep[]` and `statements: string[]` containing exactly the executable step SQL in order; `RenameUsageApi.triggers(schema: string, table: string, column: string): Promise<Array<{ name: string; event: string; timing: string }>>`; `RenameUsageApi.indexes(schema: string, table: string, column: string): Promise<Array<{ name: string; isPrimary: boolean; isUnique: boolean; columns: string[] }>>`; pure `TRIGGERS_SQL(): string` and `INDEXES_SQL(): string` exports for TASK-DBX06-006. Their pinned bind contract is exactly `$1 = schema`, `$2 = table`, `$3 = column || ""`; both APIs call `this.query<T>(SQL, [schema, table, column])`, never a two-value array. `TRIGGERS_SQL` filters `n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal AND ($3 = '' OR EXISTS (SELECT 1 FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum WHERE a.attname = $3) OR COALESCE(pg_catalog.pg_get_expr(t.tgqual, t.tgrelid), '') ~* ('\m' || $3 || '\M'))`; `INDEXES_SQL` filters `n.nspname = $1 AND tbl.relname = $2 AND ($3 = '' OR EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum WHERE k.attnum > 0 AND a.attname = $3) OR COALESCE(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '') ~* ('\m' || $3 || '\M') OR COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '') ~* ('\m' || $3 || '\M'))`.

---

## Discussion

### 2026-09-01 · planner · unic-smart
The original DBX-06 flow is already shipped and approved. This task is intentionally additive: retain `statements: string[]` as the executable compatibility surface and publish review steps separately. `operations` is optional so the original one-operation request stays byte-for-byte compatible; when provided, it allows multiple dependent rename operations and `statements` follows their order. Both new lookup APIs require a string third argument: table mode passes `""`, column mode passes the current column name. For column analysis, direct trigger/index keys plus trigger predicates, index expressions, and partial-index predicates are included by word-boundary matching; function bodies are deliberately excluded. Do not modify the historical TASK-DBX06-001–004 handoff files. Trigger/index dependency reporting is advisory; no automatic dependent-object rewrite is authorized.

---

## Executor Report

<!-- Executor appends RED→GREEN evidence, changed files, verification output, and deviations here. -->
