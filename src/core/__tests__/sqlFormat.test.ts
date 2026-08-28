// src/core/__tests__/sqlFormat.test.ts
// TASK-AF-003 — pure SQL formatter (no vscode).
import { describe, it, expect } from "vitest";
import { formatSql, type FormatOptions } from "../sqlFormat";

describe("TASK-AF-003 — formatSql", () => {
  it("T1 — simple SELECT: keywords cased, clauses on own lines", () => {
    const out = formatSql("select a,b from t where x=1");
    expect(out).toBe("SELECT a, b\nFROM t\nWHERE x = 1");
  });

  it("T2 — JOIN … ON indented under FROM", () => {
    const out = formatSql("select t1.id,t2.name from t1 join t2 on t1.id=t2.id");
    // FROM line at base, JOIN line +1 indent, ON aligned with JOIN (or +2)
    expect(out).toContain("FROM t1");
    expect(out).toContain("  JOIN t2");
    expect(out).toContain("ON t1.id = t2.id");
    // No comma at start of next line; clauses on own lines
    expect(out.startsWith("SELECT t1.id, t2.name\nFROM t1")).toBe(true);
  });

  it("T3 — subquery indented inside FROM", () => {
    const out = formatSql("select * from (select a from inner_t where a>0) s");
    // Outer SELECT base, FROM (...) line should have indented inner SELECT
    expect(out).toContain("FROM (");
    expect(out).toContain("  SELECT a");
    expect(out).toContain("    FROM inner_t");
    expect(out).toContain("    WHERE a > 0");
  });

  it("T4 — INSERT/UPDATE/DELETE shaped per clause", () => {
    const insertOut = formatSql(
      "insert into t(a,b) values(1,2)",
    );
    expect(insertOut).toBe(
      "INSERT INTO t (a, b)\nVALUES (1, 2)",
    );

    const updateOut = formatSql(
      "update t set a=1,b=2 where id=5",
    );
    expect(updateOut).toBe(
      "UPDATE t\nSET a = 1, b = 2\nWHERE id = 5",
    );

    const deleteOut = formatSql("delete from t where id=5");
    expect(deleteOut).toBe("DELETE FROM t\nWHERE id = 5");
  });

  it("T5 — empty / whitespace-only input → empty string", () => {
    expect(formatSql("")).toBe("");
    expect(formatSql("  ")).toBe("");
    expect(formatSql("\n")).toBe("");
    expect(formatSql("  \n  ")).toBe("");
  });

  it("T6 — unbalanced parens → no throw, best-effort output", () => {
    expect(() => formatSql(")select 1(")).not.toThrow();
    const out = formatSql(")select 1(");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("T7 — strings and comments are never reformatted", () => {
    const sql =
      "select 'SELECT inside string' as a,\"select inside ident\" as b from t -- a select in line comment\nwhere /* select in block comment */ x=1";
    const out = formatSql(sql);
    // String literals preserved verbatim
    expect(out).toContain("'SELECT inside string'");
    expect(out).toContain('"select inside ident"');
    // Comments preserved verbatim
    expect(out).toContain("-- a select in line comment");
    expect(out).toContain("/* select in block comment */");
    // But the structural 'select' keyword was uppercased (outside strings/comments)
    expect(out).toMatch(/^SELECT /);
    expect(out).toContain("\nWHERE ");
  });

  it("T8 — idempotent: format(format(x)) === format(x)", () => {
    const fixtures: string[] = [
      "select a,b from t where x=1",
      "select t1.id,t2.name from t1 join t2 on t1.id=t2.id where t1.x>0",
      "select * from (select a from inner_t where a>0) s",
      "update t set a=1,b=2 where id=5",
    ];
    for (const f of fixtures) {
      const once = formatSql(f);
      const twice = formatSql(once);
      expect(twice).toBe(once);
    }
  });

  it("T9 — options honored (keywordCase + indent)", () => {
    const sql = "select a,b from t where x=1";
    const upperDefault = formatSql(sql);
    expect(upperDefault).toBe("SELECT a, b\nFROM t\nWHERE x = 1");

    const lower: FormatOptions = { keywordCase: "lower" };
    expect(formatSql(sql, lower)).toBe(
      "select a, b\nfrom t\nwhere x = 1",
    );

    const fourSpaces: FormatOptions = { indent: "    " };
    // JOIN indented with 4 spaces — use T2 fixture
    const joinSql = "select t1.id,t2.name from t1 join t2 on t1.id=t2.id";
    const out = formatSql(joinSql, fourSpaces);
    expect(out).toContain("    JOIN t2");
    expect(out).toContain("ON t1.id = t2.id");
  });

  it("T10 — multi-statement input → each statement formatted, separated by blank line", () => {
    const sql = "select 1;select a from t where x=1";
    const out = formatSql(sql);
    // Two formatted statements separated by blank line
    expect(out).toBe("SELECT 1;\n\nSELECT a\nFROM t\nWHERE x = 1");
  });
});
