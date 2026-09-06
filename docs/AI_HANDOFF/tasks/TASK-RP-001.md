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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -

SUMMARY: Converted ResultsPanel from `vscode.window.createWebviewPanel` to a
`vscode.WebviewViewProvider` registered via `vscode.window.registerWebviewViewProvider`
under viewId `UnicDB.results`. Deleted all placement-related code paths
(`resultsPlacement`, `viewColumn`, `readPlacementSetting`, `canExecuteCommands`,
`moveEditorToBelowGroup`, `moveEditorToAboveGroup`, onDidChangeConfiguration
auto-dispose listener, the entire `placement` describe block including the
T3a manifest test). Registered the provider in `extension.ts`. Adapted the
mock harness across all 9 sibling `resultsPanel*.test.ts` suites to use the
new `FakeWebviewView` flow (mock `registerWebviewViewProvider` captures
providers; `executeCommand("UnicDB-results.focus")` resolves the latest
provider with a fresh `FakeWebviewView` and sets `lastPanel.current` /
`lastView.current`).

TEST_PLAN_FOLLOWED: task §4 (cases 1-6) and the TDD RED→GREEN contract
captured below.

### RED_OUTPUT (verbatim from initial test run before implementation)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-001

 ❯ src/ui/__tests__/resultsPanelViewProvider.test.ts > ResultsPanel — WebviewViewProvider shell (TASK-RP-001) > case 1: resolveWebviewView wires html, options and message handler; ready handshake posts state
   → Error: Test "..." should have been aborted but completed successfully. Instead received signal: aborted.

 ❯ src/ui/__tests__/resultsPanelViewProvider.test.ts > ResultsPanel — WebviewViewProvider shell (TASK-RP-001) > case 4: show() never creates an editor-area WebviewPanel; reveals via UnicDB-results.focus
   → FAIL  expected 'vi.fn(...)' to not have been called, but it was called with arguments: ['UnicDB.results', 'UnicDB — Results', 2, {...}]

 ❯ src/ui/__tests__/resultsPanelViewProvider.test.ts > ResultsPanel — WebviewViewProvider shell (TASK-RP-001) > case 5: dispose() disposes the live view and rolls back an open transaction
   → FAIL  expected "spy" to be called at least once

 ❯ src/ui/__tests__/resultsPanelViewProvider.test.ts > ResultsPanel — WebviewViewProvider shell (TASK-RP-001) > case 6: constructor no longer accepts resultsPlacement/viewColumn and no config listener is registered
   → FAIL  expected "mock" to not have been called, but it was called 1 times
```

### Verification Output

Command: `npx vitest run src/ui/__tests__/resultsPanelViewProvider.test.ts src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelClose.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsPanelDistinctValues.test.ts src/ui/__tests__/resultsPanelRetry.test.ts src/ui/__tests__/resultsPanelOrderBy.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelErrorIntegration.test.ts src/ui/__tests__/resultsPanelCloseWiring.test.ts src/extension.test.ts`

Result: 320 / 320 passed (12 test files)

Excerpt:
```
 ✓ src/ui/__tests__/resultsPanelViewProvider.test.ts  (6 tests) 106ms
 ✓ src/ui/__tests__/resultsPanel.test.ts              (46 tests) 480ms
 ✓ src/ui/__tests__/resultsPanelClose.test.ts         (11 tests)
 ✓ src/ui/__tests__/resultsPanelRequery.test.ts       (15 tests)
 ✓ src/ui/__tests__/resultsPanelSaveEdits.test.ts     (28 tests)
 ✓ src/ui/__tests__/resultsPanelDistinctValues.test.ts (18 tests)
 ✓ src/ui/__tests__/resultsPanelRetry.test.ts         (3 tests)
 ✓ src/ui/__tests__/resultsPanelOrderBy.test.ts       (16 tests)
 ✓ src/ui/__tests__/resultsPanelServerFilter.test.ts  (16 tests)
 ✓ src/ui/__tests__/resultsPanelErrorIntegration.test.ts (4 tests)
 ✓ src/ui/__tests__/resultsPanelCloseWiring.test.ts   (4 tests)
 ✓ src/extension.test.ts                              (153 tests)
 Test Files  12 passed (12)
      Tests  320 passed (320)
