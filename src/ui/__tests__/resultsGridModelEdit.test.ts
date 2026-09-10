// src/ui/__tests__/resultsGridModelEdit.test.ts
// TASK-501 — Pure-logic tests for EditState + parseTsvPaste + applyPasteToDirty.
// No DOM, no AG Grid, no vscode — plain vitest node environment.
import { describe, it, expect } from "vitest";
import {
  EditState,
  parseTsvPaste,
  applyPasteToDirty,
  applyRangePasteToDirty,
  selectionRangeToText,
  normalizeCellRange,
  cellRangeSize,
  type CellRange,
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
  it("8c. dense path: targetRow beyond rowCount is clipped (TASK-502 R4 inherited)", () => {
    // anchorRow=2, rowCount=3, parsed has 3 rows starting at anchor → last
    // computed targetRow is 4 which exceeds rowCount=3 → must be dropped, not
    // stamped into a non-existent row. Pre-R4 dense formula did not clip
    // because the loop bound `n` was a separate variable; targetRow used the
    // formula `anchorRow + r` without per-row bound check.
    const s = new EditState();
    const parsed = [
      ["x1"],
      ["x2"],
      ["x3"],
    ];
    applyPasteToDirty(s, /* anchorRow */ 2, /* anchorCol */ 0, parsed, /* colCount */ 1, /* rowCount */ 3);
    // Only targetRow 2 → value "x1" should land; x2/x3 must be dropped.
    expect(s.dirtyCount).toBe(1);
    const snap = s.snapshot();
    expect(snap[0].rowId).toBe(2);
    expect(snap[0].colIndex).toBe(0);
    expect(snap[0].value).toBe("x1");
    expect(snap.find((e) => e.rowId === 3)).toBeUndefined();
    expect(snap.find((e) => e.rowId === 4)).toBeUndefined();
  });
});

// =============================================================================
// TASK-007 — EditState.clearExceptRowIds / row markers / isCellDirty.
// Used by the webview commit flow (per-row error handling) and by AG Grid
// getRowClass / cellClassRules for highlight rendering.
// =============================================================================
describe("EditState — clearExceptRowIds (TASK-007)", () => {
  it("keeps entries whose rowId is in the keep set; drops the rest", () => {
    const s = new EditState();
    s.markDirty(0, 0, "v0", "old0");
    s.markDirty(1, 0, "v1", "old1");
    s.markDirty(2, 1, "v2", "old2");
    expect(s.dirtyCount).toBe(3);

    s.clearExceptRowIds(new Set([1]));

    expect(s.dirtyCount).toBe(1);
    const snap = s.snapshot();
    expect(snap).toEqual([{ rowId: 1, colIndex: 0, value: "v1" }]);
  });

  it("empty keep set clears everything", () => {
    const s = new EditState();
    s.markDirty(0, 0, "a", "A");
    s.markDirty(1, 0, "b", "B");
    s.clearExceptRowIds(new Set());
    expect(s.dirtyCount).toBe(0);
    expect(s.snapshot()).toEqual([]);
  });

  it("keep set containing only non-dirty rowIds drops everything", () => {
    const s = new EditState();
    s.markDirty(0, 0, "a", "A");
    // rowId 0 not in keep set {42} → dropped.
    s.clearExceptRowIds(new Set([42]));
    expect(s.dirtyCount).toBe(0);
    expect(s.snapshot()).toEqual([]);
  });
});

describe("EditState — row markers (TASK-007)", () => {
  it("isRowNew true only when an entry's value carries __UnicDB_new_row__", () => {
    const s = new EditState();
    s.markDirty(7, 0, { __UnicDB_new_row__: true, __rowId: 7 }, undefined);
    expect(s.isRowNew(7)).toBe(true);
    expect(s.isRowNew(0)).toBe(false);
  });

  it("isRowDeleted true only when an entry's value carries __UnicDB_deleted__", () => {
    const s = new EditState();
    s.markDirty(3, 0, { __UnicDB_deleted__: true, __rowId: 3 }, undefined);
    expect(s.isRowDeleted(3)).toBe(true);
    expect(s.isRowDeleted(7)).toBe(false);
  });

  it("plain cell edit → both predicates false", () => {
    const s = new EditState();
    s.markDirty(0, 1, "v", "old");
    expect(s.isRowNew(0)).toBe(false);
    expect(s.isRowDeleted(0)).toBe(false);
  });
});

