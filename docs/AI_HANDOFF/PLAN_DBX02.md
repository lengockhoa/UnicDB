# PLAN_DBX02 — SQL Intelligence Navigation

## §1 Intent

DBX-02 adds PostgreSQL catalog-backed SQL navigation without replacing the existing completion architecture or introducing a language server. Success means that, with an active PostgreSQL connection, a SQL editor can complete views/routines/sequences and FK targets; hover a table, column, FK target, view, routine, or sequence for cached catalog documentation; open the definition represented by that catalog object; and find parsed SQL references without treating comments or literals as usages.

The source of truth already exists: `src/ui/schemaCache.ts` caches schemas/tables/columns with a 60-second TTL and stale-on-error semantics; `src/ui/sqlCompletionProvider.ts` consumes it; `src/adapters/types.ts` defines `DbAdapter.listViews`, `listRoutines`, and optional `catalog`; and `src/core/ddl/pgCatalog.ts` provides FK constraints, sequences, and `objectDdl()` for views/routines. `src/extension.ts` creates one `SchemaCache`, invalidates it through `ConnectionManager.onDidChangeActive`, and registers the existing completion provider.

## §2 Scope

**In scope**
- PostgreSQL-only catalog rows for a requested table's foreign keys, plus view definitions, routine bodies, and sequences, read through `SchemaCache` and represented by a vscode-free module.
- Extend the existing `SqlCompletionProvider` for views, routines, sequences, and FK-annotated column completions.
- Add one SQL hover/definition provider that resolves table ↔ column ↔ FK-target catalog identities.
- Add a `ReferenceProvider` that derives usages from parsed PostgreSQL SQL statements and never counts identifiers in strings/comments/dollar quotes.
- Additive extension registration using the existing active-connection guard and the single `SchemaCache` instance; a focused activation scaffold test.

**Out of scope for this cycle**
- MySQL/MariaDB/SQL Server catalog navigation, cross-file workspace indexing, edits/renames/code actions, a language-server replacement, unbounded background catalog scans, and new caller-side controllers/debounces.

**Wave collision constraint:** tasks in one wave own disjoint files. The only shared runtime file, `src/extension.ts`, is exclusively owned by TASK-DBX02-005 after all provider tasks finish.

## §3 Approach

1. **Cache first, pure catalog projection second.** TASK-001 extends `SchemaCache` with TTL/stale-safe cached reads for the existing adapter surfaces (`listViews`, `listRoutines`, `catalog.listConstraints`, `catalog.listSequences`, `catalog.objectDdl`) plus a capability probe. `createCatalogResolver(cache, { isPostgres })` is the PostgreSQL gate: if the active driver is not PostgreSQL or the resolved adapter lacks `catalog`, every DBX-02 catalog method returns no rows/definition (even if a non-Postgres adapter exposes views/routines). New `src/ui/sqlCatalog.ts` remains vscode-free and exports a discriminated `CatalogRow` union plus this resolver. FK rows are lazy and table-scoped: a request for `public.orders` calls `catalog.listConstraints("public", "orders")` at most once per cache TTL; it never enumerates constraints for unrelated tables. View/routine DDL is likewise loaded only for the selected catalog object. No provider calls the adapter directly.
2. **Reuse the established provider seam.** TASK-002 changes only `SqlCompletionProvider`; it keeps the existing `hasConnection` early return and never-crash catch. In the existing `<table>.` context, an FK column remains a `Property` completion with `label`/`insertText` equal to the local column (for example `user_id`) and `detail` exactly `integer · FK → public.users.id`; resolving `orders.` therefore fetches only `orders` constraints. Views/routines/sequences use catalog kinds and their schema/type detail. No completion inserts an invalid relationship path.
3. **One navigation provider plus registered catalog document store.** TASK-003 adds `SqlNavigationProvider` implementing `vscode.HoverProvider` and `vscode.DefinitionProvider`, and a `SqlCatalogDocumentProvider implements vscode.TextDocumentContentProvider`. Navigation writes a typed metadata document for table/column/FK targets (the adapter has no table-DDL contract) and uses lazy `CatalogResolver.getDefinition` text only for views/routines. TASK-005 registers the document provider under `UnicDB-sql-catalog`; definition/hover lookup is case-insensitive for unquoted identifiers and exact for quoted identifiers.
4. **Parse before references.** TASK-004 extends the existing pure `src/core/statementParser.ts` rather than regex-searching documents. `extractIdentifierReferences(sql, "postgres")` respects the parser's string, quoted identifier, dollar-quote, and comment rules; `SqlReferenceProvider` resolves those spans against catalog identity and returns only matching `vscode.Location`s.
5. **Wire once in activation.** TASK-005 registers completion, hover, definition, and reference providers from the existing `schemaCache`/`mgr` lifetime block in `activate()`. The existing connection-change listener remains the sole invalidation mechanism; callers add neither a cache nor debounce/controller.

**Trade-offs and decisions**
- Use catalog virtual documents for go-to-definition: PostgreSQL catalogs provide definitions, not workspace file locations. This gives a stable, navigable target without inventing filesystem mappings.
- Keep DDL and FK loading lazy and cache it: eagerly fetching every view/routine body or every table's constraints is avoidable work on large databases.
- Do not modify `DbAdapter`: all required PostgreSQL capability is already exposed by `DbAdapter.listViews`, `listRoutines`, and optional `CatalogApi` in `src/adapters/types.ts`; the resolver explicitly rejects absent catalog capability instead of leaking cross-dialect rows.

## §4 Test Plan

All tests are Vitest and use RED first, then the minimal GREEN implementation. No real PostgreSQL instance is required: adapter/catalog capabilities are mocked exactly as in `src/ui/__tests__/schemaTreeCatalog.test.ts`.

