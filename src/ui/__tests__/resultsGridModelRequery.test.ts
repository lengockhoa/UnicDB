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
//   - Multi-statement    → use the LAST statement segment of the input.
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
  it("trims surrounding whitespace from the inner statement when wrapping", () => {
    const sql = "  select  a,  b\n  from  t  where  x=1  ";
    const out = composeRequery(sql, "b > 0", "a");
    expect(out).toBe(
      "SELECT * FROM (select  a,  b\n  from  t  where  x=1) vsdb_sub WHERE b > 0 ORDER BY a",
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
    expect(out).not.toContain("WHERE");
  });
  it("whitespace-only where / orderBy are treated as empty → returns stripped statement", () => {
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
  it("Test #3 — both empty returns the stripped statement (no WHERE / no ORDER BY)", () => {
    const out = composeRequery("SELECT 1;", "", "");
    expect(out).toBe("SELECT 1");
  });

  it("Test #3b — strips trailing `;` and whitespace from the original statement", () => {
    expect(composeRequery("SELECT 1;\n", "", "")).toBe("SELECT 1");
    expect(composeRequery("SELECT 1 ;  ", "", "")).toBe("SELECT 1");
    expect(composeRequery("SELECT 1\n", "", "")).toBe("SELECT 1");
  });

  it("Test #3c — inner trailing `;` is stripped by the multi-statement split", () => {
    // Even when wrapping, the inner statement is taken via the
    // multi-statement split — the trailing `;` is filtered out as part of
    // the "last non-empty segment" pick.
    const sql = "SELECT 1;";
    const out = composeRequery(sql, "1=1", "1");
    expect(out).toBe(
      "SELECT * FROM (SELECT 1) vsdb_sub WHERE 1=1 ORDER BY 1",
    );
  });
});
// =============================================================================
// 4. composeRequery — multi-statement input (Test #4)
// =============================================================================
describe("composeRequery — multi-statement input", () => {
  it("Test #4 — splits on `;` and uses the LAST non-empty statement segment", () => {
    const sql = "SELECT 1; SELECT a FROM t; SELECT b FROM u";
    const out = composeRequery(sql, "a>1", "a");
    expect(out).toBe(
      "SELECT * FROM (SELECT b FROM u) vsdb_sub WHERE a>1 ORDER BY a",
    );
  });

  it("Test #4b — trailing `;` after the last statement is harmless", () => {
    const sql = "SELECT 1; SELECT a FROM t;";
    const out = composeRequery(sql, "", "a");
    expect(out).toBe(
      "SELECT * FROM (SELECT a FROM t) vsdb_sub ORDER BY a",
    );
  });

  it("Test #4c — when input has empty leading segments, uses the last non-empty one", () => {
    const sql = "; ; SELECT a FROM t;";
    const out = composeRequery(sql, "a>1", "");
    expect(out).toBe(
      "SELECT * FROM (SELECT a FROM t) vsdb_sub WHERE a>1",
    );
  });
});

// =============================================================================
// 5. composeRequery — id / parity with existing test expectations
// =============================================================================
describe("composeRequery — does not double-wrap when already a SELECT", () => {
  it("does not mangle the inner SQL — passes the inner statement through verbatim", () => {
    const inner = "WITH cte AS (SELECT 1) SELECT * FROM cte";
    const out = composeRequery(inner, "1=1", "");
    expect(out).toBe(
      `SELECT * FROM (${inner}) vsdb_sub WHERE 1=1`,
    );
  });
});