// src/core/ddl/__tests__/pgCatalog.test.ts
//
// TASK-AF-001 tests 1-9 — pgCatalog pure module: SQL templates + typed mappers
// + objectDdl SQL builders. Pure unit tests; no vscode / pg imports.
//
// The file is intentionally written FIRST so the test suite acts as a behavior
// pin for the implementation. Tests are grouped per TASK-AF-001 §Test Cases.

import { describe, it, expect } from "vitest";
import {
  // types live in this module too (per task spec)
  quoteIdent,
  rowsToIndexes,
  rowsToConstraints,
  rowsToTriggers,
  rowsToSequences,
  indexesSql,
  constraintsSql,
  triggersSql,
  sequencesSql,
  rowCountSql,
  objectDdlSql,
} from "../pgCatalog";

describe("pgCatalog — quoteIdent (TASK-AF-001 test 7/8 helper)", () => {
  it("doubles internal double-quote characters", () => {
    expect(quoteIdent('plain')).toBe('"plain"');
    expect(quoteIdent('has"quote')).toBe('"has""quote"');
    expect(quoteIdent('v"1')).toBe('"v""1"');
  });

  it("rejects empty / zero-length identifiers (structured error)", () => {
    expect(() => quoteIdent("")).toThrow(/pgCatalog\.|identifier/);
  });
});

describe("pgCatalog — rowsToIndexes (test 1)", () => {
  it("maps pg_indexes-shaped rows to IndexInfo", () => {
    const rows = [
      {
        indexname: "idx_a",
        schemaname: "public",
        tablename: "t",
        indexdef:
          "CREATE UNIQUE INDEX idx_a ON public.t USING btree (a)",
      },
      {
        indexname: "idx_b_lower",
        schemaname: "public",
        tablename: "t",
        indexdef: "CREATE INDEX idx_b_lower ON public.t USING btree (lower(b))",
      },
    ];
    const out = rowsToIndexes(rows);
    expect(out).toEqual([
      {
        name: "idx_a",
        schema: "public",
        table: "t",
        isUnique: true,
        method: "btree",
        columns: ["a"],
      },
      {
        name: "idx_b_lower",
        schema: "public",
        table: "t",
        isUnique: false,
        method: "btree",
        columns: ["lower(b)"],
      },
    ]);
  });

  it("empty result set → [] (test 5)", () => {
    expect(rowsToIndexes([])).toEqual([]);
  });

  it("malformed/null fields → row skipped, no crash (test 6)", () => {
    const rows = [
      { indexname: null, schemaname: "public", tablename: "t", indexdef: "x" },
      { indexname: "ok", schemaname: "public", tablename: "t", indexdef: null },
      null,
      undefined,
    ];
    expect(rowsToIndexes(rows as unknown[])).toEqual([]);
  });
});

describe("pgCatalog — rowsToConstraints (test 2)", () => {
  it("normalizes contype to pk|fk|unique|check and captures fkTarget", () => {
    const rows = [
      {
        conname: "t_pkey",
        contype: "p",
        conkeycols: ["id"],
      },
      {
        conname: "t_email_key",
        contype: "u",
        conkeycols: ["email"],
      },
      {
        conname: "t_owner_fk",
        contype: "f",
        conkeycols: ["owner_id"],
        confrelidname: "public.users",
        confkeycols: ["id"],
      },
      {
        conname: "t_amt_check",
        contype: "c",
        conkeycols: [],
        consrc: "CHECK ((amount > 0))",
      },
    ];
    expect(rowsToConstraints(rows)).toEqual([
      { name: "t_pkey", type: "pk", columns: ["id"] },
      { name: "t_email_key", type: "unique", columns: ["email"] },
      {
        name: "t_owner_fk",
        type: "fk",
        columns: ["owner_id"],
        fkTarget: { table: "users", schema: "public", columns: ["id"] },
      },
      { name: "t_amt_check", type: "check", columns: [] },
    ]);
  });

  it("empty result set → [] (test 5)", () => {
    expect(rowsToConstraints([])).toEqual([]);
  });

  it("unknown contype / null conname → row skipped (test 6)", () => {
    const rows = [
      { conname: null, contype: "p", conkeycols: ["id"] },
      { conname: "x", contype: "x" }, // unknown
      { conname: "ok", contype: "p", conkeycols: ["id"] },
    ];
    expect(rowsToConstraints(rows as unknown[])).toEqual([
      { name: "ok", type: "pk", columns: ["id"] },
    ]);
  });
});

