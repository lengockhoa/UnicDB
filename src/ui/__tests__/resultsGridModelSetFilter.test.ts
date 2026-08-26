// src/ui/__tests__/resultsGridModelSetFilter.test.ts
// Pure-logic tests for the Excel-style set-filter helpers in resultsGridModel.
// No DOM, no AG Grid, no vscode — must run in plain vitest node environment.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildSetFilterEntries,
  setFilterPass,
  selectedKeysFromModel,
  type SetFilterEntry,
} from "../resultsGridModel";

describe("buildSetFilterEntries — groups + counts + sort", () => {
  it("groups case-insensitively, first-seen casing for display, (Blanks) last", () => {
    const entries = buildSetFilterEntries(["BUMD", "bumd", "BUMN", null]);
    expect(entries).toEqual([
      { key: "bumd", display: "BUMD", count: 2 },
      { key: "bumn", display: "BUMN", count: 1 },
      { key: "(blanks)", display: "(Blanks)", count: 1 },
    ]);
  });

  it("merges null, undefined, empty, and whitespace-only strings into one (Blanks) entry", () => {
    const entries = buildSetFilterEntries([null, undefined, "", "  ", "\t", "x"]);
    expect(entries).toEqual([
      { key: "x", display: "x", count: 1 },
      { key: "(blanks)", display: "(Blanks)", count: 5 },
    ]);
  });

  it("whitespace joins one blanks entry pinned last", () => {
    const entries = buildSetFilterEntries([null, "", "  ", "x"]);
    expect(entries).toEqual([
      { key: "x", display: "x", count: 1 },
      { key: "(blanks)", display: "(Blanks)", count: 3 },
    ]);
    expect(setFilterPass("\t", new Set(["(blanks)"]))).toBe(true);
  });

  it("groups number values by their string form", () => {
    const entries = buildSetFilterEntries([1, 1, 2.5]);
    expect(entries).toEqual([
      { key: "1", display: "1", count: 2 },
      { key: "2.5", display: "2.5", count: 1 },
    ]);
  });
});

describe("setFilterPass — membership predicate", () => {
  it("matches case-insensitively against the selected key", () => {
    expect(setFilterPass("BUMD", new Set(["bumd"]))).toBe(true);
  });

  it("matches (blanks) key for null/undefined/empty values", () => {
    expect(setFilterPass(null, new Set(["(blanks)"]))).toBe(true);
    expect(setFilterPass(undefined, new Set(["(blanks)"]))).toBe(true);
    expect(setFilterPass("", new Set(["(blanks)"]))).toBe(true);
  });

  it("returns false when selected key does not match", () => {
    expect(setFilterPass(null, new Set(["bumd"]))).toBe(false);
    expect(setFilterPass("x", new Set(["bumd"]))).toBe(false);
  });

  it("returns true for null selected (filter inactive → pass all)", () => {
    expect(setFilterPass("x", null)).toBe(true);
    expect(setFilterPass(null, null)).toBe(true);
    expect(setFilterPass(42, null)).toBe(true);
  });
});

describe("selectedKeysFromModel — display→key round-trip", () => {
  const entries: SetFilterEntry[] = [
    { key: "bumd", display: "BUMD", count: 2 },
    { key: "bumn", display: "BUMN", count: 1 },
    { key: "(blanks)", display: "(Blanks)", count: 1 },
  ];

  it("maps a known display string to its normalized key", () => {
    expect(selectedKeysFromModel(entries, ["BUMD"])).toEqual(new Set(["bumd"]));
  });

  it("returns null for null/undefined input (inactive filter)", () => {
    expect(selectedKeysFromModel(entries, null)).toBeNull();
    expect(selectedKeysFromModel(entries, undefined)).toBeNull();
  });

  it("ignores display strings not present in entries", () => {
    expect(selectedKeysFromModel(entries, ["NOPE", "BUMN"])).toEqual(
      new Set(["bumn"]),
    );
  });

  it("returns empty Set when every display string is unknown", () => {
    expect(selectedKeysFromModel(entries, ["foo", "bar"])).toEqual(new Set());
  });
});

describe("shared stripTrailingSemicolon (TASK-004 case 5)", () => {
  it("resultsGridModel imports the shared helper and declares no local copy", () => {
    const source = readFileSync(
      new URL("../resultsGridModel.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{[^}]*stripTrailingSemicolon[^}]*\}\s*from\s*"\.\.\/core\/text"/,
    );
    expect(source).not.toMatch(/function\s+stripTrailingSemicolon\s*\(/);
  });
});
