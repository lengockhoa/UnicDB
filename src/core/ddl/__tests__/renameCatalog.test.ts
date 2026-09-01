// src/core/ddl/__tests__/renameCatalog.test.ts — TASK-DBX06-002 + DBX06-005
import { describe, it, expect } from "vitest";
import {
  DEPENDENT_VIEWS_SQL,
  TABLE_FKS_SQL,
  ROUTINES_SQL,
  NAME_COLLISION_SQL,
  TRIGGERS_SQL,
  INDEXES_SQL,
  buildRenamePlan,
} from "../renameCatalog";
import type { RenameCatalogRows } from "../renameAnalysis";

const EMPTY: RenameCatalogRows = {
  dependentViews: [],
  referencingFks: [],
  routines: [],
  triggers: [],
  indexes: [],
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

describe("TRIGGERS_SQL / INDEXES_SQL (DBX06-005) — pinned $1/$2/$3 contract", () => {
  it("trigger template uses $1, $2, $3 and tgattr + tgqual; excludes function body", () => {
    const sql = TRIGGERS_SQL();
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2/);
    expect(sql).toMatch(/\$3/);
    expect(sql).toContain("tgattr");
    expect(sql).toContain("pg_get_expr(t.tgqual, t.tgrelid)");
    expect(sql).toContain("\\m");
    expect(sql).toContain("\\M");
    expect(sql).not.toMatch(/\$\{schema\}|\$\{table\}|\$\{column\}/);
    expect(sql).not.toContain("pg_proc");
    expect(sql).not.toContain("prosrc");
    expect(sql).not.toContain("pg_get_functiondef");
  });

  it("index template uses $1, $2, $3 and indkey + indexprs + indpred; excludes function body", () => {
    const sql = INDEXES_SQL();
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2/);
    expect(sql).toMatch(/\$3/);
    expect(sql).toContain("indkey");
    expect(sql).toContain("pg_get_expr(i.indexprs, i.indrelid)");
    expect(sql).toContain("pg_get_expr(i.indpred, i.indrelid)");
    expect(sql).toContain("\\m");
    expect(sql).toContain("\\M");
    expect(sql).not.toMatch(/\$\{schema\}|\$\{table\}|\$\{column\}/);
    expect(sql).not.toContain("pg_proc");
    expect(sql).not.toContain("prosrc");
    expect(sql).not.toContain("pg_get_functiondef");
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

  it("collision → error + NO statements (DBX06-005 pinned diagnostic)", () => {
    const p = buildRenamePlan({
      kind: "table",
      schema: "public",
      table: "users",
      oldName: "users",
      newName: "customers",
      rows: { ...EMPTY, collisions: ["customers (table)"] },
    });
    expect(p.statements).toEqual([]);
    expect(p.steps).toEqual([]);
    expect(p.errors).toEqual([
      "Name collision — target already exists: customers (table).",
    ]);
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
    expect(p.steps).toEqual([]);
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
        triggers: [{ name: "trg_audit", event: "INSERT", timing: "BEFORE" }],
        indexes: [{ name: "idx_users_name", isPrimary: false, isUnique: true, columns: ["name"] }],
        collisions: [],
      },
    });
    expect(p.report.views).toEqual([{ name: "v_users", kind: "view" }]);
    expect(p.report.fks).toHaveLength(1);
    expect(p.report.routines).toHaveLength(1);
    expect(p.report.triggers).toHaveLength(1);
    expect(p.report.indexes).toHaveLength(1);
  });

  it("expanded table plan: 1 executable step + review steps for each dependency (DBX06-005)", () => {
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
        triggers: [{ name: "trg_audit", event: "INSERT", timing: "BEFORE" }],
        indexes: [{ name: "idx_users_name", isPrimary: false, isUnique: true, columns: ["name"] }],
        collisions: [],
      },
    });
    expect(p.errors).toEqual([]);
    expect(p.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    ]);
    const exec = p.steps.filter((s) => s.executable);
    const review = p.steps.filter((s) => !s.executable);
    expect(exec).toHaveLength(1);
    expect(exec[0]).toMatchObject({ kind: "rename", executable: true });
    expect(exec[0].statement).toBe(
      'ALTER TABLE "public"."users" RENAME TO "customers";',
    );
    // Every populated dependency → one non-executable review step.
    expect(review).toHaveLength(5);
    const reviewKinds = review.map((r) => r.kind).sort();
    expect(reviewKinds).toEqual([
      "fks",
      "indexes",
      "routines",
      "triggers",
      "views",
    ]);
  });

  it("ordered multi-operation plan: 2 executable steps, statements match order (DBX06-005)", () => {
    const p = buildRenamePlan({
      kind: "table",
      schema: "public",
      table: "users",
      oldName: "users",
      newName: "customers",
      operations: [
        { kind: "table", schema: "public", table: "users", oldName: "users", newName: "customers" },
        { kind: "column", schema: "public", table: "customers", oldName: "name", newName: "full_name" },
      ],
      rows: {
        dependentViews: [],
        referencingFks: [],
        routines: [],
        triggers: [],
        indexes: [],
        collisions: [],
      },
    });
    expect(p.errors).toEqual([]);
    const exec = p.steps.filter((s) => s.executable);
    expect(exec).toHaveLength(2);
    expect(p.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "customers";',
      'ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";',
    ]);
  });
});
