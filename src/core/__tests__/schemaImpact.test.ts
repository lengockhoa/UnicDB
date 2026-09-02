// src/core/__tests__/schemaImpact.test.ts
// TASK-ARP07-001 — pure schema-impact classifier corpus (TDD).
// Pure core, no vscode mock — same style as dangerousStatement.test.ts /
// readOnlyIntent.test.ts. Corpus is pinned 1:1 to the task's §Test Cases.
import { describe, it, expect } from "vitest";
import { hasSchemaImpact, completedSchemaImpact } from "../schemaImpact";

describe("TASK-ARP07-001 — hasSchemaImpact", () => {
  it("T1 — CREATE TABLE depth-0 → true", () => {
    expect(hasSchemaImpact("CREATE TABLE users (id int)", "postgres")).toBe(
      true,
    );
  });

  it("T2 — DROP / ALTER / RENAME depth-0 → true each", () => {
    expect(hasSchemaImpact("DROP TABLE users", "postgres")).toBe(true);
    expect(
      hasSchemaImpact("ALTER TABLE users ADD COLUMN email text", "postgres"),
    ).toBe(true);
    expect(hasSchemaImpact("RENAME TABLE a TO b", "mysql")).toBe(true);
  });

  it("T3 — SELECT and DML are NOT schema-impact → false each", () => {
    for (const sql of [
      "SELECT * FROM users",
      "INSERT INTO users VALUES (1)",
      "UPDATE users SET x=1",
      "DELETE FROM users",
      "MERGE INTO u USING v",
      "TRUNCATE TABLE users",
    ]) {
      expect(hasSchemaImpact(sql, "postgres"), sql).toBe(false);
    }
  });

  it("T4 — keyword inside a string literal never triggers → false", () => {
    expect(
      hasSchemaImpact("INSERT INTO t VALUES ('DROP TABLE users')", "postgres"),
    ).toBe(false);
    expect(hasSchemaImpact("SELECT 'CREATE' FROM t", "postgres")).toBe(false);
  });

  it("T5 — keyword inside a comment never triggers → false", () => {
    expect(hasSchemaImpact("/* DROP TABLE users */ SELECT 1", "postgres")).toBe(
      false,
    );
    expect(hasSchemaImpact("-- DROP TABLE users\nSELECT 1", "postgres")).toBe(
      false,
    );
  });

  it("T6 — CTE prelude and parens are not depth-0 → false", () => {
    expect(hasSchemaImpact("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
    expect(hasSchemaImpact("SELECT count(*) FROM users")).toBe(false);
  });

  it("T7 — mysql masking: backtick identifier + backslash-escaped literal body → false", () => {
    expect(hasSchemaImpact("SELECT `create` FROM t", "mysql")).toBe(false);
    expect(
      hasSchemaImpact("INSERT INTO t VALUES ('DROP\\'TABLE x')", "mysql"),
    ).toBe(false);
  });

  it("T8 — data-only / maintenance statements → false", () => {
    for (const sql of [
      "TRUNCATE TABLE users",
      "VACUUM ANALYZE users",
      "ANALYZE users",
    ]) {
      expect(hasSchemaImpact(sql, "postgres"), sql).toBe(false);
    }
  });
});

describe("TASK-ARP07-001 — completedSchemaImpact (batch, any-completed)", () => {
  it("T9 — any completed statement with impact → true", () => {
    expect(
      completedSchemaImpact(
        ["SELECT 1", "CREATE TABLE t (id int)"],
        "postgres",
      ),
    ).toBe(true);
  });

  it("T10 — empty batch / no schema-impacting statement → false", () => {
    expect(completedSchemaImpact([])).toBe(false);
    expect(
      completedSchemaImpact(["SELECT 1", "INSERT INTO t VALUES (1)"]),
    ).toBe(false);
    expect(completedSchemaImpact(["SELECT 1", "TRUNCATE TABLE users"])).toBe(
      false,
    );
  });

  it("T11 — batch containing a completed MySQL RENAME → true", () => {
    expect(
      completedSchemaImpact(["SELECT 1", "RENAME TABLE a TO b"], "mysql"),
    ).toBe(true);
  });
});

// TASK-CL-001 — schemaImpact classifier inherits the new mssql bracket
// masking. Direction 1: real DDL with bracket-quoted table name still
// triggers (CREATE TABLE [foo] …). Direction 2: a SELECT with a
// bracket-quoted identifier that merely SPELLS `create` does NOT trigger,
// because the masker blanks the bracket region before the depth-scan.
describe("TASK-CL-001 — schemaImpact inherits mssql bracket masking", () => {
  it("#8a — real DDL with bracket-quoted name is still schema-impact", () => {
    expect(hasSchemaImpact("CREATE TABLE [foo] (x int)", "mssql")).toBe(true);
  });

  it("#8b — SELECT * FROM [create] (mssql) is NOT schema-impact", () => {
    expect(hasSchemaImpact("SELECT * FROM [create]", "mssql")).toBe(false);
  });
});