describe("EditState — isCellDirty (TASK-007)", () => {
  it("true only for the exact (rowId, colIndex) key", () => {
    const s = new EditState();
    s.markDirty(0, 1, "v", "old");
    expect(s.isCellDirty(0, 1)).toBe(true);
    expect(s.isCellDirty(0, 0)).toBe(false);
    expect(s.isCellDirty(1, 1)).toBe(false);
  });

  it("false after clear()", () => {
    const s = new EditState();
    s.markDirty(0, 1, "v", "old");
    s.clear();
    expect(s.isCellDirty(0, 1)).toBe(false);
  });
});

// =============================================================================
// TASK-RANGE-001 — Cell-range copy/paste helpers.
// Spreadsheet-style rectangle selection: copy range as TSV; paste tiles the
// clipboard rows/cols across the range, clipping out-of-grid cells.
// =============================================================================
describe("normalizeCellRange / cellRangeSize", () => {
  it("swaps start/end when reversed", () => {
    const n = normalizeCellRange({ startRow: 3, startCol: 4, endRow: 1, endCol: 2 });
    expect(n).toEqual({ startRow: 1, startCol: 2, endRow: 3, endCol: 4 });
  });

  it("clamps negative coords to 0", () => {
    const n = normalizeCellRange({ startRow: -5, startCol: -1, endRow: 2, endCol: 3 });
    expect(n).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 3 });
  });

  it("size is inclusive on both ends", () => {
    expect(cellRangeSize({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toEqual({
      rows: 1,
      cols: 1,
    });
    expect(cellRangeSize({ startRow: 1, startCol: 2, endRow: 3, endCol: 4 })).toEqual({
      rows: 3,
      cols: 3,
    });
  });
});

describe("selectionRangeToText", () => {
  it("1x1 range returns one cell", () => {
    const rows = [[1, "a"], [2, "b"]];
    expect(
      selectionRangeToText(rows, { startRow: 0, startCol: 1, endRow: 0, endCol: 1 }),
    ).toBe("a");
  });
  it("single-column strip returns one value per line", () => {
    const rows = [[1, "alpha"], [2, "beta"], [3, "gamma"]];
    expect(
      selectionRangeToText(rows, { startRow: 0, startCol: 1, endRow: 2, endCol: 1 }),
    ).toBe("alpha\nbeta\ngamma");
  });

  it("multi-row multi-col range: rows separated by \\n, cells by \\t", () => {
    const rows = [
      [1, "a", "x"],
      [2, "b", "y"],
      [3, "c", "z"],
    ];
    expect(
      selectionRangeToText(rows, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }),
    ).toBe("1\ta\n2\tb");
  });

  it("null cell → empty string in TSV", () => {
    const rows = [
      [1, null],
      [null, "b"],
    ];
    expect(
      selectionRangeToText(rows, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }),
    ).toBe("1\t\n\tb");
  });

  it("range past rows.length → empty trailing cells", () => {
    const rows = [[1, 2]];
    expect(
      selectionRangeToText(rows, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 }),
    ).toBe("1\t2\n\t\n\t");
  });

  it("reversed range is normalized first", () => {
    const rows = [
      [1, 2],
      [3, 4],
    ];
    // Drag from bottom-right to top-left.
    expect(
      selectionRangeToText(rows, { startRow: 1, startCol: 1, endRow: 0, endCol: 0 }),
    ).toBe("1\t2\n3\t4");
  });
});

