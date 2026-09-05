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
  it("__UnicDB_new_row__ marker → INSERT statement with current values (inline)", () => {
    const blankValues: unknown[] = ["", ""];
    const marker: EditEntry = {
      rowId: 42,
      colIndex: 0,
      value: { __UnicDB_new_row__: true, __rowId: 42, values: blankValues },
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

  it("__UnicDB_deleted__ marker → DELETE statement (inline WHERE)", () => {
    const marker: EditEntry = {
      rowId: 7,
      colIndex: 0,
      value: { __UnicDB_deleted__: true, __rowId: 7 },
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
      value: { __UnicDB_deleted__: true, __rowId: 7 },
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
      value: { __UnicDB_deleted__: true, __rowId: 7 },
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
      value: { __UnicDB_deleted__: true, __rowId: 0 },
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
      value: { __UnicDB_deleted__: true, __rowId: 1 },
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

// ---- Review Finding 3 (fix round 2): no_pk guard mis-scoped over
// insert-only rows + empty Add Row on a no-PK table emits an unidentifiable
// bare INSERT. --------------------------------------------------------------
describe("buildSaveStatements — no_pk guard scoping (Finding 3, fix round 2)", () => {
  // Case 1 (unchanged behavior) — a genuine cell edit on a no-PK mysql table
  // is still hard-refused. Already covered above ("mysql no-PK + CELL EDIT
  // (not delete-only) → still hard refuses ok:false, reason no_pk
  // (unchanged)") — repeated here as the anchor case for this describe
  // block's 3-case contract.
  it("no-PK + cell edit (no insert marker) → still hard refused, reason no_pk", () => {
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
  });

  // Case 2 (bug) — pre-fix: the no_pk guard counted `sortedRowIds` BEFORE
  // excluding insert-marker rows (the UPDATE loop skips them via
  // `insertRowIds.has(rowId)` further down). A typed value on an Add Row
  // arrives as a SEPARATE plain cell-edit EditEntry for the same rowId
  // (onCellValueChangedHandler records it apart from the marker's own
  // `values`, per the "Finding 1, cycle T" describe block above) — that
  // extra entry populates `sortedRowIds`, so the guard fired and hard-
  // refused the whole batch with the misleading "cannot save cell edits"
  // message even though it is an INSERT, not an UPDATE.
  it("no-PK + Add Row WITH a typed value → INSERT is emitted (not refused)", () => {
    const edits: EditEntry[] = [
      {
        rowId: 5,
        colIndex: -1,
        value: {
          __UnicDB_new_row__: true,
          __rowId: 5,
          values: [{ __UnicDB_default__: true }, { __UnicDB_default__: true }],
        },
      },
      { rowId: 5, colIndex: 0, value: "typed-value" },
    ];
    const r = buildSaveStatements(
      "mysql",
      "t",
      [], // no PK
      ["a", "b"],
      edits,
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expectNoPlaceholders(stmt);
    expect(stmt).toBe("INSERT INTO `t` (`a`) VALUES ('typed-value')");
  });

  // Case 3 (bug) — pre-fix: a completely empty Add Row (every column still
  // the DEFAULT-value sentinel) bypassed the no_pk guard entirely (the
  // guard only looked at `sortedRowIds`, which insert markers never
  // populate) and fell through to the bare `INSERT INTO \`t\` () VALUES ()`
  // branch — the exact unidentifiable, unrecoverable row this refusal
  // exists to prevent on a table with no PK to ever address it again.
  it("no-PK + completely empty Add Row → no empty INSERT is ever emitted", () => {
    const marker: EditEntry = {
      rowId: 9,
      colIndex: -1,
      value: {
        __UnicDB_new_row__: true,
        __rowId: 9,
        values: [
          { __UnicDB_default__: true },
          { __UnicDB_default__: true },
        ],
      },
    };
    const r = buildSaveStatements(
      "mysql",
      "t",
      [], // no PK
      ["a", "b"],
      [marker],
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(
      r.statements.some((s) => /INSERT INTO `t` \(\) VALUES \(\)/.test(s)),
    ).toBe(false);
    expect(r.warnings.some((w) => /no primary key/i.test(w))).toBe(true);
    expect(r.skippedRows).toBeDefined();
    expect(
      r.skippedRows!.some((s) => s.rowId === 9 && /no primary key/i.test(s.reason)),
    ).toBe(true);
  });

  // Edge — mixed batch: no-PK table with BOTH an insert-with-values (must
  // proceed) and a genuine cell edit on an existing row (must still be
  // refused wholesale, per the comment at saveStatements.ts:542-545 — the
  // hard refusal is reserved for batches containing UPDATE work).
  it("no-PK + insert-with-values AND a cell edit in the same batch → wholesale no_pk refusal wins (unchanged semantics)", () => {
    const insertMarker: EditEntry = {
      rowId: 5,
      colIndex: -1,
      value: {
        __UnicDB_new_row__: true,
        __rowId: 5,
        values: ["typed-value", "b"],
      },
    };
    const cellEdit: EditEntry = { rowId: 0, colIndex: 0, value: "edited" };
    const r = buildSaveStatements(
      "mysql",
      "t",
      [],
      ["a", "b"],
      [insertMarker, cellEdit],
      [["old-a", "old-b"]],
    );
    expect(r.ok).toBe(false);
    if (r.ok !== false) return;
    expect(r.reason).toBe("no_pk");
  });
});

// ---- Review Fix Round (cycle T) — Finding 1: Add Row cell edits must not
// be silently discarded. ----------------------------------------------------
describe("buildSaveStatements — Add Row cell edits merge into the INSERT (Finding 1, cycle T)", () => {
  it("insert marker + a cell edit on the SAME new row ⇒ the typed value ends up in the INSERT, not dropped", () => {
    const edits: EditEntry[] = [
      {
        rowId: 3,
        colIndex: -1,
        value: {
          __UnicDB_new_row__: true,
          __rowId: 3,
          values: [{ __UnicDB_default__: true }, { __UnicDB_default__: true }],
        },
      },
      { rowId: 3, colIndex: 1, value: "Alice" },
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expectNoPlaceholders(r.statements[0]);
    // "id" stayed untouched (DEFAULT sentinel) → omitted; "name" carries
    // the user's typed value "Alice" — it must NOT be silently dropped.
    expect(r.statements[0]).toBe('INSERT INTO "t" ("name") VALUES (\'Alice\')');
  });

  it("insert marker + edits on 2 different cells of the new row ⇒ both land in the INSERT", () => {
    const edits: EditEntry[] = [
      {
        rowId: 7,
        colIndex: -1,
        value: {
          __UnicDB_new_row__: true,
          __rowId: 7,
          values: [
            { __UnicDB_default__: true },
            { __UnicDB_default__: true },
            { __UnicDB_default__: true },
          ],
        },
      },
      { rowId: 7, colIndex: 0, value: 99 },
      { rowId: 7, colIndex: 2, value: "bob" },
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      [],
      ["id", "age", "name"],
      edits,
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(
      /^INSERT INTO "t" \("id", "name"\) VALUES \(99, 'bob'\)/,
    );
    expect(r.statements[0]).not.toContain("age");
  });
});

// ---- Review Fix Round (cycle T) — Finding 3: MySQL has no `DEFAULT VALUES`
// syntax. ---------------------------------------------------------------
describe("buildSaveStatements — dialect-aware all-DEFAULT insert (Finding 3, cycle T)", () => {
  // Review Finding 3(b), fix round 2: this case originally used pkColumns:
  // [] (no PK) — which, after the round-2 fix, is now a refused row (see
  // "buildSaveStatements — no_pk guard scoping (Finding 3, fix round 2)" >
  // "no-PK + completely empty Add Row → no empty INSERT is ever emitted").
  // Switched to a table WITH a PK so this test keeps covering its original
  // concern (mysql's dialect-specific `() VALUES ()` syntax vs
  // `DEFAULT VALUES`) without colliding with the no-PK refusal.
  it("mysql + all-DEFAULT insert ⇒ INSERT INTO `t` () VALUES () (NOT `DEFAULT VALUES`)", () => {
    const marker: EditEntry = {
      rowId: 1,
      colIndex: -1,
      value: {
        __UnicDB_new_row__: true,
        __rowId: 1,
        values: [{ __UnicDB_default__: true }],
      },
    };
    const r = buildSaveStatements("mysql", "t", ["id"], ["qty"], [marker], []);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).not.toMatch(/DEFAULT VALUES/i);
    expect(r.statements[0]).toBe("INSERT INTO `t` () VALUES ()");
  });

  it("postgres + all-DEFAULT insert is unaffected: still DEFAULT VALUES", () => {
    const marker: EditEntry = {
      rowId: 1,
      colIndex: -1,
      value: {
        __UnicDB_new_row__: true,
        __rowId: 1,
        values: [{ __UnicDB_default__: true }],
      },
    };
    const r = buildSaveStatements("postgres", "t", [], ["qty"], [marker], []);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toBe('INSERT INTO "t" DEFAULT VALUES');
  });

  // Same round-2 rationale as the mysql case above — switched to a table
  // WITH a PK so this stays a dialect-syntax test, not a no-PK-refusal one.
  it("mssql + all-DEFAULT insert is unaffected: still DEFAULT VALUES", () => {
    const marker: EditEntry = {
      rowId: 1,
      colIndex: -1,
      value: {
        __UnicDB_new_row__: true,
        __rowId: 1,
        values: [{ __UnicDB_default__: true }],
      },
    };
    const r = buildSaveStatements("mssql", "t", ["id"], ["qty"], [marker], []);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toBe("INSERT INTO [t] DEFAULT VALUES");
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
        __UnicDB_new_row__: true,
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
      value: { __UnicDB_deleted__: true, __rowId: 2 },
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

// ---- TASK-008 S1 (cycle-x-audit-host): NULL PK in a server row must never
// reach SQL. Pre-fix, both PK WHERE builders interpolated
// `sqlLiteral(serverRow[i])` unconditionally, so a NULL/undefined PK value
// produced `WHERE "id"=NULL` — matches zero rows, the statement is
// acknowledged as a successful save, and the edit is silently lost.
// Post-fix the row takes the existing skippedRows path and NO statement is
// emitted for it.
describe("buildSaveStatements — NULL PK in server row (TASK-008 S1)", () => {
  it("NULL PK on UPDATE skips the row and emits nothing", () => {
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "v"],
      [{ rowId: 0, colIndex: 1, value: "x" }],
      [[null, "old"]],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(r.statements.some((s) => s.includes("=NULL"))).toBe(false);
    expect(r.skippedRows).toEqual([
      { rowId: 0, reason: expect.stringMatching(/pk column NULL in server row/) },
    ]);
    expect(r.skippedRows![0].reason).toContain("id");
    expect(
      r.warnings.some((w) => /pk column NULL in server row/.test(w)),
    ).toBe(true);
  });

  it("partial batch: only the NULL-PK row is skipped; the good row still emits", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 1, value: "a-new" },
      { rowId: 1, colIndex: 1, value: "b-new" },
    ];
    const serverRows: unknown[][] = [
      [1, "a"], // rowId 0 → id=1, addressable
      [null, "b"], // rowId 1 → id NULL, not addressable
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "v"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/WHERE "id"=1/);
    expect(r.statements.join(" ")).not.toContain("=NULL");
    expect(r.skippedRows).toHaveLength(1);
    expect(r.skippedRows![0].rowId).toBe(1);
  });

  it("composite PK with one NULL component is skipped whole; reason names the NULL component", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 2, value: "x-new" },
      { rowId: 1, colIndex: 2, value: "y-new" }, // control row — both PK parts set
    ];
    const serverRows: unknown[][] = [
      [1, null, "x"], // b is NULL → row 0 must be skipped
      [1, 2, "y"],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["a", "b"],
      ["a", "b", "v"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/WHERE "a"=1 AND "b"=2/);
    expect(r.skippedRows).toHaveLength(1);
    expect(r.skippedRows![0].rowId).toBe(0);
    expect(r.skippedRows![0].reason).toContain('"b"');
    expect(r.skippedRows![0].reason).not.toContain('"a"');
  });

  it("NULL PK on DELETE is skipped too (both builders, not just UPDATE)", () => {
    const marker: EditEntry = {
      rowId: 3,
      colIndex: 0,
      value: { __UnicDB_deleted__: true, __rowId: 3 },
    };
    const serverRows: unknown[][] = [
      [1, "a"],
      [2, "b"],
      [3, "c"],
      [null, "d"], // rowId 3 → PK NULL
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      [marker],
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(0);
    expect(r.statements.some((s) => /^DELETE/.test(s))).toBe(false);
    expect(r.skippedRows).toEqual([
      { rowId: 3, reason: expect.stringMatching(/pk column NULL in server row/) },
    ]);
    expect(r.skippedRows![0].reason).toContain("id");
    expect(
      r.warnings.some((w) => /pk column NULL in server row/.test(w)),
    ).toBe(true);
  });

  it("falsy-but-present PK values (0, '', false) still address rows — guard is null/undefined only", () => {
    const cases: Array<{ pkVal: unknown; expected: string }> = [
      { pkVal: 0, expected: 'WHERE "id"=0' },
      { pkVal: "", expected: "WHERE \"id\"=''" },
      { pkVal: false, expected: 'WHERE "id"=FALSE' }, // sqlLiteral(false) → FALSE
    ];
    for (const { pkVal, expected } of cases) {
      const r = buildSaveStatements(
        "postgres",
        "t",
        ["id"],
        ["id", "v"],
        [{ rowId: 0, colIndex: 1, value: "x" }],
        [[pkVal, "old"]],
      );
      expect(r.ok).toBe(true);
      if (r.ok !== true) return;
      expect(r.statements).toHaveLength(1);
      expect(r.statements[0]).toContain(expected);
      expect(
        r.skippedRows === undefined || r.skippedRows.length === 0,
      ).toBe(true);
    }
  });
});
