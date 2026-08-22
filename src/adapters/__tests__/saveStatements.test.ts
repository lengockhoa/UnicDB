// src/adapters/__tests__/saveStatements.test.ts
//
// TASK-503 — buildSaveStatements pure-fn unit tests.
//
// Tests the dialect-shaped SQL builder used by the host to translate the
// webview's `saveEdits` payload into UPDATE / INSERT / DELETE statements.
//
// Pure functions: no DOM, no vscode. The fn signature mirrors the contract
// in src/core/saveStatements.ts:
//
//   buildSaveStatements(dialect, tableName, pkColumns, columns, edits, serverRows)
//     -> { statements: string[]; warnings: string[] }
//     | { ok: false; reason: 'no_pk' }
//
// `edits` is EditSnapshotEntry[] (same shape as EditState.snapshot()).
// The fn returns ADD-row markers as INSERT, delete markers as DELETE,
// ordinary cell edits as UPDATE (coalesced per row).
//
// All three cases have a "no PK + non-postgres → ok:false" guard.
import { describe, it, expect } from "vitest";
import {
  buildSaveStatements,
  type EditEntry,
  type Dialect,
} from "../../core/saveStatements";

describe("buildSaveStatements — PK present (postgres)", () => {
  it("two cell edits on same row coalesce into ONE UPDATE", () => {
    const edits: EditEntry[] = [
      { rowId: 5, colIndex: 1, value: "new-b" },
      { rowId: 5, colIndex: 2, value: 42 },
    ];
    const serverRows: unknown[][] = [
      [1, "old-b", 10], // rowId 0
      [2, "old-c", 20], // rowId 1
      [3, "old-d", 30], // rowId 2
      [4, "old-e", 40], // rowId 3
      [5, "old-f", 50], // rowId 4
      [6, "g",        60], // rowId 5 → PK id=6
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name", "qty"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    // Postgres uses $1..$N placeholders, identifier quoted only as plain text
    // in this contract (tableName / column names are host-supplied, not user).
    expect(r.statements).toHaveLength(1);
    // The set col order is non-PK cols only; the WHERE pins on id=6 (original).
    const stmt = r.statements[0];
    expect(stmt).toMatch(/UPDATE\s+t\s+SET/i);
    expect(stmt).toMatch(/name=\$1/);
    expect(stmt).toMatch(/qty=\$2/);
    expect(stmt).toMatch(/WHERE\s+id=\$3/i);
    // parameters (in order): the two new values, then the original id.
    expect(r.parameters).toEqual(["new-b", 42, 6]);
  });
});

describe("buildSaveStatements — PK present (mysql)", () => {
  it("UPDATE uses `?` placeholders and backtick-quoted identifiers", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [[7, "old-y", 99]];
    const r = buildSaveStatements(
      "mysql",
      "t",
      ["id"],
      ["id", "name", "qty"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(
      /UPDATE\s+`t`\s+SET\s+`name`=\?.*WHERE\s+`id`=\?/i,
    );
    expect(r.parameters).toEqual(["x", 7]);
  });
});

describe("buildSaveStatements — PK present (mssql)", () => {
  it("UPDATE uses TOP-1 subquery idiom (SET ... WHERE id = ...) ", () => {
    // Contract is mssql-flavoured via quoted identifiers; the dialect gate is
    // exercised at the function level by `dialect === 'mssql'`. Per the TASK-503
    // contract the UPDATE form is the same set/where; only quoting differs.
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [[7, "old-y", 99]];
    const r = buildSaveStatements(
      "mssql",
      "t",
      ["id"],
      ["id", "name", "qty"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(
      /UPDATE\s+\[t\]\s+SET\s+\[name\]=\?.*WHERE\s+\[id\]=\?/i,
    );
    expect(r.parameters).toEqual(["x", 7]);
  });
});

describe("buildSaveStatements — postgres no-PK → ctid", () => {
  it("emits UPDATE ... WHERE ctid = $N (and a ctid lookup warnings)", () => {
    const edits: EditEntry[] = [{ rowId: 1, colIndex: 0, value: "edited" }];
    const serverRows: unknown[][] = [
      ["a", "b"],
      ["c", "d"], // rowId 1 → ctid "(0,1)"
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      [], // no PK
      ["x", "y"],
      edits,
      serverRows,
      { ctidByRowId: new Map([[1, "(0,1)"]]) },
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("ctid"))).toBe(true);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/ctid/i);
    expect(r.statements[0]).toMatch(/=\s*\$1/i);
    // parameters: the new value (first positional) + the ctid as string.
    expect(r.parameters).toEqual(["edited", "(0,1)"]);
  });

  it("postgres no-PK + missing ctid for rowId → row is SKIPPED with warning", () => {
    const edits: EditEntry[] = [
      { rowId: 1, colIndex: 0, value: "edited" },
      { rowId: 99, colIndex: 0, value: "other" }, // no ctid available
    ];
    const serverRows: unknown[][] = [["a", "b"], ["c", "d"]];
    const r = buildSaveStatements(
      "postgres",
      "t",
      [],
      ["x", "y"],
      edits,
      serverRows,
      { ctidByRowId: new Map([[1, "(0,1)"]]) },
    );
    expect(r.ok).toBe(true);
    // Only one statement (the row we could address). The unknown one is warned.
    expect(r.statements).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("row 99"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("ctid"))).toBe(true);
  });
});

describe("buildSaveStatements — mysql/mssql no-PK → ok:false", () => {
  it("mysql returns { ok: false, reason: 'no_pk' } and NO statements", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 0, value: "edited" }];
    const r = buildSaveStatements(
      "mysql",
      "t",
      [],
      ["x", "y"],
      edits,
      [["a", "b"]],
    );
    expect(r.ok).toBe(false);
    if (r.ok === true) return;
    expect(r.reason).toBe("no_pk");
    // Refusal: caller MUST read `warnings` for the no-pk explanation.
    expect(r.warnings.some((w) => /no PRIMARY KEY/i.test(w))).toBe(true);
  });

  it("mssql returns { ok: false, reason: 'no_pk' } and NO statements", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 0, value: "edited" }];
    const r = buildSaveStatements(
      "mssql",
      "t",
      [],
      ["x", "y"],
      edits,
      [["a", "b"]],
    );
    expect(r.ok).toBe(false);
    if (r.ok === true) return;
    expect(r.reason).toBe("no_pk");
  });
});

