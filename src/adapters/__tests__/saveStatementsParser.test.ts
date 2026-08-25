// src/adapters/__tests__/saveStatementsParser.test.ts
//
// TASK-503 Fix Round 1 — host-side helpers:
//   - parseFromClause(sql) → { schema?, table } | null
//   - quoteIdent(name, dialect) — exposed for testing the table/column
//     quoting across dialects (covers important #3: validate identifier
//     shape before building SQL).
//
// These are RED until exported from saveStatements.ts.
import { describe, it, expect } from "vitest";
import {
  parseFromClause,
  quoteIdent,
} from "../../core/saveStatements";

describe("parseFromClause — host-derive table name from SELECT", () => {
  it("simple SELECT FROM t → { table: 't' }", () => {
    expect(parseFromClause("SELECT * FROM t")).toEqual({ table: "t" });
  });

  it("qualified schema.table", () => {
    expect(parseFromClause("SELECT * FROM public.users")).toEqual({
      schema: "public",
      table: "users",
    });
  });

  it("bracketed identifier (SQL Server) is stripped", () => {
    expect(parseFromClause("SELECT * FROM [dbo].[users]")).toEqual({
      schema: "dbo",
      table: "users",
    });
  });

  it("backtick identifier (MySQL) is stripped", () => {
    expect(parseFromClause("SELECT * FROM `mydb`.`users`")).toEqual({
      schema: "mydb",
      table: "users",
    });
  });

  it("FROM with alias is preserved", () => {
    expect(parseFromClause("SELECT u.id FROM public.users u")).toEqual({
      schema: "public",
      table: "users",
    });
  });

  it("INSERT INTO t → returns { table: 't' }", () => {
    expect(parseFromClause("INSERT INTO t VALUES (1)")).toEqual({ table: "t" });
  });

  it("UPDATE t SET ... → { table: 't' }", () => {
    expect(parseFromClause("UPDATE t SET x=1 WHERE id=1")).toEqual({
      table: "t",
    });
  });

  it("FROM inside string literal is NOT picked up", () => {
    // The keyword FROM inside a quoted string is data, not clause.
    expect(parseFromClause("SELECT 'FROM fake_table' AS x")).toBeNull();
  });

  it("FROM inside line comment is NOT picked up", () => {
    expect(parseFromClause("SELECT 1 -- FROM fake_table")).toBeNull();
  });

  it("no FROM / INSERT INTO / UPDATE → null", () => {
    expect(parseFromClause("SELECT 1")).toBeNull();
  });
});

describe("quoteIdent — identifier quoting per dialect (important #3)", () => {
  it("postgres: double-quoted with double-quote escape (TASK-001 A9)", () => {
    expect(quoteIdent("users", "postgres")).toBe('"users"');
    expect(quoteIdent('we"ird', "postgres")).toBe('"we""ird"');
  });

  it("mysql: backtick-quoted with backtick escape", () => {
    expect(quoteIdent("users", "mysql")).toBe("`users`");
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
  });

  it("mssql: square-bracket quoted with bracket escape", () => {
    expect(quoteIdent("users", "mssql")).toBe("[users]");
    expect(quoteIdent("we]ird", "mssql")).toBe("[we]]ird]");
  });
});

// ---- TASK-001 A20: parseFromClause must be a single forward pass ----------

describe("parseFromClause — perf (A20, single-pass, no O(n²) inSkippedRegion re-scan)", () => {
  it("200 KB SQL completes in well under 50ms (today's per-character re-scan is quadratic)", () => {
    // A large SQL string dominated by a long string literal (worst case for
    // the old per-character `inSkippedRegion` re-scan, which walked from 0
    // to i on every character).
    const filler = "x".repeat(200 * 1024);
    const sql = `SELECT * FROM t WHERE note = '${filler}'`;
    const t0 = performance.now();
    const result = parseFromClause(sql);
    const elapsed = performance.now() - t0;
    expect(result).toEqual({ table: "t" });
    expect(elapsed).toBeLessThan(50);
  });
});
