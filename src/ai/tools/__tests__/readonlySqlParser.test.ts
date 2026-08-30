// src/ai/tools/__tests__/readonlySqlParser.test.ts — cycle AD TASK-001 TDD
// Pure parser guard. Acceptance criterion 1.

import { describe, it, expect } from "vitest";
import { parseReadonly, containsForbidden, stripTrailingSqlComments } from "../readonlySqlParser";

describe("parseReadonly — accepts read-only statements", () => {
  it("accepts uppercase SELECT", () => {
    expect(parseReadonly("SELECT a FROM t")).toEqual({ ok: true, kind: "select" });
  });

  it("accepts lowercase select", () => {
    expect(parseReadonly("select a from t")).toEqual({ ok: true, kind: "select" });
  });

  it("accepts mixed case SeLeCt", () => {
    expect(parseReadonly("SeLeCt a FrOm t")).toEqual({ ok: true, kind: "select" });
  });

  it("accepts WITH … SELECT", () => {
    expect(parseReadonly("WITH x AS (SELECT 1 AS n) SELECT n FROM x")).toEqual({
      ok: true,
      kind: "with",
    });
  });

  it("accepts a trailing semicolon", () => {
    expect(parseReadonly("SELECT 1;")).toEqual({ ok: true, kind: "select" });
  });

  it("accepts a trailing semicolon with trailing whitespace", () => {
    expect(parseReadonly("SELECT 1 ;  \n ")).toEqual({ ok: true, kind: "select" });
  });

  it("skips leading line comments", () => {
    expect(parseReadonly("-- a note\nSELECT 1")).toEqual({ ok: true, kind: "select" });
  });

  it("skips leading block comments", () => {
    expect(parseReadonly("/* note */ SELECT 1")).toEqual({ ok: true, kind: "select" });
  });
});

describe("parseReadonly — rejects write statements", () => {
  const cases: Array<[string, string]> = [
    ["INSERT", "INSERT INTO t VALUES (1)"],
    ["UPDATE", "UPDATE t SET a = 1"],
    ["DELETE", "DELETE FROM t"],
    ["DROP", "DROP TABLE t"],
    ["ALTER", "ALTER TABLE t ADD COLUMN a int"],
    ["CREATE", "CREATE TABLE t (a int)"],
    ["TRUNCATE", "TRUNCATE t"],
    ["GRANT", "GRANT SELECT ON t TO u"],
    ["REVOKE", "REVOKE SELECT ON t FROM u"],
    ["COPY", "COPY t FROM '/tmp/x'"],
    ["MERGE", "MERGE INTO t USING s ON (1=1)"],
    ["CALL", "CALL do_thing()"],
    ["EXEC", "EXEC sp_thing"],
  ];
  for (const [label, sql] of cases) {
    it(`rejects ${label}`, () => {
      const r = parseReadonly(sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("non_select");
    });
  }

  it("rejects lowercase write statements too", () => {
    const r = parseReadonly("delete from t");
    expect(r.ok).toBe(false);
  });
});

describe("parseReadonly — structural rejections", () => {
  it("rejects multi-statement SQL", () => {
    const r = parseReadonly("SELECT 1; SELECT 2");
    expect(r).toEqual({ ok: false, reason: "multi_statement" });
  });

  it("rejects a stacked write after a SELECT", () => {
    const r = parseReadonly("SELECT 1; DROP TABLE t");
    expect(r).toEqual({ ok: false, reason: "multi_statement" });
  });

  it("rejects empty input", () => {
    expect(parseReadonly("")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects whitespace-only input", () => {
    expect(parseReadonly("   \n\t ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects comment-only input", () => {
    expect(parseReadonly("-- nothing here\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects unbalanced open paren", () => {
    expect(parseReadonly("SELECT (1 FROM t")).toEqual({
      ok: false,
      reason: "unbalanced_parens",
    });
  });

  it("rejects unbalanced close paren", () => {
    expect(parseReadonly("SELECT 1) FROM t")).toEqual({
      ok: false,
      reason: "unbalanced_parens",
    });
  });
});

describe("parseReadonly — defense in depth", () => {
  it("rejects identifiers that merely CONTAIN a forbidden keyword", () => {
    const r = parseReadonly("SELECT inserted_at FROM t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non_select");
  });
  it("rejects SELECT INTO, which can create or write server-side data", () => {
    expect(parseReadonly("SELECT * INTO t2 FROM t1").ok).toBe(false);
  });

  it("rejects a forbidden keyword hidden inside a string literal", () => {
    const r = parseReadonly("SELECT 'drop table x' AS s");
    expect(r.ok).toBe(false);
  });

  it("rejects created_at (contains CREATE)", () => {
    expect(parseReadonly("SELECT created_at FROM t").ok).toBe(false);
  });

  it("containsForbidden is exported and case-insensitive", () => {
    expect(containsForbidden("a = 1")).toBe(false);
    expect(containsForbidden("a = 1 OR TrUnCaTe")).toBe(true);
  });
});

describe("stripTrailingSqlComments — lexical safety", () => {
  it("preserves `--` inside PostgreSQL double-quoted identifiers", () => {
    // The identifier is `drop--comment` — `--` inside a quoted identifier
    // must NOT be treated as a line comment. PostgreSQL allows quoted
    // identifiers to contain any character.
    const r = stripTrailingSqlComments('SELECT "weird--col" FROM t');
    expect(r).toContain('"weird--col"');
  });

  it("preserves `--` inside dollar-quoted strings ($tag$…$tag$)", () => {
    // Dollar-quoted string body contains `--` — must be preserved verbatim.
    const r = stripTrailingSqlComments("SELECT $tag$contains -- inside$tag$ FROM t");
    expect(r).toContain("$tag$contains -- inside$tag$");
  });

  it("preserves single-quoted string contents (regression — was already safe)", () => {
    const r = stripTrailingSqlComments("SELECT 'a -- not a comment' FROM t");
    expect(r).toContain("'a -- not a comment'");
  });

  it("strips trailing `-- line` comment after a real statement", () => {
    const r = stripTrailingSqlComments("SELECT 1 -- trailing note\n");
    // The trailing comment body should be replaced with a space so tokens
    // never fuse; the trailing newline is preserved.
    expect(r.startsWith("SELECT 1 ")).toBe(true);
    expect(r).not.toContain("trailing note");
  });
});
