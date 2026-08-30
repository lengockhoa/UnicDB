// src/core/compare/__tests__/syncPlan.test.ts
// TASK-DBX03-003 — directional sync plan: safety flags, group order,
// parameterized-shaped SQL, dangerous labeling.

import { describe, it, expect } from "vitest";
import { buildSyncPlan } from "../syncPlan";
import { diffSchema, type TableShape } from "../schemaDiff";
import { diffData } from "../dataDiff";

function col(name: string, dataType = "text", nullable = false, defaultValue: string | null = null) {
  return { name, dataType, nullable, defaultValue };
}

const shape: TableShape = {
  columns: [col("id", "integer"), col("name", "text", true)],
  primaryKeys: ["id"],
};

const tables = {
  sourceTable: { schema: "public", table: "users" },
  targetTable: { schema: "public", table: "users_new" },
};

describe("buildSyncPlan — safety", () => {
  it("is non-executable when the shape is incompatible; data group empty", () => {
    const target: TableShape = {
      columns: [col("id", "bigint"), col("name", "text", true)],
      primaryKeys: ["id"],
    };
    const shapeDiff = diffSchema(shape, target);
    const dataDiff = diffData(["id"], [{ id: 1, name: "a" }], [{ id: 1, name: "a" }], ["id", "name"]);
    const plan = buildSyncPlan({ source: shape, target, schemaDiff: shapeDiff, dataDiff, ...tables });
    expect(plan.executable).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/id/);
    expect(plan.groups.find((g) => g.id === "data")?.statements).toEqual([]);
  });

  it("keeps the data group empty with a reason when the data diff was skipped (no key)", () => {
    const shapeDiff = diffSchema(shape, shape);
    const dataDiff = diffData([], [], [], ["id"]);
    const plan = buildSyncPlan({ source: shape, target: shape, schemaDiff: shapeDiff, dataDiff, ...tables });
    expect(plan.executable).toBe(false);
    expect(plan.reasons.join(" ").toLowerCase()).toMatch(/key/);
    expect(plan.groups.find((g) => g.id === "data")?.statements).toEqual([]);
  });

  it("marks DROP COLUMN statements dangerous", () => {
    const target: TableShape = { columns: [...shape.columns, col("legacy")], primaryKeys: ["id"] };
    const shapeDiff = diffSchema(shape, target);
    const dataDiff = diffData(["id"], [], [], ["id", "name"]);
    const plan = buildSyncPlan({ source: shape, target, schemaDiff: shapeDiff, dataDiff, ...tables });
    const drops = plan.groups.find((g) => g.id === "ddl")?.statements.filter((s) => s.dangerous) ?? [];
    expect(drops.length).toBe(1);
    expect(drops[0]?.sql).toMatch(/DROP COLUMN/i);
  });
});

