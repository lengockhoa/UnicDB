# TASK-DBX08-003 — Gate table-DDL and admin host entry points by declaration

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX08.md` §1–§3

## Goal

Replace advanced table-DDL and admin driver/structural guards with the DBX-08 capability contract. PostgreSQL retains its established table, sessions, and GRANT/REVOKE flows; MySQL/MSSQL receive a truthful concise explanation before any advanced-side effect.

## Target Files

- `src/ui/tableCommands.ts` — resolve the exact target adapter and gate all current PostgreSQL-only table-DDL utility commands through declared `tableDdl` before forms, SQL, AI, or clipboard side effects.
- `src/ui/adminTree.ts` — require declared `admin` capability before adding Admin roots or invoking `AdminApi` methods, with an unsupported explanation instead of structural admission/silent confusion.
- `src/ui/adminSessionsPanel.ts` — require declared `admin` capability before self-PID SQL or sessions/locks retrieval; render a precise unsupported error state instead of generic structural absence.
- `src/extension.ts` — pass the declared catalog predicate to both `createCatalogResolver` constructions and gate `UnicDB.openSessionsPanel` plus `UnicDB.runGrantSql` before opening a panel/wizard or executing PostgreSQL-confirmed SQL.
- `src/ui/__tests__/tableCommands.test.ts` — cover PostgreSQL admission plus MySQL/MSSQL no-side-effect table-DDL denial.
- `src/ui/__tests__/adminTree.test.ts` — cover declared admin root/subtree behavior and unsupported absence/explanation behavior.
- `src/ui/__tests__/adminSessionsPanel.test.ts` — cover unsupported sessions panel state before `pg_backend_pid()` or admin method calls and preserve self-PID protection.
- `src/extension.test.ts` — cover extension registration handlers for PostgreSQL admission and false/missing admin capability denial before opening a panel/wizard.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `declared PostgreSQL table-DDL and admin routes preserve existing flow` | A true `tableDdl`/`admin` adapter reaches the current table form or Admin panel/wizard route; GRANT/REVOKE still calls `confirmDangerousStatements(parsed, "postgres")` before `adapter.runQuery(sql)`. | Existing PostgreSQL command/admin fixtures amended with declarations. |
| 2 | edge — dialect unsupported | `false table-DDL declaration blocks MySQL and MSSQL before side effects` | Each current table-DDL utility command emits a concise `UnicDB:` unsupported-capability message and performs no `runQuery`, `listTableDetail`, AI provider, clipboard, or form creation. | MySQL and MSSQL connection fixtures with `tableDdl: false`. |
| 3 | edge — admin unavailable | `false or missing admin declaration blocks sessions and grant/revoke before UI or SQL` | The extension command emits a concise `UnicDB:` unsupported-admin message; it does not call `AdminSessionsPanel.show`, `commandOpenGrantWizard`, `getAdapter().runQuery`, `pg_backend_pid()`, or an `AdminApi` method. | Active MySQL/MSSQL-shaped adapter, plus a legacy adapter without the declaration. |
| 4 | edge — admin tree unsupported | `false or missing admin declaration renders an unsupported explanation node and never calls AdminApi` | `AdminTreeProvider.getChildren` (root level) on a non-admin adapter yields exactly one explanation node whose label is the literal `UnicDB: Admin tools are not supported by this connection's database.` (asserted verbatim), adds NO Admin category roots (Sessions/Locks/…), and invokes NO `AdminApi` method (spy on `adapter.admin.*` — the provider must not even reach structural access). A legacy adapter with no `capabilities` behaves identically. | `AdminTreeProvider` fixture over a MySQL-shaped and a declaration-less adapter; existing PostgreSQL fixture amended with `admin: true`. |
| 5 | edge — no active connection | `admin commands retain select-connection warning` | With no active connection, `UnicDB.openSessionsPanel` keeps its existing select-connection warning and no adapter lookup/panel creation occurs. | Extension host fixture with `mgr.getActive(): null`. |
| 6 | regression | `existing table and admin safeguards remain green` | Existing PostgreSQL table command success/error behavior, admin-tree role rendering, sessions self-PID suppression, and confirmation-gate rejection assertions remain unchanged. | Existing focused tests. |

## Test Files

- `src/ui/__tests__/tableCommands.test.ts` — mapped test for `src/ui/tableCommands.ts`.
- `src/ui/__tests__/adminTree.test.ts` — mapped test for `src/ui/adminTree.ts`.
- `src/ui/__tests__/adminSessionsPanel.test.ts` — mapped test for `src/ui/adminSessionsPanel.ts`.
- `src/ui/__tests__/adminWizard.test.ts` — mapped regression test for the GRANT/REVOKE confirmation execution seam.
- `src/extension.test.ts` — mapped test for `src/extension.ts` host command and resolver wiring.

