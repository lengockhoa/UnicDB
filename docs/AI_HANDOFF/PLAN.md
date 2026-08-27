# Cycle Z Plan — SQL Console scratchpad

Base: `main` (clean tree). Executor: `unic-code`. Reviewer: `bao-opus` (must differ from executor).

## §1 Intent

VSDB lacks a DataGrip-style **Console**: a disposable scratchpad where a user types ad-hoc SQL, runs it, then closes it. Success is: Command Palette command **VSDB: Open Console** opens an empty panel with Run and Save controls plus a right-click **Save as SQL file** action; Run/Cmd+Enter executes SQL through the existing run pipeline and displays output in the existing ResultsPanel; Save writes the current SQL through VS Code's OS dialog; cancelling does nothing; closing and reopening is empty.

**P0 decisions (RESOLVED — recorded verbatim):**

1. Run results display: reuse the EXISTING ResultsPanel — Console forwards SQL into the already-built run flow (`runStatements(mgr, runner, resultsPanel, statements)` in src/extension.ts:617); Console itself does NOT embed an AG Grid.
2. Save-as-SQL: implemented INSIDE the Console webview panel — a custom right-click (contextmenu DOM event) menu with "Save as SQL file" item, PLUS a visible Save button on the panel's in-webview toolbar. (VS Code cannot add native tab-context items to webview panels.)
3. Persistence: NONE. Closing the Console discards its content; reopening starts empty ("gõ xong tắt đi").

Scope complexity: MODERATE
Detected systems: Console protocol/helpers, Console webview bundle, extension-host panel/command wiring
Decomposition: 3 sequential implementation modules — all required to deliver one Console subsystem this cycle.

## §2 Scope

### In scope

| Slice | Task | Deliverable |
|---|---|---|
| Protocol and deterministic pure helper | TASK-001 | Validated Console-to-host messages and SQL filename suggestion. |
| Browser Console surface | TASK-002 | Webview UI, keyboard/menu interactions, browser bundle entry, jsdom test. |
| VS Code host integration | TASK-003 | Panel host, palette command, existing-run-flow delegation, disk save. |

### Out of scope

- AG Grid or results rendering inside Console; ResultsPanel remains the sole result UI.
- Any Console persistence, serializer, restore-after-reload behavior, recent-query history, or autosave.
- Native webview tab context menu contribution, editor/context-menu command, schema-tree icon, SQL syntax highlighting, connection picker, copy command, or new dependencies.
- New SQL parsing/execution semantics: Console must reuse existing parsing and `runStatements` execution behavior.

### File ownership and waves

Tasks are intentionally serialized because TASK-002 consumes TASK-001's message contract and TASK-003 consumes both the contract and emitted bundle. No same-wave tasks share a file.

| Wave | Task | Files owned |
|---|---|---|
| 1 | TASK-001 | new `src/ui/consolePanelMessages.ts`, new `src/ui/__tests__/consolePanelMessages.test.ts` |
| 2 | TASK-002 | new `webview/consolePanelMain.ts`, `webview/styles.css`, `esbuild.js`, new `src/ui/__tests__/consolePanelBundle.test.ts` |
| 3 | TASK-003 | new `src/ui/consolePanel.ts`, `src/extension.ts`, `package.json`, new `src/ui/__tests__/consolePanel.test.ts`, `src/extension.test.ts` |

## §3 Approach

### 3.1 Protocol and pure helpers (TASK-001)

Add a minimal standalone module, `src/ui/consolePanelMessages.ts`, with a discriminated `ConsoleToHostMessage` union for `{ type: "runConsole"; sql: string }` and `{ type: "saveConsoleAsSql"; sql: string }`, an `unknown` runtime guard, and `suggestSaveFileName(date: Date): string`. The host consumes only guard-approved values. A required Date keeps unit tests deterministic; the save host supplies `new Date()`.

`console_YYYYMMDD_HHMMSS.sql` is the default suggestion, with all fields zero-padded. No ready, copy, persistence, or busy protocol is needed: the panel begins empty and the existing ResultsPanel is responsible for run state/results.

### 3.2 Webview UI and build (TASK-002)

