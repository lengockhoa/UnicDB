// src/adapters/__tests__/mssql.sortQuery.test.ts
//
// TASK-006 — unit tests cho getTableSortQuery (T-SQL dialect) — pure SQL
// composition, không cần mock tedious: hàm nhận (originalSql, whereFromBar,
// column, direction) và trả về chuỗi SQL wrapped trong subquery `vsdb_sort`
// với ORDER BY trên quoted identifier (injection-safe). Importing MsSqlAdapter's
// module is safe because `tedious` is only imported, never connected.
import { describe, it, expect } from "vitest";
import { getTableSortQuery } from "../mssql";

describe("getTableSortQuery", () => {
  // Case 1 — unit (happy): basic sort wraps in a subquery with bracket quoting
  it("basic sort wraps in a subquery with bracket quoting", () => {
    expect(getTableSortQuery("SELECT 1", "", "name", "ASC")).toBe(
      "SELECT * FROM (SELECT 1) vsdb_sort ORDER BY [name] ASC",
    );
  });

  // Case 2 — unit (happy): WHERE from the requery bar is applied to the OUTER query
  it("WHERE from the requery bar is applied to the OUTER query", () => {
    const sql = getTableSortQuery("SELECT * FROM t", "age > 18", "name", "ASC");
    expect(sql).toBe(
      "SELECT * FROM (SELECT * FROM t) vsdb_sort WHERE age > 18 ORDER BY [name] ASC",
    );
    // the inner SQL is verbatim inside the subquery
    expect(sql).toContain("(SELECT * FROM t) vsdb_sort");
  });

  // Case 3 — unit (happy): DESC direction is emitted
  it("DESC direction is emitted", () => {
    expect(getTableSortQuery("SELECT 1", "", "name", "DESC")).toContain(
      "ORDER BY [name] DESC",
    );
  });

  // Case 4 — edge (identifier injection): `]` inside a column name is doubled
  // and stays one identifier; the payload never appears outside the brackets.
  it("] inside a column name is doubled and stays one identifier", () => {
    const sql = getTableSortQuery(
      "SELECT 1",
      "",
      "name]; DROP TABLE users--",
      "ASC",
    );
    expect(sql).toBe(
      "SELECT * FROM (SELECT 1) vsdb_sort ORDER BY [name]]; DROP TABLE users--] ASC",
    );
  });

  // Case 5 — edge (direction whitelist): an unexpected direction falls back to ASC
  it("an unexpected direction falls back to ASC", () => {
    const sql = getTableSortQuery(
      "SELECT 1",
      "",
      "n",
      "ASC; DROP TABLE t" as unknown as "ASC",
    );
    expect(sql).toMatch(/ASC$/);
    expect(sql).not.toContain("DROP");
  });

  // Case 6 — edge (empty inputs): empty originalSql and empty where produce no stray WHERE
  it("empty originalSql and empty where produce no stray WHERE", () => {
    const sql = getTableSortQuery("", "", "n", "ASC");
    expect(sql).toBe("SELECT * FROM () vsdb_sort ORDER BY [n] ASC");
    expect(sql).not.toMatch(/\bWHERE\b/);
  });

  // Case 7 — edge (whitespace-only where): a whitespace-only WHERE is treated as empty
  it("a whitespace-only WHERE is treated as empty", () => {
    const sql = getTableSortQuery("SELECT 1", "   ", "n", "ASC");
    expect(sql).not.toMatch(/\bWHERE\b/);
  });
});
