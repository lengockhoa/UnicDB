# PLAN — Cycle RP: SQL Results forced into the bottom Panel area

## §1 Intent

The user ran SQL after previous placement fixes (AI-001 `resultsPlacement` below/beside/top,
then the hot-apply fix) and the results STILL landed in the wrong place: side-by-side with the
SQL editor or pushed below the editor — both of which are the **editor area**, not the bottom
**panel area** where Terminal / Problems / Output live. The user wants results forced DOWN into
the bottom panel, as a tab next to Terminal. They explicitly do NOT want editor-area placement
and do NOT want the right sidebar. Per the follow-up clarification: **drop the
`UnicDB.resultsPlacement` setting entirely — bottom panel is the only placement, mandatory, not
configurable.** The user explicitly asked for thorough testing ("test thật kỹ").

Success looks like:

1. Running any query opens/raises a tab in the VS Code **bottom panel container**
   (`viewsContainers.panel`), next to Terminal — never an editor tab, never a sidebar view.
2. `UnicDB.resultsPlacement` no longer exists: not in `package.json` contributes, not read by
   any code path. No `createWebviewPanel`, no `moveEditorToBelowGroup` /
   `moveEditorToAboveGroup`, no editor-area fallback of any kind.
3. Every existing results behavior survives: multi-tab results, loadMore, cancel, saveEdits
   (+ manual commit/retry/requery), distinct values, closeTab/closeAllTabs/closeOthersTabs,
   export, copy, BigInt sanitization, CSP, session-epoch stale guards.
4. A regression net (new tests) proves the bug cannot come back, and the existing suites stay
   green.

## §2 Scope

**In scope**

- `package.json` manifest: add `viewsContainers.panel` (container id `UnicDB-results`), add a
  `views` entry for that container with a `webview` view of id `UnicDB.results`, add
  `onView:UnicDB.results` activation event, and **delete** the `UnicDB.resultsPlacement`
  configuration property.
- `src/ui/resultsPanel.ts`: replace the `createWebviewPanel` path with a
  `vscode.WebviewViewProvider` (`resolveWebviewView`); delete `readPlacementSetting`,
  `ResultsPanelOptions.resultsPlacement`, `ResultsPanelOptions.viewColumn`, the placement
  field, the `onDidChangeConfiguration` disposal listener, the `moveEditorToBelowGroup` /
  `moveEditorToAboveGroup` call and its `canExecuteCommands()` helper.
- `src/extension.ts`: register the provider via
  `vscode.window.registerWebviewViewProvider(...)` with
  `webviewOptions: { retainContextWhenHidden: true }`.
