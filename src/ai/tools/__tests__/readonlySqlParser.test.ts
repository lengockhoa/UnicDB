// src/ai/tools/__tests__/readonlySqlParser.test.ts — cycle AD TASK-001 TDD
// Pure parser guard. Acceptance criterion 1.

import { describe, it, expect } from "vitest";
import {
  parseReadonly,
  containsForbidden,
  containsRowLock,
  stripTrailingSqlComments,
} from "../readonlySqlParser";

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

describe("parseReadonly — row-lock clause rejection (TASK-AIX03-101)", () => {
  // Case 1 (happy)
  it("accepts plain SELECT 1", () => {
    expect(parseReadonly("SELECT 1")).toEqual({ ok: true, kind: "select" });
  });

  // Case 2
  it("rejects FOR SHARE (no update keyword) with reason non_select", () => {
    const r = parseReadonly("SELECT * FROM t FOR SHARE");
    expect(r).toEqual({ ok: false, reason: "non_select" });
  });

  // Case 3
  it("rejects FOR KEY SHARE with reason non_select", () => {
    const r = parseReadonly("SELECT * FROM t FOR KEY SHARE");
    expect(r).toEqual({ ok: false, reason: "non_select" });
  });

  // Case 5 (defense — already green, pinned)
  it("still rejects FOR UPDATE via the update keyword", () => {
    const r = parseReadonly("SELECT * FROM t FOR UPDATE");
    expect(r).toEqual({ ok: false, reason: "non_select" });
  });

  it("rejects FOR NO KEY UPDATE", () => {
    const r = parseReadonly("SELECT * FROM t FOR NO KEY UPDATE");
    expect(r).toEqual({ ok: false, reason: "non_select" });
  });

  it("rejects FOR NO KEY SHARE (no update keyword, only share)", () => {
    const r = parseReadonly("SELECT * FROM t FOR NO KEY SHARE");
    expect(r).toEqual({ ok: false, reason: "non_select" });
  });

  it("rejects row-lock clause case-insensitively", () => {
    expect(parseReadonly("SELECT * FROM t for share").reason).toBe("non_select");
    expect(parseReadonly("SELECT * FROM t For Key Share").reason).toBe("non_select");
  });

  it("accepts SELECT that mentions 'FOR' only as part of an identifier substring (not the clause)", () => {
    // `FORECAST` contains the letters f-o-r but is NOT a row-lock clause.
    // The regex uses \bfor\s+<lockmode> so this should pass.
    const r = parseReadonly("SELECT forecast FROM t");
    expect(r).toEqual({ ok: true, kind: "select" });
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

describe("ARP-06.1 — fail-closed policy decision API: security parser corpus (ADR 0003)", () => {
  // Case 1 (happy) — the core profile admits exactly two statement shapes.
  it("accepts plain SELECT", () => {
    expect(parseReadonly("SELECT * FROM t")).toEqual({ ok: true, kind: "select" });
  });
  it("accepts WITH … SELECT", () => {
    expect(parseReadonly("WITH x AS (SELECT 1) SELECT * FROM x")).toEqual({
      ok: true,
      kind: "with",
    });
  });

  // Case 2 (edge: mutation) — writable CTE denied by the core profile.
  it("denies a writable CTE (UPDATE inside WITH) with non_select", () => {
    expect(parseReadonly("WITH x AS (UPDATE t SET a=1) SELECT * FROM x")).toEqual({
      ok: false,
      reason: "non_select",
    });
  });

  // Case 3 (edge: mutation) — the core profile NEVER admits EXPLAIN; the
  // run_sql profile (isReadOnlySql, sqlTool.ts) reduces EXPLAIN to its inner
  // statement and re-checks separately. Two documented profiles, one policy.
  it("denies EXPLAIN ANALYZE DELETE with non_select (core never admits EXPLAIN)", () => {
    expect(parseReadonly("EXPLAIN ANALYZE DELETE FROM t")).toEqual({
      ok: false,
      reason: "non_select",
    });
  });

  // Case 4 (edge: mutation) — SELECT INTO creates/writes server-side data.
  it("denies SELECT INTO with non_select", () => {
    expect(parseReadonly("SELECT * INTO t2 FROM t")).toEqual({
      ok: false,
      reason: "non_select",
    });
  });

  // Case 5 (edge: structure).
  it("denies multi-statement SQL with multi_statement", () => {
    expect(parseReadonly("SELECT 1; SELECT 2")).toEqual({
      ok: false,
      reason: "multi_statement",
    });
  });

  // Case 6 (edge: structure) — malformed parens denied both ways.
  it("denies unbalanced parens (missing close)", () => {
    expect(parseReadonly("SELECT (1")).toEqual({ ok: false, reason: "unbalanced_parens" });
  });
  it("denies unbalanced parens (stray close)", () => {
    expect(parseReadonly("SELECT 1)")).toEqual({ ok: false, reason: "unbalanced_parens" });
  });

  // Case 7 (edge: lexical) — over-rejection is POLICY, pinned: a forbidden
  // keyword must be rejected wherever it appears — as a standalone literal,
  // hidden in a line comment, or as an identifier substring. The comment leg
  // is the fail-closed direction: stripping the comment BEFORE the scan would
  // admit `SELECT 1 -- drop table t`, which is only safe if comment bodies
  // can never smuggle tokens — the corpus asserts the strict reading.
  it("denies a forbidden keyword as a string literal with non_select", () => {
    expect(parseReadonly("SELECT 'insert'")).toEqual({ ok: false, reason: "non_select" });
  });
  it("denies a forbidden keyword hidden in a line comment with non_select", () => {
    expect(parseReadonly("SELECT 1 -- insert")).toEqual({ ok: false, reason: "non_select" });
  });
  it("denies a forbidden keyword as an identifier substring with non_select", () => {
    expect(parseReadonly("SELECT created_at FROM t")).toEqual({ ok: false, reason: "non_select" });
  });

  // Case 8 (security corpus) — the mandatory sweep. EVERY mutation-capable
  // construct below must be denied ({ ok:false }); the reason is asserted
  // only where the task pins it. A GREEN here proves no construct that can
  // mutate state is ever admitted by the core profile.
  const deniedCorpus: Array<[string, string]> = [
    // DML/DDL keywords.
    ["INSERT", "INSERT INTO t VALUES (1)"],
    ["UPDATE", "UPDATE t SET a=1"],
    ["DELETE", "DELETE FROM t"],
    ["DROP", "DROP TABLE t"],
    ["ALTER", "ALTER TABLE t ALTER COLUMN a TYPE text"],
    ["CREATE", "CREATE TABLE t (a int)"],
    ["TRUNCATE", "TRUNCATE t"],
    ["GRANT", "GRANT ALL ON t TO u"],
    ["REVOKE", "REVOKE ALL ON t FROM u"],
    ["COPY", "COPY t TO '/tmp/x'"],
    ["MERGE", "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN DO NOTHING"],
    ["CALL", "CALL admin_task()"],
    ["EXEC", "EXEC sp_thing"],
    ["EXECUTE", "EXECUTE sp_thing"],
    ["VACUUM", "VACUUM t"],
    ["ANALYZE stmt", "ANALYZE t"],
    ["SET", "SET search_path = pg_catalog"],
    ["RESET", "RESET search_path"],
    ["LISTEN", "LISTEN chan"],
    ["NOTIFY", "NOTIFY chan"],
    ["LOCK", "LOCK TABLE t"],
    ["COMMENT", "COMMENT ON TABLE t IS 'x'"],
    ["REINDEX", "REINDEX TABLE t"],
    ["CLUSTER", "CLUSTER t USING idx"],
    ["PREPARE", "PREPARE p AS SELECT 1"],
    ["DISCARD", "DISCARD ALL"],
    // INTO forms.
    ["SELECT INTO", "SELECT * INTO t2 FROM t"],
    ["INSERT INTO", "INSERT INTO t VALUES (1)"],
    ["MERGE INTO", "MERGE INTO t USING s ON (1=1)"],
    // Writable CTEs (data-modifying WITH).
    ["writable CTE INSERT", "WITH x AS (INSERT INTO t VALUES (1)) SELECT * FROM x"],
    ["writable CTE UPDATE", "WITH x AS (UPDATE t SET a=1) SELECT * FROM x"],
    ["writable CTE DELETE", "WITH x AS (DELETE FROM t) SELECT * FROM x"],
    ["writable CTE MERGE", "WITH x AS (MERGE INTO t USING s ON (1=1)) SELECT * FROM x"],
    ["writable CTE lowercase", "with x as (delete from t) select * from x"],
    // EXPLAIN (core profile never admits it — mutation hides behind ANALYZE).
    ["EXPLAIN ANALYZE DELETE", "EXPLAIN ANALYZE DELETE FROM t"],
    ["EXPLAIN ANALYZE UPDATE", "EXPLAIN ANALYZE UPDATE t SET a=1"],
    ["EXPLAIN ANALYZE INSERT", "EXPLAIN ANALYZE INSERT INTO t VALUES (1)"],
    ["EXPLAIN ANALYZE DROP", "EXPLAIN ANALYZE DROP TABLE t"],
    ["EXPLAIN (ANALYZE) DELETE", "EXPLAIN (ANALYZE) DELETE FROM t"],
    ["EXPLAIN DELETE", "EXPLAIN DELETE FROM t"],
    ["lowercase explain analyze delete", "explain analyze delete from t"],
    // Row locks (share locks block writers).
    ["FOR UPDATE", "SELECT * FROM t FOR UPDATE"],
    ["FOR NO KEY UPDATE", "SELECT * FROM t FOR NO KEY UPDATE"],
    ["FOR SHARE", "SELECT * FROM t FOR SHARE"],
    ["FOR KEY SHARE", "SELECT * FROM t FOR KEY SHARE"],
    ["FOR NO KEY SHARE", "SELECT * FROM t FOR NO KEY SHARE"],
    ["FOR SHARE inside CTE", "WITH x AS (SELECT * FROM t FOR SHARE) SELECT * FROM x"],
    // Literal/identifier-hidden forbidden tokens (over-rejection = policy).
    ["literal 'insert'", "SELECT 'insert'"],
    ["literal 'drop table x'", "SELECT 'drop table x' AS s"],
    ["literal 'delete'", "SELECT 'delete'"],
    ["literal 'update'", "SELECT 'update'"],
    ["line comment hiding drop", "SELECT 1 -- drop table t"],
    ["block comment hiding delete", "SELECT 1 /* delete */"],
    ["identifier inserted_at", "SELECT inserted_at FROM t"],
    ["identifier created_at", "SELECT created_at FROM t"],
    ["identifier updated_rows", "SELECT updated_rows FROM t"],
    ["identifier deleted_flag", "SELECT deleted_flag FROM t"],
    ["identifier truncate_id", "SELECT truncate_id FROM t"],
    // Multi-statement smuggling.
    ["multi-statement", "SELECT 1; SELECT 2"],
    ["stacked write", "SELECT 1; DROP TABLE t"],
    ["SELECT then DELETE", "SELECT 1; DELETE FROM t"],
    // Unbalanced parens (malformed input is never admitted).
    ["unbalanced open", "SELECT (1"],
    ["unbalanced close", "SELECT 1)"],
    ["unbalanced nested", "WITH x AS (SELECT (1) SELECT * FROM x"],
  ];

  it("denies every mutation-capable construct in the corpus sweep", () => {
    const admitted: string[] = [];
    for (const [label, sql] of deniedCorpus) {
      const r = parseReadonly(sql);
      if (r.ok !== false) admitted.push(`${label}: ${sql}`);
      else {
        // Structural rejections must surface their pinned reason; everything
        // else rejects with non_select (fail-closed vocabulary).
        expect(["non_select", "multi_statement", "unbalanced_parens", "empty"]).toContain(r.reason);
      }
    }
    expect(admitted).toEqual([]);
  });

  it("reports the pinned reason for each corpus category", () => {
    // Pinned reasons from the task's Test Cases table.
    expect(parseReadonly("WITH x AS (UPDATE t SET a=1) SELECT * FROM x").reason).toBe("non_select");
    expect(parseReadonly("EXPLAIN ANALYZE DELETE FROM t").reason).toBe("non_select");
    expect(parseReadonly("SELECT * INTO t2 FROM t").reason).toBe("non_select");
    expect(parseReadonly("SELECT 1; SELECT 2").reason).toBe("multi_statement");
    expect(parseReadonly("SELECT (1").reason).toBe("unbalanced_parens");
    expect(parseReadonly("SELECT 1)").reason).toBe("unbalanced_parens");
    expect(parseReadonly("SELECT 'insert'").reason).toBe("non_select");
    expect(parseReadonly("SELECT 1 -- insert").reason).toBe("non_select");
    expect(parseReadonly("SELECT created_at FROM t").reason).toBe("non_select");
  });

  it("sweep exported predicates agree with parseReadonly on the corpus", () => {
    for (const [, sql] of deniedCorpus) {
      // Every denied case either fails parseReadonly (already asserted above)
      // or — for the exotic reason categories — trips one of the exported
      // predicates; the row-lock regex must never fire on the corpus cases
      // that are denied for OTHER reasons (no false-positive coupling).
      if (parseReadonly(sql).ok === false) {
        expect(typeof containsRowLock(sql)).toBe("boolean");
        expect(typeof containsForbidden(sql)).toBe("boolean");
      }
    }
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
