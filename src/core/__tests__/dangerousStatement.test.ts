// src/core/__tests__/dangerousStatement.test.ts
// TASK-606 A1–A8 — detector thuần (không vscode).
import { describe, it, expect } from "vitest";
import { analyzeStatement, guardTier } from "../dangerousStatement";

describe("TASK-606 — analyzeStatement + guardTier", () => {
  it("A1 — DELETE có WHERE → delete/hasWhere + amber", () => {
    const a = analyzeStatement("DELETE FROM logs WHERE id = 1");
    expect(a).toEqual({ kind: "delete", hasWhere: true });
    expect(guardTier(a)).toBe("amber");
  });

  it("A2 — TRUNCATE mọi form đều red", () => {
    for (const sql of ["TRUNCATE TABLE users", "TRUNCATE users"]) {
      const a = analyzeStatement(sql);
      expect(a).toEqual({ kind: "truncate", hasWhere: false });
      expect(guardTier(a)).toBe("red");
    }
  });

  it("A3 — DROP TABLE red", () => {
    const a = analyzeStatement("DROP TABLE old_t");
    expect(a).toEqual({ kind: "drop", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });

  it("A4 — UPDATE không WHERE red, có WHERE none", () => {
    expect(guardTier(analyzeStatement("UPDATE t SET a = 1"))).toBe("red");
    expect(guardTier(analyzeStatement("UPDATE t SET a = 1 WHERE id = 2"))).toBe(
      "none",
    );
  });

  it("A5 — keyword trong string/comment không tính", () => {
    expect(analyzeStatement("SELECT 'DELETE FROM t' AS x").kind).toBe("other");
    const a = analyzeStatement("DELETE FROM t -- WHERE id = 1");
    expect(a.hasWhere).toBe(false);
    expect(guardTier(a)).toBe("red");
  });

  it("A6 — CTE: WITH ... DELETE nhận kind delete", () => {
    const a = analyzeStatement("WITH c AS (SELECT 1) DELETE FROM tgt");
    expect(a).toEqual({ kind: "delete", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });

  it("A7 — case-insensitive + leading comment", () => {
    expect(analyzeStatement("-- cleanup\ndelete from T")).toEqual({
      kind: "delete",
      hasWhere: false,
    });
  });

  it("A8 — DELETE trong dollar-quoted body không flag", () => {
    const a = analyzeStatement(
      "CREATE FUNCTION f() RETURNS void AS $$ DELETE FROM t $$ LANGUAGE sql",
    );
    expect(a.kind).toBe("other");
    expect(guardTier(a)).toBe("none");
  });
});

describe("TASK-701 — EXPLAIN prelude trong analyzeStatement", () => {
  it("1 — EXPLAIN DELETE no-where → delete/hasWhere=false + red", () => {
    const a = analyzeStatement("EXPLAIN DELETE FROM t");
    expect(a).toEqual({ kind: "delete", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });

  it("2 — EXPLAIN ANALYZE DELETE → red", () => {
    const a = analyzeStatement("EXPLAIN ANALYZE DELETE FROM t");
    expect(a).toEqual({ kind: "delete", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });

  it("3 — EXPLAIN (ANALYZE, COSTS) parenthesized options → red", () => {
    const a = analyzeStatement(
      "EXPLAIN (ANALYZE, COSTS) UPDATE t SET a=1",
    );
    expect(a).toEqual({ kind: "update", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });

  it("4 — EXPLAIN ANALYZE WITH c AS (SELECT 1) DELETE có WHERE → amber", () => {
    const a = analyzeStatement(
      "EXPLAIN ANALYZE WITH c AS (SELECT 1) DELETE FROM t WHERE x=1",
    );
    expect(a).toEqual({ kind: "delete", hasWhere: true });
    expect(guardTier(a)).toBe("amber");
  });

  it("5 — EXPLAIN ANALYZE SELECT harmless → none", () => {
    const a = analyzeStatement("EXPLAIN ANALYZE SELECT * FROM t");
    expect(a).toEqual({ kind: "other", hasWhere: false });
    expect(guardTier(a)).toBe("none");
  });

  it("6 — EXPLAIN ANALYZE UPDATE có WHERE → none", () => {
    const a = analyzeStatement(
      "EXPLAIN ANALYZE UPDATE t SET a=1 WHERE id=2",
    );
    expect(a).toEqual({ kind: "update", hasWhere: true });
    expect(guardTier(a)).toBe("none");
  });

  it("7 — regression: DELETE FROM t không EXPLAIN vẫn red", () => {
    const a = analyzeStatement("DELETE FROM t");
    expect(a).toEqual({ kind: "delete", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });
});
