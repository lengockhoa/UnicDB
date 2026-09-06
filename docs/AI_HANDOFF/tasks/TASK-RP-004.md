# TASK-RP-004 — Bottom-panel regression net (integration + source/manifest scan)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4 (Test Plan), §6 AC1, AC5, AC7

## Goal

Add the final regression net that proves the user's bug cannot return: the Results webview
renders rows through the bottom-panel view path, the manifest ids and the registered provider
agree, `show()` can never land an editor-area panel again, and no placement setting/token
remains anywhere in the touched sources. This is the cycle's full-suite gate.

## Target Files

- `src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts` — (new) all tests below. Single file; no other file is touched.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug fix — source scan) | `resultsPanel.ts no longer contains editor-area placement machinery` | `readFileSync("src/ui/resultsPanel.ts","utf8")` contains NONE of: `createWebviewPanel`, `moveEditorToBelowGroup`, `moveEditorToAboveGroup`, `resultsPlacement`, `readPlacementSetting`. RED against current HEAD (all five tokens exist today at resultsPanel.ts:322, 355-359, 263, 105, 117, 236) | raw source string |
| 2 | regression (bug fix — manifest scan) | `package.json has a panel container and zero placement config` | `JSON.parse(readFileSync("package.json"))`: `contributes.viewsContainers.panel` present with id `UnicDB-results`; raw string does NOT contain `resultsPlacement`; `activationEvents` contains `onView:UnicDB.results` | raw + parsed manifest |
| 3 | happy (end-to-end render) | `results render rows through the bottom-panel view ready handshake` | Build `ResultsPanel` with a runner stub; `panel.render([{index:0, sql:"SELECT id, name FROM t", status:"done", result:{columns:["id","name"], rows:[[1,"a"],[2,"b"]], rowCount:2, durationMs:1}}], "q at T")`; `provider.resolveWebviewView(fakeView)` (provider captured from the `registerWebviewViewProvider` mock); `dispatch({type:"ready"})` → the posted state message has `results.length === 1`, `results[0].result.rows` deep-equals `[[1,"a"],[2,"b"]]`, `header === "q at T"`, `busy === false` | vscode mocked (`window.registerWebviewViewProvider` captures `(viewId, provider)`; `commands.executeCommand` spy) |
| 4 | edge (boundary/count) | `show() executes exactly the container focus command and never creates a panel` | Call `show()` twice → `executeCommand` spy called exactly 2 times, both with `"UnicDB-results.focus"`; `createWebviewPanel` spy (throwing implementation) called 0 times; `containerId + ".focus"` derived from the on-disk manifest equals the executed command string | same vscode mock |
| 5 | edge (consistency) | `registered viewId, manifest view id and focus command all agree` | `registerWebviewViewProvider` mock's captured `viewId === "UnicDB.results" === manifest.contributes.views["UnicDB-results"][0].id`; `ResultsPanel.viewId` equals both | same fixture as 3–4 |
| 6 | regression (behavior preserved — stale guard) | `hidden view + re-render + resolve still delivers the LATEST state once` | `render(v1)` → `render(v2)` (both while unresoled) → `resolveWebviewView` + `ready` → exactly ONE state message and its `results` equal `v2` (not v1), proving buffer-overwrite semantics survived the migration | two distinct statement arrays |

## Test Files

- `src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts` — (new) cases 1–6.

## Verification Commands

```bash
npm test src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts
npm run typecheck
npm run compile
npm test
```

The final `npm test` (full suite) is the cycle gate — it must be green.

(No lint script exists in this repo — `typecheck` + `compile` are the static gates.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (cases 1, 2 are RED against pre-fix code — verified by reading current `resultsPanel.ts`/`package.json`, not by reverting).
- [ ] Full `npm test` suite passes (no regression anywhere).
- [ ] `npm run typecheck && npm run compile` pass.
- [ ] No file other than the new test file changed in this task (`git status` clean apart from prior tasks' files).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-RP-001 must complete first (provider implementation + `ResultsPanel.viewId`).
- TASK-RP-003 must complete first (panel container/view/activation in the on-disk manifest).

## Interfaces

- Consumes:
  - `ResultsPanel.viewId` (static, `"UnicDB.results"`) — TASK-RP-001
  - `vscode.window.registerWebviewViewProvider` capture pattern from `resultsPanel.test.ts`'s adapted mock — TASK-RP-001
  - manifest contract: `viewsContainers.panel[0].id === "UnicDB-results"`,
    `views["UnicDB-results"][0].id === "UnicDB.results"`,
    `activationEvents ⊇ {"onView:UnicDB.results"}`, no `resultsPlacement` — TASK-RP-003
- Produces: the cycle's regression gate; nothing downstream.

---

## Discussion

### 2026-09-06 · planner · unic-smart
- Cases 1–2 are the "test thật kỹ" guarantee: they read the actual files from disk, so any
  future re-introduction of `createWebviewPanel`/`resultsPlacement` fails CI even if behavior
  tests are mocked around it.
- Case 3 deliberately renders REAL `StatementResult` fixtures (columns + 2 rows) and asserts
  deep-equal rows on the wire message — this is the proof the user's actual scenario (run SQL →
  rows appear in the bottom panel) works end-to-end at the host/webview boundary.
- Keep this file self-contained (own vscode mock) — do not import from
  `resultsPanel.test.ts` so the two suites can evolve independently.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
