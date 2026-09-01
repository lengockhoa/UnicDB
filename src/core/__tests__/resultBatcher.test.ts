// src/core/__tests__/resultBatcher.test.ts
// Unit tests for resultBatcher pure helpers — TASK-006 §Test Cases.
import { describe, it, expect } from "vitest";
import { appendBatch, batchStats, appendBatchBounded } from "../resultBatcher";

describe("resultBatcher — appendBatch", () => {
  it("Test #3a — append thêm rows đúng thứ tự", () => {
    const out = appendBatch(
      [[1], [2]],
      [[3]],
    );
    expect(out).toEqual([[1], [2], [3]]);
  });

  it("Test #3b — append với current rỗng", () => {
    const out = appendBatch([], [[1], [2]]);
    expect(out).toEqual([[1], [2]]);
  });

  it("Test #3c — append với batch rỗng → giữ nguyên", () => {
    const out = appendBatch([[1], [2]], []);
    expect(out).toEqual([[1], [2]]);
  });

  it("Test #3d — append KHÔNG mutate input", () => {
    const cur = [[1]];
    const batch = [[2], [3]];
    appendBatch(cur, batch);
    expect(cur).toEqual([[1]]);
    expect(batch).toEqual([[2], [3]]);
  });
});

describe("resultBatcher — batchStats", () => {
  it("Test #3e — total > loaded → canLoadMore=true", () => {
    const s = batchStats(1200, 500, 500);
    expect(s.canLoadMore).toBe(true);
    expect(s.label).toBe("500 of 1200");
  });

  it("Test #3f — total === loaded → canLoadMore=false", () => {
    const s = batchStats(1000, 1000, 500);
    expect(s.canLoadMore).toBe(false);
    expect(s.label).toBe("1000 of 1000");
  });

  it("Test #3g — total < loaded (không lẽ bình thường) → canLoadMore=false", () => {
    const s = batchStats(100, 200, 500);
    expect(s.canLoadMore).toBe(false);
    expect(s.label).toBe("200 of 100");
  });

  it("Test #3h — loaded=0 → canLoadMore=true nếu total>0", () => {
    const s = batchStats(500, 0, 500);
    expect(s.canLoadMore).toBe(true);
    expect(s.label).toBe("0 of 500");
  });
});

// TASK-ARP03-001 — pure retained-result budget helper.
// `appendBatchBounded` giữ prefix deterministic của current.concat(batch) ≤ maxRows.
describe("appendBatchBounded", () => {
  it("Test #1 — under-budget append keeps all rows, limited=false", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }, d = { id: "d" };
    const out = appendBatchBounded([[a], [b]], [[c], [d]], 100);
    expect(out.rows).toEqual([[a], [b], [c], [d]]);
    expect(out.rows).toHaveLength(4);
    // refs giữ nguyên — không copy cell, không reorder
    expect(out.rows[0][0]).toBe(a);
    expect(out.rows[3][0]).toBe(d);
    expect(out.limited).toBe(false);
  });

  it("Test #2 — exact boundary cap is NOT limited", () => {
    const cur = [["r1"], ["r2"], ["r3"]];
    const batch = [["r4"], ["r5"]];
    const out = appendBatchBounded(cur, batch, 5);
    expect(out.rows).toEqual([["r1"], ["r2"], ["r3"], ["r4"], ["r5"]]);
    expect(out.rows).toHaveLength(5);
    expect(out.limited).toBe(false);
  });

  it("Test #3 — oversized batch retains deterministic prefix; inputs unmutated", () => {
    const cur = [["c1"], ["c2"], ["c3"]];
    const batch = [["b1"], ["b2"], ["b3"], ["b4"], ["b5"]];
    const curSnapshot = JSON.parse(JSON.stringify(cur));
    const batchSnapshot = JSON.parse(JSON.stringify(batch));
    const out = appendBatchBounded(cur, batch, 5);
    // prefix: 3 đầu của current + 2 đầu của batch
    expect(out.rows).toEqual([["c1"], ["c2"], ["c3"], ["b1"], ["b2"]]);
    expect(out.rows).toHaveLength(5);
    expect(out.limited).toBe(true);
    // deep-equal snapshot → không in-place splice
    expect(cur).toEqual(curSnapshot);
    expect(batch).toEqual(batchSnapshot);
  });

  it("Test #4 — degenerate maxRows (0 / negative / NaN) never throws", () => {
    const cur: any[][] = [];
    const batch = [["x1"], ["x2"]];
    // maxRows = 0
    expect(appendBatchBounded(cur, batch, 0)).toEqual({ rows: [], limited: true });
    // maxRows âm
    expect(appendBatchBounded(cur, batch, -1)).toEqual({ rows: [], limited: true });
    // maxRows NaN
    expect(appendBatchBounded(cur, batch, NaN)).toEqual({ rows: [], limited: true });
    // cả 2 input rỗng → limited=false dù cap degenerate
    expect(appendBatchBounded([], [], 0).limited).toBe(false);
  });

  it("Test #5 — empty inputs behave deterministically", () => {
    expect(appendBatchBounded([], [], 10)).toEqual({ rows: [], limited: false });
    const batch = [["s1"], ["s2"]];
    const out = appendBatchBounded([], batch, 10);
    expect(out.rows).toEqual(batch);
    expect(out.limited).toBe(false);
  });

  it("Test #6 — current already at cap: batch contributes nothing, limited=true", () => {
    const cur = [["a1"], ["a2"], ["a3"], ["a4"], ["a5"]];
    const batch = [["b1"], ["b2"], ["b3"]];
    const out = appendBatchBounded(cur, batch, 5);
    expect(out.rows).toEqual([["a1"], ["a2"], ["a3"], ["a4"], ["a5"]]);
    expect(out.rows).toHaveLength(5);
    expect(out.limited).toBe(true);
  });
});
