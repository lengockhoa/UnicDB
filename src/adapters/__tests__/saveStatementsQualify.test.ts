// src/adapters/__tests__/saveStatementsQualify.test.ts
//
// TASK-001 — schema qualification (A8), PG identifier quoting (A9),
// DEFAULT-value INSERT handling (A11), row-addressing remap (A12).
//
// New file — RED until buildSaveStatements/quoteIdent are extended per
// docs/AI_HANDOFF/tasks/TASK-001.md.
import { describe, it, expect } from "vitest";
import {
  buildSaveStatements,
  quoteIdent,
  isDefaultValueMarker,
  type EditEntry,
} from "../../core/saveStatements";

// ---- A8: schema qualification ---------------------------------------------

describe("buildSaveStatements — schema qualification (A8)", () => {
  it("qualified UPDATE: options.schema present ⇒ \"schema\".\"table\"", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "new-b" }];
    const serverRows: unknown[][] = [[1, "old-b"]];
    const r = buildSaveStatements(
      "postgres",
      "orders",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
      { schema: "analytics" },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/^UPDATE\s+"analytics"\."orders"\s+SET/);
  });

  it("unqualified UPDATE unchanged: no schema ⇒ no leading dot", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "new-b" }];
    const serverRows: unknown[][] = [[1, "old-b"]];
    const r = buildSaveStatements(
      "postgres",
      "orders",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toMatch(/^UPDATE\s+"orders"\s+SET/);
    expect(r.statements[0]).not.toMatch(/^UPDATE\s+"\."/);
  });

  it("R (A8): analytics.orders — today emits UPDATE orders; after fix UPDATE \"analytics\".\"orders\"", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [[1, "y"]];
    const r = buildSaveStatements(
      "postgres",
      "orders",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
      { schema: "analytics" },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toContain('"analytics"."orders"');
    expect(r.statements[0]).not.toBe("UPDATE orders SET name='x' WHERE id=1");
  });
});

// ---- A9: PG identifier quoting --------------------------------------------