describe("applyRangePasteToDirty", () => {
  it("1x1 clipboard into 3x4 range tiles the value", () => {
    const s = new EditState();
    const parsed = parseTsvPaste("X");
    const range: CellRange = { startRow: 0, startCol: 0, endRow: 2, endCol: 3 };
    applyRangePasteToDirty(s, parsed, range, /* colCount */ 4, /* rowCount */ 3);
    expect(s.dirtyCount).toBe(12);
    const snap = s.snapshot();
    for (const e of snap) expect(e.value).toBe("X");
  });

  it("3x3 clipboard into 2x2 range clips to 2x2 (top-left anchored)", () => {
    const s = new EditState();
    const parsed = parseTsvPaste("1\t2\t3\n4\t5\t6\n7\t8\t9");
    const range: CellRange = { startRow: 1, startCol: 1, endRow: 2, endCol: 2 };
    applyRangePasteToDirty(s, parsed, range, /* colCount */ 4, /* rowCount */ 4);
    // Only 4 cells land: (1,1)=1, (1,2)=2, (2,1)=4, (2,2)=5.
    expect(s.dirtyCount).toBe(4);
    const snap = s.snapshot();
    const byKey: Record<string, unknown> = {};
    for (const e of snap) byKey[`${e.rowId}:${e.colIndex}`] = e.value;
    expect(byKey["1:1"]).toBe("1");
    expect(byKey["1:2"]).toBe("2");
    expect(byKey["2:1"]).toBe("4");
    expect(byKey["2:2"]).toBe("5");
    // Out-of-range cells must NOT be touched.
    expect("1:3" in byKey).toBe(false);
    expect("3:1" in byKey).toBe(false);
  });

  it("2x2 clipboard into 4x3 range tiles (paste fills)", () => {
    const s = new EditState();
    const parsed = parseTsvPaste("A\tB\nC\tD");
    const range: CellRange = { startRow: 0, startCol: 0, endRow: 3, endCol: 2 };
    applyRangePasteToDirty(s, parsed, range, /* colCount */ 3, /* rowCount */ 4);
    // 4×3 = 12 cells, all populated with tiled A/B/C/D.
    expect(s.dirtyCount).toBe(12);
    const byKey: Record<string, string> = {};
    for (const e of s.snapshot()) byKey[`${e.rowId}:${e.colIndex}`] = String(e.value);
    expect(byKey["0:0"]).toBe("A");
    expect(byKey["0:1"]).toBe("B");
    expect(byKey["0:2"]).toBe("A");
    expect(byKey["1:0"]).toBe("C");
    expect(byKey["1:1"]).toBe("D");
    expect(byKey["1:2"]).toBe("C");
    expect(byKey["2:0"]).toBe("A");
    expect(byKey["2:1"]).toBe("B");
    expect(byKey["2:2"]).toBe("A");
    expect(byKey["3:0"]).toBe("C");
    expect(byKey["3:1"]).toBe("D");
    expect(byKey["3:2"]).toBe("C");
  });

  it("range past colCount clips columns out of grid bounds", () => {
    const s = new EditState();
    const parsed = parseTsvPaste("A\tB\tC");
    const range: CellRange = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };
    applyRangePasteToDirty(s, parsed, range, /* colCount */ 3, /* rowCount */ 1);
    // Only cols 1 and 2 fit (col 3, 4, 5 out of bounds).
    expect(s.dirtyCount).toBe(2);
    const snap = s.snapshot();
    expect(snap.find((e) => e.colIndex === 1)?.value).toBe("A");
    expect(snap.find((e) => e.colIndex === 2)?.value).toBe("B");
  });

  it("targetRowIds path resolves rows by stable id, not dense index", () => {
    const s = new EditState();
    // id namespace has holes: 5, 7, 9 (locally-added rows interspersed).
    const parsed = parseTsvPaste("a\tb\nc\td");
    const range: CellRange = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    applyRangePasteToDirty(
      s,
      parsed,
      range,
      /* colCount */ 2,
      /* rowCount */ 99,
      /* targetRowIds */ [5, 7],
    );
    const snap = s.snapshot();
    expect(snap.find((e) => e.rowId === 5 && e.colIndex === 0)?.value).toBe("a");
    expect(snap.find((e) => e.rowId === 5 && e.colIndex === 1)?.value).toBe("b");
    expect(snap.find((e) => e.rowId === 7 && e.colIndex === 0)?.value).toBe("c");
    expect(snap.find((e) => e.rowId === 7 && e.colIndex === 1)?.value).toBe("d");
    // The dense path would have written into 6 and 8 — those must be empty.
    expect(snap.find((e) => e.rowId === 6)).toBeUndefined();
    expect(snap.find((e) => e.rowId === 8)).toBeUndefined();
  });
});

