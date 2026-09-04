// src/core/__tests__/schemaImpact.test.ts
// TASK-ARP07-001 — pure schema-impact classifier corpus (TDD).
// Pure core, no vscode mock — same style as dangerousStatement.test.ts /
// readOnlyIntent.test.ts. Corpus is pinned 1:1 to the task's §Test Cases.
import { describe, it, expect, vi } from "vitest";
import {
  hasSchemaImpact,
  completedSchemaImpact,
  shouldRefreshAfter,
  createDebouncedRefresher,
} from "../schemaImpact";

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

describe("TASK-UX1-011 (R13) — shouldRefreshAfter", () => {
  it("#1 DDL → 'full'", () => {
    expect(shouldRefreshAfter(["CREATE TABLE t (id int)"], "postgres")).toBe(
      "full",
    );
  });

  it("#2 DML-only → 'tree'", () => {
    expect(shouldRefreshAfter(["INSERT INTO t VALUES (1)"], "postgres")).toBe(
      "tree",
    );
    expect(shouldRefreshAfter(["UPDATE t SET a=1"], "postgres")).toBe("tree");
    expect(shouldRefreshAfter(["DELETE FROM t"], "postgres")).toBe("tree");
    expect(shouldRefreshAfter(["TRUNCATE t"], "postgres")).toBe("tree");
    expect(shouldRefreshAfter(["MERGE INTO t USING s ON 1=1"], "postgres")).toBe("tree");
  });

  it("#3 SELECT-only → 'none'", () => {
    expect(shouldRefreshAfter(["SELECT 1"], "postgres")).toBe("none");
    expect(shouldRefreshAfter(["EXPLAIN SELECT 1"], "postgres")).toBe("none");
  });

  it("#4 empty batch → 'none' (failures filtered out)", () => {
    expect(shouldRefreshAfter([], "postgres")).toBe("none");
  });

  it("#5 boundary — COMMENT ON, EXPLAIN, masked DDL", () => {
    expect(shouldRefreshAfter(["COMMENT ON TABLE t IS 'x'"], "postgres")).toBe(
      "full",
    );
    expect(shouldRefreshAfter(["EXPLAIN SELECT 1"], "postgres")).toBe("none");
    expect(shouldRefreshAfter(["/* c */ CREATE VIEW v AS SELECT 1"], "postgres")).toBe(
      "full",
    );
  });

  it("#5b mixed batch — DDL sticky", () => {
    expect(
      shouldRefreshAfter(
        ["INSERT INTO t VALUES (1)", "CREATE TABLE x (id int)"],
        "postgres",
      ),
    ).toBe("full");
  });

  it("#5c only-DML batch (no DDL anywhere) → 'tree'", () => {
    expect(
      shouldRefreshAfter(
        ["INSERT INTO t VALUES (1)", "SELECT 1 FROM t"],
        "postgres",
      ),
    ).toBe("tree");
  });
});

describe("TASK-UX1-011 (R13) — createDebouncedRefresher", () => {
  it("#6 trigger+advance → fires once with latest strategy", () => {
    vi.useFakeTimers();
    const calls: Array<"full" | "tree"> = [];
    const r = createDebouncedRefresher((s) => calls.push(s), 200);
    r.trigger("full");
    r.trigger("tree"); // resets timer; "tree" is the latest
    vi.advanceTimersByTime(199);
    expect(calls).toEqual([]); // not yet
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["tree"]); // fires with latest
    vi.useRealTimers();
  });

  it("#7 3 rapid triggers within window → exactly 1 fire", () => {
    vi.useFakeTimers();
    const calls: Array<"full" | "tree"> = [];
    const r = createDebouncedRefresher((s) => calls.push(s), 200);
    r.trigger("full");
    r.trigger("full");
    r.trigger("full");
    vi.advanceTimersByTime(250);
    expect(calls).toEqual(["full"]);
    vi.useRealTimers();
  });

  it("#8 flush() forces immediate fire", () => {
    vi.useFakeTimers();
    const calls: Array<"full" | "tree"> = [];
    const r = createDebouncedRefresher((s) => calls.push(s), 200);
    r.trigger("tree");
    r.flush();
    expect(calls).toEqual(["tree"]);
    vi.useRealTimers();
  });

  it("#9 cancel() clears pending", () => {
    vi.useFakeTimers();
    const calls: Array<"full" | "tree"> = [];
    const r = createDebouncedRefresher((s) => calls.push(s), 200);
    r.trigger("full");
    r.cancel();
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it("#10 'none' trigger is a no-op (does not arm or fire)", () => {
    vi.useFakeTimers();
    const calls: Array<"full" | "tree"> = [];
    const r = createDebouncedRefresher((s) => calls.push(s), 200);
    r.trigger("none");
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it("#11 latest accessor reflects armed strategy", () => {
    vi.useFakeTimers();
    const r = createDebouncedRefresher(() => undefined, 200);
    expect(r.latest).toBe("none");
    r.trigger("tree");
    expect(r.latest).toBe("tree");
    r.trigger("full");
    expect(r.latest).toBe("full");
    r.cancel();
    expect(r.latest).toBe("none");
    vi.useRealTimers();
  });
});
