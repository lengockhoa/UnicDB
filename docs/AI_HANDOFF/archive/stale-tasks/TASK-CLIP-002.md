# TASK-CLIP-002 — Paste matrix semantics (Excel TSV → grid edits; bundle + pure test pin)

<!--
TESTS-ONLY task: pins the existing paste pipeline (paste capture listener → onGridPaste →
parseTsvPaste / applyPasteToDirty / applyRangePasteToDirty) so wave-2 wiring (TASK-CLIP-003)
cannot regress it. Disjoint test files from TASK-CLIP-001 → wave 1 parallel.
-->

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (TASK-CLIP-002), §4 rows CLIP-002, §5 wave 1

## Goal

Pin, at the jsdom bundle level, that a `paste` ClipboardEvent carrying TSV text lands as
dirty grid edits with the documented semantics: focused-cell anchor, range tiling/clipping,
CRLF + trailing-newline normalization (Excel origin), empty-text no-op, filter-input
pass-through, bottom-edge clip, and one undo-stack `cell-edit` per pasted cell. These tests
are the contract the CLIP-003 Cmd/Ctrl+V wiring funnels into.

## Target Files

- `src/ui/__tests__/webviewClipboardPaste.test.ts` — (new) jsdom bundle-eval paste suite.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `paste 2x2 TSV at focused cell marks 2+2 dirty and mirrors into nodes` | `editState.dirtyCount === 4`; snapshot cells `(0,0)="10" (0,1)="x" (1,0)="20" (1,1)="y"`; `gridApi.getRowNode("0").data.id === "10"` after refresh | 3×2 state; `api.setFocusedCell(0, colId "id")`; synthetic `paste` event with `clipboardData.getData` → `"10\tx\n20\ty"` (jsdom `Object.defineProperty` pattern: `aiChatPanelWebviewTask002.test.ts:780`) |
| 2 | happy | `Excel-origin CRLF + trailing newline parses` | paste `"1\r\n2\r\n"` at (0,0) → `dirtyCount === 2`, cells (0,0)=`"1"` (1,0)=`"2"`; no phantom third row | same harness; focused (0,0) |
| 3 | happy | `1x1 clipboard tiles into active 2x2 range` | all 4 range cells `"z"`; `dirtyCount === 4` | build range via mousedown/mousemove on cells, then paste `"z"` |
| 4 | edge (shape) | `3x3 clipboard into 2x2 range clips over-paste` | `dirtyCount === 4` (not 9); values outside range bounds untouched | active 2×2 range; clipboard `"a\tb\tc\nd\te\tf\ng\th\ti"` |
| 5 | edge (empty) | `paste with empty text/plain is a no-op` | `dirtyCount === 0`; zero `copy`/`saveEdits` posts | clipboardData returns `""` (`webview/main.ts:3306` guard) |
| 6 | edge (target) | `paste on filter input is user typing, not a grid edit` | `dirtyCount === 0`; input value unchanged by grid handler | `<input>` appended inside `.UnicDB-grid-host`, focused; paste dispatched on it (`isFilterInput` guard `main.ts:3304`) |
| 7 | edge (boundary) | `paste 2 rows with only 1 displayed row left clips at bottom edge` | only the existing row dirtied; no dirty rowId outside the id space | paste at last row: anchor rowIndex = `getDisplayedRowCount()-1`, clipboard 2 rows (`main.ts:3348` break) |
| 8 | edge (target) | `paste stops before locally-added rows` | rows added via `__UnicDB.addRow()` are never dirtied; walk stops (`serverIndexByRowId` miss, `main.ts:3351`) | addRow then paste spanning server row + local row |
| 9 | regression | existing `resultsGridModelEdit.test.ts` parseTsvPaste/applyPasteToDirty/applyRangePasteToDirty describes | unchanged GREEN | existing file |
| 10 | regression | undo parity: one `cell-edit` pushed per pasted cell, Cmd+Z reverts one | after 4-cell paste `undoStack.canUndo`; one Cmd+Z → `dirtyCount === 3`, cell reverted to server value | harness of `tests/webviewEditHighlight.test.ts` #6 (`webview/main.ts:3393`) |

## Test Files

