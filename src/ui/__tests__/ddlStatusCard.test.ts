// src/ui/__tests__/ddlStatusCard.test.ts
// TASK-UX1-010 — pure-helper tests for the DDL/DML status card contract.
//
// The webview/main.ts state-tab logic routes through two small pure helpers
// exported from `src/ui/ddlStatusCard.ts`:
//   - `classifyPanelKind(r)` — "grid" for SELECT / no-kind (legacy / pending),
//     "card" for everything else (DDL/DML/other).
//   - `buildDdlCardText({ r, statementCount, statementIndex })` — pure builder
//     producing the title / meta / errorText / hint the card DOM reads.
//
// Cases covered (per TASK-UX1-010 §Test Cases):
//   1. CREATE FUNCTION success → "card" (NOT "grid")
//   2. SELECT → "grid" (byte-identical to today)
//   3. empty DML (UPDATE 0) → "card" success variant
//   4. failure pinpoints: cardText preserves error verbatim + hint
//   7. multi-statement mixed run → per-statement classify
//   8. reconstructions carry `kind` through (mirror StatementResult)
//
// Run: `npx vitest run src/ui/__tests__/ddlStatusCard.test.ts`
import { describe, it, expect } from "vitest";
import {
  classifyPanelKind,
  buildDdlCardText,
  type StatementResultLike,
} from "../ddlStatusCard";

// =============================================================================
// Case 1 — CREATE FUNCTION success renders card, no grid
// =============================================================================
describe("classifyPanelKind — case 1 (CREATE FUNCTION success)", () => {
  it("DDL success statement is 'card', not 'grid'", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "CREATE OR REPLACE FUNCTION app.fn_create_plan(...) ...",
      status: "done",
      result: {
        columns: [],
        rows: [],
        rowCount: null,
        commandTag: "CREATE FUNCTION",
        durationMs: 1,
      },
      durationMs: 1,
      kind: "ddl",
    };
    expect(classifyPanelKind(r)).toBe("card");
  });
});

// =============================================================================
// Case 2 — SELECT still renders a grid (byte-identical)
// =============================================================================
describe("classifyPanelKind — case 2 (SELECT)", () => {
  it("SELECT kind='select' routes to 'grid'", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "SELECT * FROM t",
      status: "done",
      result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 1 },
      durationMs: 1,
      kind: "select",
    };
    expect(classifyPanelKind(r)).toBe("grid");
  });

  it("legacy entry with no kind field routes to 'grid' (BQ-pending safe)", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "",
      status: "running",
      durationMs: 0,
    };
    expect(classifyPanelKind(r)).toBe("grid");
  });
});

// =============================================================================
// Case 3 — empty DML (UPDATE 0)
// =============================================================================
describe("buildDdlCardText — case 3 (empty DML UPDATE 0)", () => {
  it("renders success variant with commandTag and no error node", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "UPDATE t SET x=1",
      status: "done",
      result: {
        columns: [],
        rows: [],
        rowCount: 0,
        commandTag: "UPDATE 0",
        durationMs: 1,
      },
      durationMs: 7,
      kind: "dml",
    };
    const card = buildDdlCardText({ r, statementCount: 1, statementIndex: 0 });
    expect(card.variant).toBe("success");
    expect(card.title).toContain("UPDATE 0");
    expect(card.title).toContain("DML");
    expect(card.meta).toContain("7ms");
    expect(card.hasError).toBe(false);
    expect(card.errorText).toBeUndefined();
  });
});

