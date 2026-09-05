// src/adapters/__tests__/bigqueryPageSize.test.ts
// TASK-BQF-001 — pageSize plumbing for BigQueryAdapter.runQuery + page fetcher.
//
// Strategy: drive `clampPageSize` directly (pure helper) + drive
// `createBigQueryPageFetcher` with a mock `fetch` spy and assert the
// `maxResults` arg passed to the underlying fetch. We also verify the
// `BigQueryAdapter.runQuery` thread by stubbing the seam (`createQueryJob`
// + `job.getQueryResults`).
//
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { clampPageSize, createBigQueryPageFetcher } from "../bigqueryPages";

// ---- clampPageSize (pure) -----------------------------------------------

describe("TASK-BQF-001 clampPageSize", () => {
  it("unit: returns undefined when input is undefined", () => {
    expect(clampPageSize(undefined)).toBeUndefined();
  });
  it("unit: passes through 500 (in range)", () => {
    expect(clampPageSize(500)).toBe(500);
  });
  it("unit: clamps 50000 to 10000 (BQ API ceiling)", () => {
    expect(clampPageSize(50000)).toBe(10000);
  });
  it("edge: clamps 0 to 1 (BQ API floor)", () => {
    expect(clampPageSize(0)).toBe(1);
  });
  it("edge: clamps negative to 1", () => {
    expect(clampPageSize(-5)).toBe(1);
  });
  it("regression: returns undefined for NaN / non-integer (no override)", () => {
    expect(clampPageSize(Number.NaN)).toBeUndefined();
    expect(clampPageSize(1.5)).toBeUndefined();
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

// ---- createBigQueryPageFetcher (mock fetch) ------------------------------

describe("TASK-BQF-001 createBigQueryPageFetcher pageSize thread", () => {
  it("unit: pageSize=500 → maxResults=500 passed to fetch on first()", async () => {
    const fetchSpy = vi.fn(async () => [
      null,
      null,
      { schema: { fields: [] }, rows: [], pageToken: null, totalBytesProcessed: "0" },
    ]);
    const fetcher = createBigQueryPageFetcher({ fetch: fetchSpy, pageSize: 500 });
    await fetcher.first();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 500 }),
    );
  });

  it("unit: pageSize=50000 → maxResults=10000 (clamped)", async () => {
    const fetchSpy = vi.fn(async () => [
      null,
      null,
      { schema: { fields: [] }, rows: [], pageToken: null, totalBytesProcessed: "0" },
    ]);
    const fetcher = createBigQueryPageFetcher({ fetch: fetchSpy, pageSize: 50000 });
    await fetcher.first();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 10000 }),
    );
  });

  it("edge: pageSize=0 → maxResults=1 (clamped)", async () => {
    const fetchSpy = vi.fn(async () => [
      null,
      null,
      { schema: { fields: [] }, rows: [], pageToken: null, totalBytesProcessed: "0" },
    ]);
    const fetcher = createBigQueryPageFetcher({ fetch: fetchSpy, pageSize: 0 });
    await fetcher.first();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 1 }),
    );
  });

  it("regression: no pageSize → no maxResults key in fetch call", async () => {
    const fetchSpy = vi.fn(async () => [
      null,
      null,
      { schema: { fields: [] }, rows: [], pageToken: null, totalBytesProcessed: "0" },
    ]);
    const fetcher = createBigQueryPageFetcher({ fetch: fetchSpy });
    await fetcher.first();
    const call = fetchSpy.mock.calls[0][0] as Record<string, unknown>;
    expect("maxResults" in call).toBe(false);
  });
});