- `src/ui/__tests__/webviewClipboardPaste.test.ts` — (new) contains tests #1-#8, #10.

## Verification Commands

```bash
npm run typecheck
npm run compile        # REQUIRED — bundle tests eval dist/webview.js; a self-skip is a FAIL
npx vitest run src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
```

## Acceptance Criteria

- [ ] All §Test Cases GREEN (no silent bundle skips).
- [ ] Zero production files modified (`git status` shows only the new test file).
- [ ] `npm run typecheck` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes:
  - Capture-phase `paste` listener on `gridWrap` → `onGridPaste(ev: ClipboardEvent): void` — `webview/main.ts:1401/3300`.
  - `parseTsvPaste(text: string): string[][]` / `applyPasteToDirty(...)` / `applyRangePasteToDirty(...)` — `src/ui/resultsGridModel.ts:1226/1261/1387`.
  - `__UnicDB.editState` / `__UnicDB.addRow` / `__UnicDB.undoStack` / `__UnicDB.gridApi` seams — `webview/main.ts:4523-4592`.
  - Synthetic ClipboardEvent pattern — `aiChatPanelWebviewTask002.test.ts:780-782`.
- Produces: (none) — test-only; TASK-CLIP-003's Cmd/Ctrl+V path MUST route into the same `onGridPaste` dispatch and keep these GREEN.

## Discussion

### 2026-09-10 · planner · unic/unic-smart
-> @executor: jsdom `ClipboardEvent` has no real `clipboardData` — construct with
`new Event("paste", {bubbles:true, cancelable:true})` and `Object.defineProperty(ev,
"clipboardData", {value: {getData: () => text}})`. The bundle reads only
`getData("text/plain")` (`webview/main.ts:3305`).

### 2026-09-10 · executor · unic-code
The required bundle contract test for `1x1 clipboard tiles into active 2x2 range` exposes an existing production mismatch: `pasteIntoRange` marks the two column-1 cells dirty with `""` instead of tiling `"z"`. The task is tests-only, so production code was not changed; the required test remains contract-correct and verification is PARTIAL until the existing behavior is fixed in a production-owned task.

### 2026-09-10 · planner · unic/unic-smart — implementation-discovery revision
-> @reviewer/@executor: this task stays tests-only and its target file is unchanged. Its
executor report above is PRESERVED as historical partial evidence — 8/9 GREEN, with the
9th case (`1x1 clipboard tiles into active 2x2 range`) failing against real production
behaviour in `pasteIntoRange` (`webview/main.ts:3464` pads overhang columns with `""`).
The failing case is a correct contract, not a bad test, so it was NOT relaxed or deleted.
Ownership of the fix moved to TASK-CLIP-003 (now `Dependencies: none`), which re-runs this
whole suite as a required verification target. Re-verification here is gated on
TASK-CLIP-003 landing; this task is `pending_review` (not `ready`) so the executed wave is
not re-run.

---

## Executor Report

STATUS: PARTIAL
EXECUTOR_TOOL: other
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ImplementClipboardPasteTests
SUMMARY: Added the jsdom dist-bundle clipboard-paste matrix covering focused-cell TSV paste, CRLF/trailing newline normalization, active-range tiling/clipping, empty/filter/boundary/local-row guards, and Cmd/Ctrl+Z undo parity. No production files were modified.
TEST_PLAN_FOLLOWED: task §Test Cases / inline — all required cases #1-#8 and #10 are represented in the new bundle suite; the existing behavior mismatch is recorded above rather than changing production code.
FILES_CHANGED:
  - src/ui/__tests__/webviewClipboardPaste.test.ts: new bundle-eval paste matrix test suite
  - docs/AI_HANDOFF/tasks/TASK-CLIP-002.md: Discussion and Executor Report appended
TESTS_ADDED:
  - src/ui/__tests__/webviewClipboardPaste.test.ts: 9 tests covering required cases #1-#8 and #10