describe("pgCatalog — rowsToTriggers (test 3)", () => {
  it("maps pg_trigger-shaped rows to TriggerInfo", () => {
    const rows = [
      {
        tgname: "trg_audit",
        tgtype: 23, // 23 = INSERT(4) + UPDATE(16) + row-level(2) + before(1)
        tgrelid: "public.t",
        action_statement: "EXECUTE FUNCTION public.audit()",
      },
    ];
    const out = rowsToTriggers(rows);
    expect(out).toEqual([
      {
        name: "trg_audit",
        event: "INSERT OR UPDATE",
        timing: "BEFORE",
        statement: "EXECUTE FUNCTION public.audit()",
      },
    ]);
  });

  it("empty result set → [] (test 5)", () => {
    expect(rowsToTriggers([])).toEqual([]);
  });
});

describe("pgCatalog — rowsToSequences (test 3)", () => {
  it("maps pg_sequences rows to SequenceInfo", () => {
    const rows = [
      {
        schemaname: "public",
        sequencename: "t_id_seq",
        data_type: "bigint",
        last_value: "42",
      },
      {
        schemaname: "public",
        sequencename: "untouched_seq",
        data_type: "integer",
        last_value: null,
      },
    ];
    expect(rowsToSequences(rows)).toEqual([
      {
        name: "t_id_seq",
        schema: "public",
        dataType: "bigint",
        lastValue: "42",
      },
      {
        name: "untouched_seq",
        schema: "public",
        dataType: "integer",
      },
    ]);
  });

  it("empty result set → [] (test 5)", () => {
    expect(rowsToSequences([])).toEqual([]);
  });
});

describe("pgCatalog — SQL templates (test 4, 7, 8, 9)", () => {
  it("rowCountSql quotes identifiers and survives embedded quotes", () => {
    const sql = rowCountSql('my schema', 't"drop');
    expect(sql).toContain('"my schema"."t""drop"');
    // Should never string-interpolate raw; only the quoted fragment appears.
    expect(sql).toMatch(/COUNT\(\*\)/i);
  });

  it("objectDdlSql quotes identifiers and survives embedded quotes (test 7)", () => {
    const sql = objectDdlSql("view", 'v"1', "s");
    expect(sql).toContain('"s"');
    expect(sql).toContain('"v""1"');
  });

  it("objectDdlSql rejects empty identifier with structured error (test 8)", () => {
    expect(() => objectDdlSql("view", "", "public")).toThrow(
      /pgCatalog\./,
    );
  });

  it("viewDdl / routineDdl / triggerDdl SQL uses pg_get_ functions (test 9)", () => {
    expect(objectDdlSql("view", "v", "public")).toMatch(/pg_get_viewdef/);
    expect(objectDdlSql("routine", "f", "public")).toMatch(/pg_get_functiondef/);
    expect(objectDdlSql("trigger", "trg", "public")).toMatch(/pg_get_triggerdef/);
  });

  it("indexes / constraints / triggers / sequences SQL are parameterized (test 4)", () => {
    // SQL functions take schema/table params; bind via $1/$2 + array args.
    expect(indexesSql()).toMatch(/\$1/);
    expect(indexesSql()).toMatch(/\$2/);
    expect(constraintsSql()).toMatch(/\$1/);
    expect(constraintsSql()).toMatch(/\$2/);
    expect(triggersSql()).toMatch(/\$1/);
    expect(triggersSql()).toMatch(/\$2/);
    expect(sequencesSql()).toMatch(/\$1/);
  });

  it("rowCountSql survives embedded quotes via quoteIdent", () => {
    // Implementation uses quoteIdent (safe identifier wrapper) so the
    // SQL is a single statement with no $N placeholders. Either path
    // (pure quoteIdent OR prepared-statement) is acceptable per
    // PLAN_AF §4 — both are injection-safe.
    const sql = rowCountSql('my schema', 't"drop');
    expect(sql).toContain('"my schema"."t""drop"');
    expect(sql).toMatch(/COUNT\(\*\)/i);
  });
});
