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
- `src/extension.ts` — pass the declared catalog predicate to both `createCatalogResolver` constructions and gate `vsdb.openSessionsPanel` plus `vsdb.runGrantSql` before opening a panel/wizard or executing PostgreSQL-confirmed SQL.
- `src/ui/__tests__/tableCommands.test.ts` — cover PostgreSQL admission plus MySQL/MSSQL no-side-effect table-DDL denial.
- `src/ui/__tests__/adminTree.test.ts` — cover declared admin root/subtree behavior and unsupported absence/explanation behavior.
- `src/ui/__tests__/adminSessionsPanel.test.ts` — cover unsupported sessions panel state before `pg_backend_pid()` or admin method calls and preserve self-PID protection.
- `src/extension.test.ts` — cover extension registration handlers for PostgreSQL admission and false/missing admin capability denial before opening a panel/wizard.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `declared PostgreSQL table-DDL and admin routes preserve existing flow` | A true `tableDdl`/`admin` adapter reaches the current table form or Admin panel/wizard route; GRANT/REVOKE still calls `confirmDangerousStatements(parsed, "postgres")` before `adapter.runQuery(sql)`. | Existing PostgreSQL command/admin fixtures amended with declarations. |
| 2 | edge — dialect unsupported | `false table-DDL declaration blocks MySQL and MSSQL before side effects` | Each current table-DDL utility command emits a concise `VSDB:` unsupported-capability message and performs no `runQuery`, `listTableDetail`, AI provider, clipboard, or form creation. | MySQL and MSSQL connection fixtures with `tableDdl: false`. |
| 3 | edge — admin unavailable | `false or missing admin declaration blocks sessions and grant/revoke before UI or SQL` | The extension command emits a concise `VSDB:` unsupported-admin message; it does not call `AdminSessionsPanel.show`, `commandOpenGrantWizard`, `getAdapter().runQuery`, `pg_backend_pid()`, or an `AdminApi` method. | Active MySQL/MSSQL-shaped adapter, plus a legacy adapter without the declaration. |
| 4 | edge — admin tree unsupported | `false or missing admin declaration renders an unsupported explanation node and never calls AdminApi` | `AdminTreeProvider.getChildren` (root level) on a non-admin adapter yields exactly one explanation node whose label is the literal `VSDB: Admin tools are not supported by this connection's database.` (asserted verbatim), adds NO Admin category roots (Sessions/Locks/…), and invokes NO `AdminApi` method (spy on `adapter.admin.*` — the provider must not even reach structural access). A legacy adapter with no `capabilities` behaves identically. | `AdminTreeProvider` fixture over a MySQL-shaped and a declaration-less adapter; existing PostgreSQL fixture amended with `admin: true`. |
| 5 | edge — no active connection | `admin commands retain select-connection warning` | With no active connection, `vsdb.openSessionsPanel` keeps its existing select-connection warning and no adapter lookup/panel creation occurs. | Extension host fixture with `mgr.getActive(): null`. |
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
- [ ] Unsupported paths show concise English `VSDB:` capability messages before all advanced UI, API, SQL, AI, clipboard, and self-PID side effects.
- [ ] Both extension catalog resolver constructions receive the declared catalog predicate produced by TASK-DBX08-002; no `isPostgres` resolver option remains.
- [ ] Existing PostgreSQL confirmation, self-protection, and positive command behavior remain green.
- [ ] The test cases and verification commands pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DBX08-001
- TASK-DBX08-002

## Interfaces

- Consumes: `hasAdapterCapability(adapter, "tableDdl" | "admin" | "catalog"): boolean` and `DbAdapter.capabilities?: AdapterCapabilities` from TASK-DBX08-001; capability-driven `CatalogResolverOptions` from TASK-DBX08-002; `AdminSessionsPanel.show(mgr: ConnectionManager, conn: ConnectionConfig): Promise<AdminSessionsPanel>`; `commandOpenGrantWizard(mgr, kind: "grant" | "revoke", execute?: (sql: string) => Promise<void>): Promise<void>`.
- Produces: capability-driven advanced table/admin host behavior. Preserves `registerTableCommands(deps: RegisterDeps): void`, `AdminTreeProvider`, `AdminSessionsPanel`, and existing `vsdb.openSessionsPanel`/`vsdb.runGrantSql` command IDs and GRANT confirmation callback semantics.

---

## Discussion

### 2026-09-01 · planner · unic-smart
`tableDdl` deliberately gates the existing collection of PostgreSQL-only table utility commands even where a command happens to use generic metadata internally: those commands were previously advertised as PostgreSQL-only and no equivalent MySQL/MSSQL table-DDL workflow is proven. Keep the existing package commands and menus; this task corrects admission and messaging, not contribution visibility.

---
