// src/core/ddl/__tests__/renameAnalysis.test.ts — TASK-DBX06-001
import { describe, it, expect } from "vitest";
import {
  validateNewName,
  analyzeUsage,
  type RenameCatalogRows,
} from "../renameAnalysis";

const EMPTY: RenameCatalogRows = {
  dependentViews: [],
  referencingFks: [],
  routines: [],
  collisions: [],
};

describe("validateNewName", () => {
  it("valid plain identifier → null", () => {
    expect(validateNewName("users_2026")).toBeNull();
    expect(validateNewName("_private$x")).toBeNull();
  });

  it("empty / non-string rejected", () => {
    expect(validateNewName("")).toContain("non-empty");
    expect(validateNewName(undefined)).toContain("non-empty");
    expect(validateNewName(42)).toContain("non-empty");
  });

  it("non-plain identifier (quotes/semicolon/space/dash/dot) rejected", () => {
    expect(validateNewName('us"; DROP TABLE x; --')).toContain("plain identifier");
    expect(validateNewName("users; DROP")).toContain("plain identifier");
    expect(validateNewName("my-table")).toContain("plain identifier");
    expect(validateNewName("my.table")).toContain("plain identifier");
    expect(validateNewName("1abc")).toContain("plain identifier");
  });

  it("forbidden keyword at a left boundary rejected (containsForbidden parity)", () => {
    expect(validateNewName("inserted_at")).toContain("forbidden");
    expect(validateNewName("created_at")).toContain("forbidden");
    expect(validateNewName("DELETE_ME")).toContain("forbidden");
    expect(validateNewName("deleted_count")).toContain("forbidden");
    // No left-boundary keyword → allowed.
    expect(validateNewName("updated_rows_count")).toContain("forbidden"); // "update" at start
    expect(validateNewName("xupdated")).toBeNull(); // keyword not at boundary
  });
});

describe("analyzeUsage", () => {
  it("empty catalog → zero usage, safe", () => {
    const r = analyzeUsage(EMPTY);
    expect(r.usageCount).toBe(0);
    expect(r.safe).toBe(true);
    expect(r.report.views).toHaveLength(0);
  });

  it("counts views + fks + routines, safe stays true without collisions", () => {
    const rows: RenameCatalogRows = {
      dependentViews: [{ name: "v_users", kind: "view" }],
      referencingFks: [
        { constraint: "fk_orders", fromTable: "orders" },
        { constraint: "fk_audit", fromTable: "audit" },
      ],
      routines: [{ name: "sync_users" }],
      collisions: [],
    };
    const r = analyzeUsage(rows);
    expect(r.usageCount).toBe(4);
    expect(r.safe).toBe(true);
    expect(r.report.fks).toHaveLength(2);
  });

  it("collisions → unsafe", () => {
    const rows: RenameCatalogRows = {
      ...EMPTY,
      collisions: ["users_backup (table)"],
    };
    const r = analyzeUsage(rows);
    expect(r.safe).toBe(false);
    expect(r.report.collisions).toEqual(["users_backup (table)"]);
  });
});
