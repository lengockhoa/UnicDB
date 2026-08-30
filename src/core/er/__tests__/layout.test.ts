import { describe, expect, it } from "vitest";
import { buildErGraph, type ErGraphInput } from "../fkGraph";
import { layoutErGraph } from "../layout";

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
  }>,
): Detail => ({ columns: columns.map(col), constraints });

const graph = (input: ErGraphInput) => buildErGraph(input);

describe("layoutErGraph", () => {
  it("returns an empty layout for an empty graph", () => {
    const r = layoutErGraph(graph([]));
    expect(r.nodes).toHaveLength(0);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });

  it("places every node with finite coordinates", () => {
    const r = layoutErGraph(
      graph([
        { schema: "public", table: "a", detail: d(["id"], []) },
        { schema: "public", table: "b", detail: d(["id"], []) },
      ]),
    );
    for (const n of r.nodes.values()) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.w).toBeGreaterThan(0);
      expect(n.h).toBeGreaterThan(0);
    }
  });

  it("layers parents above children (fk child below referenced parent)", () => {
    const g = graph([
      { schema: "public", table: "users", detail: d(["id"], [{ conname: "users_pk", contype: "p", conkey: [1], confrelidname: null, confkeycols: null }]) },
      {
        schema: "public",
        table: "orders",
        detail: d(["id", "uid"], [{ conname: "fk_o_u", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]),
      },
    ]);
    const r = layoutErGraph(g);
    const users = r.nodes.get("public.users");
    const orders = r.nodes.get("public.orders");
    expect(users && orders && users.y < orders.y).toBe(true);
  });

  it("terminates on a self-loop", () => {
    const g = graph([
      {
        schema: "public",
        table: "tree",
        detail: d(["id", "pid"], [{ conname: "fk_self", contype: "f", conkey: [2], confrelidname: "public.tree", confkeycols: ["id"] }]),
      },
    ]);
    const r = layoutErGraph(g);
    expect(r.nodes).toHaveLength(1);
  });

  it("terminates on a two-node cycle", () => {
    const g = graph([
      {
        schema: "public",
        table: "a",
        detail: d(["id", "b"], [{ conname: "fk_ab", contype: "f", conkey: [2], confrelidname: "public.b", confkeycols: ["id"] }]),
      },
      {
        schema: "public",
        table: "b",
        detail: d(["id", "a"], [{ conname: "fk_ba", contype: "f", conkey: [2], confrelidname: "public.a", confkeycols: ["id"] }]),
      },
    ]);
    const r = layoutErGraph(g);
    expect(r.nodes).toHaveLength(2);
  });

  it("does not overlap nodes in the same layer", () => {
    const g = graph([
      { schema: "public", table: "users", detail: d(["id"], []) },
      { schema: "public", table: "a1", detail: d(["id", "u"], [{ conname: "f1", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]) },
      { schema: "public", table: "a2", detail: d(["id", "u"], [{ conname: "f2", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]) },
    ]);
    const r = layoutErGraph(g);
    const a1 = r.nodes.get("public.a1");
    const a2 = r.nodes.get("public.a2");
    expect(a1 && a2 && a1.x !== a2.x).toBe(true);
  });

  it("is deterministic byte-for-byte", () => {
    const g = graph([
      { schema: "public", table: "b", detail: d(["id"], []) },
      { schema: "public", table: "a", detail: d(["id"], []) },
    ]);
    expect(JSON.stringify([...layoutErGraph(g).nodes])).toBe(
      JSON.stringify([...layoutErGraph(g).nodes]),
    );
  });

  it("sizes the canvas to contain all nodes", () => {
    const g = graph([
      { schema: "public", table: "users", detail: d(["id"], []) },
      { schema: "public", table: "c1", detail: d(["id", "u"], [{ conname: "k1", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]) },
      { schema: "public", table: "c2", detail: d(["id", "u"], [{ conname: "k2", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]) },
    ]);
    const r = layoutErGraph(g);
    for (const n of r.nodes.values()) {
      expect(n.x + n.w).toBeLessThanOrEqual(r.width);
      expect(n.y + n.h).toBeLessThanOrEqual(r.height);
    }
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});
