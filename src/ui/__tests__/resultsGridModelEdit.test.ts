// src/ui/__tests__/resultsGridModelEdit.test.ts
// TASK-501 — Pure-logic tests for EditState + parseTsvPaste + applyPasteToDirty.
// No DOM, no AG Grid, no vscode — plain vitest node environment.
import { describe, it, expect } from "vitest";
import {
  EditState,
  parseTsvPaste,
  applyPasteToDirty,
} from "../resultsGridModel";

// =============================================================================
// 1. markDirty two different cells — dirty map has 2 entries, dirtyCount = 2
// =============================================================================
describe("EditState — markDirty", () => {
  it("1. markDirty two different cells → 2 entries, dirtyCount=2", () => {
    const s = new EditState();
    s.markDirty(0, 1, "new-b", "old-b");
    s.markDirty(1, 0, 99, 1);
    expect(s.dirtyCount).toBe(2);
  });

  it("2. markDirty same cell twice → overwrites, no double entry, single undo step (coalesce)", () => {
    const s = new EditState();
    s.markDirty(0, 0, "v1", "orig");
    s.markDirty(0, 0, "v2", "v1");
    s.markDirty(0, 0, "v3", "v2");
    expect(s.dirtyCount).toBe(1);

    // First undo: v3 → v2 (coalesced: only the original old "orig" remains)
    const first = s.undo();
    expect(first).toEqual({ rowId: 0, colIndex: 0 });
    // After undo, the dirty entry should be removed (we're back to old value).
    expect(s.dirtyCount).toBe(0);
    // Next undo: nothing more to undo.
    const second = s.undo();
    expect(second).toBeNull();
  });
});

// =============================================================================
// 3. undo on empty stack → null, state unchanged
// =============================================================================
describe("EditState — undo", () => {
  it("3. undo on empty stack → null, state unchanged", () => {
    const s = new EditState();
    expect(s.undo()).toBeNull();
    expect(s.dirtyCount).toBe(0);
  });

  it("4. undo 2 steps → LIFO, restore old value (dirty entry removed if back to old)", () => {
    const s = new EditState();
    s.markDirty(0, 0, "new-a", "old-a");
    s.markDirty(1, 1, "new-b", "old-b");
    expect(s.dirtyCount).toBe(2);

    const first = s.undo();
    // LIFO — last edit is (1,1).
    expect(first).toEqual({ rowId: 1, colIndex: 1 });
    expect(s.dirtyCount).toBe(1);

    const second = s.undo();
    expect(second).toEqual({ rowId: 0, colIndex: 0 });
    expect(s.dirtyCount).toBe(0);
  });
});

// =============================================================================
// 9. clear() resets dirty map (regression: tab switch / new query)
// =============================================================================
describe("EditState — clear", () => {
  it("9. clear() resets dirty map (regression: tab switch / new query)", () => {
    const s = new EditState();
    s.markDirty(0, 0, "x", "a");
    s.markDirty(2, 3, "y", "b");
    expect(s.dirtyCount).toBe(2);
    s.clear();
    expect(s.dirtyCount).toBe(0);
    // Undo stack should also be empty after clear.
    expect(s.undo()).toBeNull();
    // snapshot should be empty too.
    expect(s.snapshot()).toEqual([]);
  });
});

// =============================================================================
// EditState.snapshot() — TASK-503 consumes this
// =============================================================================
describe("EditState — snapshot", () => {
  it("snapshot() returns current dirty cells as { rowId, colIndex, value }", () => {
    const s = new EditState();
    s.markDirty(0, 1, "v01", "old01");
    s.markDirty(2, 0, 42, 1);
    const snap = s.snapshot();
    expect(snap.length).toBe(2);
    const byKey: Record<string, unknown> = {};
    for (const x of snap) {
      byKey[`${x.rowId}:${x.colIndex}`] = x.value;
    }
    expect(byKey["0:1"]).toBe("v01");
    expect(byKey["2:0"]).toBe(42);
  });
});

// =============================================================================
// 5/6/7. parseTsvPaste
// =============================================================================
describe("parseTsvPaste", () => {
  it("5. parseTsvPaste happy `a\\tb\\nc\\td` → [[a,b],[c,d]]", () => {
    expect(parseTsvPaste("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("6. CRLF + trailing `\\r\\n` + empty trailing line → no empty row", () => {
    expect(parseTsvPaste("a\tb\r\nc\td\r\n\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("7. row thiếu cell → pad `''` theo max width", () => {
    // max width of parsed rows = 2, so "c" → ["c", ""]
    expect(parseTsvPaste("a\tb\nc")).toEqual([
      ["a", "b"],
      ["c", ""],
    ]);
  });
});

// =============================================================================
// 8. applyPasteToDirty clips out-of-bounds cells
// =============================================================================
describe("applyPasteToDirty", () => {
  it("8. applyPaste clips out-of-bounds; does not throw", () => {
    const s = new EditState();
    // 2 cols, 2 rows grid; paste 3 cols x 2 rows from anchor (0,0)
    const parsed = [
      ["1", "2", "3"],
      ["4", "5", "6"],
    ];
    applyPasteToDirty(s, 0, 0, parsed, /* colCount */ 2, /* rowCount */ 2);
    expect(s.dirtyCount).toBe(4); // (0,0), (0,1) only — col 2 out of bounds.
    const snap = s.snapshot();
    const byKey: Record<string, unknown> = {};
    for (const x of snap) {
      byKey[`${x.rowId}:${x.colIndex}`] = x.value;
    }
    expect(byKey["0:0"]).toBe("1");
    expect(byKey["0:1"]).toBe("2");
    // Out-of-bounds col 2 should NOT be applied.
    expect("0:2" in byKey).toBe(false);
    expect(byKey["1:0"]).toBe("4");
    expect(byKey["1:1"]).toBe("5");
    expect("1:2" in byKey).toBe(false);
  });

  it("8b. applyPaste with rows beyond rowCount → out-of-bounds rows skipped", () => {
    const s = new EditState();
    // 1-row grid, paste 3 rows
    const parsed = [
      ["a"],
      ["b"],
      ["c"],
    ];
    applyPasteToDirty(s, 0, 0, parsed, /* colCount */ 1, /* rowCount */ 1);
    expect(s.dirtyCount).toBe(1);
    expect(s.snapshot()[0].value).toBe("a");
  });
});
