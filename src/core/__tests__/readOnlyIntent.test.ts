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

  // ---- ARP-01.1 TASK-ARP01-001 — dialect + transaction-control matrix ----

  // Case 3 (RED-first driver): a MySQL backtick-quoted identifier that merely
  // SPELLS a mutation keyword is an identifier, not a statement starter. It
  // must be masked before the depth-scan, exactly like the `"`-quoted
  // identifier branch already does for postgres.
  it("MySQL backtick-quoted keyword identifier is not a mutation", () => {
    expect(isMutationSql("SELECT `insert` FROM t", "mysql")).toBe(false);
    expect(isMutationSql("SELECT `update` FROM t", "mysql")).toBe(false);
    expect(isMutationSql("SELECT `delete` FROM t", "mysql")).toBe(false);
  });

  // Case 4 (decision pin): transaction control changes session state, never
  // data/schema/permissions — so it is NOT a mutation on a read-only
  // connection. Pinned here so a future keyword-table edit cannot silently
  // flip it.
  it("Transaction-control statements are not mutations", () => {
    expect(isMutationSql("COMMIT")).toBe(false);
    expect(isMutationSql("ROLLBACK")).toBe(false);
    expect(isMutationSql("BEGIN")).toBe(false);
    expect(isMutationSql("START TRANSACTION")).toBe(false);
    expect(isMutationSql("SAVEPOINT x")).toBe(false);
  });

  // Case 5 (dialect threading): keyword classification itself is
  // dialect-agnostic — core DML must stay blocked on every supported dialect.
  it("Core DML classifies identically across postgres/mysql/mssql", () => {
    const dmls = [
      "DELETE FROM t",
      "UPDATE t SET a = 1",
      "INSERT INTO t VALUES (1)",
    ];
    const dialects = ["postgres", "mysql", "mssql"] as const;
    for (const sql of dmls) {
      for (const d of dialects) {
        expect(isMutationSql(sql, d), `${sql} @ ${d}`).toBe(true);
      }
    }
  });

  // Case 6 (batch composition): transaction control mixed into a batch stays
  // clean; a real DML elsewhere in the same batch is still listed — and only
  // it, not the surrounding safe statements.
  it("Batch with transaction-control + safe SELECT stays clean; one real DML still listed", () => {
    expect(mutationStatements("COMMIT; SELECT 1")).toEqual([]);
    expect(mutationStatements("SELECT 1; COMMIT; DELETE FROM t")).toEqual([
      "DELETE FROM t",
    ]);
  });
});
