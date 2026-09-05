// src/adapters/__tests__/postgres.sortQuery.test.ts
//
// Unit tests cho getTableSortQuery (TASK-003) — pure SQL composition, không
// cần mock pg: hàm nhận (originalSql, whereFromBar, column, direction) và
// trả về chuỗi SQL wrapped trong subquery `UnicDB_sort` với ORDER BY trên
// quoted identifier (injection-safe).
import { describe, it, expect } from "vitest";
import { getTableSortQuery } from "../postgres";

describe("getTableSortQuery", () => {
  // Case 1 — unit: basic sort
  it("getTableSortQuery basic sort", () => {
    expect(getTableSortQuery("SELECT 1", "", "name", "ASC")).toBe(
      'SELECT * FROM (SELECT 1) UnicDB_sort ORDER BY "name" ASC',
    );
  });

  // Case 2 — unit: WHERE from requery bar included
  it("getTableSortQuery with WHERE", () => {
    const sql = getTableSortQuery("SELECT * FROM t", "age > 18", "name", "ASC");
    expect(sql).toContain("WHERE");
    expect(sql).toContain("age > 18");
    expect(sql).toContain("ORDER BY");
  });

  // Case 3 — unit: DESC direction
  it("getTableSortQuery DESC direction", () => {
    const sql = getTableSortQuery("SELECT 1", "", "name", "DESC");
    expect(sql).toContain('ORDER BY "name" DESC');
  });

  // Case 4 — unit: empty where → no WHERE clause
  it("getTableSortQuery empty where", () => {
    const sql = getTableSortQuery("SELECT 1", "", "name", "ASC");
    expect(sql).not.toMatch(/\bWHERE\b/);
  });

  // Case 5 — edge: column name with injection payload must land as ONE
  // quoted identifier token, never as executable SQL outside quotes.
  it("getTableSortQuery SQL injection in column name", () => {
    const sql = getTableSortQuery(
      "SELECT 1",
      "",
      "name; DROP TABLE users--",
      "ASC",
    );
    expect(sql).toContain('ORDER BY "name; DROP TABLE users--" ASC');
  });

  // Case 6 — edge: empty originalSql must not throw, still composes
  it("getTableSortQuery empty originalSql", () => {
    const sql = getTableSortQuery("", "", "name", "ASC");
    expect(typeof sql).toBe("string");
    expect(sql).toContain("UnicDB_sort");
    expect(sql).toContain('ORDER BY "name"');
  });

  // Case 7 — regression: original SQL preserved verbatim in the subquery
  it("getTableSortQuery preserves original SQL", () => {
    const original = "SELECT * FROM t WHERE id>5";
    const sql = getTableSortQuery(original, "", "name", "ASC");
    expect(sql).toContain(`(${original}) UnicDB_sort`);
  });
});