| Type | Test Name | Expected |
|---|---|---|
| unit | Catalog resolver assembles requested FK, view-DDL, routine-body, and sequence rows | Discriminated rows preserve schema/name/columns/body and omit no valid fixture row |
| edge—PostgreSQL gate | Active driver is non-PostgreSQL or resolved adapter has no `catalog` | Every catalog resolver method returns `[]`/`undefined`, including views/routines; existing table completion is unchanged |
| edge—stale failure | Expired cache refresh rejects after a successful catalog read | Returns the prior cached row reference, matching current `SchemaCache` semantics |
| edge—lazy scope | Resolving `public.orders` with unrelated `public.audit_log` in the table list | Calls `listConstraints("public", "orders")` only; never calls constraints for `audit_log` |
| unit | Completion exposes a view/routine/sequence and FK column | Root items have expected label/detail/kind; in `orders.` the `user_id` item has `insertText: "user_id"` and detail `integer · FK → public.users.id` |
| edge—prefix | Prefix does not match a catalog object | That object is absent while existing keyword/table behavior remains |
| edge—no connection | `hasConnection()` is false | Provider returns `[]` and calls no catalog method |
| unit | Hover and definition resolve table column and FK target | Hover includes concrete type/target; definition points at `UnicDB-sql-catalog:` whose registered provider returns typed table/column/FK metadata |
| unit | Hover and definition resolve view/routine/sequence | View/routine document returns cached DDL; sequence document returns typed sequence metadata |
| unit | Parsed find-usages returns only SQL identifier spans | Locations cover matching table/column/FK target references across statements |
| edge—comments/literals | Same identifier occurs in line/block comments, strings, and dollar quotes | No location is returned for non-code spans |
| edge—cancellation/absence | Cancellation requested or catalog identity unresolved | Provider returns `[]` without scanning further/throwing |
| integration-style smoke | Activation registers language and catalog-document providers once | SQL/file providers and one `UnicDB-sql-catalog` text-document provider are registered; navigation-populated URI content is retrievable; absent APIs remain safe no-ops |

## §5 Verification

The project defines `test`, `typecheck`, and `compile` in `package.json`; it has no `lint` script. Executors run these scoped commands per task before review:

```bash
npx vitest run src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/sqlCatalog.test.ts
npx vitest run src/ui/__tests__/sqlCompletionProvider.test.ts
npx vitest run src/ui/__tests__/sqlNavigationProvider.test.ts
npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/sqlReferenceProvider.test.ts
npx vitest run src/extension.test.ts
npm run typecheck
npm run compile
```

At each wave boundary, the executor/reviewer additionally runs `npm test` as the regression net. New provider files have no historical entry in `.cache/index/tests-map.json`; their explicit neighboring test files above are the non-empty narrowed selection. `yarn test:release-core` is unavailable because this repository has neither Yarn scripts nor that command.

## §6 Acceptance

- [ ] TASK-DBX02-001 provides vscode-free, cached catalog rows for FKs, view definitions, routine bodies, and sequences through the existing PostgreSQL adapter contracts.
- [ ] TASK-DBX02-002 preserves current completion behavior and adds catalog/FK completion with no active-connection query.
- [ ] TASK-DBX02-003 provides PostgreSQL catalog hover and virtual-document definition for table/column/FK-target relationships.
- [ ] TASK-DBX02-004 returns parsed SQL usages only, excluding comments/literals/dollar quotes.
- [ ] TASK-DBX02-005 wires all language providers plus the `UnicDB-sql-catalog` text-document provider to the one activation cache and proves registrations/content retrieval in `src/extension.test.ts`.
- [ ] Targeted Vitest tests, `npm run typecheck`, `npm run compile`, and wave-boundary `npm test` pass.
- [ ] No `as any` or `: any`; no language-server replacement; no new dependency; PostgreSQL capability is explicitly gated.

Traceability: acceptance 1→TASK-001; 2→TASK-002; 3→TASK-003; 4→TASK-004; 5→TASK-005; 6–7→all tasks.

## §7 Global Constraints

- VS Code engine floor remains `^1.75.0` from `package.json`; use only APIs available at that floor.
- PostgreSQL only: `createCatalogResolver` MUST return no DBX-02 catalog rows/definitions unless active `ConnectionConfig.driver === "postgres"` and optional `DbAdapter.catalog` is present; never add fallback adapter implementations in this cycle.
- Use domain types/`unknown`, never `as any` or `: any`; discriminated catalog rows are the cross-provider contract.
- Navigation reads must be bounded by cache TTL and requested identity: never enumerate table constraints or object DDL for unrelated catalog objects, and add no caller debounce/controller state.
- Preserve current completion never-crash/no-active-connection behavior and parameterized catalog access owned by existing adapter code.

## §8 Execution Queue

| Wave | Tasks | Reviewer | File ownership |
|---|---|---|---|
| 1 | TASK-DBX02-001 | independent `unic-smart` reviewer | `schemaCache.ts`, new `sqlCatalog.ts`, their tests |
| 2 | TASK-DBX02-002, TASK-DBX02-003, TASK-DBX02-004 | independent `unic-smart` reviewer per task | completion; new navigation; parser/reference files respectively |
| 3 | TASK-DBX02-005 | independent `unic-smart` reviewer | activation + activation test only |

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: replaced the non-existent `src/core/schemaIntrospect.ts` with the verified PostgreSQL catalog surface in `src/core/ddl/pgCatalog.ts`; used only defined npm scripts; separated extension ownership into its own final wave.
Known gaps: Provider source/test files for navigation and references are deliberately new, so `.cache/index/tests-map.json` cannot map them yet; each task names its concrete new test file and retains the applicable existing mapped test.
