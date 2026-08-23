// src/ui/__tests__/resultsGridModelRequery.test.ts
// TASK-504 — Pure-logic tests for composeRequery (WHERE/ORDER BY bar helper).
//
// `composeRequery(sql, where, orderBy)` wraps the ORIGINAL statement SQL in
//   SELECT * FROM (<stmt>) vsdb_sub WHERE <where> ORDER BY <orderBy>
// so the user can re-run the statement with a quick filter and ordering.
//
//   - Both empty         → return the original statement (with trailing `;`
//                          + whitespace stripped).
//   - Only where         → return the WHERE clause only.
//   - Only orderBy       → return the ORDER BY clause only.
//
// IMPORTANT (Fix Round 2): composeRequery uses `sql` VERBATIM and only strips
// a TRAILING `;` (+ whitespace). It does NOT split on `;` — `r.sql` already
// contains a single statement (statementParser is literal-aware upstream),
// and naive split(";") corrupts SQL containing `;` inside string literals
// (e.g. `SELECT 'a;b' AS x FROM t` → split eats the inner literal).
//
// No DOM, no vscode — plain vitest node environment.
import { describe, it, expect } from "vitest";
import { composeRequery } from "../resultsGridModel";

// =============================================================================
// 1. composeRequery — happy path (Test #1)
// =============================================================================
describe("composeRequery — happy path", () => {
  it("Test #1 — where + orderBy wraps as SELECT * FROM (<stmt>) vsdb_sub WHERE … ORDER BY …", () => {
    const sql = "SELECT a FROM t";
    const out = composeRequery(sql, "a>1", "a DESC");
    expect(out).toBe(
      "SELECT * FROM (SELECT a FROM t) vsdb_sub WHERE a>1 ORDER BY a DESC",
    );
  });

  it("preserves the inner statement verbatim (no double-wrap, no splitting)", () => {
    const inner = "WITH cte AS (SELECT 1) SELECT * FROM cte";
    const out = composeRequery(inner, "1=1", "");
    expect(out).toBe(
      `SELECT * FROM (${inner}) vsdb_sub WHERE 1=1`,
    );
  });

  it("trims surrounding whitespace around where / orderBy fragments", () => {
    const sql = "SELECT a FROM t";
    const out = composeRequery(sql, "  a > 1  ", "  a DESC  ");
    expect(out).toBe(
      "SELECT * FROM (SELECT a FROM t) vsdb_sub WHERE a > 1 ORDER BY a DESC",
    );
  });
});

// =============================================================================
// 2. composeRequery — only where / only orderBy (Test #2)
// =============================================================================
describe("composeRequery — single fragment", () => {
  it("Test #2a — where only: emits WHERE but no ORDER BY clause", () => {
    const sql = "SELECT a FROM t";
    const out = composeRequery(sql, "a>1", "");
    expect(out).toBe("SELECT * FROM (SELECT a FROM t) vsdb_sub WHERE a>1");
    expect(out).not.toContain("ORDER BY");
  });

  it("Test #2b — orderBy only: emits ORDER BY but no WHERE clause", () => {
    const sql = "SELECT a FROM t";
    const out = composeRequery(sql, "", "a DESC");
    expect(out).toBe(
      "SELECT * FROM (SELECT a FROM t) vsdb_sub ORDER BY a DESC",
    );
    expect(out).not.toContain(" WHERE ");
  });

  it("whitespace-only where / orderBy are treated as empty", () => {
    expect(composeRequery("SELECT 1", "   ", "")).toBe("SELECT 1");
    expect(composeRequery("SELECT 1", "", "   \t  ")).toBe("SELECT 1");
    // Mixed — whitespace-only where + non-empty orderBy → only ORDER BY clause.
    expect(composeRequery("SELECT 1", "   ", "a")).toBe(
      "SELECT * FROM (SELECT 1) vsdb_sub ORDER BY a",
    );
  });
});

