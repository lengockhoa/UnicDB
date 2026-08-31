// src/ai/tools/__tests__/analysisTools.test.ts — TASK-AIX03-002
import { describe, it, expect } from "vitest";
import {
  createAnalyzeTableTool,
  createDiagnoseQueryTool,
} from "../analysisTools";
import type { AdapterFactory } from "../types";
import type { DbAdapter } from "../../../adapters/types";

function fakeAdapter(overrides: Partial<DbAdapter> = {}): DbAdapter {
  const base = {
    listTables: async () => [{ schema: "public", name: "users" }],
    listTableDetail: async () => ({
      columns: [
        { column_name: "id", format_type: "integer", is_nullable: "NO", column_default: null },
        { column_name: "email", format_type: "text", is_nullable: "YES", column_default: null },
      ],
      constraints: [
        {
          conname: "fk_orders_user",
          contype: "f",
          conkey: [1],
          confrelidname: "orders",
          confkeycols: ["id"],
          consrc: "FOREIGN KEY (id) REFERENCES orders(id)",
        },
      ],
    }),
    runQuery: async (sql: string) => {
      if (sql.startsWith("SELECT COUNT")) {
        return { batched: false, results: [{ columns: ["count"], rows: [[42]] }] };
      }
      return {
        batched: false,
        results: [{ columns: ["id", "email"], rows: [[1, "a@b.c"], [2, "d@e.f"], [3, "x@y.z"]] }],
      };
    },
  } as unknown as DbAdapter;
  return { ...base, ...overrides } as DbAdapter;
}

const factory = (a: DbAdapter): AdapterFactory => async () => a;

describe("analyze_table", () => {
  it("combines schema + count + sample + relationships", async () => {
    const tool = createAnalyzeTableTool(factory(fakeAdapter()));
    const report = JSON.parse(await tool.execute({ schema: "public", table: "users" }));
    expect(report.schema.error).toBeUndefined();
    expect(report.schema.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "email", type: "text" },
    ]);
    expect(report.count).toBe(42);
    expect(report.sample).toContain("a@b.c"); // sample carries rows (data surface)
    expect(report.relationships).toEqual([
      { constraint: "fk_orders_user", references: "orders", columns: ["id"] },
    ]);
  });

  it("per-part failure degrades only that part", async () => {
    const adapter = fakeAdapter({
      runQuery: async () => {
        throw new Error("boom");
      },
    });
    const tool = createAnalyzeTableTool(factory(adapter));
    const report = JSON.parse(await tool.execute({ schema: "public", table: "users" }));
    expect(report.count.error).toContain("boom");
    expect(report.sample.error).toContain("boom");
    expect(report.schema.columns).toHaveLength(2); // schema part still fine
    expect(report.relationships).toHaveLength(1);
  });

  it("no connection → standard envelope", async () => {
    const tool = createAnalyzeTableTool(async () => null);
    expect(await tool.execute({ schema: "public", table: "users" })).toContain(
      "No active database connection",
    );
  });

  it("bad identifier rejected", async () => {
    const tool = createAnalyzeTableTool(factory(fakeAdapter()));
    expect(await tool.execute({ schema: "public", table: "" })).toContain("bad_identifier");
  });
});

describe("diagnose_query", () => {
  it("success → ok + row count", async () => {
    const tool = createDiagnoseQueryTool(factory(fakeAdapter()));
    const res = JSON.parse(await tool.execute({ sql: "SELECT * FROM users" }));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(3);
  });

  it("classifies syntax / permission / connection / unknown", async () => {
    const make = (msg: string) =>
      createDiagnoseQueryTool(
        factory(
          fakeAdapter({
            runQuery: async () => {
              throw new Error(msg);
            },
          }),
        ),
      );
    expect(JSON.parse(await make("syntax error at or near 'FROM'").execute({ sql: "SELECT 1" })).class).toBe("syntax");
    expect(JSON.parse(await make("permission denied for table users").execute({ sql: "SELECT 1" })).class).toBe("permission");
    expect(JSON.parse(await make("connection terminated unexpectedly").execute({ sql: "SELECT 1" })).class).toBe("connection");
    expect(JSON.parse(await make("something odd").execute({ sql: "SELECT 1" })).class).toBe("unknown");
  });

  it("re-guards: DELETE and EXPLAIN ANALYZE rejected without adapter call", async () => {
    let called = 0;
    const adapter = fakeAdapter({
      runQuery: async () => {
        called++;
        return { batched: false, results: [{ columns: ["x"], rows: [[1]] }] };
      },
    });
    const tool = createDiagnoseQueryTool(factory(adapter));
    expect(await tool.execute({ sql: "DELETE FROM users" })).toContain("rejected");
    expect(await tool.execute({ sql: "EXPLAIN ANALYZE DELETE FROM users" })).toContain("rejected");
    expect(called).toBe(0);
  });

  it("detail capped at 200 chars", async () => {
    const tool = createDiagnoseQueryTool(
      factory(
        fakeAdapter({
          runQuery: async () => {
            throw new Error("x".repeat(500));
          },
        }),
      ),
    );
    const res = JSON.parse(await tool.execute({ sql: "SELECT 1" }));
    expect(res.detail.length).toBe(200);
  });
});
