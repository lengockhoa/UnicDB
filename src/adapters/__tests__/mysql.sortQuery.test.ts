// src/adapters/__tests__/mysql.sortQuery.test.ts
//
// TASK-005 — unit tests cho getTableSortQuery (MySQL dialect) — pure SQL
// composition, không cần mock mysql2: hàm nhận (originalSql, whereFromBar,
// column, direction) và trả về chuỗi SQL wrapped trong subquery `UnicDB_sort`
// với ORDER BY trên backtick-quoted identifier (injection-safe qua
// `quoteIdent`). Importing MySqlAdapter's module is safe because `mysql2` is
// only imported, never connected. Mirrors mssql.sortQuery.test.ts case-for-
// case so the twins cannot drift.
import { describe, it, expect } from "vitest";
import { getTableSortQuery } from "../mysql";

describe("getTableSortQuery (mysql)", () => {
  // Case 1 — unit (happy): basic sort wraps in a subquery with backtick quoting
  it("basic sort wraps in a subquery with backtick quoting", () => {
    expect(getTableSortQuery("SELECT 1", "", "name", "ASC")).toBe(
      "SELECT * FROM (SELECT 1) UnicDB_sort ORDER BY `name` ASC",
    );
  });

  // Case 2 — unit (happy): WHERE from the requery bar is applied to the OUTER query
  it("WHERE from the requery bar is applied to the OUTER query", () => {
    const sql = getTableSortQuery("SELECT * FROM t", "age > 18", "name", "ASC");
    expect(sql).toBe(
      "SELECT * FROM (SELECT * FROM t) UnicDB_sort WHERE age > 18 ORDER BY `name` ASC",
    );
    // the inner SQL is verbatim inside the subquery
    expect(sql).toContain("(SELECT * FROM t) UnicDB_sort");
  });

  // Case 3 — unit (happy): DESC direction is emitted
  it("DESC direction is emitted", () => {
    expect(getTableSortQuery("SELECT 1", "", "name", "DESC")).toContain(
      "ORDER BY `name` DESC",
    );
  });

  // Case 4 — edge (identifier injection): backtick inside a column name is
  // doubled and stays one identifier; the payload never appears outside it.
  it("backtick inside a column name is doubled and stays one identifier", () => {
    const sql = getTableSortQuery("SELECT 1", "", "n`; DROP TABLE x--", "ASC");
    expect(sql).toBe(
      "SELECT * FROM (SELECT 1) UnicDB_sort ORDER BY `n``; DROP TABLE x--` ASC",
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
    expect(sql).toBe("SELECT * FROM () UnicDB_sort ORDER BY `n` ASC");
    expect(sql).not.toMatch(/\bWHERE\b/);
  });

  // Case 7 — edge (whitespace-only where): a whitespace-only WHERE is treated as empty
  it("a whitespace-only WHERE is treated as empty", () => {
    const sql = getTableSortQuery("SELECT 1", "   ", "n", "ASC");
    expect(sql).not.toMatch(/\bWHERE\b/);
  });
});