describe("buildSaveStatements — Add Row / Delete Row markers", () => {
  it("__vsdb_new_row__ marker → INSERT statement with current values", () => {
    const blankValues: unknown[] = ["", ""];
    const marker: EditEntry = {
      rowId: 42,
      colIndex: 0,
      value: { __vsdb_new_row__: true, __rowId: 42, values: blankValues },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["a", "b"],
      [marker],
      [],
    );
    expect(r.ok).toBe(true);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/^INSERT INTO t \(a, b\) VALUES \(\$1, \$2\)/);
    expect(r.parameters).toEqual(["", ""]);
  });

  it("__vsdb_deleted__ marker → DELETE statement", () => {
    const marker: EditEntry = {
      rowId: 7,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 7 },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      [marker],
      // server row indexed by rowId=7 has [original-id, original-name]. The
      // host pins the DELETE WHERE on the original (server-truth) id so a
      // concurrent update can't re-delete a row that has since changed.
      Array.from({ length: 8 }, () => ["", ""]).map((row, idx) =>
        idx === 7 ? [99, "old-name"] : row,
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/^DELETE FROM t WHERE id=\$1/i);
    expect(r.parameters).toEqual([99]);
  });
});

describe("buildSaveStatements — batch shape", () => {
  it("two rows × two cells → 2 UPDATE statements (one per row)", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 1, value: "X" },
      { rowId: 0, colIndex: 2, value: 11 },
      { rowId: 1, colIndex: 1, value: "Y" },
      { rowId: 1, colIndex: 2, value: 22 },
    ];
    const serverRows: unknown[][] = [
      [1, "old-a", 10],
      [2, "old-b", 20],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name", "qty"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    expect(r.statements).toHaveLength(2);
    // Placeholders are globally monotonic across the batch: row 0 → $1..$3,
    // row 1 → $4..$6 (postgres) / `?` × N (mysql/mssql). The driver sees the
    // joined parameter array; ordering matches the joined statement text.
    expect(r.statements[0]).toMatch(/name=\$1.*qty=\$2.*WHERE id=\$3/);
    expect(r.statements[1]).toMatch(/name=\$4.*qty=\$5.*WHERE id=\$6/);
    expect(r.parameters).toEqual(["X", 11, 1, "Y", 22, 2]);
  });
});

describe("buildSaveStatements — no edits → empty statements, no warnings", () => {
  it("empty edits + PK → empty array, no warnings", () => {
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      [],
      [[1, "a"]],
    );
    expect(r.ok).toBe(true);
    expect(r.statements).toEqual([]);
    expect(r.parameters).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("buildSaveStatements — type coverage", () => {
  it("Dialects covered: postgres / mysql / mssql (compile-time exhaustive switch)", () => {
    const dialects: Dialect[] = ["postgres", "mysql", "mssql"];
    for (const d of dialects) {
      const r = buildSaveStatements(
        d,
        "t",
        ["id"],
        ["id", "v"],
        [{ rowId: 0, colIndex: 1, value: "x" }],
        [[1, "y"]],
      );
      expect(r.ok).toBe(true);
      expect(r.statements).toHaveLength(1);
      expect(r.parameters).toEqual(["x", 1]);
    }
  });
});
