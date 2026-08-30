// src/core/compare/__tests__/schemaDiff.test.ts
// TASK-DBX03-001 — schema diff: identical/added/dropped/changed/pk
// classification with deterministic ordering and a compatibility flag.

import { describe, it, expect } from "vitest";
import { diffSchema, shapeFromTableDetail, type TableShape } from "../schemaDiff";

function col(name: string, dataType = "text", nullable = false, defaultValue: string | null = null) {
  return { name, dataType, nullable, defaultValue };
}

const base: TableShape = {
  columns: [col("id", "integer"), col("name", "text", true)],
  primaryKeys: ["id"],
};

describe("diffSchema — identical", () => {
  it("reports identical shapes with zero entries", () => {
    const result = diffSchema(base, base);
    expect(result.identical).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it("handles both shapes empty without throwing", () => {
    const empty: TableShape = { columns: [], primaryKeys: [] };
    const result = diffSchema(empty, empty);
    expect(result.identical).toBe(true);
    expect(result.entries).toEqual([]);
  });
});

describe("diffSchema — column set changes", () => {
  it("classifies a column added in source with source ordering", () => {
    const source: TableShape = { columns: [...base.columns, col("email")], primaryKeys: ["id"] };
    const result = diffSchema(source, base);
    expect(result.identical).toBe(false);
    const added = result.entries.filter((e) => e.kind === "added");
    expect(added).toEqual([{ kind: "added", column: "email", position: 2 }]);
  });

  it("classifies a target-only column as dropped", () => {
    const target: TableShape = { columns: [...base.columns, col("legacy")], primaryKeys: ["id"] };
    const result = diffSchema(base, target);
    expect(result.entries.filter((e) => e.kind === "dropped")).toEqual([
      { kind: "dropped", column: "legacy" },
    ]);
  });

  it("orders multiple dropped columns alphabetically", () => {
    const target: TableShape = {
      columns: [...base.columns, col("zeta"), col("alpha")],
      primaryKeys: ["id"],
    };
    const result = diffSchema(base, target);
    const dropped = result.entries.filter((e) => e.kind === "dropped");
    expect(dropped.map((e) => (e as { column: string }).column)).toEqual(["alpha", "zeta"]);
  });
});

describe("diffSchema — attribute changes", () => {
  it("classifies a type change with from/to", () => {
    const target: TableShape = {
      columns: [col("id", "integer"), col("name", "varchar", true)],
      primaryKeys: ["id"],
    };
    const result = diffSchema(base, target);
    expect(result.entries).toContainEqual({
      kind: "changed", column: "name", change: "type", from: "text", to: "varchar",
    });
  });

  it("emits separate entries for type/nullable/default changes on one column", () => {
    const target: TableShape = {
      columns: [col("id", "bigint", true, "nextval('x')"), col("name", "text", true)],
      primaryKeys: ["id"],
    };
    const result = diffSchema(base, target);
    const changes = result.entries.filter((e) => e.kind === "changed");
    expect(changes).toEqual([
      { kind: "changed", column: "id", change: "type", from: "integer", to: "bigint" },
      { kind: "changed", column: "id", change: "nullable", from: false, to: true },
      { kind: "changed", column: "id", change: "default", from: null, to: "nextval('x')" },
    ]);
  });

  it("classifies a PK set change", () => {
    const target: TableShape = { columns: base.columns, primaryKeys: ["name"] };
    const result = diffSchema(base, target);
    expect(result.entries).toContainEqual({ kind: "pk-changed", from: ["id"], to: ["name"] });
  });
});

describe("diffSchema — compatibility", () => {
  it("is incompatible on a type change even when column sets match", () => {
    const target: TableShape = {
      columns: [col("id", "bigint"), col("name", "text", true)],
      primaryKeys: ["id"],
    };
    const result = diffSchema(base, target);
    expect(result.compatible).toBe(false);
  });

  it("is incompatible when column sets differ", () => {
    const source: TableShape = { columns: [...base.columns, col("email")], primaryKeys: ["id"] };
    expect(diffSchema(source, base).compatible).toBe(false);
    expect(diffSchema(base, source).compatible).toBe(false);
  });
});

describe("shapeFromTableDetail", () => {
  it("maps listTableDetail output, resolving PK columns from conkey ordinals", () => {
    const detail = {
      columns: [
        { column_name: "id", format_type: "integer", is_nullable: "NO" as const, column_default: null },
        { column_name: "name", format_type: "text", is_nullable: "YES" as const, column_default: null },
      ],
      constraints: [
        { conname: "t_pkey", contype: "p", conkey: [1], confrelidname: null, confkeycols: null, consrc: "" },
      ],
    };
    const shape = shapeFromTableDetail(detail);
    expect(shape.columns).toEqual([
      { name: "id", dataType: "integer", nullable: false, defaultValue: null },
      { name: "name", dataType: "text", nullable: true, defaultValue: null },
    ]);
    expect(shape.primaryKeys).toEqual(["id"]);
  });
});
