// src/adapters/__tests__/saveStatements.test.ts
//
// TASK-503 — buildSaveStatements pure-fn unit tests.
//
// Tests the dialect-shaped SQL builder used by the host to translate the
// webview's `saveEdits` payload into UPDATE / INSERT / DELETE statements.
//
// FIX ROUND 1 (inline-literal contract):
//   - Output SQL is INLINE-LITERAL — values embedded via sqlLiteral
//     (single-quote doubling, NO backslash escaping, portable across PG
//     and MSSQL).
//   - The `parameters[]` aggregate is GONE — host passes the SQL string
//     straight to `adapter.runQuery(sql)`.
//   - No `$N` or `?` placeholders anywhere in the output.
//
// All three cases have a "no PK + non-postgres → ok:false" guard.
import { describe, it, expect } from "vitest";
import {
  buildSaveStatements,
  type EditEntry,
  type Dialect,
} from "../../core/saveStatements";

/** Assert a statement has NO placeholders ($N, ?). */
function expectNoPlaceholders(stmt: string): void {
  expect(stmt).not.toMatch(/\$\d+/);
  expect(stmt).not.toMatch(/\?/);
}

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
      [6, "g", 60], // rowId 5 → PK id=6
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
    if (r.ok !== true) return;
    expect(r.warnings).toEqual([]);
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(/UPDATE\s+"t"\s+SET/i);
    expect(stmt).toContain("\"name\"='new-b'");
    expect(stmt).toContain('"qty"=42');
    expect(stmt).toMatch(/WHERE\s+"id"=6/i);
  });
});

describe("buildSaveStatements — PK present (mysql)", () => {
  it("UPDATE uses inline literal values and backtick-quoted identifiers", () => {
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
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(
      /UPDATE\s+`t`\s+SET\s+`name`='x'.*WHERE\s+`id`=7/i,
    );
  });
});

describe("buildSaveStatements — PK present (mssql)", () => {
  it("UPDATE uses inline literal values and bracket-quoted identifiers", () => {
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
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(
      /UPDATE\s+\[t\]\s+SET\s+\[name\]='x'.*WHERE\s+\[id\]=7/i,
    );
  });
});

