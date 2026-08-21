// src/core/__tests__/resultBatcher.test.ts
// Unit tests for resultBatcher pure helpers — TASK-006 §Test Cases.
import { describe, it, expect } from "vitest";
import { appendBatch, batchStats } from "../resultBatcher";

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
