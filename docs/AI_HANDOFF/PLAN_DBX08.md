# PLAN_DBX08 — Dialect Parity Contract

Cycle: DBX-08 (Wave 6) · Base: main @ f5f3d45 · Release baseline: v1.28.0  
Reviewer: `unic-smart` — MUST differ from executor `unic-code`

## §1 Intent

Make adapter support explicit, testable, and authoritative for catalog, DDL, navigation, and admin entry points. PostgreSQL must retain every currently proven catalog/admin/table-DDL behavior; MySQL and MSSQL must retain their proven baseline navigation and metadata behavior, while every unsupported advanced surface is consistently gated with an accurate explanation rather than a silent omission, a hard-coded driver check, or an advertised but unimplemented feature.

Success is a declared capability contract on each production adapter, consumed by the affected host/UI funnels. A feature is available only when the active adapter declares it and implements the matching existing interface; no MySQL/MSSQL catalog, admin, DDL, or routine-detail backend is invented in this cycle.

## §2 Scope

### In scope

- Add a backward-compatible optional `DbAdapter.capabilities?: AdapterCapabilities` declaration and pure `hasAdapterCapability(adapter, capability)` helper in `src/adapters/types.ts`. The matrix covers `catalog`, `objectDdl`, `tableDdl`, and `admin`; absent declarations are unsupported. `PostgresAdapter` declares all four true; `MySqlAdapter` and `MsSqlAdapter` declare all four false. Concrete adapter tests prove the matrix and the existing PostgreSQL `catalog`/`admin` objects agree with its declarations.
- Replace catalog structural/driver gates in `src/ui/schemaCache.ts`, `src/ui/schemaTree.ts`, `src/ui/sqlCatalog.ts`, and `src/ui/ddlView.ts` with the declared catalog/object-DDL capabilities. Preserve baseline schema/table/view/routine/column navigation and estimate fallback for MySQL/MSSQL; make the DDL document state that the active adapter does not declare object-DDL support rather than calling it a generic “Postgres-only” feature.
- Replace PostgreSQL-driver and optional-object checks at table-DDL and admin host/UI entry points with declared `tableDdl`/`admin` checks. This includes table commands, the Admin tree, sessions panel, GRANT/REVOKE entry, and extension command wiring. Unsupported adapters receive one concise `UnicDB:` message and no SQL, form, webview, catalog, or admin API call.
- Add focused unit tests for capability declarations, supported PostgreSQL regressions, absent/malformed capability declarations, MySQL/MSSQL unsupported gates, and baseline navigation fallback.

### Out of scope for this cycle

- Implementing any missing MySQL/MSSQL backend: `catalog`, `admin`, `listTableDetail`, `listRoutineParams`, PostgreSQL GRANT/REVOKE SQL builders, exact catalog row counts, object DDL retrieval, or PostgreSQL table-designer SQL semantics.
- Broad non-catalog features whose current product requirement remains explicitly PostgreSQL-specific, including import, compare, relationship explorer, and AI adapter creation.
- Changing database queries, SQL mappers, connection pooling, cursor batching, transaction semantics, schemas, persisted connection configuration, package version, dependencies, menu visibility, or extension contribution commands.
- Making capability declarations required for external/mock `DbAdapter` values in this release. Missing declarations fail closed to preserve compatibility; all three production adapters must explicitly declare the full matrix.

### Same-wave file exclusion

TASK-DBX08-001 is Wave 1. TASK-DBX08-002 is Wave 2 and exclusively owns catalog/navigation files. TASK-DBX08-003 is Wave 3: it consumes TASK-DBX08-002's changed catalog-resolver option while exclusively owning table-DDL/admin/host files, including the shared `src/extension.ts` wiring. No same-wave tasks modify a shared file.

## §3 Approach

1. **Declare, then verify.** Add a literal capability matrix to the shared adapter contract, but make the optional property fail closed so existing narrow test doubles do not become falsely capable merely by compiling. Export `hasAdapterCapability(adapter, capability): boolean`; it returns true only for an explicit `true` declaration. Production adapters expose immutable literal declarations. Contract tests instantiate the actual classes and prove PostgreSQL’s declared `catalog`/`admin` capabilities match its existing `readonly catalog: CatalogApi` and `readonly admin: AdminApi`, whereas MySQL/MSSQL expose neither API and declare every advanced capability false.