describe("quoteIdent — postgres now quotes (A9)", () => {
  it("mixed case: quoteIdent('createdAt','postgres') → '\"createdAt\"'", () => {
    expect(quoteIdent("createdAt", "postgres")).toBe('"createdAt"');
  });

  it("embedded double quote is escaped by doubling", () => {
    expect(quoteIdent('a"b', "postgres")).toBe('"a""b"');
  });

  it("R (A9): table Users — today emits UPDATE Users; after fix UPDATE \"Users\"", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [[1, "y"]];
    const r = buildSaveStatements(
      "postgres",
      "Users",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toMatch(/^UPDATE\s+"Users"\s+SET/);
    expect(r.statements[0]).not.toBe("UPDATE Users SET name='x' WHERE id=1");
  });

  it("spaced / non-ASCII identifiers are quoted, not refused (isSafeIdent relaxed)", () => {
    const edits: EditEntry[] = [{ rowId: 0, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [[1, "y"]];
    const r = buildSaveStatements(
      "postgres",
      "my table",
      ["id"],
      ["id", "café"],
      edits,
      serverRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toContain('"my table"');
    expect(r.statements[0]).toContain('"café"');
  });
});

// ---- A11: DEFAULT-value INSERT ---------------------------------------------

describe("buildSaveStatements — DEFAULT-value INSERT (A11)", () => {
  it("all-DEFAULT insert ⇒ exactly INSERT INTO \"public\".\"t\" DEFAULT VALUES", () => {
    const marker: EditEntry = {
      rowId: 5,
      colIndex: 0,
      value: {
        __vsdb_new_row__: true,
        __rowId: 5,
        values: [
          { __vsdb_default__: true },
          { __vsdb_default__: true },
        ],
      },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["a", "b"],
      [marker],
      [],
      { schema: "public" },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toBe('INSERT INTO "public"."t" DEFAULT VALUES');
  });

  it("partial-DEFAULT insert ⇒ column list has 2 entries, defaulted col absent", () => {
    const marker: EditEntry = {
      rowId: 6,
      colIndex: 0,
      value: {
        __vsdb_new_row__: true,
        __rowId: 6,
        values: ["alice", { __vsdb_default__: true }, 30],
      },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["name", "created_at", "age"],
      [marker],
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    const stmt = r.statements[0];
    expect(stmt).toMatch(/^INSERT INTO "t" \("name", "age"\) VALUES \('alice', 30\)/);
    expect(stmt).not.toContain("created_at");
  });

  it("isDefaultValueMarker recognises the sentinel shape only", () => {
    expect(isDefaultValueMarker({ __vsdb_default__: true })).toBe(true);
    expect(isDefaultValueMarker({ __vsdb_default__: false })).toBe(false);
    expect(isDefaultValueMarker("")).toBe(false);
    expect(isDefaultValueMarker(null)).toBe(false);
  });

  it("R (A11): blank new-row cell — today INSERT ... VALUES (''); after fix column omitted", () => {
    const marker: EditEntry = {
      rowId: 1,
      colIndex: 0,
      value: {
        __vsdb_new_row__: true,
        __rowId: 1,
        values: [{ __vsdb_default__: true }],
      },
    };
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["qty"],
      [marker],
      [],
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).not.toContain("VALUES ('')");
    expect(r.statements[0]).toBe('INSERT INTO "t" DEFAULT VALUES');
  });
});

// ---- A12: row-addressing remap ---------------------------------------------

describe("buildSaveStatements — serverIndexByRowId remap (A12)", () => {
  it("remapped row: serverIndexByRowId = Map([[4,3]]) ⇒ WHERE built from serverRows[3]", () => {
    const edits: EditEntry[] = [{ rowId: 4, colIndex: 1, value: "new-name" }];
    const serverRows: unknown[][] = [
      [10, "row0"],
      [11, "row1"],
      [12, "row2"],
      [13, "row3"], // the actual server row for rowId 4, per remap
      [14, "row4"], // serverRows[4] — WRONG record if remap is ignored
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
      { serverIndexByRowId: new Map([[4, 3]]) },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]).toMatch(/WHERE\s+"id"=13/);
  });

  it("R (A12): rowId 4 / serverIndex 3 — today WHERE from serverRows[4]; after fix serverRows[3]", () => {
    const edits: EditEntry[] = [{ rowId: 4, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"],
      [999, "wrong-record"],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
      { serverIndexByRowId: new Map([[4, 3]]) },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toContain("WHERE \"id\"=3");
    expect(r.statements[0]).not.toContain("999");
  });

  it("absent option ⇒ byte-identical output to today's identity mapping (back-compat)", () => {
    const edits: EditEntry[] = [{ rowId: 1, colIndex: 1, value: "x" }];
    const serverRows: unknown[][] = [
      [0, "a"],
      [1, "b"],
    ];
    const withOpt = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
    );
    const withEmptyMap = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      edits,
      serverRows,
      { serverIndexByRowId: new Map() },
    );
    expect(withOpt.ok).toBe(true);
    expect(withEmptyMap.ok).toBe(true);
    if (withOpt.ok !== true || withEmptyMap.ok !== true) return;
    expect(withOpt.statements).toEqual(withEmptyMap.statements);
  });

  it("remap applies to the DELETE branch too", () => {
    const marker: EditEntry = {
      rowId: 4,
      colIndex: 0,
      value: { __vsdb_deleted__: true, __rowId: 4 },
    };
    const serverRows: unknown[][] = [
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"], // real target
      [999, "wrong"],
    ];
    const r = buildSaveStatements(
      "postgres",
      "t",
      ["id"],
      ["id", "name"],
      [marker],
      serverRows,
      { serverIndexByRowId: new Map([[4, 3]]) },
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.statements[0]).toContain("WHERE \"id\"=3");
    expect(r.statements[0]).not.toContain("999");
  });
});

// ---- negative marker colIndex must never index columns[] -------------------

describe("buildSaveStatements — negative marker colIndex never reaches columns[]", () => {
  it("marker at colIndex:-1 (MARKER_COL_INSERT) never produces 'skipped unknown col index'; no columns[-1] read", () => {
    const marker: EditEntry = {
      rowId: 9,
      colIndex: -1,
      value: {
        __vsdb_new_row__: true,
        __rowId: 9,
        values: ["a", "b"],
      },
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
    expect(
      r.warnings.some((w) => w.includes("skipped unknown col index")),
    ).toBe(false);
  });
});
