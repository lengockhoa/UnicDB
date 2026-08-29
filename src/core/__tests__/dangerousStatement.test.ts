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

  // Review fix round C, Finding #5 — must mask MySQL `\'` backslash-escape
  // the SAME way statementParser.ts's splitStatements(sql, "mysql") does.
  // Without dialect-aware masking, a backslash-escaped quote inside a MySQL
  // string literal is misread as the string's real closing quote, which
  // leaks the REST of that literal (here containing the word "WHERE") out
  // as if it were live SQL — turning a DELETE with NO real WHERE (should be
  // RED) into a false "has WHERE" amber, silently downgrading the warning.
  it("regression (finding 5): MySQL backslash-escaped quote inside a DELETE's string must not leak a fake WHERE", () => {
    const sql = "DELETE FROM t SET note = 'a\\' WHERE 1=1'";
    const a = analyzeStatement(sql, "mysql");
    expect(a).toEqual({ kind: "delete", hasWhere: false });
    expect(guardTier(a)).toBe("red");
  });

  it("regression (finding 5) guard: non-mysql dialect keeps the old ''-escape-only masking behavior", () => {
    // Same text, but postgres/mssql don't recognize backslash escapes — `'`
    // right after `\` really does close the string, exactly like today.
    const sql = "DELETE FROM t SET note = 'a\\' WHERE 1=1'";
    const a = analyzeStatement(sql, "postgres");
    expect(a).toEqual({ kind: "delete", hasWhere: true });
    expect(guardTier(a)).toBe("amber");
  });

  it("regression (finding 5) guard: omitting dialect stays byte-identical to today (no dialect arg)", () => {
    const sql = "DELETE FROM t SET note = 'a\\' WHERE 1=1'";
    const a = analyzeStatement(sql);
    expect(a).toEqual({ kind: "delete", hasWhere: true });
    expect(guardTier(a)).toBe("amber");
  });
});

describe("TASK-AHL-004 — admin DCL detection (GRANT/REVOKE)", () => {
  it("B1 — GRANT SELECT ON TABLE x TO y → kind=grant, tier=admin-red", () => {
    const a = analyzeStatement("GRANT SELECT ON TABLE x TO y");
    expect(a.kind).toBe("grant");
    expect(guardTier(a)).toBe("admin-red");
  });

  it("B2 — REVOKE INSERT ON TABLE x FROM y → kind=revoke, tier=admin-red", () => {
    const a = analyzeStatement("REVOKE INSERT ON TABLE x FROM y");
    expect(a.kind).toBe("revoke");
    expect(guardTier(a)).toBe("admin-red");
  });

  it("B3 — GRANT SELECT ON ALL TABLES IN SCHEMA public TO app → admin-red", () => {
    const a = analyzeStatement(
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO app",
    );
    expect(a.kind).toBe("grant");
    expect(guardTier(a)).toBe("admin-red");
  });

  it("B4 — REVOKE SELECT ON SEQUENCE seq FROM app → admin-red", () => {
    const a = analyzeStatement("REVOKE SELECT ON SEQUENCE seq FROM app");
    expect(a.kind).toBe("revoke");
    expect(guardTier(a)).toBe("admin-red");
  });

  it("B5 — case-insensitive grant/revoke", () => {
    expect(analyzeStatement("grant select on table t to bob").kind).toBe(
      "grant",
    );
    expect(analyzeStatement("Revoke Insert on t from bob").kind).toBe("revoke");
  });

  it("B6 — keyword trong string/comment KHÔNG flag (regression B-safety)", () => {
    expect(
      analyzeStatement("SELECT 'GRANT SELECT ON x TO y' AS sql").kind,
    ).toBe("other");
    expect(
      analyzeStatement("SELECT 1 -- GRANT SELECT ON t TO bob").kind,
    ).toBe("other");
  });

  it("B7 — regression: DML/DDL kinds + tiers KHÔNG đổi", () => {
    expect(guardTier(analyzeStatement("DELETE FROM logs WHERE id = 1"))).toBe(
      "amber",
    );
    expect(guardTier(analyzeStatement("DELETE FROM logs"))).toBe("red");
    expect(guardTier(analyzeStatement("TRUNCATE TABLE t"))).toBe("red");
    expect(guardTier(analyzeStatement("DROP TABLE t"))).toBe("red");
    expect(guardTier(analyzeStatement("UPDATE t SET a = 1"))).toBe("red");
    expect(guardTier(analyzeStatement("UPDATE t SET a = 1 WHERE id = 2"))).toBe(
      "none",
    );
    expect(guardTier(analyzeStatement("SELECT 1"))).toBe("none");
  });
});

describe("TASK-AHL-004b — session-control DCL (KILL/TERMINATE)", () => {
  it("C1 — pg_cancel_backend(pid) wrapped → kind=kill, tier=admin-red", () => {
    const a = analyzeStatement("SELECT pg_cancel_backend(12345)");
    expect(a.kind).toBe("kill");
    expect(guardTier(a)).toBe("admin-red");
  });

  it("C2 — pg_terminate_backend(pid) wrapped → kind=terminate, tier=admin-red", () => {
    const a = analyzeStatement("SELECT pg_terminate_backend(12345)");
    expect(a.kind).toBe("terminate");
    expect(guardTier(a)).toBe("admin-red");
  });

  it("C3 — case-insensitive kill/terminate", () => {
    expect(analyzeStatement("select PG_CANCEL_BACKEND(9999)").kind).toBe(
      "kill",
    );
    expect(analyzeStatement("select Pg_Terminate_Backend(9999)").kind).toBe(
      "terminate",
    );
  });

  it("C4 — regression: bare SELECT 1 vẫn other/none", () => {
    expect(analyzeStatement("SELECT 1").kind).toBe("other");
    expect(guardTier(analyzeStatement("SELECT 1"))).toBe("none");
  });
});
