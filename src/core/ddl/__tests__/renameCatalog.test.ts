// src/core/ddl/__tests__/renameCatalog.test.ts — TASK-DBX06-002
import { describe, it, expect } from "vitest";
import {
  DEPENDENT_VIEWS_SQL,
  TABLE_FKS_SQL,
  ROUTINES_SQL,
  NAME_COLLISION_SQL,
  buildRenamePlan,
} from "../renameCatalog";
import type { RenameCatalogRows } from "../renameAnalysis";

const EMPTY: RenameCatalogRows = {
  dependentViews: [],
  referencingFks: [],
  routines: [],
  collisions: [],
};

describe("SQL builders are parameterized", () => {
  it("all four use $1/$2 placeholders and never interpolate identifiers", () => {
    for (const sql of [DEPENDENT_VIEWS_SQL(), TABLE_FKS_SQL(), ROUTINES_SQL(), NAME_COLLISION_SQL()]) {
      expect(sql).toMatch(/\$1/);
      expect(sql).not.toMatch(/\$\{schema\}|\$\{table\}|\$\{name\}/);
    }
    expect(DEPENDENT_VIEWS_SQL()).toMatch(/\$2/);
    expect(NAME_COLLISION_SQL()).toMatch(/\$2/);
  });

  it("catalog queries reference pg_catalog only (no information_schema)", () => {
    for (const sql of [DEPENDENT_VIEWS_SQL(), TABLE_FKS_SQL(), ROUTINES_SQL(), NAME_COLLISION_SQL()]) {
      expect(sql).not.toContain("information_schema");
    }
  });
});

describe("buildRenamePlan", () => {
  it("table rename → single RENAME TO statement + report", () => {
    const p = buildRenamePlan({
      kind: "table",
      schema: "public",
      table: "users",
      oldName: "users",
      newName: "customers",
      rows: EMPTY,
    });
    expect(p.errors).toEqual([]);
    expect(p.statements).toEqual(['ALTER TABLE "public"."users" RENAME TO "customers";']);
    expect(p.report.views).toHaveLength(0);
  });

  it("column rename → single RENAME COLUMN statement", () => {
    const p = buildRenamePlan({
      kind: "column",
      schema: "public",
      table: "users",
      oldName: "name",
      newName: "full_name",
      rows: EMPTY,
    });
    expect(p.errors).toEqual([]);
    expect(p.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME COLUMN "name" TO "full_name";',
    ]);
  });

  it("collision → error + NO statements", () => {
    const p = buildRenamePlan({
      kind: "table",
      schema: "public",
      table: "users",
      oldName: "users",
      newName: "customers",
      rows: { ...EMPTY, collisions: ["customers (table)"] },
    });
    expect(p.statements).toEqual([]);
    expect(p.errors.join(" ")).toContain("customers (table)");
  });

  it("same name → error + NO statements", () => {
    const p = buildRenamePlan({
      kind: "table",
      schema: "public",
      table: "users",
      oldName: "users",
      newName: "users",
      rows: EMPTY,
    });
    expect(p.statements).toEqual([]);
    expect(p.errors.length).toBeGreaterThan(0);
  });

  it("usage report rides alongside (reviewable)", () => {
    const p = buildRenamePlan({
      kind: "table",
      schema: "public",
      table: "users",
      oldName: "users",
      newName: "customers",
      rows: {
        dependentViews: [{ name: "v_users", kind: "view" }],
        referencingFks: [{ constraint: "fk_orders_users", fromTable: "orders" }],
        routines: [{ name: "sync_users" }],
        collisions: [],
      },
    });
    expect(p.report.views).toEqual([{ name: "v_users", kind: "view" }]);
    expect(p.report.fks).toHaveLength(1);
    expect(p.report.routines).toHaveLength(1);
  });
});
