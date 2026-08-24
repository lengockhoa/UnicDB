// src/ui/undoStack.ts
//
// TASK-008 — Unified Excel-like undo/redo stack.
//
// One stack, three action kinds (cell-edit / add-row / delete-row). Push records
// the user action and clears the redo branch (Excel rule). Undo pops the top
// and moves it to the redo branch. Redo replays the most-recently-undone
// action.
//
// Cell-edit coalesce: consecutive edits to the SAME (rowId, colIndex) merge
// into a single stack entry whose `oldValue` stays at the pre-edit value and
// whose `newValue` tracks the latest edit. One undo then jumps back to the
// original in a single step — parity with TASK-501's EditState coalesce.
//
// add-row and delete-row do NOT coalesce (they are distinct user actions on
// distinct rows; collapsing them would hide the user's intent).
//
// Pure module: no vscode, no DOM. The webview bundle imports it and wires
// cellValueChanged / onAddRowClick / onDeleteRowClick through `push`. After
// a successful saveResult commit, the host message handler calls `clear()`.
//
// Consumers:
//   - src/ui/undoStack.test.ts (unit tests, this module's own contract)
//   - webview/main.ts (push on each user mutation; undo/redo via the
//     unified toolbar buttons + Cmd/Ctrl+Z / Shift+Z keyboard).

export type UndoAction =
  | {
      kind: "cell-edit";
      rowId: number;
      colIndex: number;
      oldValue: unknown;
      newValue: unknown;
    }
  | { kind: "add-row"; rowId: number }
  | { kind: "delete-row"; rowId: number };

/** True when a `cell-edit` push to the SAME (rowId, colIndex) should merge
 *  into the top stack entry rather than create a new step. Only same-cell
 *  cell-edits coalesce — add-row / delete-row always push a fresh step. */
function sameCellEdit(a: UndoAction, rowId: number, colIndex: number): boolean {
  return (
    a.kind === "cell-edit" && a.rowId === rowId && a.colIndex === colIndex
  );
}

export class UndoStack {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];

  /** Record a new user action. Clears the redo branch (Excel rule: a new
   *  action invalidates any future-redo path). Consecutive cell-edits to
   *  the same (rowId, colIndex) merge into the top entry instead of
   *  growing the stack — keeps undo parity with TASK-501's EditState
   *  coalesce and keeps the stack from filling up with one keystroke
   *  per character. */
  push(a: UndoAction): void {
    this.redoStack.length = 0;
    if (
      a.kind === "cell-edit" &&
      this.undoStack.length > 0 &&
      sameCellEdit(this.undoStack[this.undoStack.length - 1], a.rowId, a.colIndex)
    ) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top.kind === "cell-edit") {
        // Keep the ORIGINAL oldValue at the bottom; update newValue to the
        // latest. Subsequent undos restore the user back to the pre-edit
        // value in a single step (parity with EditState.markDirty).
        top.newValue = a.newValue;
        return;
      }
    }
    this.undoStack.push(a);
  }

  /** Pop the most-recently-pushed action; move it to the redo branch so
   *  `redo()` can replay it. Returns null when the undo branch is empty. */
  undo(): UndoAction | null {
    if (this.undoStack.length === 0) return null;
    const a = this.undoStack.pop()!;
    this.redoStack.push(a);
    return a;
  }

  /** Pop the most-recently-undone action; move it back to the undo branch.
   *  Returns null when the redo branch is empty. */
  redo(): UndoAction | null {
    if (this.redoStack.length === 0) return null;
    const a = this.redoStack.pop()!;
    this.undoStack.push(a);
    return a;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Drop both branches. Called after a successful saveResult commit and on
   *  tab switch / new query — undo past a DB write is out of scope (the
   *  DB has already committed), so we just forget the stack. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** UI hint: number of undoable steps. Redo-stack size is intentionally
   *  not surfaced here — the toolbar uses `canRedo` for the enabled flag. */
  get undoDepth(): number {
    return this.undoStack.length;
  }
}
