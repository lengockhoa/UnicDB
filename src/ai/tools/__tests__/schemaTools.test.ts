// src/ai/tools/__tests__/schemaTools.test.ts — TASK-001 TDD tests (RED → GREEN)
// Spec: docs/AI_HANDOFF/tasks/TASK-001.md §Test Cases (frozen). NO vscode import.

import { describe, it, expect, vi } from "vitest";
import {
  createListTablesTool,
  createDescribeTableTool,
  createExportStructureTool,
} from "../schemaTools";
import type { DbAdapter, TableInfo, TableDetail, ColumnInfo } from "../../../adapters/types";
import { NotImplementedError } from "../../../adapters/types";
import type { AdapterFactory } from "../types";

// ---- fakes ------------------------------------------------------------------

/**
 * Fake DbAdapter — implements only methods used by schemaTools. The DbAdapter
 * interface has more; cast satisfies TS structurally.
 */
function fakeAdapter(impl: Partial<DbAdapter>): DbAdapter {
  return impl as DbAdapter;
}

function tablesFixture(): TableInfo[] {
  return [
    { schema: "public", name: "users" },
    { schema: "public", name: "orders" },
    { schema: "billing", name: "invoices" },
  ];
}

function detailFixture(): TableDetail {
  return {
    columns: [
      {
        column_name: "id",
        format_type: "uuid",
        is_nullable: "NO",
        column_default: "gen_random_uuid()",
      },
      {
        column_name: "email",
        format_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
    ],
    constraints: [
      {
        conname: "users_pkey",
        contype: "p",
        conkey: [1],
        confrelidname: null,
        confkeycols: null,
        consrc: "PRIMARY KEY (id)",
      },
    ],
  };
}

// ---- tests ------------------------------------------------------------------

describe("schemaTools — frozen contract", () => {
  // test #1 — happy list_tables
  it("test #1 list_tables returns JSON parsed array from listTables()", async () => {
    const adapter = fakeAdapter({
      listTables: vi.fn(async () => tablesFixture()),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createListTablesTool(f);

    const out = await tool.execute({});

    const parsed = JSON.parse(out) as unknown;
    expect(parsed).toEqual([
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
      { schema: "billing", name: "invoices" },
    ]);
    expect(adapter.listTables).toHaveBeenCalledWith(undefined);
  });

  // test #2 — happy describe_table on PG
  it("test #2 describe_table returns columns + constraints JSON", async () => {
    const adapter = fakeAdapter({
      listTableDetail: vi.fn(async () => detailFixture()),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createDescribeTableTool(f);

    const out = await tool.execute({ schema: "public", table: "users" });

    const parsed = JSON.parse(out) as { columns: unknown[]; constraints: unknown[] };
    expect(parsed.columns).toHaveLength(2);
    expect(parsed.columns[0]).toMatchObject({
      column_name: "id",
      format_type: "uuid",
    });
    expect(parsed.constraints).toHaveLength(1);
    expect(parsed.constraints[0]).toMatchObject({
      conname: "users_pkey",
      contype: "p",
    });
    expect(adapter.listTableDetail).toHaveBeenCalledWith("public", "users");
  });

  // test #3 — edge null factory → message
  it("test #3 list_tables: factory resolves null → 'No active connection' message", async () => {
    const f: AdapterFactory = async () => null;
    const tool = createListTablesTool(f);

    const out = await tool.execute({});

    expect(out).toContain("No active connection");
  });

  // test #4 — edge NotImplementedError → PG-only message
  it("test #4 describe_table: NotImplementedError → 'only supported for PostgreSQL'", async () => {
    const adapter = fakeAdapter({
      listTableDetail: vi.fn(async () => {
        throw new NotImplementedError("mysql");
      }),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createDescribeTableTool(f);

    const out = await tool.execute({ schema: "public", table: "users" });

    expect(out).toContain("only supported for PostgreSQL");
  });

  // test #5 — edge adapter throws generic Error → "Tool failed: …"
  it("test #5 list_tables: adapter throws Error('boom') → 'Tool failed: boom'", async () => {
    const adapter = fakeAdapter({
      listTables: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createListTablesTool(f);

    const out = await tool.execute({});

    expect(out).toBe("Tool failed: boom");
  });
});

// ---- TASK-001 §Test Cases #2, #4, #5, #6 ------------------------------------

describe("export_structure tool", () => {
  // ---- helpers ----
  function columnCols(): ColumnInfo[] {
    return [
      { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
    ];
  }

  // test #2 — happy path
  it("test #2 execute returns JSON with ddl + counts (schemas=2, tables=3, views=1, skipped=0)", async () => {
    const adapter = fakeAdapter({
      listSchemas: vi.fn(async () => [
        { name: "public" },
        { name: "sales" },
      ]),
      listTables: vi.fn(async (schema?: string) => {
        if (schema === "public") return [{ schema: "public", name: "users" }, { schema: "public", name: "orders" }];
        if (schema === "sales") return [{ schema: "sales", name: "deals" }];
        return [];
      }),
      listViews: vi.fn(async (schema?: string) => {
        if (schema === "public") return [{ schema: "public", name: "v_active" }];
        return [];
      }),
      listColumns: vi.fn(async () => columnCols()),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createExportStructureTool(f);

    const out = await tool.execute({});
    const parsed = JSON.parse(out) as {
      ddl: string;
      schemas: number;
      tables: number;
      views: number;
      skipped: number;
    };

    expect(parsed.ddl).toContain("-- Database structure (2 schemas, 3 tables, 1 views)");
    expect(parsed.schemas).toBe(2);
    expect(parsed.tables).toBe(3);
    expect(parsed.views).toBe(1);
    expect(parsed.skipped).toBe(0);
    expect(adapter.listSchemas).toHaveBeenCalledWith(false);
  });

  // test #4 — mysql adapter throws NotImplementedError
  it("test #4 mysql adapter NotImplementedError → PG-only message string", async () => {
    const adapter = fakeAdapter({
      listSchemas: vi.fn(async () => {
        throw new NotImplementedError("mysql");
      }),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createExportStructureTool(f);

    const out = await tool.execute({});

    expect(out).toBe("export_structure is only supported for PostgreSQL connections.");
  });

  // test #5 — listColumns throws for one table → skipped=1, others still render
  it("test #5 one table listColumns throws → skipped=1, surviving table renders in ddl", async () => {
    const adapter = fakeAdapter({
      listSchemas: vi.fn(async () => [{ name: "public" }]),
      listTables: vi.fn(async () => [
        { schema: "public", name: "orders" },
        { schema: "public", name: "users" },
      ]),
      listViews: vi.fn(async () => []),
      listColumns: vi.fn(async (table: string, _schema?: string) => {
        if (table === "orders") throw new Error("columns boom");
        return columnCols();
      }),
    });
    const f: AdapterFactory = async () => adapter;
    const tool = createExportStructureTool(f);

    const out = await tool.execute({});
    const parsed = JSON.parse(out) as {
      ddl: string;
      schemas: number;
      tables: number;
      views: number;
      skipped: number;
    };

    expect(parsed.skipped).toBe(1);
    expect(parsed.tables).toBe(2);
    expect(parsed.ddl).toContain("CREATE TABLE public.users (");
    expect(parsed.ddl).not.toContain("CREATE TABLE public.orders");
  });

  // test #6 — factory resolves null
  it("test #6 factory resolves null → no-connection message string", async () => {
    const f: AdapterFactory = async () => null;
    const tool = createExportStructureTool(f);

    const out = await tool.execute({});

    expect(out).toBe(
      "No active connection. Connect to a database first, then retry.",
    );
  });
});