2. **Gate catalog behavior by the declaration and implementation seam.** `SchemaCache` and `SchemaTreeProvider` continue to resolve actual adapters, but treat a false/missing capability as unsupported before any catalog call. `createCatalogResolver` stops accepting `isPostgres`; its option names the declared capability predicate so extension wiring no longer tests `driver === "postgres"`. `DdlViewProviderImpl.resolveDdl` checks `objectDdl` before calling the real `CatalogApi.objectDdl(kind, name, schema)` signature. A defensive missing API after a true declaration must render a clear unavailable document rather than throw; adapter contract tests make this an invariant violation in production rather than a way to advertise a feature.

3. **Keep known generic navigation, constrain only catalog navigation.** `listSchemas`, `listTables`, `listViews`, `listRoutines`, `listColumns`, `estimateTableRows`, and `estimateTableRowsBatch` remain the baseline adapter contract. The schema tree still shows its ordinary Tables/Views/Routines and calls estimate batching for non-catalog adapters. The SQL catalog resolver only adds FK, sequence, and definition navigation where `catalog` is declared; it must return `[]`/`undefined` without cache catalog calls otherwise.

4. **Centralize advanced command admission at existing funnels.** Make table-command guards async so they resolve the exact target adapter and use `tableDdl`, rather than infer capability from `ConnectionConfig.driver`. Commands must emit a stable `UnicDB:` unsupported-capability message before constructing a form or running SQL. The admin tree, sessions panel, and extension’s sessions/GRANT-REVOKE entry similarly require `admin`; the extension must not open a panel or invoke the wizard for a non-admin adapter. This deliberately changes silent hiding/generic errors into a truthful user explanation without pretending MySQL/MSSQL offer equivalent SQL.

### Trade-offs and rejected alternatives

- Rejected implementing PostgreSQL `CatalogApi` or `AdminApi` queries for MySQL/MSSQL from analogous information-schema guesses: no adapter backend in this repository proves equivalent semantics, and fake parity would create unsafe product claims.
- Rejected retaining `driver === "postgres"` as the effective source of truth: it makes declared adapter support impossible to extend safely and lets interfaces/messages drift from implementation.
- Rejected deleting optional `catalog`/`admin` objects or making `capabilities` mandatory immediately: both would cause an unrelated wide fixture migration. The new matrix is authoritative at consumer boundaries; absent capability is explicitly unsupported.
- Rejected hiding unsupported admin/category/command surfaces without feedback: a visible command that does nothing or a missing tree root gives users no accurate reason. The cycle standardizes concise unsupported messages before side effects.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | `production adapters declare the DBX-08 matrix` | A real `PostgresAdapter` declares `catalog`, `objectDdl`, `tableDdl`, and `admin` true and exposes the existing catalog/admin APIs; real MySQL and MSSQL adapters declare all four false and expose neither catalog nor admin. |
| edge — absent declaration | `hasAdapterCapability fails closed for legacy/malformed adapters` | Missing `capabilities`, an omitted key, or `{ catalog: false }` returns false; no unsupported feature is admitted by structural API presence alone. |
| edge — contract mismatch | `declared catalog/object-DDL support requires its matching API before use` | A fake adapter declaring a capability but omitting `catalog`/`objectDdl` receives a stable unavailable result/message and no TypeError or catalog method call. |
| happy | `declared PostgreSQL catalog capability keeps tree and SQL catalog results` | A catalog-capable adapter still renders Indexes/Constraints/Triggers/Sequences, resolves requested FK/definition rows, and invokes the known catalog methods with the existing schema/table arguments. |
| edge — unsupported catalog | `missing/false catalog declaration preserves generic navigation without catalog calls` | MySQL/MSSQL-shaped adapters retain Tables/Views/Routines/Columns and batch row estimates, while SQL catalog returns `[]`/`undefined`, no catalog API/cache call occurs, and catalog categories remain absent. |
| edge — object DDL | `Open DDL reports unsupported object-DDL before retrieval` | A node on an adapter without object-DDL capability caches a document naming unsupported object DDL; `catalog.objectDdl` is not invoked. |
| regression | `PostgreSQL catalog failure and stale navigation behavior remain green` | Existing catalog error/row-count and resolver stale-result tests retain their present expected fallback behavior. |
| happy | `table-DDL and admin commands admit a declared PostgreSQL capability` | A PostgreSQL-shaped adapter with declared `tableDdl`/`admin` opens its existing form/panel/wizard path and preserves the dangerous-statement confirmation route before SQL execution. |
| edge — dialect unsupported | `MySQL and MSSQL advanced commands stop before side effects` | Each false declaration produces a concise `UnicDB:` unsupported-capability message; no `runQuery`, form/webview creation, admin API, or wizard input is used. |
| edge — no active/broken adapter | `admin command handling distinguishes no connection from unavailable capability` | No active connection keeps the existing select-connection warning; a resolved adapter with missing/false admin capability reports unsupported access without opening a sessions panel. |
| edge — admin tree unsupported | `AdminTreeProvider explains unsupported admin instead of silent omission` | A non-admin adapter (false OR missing `admin` declaration) yields exactly one explanation node labeled `UnicDB: Admin tools are not supported by this connection's database.` (verbatim), no Admin category roots, and zero `AdminApi` method calls. |
| regression | `existing PostgreSQL table command, admin tree, sessions self-protection, and GRANT confirmation tests remain green` | Existing positive PostgreSQL behavior, self-PID protection, and confirmation-gate rejection results are unchanged. |

