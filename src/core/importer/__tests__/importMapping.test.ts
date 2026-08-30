// src/core/importer/__tests__/importMapping.test.ts
// DBX-01-002 — column mapping + opt-in type coercion. RED first.

import { describe, it, expect } from "vitest";
import type { ImportParseResult } from "../importTypes";
import { applyMapping, type ColumnMapping } from "../importMapping";

function parse(headers: string[], rows: string[][]): ImportParseResult {
  return { headers, rows, errors: [] };
}

describe("applyMapping — happy paths", () => {
  it("renames a source column to a target column and drops unmapped sources", () => {
    const r = applyMapping(
      parse(["a", "b"], [["1", "x"], ["2", "y"]]),
      [{ source: "a", target: "id", type: "int" }],
      ["id"],
    );
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual([[1], [2]]);
  });

  it("keeps a source column when the user maps it (drops truly-unmapped ones)", () => {
    const r = applyMapping(
      parse(["a", "b", "c"], [["1", "raw", "extra"]]),
      [
        { source: "a", target: "id", type: "int" },
        { source: "b", target: "label", type: "text" },
      ],
      ["id", "label"],
    );
    expect(r.values[0]?.[0]).toBe(1);
    expect(r.values[0]?.[1]).toBe("raw");
  });

  it("int coercion: '42' -> 42", () => {
    const r = applyMapping(
      parse(["n"], [["42"]]),
      [{ source: "n", target: "n", type: "int" }],
      ["n"],
    );
    expect(r.values[0]?.[0]).toBe(42);
  });

  it("numeric coercion: '3.14' -> 3.14", () => {
    const r = applyMapping(
      parse(["v"], [["3.14"]]),
      [{ source: "v", target: "v", type: "numeric" }],
      ["v"],
    );
    expect(r.values[0]?.[0]).toBe(3.14);
  });

  it("bool coercion accepts true/false/1/0 case-insensitive", () => {
    const r = applyMapping(
      parse(["f"], [["TRUE"], ["False"], ["1"], ["0"]]),
      [{ source: "f", target: "f", type: "bool" }],
      ["f"],
    );
    expect(r.values.map((row) => row[0])).toEqual([true, false, true, false]);
  });

  it("timestamp coercion: ISO string passes through", () => {
    const r = applyMapping(
      parse(["t"], [["2026-08-30T00:00:00Z"]]),
      [{ source: "t", target: "t", type: "timestamp" }],
      ["t"],
    );
    expect(typeof r.values[0]?.[0]).toBe("string");
    expect(r.values[0]?.[0]).toBe("2026-08-30T00:00:00Z");
  });

  it("json coercion validates JSON.parse on the cell", () => {
    const r = applyMapping(
      parse(["j"], [[`{"a":1}`]]),
      [{ source: "j", target: "j", type: "json" }],
      ["j"],
    );
    expect(r.values[0]?.[0]).toEqual({ a: 1 });
  });
});

describe("applyMapping — error paths", () => {
  it("coercion failure produces a column-named error and drops the row", () => {
    const r = applyMapping(
      parse(["n", "m"], [["abc", "ok"], ["1", "ok2"]]),
      [
        { source: "n", target: "n", type: "int" },
        { source: "m", target: "m", type: "text" },
      ],
      ["n", "m"],
    );
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.column).toBe("n");
    expect(r.values.length).toBe(1);
    expect(r.values[0]?.[0]).toBe(1);
  });

  it("mapping references a source column missing from the parse result", () => {
    const r = applyMapping(
      parse(["a", "b"], [["1", "x"]]),
      [{ source: "c", target: "id", type: "int" }],
      ["id"],
    );
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.column).toBe("c");
  });

  it("required target column unmapped → fatal error", () => {
    const r = applyMapping(
      parse(["a", "b"], [["1", "x"]]),
      [],
      ["required_id", "b"],
    );
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.message.toLowerCase()).toContain("required");
  });
});
