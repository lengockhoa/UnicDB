// src/ui/__tests__/queryComposer.test.ts
//
// TASK-004 — Dialect query composer: filter WHERE + OFFSET/LIMIT paging +
// sort dispatch. Pure string-assertion tests (no mocks, no DOM), mirroring
// the style of src/adapters/__tests__/postgres.sortQuery.test.ts — one `it`
// per numbered case from the task's §Test Cases table (19 cases, incl. the
// typed-value cases 15-19).
import { describe, it, expect } from "vitest";
import {
  buildFilterWhere,
  buildPagedQuery,
  composeSortQuery,
} from "../queryComposer";
import { getTableSortQuery } from "../../adapters/postgres";

describe("buildFilterWhere", () => {
  // Case 1 — unit (happy): emits an IN list
  it("buildFilterWhere emits an IN list", () => {
    expect(
      buildFilterWhere({ name: { values: ["a", "b"] } }, "postgres"),
    ).toBe(`"name" IN ('a', 'b')`);
  });

  // Case 2 — unit (happy): two filtered columns are AND-joined
  it("two filtered columns are AND-joined", () => {
    expect(
      buildFilterWhere(
        { a: { values: ["1"] }, b: { values: ["2"] } },
        "postgres",
      ),
    ).toBe(`"a" IN ('1') AND "b" IN ('2')`);
  });

  // Case 3 — edge (blanks sentinel): (Blanks) → IS NULL, OR-joins with IN
  it("(Blanks) becomes IS NULL and OR-joins with the IN list", () => {
    expect(
      buildFilterWhere({ n: { values: ["(Blanks)", "a"] } }, "postgres"),
    ).toBe(`("n" IS NULL OR "n" IN ('a'))`);
  });

  // Case 4 — edge (blanks only): bare IS NULL, no empty IN ()
  it("only (Blanks) selected yields a bare IS NULL", () => {
    expect(
      buildFilterWhere({ n: { values: ["(Blanks)"] } }, "postgres"),
    ).toBe(`"n" IS NULL`);
  });

  // Case 5 — edge (value injection): single quote in a value is doubled
  it("single quote in a value is doubled", () => {
    const sql = buildFilterWhere(
      { name: { values: ["O'Brien"] } },
      "postgres",
    );
    expect(sql).toBe(`"name" IN ('O''Brien')`);
    expect(sql).not.toContain("'O'Brien'");
  });

  // Case 6 — edge (identifier injection): delimiter in column name doubled
  it("delimiter inside a column name is doubled per dialect", () => {
    expect(buildFilterWhere({ "a]b": { values: ["1"] } }, "mssql")).toBe(
      "[a]]b] IN ('1')",
    );
    expect(buildFilterWhere({ "a`b": { values: ["1"] } }, "mysql")).toBe(
      "`a``b` IN ('1')",
    );
    expect(buildFilterWhere({ 'a"b': { values: ["1"] } }, "postgres")).toBe(
      `"a""b" IN ('1')`,
    );
  });

  // Case 7 — edge (empty model): empty / all-empty → ""
  it("empty or all-empty filter model returns empty string", () => {
    expect(buildFilterWhere({}, "postgres")).toBe("");
    expect(buildFilterWhere({ n: { values: [] } }, "postgres")).toBe("");
  });
});

describe("buildPagedQuery", () => {
  // Case 8 — unit (happy): postgres pages with LIMIT/OFFSET
  it("buildPagedQuery pages postgres with LIMIT/OFFSET", () => {
    const sql = buildPagedQuery("SELECT * FROM t", "", "", 1000, 500, "postgres");
    expect(sql).toMatch(/LIMIT 500 OFFSET 1000$/);
  });

  // Case 9 — edge (dialect): mssql OFFSET/FETCH + injected ORDER BY
  it("mssql pages with OFFSET/FETCH and injects an ORDER BY", () => {
    const sql = buildPagedQuery("SELECT * FROM t", "", "", 1000, 500, "mssql");
    expect(sql).toContain(
      "ORDER BY (SELECT NULL) OFFSET 1000 ROWS FETCH NEXT 500 ROWS ONLY",
    );
  });

  // Case 10 — edge (dialect, order supplied): mssql keeps caller ORDER BY
  it("mssql keeps the caller's ORDER BY instead of the placeholder", () => {
    const sql = buildPagedQuery("SELECT * FROM t", "", "name DESC", 1000, 500, "mssql");
    expect(sql).toContain("ORDER BY name DESC OFFSET");
    expect(sql).not.toContain("(SELECT NULL)");
  });

  // Case 11 — edge (boundary): offset 0 still emits OFFSET 0
  it("offset 0 still emits OFFSET 0", () => {
    expect(
      buildPagedQuery("SELECT * FROM t", "", "", 0, 100, "mssql"),
    ).toContain("OFFSET 0");
    expect(
      buildPagedQuery("SELECT * FROM t", "", "", 0, 100, "postgres"),
    ).toContain("OFFSET 0");
  });

  // Case 12 — edge (statement terminator): trailing `;` stripped before wrap
  it("a trailing semicolon in the inner SQL is stripped before wrapping", () => {
    const sql = buildPagedQuery("SELECT 1;", "", "", 100, 0, "postgres");
    expect(sql).not.toContain("(SELECT 1;)");
    expect(sql.split(";").length - 1).toBeLessThanOrEqual(1);
  });
});