```

Command: `npm run typecheck` — `tsc --noEmit` → exit 0 (no errors)
Command: `npm run compile` — `esbuild` build complete, exit 0

### Files Changed

- src/ui/resultsPanel.ts: refactored to implement vscode.WebviewViewProvider; added public static readonly viewId = "UnicDB.results"; replaced `panel: vscode.WebviewPanel | null` with `view: vscode.WebviewView | null`; rewrote `show()` to execute `UnicDB-results.focus`; added `resolveWebviewView`; deleted `readPlacementSetting`, `canExecuteCommands`, `resultsPlacement`, `viewColumn` options; removed onDidChangeConfiguration listener; updated dispose to use optional `view.dispose()` (test-only hook) then null out the view.
- src/extension.ts: registers `vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } })` and pushes the Disposable into `context.subscriptions`.
- src/ui/__tests__/resultsPanelViewProvider.test.ts (NEW, 472 lines): all 6 TDD cases per task §4.
- src/ui/__tests__/resultsPanel.test.ts: bulk-replaced `new FakeWebviewPanel` with `new FakeWebviewView`, swapped `lastPanel.current` for `lastView.current`, added `ensureResolved()`/`resolveView()` helpers, injected `registerWebviewViewProvider` call after every `new ResultsPanel(...)`, deleted the entire `placement` describe block (which contained the T3a manifest test at the original line 1043), adapted session-epoch and BQ tests to drive the registered provider's `resolveWebviewView`.
- src/extension.test.ts: added `window.registerWebviewViewProvider: vi.fn()` to the vscode mock; recorded registered providers in `state.registeredWebviewViewProviders`. The console panel (`UnicDB.console`) tests stay untouched — console remains an editor panel.
- src/ui/__tests__/resultsPanelClose.test.ts: adapted mock harness (registerWebviewViewProvider + commands.executeCommand auto-resolve on UnicDB-results.focus); added `vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, ...)` injection; added FakeWebviewView/providerStore/lastView declarations.
- src/ui/__tests__/resultsPanelRequery.test.ts: same adaptation as above.
- src/ui/__tests__/resultsPanelSaveEdits.test.ts: same adaptation.
- src/ui/__tests__/resultsPanelDistinctValues.test.ts: same adaptation.
- src/ui/__tests__/resultsPanelRetry.test.ts: same adaptation.
- src/ui/__tests__/resultsPanelOrderBy.test.ts: same adaptation.
- src/ui/__tests__/resultsPanelServerFilter.test.ts: same adaptation.
- src/ui/__tests__/resultsPanelCloseWiring.test.ts: same adaptation (manual edit because file uses a different vi.mock structure).
- src/ui/__tests__/resultsPanelErrorIntegration.test.ts: comment touch-up on line ~104 — the old TASK-AI-001-fix comment referenced the removed UnicDB.resultsPlacement auto-recreate listener; updated to note that the setting was removed in this wave.

### TESTS_ADDED

- src/ui/__tests__/resultsPanelViewProvider.test.ts: 6 tests (case 1 happy resolveWebviewView wiring; case 2 buffered render ordering; case 3 dispose mid-requery suppression; case 4 regression — show() never creates WebviewPanel; case 5 dispose rolls back open transaction; case 6 unit — no resultsPlacement/viewColumn, no config listener).

### ISSUES

- The 9 sibling resultsPanel test files relied on the original `createWebviewPanel` mock setting `lastPanel.current`. With `show()` now executing `UnicDB-results.focus` instead, each sibling test needed: (a) `commands.executeCommand` mock that auto-resolves the latest registered provider with a fresh FakeWebviewView, (b) `registerWebviewViewProvider` capture, (c) explicit `vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, ...)` injection after every `new ResultsPanel(...)`. Implemented via 4 deterministic transformation scripts applied to each file plus manual edits for the closeWiring and close files whose vi.mock structure differed slightly.
- `WebviewView` in production has no `.dispose()` method (VS Code tears the view down via the bottom-panel container and `onDidDispose` fires). Implemented `panel.dispose()` defensively with `(view as { dispose?: () => void } | null)` optional-call so production code never calls it but test fakes can intercept via their own `dispose()` to simulate the host-side teardown.

HANDOFF_TO_REVIEWER: yes — STATUS DONE, all 320 tests pass, typecheck + compile clean.

NEXT: ready for review (TASK-RP-002 already PASS; this is wave-1's last blocker before wave boundary commit + wave-2 TASK-RP-003).

## Reviewer Verdict

VERDICT: CRITICAL
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS (npm run typecheck clean; npm run compile clean; npm test 3619 passed / 0 failed / 2 skipped, exit 0)
FINDINGS:
  critical: src/ui/resultsPanel.ts:233 — show() executes "UnicDB-results.focus" (the viewsContainers.panel CONTAINER id), but VS Code auto-registers focus commands per VIEW (`${viewId}.focus` = "UnicDB.results.focus") and per extension container (`workbench.view.extension.<containerId>`); verified against the installed workbench bundle (`super({id:e.focusCommand?e.focusCommand.id:`${e.id}.focus`,...})`, keybinding `workbench.panel.repl.view.focus`, container pattern `workbench.view.extension.${r.id}`). In production the executed command does not exist: executeCommand rejects, the rejection is swallowed by `void`, and the bottom-panel view is NEVER revealed when a query runs — first-use results stay buffered until the user manually opens the "UnicDB Results" tab. The whole suite is blind to this because all mocks assert the literal wrong string.
  important: fix shape — execute `${ResultsPanel.viewId}.focus` (i.e. "UnicDB.results.focus") and rename the string in the 14 test files that pin it (resultsPanelViewProvider.test.ts case 4; resultsPanelBottomPanelIntegration.test.ts:248 source-scan assertion AND case 4; manualCommit.test.ts mock handler; the adapted sibling suites). The source-scan at resultsPanelBottomPanelIntegration.test.ts:248 currently enforces the BROKEN string, so it must change in the same commit or CI will defend the defect.
  minor: none
NEXT_STATUS_FOR_INDEX: critical_block
NOTES: Test-plan discipline and the provider migration itself are sound; the defect is a wrong command id inherited from the plan text (task §Test Cases case 4 prescribed the container id). One-line source fix + mechanical test-string rename unblocks the cycle.

## Reviewer Verdict (round 2)

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS (npm test = 244 files / 3619 tests passed / 0 failed / 2 skipped; npm run typecheck exit 0; npm run compile exit 0 — re-run fresh at 72f180f)
FINDINGS:
  critical: none — round-1 CRITICAL resolved in a6bcb3b: src/ui/resultsPanel.ts:233 now executes "UnicDB.results.focus" (VIEW id, dot), matching VS Code's per-view focus-command registration; grep "UnicDB-results.focus" over src/ returns 0 matches; all 14 test files pin the dot form.
  important: none
  minor: (1) this task file's own spec text still prescribes the broken string (line 33 §Test Cases row 4, line 78 §Interfaces "UnicDB-results.focus") — superseded by the round-1 verdict but stale on disk; (2) AC2 says resultsPanel.ts contains "no occurrences" of createWebviewPanel/moveEditorTo*, yet the show() doc comment (resultsPanel.ts:227-229) mentions them; the RP-004 gate strips comments before scanning (correct enforcement) so AC wording is stricter than the gate.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Strongest part of the migration: behavior preservation was proven with real buffered-delivery evidence (integration cases 3+6: deep-equal rows, single state post, buffer-overwrite). Round-1 critical is fixed and re-verified fresh; remaining items are doc residue only.
