// src/core/compare/__tests__/dataDiff.test.ts
// TASK-DBX03-002 — keyed row diff: added/removed/changed with per-cell
// diffs, deterministic ordering, no-key guard, duplicate tolerance.

import { describe, it, expect } from "vitest";
import { diffData } from "../dataDiff";

function row(key: number, extra: Record<string, unknown> = {}) {
  return { id: key, ...extra };
}

describe("diffData", () => {
  it("collects source-only rows into addedRows ordered by key", () => {
    const source = [row(1, { v: "a" }), row(5, { v: "e" }), row(2, { v: "b" })];
    const target = [row(2, { v: "b" })];
    const result = diffData(["id"], source, target, ["id", "v"]);
    expect(result.skipped).toBeUndefined();
    expect(result.addedRows.map((r) => r.key[0])).toEqual([1, 5]);
  });

  it("reports a changed row with column-named cell diffs", () => {
    const source = [row(1, { v: "old" })];
    const target = [row(1, { v: "new" })];
    const result = diffData(["id"], source, target, ["id", "v"]);
    expect(result.changedRows).toEqual([
      { key: [1], cellDiffs: [{ column: "v", from: "old", to: "new" }] },
    ]);
  });

  it("returns empty groups for identical datasets", () => {
    const rows = [row(1, { v: "a" }), row(2, { v: "b" })];
    const result = diffData(["id"], rows, rows, ["id", "v"]);
    expect(result.addedRows).toEqual([]);
    expect(result.removedRows).toEqual([]);
    expect(result.changedRows).toEqual([]);
  });

  it("skips computation when no key exists", () => {
    const result = diffData([], [row(1)], [row(1)], ["id"]);
    expect(result.skipped).toBe("no-key");
    expect(result.addedRows).toEqual([]);
    expect(result.changedRows).toEqual([]);
  });

  it("survives duplicate keys: first wins, duplicates counted", () => {
    const source = [row(1, { v: "first" }), row(1, { v: "dup" })];
    const target = [row(1, { v: "first" })];
    const result = diffData(["id"], source, target, ["id", "v"]);
    expect(result.skipped).toBeUndefined();
    expect(result.duplicateKeyCount).toBe(1);
    expect(result.changedRows).toEqual([]);
  });

  it("treats null -> null as identical but null -> value as a change", () => {
    const source = [
      { id: 1, v: null },
      { id: 2, v: null },
      { id: 3, v: "x" },
    ];
    const target = [
      { id: 1, v: null },
      { id: 2, v: "now" },
      { id: 3, v: null },
    ];
    const result = diffData(["id"], source, target, ["id", "v"]);
    expect(result.changedRows.map((r) => r.key[0])).toEqual([2, 3]);
    expect(result.changedRows[0]?.cellDiffs).toEqual([{ column: "v", from: null, to: "now" }]);
    expect(result.changedRows[1]?.cellDiffs).toEqual([{ column: "v", from: "x", to: null }]);
  });

  it("orders output by key tuple ascending across all groups", () => {
    const source = [row(3), row(1), row(2)];
    const target: Array<Record<string, unknown>> = [];
    const result = diffData(["id"], source, target, ["id"]);
    expect(result.addedRows.map((r) => r.key[0])).toEqual([1, 2, 3]);
  });
});