// =============================================================================
// 3. composeRequery — both empty (Test #3)
// =============================================================================
describe("composeRequery — both empty", () => {
  it("Test #3 — both empty returns the statement with trailing `;` stripped (no WHERE / no ORDER BY)", () => {
    const out = composeRequery("SELECT 1;", "", "");
    expect(out).toBe("SELECT 1");
  });

  it("Test #3b — strips trailing `;` and whitespace from the original statement", () => {
    expect(composeRequery("SELECT 1;\n", "", "")).toBe("SELECT 1");
    expect(composeRequery("SELECT 1 ;  ", "", "")).toBe("SELECT 1");
    expect(composeRequery("SELECT 1\n", "", "")).toBe("SELECT 1");
    expect(composeRequery("SELECT 1  ;  \n  ", "", "")).toBe("SELECT 1");
  });

  it("Test #3c — preserves interior `;` (not stripped) when both fragments empty", () => {
    // Trailing `;` is stripped, but interior `;` inside a comment or
    // unrelated context is preserved. composeRequery treats the input as
    // one statement; trailing whitespace+`;` only.
    expect(composeRequery("SELECT 1 /* ; */", "", "")).toBe("SELECT 1 /* ; */");
  });
});

// =============================================================================
// 4. composeRequery — LITERAL-PRESERVING wrap (Fix Round 2)
// =============================================================================
//
// The previous implementation did `sql.split(";")` to handle multi-statement
// input. That corrupted statements containing `;` inside string literals —
// `SELECT 'a;b' AS x FROM t` got chopped MID-LITERAL. Host already passes a
// single statement (statementParser.splitStatements is literal-aware), so
// multi-statement handling is dead code. composeRequery now uses sql
// VERBATIM and only strips a trailing `;`.
describe("composeRequery — literal-preserving (Fix Round 2 important #1)", () => {
  it("does NOT chop the statement at `;` inside a string literal", () => {
    const sql = "SELECT 'a;b' AS x FROM t";
    const out = composeRequery(sql, "x IS NOT NULL", "");
    expect(out).toBe(
      "SELECT * FROM (SELECT 'a;b' AS x FROM t) vsdb_sub WHERE x IS NOT NULL",
    );
    // Sanity: the inner literal `'a;b'` must round-trip intact.
    expect(out).toContain("'a;b'");
  });

  it("does NOT chop at `;` inside a string literal with both fragments", () => {
    const sql = "SELECT 'x;y;z' AS a, id FROM t";
    const out = composeRequery(sql, "id > 0", "a DESC");
    expect(out).toBe(
      "SELECT * FROM (SELECT 'x;y;z' AS a, id FROM t) vsdb_sub WHERE id > 0 ORDER BY a DESC",
    );
  });

  it("does NOT chop at `;` inside a dollar-quoted string (postgres $$...$$)", () => {
    const sql = "SELECT $$hello;world$$ AS greeting, id FROM t";
    const out = composeRequery(sql, "id = 1", "");
    expect(out).toBe(
      "SELECT * FROM (SELECT $$hello;world$$ AS greeting, id FROM t) vsdb_sub WHERE id = 1",
    );
  });

  it("trailing `;` still gets stripped when present alongside interior literal `;`", () => {
    const sql = "SELECT 'a;b' AS x FROM t;";
    const out = composeRequery(sql, "", "");
    expect(out).toBe("SELECT 'a;b' AS x FROM t");
  });

  it("trailing `;` is stripped from the WRAPPED inner statement too (v1.4.1 defense-in-depth)", () => {
    const sql = "SELECT 'a;b' AS x FROM t;";
    const out = composeRequery(sql, "x IS NOT NULL", "");
    // The trailing `;` must not nest inside the subquery — interior
    // literal `;` survives, only the terminator goes.
    expect(out).toBe(
      "SELECT * FROM (SELECT 'a;b' AS x FROM t) vsdb_sub WHERE x IS NOT NULL",
    );
  });
});