describe("composeSortQuery", () => {
  // Case 13 — unit (happy): postgres routes to the existing helper (byte-identical)
  it("composeSortQuery routes postgres to the existing helper", () => {
    expect(composeSortQuery("postgres", "SELECT 1", "", "name", "ASC")).toBe(
      getTableSortQuery("SELECT 1", "", "name", "ASC"),
    );
  });

  // Case 14 — edge (dispatch): quotes per dialect
  it("composeSortQuery quotes per dialect", () => {
    expect(composeSortQuery("postgres", "SELECT 1", "", "name", "ASC")).toContain(
      'ORDER BY "name" ASC',
    );
    expect(composeSortQuery("mysql", "SELECT 1", "", "name", "ASC")).toContain(
      "ORDER BY `name` ASC",
    );
    expect(composeSortQuery("mssql", "SELECT 1", "", "name", "ASC")).toContain(
      "ORDER BY [name] ASC",
    );
  });
});

describe("buildFilterWhere — typed values (cases 15-19)", () => {
  // Case 15 — edge (numeric typing): unquoted on all three dialects
  it("numeric filter values are emitted unquoted on all three dialects", () => {
    const filters = { id: { values: ["42", "7"], typed: [42, 7] } };
    expect(buildFilterWhere(filters, "postgres")).toBe(`"id" IN (42, 7)`);
    expect(buildFilterWhere(filters, "mysql")).toBe("`id` IN (42, 7)");
    expect(buildFilterWhere(filters, "mssql")).toBe("[id] IN (42, 7)");
  });

  // Case 16 — edge (temporal typing): ISO timestamp normalized per dialect
  it("an ISO timestamp is normalized per dialect", () => {
    const filters = {
      d: {
        values: ["2024-03-01T10:30:00.000Z"],
        typed: ["2024-03-01T10:30:00.000Z"],
      },
    };
    expect(buildFilterWhere(filters, "postgres")).toBe(
      `"d" IN ('2024-03-01T10:30:00.000Z')`,
    );
    expect(buildFilterWhere(filters, "mysql")).toBe(
      "`d` IN ('2024-03-01 10:30:00.000')",
    );
    expect(buildFilterWhere(filters, "mssql")).toBe(
      "[d] IN ('2024-03-01 10:30:00.000')",
    );
  });

  // Case 17 — edge (boolean + null typing): typed, not stringified
  it("booleans and nulls are typed, not stringified", () => {
    expect(
      buildFilterWhere({ f: { values: ["true"], typed: [true] } }, "postgres"),
    ).toBe(`"f" IN (TRUE)`);
    // typed null routes to the IS NULL branch, never inside the IN list
    expect(
      buildFilterWhere({ f: { values: ["(Blanks)"], typed: [null] } }, "postgres"),
    ).toBe(`"f" IS NULL`);
  });

  // Case 18 — edge (no type sniffing): numeric-looking value stays quoted
  it("a numeric-looking value stays quoted when no typed[] is supplied", () => {
    expect(
      buildFilterWhere({ code: { values: ["007"] } }, "postgres"),
    ).toBe(`"code" IN ('007')`);
  });

  // Case 19 — edge (length mismatch): typed[] of wrong length is ignored
  it("a typed[] of the wrong length is ignored, not zipped", () => {
    expect(
      buildFilterWhere(
        { id: { values: ["1", "2"], typed: [1] } },
        "postgres",
      ),
    ).toBe(`"id" IN ('1', '2')`);
  });
});