TDD rule for every task: write the listed focused test(s), capture the RED failure against the pre-task implementation, then implement the smallest change to make them GREEN.

## §5 Verification

No `lint` script exists in the current `package.json`; it must not be invented. The repository defines `test`, `typecheck`, and `compile` only.

```bash
# TASK-DBX08-001 focused RED→GREEN and static/build checks
npm test -- src/adapters/__tests__/capabilities.test.ts src/adapters/__tests__/postgresCatalog.test.ts src/adapters/__tests__/mysql.integration.test.ts src/adapters/__tests__/mssql.parameterized.test.ts
npm run typecheck
npm run compile

# TASK-DBX08-002 focused catalog/navigation checks
npm test -- src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/sqlCatalog.test.ts src/ui/__tests__/ddlView.test.ts
npm run typecheck
npm run compile

# TASK-DBX08-003 focused table-DDL/admin/host checks
npm test -- src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/adminTree.test.ts src/ui/__tests__/adminSessionsPanel.test.ts src/ui/__tests__/adminWizard.test.ts src/extension.test.ts
npm run typecheck
npm run compile

# Mandatory wave/cycle regression net after each completed wave and at release review
npm test
npm run typecheck
npm run compile
```

## §6 Acceptance

- [ ] TASK-DBX08-001: Each production adapter exposes an explicit tested matrix; absent or false declarations fail closed, PostgreSQL’s true entries correspond to its existing APIs, and MySQL/MSSQL do not claim unimplemented capabilities.
- [ ] TASK-DBX08-002: Catalog/navigation tree, cache, resolver, and DDL document use declared capability checks rather than `driver === "postgres"` or optional-object presence as the admission decision. Generic MySQL/MSSQL metadata navigation and row-estimate fallback remain intact. 
- [ ] TASK-DBX08-002: Unsupported object-DDL is accurately explained with no retrieval call, while existing PostgreSQL `CatalogApi.objectDdl(kind, name, schema?)` behavior remains available.
- [ ] TASK-DBX08-003: Table-DDL and admin entry points use declared `tableDdl`/`admin` support; MySQL/MSSQL receive a concise message and incur no advanced API, SQL, form, wizard, or webview side effect. The Admin tree renders the single explanation node labeled `UnicDB: Admin tools are not supported by this connection's database.` verbatim (no silent root omission, no `AdminApi` call) for false/missing declarations.
- [ ] TASK-DBX08-003: PostgreSQL table actions, admin tree/sessions behavior, and GRANT/REVOKE confirmation execution route remain regression-tested.
- [ ] TASK-DBX08-001, TASK-DBX08-002, TASK-DBX08-003: Every focused command and cycle `npm test`, `npm run typecheck`, and `npm run compile` command passes under `unic-smart` review.

## §7 Global Constraints

