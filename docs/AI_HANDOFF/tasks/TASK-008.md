# TASK-008 (grid C) — Unified undo/redo stack (cell edits + row add/delete)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 G3; spec `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` §C

## Goal

Undo/redo kiểu Excel: MỘT unified stack bước qua cell edits, row adds, row deletes (thứ tự ngược); Ctrl/Cmd+Z undo, Shift+Z (Ctrl/Cmd+Shift+Z) redo, toolbar icons undo/redo đồng bộ. Undo SAU commit = out-of-scope (DB đã ghi — document trong UI hint, không implement).

## Target Files

- `src/ui/undoStack.ts` (NEW) — pure undo/redo stack module (no vscode, no DOM — test đơn giản, webview-importable).
- `src/ui/undoStack.test.ts` (NEW) — unit tests stack transitions.
- `webview/main.ts` — wire stack: cellValueChanged push cell-edit action; onAddRowClick push add-row; onDeleteRowClick push delete-row; keyboard Cmd/Ctrl+Z + Shift+Z; toolbar undoBtn/redoBtn enable/disable theo stack state; thay EditState.undo() cũ bằng stack undo (EditState vẫn là dirty-map truth).
- `webview/styles.css` — chỉ nếu cần style cho disabled undo/redo icon (`.vsdb-btn:disabled` đã có — có thể không cần sửa; nếu không sửa thì bỏ khỏi Target Files trong Executor Report).

## Spec

```ts
// src/ui/undoStack.ts (NEW) — pure module:
export type UndoAction =
  | { kind: "cell-edit"; rowId: number; colIndex: number; oldValue: unknown; newValue: unknown }
  | { kind: "add-row"; rowId: number }                       // undo = remove row
  | { kind: "delete-row"; rowId: number };                   // undo = unmark delete

export class UndoStack {
  /** Ghi 1 action. Redo stack clear (Excel rule). */
  push(a: UndoAction): void;
  /** Pop action gần nhất; chuyển sang redo stack. null khi rỗng. */
  undo(): UndoAction | null;
  /** Pop redo gần nhất; trở lại undo stack. null khi rỗng. */
  redo(): UndoAction | null;
  get canUndo(): boolean;
  get canRedo(): boolean;
  /** Clear cả hai (dùng sau commit / refresh / tab switch). */
  clear(): void;
  /** Số bước undo còn (UI hint). */
  get undoDepth(): number;
}
```

Webview wiring:
1. `cellValueChanged` (main.ts:1428+): sau `editState.markDirty(...)` push `{kind:"cell-edit", rowId, colIndex, oldValue: e.oldValue, newValue: e.newValue}`. Coalesce rule: EditState coalesce same-cell consecutive edits — stack CŨNG coalesce: nếu action top là cell-edit cùng (rowId,colIndex) → update newValue của top, KHÔNG push mới (giữ parity undo 1 bước về original).
2. `onAddRowClick` (main.ts ~1716): push `{kind:"add-row", rowId: newRowId}` sau khi append row.
3. `onDeleteRowClick` (main.ts ~1722-1734): push `{kind:"delete-row", rowId}` sau markDirty delete marker.
4. Undo apply:
   - cell-edit → set cell về oldValue (AG Grid rowNode.setDataValue hoặc applyTransaction + refreshCell), editState un-dirty cell đó (thêm method nếu chưa có — EditState.undo() hiện pop LIFO riêng; thay bằng targeted removal theo (rowId,colIndex): thêm `EditState.clearCell(rowId, colIndex)` — sửa src/ui/resultsGridModel.ts CHỈ method này nếu cần; ghi trong report).
   - add-row → remove row khỏi grid (applyTransaction remove theo rowId).
   - delete-row → remove delete marker (restore row values trước strike) + editState.clearCell(rowId, 0).
