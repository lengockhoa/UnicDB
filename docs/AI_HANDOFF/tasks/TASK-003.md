# TASK-003 — Wire Console host panel, execution, and save-as

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.3

## Goal

Add the host-side `ConsolePanel`, register the `VSDB: Open Console` palette command, and route Console messages to the existing SQL execution and ResultsPanel flow. Saving SQL opens an OS save dialog and writes UTF-8 text; closing the panel retains nothing.

## Target Files

- `src/ui/consolePanel.ts` (new) — standalone `vscode.WebviewPanel` owner with strict CSP HTML, `asWebviewUri` URIs for both `dist/consolePanel.js` and the shared emitted `dist/webview.css`, validated message routing, injected run callback, and `showSaveDialog`/`workspace.fs.writeFile` save implementation.
- `src/extension.ts` — create one ConsolePanel singleton during activation and register `vsdb.openConsole`; its run callback calls `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)` so the entire Console buffer is parsed, then passes all resulting statements to the existing `runStatements(mgr, runner, resultsPanel, statements)` flow.
- `package.json` — contribute `onCommand:vsdb.openConsole` and `VSDB: Open Console` for Command Palette access only; no menu contribution.
- `src/ui/__tests__/consolePanel.test.ts` (new) — mocked-VS-Code host-panel tests.
- `src/extension.test.ts` — command-registration and execution-delegation coverage, following the test file mapped to `src/extension.ts`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | palette command opens empty styled Console | The contributed `vsdb.openConsole` command calls ConsolePanel `show()` and creates/reveals a `vsdb.console` panel whose HTML references `consolePanel.js` and a `webview.css` `asWebviewUri` stylesheet link under the established local `style-src` CSP. | Mocked extension context and VS Code APIs. |
| 2 | happy | run message executes every statement in the full buffer through shared flow | `{ type: "runConsole", sql: "SELECT 1; SELECT 2" }` calls `sqlToRun(sql, { start: 0, end: sql.length }, 0, activeDriver)` and invokes `runStatements(mgr, runner, resultsPanel, statements)` with both parsed statements in source order, so ResultsPanel receives the existing run flow rather than a grid in Console. | Active connection and mocked runner/results panel. |
| 3 | edge-cancel | cancelled save is a no-op | A save message followed by `showSaveDialog` returning `undefined` calls neither `workspace.fs.writeFile` nor an error notification. | Textarea SQL and cancelled dialog. |
| 4 | edge-filesystem | accepted save writes exact UTF-8 text | The dialog receives default URI `console_20260102_030405.sql` and filters `{ SQL: ["sql"], "All Files": ["*"] }`; accepting `/tmp/query.sql` writes the source SQL's UTF-8 bytes to that URI. | Fixed clock and mocked URI/fs. |
| 5 | edge-lifecycle | disposal drops Console state | After disposal, `show()` creates a new panel; no prior textarea content is sent into the new HTML or retained in host fields. | Create panel, route SQL, dispose, show again. |
| 6 | regression-security | malformed webview messages do nothing | `null` and an unknown message type invoke neither the run callback nor the save dialog. | Mocked panel message listener. |

## Test Files

- `src/ui/__tests__/consolePanel.test.ts` (new) — ConsolePanel message routing, save cancellation/write, lifecycle, CSP/bundle URI coverage.
- `src/extension.test.ts` — command contribution/registration and delegation through existing `runStatements(mgr, runner, resultsPanel, statements)` execution flow.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/consolePanel.test.ts src/extension.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate.

## Acceptance Criteria

- [ ] Command Palette exposes `VSDB: Open Console` through `vsdb.openConsole`, with a matching activation event and no unrequested editor/view menu item.
- [ ] The Console panel is idempotently revealed while live; dispose clears its host reference and reopening starts with empty UI state.
- [ ] Console execution calls `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)` and passes every resulting statement to `runStatements(mgr, runner, resultsPanel, statements)`, retaining existing dangerous-statement confirmation, keyword qualification, runner updates, and ResultsPanel rendering.
- [ ] Save opens an SQL-filtered OS dialog using the TASK-001 filename helper; accepted saves write UTF-8 SQL and cancellation is a no-op.
- [ ] Webview HTML retains the established strict CSP, loads local `consolePanel.js`, and links the shared emitted `dist/webview.css` with `asWebviewUri` under `style-src ${webview.cspSource} 'unsafe-inline'`.
- [ ] The targeted tests and `npm run typecheck` pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001
- TASK-002

## Interfaces

- Consumes: `isConsoleToHostMessage(value: unknown): value is ConsoleToHostMessage` and `suggestSaveFileName(date: Date): string` from `src/ui/consolePanelMessages.ts` (TASK-001); browser messages emitted by `dist/consolePanel.js` and Console CSS emitted in `dist/webview.css` (TASK-002); `sqlToRun(sql: string, selection: { start: number; end: number } | undefined, cursorOffset: number, dialect?: SqlDialect): { statements: ParsedStatement[]; mode: "selection" | "cursor" }` from `src/core/statementParser.ts`; and existing `runStatements(mgr, runner, panel, statements)` in `src/extension.ts`.
- Produces: `vsdb.openConsole` command and a `ConsolePanel` host surface that links the local shared stylesheet and accepts `ConsoleToHostMessage` values. Its run callback delegates valid SQL as the full-buffer call `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)`.

---

## Discussion

### 2026-08-27 · planner · bao-opus
Verified source contract: `SchemaForm.buildHtml` links `dist/webview.css` with `webview.asWebviewUri`, so Console must independently link that same emitted asset under `style-src ${webview.cspSource} 'unsafe-inline'`; `webview/main.ts` is the existing stylesheet import that emits it. `sqlToRun` is `sqlToRun(sql, selection, cursorOffset, dialect)`: absent selection takes its cursor-only branch, so Console must force full-buffer parsing with `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)`. The selection branch parses the full slice, while `0` is required but ignored there. Do not substitute the editor handler's selection/cursor inputs or bypass `runStatements`.

---
