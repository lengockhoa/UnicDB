// src/adapters/__tests__/saveStatementsInline.test.ts
//
// TASK-503 Fix Round 1 — INLINE LITERAL contract tests.
//
// After Fix R1 (option B): the build emits complete SQL with values inlined
// via the portable sqlLiteral (single-quote doubling, NO backslash escaping).
// The `parameters[]` field is REMOVED — no driver-side substitution needed.
// The output SQL can be shipped straight to `adapter.runQuery(sql)`.
//
// These tests assert the new contract — they are RED until the build
// function is rewritten.
import { describe, it, expect } from "vitest";
import {
  buildSaveStatements,
  type EditEntry,
} from "../../core/saveStatements";

describe("buildSaveStatements — INLINE LITERAL contract (Fix R1)", () => {
  it("postgres PK present: values inlined as literals (no $N placeholders, no parameters)", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 1, value: "new-name" },
      { rowId: 0, colIndex: 2, value: 42 },
    ];
    const serverRows: unknown[][] = [[7, "old", 10]];
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
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    // No placeholder characters.
    expect(stmt).not.toMatch(/\$\d+/);
    expect(stmt).not.toMatch(/\?/);
    // Inline string with single-quote escape.
    expect(stmt).toContain(`'new-name'`);
    expect(stmt).toContain(`42`);
    expect(stmt).toContain(`WHERE "id"=7`);
    // parameters field is GONE — call sites MUST NOT read it.
    expect((r as unknown as { parameters?: unknown[] }).parameters).toBeUndefined();
  });

  it("postgres PK present: value containing apostrophe is escaped by quote-doubling", () => {
    const edits: EditEntry[] = [
      { rowId: 0, colIndex: 1, value: "O'Brien" },
    ];
    const serverRows: unknown[][] = [[1, "old", 10]];
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
    expect(r.statements).toHaveLength(1);
    // Portable escape: single quote doubled.
    expect(r.statements[0]).toContain(`'O''Brien'`);
    // Backslash NOT escaped (R1 portable).
    expect(r.statements[0]).not.toContain(`\\`);
  });

  it("postgres PK present: NULL value inlined as NULL", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: null }];
    const serverRows: unknown[][] = [[1, "old"]];
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
    expect(r.statements[0]).toContain(`"name"=NULL`);
  });

  it("mysql PK present: backtick identifiers + inline literal values", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [[7, "y"]];
    const r = buildSaveStatements(
      "mysql",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    const stmt = r.statements[0];
    expect(stmt).not.toMatch(/\?/);
    expect(stmt).toContain("`t`");
    expect(stmt).toContain("`name`");
    expect(stmt).toContain("`id`");
    expect(stmt).toContain("'x'");
    expect(stmt).toContain("7");
  });

  it("mssql PK present: square-bracket identifiers + inline literal values", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "z" }];
    const serverRows: unknown[][] = [[9, "y"]];
    const r = buildSaveStatements(
      "mssql",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    const stmt = r.statements[0];
    expect(stmt).not.toMatch(/\?/);
    expect(stmt).toContain("[t]");
    expect(stmt).toContain("[name]");
    expect(stmt).toContain("[id]");
    expect(stmt).toContain("'z'");
    expect(stmt).toContain("9");
  });

  it("postgres no-PK ctid path: WHERE ctid = '<ctid literal>' (no $N)", () => {
    const edits: EditEntry[] = [{ rowId: 1, colIndex: 0, value: "edited" }];
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
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expect(stmt).not.toMatch(/\$\d+/);
    expect(stmt).not.toMatch(/\?/);
    expect(stmt).toMatch(/ctid='\(0,1\)'/);
  });

  it("INSERT marker produces inline VALUES list (no $N, no ?)", () => {
    const marker: EditEntry = {
      rowId: 5,
      colIndex: 0,
      value: { __vsdb_new_row__: true, __rowId: 5, values: ["Alice", 30] },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["name", "age"],
      [marker],
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).not.toMatch(/\$\d+/);
    expect(r.statements[0]).toContain(`'Alice'`);
    expect(r.statements[0]).toContain(`30`);
  });

  it("DELETE marker uses inline literal WHERE", () => {
    const marker: EditEntry = {
      rowId: 0,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 0 },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      [marker],
      [[42, "old"]],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).not.toMatch(/\$\d+/);
    expect(r.statements[0]).toContain('DELETE FROM "t" WHERE "id"=42');
  });
});