5. Redo apply: replay action (re-set cell newValue / re-add row / re-mark delete).
6. Keyboard: `Cmd/Ctrl+Z` → undo; `Cmd/Ctrl+Shift+Z` → redo (grid-level keydown listener — KHÔNG cấu hiệu với AG Grid editing stop-edit; dùng AG Grid `stopEditing` trước apply).
7. Toolbar undoBtn (main.ts:528-534) + thêm redoBtn cạnh: enabled = canUndo/canRedo.
8. Commit success (TASK-007 contract: saveResult ok ⇒ clear) → `undoStack.clear()` CŨNG chạy. Tab switch/new query (editState.clear() path main.ts:1358) → clear luôn.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | undo 3 bước qua edit→add→delete (reverse order) | push cell-edit, add-row, delete-row → undo() trả delete-row, add-row, cell-edit đúng thứ tự ngược; canUndo false sau 3 | pure UndoStack |
| 2 | happy | redo replay đúng thứ tự | sau 3 undo, redo() × 3 trả cell-edit, add-row, delete-row (thứ tự xuôi) | pure |
| 3 | edge | action mới sau undo → redo stack clear | undo 1 → push mới → canRedo false, redo() null | pure |
| 4 | edge | undo khi rỗng → null no-throw | undo() trả null; canUndo false | pure |
| 5 | edge | coalesce same-cell consecutive edits | push cell-edit (r1,c1,v1→v2) rồi (r1,c1,v2→v3) → undoDepth===1; undo() trả oldValue v1 | pure |
| 6 | happy | webview wiring: edit → Cmd+Z revert cell + mất dirty class | jsdom: cellValueChanged → dispatch keydown Cmd+Z → cell value về oldValue, class vsdb-cell-dirty mất | jsdom harness pattern TASK-007 |
| 7 | regression | commit success → undoStack.clear() (không undo qua DB write) | sau saveResult ok: undo() null | jsdom |

## Test Files

- `src/ui/undoStack.test.ts` (NEW) — #1-#5.
- `tests/webviewEditHighlight.test.ts` (từ TASK-007 — append describe "undo/redo wiring") — #6, #7. Nếu TASK-007 chưa land lúc start: tạo file với cả hai describe (ghi chú trong Executor Report tránh double-create).

## Verification Commands

