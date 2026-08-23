// src/ai/tools/__tests__/schemaContext.test.ts — TASK-002 TDD
import { describe, it, expect } from "vitest";
import type { TableInfo, TableDetail } from "../../../adapters/types";
import { formatSchemaContext } from "../schemaContext";

// ---- helpers ----------------------------------------------------------------

function table(schema: string, name: string): TableInfo {
  return { schema, name };
}

function detail(
  cols: Array<[string, string, "YES" | "NO"]>,
  constraints: TableDetail["constraints"] = [],
): TableDetail {
  return {
    columns: cols.map(([column_name, format_type, is_nullable]) => ({
      column_name,
      format_type,
      is_nullable,
      column_default: null,
    })),
    constraints,
  };
}

// ---- tests ------------------------------------------------------------------

describe("formatSchemaContext", () => {
  it("renders each table + columns + constraints when within budget", () => {
    const tables = [table("public", "users"), table("public", "orders")];
    const details: TableDetail[] = [
      detail([
        ["id", "integer", "NO"],
        ["email", "text", "YES"],
      ]),
      detail([
        ["id", "integer", "NO"],
        ["total", "numeric", "NO"],
      ]),
    ];
    const out = formatSchemaContext(tables, details, 10_000);
    expect(out).toContain("public.users");
    expect(out).toContain("public.orders");
    expect(out).toContain("id integer NOT NULL");
    expect(out).toContain("email text NULL");
    expect(out).toContain("total numeric NOT NULL");
    expect(out).not.toContain("omitted");
  });

  it("cuts at table boundary and appends '(+N more tables omitted)' when over budget", () => {
    const tables = [
      table("public", "users"),
      table("public", "orders"),
      table("public", "payments"),
    ];
    const details: TableDetail[] = [
      detail([["id", "integer", "NO"]]),
      detail([["id", "integer", "NO"]]),
      detail([["id", "integer", "NO"]]),
    ];
    const full = formatSchemaContext(tables, details, 10_000);
    const firstBlockEnd = full.indexOf("\n\nTable: public.orders");
    expect(firstBlockEnd).toBeGreaterThan(-1);
    // budget fits the first table block + `(N more tables omitted)` footer
    // (28 chars), but not the second table block (42 chars).
    const budget = firstBlockEnd + 30;
    const out = formatSchemaContext(tables, details, budget);
    expect(out).toContain("public.users");
    expect(out).not.toContain("public.orders");
    expect(out).not.toContain("public.payments");
    expect(out).toContain("(+2 more tables omitted)");
  });

  it("returns empty string when budget <= 0", () => {
    const out = formatSchemaContext(
      [table("public", "users")],
      [detail([["id", "integer", "NO"]])],
      0,
    );
    expect(out).toBe("");
  });

  it("renders PK and FK constraints on one line each", () => {
    const tables = [table("public", "orders")];
    const details: TableDetail[] = [
      detail(
        [
          ["id", "integer", "NO"],
          ["user_id", "integer", "NO"],
        ],
        [
          {
            conname: "orders_pkey",
            contype: "p",
            conkey: [1],
            confrelidname: null,
            confkeycols: null,
            consrc: "PRIMARY KEY (id)",
          },
          {
            conname: "orders_user_id_fkey",
            contype: "f",
            conkey: [2],
            confrelidname: "public.users",
            confkeycols: ["id"],
            consrc: "FOREIGN KEY (user_id) REFERENCES public.users(id)",
          },
        ],
      ),
    ];
    const out = formatSchemaContext(tables, details, 10_000);
    expect(out).toContain("PK: orders_pkey -> [id]");
    expect(out).toContain("FK: orders_user_id_fkey [user_id] -> public.users([id])");
  });
});