Follow the existing dedicated browser-entry pattern in verified `esbuild.js`: add a `consolePanelConfig` mapping `webview/consolePanelMain.ts` to `dist/consolePanel.js`, then include it in both `--watch` contexts and normal `Promise.all` builds. The existing config uses `platform: "browser"`, `format: "iife"`, and `target: "es2022"`; Console matches it.

The new entry renders a textarea, visible Run/Save toolbar buttons, and a custom DOM `contextmenu` overlay. Run sends `{ type: "runConsole", sql }` on click and Cmd/Ctrl+Enter, after rejecting empty SQL; Save and its context-menu item send `{ type: "saveConsoleAsSql", sql }`. Plain Enter remains textarea input. Console-specific rules live in the existing `webview/styles.css`; `webview/main.ts` imports that asset so the existing normal/watch `webviewConfig` emits `dist/webview.css`. TASK-003's `ConsolePanel.buildHtml` must independently create `styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"))` and include `<link rel="stylesheet" href="${styleUri}" />` under its existing `style-src ${webview.cspSource} 'unsafe-inline'` CSP. Thus `consolePanel.js` is the Console script and the shared emitted `webview.css` is its stylesheet; no Console entry import or additional CSS output is needed. A jsdom test follows the verified `src/ui/__tests__/webviewDistinctValues.test.ts` precedent: compile first, load the `dist` text, stub `acquireVsCodeApi`, dispatch UI events, assert exact posted messages.

Alternative rejected: syntax highlighting via `webview/sqlHighlight.ts`. It is optional and does not contribute to the resolved Console success path.

### 3.3 Host panel, command, execution, and saving (TASK-003)

Create `src/ui/consolePanel.ts` matching existing standalone `vscode.WebviewPanel` patterns: idempotent `show()`, `createWebviewPanel`, `enableScripts`, local resource root at `dist`, strict CSP (`default-src 'none'` and local script/style URIs), and disposal that clears the panel reference. Following `SchemaForm.buildHtml`, its HTML must construct `scriptUri` for `dist/consolePanel.js` and `styleUri` for `dist/webview.css` with `webview.asWebviewUri`, then emit both `<link rel="stylesheet" href="${styleUri}" />` and `<script src="${scriptUri}"></script>` under `style-src ${webview.cspSource} 'unsafe-inline'` and `script-src ${webview.cspSource}`. It never embeds AG Grid or stores textarea contents.

Inject a run callback from `src/extension.ts`. Register `vsdb.openConsole` with disposables and instantiate one ConsolePanel during `activate()`. Console Run is explicitly full-buffer execution: for received `sql`, call `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)`, then pass its `statements` to `runStatements(mgr, runner, resultsPanel, statements)`. `sqlToRun`'s real signature is `sqlToRun(sql, selection, cursorOffset, dialect)`; the full-length selection selects every parsed statement (`mode: "selection"`), and `0` is required but unused on that selection branch. The active driver's dialect preserves MySQL/MSSQL splitting. Retain the existing zero-statement information message before delegation, preserving dangerous-statement confirmation, keyword qualification, busy state, runner updates, and ResultsPanel rendering.

For save, mirror the verified ResultsPanel export pattern: `showSaveDialog` with the helper's suggested URI and `{ SQL: ["sql"], "All Files": ["*"] }`, return on `undefined`, then `workspace.fs.writeFile(uri, new TextEncoder().encode(sql))`. Contribute only `onCommand:vsdb.openConsole` and the palette-visible `VSDB: Open Console` command in `package.json`; add no menu contribution.