## Verification Commands

```bash
npm test -- src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/adminTree.test.ts src/ui/__tests__/adminSessionsPanel.test.ts src/ui/__tests__/adminWizard.test.ts src/extension.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] Current PostgreSQL-only table-DDL utility commands resolve their target adapter and require declared `tableDdl`, not connection driver identity.
- [ ] Current admin roots, sessions panel, and extension sessions/GRANT-REVOKE commands require declared `admin`, not `adapter.admin` structural presence alone; a non-admin AdminTreeProvider renders the unsupported explanation node (Test Case #4) instead of silently omitting the root.
- [ ] Unsupported paths show concise English `UnicDB:` capability messages before all advanced UI, API, SQL, AI, clipboard, and self-PID side effects.
- [ ] Both extension catalog resolver constructions receive the declared catalog predicate produced by TASK-DBX08-002; no `isPostgres` resolver option remains.
- [ ] Existing PostgreSQL confirmation, self-protection, and positive command behavior remain green.
- [ ] The test cases and verification commands pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DBX08-001
- TASK-DBX08-002

## Interfaces

- Consumes: `hasAdapterCapability(adapter, "tableDdl" | "admin" | "catalog"): boolean` and `DbAdapter.capabilities?: AdapterCapabilities` from TASK-DBX08-001; capability-driven `CatalogResolverOptions` from TASK-DBX08-002; `AdminSessionsPanel.show(mgr: ConnectionManager, conn: ConnectionConfig): Promise<AdminSessionsPanel>`; `commandOpenGrantWizard(mgr, kind: "grant" | "revoke", execute?: (sql: string) => Promise<void>): Promise<void>`.
- Produces: capability-driven advanced table/admin host behavior. Preserves `registerTableCommands(deps: RegisterDeps): void`, `AdminTreeProvider`, `AdminSessionsPanel`, and existing `UnicDB.openSessionsPanel`/`UnicDB.runGrantSql` command IDs and GRANT confirmation callback semantics.

---

## Discussion

### 2026-09-01 · planner · unic-smart
`tableDdl` deliberately gates the existing collection of PostgreSQL-only table utility commands even where a command happens to use generic metadata internally: those commands were previously advertised as PostgreSQL-only and no equivalent MySQL/MSSQL table-DDL workflow is proven. Keep the existing package commands and menus; this task corrects admission and messaging, not contribution visibility.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -

RED_OUTPUT: All new gating tests failed against the pre-task implementation, for the expected reasons:

1. `npx vitest run src/ui/__tests__/tableCommands.test.ts` → `Test Files 1 failed (1) · Tests 10 failed | 33 passed (43)`. Representative failures (old driver-text guard produced neither the new `UnicDB:` capability message nor capability admission):
   ```
   FAIL … tableCommands — guards > #7 mysql guard → 'UnicDB: Modify Table is not supported by this connection's database.' info, no runQuery
   FAIL … DBX-08 tableDdl capability gate > declared tableDdl:true on a mysql-driver adapter admits the flow (declaration, not driver, decides)
   FAIL … DBX-08 tableDdl capability gate > tableDdl:false blocks MySQL and MSSQL before side effects (all utility commands)
   AssertionError: expected false to be true // Object.is equality
    ❯ src/ui/__tests__/tableCommands.test.ts:1520:11
   ```

2. `npx vitest run src/ui/__tests__/adminTree.test.ts` → `Tests 2 failed | 6 passed (8)`:
   ```
   FAIL … AdminTreeProvider — DBX-08 declared admin capability > false or missing admin declaration renders an unsupported explanation node and never calls AdminApi
   FAIL … AdminTreeProvider — DBX-08 declared admin capability > legacy adapter without capabilities behaves identically (verbatim label, no Admin roots)
   ```
   (pre-task provider silently omitted the root: `if (!adapter.admin) continue` — no explanation node existed)

3. `npx vitest run src/ui/__tests__/adminSessionsPanel.test.ts` → `Tests 3 failed | 11 passed (14)`:
   ```
   FAIL … refresh with false admin declaration renders the unsupported state before pg_backend_pid or admin calls
   AssertionError: expected '<!doctype html>…' to contain 'UnicDB: Admin tools are not supported b…'
   FAIL … renderUnsupportedAdminHtml renders the precise unsupported error state
   TypeError: renderUnsupportedAdminHtml is not a function
   ```

4. `npx vitest run src/extension.test.ts` → `Tests 2 failed | 79 passed (81)`:
   ```
   FAIL … extension — DBX-08 capability-gated admin host commands > #3 false admin declaration blocks sessions panel + grant/revoke before UI or SQL
   AssertionError: expected 1 to be +0 // Object.is equality   (webview panel WAS created via structural `adapter.admin` admission)
   FAIL … #3b legacy adapter (missing capabilities) is denied identically — same `expected 1 to be +0`
   ```

Verification Output:
```bash
# 1) npm test -- src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/adminTree.test.ts src/ui/__tests__/adminSessionsPanel.test.ts src/ui/__tests__/adminWizard.test.ts src/extension.test.ts
 ✓ src/ui/__tests__/adminTree.test.ts  (8 tests) 4ms
 ✓ src/ui/__tests__/adminSessionsPanel.test.ts  (14 tests) 4ms
 ✓ src/ui/__tests__/adminWizard.test.ts  (12 tests) 7ms
 ✓ src/ui/__tests__/tableCommands.test.ts  (43 tests) 17ms
 ✓ src/extension.test.ts  (81 tests) 468ms
 Test Files  5 passed (5)
      Tests  158 passed (158)

