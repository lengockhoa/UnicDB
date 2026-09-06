# TASK-RP-001 — Convert ResultsPanel to a bottom-panel WebviewViewProvider

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Migration inside `ResultsPanel`), §6 AC3

## Goal

Replace the `vscode.window.createWebviewPanel` shell of `ResultsPanel` with a
`vscode.WebviewViewProvider` whose view lives in the bottom panel container (next to
Terminal), and delete every `UnicDB.resultsPlacement` / editor-placement code path. Register
the provider in `extension.ts`. Keep ALL results behavior (render, loadMore, cancel, saveEdits,
manual commit/rollback, retry, requery, distinct values, closeTab family, export, copy,
sanitization, CSP, `ready` handshake, session-epoch stale guards) unchanged.

## Target Files

- `src/ui/resultsPanel.ts` — implement `vscode.WebviewViewProvider`; swap `panel: WebviewPanel` for `view: WebviewView`; rewrite `show()`; delete `readPlacementSetting`, `canExecuteCommands`, `resultsPlacement` option/field, `viewColumn` option, the `onDidChangeConfiguration` auto-dispose listener, and the `moveEditorToBelowGroup`/`moveEditorToAboveGroup` branch.
- `src/extension.ts` — after `new ResultsPanel({ runner, saveContext })` (line ~474), register: `vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } })`; push the returned Disposable into `context.subscriptions`.
- `src/ui/__tests__/resultsPanel.test.ts` — swap the `createWebviewPanel` mock for a `registerWebviewViewProvider` + `resolveWebviewView(FakeWebviewView)` mock; rewrite/delete the `resultsPlacement` describes (T1–T7a and the `AI-001`/`TASK-AI-001-fix`/`TASK-UX1-006` blocks, ~lines 973–1400). **This includes deleting the T3a manifest test at `resultsPanel.test.ts:1043`** ("package.json manifest declares UnicDB.resultsPlacement") — it exists only to lock the placement code this task removes, and TASK-RP-003 later deletes the property from `package.json` (review round 1, Option A). Every other test keeps its semantics with the new shell.
- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` — at most a comment/mock touch-up: line ~104 mentions the removed `UnicDB.resultsPlacement` auto-dispose listener; update the comment and drop any now-dead config-listener mock wiring if the suite references it.
- `src/extension.test.ts` — add `window.registerWebviewViewProvider: vi.fn()` to the vscode mock (line ~109 area); update results-flow tests that index `createWebviewPanel` calls with viewType `UnicDB.results` (lines ~3796, ~3849, ~3920) to drive the registered provider's `resolveWebviewView` instead.
- `src/ui/__tests__/resultsPanelViewProvider.test.ts` — (new) the TDD tests below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `resolveWebviewView wires html, options and message handler; ready handshake posts state` | After `provider.resolveWebviewView(fakeView)`: `webview.options.enableScripts === true`, `webview.options.localResourceRoots` includes `<extUri>/dist`, `webview.html` contains `Content-Security-Policy` and `dist/webview.js`; `dispatch({type:"ready"})` → `postMessage` called with `{type:"state", header, results, busy:false}` and then `{type:"transactionStatus", open:false}` | `ResultsPanel` with runner stub; `render([stmt], "q at T")` BEFORE resolve (buffered) |
| 2 | edge (lifecycle ordering) | `render before the view exists never posts; buffered state delivered once after resolve+ready` | Between `render()` and `resolveWebviewView`: zero `postMessage` calls, no throw; after resolve + `ready`: exactly ONE state message carrying the full buffered `lastResults` (rows `[[1,"a"],[2,"b"]]`) | render called with 2 statements while `view === null` |
| 3 | edge (concurrency) | `dispose mid-requery suppresses stale continuation into a re-created view` | `resolveWebviewView(viewA)` → start requery (runner.runSql pending) → fire `viewA`'s `onDidDispose` → `resolveWebviewView(viewB)` → runSql resolves → NO postMessage into viewB's webview, `viewB` busy stays `false`, `showErrorMessage` NOT called | runner.runSql returns a controllable promise; requery triggered via `dispatch({type:"requery", index:0, ...})` |
| 4 | regression (bug fix) | `show() never creates an editor-area WebviewPanel; reveals via UnicDB-results.focus` | `vscode.window.createWebviewPanel` mock called 0 times (RED on current code — `resultsPanel.ts:322` calls it); `vscode.commands.executeCommand` called with exactly `("UnicDB-results.focus")` on every `show()`; two `show()` calls → exactly 2 executeCommand calls, still 0 createWebviewPanel | Fresh `ResultsPanel`; mocked `vscode.window` + `vscode.commands` |
| 5 | unit | `dispose() disposes the live view and rolls back an open transaction` | After `dispose()`: `view.dispose` spy called, subsequent `postMessage` is a no-op, `runner`'s fake transaction `rollback` awaited | open manual transaction via `saveContext.getManualCommit()===true` + saveEdits dispatch |
| 6 | unit (removed API) | `constructor no longer accepts resultsPlacement/viewColumn and no config listener is registered` | `new ResultsPanel({ runner, saveContext, resultsPlacement: "beside" } as any)` compiles-at-runtime ignoring the extra key AND `workspace.onDidChangeConfiguration` mock called 0 times; `getConfiguration` never called during show/render | vitest mocks for `workspace.*` with call-count spies |

## Test Files

- `src/ui/__tests__/resultsPanelViewProvider.test.ts` — (new) cases 1–6.
- `src/ui/__tests__/resultsPanel.test.ts` — adapted existing suite (mock swap; placement describes replaced by case-4-style assertions).
- `src/extension.test.ts` — adapted results-flow suite.

## Verification Commands

```bash
npm test src/ui/__tests__/resultsPanelViewProvider.test.ts
npm test src/ui/__tests__/resultsPanel.test.ts
npm test src/ui/__tests__/resultsPanelClose.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/resultsPanelRetry.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelErrorIntegration.test.ts src/ui/__tests__/resultsPanelCloseWiring.test.ts
npm test src/extension.test.ts
npm run typecheck
npm run compile
```

(No lint script exists in this repo — `typecheck` + `compile` are the static gates.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (case 4 and 6 are RED against current code before the edit).
- [ ] `src/ui/resultsPanel.ts` contains no occurrences of `createWebviewPanel`, `moveEditorToBelowGroup`, `moveEditorToAboveGroup`, `resultsPlacement`, `readPlacementSetting`, `canExecuteCommands`.
- [ ] The T3a manifest test (`resultsPanel.test.ts:1043`, asserting `UnicDB.resultsPlacement` IS declared in package.json) is deleted together with its placement `describe` block — after this task, NO test anywhere asserts the setting's presence (prerequisite for TASK-RP-003's wave-2 property deletion).
- [ ] `src/extension.ts` calls `registerWebviewViewProvider("UnicDB.results", panel, { webviewOptions: { retainContextWhenHidden: true } })` and pushes the Disposable.
- [ ] All sibling `resultsPanel*.test.ts` suites and `extension.test.ts` pass.
- [ ] `npm run typecheck` and `npm run compile` pass.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: existing `ResultsPanel` internals (`render`, `postMessage`, `handleMessage`, `buildHtml`, `sessionEpoch` guards) — unchanged signatures; `vscode.WebviewViewProvider` (`resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): void | Thenable<void>`).
- Produces (TASK-RP-003 / TASK-RP-004 rely on these):
  - `export class ResultsPanel implements vscode.WebviewViewProvider`
  - `public static readonly viewId = "UnicDB.results"` (static string constant)
  - `resolveWebviewView(view: vscode.WebviewView): void` (sync is fine)
  - `constructor(options: { runner: QueryRunner; title?: string; saveContext?: SaveContext })` — `resultsPlacement` and `viewColumn` REMOVED from `ResultsPanelOptions`
  - `show(): void` — executes `vscode.commands.executeCommand("UnicDB-results.focus")`; never calls `vscode.window.createWebviewPanel`

---

## Discussion

### 2026-09-06 · planner · unic-smart
- The `ready` handshake (`resultsPanel.ts:1109-1118`) already solves the lazy-resolution problem: a webview view may resolve long after `render()`; the host posts nothing while `this.view === null`, and the webview JS's `ready` message triggers the full-state post. Do NOT add a second buffering mechanism.
- Keep the view id `UnicDB.results` (the old viewType string) so `package.json`'s `webview/UnicDB.results/context` Help-Grid menu (`package.json:433`) and `extension.test.ts:4849`'s assertion keep working for the webview view without edits.
- `extension.ts` line 474 already passes only `{ runner, saveContext }`, so removing the options breaks no caller — but the register call is what makes `ResultsPanel` satisfy `WebviewViewProvider` structurally; without it `typecheck` fails. This is why registration is inside THIS task.
- `extension.test.ts` results-flow tests currently fish panels out of `createWebviewPanel` calls (e.g. lines 3796/3849/3920). Rewrite them to grab the captured provider from the `registerWebviewViewProvider` mock and call `resolveWebviewView(new FakeWebviewView())`. The console panel (`UnicDB.console`) tests stay untouched — console remains an editor panel.
- Do not touch `package.json` in this task — TASK-RP-003 owns it (wave ordering keeps the old T3a manifest test, which reads package.json from disk, deterministic until TASK-RP-001's rewrite removes it here).
- Review round 1 (Option A): the T3a gap is closed HERE. Deleting the placement describe block (which contains T3a at line 1043) in wave 1 guarantees that when TASK-RP-003 deletes the property from package.json in wave 2, no test asserts its presence — no unowned red between waves.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
