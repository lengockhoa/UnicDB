// src/core/importer/__tests__/importCsv.test.ts
// DBX-01-001 — pure CSV parser contract. RED until importCsv.ts lands.

import { describe, it, expect } from "vitest";
import { parseCsv } from "../importCsv";

describe("parseCsv — basic", () => {
  it("parses simple comma CSV", () => {
    const r = parseCsv("id,name\n1,Ann\n2,Bob");
    expect(r.headers).toEqual(["id", "name"]);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((row) => row.join("|"))).toEqual(["1|Ann", "2|Bob"]);
  });

  it("parses quoted fields with embedded comma", () => {
    const r = parseCsv('id,name\n1,"Doe, Jane"');
    expect(r.rows[0]?.[1]).toBe("Doe, Jane");
    expect(r.errors).toEqual([]);
  });

  it("handles escaped quotes inside quotes", () => {
    const r = parseCsv('name\n"He said ""hi"""');
    expect(r.rows[0]?.[0]).toBe('He said "hi"');
    expect(r.errors).toEqual([]);
  });

  it("keeps embedded newline inside a quoted field as a single cell", () => {
    const r = parseCsv('name\n"line1\nline2"');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.[0]).toBe("line1\nline2");
    expect(r.errors).toEqual([]);
  });
});

describe("parseCsv — edge cases", () => {
  it("strips UTF-8 BOM from the first header", () => {
    const r = parseCsv("\uFEFFid,name\n1,A");
    expect(r.headers[0]).toBe("id");
    expect(r.errors).toEqual([]);
  });

  it("accepts mixed CRLF and LF line endings", () => {
    const r = parseCsv("a,b\r\n1,2\n3,4");
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]).toEqual(["1", "2"]);
    expect(r.rows[1]).toEqual(["3", "4"]);
  });

  it("returns an empty error for an empty file (loud, not silent success)", () => {
    const r = parseCsv("");
    expect(r.headers).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.message.toLowerCase()).toContain("empty");
  });

  it("parses a single-column CSV", () => {
    const r = parseCsv("x\n1\n2\n3");
    expect(r.headers).toEqual(["x"]);
    expect(r.rows.length).toBe(3);
    expect(r.errors).toEqual([]);
  });

  it("does not synthesize a trailing empty row when input ends with a newline", () => {
    const r = parseCsv("a\n1\n");
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toEqual(["1"]);
  });

  it("records a per-row error for a ragged row (column count mismatch)", () => {
    const r = parseCsv("a,b\n1,2\n3");
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.line).toBe(3);
    // Row 3 is excluded from the parsed set.
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toEqual(["1", "2"]);
  });
});
