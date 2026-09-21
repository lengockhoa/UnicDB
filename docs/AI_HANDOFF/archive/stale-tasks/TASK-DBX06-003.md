# TASK-DBX06-003 — rename UI (preview + confirm + progress) + commands

Cycle: DBX-06 · Wave 4 · Priority: P1
Status: done (reviewer APPROVED — see verdict block in TASK-DBX06-001.md)
Depends on: DBX06-002
Reviewer: unic-smart (cycle reviewer)

## Spec

1. `src/ui/renameForm.ts` — `RenameForm` class (DOM-API webview, CSP-safe;
   mirror NewTableForm's panel scaffold + message contract, but a minimal
   purpose-built form):
   - Host → webview `init {mode, schema, table, oldName}`; webview → host
     `analyze {newName}`, `approve {newName, statements}`, `cancel {}`.
   - On `analyze`: host validates via validateNewName, runs the 4 catalog
     queries (parameterized via adapter runQuery), builds the plan, posts
     `analysis {report, statements, errors}`. Errors → webview shows them,
     approve stays disabled.
   - Approve → host executes statements sequentially; per-statement
     `progress {index, total, statement}`; on completion `done {applied}`.
     Failure mid-run → `done {applied, failedAt, error}` naming the exact
     statement + what already applied. Cancel during run stops BEFORE the
     next statement and returns the same done shape.
2. Commands in `tableCommands.ts`: `UnicDB.renameTable` (table node) and
   `UnicDB.renameColumn` (column node; resolve column via node arg or a
   QuickPick over listTableDetail columns). Both guardPostgres.
3. `package.json`: commands + view/item menus contributions.

## Acceptance

- [ ] Webview scaffold test (jsdom, compiled bundle): init renders input +
      Analyze + Cancel; analysis renders report lines + statements
      (textContent only); approve posts the approve wire message; no
      innerHTML sinks.
- [ ] Host logic tests with a fake adapter: analyze runs 4 parameterized
      queries; approve executes statements in order with progress; mid-run
      failure reports applied/failedAt/error; cancel-after-statement stops.
- [ ] `npx vitest run <targeted files>` green; package.json has the 2
      commands (asserted in 004).

## Executor

Delivered: src/core/ddl/renameRunner.ts (pure runRenameStatements — progress + mid-run failure + cancel-before-next), src/ui/renameFormMessages.ts (typed init/analysis/progress/done contract), src/ui/renameForm.ts (host — runs the 4 parameterized pg_catalog lookups via adapter.renameUsage capability, builds plan, runs statements, posts per-statement progress + done shape), webview/renameFormMain.ts (vanilla DOM, textContent-only, init/analysis/progress/done renders), esbuild entry dist/renameForm.js, tableCommands.ts wires UnicDB.renameTable + UnicDB.renameColumn (renameTable → onRenamed reveals the renamed node; renameColumn → QuickPick over listTableDetail columns), package.json command + menu contributions.

**RED → GREEN evidence**:
- `npx vitest run src/core/ddl/__tests__/renameRunner.test.ts` → Tests 3 passed
- `npx vitest run src/ui/__tests__/renameFormHost.test.ts` → Tests 4 passed
- `npm run compile` + `npx vitest run src/ui/__tests__/renameFormBundle.test.ts` → Tests 5 passed

Notes:
- Adapter interface gained an OPTIONAL `renameUsage` capability (RenameUsageApi in src/adapters/types.ts). PostgresAdapter implements it; mysql/mssql leave it undefined (caller guard via guardPostgres + non-null check in RenameForm.usage()).
- Cancellation respects the roadmap "cancellation/partial failure" edge: the cancel probe is polled BEFORE each statement, so a mid-flight cancel still completes the in-flight statement and reports applied/cancelledAfter/remaining.
- Webview is textContent-only — bundle source asserts no innerHTML/insertAdjacentHTML writes (regression for the project-wide webview-CSP rule).

## Reviewer

(verdict appended by reviewer)