// =============================================================================
// Case 4 — failure pinpoints (error verbatim + hint)
// =============================================================================
describe("buildDdlCardText — case 4 (DDL failure, error verbatim + hint)", () => {
  it("preserves error verbatim and includes LINE N hint", () => {
    const errorText = 'syntax error at or near "SELEC"\nLINE 3: SELEC ...';
    const r: StatementResultLike = {
      index: 0,
      sql: "CREATE OR REPLACE FUNCTION app.fn()\nRETURNS void\nSELEC ...",
      status: "error",
      error: errorText,
      durationMs: 3,
      kind: "ddl",
    };
    const card = buildDdlCardText({ r, statementCount: 2, statementIndex: 0 });
    expect(card.variant).toBe("error");
    // byte-identical preservation
    expect(card.errorText).toBe(errorText);
    // hint contains LINE 3 and the index-in-run context.
    expect(card.hint).toBeDefined();
    expect(card.hint).toContain("LINE 3");
    expect(card.meta).toContain("statement 1 of 2");
  });

  it("renders card even when no commandTag is set", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "broken",
      status: "error",
      error: 'syntax error at or near "broken"\nLINE 1: broken',
      durationMs: 1,
      kind: "ddl",
    };
    const card = buildDdlCardText({ r, statementCount: 1, statementIndex: 0 });
    expect(card.variant).toBe("error");
    expect(card.title).toContain("DDL");
    expect(card.errorText).toBe(r.error);
    expect(card.hint).toContain("LINE 1");
  });
});

// =============================================================================
// Case 7 — multi-statement mixed run: per-statement classification
// =============================================================================
describe("classifyPanelKind — case 7 (mixed multi-statement run)", () => {
  it("DDL statement routes to card; SELECT statement routes to grid", () => {
    const ddl: StatementResultLike = {
      index: 0,
      sql: "CREATE TABLE a (id int)",
      status: "done",
      result: { columns: [], rows: [], rowCount: null, commandTag: "CREATE TABLE", durationMs: 1 },
      durationMs: 1,
      kind: "ddl",
    };
    const select: StatementResultLike = {
      index: 1,
      sql: "SELECT 1",
      status: "done",
      result: { columns: ["n"], rows: [[1]], rowCount: 1, durationMs: 1 },
      durationMs: 1,
      kind: "select",
    };
    expect(classifyPanelKind(ddl)).toBe("card");
    expect(classifyPanelKind(select)).toBe("grid");
  });
});

// =============================================================================
// Case 8 — reconstructions carry `kind` through (mirror StatementResult)
// =============================================================================
describe("StatementResult mirror — case 8 (kind reconstruction)", () => {
  it("spread of mirror StatementResult preserves kind", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "CREATE TABLE a (id int)",
      status: "done",
      durationMs: 1,
      kind: "ddl",
    };
    // Mirror the rest-spread pattern from resultsPanel.ts:696.
    const { kind, ...rest } = r;
    const rebuilt: StatementResultLike = { ...rest, kind };
    expect(rebuilt.kind).toBe("ddl");
    expect(rebuilt.sql).toBe("CREATE TABLE a (id int)");
    expect(rebuilt.status).toBe("done");
  });

  it("spread without `kind` field present stays undefined (BQ-pending safe)", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "",
      status: "running",
      durationMs: 0,
      // no kind set — pending BQ shape
    };
    const { kind, ...rest } = r;
    expect(kind).toBeUndefined();
    const rebuilt: StatementResultLike = { ...rest, kind };
    expect(rebuilt.kind).toBeUndefined();
    expect(classifyPanelKind(rebuilt)).toBe("grid");
  });
});

// =============================================================================
// Card contract — duration / commandTag are surfaced in success card
// =============================================================================
describe("buildDdlCardText — success card text", () => {
  it("includes CREATE FUNCTION and duration when present", () => {
    const r: StatementResultLike = {
      index: 0,
      sql: "CREATE OR REPLACE FUNCTION app.fn(x int) RETURNS int AS $$ BEGIN return x; END; $$ LANGUAGE plpgsql",
      status: "done",
      result: {
        columns: [],
        rows: [],
        rowCount: null,
        commandTag: "CREATE FUNCTION",
        durationMs: 1,
      },
      durationMs: 12,
      kind: "ddl",
    };
    const card = buildDdlCardText({ r, statementCount: 1, statementIndex: 0 });
    expect(card.title).toContain("CREATE FUNCTION");
    expect(card.meta).toContain("12ms");
    expect(card.variant).toBe("success");
    expect(card.hasError).toBe(false);
  });
});