- Preserve `engines.vscode: ^1.75.0`, TypeScript 5.4 compatibility, package version `1.28.0`, and all existing production dependencies; add no dependency.
- The source of advanced-feature admission is an explicit adapter capability declaration; missing/false means unsupported. Never infer support solely from `driver`, an optional object’s structural presence, or a test double.
- Capability true must correspond to a real existing adapter API; do not add MySQL/MSSQL SQL, placeholders, stubs, backend probes, or UI claims for catalog/admin/object-DDL/table-DDL capabilities not proven in their current adapters.
- Preserve PostgreSQL SQL/mappers, parameterization, cursor batching, transactions, confirmation gates, and current baseline navigation behavior unless the task explicitly changes its admission guard.
- Unsupported surfaces must provide concise English `UnicDB:` messaging before side effects; do not silently execute, open a form/panel, call a catalog/admin method, or fall back to PostgreSQL SQL for MySQL/MSSQL.
- Keep public command IDs and contribution/menu configuration unchanged; do not modify `package.json`, generated `dist/`, release artifacts, connection persistence, or unrelated cycle files.
- Do not modify `docs/AI_HANDOFF/RUN.md`, older cycle plans/tasks/indexes, `docs/STATUS.md`, or `docs/WORKLOG.md` during this planning/implementation cycle; do not git add, commit, tag, package, or push.
- All tasks inherit this section by reference.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: split the catalog/navigation and table-DDL/admin consumer work into disjoint Wave-2 file sets so both can start immediately after the capability contract; added an explicit absent/malformed-declaration fail-closed case and a no-side-effect assertion for each unsupported host path.
Known gaps: no MySQL/MSSQL advanced capability is implemented because the checked-in adapters provide no verified backend API for it; explicit gating and messaging are the deliberate delivery for those surfaces.

## Plan Review Log

### Round 1 — Issues Found
REVIEWER_MODEL: unic-smart
- `docs/AI_HANDOFF/PLAN_DBX08.md §1, §2, §3.4, §4 (dialect unsupported)` / `docs/AI_HANDOFF/tasks/TASK-DBX08-003.md Test Cases #1–#5` — The plan requires every unsupported advanced surface, including the Admin tree, to give a concise `UnicDB:` explanation rather than silently omit it, but TASK-DBX08-003 has no test case with a concrete expected Admin-tree result for a false/missing `admin` declaration. Its only unsupported-admin case tests extension commands, while the Admin-tree case is ambiguously described as “absence/explanation”; an executor can retain the current silent `if (!adapter.admin) continue` behavior and still satisfy the listed tests.

Required changes:
- In `TASK-DBX08-003.md Test Cases`, add an explicit AdminTreeProvider false/missing-admin case with the exact expected unsupported node/message and assertions that no `AdminApi` method is invoked; name that test in `src/ui/__tests__/adminTree.test.ts` and align the Admin-tree acceptance criterion with this result. Update `PLAN_DBX08.md §4` and §6 to state the same concrete Admin-tree unsupported result.
- **Revision applied (planner round 1):** added TASK-DBX08-003 Test Case #4 (AdminTreeProvider false/missing-admin explanation node, zero AdminApi calls, legacy-adapter parity) in `src/ui/__tests__/adminTree.test.ts`, aligned the TASK acceptance criterion, and mirrored the concrete result in §4 and §6.


### Round 2 — Issues Found
REVIEWER_MODEL: unic-smart
- `docs/AI_HANDOFF/tasks/TASK-DBX08-003.md:29` and `docs/AI_HANDOFF/PLAN_DBX08.md:62,98` — The revised AdminTree contract still does not state an exact expected explanation-node label/message: “names unsupported admin access” and “unsupported-admin explanation node” permit divergent text. Specify the literal `UnicDB:` node label/message in the task, then mirror that same literal in PLAN §4 and §6 so `src/ui/__tests__/adminTree.test.ts` has a deterministic assertion.

### Round 2 — findings applied without re-review
REVIEWER_MODEL: unic-smart (loop cap reached: round 1 revision + round 2 finding)
- Round-2 finding applied directly: the AdminTree unsupported node label is pinned to the exact literal `UnicDB: Admin tools are not supported by this connection's database.` in TASK-DBX08-003 Test Case #4, and the same literal is mirrored in §4 and §6 so the adminTree test assertion is deterministic.
