// src/ui/__tests__/compareService.test.ts
// TASK-DBX03-004 — host orchestration: driver gate, missing-table
// error, row cap, end-to-end result assembly.

import { describe, it, expect, vi } from "vitest";
import { runCompare, COMPARE_ROW_LIMIT, type RowFetcher } from "../compareService";
import type { DbAdapter, TableDetail } from "../../adapters/types";

const detail = (cols: string[], pkIdx: number[] = [1]): TableDetail => ({
  columns: cols.map((c, i) => ({
    column_name: c,
    format_type: i === 0 ? "integer" : "text",
    is_nullable: i === 0 ? ("NO" as const) : ("YES" as const),
    column_default: null,
  })),
  constraints:
    cols.length > 0
      ? [{ conname: "t_pkey", contype: "p", conkey: pkIdx, confrelidname: null, confkeycols: null, consrc: "" }]
      : [],
});

function makeAdapter(overrides: { detailA?: TableDetail; detailB?: TableDetail }): DbAdapter {
  return {
    listTableDetail: vi
      .fn()
      .mockImplementation(async (schema: string, table: string) => {
        const d = table === "a" ? overrides.detailA : overrides.detailB;
        if (!d) throw new Error(`table not found: ${schema}.${table}`);
        return d;
      }),
  } as unknown as DbAdapter;
}

const req = {
  source: { schema: "public", table: "a" },
  target: { schema: "public", table: "b" },
};

describe("runCompare — guards", () => {
  it("refuses non-postgres drivers without touching the adapter", async () => {
    const adapter = makeAdapter({});
    const result = await runCompare(req, adapter, "mysql");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PostgreSQL/);
    expect(adapter.listTableDetail).not.toHaveBeenCalled();
  });

  it("refuses when driver is undefined", async () => {
    const result = await runCompare(req, makeAdapter({}), undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PostgreSQL/);
  });

  it("reports a missing target table with its name", async () => {
    const adapter = makeAdapter({ detailA: detail(["id", "name"]) });
    const result = await runCompare(req, adapter, "postgres");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/public\.b/);
  });
});

describe("runCompare — happy path", () => {
  it("carries shapeDiff + dataDiff + executable plan", async () => {
    const rowsA: Array<Record<string, unknown>> = [{ id: 1, name: "x" }];
    const rowsB: Array<Record<string, unknown>> = [{ id: 1, name: "y" }];
    const fetchA: RowFetcher = async () => rowsA;
    const fetchB: RowFetcher = async () => rowsB;
    const adapter = makeAdapter({
      detailA: detail(["id", "name"]),
      detailB: detail(["id", "name"]),
    });
    const result = await runCompare(req, adapter, "postgres", { fetchRowsA: fetchA, fetchRowsB: fetchB });
    expect(result.ok).toBe(true);
    expect(result.shapeDiff?.identical).toBe(true);
    expect(result.dataDiff && !result.dataDiff.skipped ? result.dataDiff.changedRows.length : -1).toBe(1);
    expect(result.plan?.executable).toBe(true);
    expect(result.plan?.totals.data).toBe(1);
  });
});

describe("runCompare — row cap", () => {
  it("sets truncated and diffs the fetched prefix when over COMPARE_ROW_LIMIT", async () => {
    const big: Array<Record<string, unknown>> = Array.from({ length: COMPARE_ROW_LIMIT + 5 }, (_, i) => ({
      id: i + 1,
      name: `r${i}`,
    }));
    const fetchA: RowFetcher = async () => big;
    const fetchB: RowFetcher = async () => [];
    const adapter = makeAdapter({
      detailA: detail(["id", "name"]),
      detailB: detail(["id", "name"]),
    });
    const result = await runCompare(req, adapter, "postgres", { fetchRowsA: fetchA, fetchRowsB: fetchB });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    const dd = result.dataDiff;
    expect(dd && !dd.skipped && dd.addedRows.length > 0).toBe(true);
  });
});

describe("runCompare — reviewer fixes (regression)", () => {
  it("never issues a data query when no usable key exists (no-key safety)", async () => {
    const tableNoKey = (cols: string[]): TableDetail => ({
      columns: cols.map((c) => ({
        column_name: c,
        format_type: "text",
        is_nullable: "YES" as const,
        column_default: null,
      })),
      constraints: [],
    });
    const fetchSpy: RowFetcher = vi.fn(async () => []);
    const adapter = makeAdapter({
      detailA: tableNoKey(["a", "b"]),
      detailB: tableNoKey(["a", "b"]),
    });
    const result = await runCompare(req, adapter, "postgres", {
      fetchRowsA: fetchSpy,
      fetchRowsB: fetchSpy,
    });
    expect(result.ok).toBe(true);
    expect(result.dataDiff?.skipped).toBe("no-key");
    expect(result.plan?.executable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a single-column unique NOT NULL constraint as key when no PK", async () => {
    const uniqDetail = (v: string): TableDetail => ({
      columns: [
        { column_name: "code", format_type: "text", is_nullable: "NO" as const, column_default: null },
        { column_name: "val", format_type: "text", is_nullable: "YES" as const, column_default: null },
      ],
      constraints: [
        { conname: "uq", contype: "u", conkey: [1], confrelidname: null, confkeycols: null, consrc: "" },
      ],
      marker: v,
    } as unknown as TableDetail);
    const fetchA: RowFetcher = async () => [{ code: "K1", val: "s" }];
    const fetchB: RowFetcher = async () => [{ code: "K1", val: "t" }];
    const adapter = makeAdapter({ detailA: uniqDetail("a"), detailB: uniqDetail("b") });
    const result = await runCompare(req, adapter, "postgres", { fetchRowsA: fetchA, fetchRowsB: fetchB });
    expect(result.ok).toBe(true);
    expect(result.dataDiff && !result.dataDiff.skipped ? result.dataDiff.changedRows.length : -1).toBe(1);
    expect(result.plan?.executable).toBe(true);
  });
});
