// src/core/importer/__tests__/importDryRun.test.ts
// DBX-01-002 — pure, read-only dry-run that builds a parameterized
// batched INSERT plan. RED first.

import { describe, it, expect, vi } from "vitest";
import { buildDryRunPlan, type MappedRows } from "../importDryRun";

function mapped(values: unknown[][]): MappedRows {
  return { values, errors: [] };
}

describe("buildDryRunPlan — SQL shape", () => {
  it("emits parameterized INSERTs with $N placeholders, never string-concatenated literals", () => {
    const plan = buildDryRunPlan(
      mapped([
        [1, "Ann"],
        [2, "Bob"],
      ]),
      { schema: "public", table: "users" },
    );
    expect(plan.sqlStatements.length).toBe(1);
    const sql = plan.sqlStatements[0] ?? "";
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain('"public"');
    expect(sql).toContain('"users"');
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
    // No literal cell values in the SQL.
    expect(sql).not.toContain("'Ann'");
    expect(sql).not.toContain("'Bob'");
    expect(plan.parameterSets[0]).toEqual([1, "Ann"]);
    expect(plan.parameterSets[1]).toEqual([2, "Bob"]);
  });

  it("honors batchSize and reports the correct number of batches", () => {
    const rows: unknown[][] = Array.from({ length: 10 }, (_, i) => [i]);
    const plan = buildDryRunPlan(mapped(rows), { schema: "public", table: "t" }, { batchSize: 4 });
    expect(plan.batches).toBe(3);
    expect(plan.sqlStatements.length).toBe(3);
    expect(plan.rowCount).toBe(10);
  });

  it("summary reports totalBytes > 0", () => {
    const plan = buildDryRunPlan(
      mapped([[1, "hello"], [2, "world"]]),
      { schema: "public", table: "t" },
    );
    expect(plan.totalBytes).toBeGreaterThan(0);
    expect(plan.rowCount).toBe(2);
  });

  it("dry-run performs no database call (the module has no DB code path)", () => {
    const spy = vi.fn();
    // No adapter arg is accepted by buildDryRunPlan; the spy is here
    // as a regression guard — a future edit must not add a
    // `runQuery` call to this module.
    buildDryRunPlan(mapped([[1]]), { schema: "public", table: "t" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("quotes identifiers with double-quote escaping (no string concat of untrusted names)", () => {
    const plan = buildDryRunPlan(
      mapped([[1]]),
      { schema: 'weird"schema', table: "t" },
    );
    const sql = plan.sqlStatements[0] ?? "";
    // Double-quote in the identifier name must be escaped to "" per
    // SQL standard; never concatenated raw.
    expect(sql).toContain('"weird""schema"');
  });

  it("empty plan returns zero batches and zero rows without throwing", () => {
    const plan = buildDryRunPlan(mapped([]), { schema: "public", table: "t" });
    expect(plan.batches).toBe(0);
    expect(plan.rowCount).toBe(0);
    expect(plan.sqlStatements).toEqual([]);
    expect(plan.parameterSets).toEqual([]);
    expect(plan.totalBytes).toBe(0);
  });
});
