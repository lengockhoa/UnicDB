// src/ai/__tests__/changePlan.test.ts — TASK-AIX04-001
import { describe, it, expect } from "vitest";
import {
  classifyStatements,
  validatePlanStatements,
  detectDrift,
} from "../changePlan";

describe("classifyStatements", () => {
  it("DELETE w/o WHERE → red + dangerNote", () => {
    const p = classifyStatements(["DELETE FROM users"]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      kind: "delete",
      tier: "red",
      hasWhere: false,
    });
    expect(p[0].dangerNote).toContain("destructive");
  });

  it("UPDATE with WHERE → none, no dangerNote", () => {
    const p = classifyStatements(["UPDATE users SET a = 1 WHERE id = 2"]);
    expect(p[0]).toMatchObject({ kind: "update", tier: "none" });
    expect(p[0].dangerNote).toBe("");
  });

  it("DROP → red", () => {
    const p = classifyStatements(["DROP TABLE users"]);
    expect(p[0]).toMatchObject({ kind: "drop", tier: "red" });
  });

  it("GRANT → admin-red + DCL note", () => {
    const p = classifyStatements(["GRANT SELECT ON users TO app"]);
    expect(p[0]).toMatchObject({ kind: "grant", tier: "admin-red" });
    expect(p[0].dangerNote).toContain("admin DCL");
  });

  it("SELECT → none", () => {
    const p = classifyStatements(["SELECT * FROM users"]);
    expect(p[0]).toMatchObject({ kind: "other", tier: "none" });
  });

  it("multi-statement array classifies each", () => {
    const p = classifyStatements(["SELECT 1", "DROP TABLE x"]);
    expect(p.map((s) => s.tier)).toEqual(["none", "red"]);
  });
});

describe("validatePlanStatements", () => {
  it("empty / missing / non-array → error", () => {
    expect(validatePlanStatements([]).length).toBeGreaterThan(0);
    expect(validatePlanStatements(undefined).length).toBeGreaterThan(0);
    expect(validatePlanStatements("DROP TABLE x").length).toBeGreaterThan(0);
    expect(validatePlanStatements([""]).length).toBeGreaterThan(0);
    expect(validatePlanStatements(["   "]).length).toBeGreaterThan(0);
  });

  it("valid multi-line SQL passes", () => {
    const errs = validatePlanStatements([
      "ALTER TABLE public.users ADD COLUMN bio text;\nCOMMENT ON COLUMN public.users.bio IS 'x';",
    ]);
    expect(errs).toEqual([]);
  });
});

describe("detectDrift", () => {
  it("identical sets → []", () => {
    expect(detectDrift(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("missing / extra columns reported sorted", () => {
    expect(detectDrift(["a", "b", "c"], ["a", "d"])).toEqual(["b", "c", "d"]);
  });

  it("renamed column shows as missing + extra", () => {
    expect(detectDrift(["old_name"], ["new_name"])).toEqual(["new_name", "old_name"]);
  });
});
