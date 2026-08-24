// src/ui/undoStack.test.ts
// TASK-008 — Pure-logic tests for the unified UndoStack (cell-edit + add-row +
// delete-row). No DOM, no AG Grid, no vscode — plain vitest node environment.
// The webview bundle imports the same module and wires it to user actions.
import { describe, it, expect } from "vitest";
import { UndoStack } from "./undoStack";

describe("UndoStack — push/undo/redo semantics", () => {
  // ---- #1: undo 3 steps in reverse order ----------------------------------
  it("1. push cell-edit, add-row, delete-row → undo × 3 returns delete-row, add-row, cell-edit", () => {
    const s = new UndoStack();
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 1, oldValue: "old", newValue: "new" });
    s.push({ kind: "add-row", rowId: 5 });
    s.push({ kind: "delete-row", rowId: 3 });

    expect(s.canUndo).toBe(true);
    expect(s.undoDepth).toBe(3);

    const a = s.undo();
    expect(a).toEqual({ kind: "delete-row", rowId: 3 });
    const b = s.undo();
    expect(b).toEqual({ kind: "add-row", rowId: 5 });
    const c = s.undo();
    expect(c).toEqual({
      kind: "cell-edit",
      rowId: 0,
      colIndex: 1,
      oldValue: "old",
      newValue: "new",
    });

    expect(s.canUndo).toBe(false);
    expect(s.undo()).toBeNull();
  });

  // ---- #2: redo replays in forward order ----------------------------------
  it("2. after 3 undo, redo × 3 replays in forward order", () => {
    const s = new UndoStack();
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 1, oldValue: "old", newValue: "new" });
    s.push({ kind: "add-row", rowId: 5 });
    s.push({ kind: "delete-row", rowId: 3 });

    s.undo();
    s.undo();
    s.undo();

    expect(s.canRedo).toBe(true);

    const a = s.redo();
    expect(a).toEqual({
      kind: "cell-edit",
      rowId: 0,
      colIndex: 1,
      oldValue: "old",
      newValue: "new",
    });
    const b = s.redo();
    expect(b).toEqual({ kind: "add-row", rowId: 5 });
    const c = s.redo();
    expect(c).toEqual({ kind: "delete-row", rowId: 3 });

    expect(s.canRedo).toBe(false);
    expect(s.redo()).toBeNull();
  });

  // ---- #3: new action after undo clears redo stack ------------------------
  it("3. push after undo → redo stack cleared (Excel rule)", () => {
    const s = new UndoStack();
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 0, oldValue: "a", newValue: "b" });
    s.push({ kind: "cell-edit", rowId: 1, colIndex: 0, oldValue: "c", newValue: "d" });

    s.undo();
    expect(s.canRedo).toBe(true);

    s.push({ kind: "cell-edit", rowId: 2, colIndex: 0, oldValue: "e", newValue: "f" });
    expect(s.canRedo).toBe(false);
    expect(s.redo()).toBeNull();

    // Undo brings back the most-recent action only (the new one).
    const popped = s.undo();
    expect(popped).toEqual({
      kind: "cell-edit",
      rowId: 2,
      colIndex: 0,
      oldValue: "e",
      newValue: "f",
    });
  });

  // ---- #4: undo on empty stack is a no-op (null, no throw) -----------------
  it("4. undo on empty stack → null, canUndo=false", () => {
    const s = new UndoStack();
    expect(s.canUndo).toBe(false);
    expect(s.undoDepth).toBe(0);
    expect(s.undo()).toBeNull();
    // Calling again stays safe.
    expect(s.undo()).toBeNull();
  });

  // ---- #5: coalesce same-cell consecutive edits ---------------------------
  it("5. push cell-edit (r1,c1,v1→v2) then (r1,c1,v2→v3) → undoDepth===1, undo restores oldValue v1", () => {
    const s = new UndoStack();
    s.push({ kind: "cell-edit", rowId: 1, colIndex: 1, oldValue: "v1", newValue: "v2" });
    s.push({ kind: "cell-edit", rowId: 1, colIndex: 1, oldValue: "v2", newValue: "v3" });
    s.push({ kind: "cell-edit", rowId: 1, colIndex: 1, oldValue: "v3", newValue: "v4" });

    expect(s.undoDepth).toBe(1);

    const popped = s.undo();
    expect(popped).toEqual({
      kind: "cell-edit",
      rowId: 1,
      colIndex: 1,
      oldValue: "v1",
      newValue: "v4",
    });

    // After coalesce-undo the stack is empty.
    expect(s.canUndo).toBe(false);
    expect(s.undo()).toBeNull();
  });

  // ---- #5b: coalesce does NOT cross kind boundaries ------------------------
  it("5b. coalesce is kind+cell-scoped: cell-edit then add-row are separate steps", () => {
    const s = new UndoStack();
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 0, oldValue: "a", newValue: "b" });
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 0, oldValue: "b", newValue: "c" });
    // Different kind → push a new step.
    s.push({ kind: "add-row", rowId: 7 });
    // Different cell → push a new step.
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 1, oldValue: "x", newValue: "y" });

    expect(s.undoDepth).toBe(3);

    // Top step: cell-edit (0,1)
    const a = s.undo();
    expect(a).toEqual({
      kind: "cell-edit",
      rowId: 0,
      colIndex: 1,
      oldValue: "x",
      newValue: "y",
    });
    // Next: add-row
    const b = s.undo();
    expect(b).toEqual({ kind: "add-row", rowId: 7 });
    // Next: cell-edit (0,0) coalesced — oldValue stays as the original "a"
    const c = s.undo();
    expect(c).toEqual({
      kind: "cell-edit",
      rowId: 0,
      colIndex: 0,
      oldValue: "a",
      newValue: "c",
    });
  });

  // ---- #6: redo() on empty stack is a no-op -------------------------------
  it("6. redo on empty stack → null, canRedo=false", () => {
    const s = new UndoStack();
    expect(s.canRedo).toBe(false);
    expect(s.redo()).toBeNull();
  });

  // ---- #7: clear empties both stacks --------------------------------------
  it("7. clear() drops both stacks; canUndo and canRedo both false", () => {
    const s = new UndoStack();
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 0, oldValue: "a", newValue: "b" });
    s.undo();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);

    s.clear();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.undoDepth).toBe(0);
    expect(s.redo()).toBeNull();
  });

  // ---- #8: undoDepth reflects size of undo stack only ----------------------
  it("8. undoDepth = size of undo stack; redo stack does not affect it", () => {
    const s = new UndoStack();
    expect(s.undoDepth).toBe(0);
    s.push({ kind: "cell-edit", rowId: 0, colIndex: 0, oldValue: "a", newValue: "b" });
    expect(s.undoDepth).toBe(1);
    s.push({ kind: "add-row", rowId: 1 });
    expect(s.undoDepth).toBe(2);
    s.undo();
    expect(s.undoDepth).toBe(1);
    s.undo();
    expect(s.undoDepth).toBe(0);
    // After full undo, the redo stack holds 2; undoDepth stays at 0.
    s.redo();
    expect(s.undoDepth).toBe(1);
  });
});
