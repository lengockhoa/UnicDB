// src/core/__tests__/schemaEnforce.test.ts
// withSchemaSearchPath — prepend `SET search_path` so SQL runs in the
// user's pinned schema (DataGrip parity).
//
// Pure helper — no vscode import needed.
import { describe, it, expect } from "vitest";
import { withSchemaSearchPath } from "../schemaEnforce";

describe("withSchemaSearchPath", () => {
  it("happy path: prepends SET before SELECT", () => {
    const out = withSchemaSearchPath("SELECT * FROM users;", "analytics");
    expect(out).toBe(
      'SET search_path TO "analytics", public;\nSELECT * FROM users;',
    );
  });

  it("DDL — CREATE FUNCTION lands in pinned schema", () => {
    const sql = `CREATE FUNCTION foo() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;`;
    const out = withSchemaSearchPath(sql, "reporting");
    expect(out.startsWith('SET search_path TO "reporting", public;\n')).toBe(
      true,
    );
    expect(out.endsWith(sql)).toBe(true);
  });

  it("no double-prepend when SQL already leads with SET search_path", () => {
    const sql = 'SET search_path TO "other"; SELECT 1;';
    const out = withSchemaSearchPath(sql, "analytics");
    expect(out).toBe(sql);
  });

  it("empty SQL returns empty unchanged", () => {
    expect(withSchemaSearchPath("", "analytics")).toBe("");
  });

  it("null / undefined / empty schema returns input unchanged", () => {
    const sql = "SELECT 1;";
    expect(withSchemaSearchPath(sql, undefined)).toBe(sql);
    expect(withSchemaSearchPath(sql, null)).toBe(sql);
    expect(withSchemaSearchPath(sql, "")).toBe(sql);
    expect(withSchemaSearchPath(sql, "   ")).toBe(sql);
  });

  it("SET inside a string literal is NOT treated as a leading SET", () => {
    // The leading token is actually SELECT — a "SET search_path" appears
    // only inside a string literal. We must still prepend our SET.
    const sql = "SELECT 'SET search_path TO evil' AS x;";
    const out = withSchemaSearchPath(sql, "analytics");
    expect(out.startsWith('SET search_path TO "analytics", public;\n')).toBe(
      true,
    );
  });

  it("SET inside a line comment is NOT treated as a leading SET", () => {
    const sql = "-- SET search_path TO comment_only\nSELECT 1;";
    const out = withSchemaSearchPath(sql, "analytics");
    expect(out.startsWith('SET search_path TO "analytics", public;\n')).toBe(
      true,
    );
  });

  it("schema name containing double-quote is escaped via doubling", () => {
    // PG would reject this identifier at create time, but the helper stays
    // safe: any embedded `"` is doubled per the quoted-identifier rule.
    const out = withSchemaSearchPath("SELECT 1;", 'weird"name');
    expect(out).toBe(
      'SET search_path TO "weird""name", public;\nSELECT 1;',
    );
  });

  it("schema name with leading whitespace is trimmed", () => {
    const out = withSchemaSearchPath("SELECT 1;", "  analytics  ");
    expect(out.startsWith('SET search_path TO "analytics", public;\n')).toBe(
      true,
    );
  });

  it("preserves trailing newline on input", () => {
    const out = withSchemaSearchPath("SELECT 1;\n", "analytics");
    expect(out).toBe(
      'SET search_path TO "analytics", public;\nSELECT 1;\n',
    );
  });
});