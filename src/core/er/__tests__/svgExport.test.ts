import { describe, expect, it } from "vitest";
import { buildErGraph, type ErGraphInput } from "../fkGraph";
import { layoutErGraph, NODE_W } from "../layout";
import { renderErSvg } from "../svgExport";

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

describe("renderErSvg", () => {
  it("returns an empty svg for an empty graph", () => {
    const g = buildErGraph([]);
    const svg = renderErSvg(g, layoutErGraph(g), "t");
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<rect");
  });

  it("escapes xml-special characters in table and constraint names", () => {
    const g = buildErGraph([
      {
        schema: "pu\"blic",
        table: "a&b<c>",
        detail: d(["id", "u"], [{ conname: "fk'x", contype: "f", conkey: [2], confrelidname: 'pu"blic.a&b<c>', confkeycols: ["id"] }]),
      },
      { schema: "pu\"blic", table: "p", detail: d(["id"], []) },
    ]);
    const svg = renderErSvg(g, layoutErGraph(g), "ti&tle");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&gt;");
    expect(svg).not.toMatch(/a&b<c>/);
    expect(svg).not.toMatch(/ti&tle/);
  });

  it("includes a node rect per table and the title", () => {
    const g = buildErGraph([{ schema: "public", table: "users", detail: d(["id"], []) }]);
    const svg = renderErSvg(g, layoutErGraph(g), "My Schema");
    expect(svg.match(/<rect/g)).toHaveLength(1);
    expect(svg).toContain("users");
    expect(svg).toContain("My Schema");
  });

  it("draws one edge line per fk with cardinality labels", () => {
    const g = buildErGraph([
      { schema: "public", table: "users", detail: d(["id"], []) },
      { schema: "public", table: "orders", detail: d(["id", "u"], [{ conname: "fk1", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]) },
    ]);
    const svg = renderErSvg(g, layoutErGraph(g), "t");
    expect(svg.match(/<line/g)).toHaveLength(1);
    expect(svg).toContain("N");
    expect(svg).toContain("1");
  });

  it("viewBox matches layout dimensions", () => {
    const g = buildErGraph([
      { schema: "public", table: "users", detail: d(["id"], []) },
      { schema: "public", table: "c", detail: d(["id", "u"], [{ conname: "k", contype: "f", conkey: [2], confrelidname: "public.users", confkeycols: ["id"] }]) },
    ]);
    const layout = layoutErGraph(g);
    const svg = renderErSvg(g, layout, "t");
    expect(svg).toContain(`viewBox="0 0 ${layout.width} ${layout.height}"`);
  });

  it("never emits a script element", () => {
    const g = buildErGraph([{ schema: "public", table: "users", detail: d(["id"], []) }]);
    const svg = renderErSvg(g, layoutErGraph(g), "t");
    expect(svg).not.toContain("<script");
  });

  it("is deterministic byte-for-byte", () => {
    const g = buildErGraph([
      { schema: "public", table: "b", detail: d(["id"], []) },
      { schema: "public", table: "a", detail: d(["id", "b"], [{ conname: "fk", contype: "f", conkey: [2], confrelidname: "public.b", confkeycols: ["id"] }]) },
    ]);
    const layout = layoutErGraph(g);
    expect(renderErSvg(g, layout, "t")).toBe(renderErSvg(g, layout, "t"));
  });

  it("positions node rects at layout coordinates", () => {
    const g = buildErGraph([{ schema: "public", table: "solo", detail: d(["id"], []) }]);
    const layout = layoutErGraph(g);
    const n = layout.nodes.get("public.solo");
    const svg = renderErSvg(g, layout, "t");
    expect(svg).toContain(`x="${n?.x}"`);
    expect(svg).toContain(`y="${n?.y}"`);
    expect(svg).toContain(`width="${NODE_W}"`);
  });
});
