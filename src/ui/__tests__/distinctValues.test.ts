// src/ui/__tests__/distinctValues.test.ts
//
// TASK-002 — Pure DISTINCT-values SQL builder tests. Plain unit style
// (no vi.mock, no DOM), mirroring src/ui/__tests__/queryComposer.test.ts —
// one `it` per numbered case from the task's §Test Cases table (11 cases).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildDistinctValuesQuery,
  takeDistinctValues,
  DISTINCT_VALUES_LIMIT,
} from "../distinctValues";

describe("buildDistinctValuesQuery", () => {
  // Case 1 — unit (happy): postgres composition
  it("postgres composition", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "name", "postgres", "", 1000),
    ).toBe(
      `SELECT DISTINCT "name" FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001`,
    );
  });

  // Case 2 — unit (happy): mysql quoting
  it("mysql quoting", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "name", "mysql", "", 1000),
    ).toBe(
      "SELECT DISTINCT `name` FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001",
    );
  });

  // Case 3 — edge (dialect capability): mssql has no LIMIT
  it("mssql has no LIMIT", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "name", "mssql", "", 1000),
    ).toBe(
      `SELECT DISTINCT TOP (1001) [name] FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1`,
    );
  });

  // Case 4 — edge (injection): column payload stays one identifier
  it("column payload stays one identifier", () => {
    const out = buildDistinctValuesQuery(
      "SELECT * FROM t",
      `name"; DROP TABLE t--`,
      "postgres",
      "",
      1000,
    );
    expect(out).toContain(`"name""; DROP TABLE t--"`);
    expect(out.replace(`"name""; DROP TABLE t--"`, "")).not.toContain(
      `DROP TABLE t--`,
    );
  });

  // Case 4b — edge (injection, exact SQL): escaped identifiers, quote doubled
  it("postgres identifier with embedded quote is doubled (exact SQL)", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", 'we"ird', "postgres", "", 1000),
    ).toBe(
      `SELECT DISTINCT "we""ird" FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001`,
    );
  });

  it("mysql identifier with embedded backtick is doubled (exact SQL)", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "we`ird", "mysql", "", 1000),
    ).toBe(
      "SELECT DISTINCT `we``ird` FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001",
    );
  });

  it("mssql identifier with embedded ] is doubled (exact SQL)", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "we]ird", "mssql", "", 1000),
    ).toBe(
      `SELECT DISTINCT TOP (1001) [we]]ird] FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1`,
    );
  });

  // Case 4c — edge (exact SQL): schema-qualified base stays verbatim
  it("schema-qualified base stays verbatim (postgres, exact SQL)", () => {
    expect(
      buildDistinctValuesQuery(
        "SELECT * FROM analytics.events",
        "name",
        "postgres",
        "",
        1000,
      ),
    ).toBe(
      `SELECT DISTINCT "name" FROM (SELECT * FROM analytics.events) UnicDB_distinct ORDER BY 1 LIMIT 1001`,
    );
  });

  it("schema-qualified base stays verbatim (mssql, exact SQL)", () => {
    expect(
      buildDistinctValuesQuery(
        "SELECT * FROM dbo.Events",
        "name",
        "mssql",
        "",
        1000,
      ),
    ).toBe(
      `SELECT DISTINCT TOP (1001) [name] FROM (SELECT * FROM dbo.Events) UnicDB_distinct ORDER BY 1`,
    );
  });

  // Case 5 — edge (boundary): trailing semicolon on inner SQL is stripped
  it("trailing semicolon on inner SQL is stripped", () => {
    const out = buildDistinctValuesQuery(
      "SELECT * FROM t;",
      "name",
      "postgres",
      "",
      1000,
    );
    expect(out).not.toContain(");");
    expect(out).toBe(
      `SELECT DISTINCT "name" FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001`,
    );
    expect(out.split(";").length).toBe(1);
  });

  // Case 6 — edge (composition): WHERE applies at the OUTER level
  it("an existing WHERE is applied at the OUTER level", () => {
    const out = buildDistinctValuesQuery(
      "SELECT * FROM t",
      "name",
      "postgres",
      "id > 5",
      1000,
    );
    expect(out).toBe(
      `SELECT DISTINCT "name" FROM (SELECT * FROM t) UnicDB_distinct WHERE id > 5 ORDER BY 1 LIMIT 1001`,
    );
  });

  // Case 7 — edge (empty input): empty/whitespace WHERE adds no clause
  it("empty/whitespace WHERE adds no clause", () => {
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "name", "postgres", "   "),
    ).not.toContain("WHERE");
  });

  it("DISTINCT_VALUES_LIMIT defaults to 1000 and is the default limit", () => {
    expect(DISTINCT_VALUES_LIMIT).toBe(1000);
    expect(
      buildDistinctValuesQuery("SELECT * FROM t", "name", "postgres", ""),
    ).toBe(
      `SELECT DISTINCT "name" FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT ${DISTINCT_VALUES_LIMIT + 1}`,
    );
  });
});

describe("takeDistinctValues", () => {
  // Case 8 — edge (boundary): under the limit
  it("under the limit", () => {
    expect(takeDistinctValues([[1], [2], [3]], 1000)).toEqual({
      values: [1, 2, 3],
      truncated: false,
    });
  });

  // Case 9 — edge (boundary): exactly at limit+1
  it("exactly at limit+1", () => {
    const out = takeDistinctValues([["a"], ["b"], ["c"]], 2);
    expect(out.values.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  // Case 10 — edge (null handling): NULL survives as null
  it("NULL survives as null, not \"null\"", () => {
    const out = takeDistinctValues([[null], ["a"]]);
    expect(out.values[0]).toBe(null);
    expect(out.truncated).toBe(false);
  });

  // Case 11 — edge (malformed input): non-array / short rows skipped
  it("non-array / short rows are skipped, not crashed", () => {
    expect(
      takeDistinctValues(
        [["a"], [], undefined as unknown as unknown[]],
        1000,
      ),
    ).toEqual({ values: ["a"], truncated: false });
  });
});

// TASK-004 case 5 — shared terminator helper source contract.
describe("shared stripTrailingSemicolon (TASK-004)", () => {
  it("distinctValues imports the shared helper and declares no local copy", () => {
    const source = readFileSync(
      new URL("../distinctValues.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{[^}]*stripTrailingSemicolon[^}]*\}\s*from\s*"\.\.\/core\/text"/,
    );
    expect(source).not.toMatch(/function\s+stripTrailingSemicolon\s*\(/);
  });
});
