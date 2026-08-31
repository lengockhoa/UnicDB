# TASK-DBX06-003 — rename UI (preview + confirm + progress) + commands

Cycle: DBX-06 · Wave 4 · Priority: P1
Status: pending
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
2. Commands in `tableCommands.ts`: `vsdb.renameTable` (table node) and
   `vsdb.renameColumn` (column node; resolve column via node arg or a
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

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