# 2) npm run typecheck   → tsc --noEmit, exit 0
# 3) npm run compile     → esbuild: build complete, exit 0

# 4) regression net: npx vitest run src/ui/__tests__/schemaCache.test.ts src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/sqlCatalog.test.ts src/ui/__tests__/ddlView.test.ts src/ui/__tests__/sqlNavigationProvider.test.ts src/adapters/__tests__/capabilities.test.ts
 Test Files  6 passed (6)
      Tests  45 passed (45)

# 5) full npm test
 Test Files  213 passed | 1 skipped (214)
      Tests  2810 passed | 2 skipped (2812)
```

Status: PASS

Note: implementation details — (a) `guardPostgres` in `src/ui/tableCommands.ts` became async and now resolves the exact target adapter via `mgr.getAdapterFor(conn)` then checks `hasAdapterCapability(adapter, "tableDdl")` (fail-closed; unresolvable adapter → capability message, zero side effects); `createSchema`/`exportAllStructures` driver checks were replaced the same way. (b) `AdminTreeProvider.getRootChildren` renders exactly one verbatim `ADMIN_UNSUPPORTED_LABEL` node for false/missing `admin` declaration and never touches `adapter.admin`; `ADMIN_UNSUPPORTED_LABEL` re-exports the single pinned constant owned by `adminSessionsPanel.ts`. (c) `AdminSessionsPanel.refresh` checks `hasAdapterCapability(adapter, "admin")` BEFORE `pg_backend_pid()` and any AdminApi call; new `renderUnsupportedAdminHtml` renders the precise unsupported banner. (d) `extension.ts`: `UnicDB.openSessionsPanel` keeps the no-connection warning first, then capability-gates before `AdminSessionsPanel.show`; `UnicDB.runGrantSql` capability-gates before `commandOpenGrantWizard` (no-connection still gets the wizard's own select-connection warning — distinct case per PLAN §4); the GRANT execute seam still routes through `confirmDangerousStatements(parsed, "postgres")` before `adapter.runQuery(sql)`. (e) Pre-existing tests asserting the removed "PostgreSQL connections only" wording were updated to the new pinned `UnicDB:` message (Test Case #6 contract: safeguards unchanged, message text now capability-based). package.json untouched; version 1.28.0; no new deps; no git add/commit.


## Review — Round 1

REVIEWER_MODEL: unic-smart (configured `handoff.reviewer.model`; running model: unic-smart)
EXECUTOR_MODEL: unic-code
VERDICT: APPROVED
FINDINGS: none
VERIFICATION_RERUN:
- `npx vitest run src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/adminTree.test.ts src/ui/__tests__/adminSessionsPanel.test.ts src/ui/__tests__/adminWizard.test.ts src/extension.test.ts` — PASS (5 files, 158 tests)
- `npm run typecheck` — PASS (`tsc --noEmit`, exit 0)
TEST_PLAN_COVERAGE: all-followed — PostgreSQL admission/confirmation, false and legacy capability denials, Admin-tree verbatim single-node/no-AdminApi behavior, sessions self-PID gate, and no-active-connection warning are covered.
NOTES: Commit `08fc0c9` uses declared capability gates at the required table/admin funnels, preserves the PostgreSQL GRANT confirmation-before-query ordering, wires both catalog resolvers with `declaresCatalog`, and leaves package metadata/dependencies/contributions unchanged.
