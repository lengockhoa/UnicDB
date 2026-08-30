// src/core/importer/__tests__/importJson.test.ts
// DBX-01-001 — pure JSON parser contract. RED until importJson.ts lands.

import { describe, it, expect } from "vitest";
import { parseJson } from "../importJson";

describe("parseJson — basic shapes", () => {
  it("parses an array of objects and aligns rows by header order", () => {
    const r = parseJson('[{"id":1,"name":"Ann"},{"id":2,"name":"Bob"}]');
    expect(r.headers).toEqual(["id", "name"]);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toEqual(["1", "Ann"]);
    expect(r.rows[1]).toEqual(["2", "Bob"]);
  });

  it("parses NDJSON (one object per line)", () => {
    const r = parseJson('{"id":1}\n{"id":2}');
    expect(r.headers).toEqual(["id"]);
    expect(r.rows[0]?.[0]).toBe("1");
    expect(r.rows[1]?.[0]).toBe("2");
    expect(r.errors).toEqual([]);
  });

  it("preserves explicit JSON nulls (distinct from empty string)", () => {
    const r = parseJson('[{"id":1,"note":null}]');
    expect(r.rows[0]?.[1]).toBeNull();
  });
});

describe("parseJson — rejections", () => {
  it("rejects a primitive root loudly", () => {
    const r = parseJson("42");
    expect(r.rows).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.message.toLowerCase()).toMatch(/root|primitive/);
  });

  it("rejects top-level null or empty array with an error", () => {
    const nullR = parseJson("null");
    expect(nullR.errors.length).toBe(1);
    expect(nullR.rows).toEqual([]);

    const emptyR = parseJson("[]");
    expect(emptyR.errors.length).toBe(1);
    expect(emptyR.rows).toEqual([]);
  });

  it("rejects deeply-nested object values with a column-named error", () => {
    const r = parseJson('[{"a":{"b":{"c":1}}}]');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.column).toBe("a");
    expect(r.rows).toEqual([]);
  });

  it("rejects mixed NDJSON + array wrapper as ambiguous", () => {
    const r = parseJson('[{"id":1}]\n{"id":2}');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.message.toLowerCase()).toMatch(/ambig|mixed/);
  });
});