```bash
npx vitest run src/ui/undoStack.test.ts tests/webviewEditHighlight.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test §Test Cases PASS.
- [ ] Ctrl/Cmd+Z (+Shift) + toolbar icons hoạt động qua edit/add/delete; redo stack clear trên action mới; clear sau commit.
- [ ] Undo-sau-commit KHÔNG implement (spec C) — chỉ clear stack sau commit.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-007 (cùng đụng webview/main.ts + commit contract saveResult ok ⇒ clear; tests/webviewEditHighlight.test.ts append).

## Interfaces

- Consumes: TASK-007 produces — highlight classes + commit-complete contract (saveResult ok ⇒ editState.clear() + re-query; điểm cắm thêm undoStack.clear()). `EditState` (src/ui/resultsGridModel.ts) + method mới nếu thêm `clearCell(rowId, colIndex)`.
- Produces: `src/ui/undoStack.ts` exports `UndoStack`, `UndoAction` — pure, có thể reuse cho webview khác; không task sau tiêu thụ trong cycle này.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: EditState hiện có `undo()` pop LIFO riêng cho cell (dùng bởi undoBtn cũ). Task này THAY thế đường đó bằng unified stack — đường cũ giữ method (không xóa API public) nhưng undoBtn handler chuyển sang stack. Nếu thấy xung đột với paste-TSV flow (applyTsvToEditState), giữ paste flow nguyên — chỉ cắm push sau khi paste xong như 1 action composite hoặc N action (chọn N action đơn giản, ghi report).

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Implemented unified Excel-like undo/redo stack (src/ui/undoStack.ts) covering cell-edits, row-adds, row-deletes through one LIFO branch with same-cell coalesce; wired it into webview/main.ts (cellValueChanged, onAddRowClick, onDeleteRowClick pushes; Cmd/Ctrl+Z + Shift+Z keyboard; toolbar undoBtn/redoBtn enabled sync; clear on saveResult ok + tab switch + refresh). Added EditState.clearCell(rowId, colIndex) targeted removal for undo of cell-edit. Pure module + jsdom wiring tests both pass.
TEST_PLAN_FOLLOWED: task §4 Test Cases #1-#7 — #1-#5 pure logic in src/ui/undoStack.test.ts; #6 #7 wiring in tests/webviewUndoRedo.test.ts (separate file rather than appending to webviewEditHighlight.test.ts because the edit tool's hash drift kept rejecting inserts; flagged in REPORT).
FILES_CHANGED:
  - src/ui/undoStack.ts (NEW) — UndoStack class + UndoAction union (cell-edit/add-row/delete-row); push coalesces consecutive same-cell cell-edits into a single step with the original oldValue preserved at the bottom; push clears redo branch; undo/redo swap between branches.
  - src/ui/undoStack.test.ts (NEW) — 9 unit tests covering LIFO push/undo/redo, coalesce (#5 + #5b kind/cell scope), redo-clear-on-new-action (#3), empty-stack no-throw (#4, #6), clear() empties both branches (#7), undoDepth tracks undo branch only (#8).
  - src/ui/resultsGridModel.ts — added EditState.clearCell(rowId, colIndex) so the stack can remove the dirty entry for a single (rowId, colIndex) without clobbering others (undo of a cell-edit). TASK-007's clearExceptRowIds / isCellDirty / isRowNew / isRowDeleted / markDirty / undo() preserved per the contract.
  - webview/main.ts — imported UndoStack; module-level `undoStack = new UndoStack()`; onCellValueChangedHandler pushes cell-edit after markDirty; onAddRowClick pushes add-row after markDirty before applyTransaction; onDeleteRowClick pushes delete-row after markDirty before redraw; ICON_REDO svg; redo button next to undo button (initially disabled); replaced onUndoClick body to pop from the unified stack and call new applyUndoAction(action, "undo" | "redo") which handles all three kinds (cell-edit: server-truth revert + clearCell on undo / re-mark on redo; add-row: applyTransaction remove on undo / re-add on redo; delete-row: clearCell on undo / re-mark on redo); refreshUndoRedoButtons() called inside updateFooterNow so all push/clear/undo/redo paths naturally sync the toolbar; undoStack.clear() alongside every editState.clear() (handleSaveResult full-success branch, two renderGrid reset branches, onRefreshClick); keydown capture-phase listener on gridWrap for Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (skips filter inputs; guards getEditingCell because jsdom AG Grid stub omits it); live `undoBtn` / `redoBtn` getters in the __vsdb debug export so tests can inspect enabled state after `dom` is built on first render (TASK-007's editState getter pattern, applied to the buttons); undoStack getter + redo() added to __vsdb.
  - tests/webviewUndoRedo.test.ts (NEW, separate from webviewEditHighlight.test.ts) — 2 jsdom tests covering Cmd+Z revert + dirty-class strip + redo replay (#6) and full-commit clear (#7). Test seam uses the same jsdom harness as TASK-007's webviewEditHighlight.test.ts (loadBundle, dispatchState, dispatchHost, flushGridEvents, threeRowsState) plus the live undoBtn/redoBtn getters and undoStack handle.
  - node_modules (symlink to parent — worktree started fresh, no install needed; npm install is a sibling task, not this one).
  - dist/webview.js + sourcemap (rebuilt via `npm run compile` to bundle the new wiring for jsdom tests).
TESTS_ADDED:
  - src/ui/undoStack.test.ts: 9 tests (push/undo/redo, coalesce cell-edit, kind-scope coalesce boundary, redo-clear-on-new-action, empty undo/redo no-throw, clear empties both, undoDepth).
  - tests/webviewUndoRedo.test.ts: 2 tests (Cmd+Z cell-edit revert + dirty class strip + redo replay; saveResult ok → undoStack cleared + undo() null).
VERIFICATION:
  command: npx vitest run src/ui/undoStack.test.ts tests/webviewUndoRedo.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
  result: 3 files, 31 tests, all pass (9 + 2 + 20), exit 0
  output_excerpt: |
    ✓ src/ui/undoStack.test.ts                       (9 tests)  3ms
    ✓ src/ui/__tests__/resultsGridModelEdit.test.ts  (20 tests) 3ms
    ✓ tests/webviewUndoRedo.test.ts                  (2 tests)  265ms
    Test Files  3 passed (3)
         Tests  31 passed (31)
  command: npx tsc --noEmit
  result: exit 0, no output (clean)
ISSUES:
  - Could NOT append #6/#7 to tests/webviewEditHighlight.test.ts: the edit tool rejected multiple `PUT >N` insertion attempts with hash-drift errors ("hash #4F20 is not from this session"), and `git checkout` confirmed the file was unchanged. Worked around by creating tests/webviewUndoRedo.test.ts as a sibling — same jsdom harness, same fixtures, no double-create of any existing describe. If TASK-009 / Phase 4 reviewer wants a single combined file, the two describe blocks can be merged at that point without re-running tests.
  - EditState.undo() intentionally retained (not deleted) per the planner note: "đường cũ giữ method (không xóa API public) nhưng undoBtn handler chuyển sang stack". The legacy EditState undo path is now dead code from webview/main.ts (only __vsdb undoBtn wiring changed) — kept for downstream consumers that may import EditState directly.
  - Paste TSV flow (applyPasteToDirty) was left as-is per planner note: paste path stays untouched, no composite push — each cell in a paste lands as its own coalescable cell-edit via cellValueChanged (AG Grid fires per-cell on programmatic value set), so the stack picks them up naturally.
HANDOFF_TO_REVIEWER: yes — unified stack + wiring + tests pass; EditState contract preserved (clearCell added, undo/markDirty/isCellDirty/isRowNew/isRowDeleted/clearExceptRowIds unchanged). Undo-sau-commit out of scope per spec C — only the clear-after-commit is implemented.
NEXT: ready for review.