Alternative rejected: separate Console execution or ResultsPanel changes. The existing shared flow is an explicit product decision, and independently rendering results would duplicate behavior and add AG Grid scope.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | Console message guard accepts a valid run payload | `{ type: "runConsole", sql: "SELECT 1" }` returns `true`; a discriminated message can be consumed safely. |
| edge-malformed | Console message guard rejects invalid payloads | `null`, missing/non-string `sql`, and unknown `type` each return `false`. |
| edge-boundary | Save filename zero-pads date fields | 2026-01-02 03:04:05 becomes exactly `console_20260102_030405.sql`. |
| happy | Run button posts SQL | Clicking Run with `SELECT 1` posts exactly `{ type: "runConsole", sql: "SELECT 1" }`. |
| edge-empty | Empty editor does not execute | Clicking Run with `""` posts no run message. |
| edge-shortcut | Cmd/Ctrl+Enter runs, plain Enter does not | Modified Enter posts run and prevents default; plain Enter posts nothing. |
| edge-interaction | Right-click save is custom and functional | Browser menu is prevented, `Save as SQL file` appears, selection posts exact save payload. |
| happy | Open Console command delegates full-buffer SQL to the established pipeline | A run message with `SELECT 1; SELECT 2` calls `sqlToRun(sql, { start: 0, end: sql.length }, 0, activeDriver)` and reaches `runStatements(mgr, runner, resultsPanel, statements)` with both parsed statements in source order. |
| edge-asset-load | Console HTML links the shared stylesheet under its CSP | `buildHtml` uses `asWebviewUri` for `dist/webview.css`, emits its `<link rel="stylesheet">`, and retains a `style-src` directive permitting `webview.cspSource`. |
| edge-cancel | Cancelled SQL save changes nothing | `showSaveDialog` resolving `undefined` calls neither `workspace.fs.writeFile` nor error notification. |
| edge-filesystem | Accepted SQL save writes UTF-8 source | The dialog has SQL filters/default name and receives bytes for the exact textarea SQL. |
| edge-lifecycle | Close/reopen does not retain content | Disposing then showing creates a new panel with no saved SQL state. |
| regression-security | Malformed host message has no side effect | Invalid message invokes neither run callback nor save dialog. |

## §5 Verification

Verified `package.json` scripts: `npm run compile` runs `node esbuild.js`; `npm test` runs `vitest run`; `npm run typecheck` runs `tsc --noEmit`. There is **no lint script**. Typecheck is therefore the required static gate for every task.

Per-task commands are recorded in each task with the targeted test file(s) selected from the verified test layout. At cycle close, run:

```bash
npm run typecheck
npm run compile
npx vitest run src/ui/__tests__/consolePanelMessages.test.ts src/ui/__tests__/consolePanelBundle.test.ts src/ui/__tests__/consolePanel.test.ts src/extension.test.ts
npm test
```

`npm run compile` must occur before `consolePanelBundle.test.ts`, because it reads `dist/consolePanel.js`.

## §6 Acceptance Criteria

- [ ] TASK-001: only valid string-bearing Console run/save messages reach the host; suggested `.sql` filenames are deterministic and zero-padded.
- [ ] TASK-002: `dist/consolePanel.js` is emitted; the UI has an empty textarea, visible Run/Save controls, Cmd/Ctrl+Enter handling, and custom right-click `Save as SQL file` handling.
- [ ] TASK-003: `VSDB: Open Console` is accessible from Command Palette and opens/reveals a secure standalone Console panel.
- [ ] TASK-003: Console HTML links `dist/webview.css` through `asWebviewUri` under the established local-only CSP, so TASK-002's shared Console styles reach the panel.
- [ ] TASK-003: every Console buffer is parsed as `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)` and all resulting statements run through `runStatements(mgr, runner, resultsPanel, statements)`; results remain exclusively in ResultsPanel.
- [ ] TASK-003: save cancellation is a no-op; accepted saves use VS Code's OS dialog and write exact UTF-8 SQL with SQL file filters.
- [ ] TASK-003: closing discards Console contents and reopening starts empty.
- [ ] `npm run typecheck`, `npm run compile`, targeted Console tests, and `npm test` pass.
- [ ] Every task has an APPROVED or APPROVED-WITH-MINOR reviewer verdict.

## §7 Global Constraints

- Use npm only; do not introduce dependencies or a lint script.
- Preserve TypeScript strictness and the project browser bundle target (`es2022`) and extension engine floor (`vscode ^1.75.0`).
- Use existing VS Code WebviewPanel CSP/local-resource conventions; never widen CSP or load remote resources.
- Persist no Console SQL, panel state, serializer data, or history; disposal must clear host references.
- Reuse `runStatements(mgr, runner, resultsPanel, statements)` for Console execution; Console must not embed AG Grid or duplicate ResultsPanel behavior.
- Use `workspace.fs.writeFile` with `TextEncoder`; do not use Node filesystem APIs for VS Code workspace save paths.
- New files are marked `(new)` in tasks; no two tasks in the same wave may modify a file.
- Each task inherits these constraints by reference and must begin TDD with a real RED observation before implementation.

