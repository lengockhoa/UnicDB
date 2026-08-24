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