RED_OUTPUT: |
  Command: npx vitest run src/ui/__tests__/webviewClipboardPaste.test.ts
  Exit code: 1
  Test Files: 1 failed (1)
  Tests: 9 failed
  Failure reason: dist/webview.js missing — run npm run compile before this test (all 9 tests failed at loadBundle as intended; the harness does not silently skip a missing bundle).
  After compiling the existing bundle, the behavior RED was:
  FAIL  1x1 clipboard tiles into active 2x2 range
  Expected: 0:0=z, 0:1=z, 1:0=z, 1:1=z
  Received: 0:0=z, 0:1="", 1:0=z, 1:1=""
  This is an existing production mismatch in pasteIntoRange; production code was intentionally not modified by this tests-only task.
VERIFICATION:
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > UnicDB@1.53.42 typecheck
    > tsc --noEmit
  command: npm run compile
  result: exit 0
  output_excerpt: |
    > node esbuild.js
    > dist/schemaForm.js 3.0kb
    > dist/schemaForm.js.map 6.7kb
  command: npx vitest run src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
  result: exit 1 (8/9 clipboard tests pass; pure model file passes; 1 clipboard test fails)
  output_excerpt: |
    FAIL  src/ui/__tests__/webviewClipboardPaste.test.ts > ... > 1x1 clipboard tiles into active 2x2 range
    AssertionError: expected { '0:0': 'z', '1:0': 'z', …(2) } to match object { '0:0': 'z', '0:1': 'z', …(2) }
    Test Files 1 failed | 1 passed (2)
    Exit code 1
ISSUES: Required 1x1 range tiling contract fails against current production behavior; no production edit permitted by TASK-CLIP-002. All other required bundle cases and existing resultsGridModelEdit tests pass.
HANDOFF_TO_REVIEWER: no — verification is PARTIAL due to the pre-existing production mismatch and task scope forbids fixing production.
NEXT: Production owner must correct pasteIntoRange 1x1 tiling before this contract can be green and reviewed.

## Reviewer Verdict

(appended by Phase 4)

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run typecheck
  result: exit 0
  command: npm run compile
  result: exit 0 (dist/webview.js rebuilt fresh before tests)
  command: npx vitest run src/ui/__tests__/webviewClipboardPaste.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
  result: 43 pass / 0 fail (webviewClipboardPaste 9/9, resultsGridModelEdit 34/34), exit 0
TEST_PLAN_COVERAGE: all-followed — 9-test bundle suite covers cases #1-#8 and #10; case #9 (resultsGridModelEdit regression suite) re-run GREEN (34/34). RED_OUTPUT contains real failing output (bundle-missing load failure + genuine AssertionError `0:1="" vs "z"`). Tests are real (29 expect() assertions on observable dirty state, node mirrors, message counts, undo stack).
HISTORICAL PARTIAL EXPLANATION: The wave-1 executor (unic-code, subagent ImplementClipboardPasteTests) correctly kept this task tests-only and did not touch production when required case #3 (`1x1 clipboard tiles into active 2x2 range`) exposed a REAL production defect: `pasteIntoRange` sliced clipboard columns with `row[srcColOffset] ?? ""` (webview/main.ts:3464 at the time), padding overhang columns with `""` — observed 0:0="z", 0:1="", 1:0="z", 1:1="". The failing test was the correct contract and was NOT relaxed or deleted; the report was honestly filed PARTIAL (8/9) with the defect handed to the production owner. TASK-CLIP-003 (commit 1b66032) then landed the fix exactly as planned — column index now tiles via `row[srcColOffset % row.length] ?? ""` with the empty-row fallback kept (webview/main.ts:3508) — turning this frozen suite 9/9 GREEN. The frozen test file has zero diff since wave-1 commit a7e4a98 (verified: `git diff a7e4a98..HEAD -- <file>` empty); the regression now passes against real production behavior, not a weakened test.
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - docs/AI_HANDOFF/INDEX.md:24 — task title still carries the stale "PARTIAL report preserved" label; with the tiling fix landed in 1b66032 and this suite 9/9 GREEN, that qualifier is historical only and may read as an open defect to a fresh reader. Informational; no action required for handoff.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Executor model isolation verified (unic/unic-code vs reviewer unic/unic-smart). Acceptance criteria all met: all §Test Cases GREEN, zero production files modified by this task (worktree clean, only ignored dist/ rebuilt by my verification), typecheck exit 0. The task is tests-only; the production tiling correction it exposed is owned and verified under TASK-CLIP-003. Historical PARTIAL is fully resolved — current verification is complete GREEN.
