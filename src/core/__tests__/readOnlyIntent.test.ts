// src/core/__tests__/readOnlyIntent.test.ts
// DBX-05 TASK-DBX05-001 — read-only intent guard.
import { describe, it, expect } from "vitest";
import {
  isMutationSql,
  mutationStatements,
  ReadOnlyViolation,
} from "../readOnlyIntent";

describe("readOnlyIntent", () => {
  it("SELECT is not a mutation", () => {
    expect(isMutationSql("SELECT * FROM t")).toBe(false);
  });

  it("CTE SELECT is not a mutation", () => {
    expect(isMutationSql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
  });

  it.each([
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "DELETE FROM t", // no WHERE → red
    "TRUNCATE t",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN c int",
  ])("%s is a mutation", (sql) => {
    expect(isMutationSql(sql)).toBe(true);
  });

  it("admin DCL is a mutation", () => {
    expect(isMutationSql("GRANT SELECT ON t TO bob")).toBe(true);
    expect(isMutationSql("REVOKE SELECT ON t FROM bob")).toBe(true);
  });

  it("DELETE with WHERE is still amber-mutation for read-only", () => {
    expect(isMutationSql("DELETE FROM t WHERE id = 1")).toBe(true);
  });

  it("comments-only is not a mutation", () => {
    expect(isMutationSql("-- nothing here\n/* block */")).toBe(false);
  });

  it("multi-statement batch with one mutation is a mutation", () => {
    expect(isMutationSql("SELECT 1;\nUPDATE t SET a = 1;")).toBe(true);
  });

  it("mutationStatements lists only the mutations", () => {
    const bad = mutationStatements("SELECT 1;\nDROP TABLE x;\nSELECT 2;");
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("DROP TABLE x");
  });

  it("ReadOnlyViolation carries statements", () => {
    const err = new ReadOnlyViolation(["DROP TABLE x"]);
    expect(err.statements).toEqual(["DROP TABLE x"]);
    expect(err.name).toBe("ReadOnlyViolation");
  });

  // DBX-05 review regression: EXPLAIN's option group must not terminate the
  // scan before the real statement — EXPLAIN ANALYZE executes its target.
  it("EXPLAIN (ANALYZE, BUFFERS) DELETE is a mutation", () => {
    expect(isMutationSql("EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t")).toBe(true);
    expect(isMutationSql("EXPLAIN ANALYZE DELETE FROM t")).toBe(true);
    expect(isMutationSql("EXPLAIN ANALYZE SELECT * FROM t")).toBe(false);
    expect(isMutationSql("EXPLAIN (VERBOSE, FORMAT JSON) SELECT 1")).toBe(false);
  });

  it("data-modifying CTE is a mutation even inside parens", () => {
    expect(
      isMutationSql("WITH x AS (INSERT INTO t VALUES (1)) SELECT * FROM x"),
    ).toBe(true);
    expect(isMutationSql("WITH x AS (SELECT 1) DELETE FROM t")).toBe(true);
    expect(isMutationSql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
  });
});