describe("buildSyncPlan — ordering", () => {
  it("orders DDL: ADD COLUMN → ALTER → DROP COLUMN", () => {
    const source: TableShape = {
      columns: [col("id", "integer"), col("name", "varchar", true), col("email")],
      primaryKeys: ["id"],
    };
    const target: TableShape = {
      columns: [col("id", "integer"), col("name", "text", true), col("legacy")],
      primaryKeys: ["id"],
    };
    const shapeDiff = diffSchema(source, target);
    const dataDiff = diffData(["id"], [], [], ["id", "name", "email"]);
    const plan = buildSyncPlan({ source, target, schemaDiff: shapeDiff, dataDiff, ...tables });
    const ddl = plan.groups.find((g) => g.id === "ddl")?.statements.map((s) => s.sql) ?? [];
    const addIdx = ddl.findIndex((s) => /ADD COLUMN/i.test(s));
    const alterIdx = ddl.findIndex((s) => /ALTER COLUMN/i.test(s));
    const dropIdx = ddl.findIndex((s) => /DROP COLUMN/i.test(s));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(addIdx);
    expect(dropIdx).toBeGreaterThan(alterIdx);
  });

  it("emits groups [ddl, data] with INSERT → UPDATE → DELETE order and summaries", () => {
    const shapeDiff = diffSchema(shape, shape);
    const dataDiff = diffData(
      ["id"],
      [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }],
      [{ id: 2, name: "B" }, { id: 4, name: "d" }],
      ["id", "name"],
    );
    const plan = buildSyncPlan({ source: shape, target: shape, schemaDiff: shapeDiff, dataDiff, ...tables });
    expect(plan.groups.map((g) => g.id)).toEqual(["ddl", "data"]);
    expect(plan.totals).toEqual({ ddl: 0, data: 4 });
    const data = plan.groups.find((g) => g.id === "data")?.statements.map((s) => s.sql) ?? [];
    expect(data.findIndex((s) => /INSERT INTO/i.test(s))).toBeLessThan(data.findIndex((s) => /UPDATE /i.test(s)));
    expect(data.findIndex((s) => /UPDATE /i.test(s))).toBeLessThan(data.findIndex((s) => /DELETE FROM/i.test(s)));
    for (const g of plan.groups) {
      for (const s of g.statements) {
        expect(s.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the ddl group empty when only data differs", () => {
    const shapeDiff = diffSchema(shape, shape);
    const dataDiff = diffData(["id"], [{ id: 1, name: "a" }], [], ["id", "name"]);
    const plan = buildSyncPlan({ source: shape, target: shape, schemaDiff: shapeDiff, dataDiff, ...tables });
    expect(plan.groups.find((g) => g.id === "ddl")?.statements).toEqual([]);
    expect(plan.totals.data).toBe(1);
  });
});

describe("buildSyncPlan — parameterization safety", () => {
  it("carries values in parallel arrays; SQL uses $N placeholders, never literal values", () => {
    const shapeDiff = diffSchema(shape, shape);
    const nasty = "robert'); DROP TABLE students;--";
    const dataDiff = diffData(
      ["id"],
      [{ id: 1, name: nasty }, { id: 2, name: "u" }],
      [{ id: 2, name: "U" }],
      ["id", "name"],
    );
    const plan = buildSyncPlan({ source: shape, target: shape, schemaDiff: shapeDiff, dataDiff, ...tables });
    const data = plan.groups.find((g) => g.id === "data")?.statements ?? [];
    expect(data.length).toBeGreaterThan(0);
    for (const s of data) {
      if (/VALUES/i.test(s.sql)) {
        expect(s.sql).toMatch(/\$\d+/);
        expect(/'.*robert/.test(s.sql)).toBe(false);
        expect(/'.*students/.test(s.sql)).toBe(false);
      }
      if (/SET /i.test(s.sql)) {
        expect(s.sql).toMatch(/=\s*\$\d+/);
        expect(/'.*U'/.test(s.sql)).toBe(false);
      }
      if (s.values !== undefined) {
        expect(Array.isArray(s.values)).toBe(true);
      }
    }
  });

  it("quotes identifiers with double quotes", () => {
    const shapeDiff = diffSchema(shape, shape);
    const dataDiff = diffData(["id"], [{ id: 1, name: "a" }], [], ["id", "name"]);
    const plan = buildSyncPlan({ source: shape, target: shape, schemaDiff: shapeDiff, dataDiff, ...tables });
    const insert = plan.groups.find((g) => g.id === "data")?.statements[0];
    expect(insert?.sql).toMatch(/INSERT INTO "public"\."users_new"/);
  });
});

describe("buildSyncPlan — reviewer fixes (regression)", () => {
  it("applies SOURCE-side values in ALTER statements (directional fix)", () => {
    const source: TableShape = {
      columns: [col("id", "integer"), col("name", "varchar", true)],
      primaryKeys: ["id"],
    };
    const target: TableShape = {
      columns: [col("id", "integer"), col("name", "text", true)],
      primaryKeys: ["id"],
    };
    const shapeDiff = diffSchema(source, target);
    const dataDiff = diffData(["id"], [], [], ["id", "name"]);
    const plan = buildSyncPlan({ source, target, schemaDiff: shapeDiff, dataDiff, ...tables });
    const alter = plan.groups.find((g) => g.id === "ddl")?.statements.find((s) => /ALTER COLUMN/i.test(s.sql));
    expect(alter?.sql).toContain("varchar"); // source type, not target's text
    expect(alter?.sql).not.toMatch(/TYPE text/);
  });
});

describe("buildSyncPlan — unique-key WHERE binding (reviewer round 2)", () => {
  it("binds UPDATE/DELETE WHERE against dataDiff.keys (unique key, no PK)", () => {
    const source: TableShape = {
      columns: [col("code", "text"), col("val", "text", true)],
      primaryKeys: [], // no PK — service keyed on unique NOT NULL "code"
    };
    // K2 exists ONLY in target -> DELETE; K1 changed -> UPDATE.
    const dataDiff = diffData(
      ["code"],
      [{ code: "K1", val: "s" }],
      [{ code: "K1", val: "t" }, { code: "K2", val: "gone" }],
      ["code", "val"],
    );
    const plan = buildSyncPlan({ source, target: source, schemaDiff: diffSchema(source, source), dataDiff, ...tables });
    expect(plan.executable).toBe(true);
    const update = plan.groups.find((g) => g.id === "data")?.statements.find((s) => /UPDATE /i.test(s.sql));
    expect(update?.sql).toMatch(/WHERE "code" = \$2;/);
    expect(update?.sql).not.toMatch(/WHERE ;/);
    expect(update?.values).toEqual(["t", "K1"]);
    const del = plan.groups.find((g) => g.id === "data")?.statements.find((s) => /DELETE FROM/i.test(s.sql));
    expect(del?.sql).toMatch(/WHERE "code" = \$1;/);
    expect(del?.sql).not.toMatch(/WHERE ;/);
    expect(del?.values).toEqual(["K2"]);
  });
});
