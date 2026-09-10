# TASK-CLIP-002 — Paste matrix semantics (Excel TSV → grid edits; bundle + pure test pin)

<!--
TESTS-ONLY task: pins the existing paste pipeline (paste capture listener → onGridPaste →
parseTsvPaste / applyPasteToDirty / applyRangePasteToDirty) so wave-2 wiring (TASK-CLIP-003)
cannot regress it. Disjoint test files from TASK-CLIP-001 → wave 1 parallel.
-->

- Status: `ready`
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

---

## Executor Report

(appended by Phase 3)

## Reviewer Verdict

(appended by Phase 4)
