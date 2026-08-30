import { describe, expect, it } from "vitest";
import { buildErGraph, type ErGraphInput } from "../fkGraph";

type Detail = ErGraphInput[number]["detail"];

const col = (name: string) => ({ column_name: name, format_type: "text", is_nullable: "YES" as const, column_default: null });

const d = (
  columns: string[],
  constraints: Array<{
    conname: string;
    contype: string;
    conkey: number[];
    confrelidname: string | null;
    confkeycols: string[] | null;
    consrc?: string;
  }>,
): Detail => ({
  columns: columns.map(col),
  constraints: constraints.map((c) => ({ consrc: "", ...c })),
});

describe("buildErGraph", () => {
  it("builds a node per table with schema-qualified id", () => {
    const g = buildErGraph([
      { schema: "public", table: "users", detail: d(["id", "name"], [{ conname: "users_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null }]) },
      { schema: "public", table: "orders", detail: d(["id"], []) },
    ]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["public.orders", "public.users"]);
    const users = g.nodes.find((n) => n.id === "public.users");
    expect(users?.pkColumns).toEqual(["id"]);
    expect(users?.columnCount).toBe(2);
  });

  it("creates a child->parent edge from a foreign key constraint", () => {
    const g = buildErGraph([
      { schema: "public", table: "users", detail: d(["id"], [{ conname: "users_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null }]) },
      {
        schema: "public",
        table: "orders",
        detail: d(["id", "user_id"], [
          { conname: "fk_orders_user", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] },
        ]),
      },
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].source).toBe("public.orders");
    expect(g.edges[0].target).toBe("public.users");
    expect(g.edges[0].sourceColumns).toEqual(["user_id"]);
    expect(g.edges[0].targetColumns).toEqual(["id"]);
    expect(g.droppedEdges).toBe(0);
  });

  it("drops edges whose target table is outside the captured set", () => {
    const g = buildErGraph([
      {
        schema: "public",
        table: "orders",
        detail: d(["id", "uid"], [
          { conname: "fk_missing", contype: "f", conkey: [2], confrelidname: "public.ghost", confkeycols: ["id"] },
        ]),
      },
    ]);
    expect(g.edges).toHaveLength(0);
    expect(g.droppedEdges).toBe(1);
  });

  it("keeps self-references", () => {
    const g = buildErGraph([
      {
        schema: "public",
        table: "tree",
        detail: d(["id", "parent_id"], [
          { conname: "fk_parent", contype: "f", conkey: [2], confrelidname: "public.tree", confkeycols: ["id"] },
        ]),
      },
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].source).toBe("public.tree");
    expect(g.edges[0].target).toBe("public.tree");
  });

  it("resolves multi-column fk ordinals", () => {
    const g = buildErGraph([
      { schema: "s", table: "a", detail: d(["k1", "k2"], [{ conname: "a_pk", contype: "p", conkey: [1, 2], confrelidname: null, confkeycols: null }]) },
      {
        schema: "s",
        table: "b",
        detail: d(["x1", "x2"], [{ conname: "fk_multi", contype: "f", conkey: [2, 1], confrelidname: "s.a", confkeycols: ["k2", "k1"] }]),
      },
    ]);
    expect(g.edges[0].sourceColumns).toEqual(["x2", "x1"]);
    expect(g.edges[0].targetColumns).toEqual(["k2", "k1"]);
  });

  it("returns empty graph for empty input", () => {
    const g = buildErGraph([]);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.droppedEdges).toBe(0);
  });

  it("is deterministic across runs", () => {
    const input = [
      { schema: "public", table: "b", detail: d(["id"], []) },
      { schema: "public", table: "a", detail: d(["id"], []) },
    ];
    const g1 = buildErGraph(input);
    const g2 = buildErGraph(input);
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
    // Node order is input order (stable); edges sorted by id.
    expect(g1.nodes.map((n) => n.table)).toEqual(["b", "a"]);
  });

  it("sorts edges by id for stable output", () => {
    const g = buildErGraph([
      { schema: "public", table: "users", detail: d(["id"], [{ conname: "users_pk", contype: "p", conkey: [1], confrelidname: null, confkeycols: null }]) },
      {
        schema: "public",
        table: "zeta",
        detail: d(["id", "u"], [{ conname: "zz_fk", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]),
      },
      {
        schema: "public",
        table: "alpha",
        detail: d(["id", "u"], [{ conname: "aa_fk", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]),
      },
    ]);
    expect(g.edges.map((e) => e.id)).toEqual(["aa_fk", "zz_fk"]);
  });
});
