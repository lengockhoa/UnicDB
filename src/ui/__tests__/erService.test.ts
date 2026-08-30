import { describe, expect, it, vi } from "vitest";
import { runErExplorer, MAX_ER_NODES } from "../erService";
import type { DbAdapter, TableDetail, TableInfo } from "../../adapters/types";

const detail = (cols: string[], fks: Array<{ conname: string; conkey: number[]; confrelidname: string | null; confkeycols: string[] | null }>): TableDetail => ({
  columns: cols.map((c) => ({ column_name: c, format_type: "text", is_nullable: "YES" as const, column_default: null })),
  constraints: fks.map((f) => ({ contype: "f", consrc: "", ...f })),
});

const table = (schema: string, name: string): TableInfo => ({ schema, name } as TableInfo);

function makeAdapter(over: Partial<DbAdapter> & { tables?: TableInfo[]; details?: Record<string, TableDetail | Error> }): DbAdapter {
  const { tables = [], details = {}, ...rest } = over;
  return {
    listTables: vi.fn(() => Promise.resolve(tables)),
    listTableDetail: vi.fn((schema: string, name: string) => {
      const d = details[`${schema}.${name}`];
      if (d instanceof Error) return Promise.reject(d);
      return Promise.resolve(d ?? { columns: [], constraints: [] });
    }),
    ...rest,
  } as unknown as DbAdapter;
}

describe("runErExplorer", () => {
  it("refuses non-postgres drivers before ANY adapter call", async () => {
    const listTables = vi.fn(() => Promise.resolve([]));
    const adapter = makeAdapter({ listTables: listTables as never });
    const r = await runErExplorer(adapter, "mysql");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported-driver");
    expect(listTables).not.toHaveBeenCalled();
  });

  it("refuses a null adapter", async () => {
    const r = await runErExplorer(null, "postgres");
    expect(r.ok).toBe(false);
  });

  it("builds graph + layout on the happy path", async () => {
    const adapter = makeAdapter({
      driver: "postgres",
      tables: [table("public", "users"), table("public", "orders")],
      details: {
        "public.users": detail(["id"], []),
        "public.orders": detail(["id", "uid"], [{ conname: "fk1", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]),
      },
    });
    const r = await runErExplorer(adapter as DbAdapter & { driver?: string }, "postgres");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(2);
      expect(r.graph.edges).toHaveLength(1);
      expect(r.layout.nodes.size).toBe(2);
      expect(r.truncated).toBe(false);
    }
  });

  it("degrades listTables failure to an empty graph, never throws", async () => {
    const adapter = makeAdapter({
      driver: "postgres",
      listTables: vi.fn(() => Promise.reject(new Error("boom"))),
    });
    const r = await runErExplorer(adapter as DbAdapter & { driver?: string }, "postgres");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph.nodes).toHaveLength(0);
  });

  it("omits a table whose detail query fails", async () => {
    const adapter = makeAdapter({
      driver: "postgres",
      tables: [table("public", "good"), table("public", "bad")],
      details: {
        "public.good": detail(["id"], []),
        "public.bad": new Error("gone"),
      },
    });
    const r = await runErExplorer(adapter as DbAdapter & { driver?: string }, "postgres");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph.nodes.map((n) => n.table)).toEqual(["good"]);
  });

  it("caps at MAX_ER_NODES with truncated flag (highest FK degree kept)", async () => {
    const tables: TableInfo[] = [];
    const details: Record<string, TableDetail> = {};
    for (let i = 0; i < MAX_ER_NODES + 5; i++) {
      tables.push(table("public", `t${String(i).padStart(3, "0")}`));
      details[`public.t${String(i).padStart(3, "0")}`] = detail(["id"], []);
    }
    const adapter = makeAdapter({ driver: "postgres", tables, details });
    const r = await runErExplorer(adapter as DbAdapter & { driver?: string }, "postgres");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(MAX_ER_NODES);
      expect(r.truncated).toBe(true);
    }
  });

  it("keeps determinism: same tables in, same graph out", async () => {
    const make = () =>
      makeAdapter({
        driver: "postgres",
        tables: [table("public", "b"), table("public", "a")],
        details: { "public.b": detail(["id"], []), "public.a": detail(["id"], []) },
      });
    const r1 = await runErExplorer(make() as DbAdapter & { driver?: string }, "postgres");
    const r2 = await runErExplorer(make() as DbAdapter & { driver?: string }, "postgres");
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("orders selected nodes by id after capping", async () => {
    const tables: TableInfo[] = [table("public", "zz"), table("public", "aa"), table("public", "mm")];
    const details: Record<string, TableDetail> = {
      "public.zz": detail(["id"], []),
      "public.aa": detail(["id"], []),
      "public.mm": detail(["id"], []),
    };
    const adapter = makeAdapter({ driver: "postgres", tables, details });
    const r = await runErExplorer(adapter as DbAdapter & { driver?: string }, "postgres", "public", { maxNodes: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph.nodes.map((n) => n.table)).toEqual(["aa", "mm"]);
  });
});