describe("buildSaveStatements — postgres no-PK → ctid", () => {
  it("emits UPDATE ... WHERE ctid = '<literal>' (no $N, no ?)", () => {
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
    if (r.ok !== true) return;
    expect(r.warnings.some((w) => w.includes("ctid"))).toBe(true);
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(/ctid/i);
    expect(stmt).toMatch(/'edited'/);
    expect(stmt).toMatch(/ctid='\(0,1\)'/);
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
    if (r.ok !== true) return;
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
  it("__vsdb_new_row__ marker → INSERT statement with current values (inline)", () => {
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
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(/^INSERT INTO "t" \("a", "b"\) VALUES \('', ''\)/);
  });

  it("__vsdb_deleted__ marker → DELETE statement (inline WHERE)", () => {
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
      Array.from({ length: 8 }, () => ["", ""]).map((row, idx) =>
        idx === 7 ? [99, "old-name"] : row,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(/^DELETE FROM "t" WHERE "id"=99/i);
  });

  // ---- postgres no-PK DELETE via ctid (TASK-003) --------------------------
  it("PG no-PK + delete marker + ctid in map → DELETE FROM t WHERE ctid='(0,2)'", () => {
    const marker: EditEntry = {
      rowId: 7,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 7 },
    };
    const serverRows: unknown[][] = Array.from({ length: 8 }, () => ["", ""]).map(
      (row, idx) => (idx === 7 ? [99, "old-name"] : row),
    );
    const r = buildSaveStatements(
      "postgres",
      "t",
      [], // no PK
      ["id", "name"],
      [marker],
      serverRows,
      { ctidByRowId: new Map([[7, "(0,2)"]]) },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toMatch(/^DELETE FROM "t" WHERE ctid='\(0,2\)'/i);
    expect(
      r.warnings.some((w) => /not safe under concurrent writes/i.test(w)),
    ).toBe(true);
  });

  it("PG no-PK + delete marker + rowId NOT in ctid map → 0 stmts + warning", () => {
    const marker: EditEntry = {
      rowId: 7,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 7 },
    };
    const serverRows: unknown[][] = Array.from({ length: 8 }, () => ["", ""]).map(
      (row, idx) => (idx === 7 ? [99, "old-name"] : row),
    );
    const r = buildSaveStatements(
      "postgres",
      "t",
      [],
      ["id", "name"],
      [marker],
      serverRows,
      { ctidByRowId: new Map() }, // empty — no ctid for row 7
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(
      r.warnings.some(
        (w) =>
          w ===
          "delete row 7 skipped: postgres no-PK + missing ctid",
      ),
    ).toBe(true);
    // TASK-001 A19-skip: a machine-readable twin of the warning so the
    // webview never clears an edit that produced no statement.
    expect(r.skippedRows).toBeDefined();
    expect(
      r.skippedRows!.some(
        (s) => s.rowId === 7 && /ctid/i.test(s.reason),
      ),
    ).toBe(true);
  });

  it("mysql no-PK + delete marker → TASK-001: soft per-row skip (ok:true, no DELETE emitted, skippedRows names the row)", () => {
    const marker: EditEntry = {
      rowId: 0,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 0 },
    };
    const r = buildSaveStatements(
      "mysql",
      "t",
      [],
      ["a"],
      [marker],
      [["x"]],
      { ctidByRowId: new Map([[0, "(0,1)"]]) },
    );
    // TASK-001 item 3 (A10-remainder): a delete-only batch on a no-PK
    // mysql/mssql table is no longer a hard wholesale refusal — mysql has
    // no ctid-style fallback, so the row is skipped individually with an
    // explicit warning + skippedRows entry, and the batch still reports
    // ok:true (statements empty). The blanket no_pk REFUSAL is reserved for
    // batches that actually contain cell edits needing a PK-based WHERE.
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(r.warnings.some((w) => /no primary key/i.test(w))).toBe(true);
    expect(r.skippedRows).toBeDefined();
    expect(
      r.skippedRows!.some(
        (s) => s.rowId === 0 && /no primary key/i.test(s.reason),
      ),
    ).toBe(true);
  });

  it("mysql no-PK + CELL EDIT (not delete-only) → still hard refuses ok:false, reason no_pk (unchanged)", () => {
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
    if (r.ok !== false) return;
    expect(r.reason).toBe("no_pk");
    expect(r.warnings.some((w) => /no PRIMARY KEY/i.test(w))).toBe(true);
  });

  it("PG no-PK + delete + update mixed in one save → 1 ctid-DELETE + 1 ctid-UPDATE, ordered deletes-then-updates", () => {
    const deleteMarker: EditEntry = {
      rowId: 1,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 1 },
    };
    const cellEdit: EditEntry = {
      rowId: 0,
      colIndex: 0,
      value: "new-a",
    };
    const serverRows: unknown[][] = [
      ["old-a-0", "b-0"],
      ["old-a-1", "b-1"],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      [],
      ["a", "b"],
      [deleteMarker, cellEdit],
      serverRows,
      {
        ctidByRowId: new Map([
          [1, "(0,1)"],
          [0, "(0,0)"],
        ]),
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(2);
    const stmt0 = r.statements[0];
    const stmt1 = r.statements[1];
    expectNoPlaceholders(stmt0);
    expectNoPlaceholders(stmt1);
    expect(stmt0).toMatch(/^DELETE FROM "t" WHERE ctid='\(0,1\)'/i);
    expect(stmt1).toMatch(/^UPDATE "t" SET "a"='new-a' WHERE ctid='\(0,0\)'/i);
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
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(2);
    // Two-row batch — each statement independent, inline-literal.
    expect(r.statements[0]).toMatch(/"name"='X'.*"qty"=11.*WHERE\s+"id"=1/);
    expect(r.statements[1]).toMatch(/"name"='Y'.*"qty"=22.*WHERE\s+"id"=2/);
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
    if (r.ok !== true) return;
    expect(r.statements).toEqual([]);
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
      if (r.ok !== true) continue;
      expect(r.statements).toHaveLength(1);
      const stmt = r.statements[0];
      expectNoPlaceholders(stmt);
      expect(stmt).toMatch(/=('|")x('|")/);
      expect(stmt).toMatch(/WHERE\s+\S*id\S*=1/);
    }
  });
});

// ---- TASK-001 A19-skip (§3.4a): skippedRows must be machine-readable ------
// A skipped row must never come back as an unrecoverable "ok:true, nothing
// mentions it" — see docs/AI_HANDOFF/tasks/TASK-001.md §Test Cases.

describe("buildSaveStatements — skippedRows (A19-skip, §3.4a)", () => {
  it("nothing skipped: all rows emit ⇒ skippedRows is undefined or [] (never a phantom entry)", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 1, value: "x" },
      { rowId: 1, colIndex: 1, value: "y" },
    ];
    const serverRows: unknown[][] = [
      [1, "a"],
      [2, "b"],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(2);
    expect(r.skippedRows === undefined || r.skippedRows!.length === 0).toBe(
      true,
    );
  });

  it("partial skip: 3 dirty rows, row 2 has no server row ⇒ ok:true, statements.length===2, skippedRows exactly [{rowId:2,…}] — the two good rows still emit", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 1, value: "a-new" },
      { rowId: 2, colIndex: 1, value: "gone" }, // no server row at index 2
      { rowId: 1, colIndex: 1, value: "b-new" },
    ];
    // Only indices 0 and 1 exist; serverRows[2] is undefined.
    const serverRows: unknown[][] = [
      [10, "a"],
      [11, "b"],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(2);
    expect(r.skippedRows).toEqual([
      { rowId: 2, reason: expect.stringContaining("no server row") },
    ]);
  });

  it("no-warning drop: row whose only edits hit unknown col indexes (cols.length===0 at :453) ⇒ skippedRows contains that rowId (warnings may stay silent — must assert on skippedRows, not warning text)", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 99, value: "x" }, // unknown col index — the row's ONLY edit
    ];
    const serverRows: unknown[][] = [[1, "a"]];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(r.skippedRows).toBeDefined();
    expect(r.skippedRows!.some((s) => s.rowId === 0)).toBe(true);
  });

  it("false positive guard: row with BOTH an insert marker and cell edits ⇒ one INSERT emitted, skippedRows does NOT contain that rowId (the insertRowIds.has(rowId) skip is correct behavior, not data loss)", () => {
    const insertMarker: EditEntry = {
      rowId: 5,
      colIndex: 0,
      value: {
        __vsdb_new_row__: true,
        __rowId: 5,
        values: ["new-a", "new-b"],
      },
    };
    // Same rowId also carries a redundant cell edit — the UPDATE loop must
    // skip it silently (it's already covered by the INSERT above).
    const cellEdit: EditEntry = { rowId: 5, colIndex: 1, value: "ignored" };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["a", "b"],
      [insertMarker, cellEdit],
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/^INSERT INTO "t"/);
    expect(
      r.skippedRows === undefined ||
        !r.skippedRows.some((s) => s.rowId === 5),
    ).toBe(true);
  });

  it("live path: postgres no-PK, ctidByRowId empty (what A3 produces today), one cell edit ⇒ ok:true, 0 statements, skippedRows [{rowId, reason:/no-PK \\+ missing ctid/}]", () => {
    const edits: EditEntry[] = [{ rowId: 3, colIndex: 0, value: "edited" }];
    const serverRows: unknown[][] = [["", ""], ["", ""], ["", ""], ["a", "b"]];
    const r = buildSaveStatements(
      "postgres",
      "t",
      [], // no PK
      ["x", "y"],
      edits,
      serverRows,
      { ctidByRowId: new Map() }, // A3 unfixed today ⇒ always empty
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(r.skippedRows).toEqual([
      { rowId: 3, reason: expect.stringMatching(/no-PK \+ missing ctid/) },
    ]);
  });

  it("non-postgres no-PK DELETE now warns (item 3) instead of a silent continue, and records skippedRows", () => {
    const marker: EditEntry = {
      rowId: 2,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 2 },
    };
    const r = buildSaveStatements("mssql", "t", [], ["a"], [marker], [["x"]]);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.skippedRows).toBeDefined();
    expect(r.skippedRows!.some((s) => s.rowId === 2)).toBe(true);
  });
});