- Test adaptation: `src/ui/__tests__/resultsPanel.test.ts` (vscode mock swap + placement
  describes rewritten), `src/extension.test.ts` (new mock + results-flow assertions updated),
  `src/ui/__tests__/userGuideContent.test.ts` (#4 flipped).
- New tests: `resultsPanelViewProvider.test.ts`, `resultsPanelViewManifest.test.ts`,
  `resultsPanelBottomPanelIntegration.test.ts`.
- Docs: `docs/UNICDB_USER_GUIDE.md` — remove the setting bullets, document the forced
  bottom-panel behavior.

**Out of scope (this cycle)**

- Any new results UI features (grid, styling, export formats) — behavior must stay
  byte-compatible.
- Sidebar (`activitybar`/`secondarySidebar`) views — untouched; the admin tree stays where it
  is.
- Version bump / CHANGELOG / `vsce publish` — that is the P3/release lane per
  `docs/RELEASE.md`.
- `WebviewViewSerializer` (restore results across window reloads) — nice follow-up, not
  required to fix the user's bug.

**CONSTRAINT honored:** no two tasks in the same wave share a Target File (see task file
ownership in §3/§6 and each task's Target Files).

## §3 Approach

**Architectural choice — a real panel-area webview view.** VS Code's bottom panel (the region
holding Terminal/Problems/Output) is a *different* workbench region from the editor area; a
`WebviewPanel` created with `createWebviewPanel` can never live there, and
`workbench.action.moveEditorToBelowGroup` only moves things *within* the editor area — which is
exactly why the previous two fix rounds failed. The only supported way to host a webview in the
panel is:

- `contributes.viewsContainers.panel` → container `{ "id": "UnicDB-results", "title":
  "UnicDB Results", "icon": "media/UnicDB.svg" }` (icon already exists — verified).
- `contributes.views["UnicDB-results"]` → `{ "type": "webview", "id": "UnicDB.results",
  "name": "Results" }`.
- `vscode.window.registerWebviewViewProvider("UnicDB.results", provider)` in `extension.ts`.
- Reveal via `vscode.commands.executeCommand("UnicDB-results.focus")` — opens the panel
  container and focuses the Results tab, i.e. literally "next to Terminal".

The view id deliberately stays `UnicDB.results` (the old `createWebviewPanel` viewType). The
`webview/UnicDB.results/context` menu contribution (Help Grid, `package.json:433` and
`extension.test.ts:4849`) keys off the view id and keeps working unchanged for webview views.

**Migration inside `ResultsPanel`** (keeps ALL behavior): the class currently owns
`panel: WebviewPanel | null` plus the entire message/state machine (`render`, `postMessage`,
`handleMessage` with loadMore/cancel/copy/exportFile/saveEdits/retryFailedRows/requery/
requestDistinctValues/commit/rollback/ready/closeTab family, sanitize, sessionEpoch guards).
The conversion only swaps the *shell*:

- `class ResultsPanel implements vscode.WebviewViewProvider`, `public static readonly viewId =
  "UnicDB.results"`.
- `resolveWebviewView(view)`: set `view.webview.options = { enableScripts: true,
  localResourceRoots: [<extUri>/dist] }`, assign `view.webview.html = this.buildHtml(view.webview)`
  (same HTML/CSP/template as today), subscribe `webview.onDidReceiveMessage` and
  `view.onDidDispose` (same epoch-bump + rollback + null-out as today's `panel.onDidDispose`).
- `show()`: no creation at all — always `executeCommand("UnicDB-results.focus")`. The view
  resolves lazily; the **existing `ready` handshake** (webview JS posts `ready` → host replies
  with full `lastResults` state, `resultsPanel.ts:1109`) already covers the
  "render() happened before the view existed" case: `postMessage` no-ops while `this.view` is
  null, and the buffered `lastResults` are delivered on `ready`. No new buffering code needed.
- `dispose()`: `this.view?.dispose()` instead of `panel.dispose()`; `isVisible()` reads
  `this.view !== null && this.view.visible`.
- Deleted outright: `readPlacementSetting()`, `canExecuteCommands()`, the
  `resultsPlacement` option/field, `viewColumn` option, the
  `onDidChangeConfiguration("UnicDB.resultsPlacement")` auto-dispose listener, and the
  `moveEditorToBelowGroup`/`moveEditorToAboveGroup` branch in `show()`.
- Retained unchanged: `retainContextWhenHidden` semantics come from the provider registration
  option (`webviewOptions: { retainContextWhenHidden: true }` in extension.ts) so a hidden
  (backgrounded) Results tab keeps its state, matching today's editor-panel behavior; CSP,
  `buildHtml`, sanitize, all 11 postMessage sites, requerySeq/statementGeneration/sessionEpoch
  guards — untouched.

**Setting removal (per user clarification — breaking, intentional):** the
`UnicDB.resultsPlacement` property is deleted from `contributes.configuration` — no deprecation
alias, no fallback, no `below` default. Users who had set it simply stop having the knob; VS
Code leaves unknown settings inert in `settings.json` (harmless). The user guide is updated in
the same cycle to say results always open in the bottom panel.

**Alternatives rejected:**

- *Keep `createWebviewPanel` + smarter move commands* — impossible: no command moves an editor
  tab into the panel region; two fix rounds (AI-001, AI-001-fix) already proved this path.
- *Secondary sidebar view* — explicitly forbidden by the user ("not the right sidebar").
- *Alias the setting to a single value* — rejected by the user's follow-up: "Bỏ luôn setting"
  (drop the setting entirely).
- *Split extension registration into its own task* — rejected: `extension.ts` calling
  `registerWebviewViewProvider(viewId, panel)` does not compile until `ResultsPanel`
  implements `WebviewViewProvider`, and `extension.test.ts` results-flow assertions break the
  moment the conversion lands without the registration. They are one atomic unit and are one
  task (RP-001).

**Test strategy (user demanded thorough testing):** TDD RED→GREEN. The regression net asserts
BOTH behavior (no editor-area API call ever happens; the view resolves and renders rows through
the `ready` handshake; stale-session dispose guard still holds) AND source/manifest shape (no
`createWebviewPanel`/`moveEditorToBelowGroup`/`resultsPlacement` tokens remain in
`resultsPanel.ts`; manifest ids agree with the registered view id and the focus command). The
source-scan regression test is RED against current HEAD (the tokens are present today) — a true
fails-before-fix test.

**Task / wave design** (file ownership, zero same-wave collisions):

| Wave | Task | Owns (exclusive) |
|------|------|------------------|
| 1 | TASK-RP-001 core migration | src/ui/resultsPanel.ts, src/extension.ts, src/ui/__tests__/resultsPanel.test.ts (incl. **deleting the T3a manifest test at `resultsPanel.test.ts:1043`** with the rest of the AI-001 placement describe block), src/extension.test.ts, src/ui/__tests__/resultsPanelErrorIntegration.test.ts (comment/mock touch-up only), src/ui/__tests__/resultsPanelViewProvider.test.ts (new) |
| 1 | TASK-RP-002 docs | docs/UNICDB_USER_GUIDE.md, src/ui/__tests__/userGuideContent.test.ts |
| 2 | TASK-RP-003 manifest | package.json, src/ui/__tests__/resultsPanelViewManifest.test.ts (new) |
| 3 | TASK-RP-004 regression net | src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts (new) |

RP-003 deliberately follows RP-001: the old `resultsPanel.test.ts` T3a asserts the manifest
DECLARES `resultsPlacement` (reads `package.json` from disk at `resultsPanel.test.ts:1043`).
**Ownership (review round 1, Option A): TASK-RP-001 deletes T3a in wave 1**, together with the
rest of the AI-001 placement describe block it belongs to (that `describe` only exists to lock
the placement code RP-001 removes). TASK-RP-003 therefore never touches
`resultsPanel.test.ts` and owns only `package.json` + its new manifest test, so the wave-2
package.json deletion cannot strand an unowned failing test. Sequencing keeps every wave
boundary fully green. RP-004 needs both the converted
module (RP-001) and the final manifest (RP-003). The graph is chain-shaped at the tail; this is
a genuine artifact/test coupling, not an ordering preference — RP-001+RP-002 parallelism is the
width win.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | resolveWebviewView wires html + message handler; dispatch `ready` → host posts full state | `webview.html` contains `Content-Security-Policy`, `dist/webview.js`; state message carries `header` + `results` + `busy:false` |
| happy | run query flow (extension.test results path) → results appear via the registered view, not an editor tab | `registerWebviewViewProvider` called once with `"UnicDB.results"`; `createWebviewPanel` NOT called for `UnicDB.results` |
| edge (lifecycle ordering) | `render()` called before the view is ever resolved | no throw, no postMessage; after `resolveWebviewView` + `ready`, the buffered `lastResults` state posts exactly once |
| edge (concurrency) | `onDidDispose` fires mid-requery, then a new view resolves and `render()` runs | old continuation suppressed by `sessionEpoch`: no postMessage/toast/busy write into the new view |
| regression (bug fix) | `show()` placement | `vscode.window.createWebviewPanel` is never called (spy asserts 0 calls); `executeCommand("UnicDB-results.focus")` IS called |
| regression (bug fix) | source/manifest scan (RP-004) | `src/ui/resultsPanel.ts` contains none of `createWebviewPanel` / `moveEditorToBelowGroup` / `moveEditorToAboveGroup` / `resultsPlacement`; RED on current HEAD |
| edge (manifest negative) | setting removal | `contributes.configuration.properties` has NO `UnicDB.resultsPlacement` key; the old T3a test that asserted the key EXISTS (`resultsPanel.test.ts:1043`) is deleted in wave 1 by TASK-RP-001 — no test anywhere asserts the setting's presence after RP-001 lands |
| edge (manifest consistency) | id agreement | `views["UnicDB-results"][0].id === "UnicDB.results"` === `ResultsPanel.viewId`; `viewsContainers.panel[0].id + ".focus"` is the command `show()` executes; `activationEvents` contains `onView:UnicDB.results` |
| edge (partial host) | vscode mock lacks `window.registerWebviewViewProvider` | extension activation does not crash (guarded call path) |
| docs | guide content flip | `docs/UNICDB_USER_GUIDE.md` does NOT contain `UnicDB.resultsPlacement`; DOES document bottom-panel (cạnh Terminal) placement |
| regression (behavior preserved) | existing suites | `resultsPanel*.test.ts` (requery, saveEdits, distinct, retry, close, orderBy, serverFilter, errorIntegration) + `extension.test.ts` + `userGuideContent.test.ts` all pass unchanged in their expectations that are unrelated to placement |

## §5 Verification

Project scripts (verified in `package.json` §scripts): `test` = `vitest run`,
`typecheck` = `tsc --noEmit`, `compile` = `node esbuild.js`, `verify:fast` = typecheck +
compile. **There is no lint script in this repo** (stated explicitly per gate rule — nothing to
include).

Per-task commands are in each `tasks/TASK-RP-00x.md`; the cycle-level gate is:

```bash
npm run typecheck
npm run compile
npm test
```

`npm test` (full suite) is the final gate, run by TASK-RP-004.

## §6 Acceptance Criteria

- [ ] **AC1** — `UnicDB.resultsPlacement` setting is removed from package.json; code that reads
      it is deleted; no fallback to editor-area placement remains. *(TASK-RP-003 for the
      manifest, TASK-RP-001 for the code deletion, TASK-RP-004 scan test as proof.)*
- [ ] **AC2** — `package.json` declares `viewsContainers.panel` (id `UnicDB-results`), a webview
      view `UnicDB.results` inside it, and `onView:UnicDB.results` activation.
      *(TASK-RP-003.)*
- [ ] **AC3** — `ResultsPanel` implements `vscode.WebviewViewProvider`; `extension.ts` registers
      it with `webviewOptions: { retainContextWhenHidden: true }`; `show()` reveals via
      `UnicDB-results.focus` only. *(TASK-RP-001.)*
- [ ] **AC4** — All existing results behaviors preserved; the suites listed in §4
      "regression (behavior preserved)" pass. *(TASK-RP-001; full-suite proof in TASK-RP-004.)*
- [ ] **AC5** — Regression net exists and is RED against pre-fix code (source-scan +
      no-createWebviewPanel assertions). *(TASK-RP-004.)*
- [ ] **AC6** — User guide no longer documents the setting and documents the forced
      bottom-panel placement. *(TASK-RP-002.)*
- [ ] **AC7** — `npm run typecheck && npm run compile && npm test` all pass at cycle close.
      *(TASK-RP-004 final gate; every task also runs typecheck+compile.)*

## §7 Global Constraints

- Engine floor `vscode: ^1.75.0` — panel-area webview views are fully supported; do not raise
  the floor.
- View id MUST remain exactly `UnicDB.results`; container id MUST be `UnicDB-results` (focus
  command `UnicDB-results.focus`); keep the `webview/UnicDB.results/context` menu untouched.
- No new npm dependencies. No `engines`/`main`/publisher changes.
- Results grid behavior must stay byte-compatible: no changes to message protocol types in
  `src/ui/messages.ts`, no changes to sanitization, CSP, or the `ready` handshake contract.
- `retainContextWhenHidden` moves to the provider registration option; do not attempt to set it
  per-view (WebviewView has no such per-instance property).
- Breaking-change rule: the setting removal is intentional and user-approved; do NOT soften it
  into a deprecation alias. (Release lane will record it in CHANGELOG per `docs/RELEASE.md`.)
- This repo has no lint script; `npm run typecheck` + `npm run compile` are the static gates.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: merged extension registration into TASK-RP-001 (compile-coupled both directions with the conversion via `registerWebviewViewProvider` typing and `extension.test.ts` results-flow assertions — separate tasks would have shipped a red suite between waves); sequenced TASK-RP-003 after TASK-RP-001 because old `resultsPanel.test.ts` T3a reads `package.json` from disk and asserts the setting IS declared. Review round 1 (Option A applied): T3a deletion is now pinned explicitly to TASK-RP-001's Target Files + Acceptance Criteria (was implied by file ownership, now line-level explicit); `resultsPanelErrorIntegration.test.ts` added to RP-001 for the stale comment/mock touch-up.
Known gaps: no `WebviewViewSerializer` — results grid does not restore across full window reloads (out of scope; the old editor panel didn't restore either). Wave tail is a chain (RP-001 → RP-003 → RP-004) driven by real test-coupling, not ordering preference; only wave 1 has parallelism.

## Plan Review Log

### Round 1 — 2026-09-06 · unic-smart
Status: Issues Found
Findings:
  - PLAN.md §3 wave table / §2 Scope (coupling with src/ui/__tests__/resultsPanel.test.ts:1043) — T3a ownership gap: T3a (inside describe "ResultsPanel — resultsPlacement (AI-001)", resultsPanel.test.ts:983) reads package.json from disk and asserts `UnicDB.resultsPlacement` IS declared. TASK-RP-003 (wave 2) deletes the property but owns only package.json + resultsPanelViewManifest.test.ts — not resultsPanel.test.ts. T3a still passes during wave 1 (manifest untouched), so RP-001's executor has no signal to rewrite or delete it; after RP-003 lands, T3a fails and the wave-2 boundary is red with an unowned fix. "placement describes rewritten" is too vague to guarantee T3a's fate.
  - COMPLETENESS: none — all 6 mandatory sections present; "## Planner Report" footer with PLANNER_MODEL present; no placeholders. §5 no-lint claim verified against package.json scripts (test/typecheck/compile/verify:fast exist, no lint script).
  - CONSISTENCY: none beyond the T3a gap — ACs map 1:1 to tasks; cited line numbers verified (resultsPanel.test.ts:1043 T3a, extension.test.ts ~4849 context menu, resultsPanel.ts ~1109 ready handshake, package.json:689 resultsPlacement, :433 context menu, :35 activationEvents exists); viewsContainers currently has only activitybar, so "add viewsContainers.panel" is accurate.
  - CLARITY: none beyond the T3a gap — exact tokens to delete, exact ids, migration steps, and TDD-RED evidence plan are executor-ready.
  - SCOPE: none — tight in/out lists; docs update minimal.
  - YAGNI: none — alias/fallback explicitly rejected per user; serializer deferred; no new deps. User's 3 constraints all honored (setting dropped entirely; forced bottom-panel tab next to Terminal; zero editor-area fallback). AC1 includes the "setting removed from package.json" check.
Required changes:
  - PLAN.md §3: add one explicit line — TASK-RP-001 deletes T3a (resultsPanel.test.ts:1043) together with the rest of the AI-001 placement describe; OR extend TASK-RP-003's Target Files to include the T3a update in resultsPanel.test.ts (different wave, so no same-wave ownership collision).
NOTES: Planner self-reports unic-smart and reviewer is config-bound to unic-smart (handoff.reviewer.model); mustDifferFromExecutor applies to Phase 3 code review where an executor exists — no isolation refusal at plan stage. All other plan claims verified against the repo and approved on their merits.

### Round 2 — 2026-09-06 · unic-smart
Status: Approved
Findings:
  - Round-1 T3a ownership gap (resultsPanel.test.ts:1043): RESOLVED via Option A. §3 wave table (line 146) now lists `src/ui/__tests__/resultsPanel.test.ts` explicitly under TASK-RP-001 with the line-level instruction "deleting the T3a manifest test at `resultsPanel.test.ts:1043`" together with the rest of the AI-001 placement describe block; the "Ownership (review round 1, Option A)" paragraph (§3 lines 151-158) and the §4 "edge (manifest negative)" row (line 173) pin the same fact — "no test anywhere asserts the setting's presence after RP-001 lands". TASK-RP-003 owns only package.json + resultsPanelViewManifest.test.ts, so the wave-2 manifest deletion can no longer strand an unowned failing test; wave boundaries stay green by construction.
  - COMPLETENESS: none — all mandatory sections present, no placeholders; §5 explicitly declares there is no lint script (gate rule satisfied); Round-1 required change applied exactly as specified.
  - CONSISTENCY: none blocking — wave table, §4 negative-manifest row, AC1, and the self-audit all agree on T3a ownership and the task/file mapping. Non-blocking nit: §2 "Test adaptation" prose list (lines 43-45) omits `resultsPanelErrorIntegration.test.ts`, which the §3 wave table and self-audit own under TASK-RP-001 ("comment/mock touch-up only"); the wave table is the stated ownership authority and each task file carries explicit Target Files, so this prose drift cannot cause a wrong build.
  - CLARITY: none — T3a deletion is now line-level explicit in the wave table; ids, tokens-to-delete, migration steps, and TDD-RED evidence remain executor-ready.
  - SCOPE: none — unchanged from Round 1; version bump/CHANGELOG/publish correctly parked in the P3/release lane.
  - YAGNI: none — setting alias/fallback still rejected per the user's clarification, WebviewViewSerializer still deferred, no new dependencies; all three user constraints (setting dropped entirely, forced bottom-panel tab next to Terminal, zero editor-area fallback) still honored.
Required changes:
  - none
NOTES: Round-1 repo-level line citations were verified in Round 1 and re-affirmed without re-reading sources (Round 2 scoped to PLAN.md per instructions). Planner self-reports unic-smart; reviewer is unic-smart, the config-bound handoff.reviewer.model — the mustDiffer isolation rule applies to Phase 3 code review where a task executor exists, so no isolation refusal at plan stage.