## Planner Self-Audit

Checklist: 12/12 pass

1. §6 acceptance traces to TASK-001 (protocol), TASK-002 (webview/bundle), or TASK-003 (host command/run/save/lifecycle); verification is shared across all three.
2. Every task delivers a stated §1 success component; no task introduces unrelated behavior.
3. The three tasks jointly deliver opening, editing, running, ResultsPanel display, saving, cancellation, and non-persistence; no success gap remains.
4. Unhappy paths cover malformed messages, empty SQL, keyboard boundary, cancelled dialog, filesystem write expectation, and lifecycle disposal.
5. Existing targets were verified; all new source/test paths have existing parent directories and are marked `(new)` in task files.
6. Commands were verified against `package.json`; absent lint is explicit.
7. The dependency graph is a three-wave chain and has no same-wave file collision.
8. TASK-002 consumes TASK-001's contract; TASK-003 consumes both prior artifacts. No task references an uncreated dependency.
9. Each task has happy plus at least two distinct edge kinds, specified in its own test table.
10. Each expected result is concrete: exact union values, filename, postMessage payload, call/no-call, URI filters, byte content, stylesheet URI, or multi-statement array.
11. This is a new feature, not a bugfix; no regression-only reproduction requirement applies. TASK-003 nevertheless guards invalid-message behavior.
12. No test passes against an empty implementation: each requires a concrete export, emitted bundle, DOM event result, host routing, save call, asset link, full-buffer parsed statements, or lifecycle behavior.

Fixed during audit: narrowed the package contribution to Command Palette access only; selected existing `webview/styles.css` and verified `esbuild.js` as the sole browser bundler; added explicit malformed-message and close/reopen cases; specified the `dist/webview.css` `asWebviewUri`/CSP asset-load contract and full-buffer `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)` execution contract with tests.

Known gaps: none.

## Planner Report
PLANNER_MODEL: bao-opus
PLAN_REVIEW: Approved by bao-opus

## Plan Review Log

### Round 1
Status: Issues Found
- `§3.2` (lines 55-57) and `§3.3` (lines 63-64) — Console styling has no defined load path: `webview/styles.css` is emitted as `dist/webview.css` only because `webview/main.ts:30` imports it, while the new panel is specified to load only `consolePanel.js`. Console-specific rules therefore will not reach the Console webview. Specify one concrete asset contract (for example, link `dist/webview.css` from Console HTML under the existing `style-src` CSP) and add an HTML/CSP assertion to TASK-003.
- `§3.3` (line 65) and TASK-003 `Test Cases` (lines 22-28) — The Console supplies only SQL, but the required parser is `sqlToRun(sql, selection, cursorOffset, dialect)` (`src/core/statementParser.ts:815-830`). The plan never defines selection/cursor inputs, and its lone `SELECT 1` delegation test cannot detect an implementation that runs only the first statement. Define the Console as full-buffer execution with `selection: { start: 0, end: sql.length }` (and active dialect), then add a multi-statement test proving every parsed statement is passed to `runStatements`.

### Round 1 Remediation
Status: Addressed
- CSS delivery is now explicit: Console rules stay in `webview/styles.css`, its existing `webview/main.ts` import emits `dist/webview.css`, and TASK-003 links that asset using `asWebviewUri` under the existing local `style-src` CSP; TASK-003 tests the HTML/CSP contract.
- Execution is now explicit: Console calls `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)` and passes every returned statement to `runStatements`; TASK-003 tests a two-statement buffer in source order.

### Round 2
Status: Approved
- CSS asset contract is concrete and matches `SchemaForm.buildHtml`: `webview/main.ts` emits `dist/webview.css`, and TASK-003 links it via `asWebviewUri` under the local `style-src` CSP.
- Full-buffer execution is concrete and correct: `sqlToRun(sql, { start: 0, end: sql.length }, 0, mgr.getActive()?.driver)` takes the parser selection branch, splits the entire buffer in active dialect, and the two-statement test verifies source-order delegation.
- Completeness, consistency, scope, and YAGNI remain sound; no new implementation-blocking issue found.
