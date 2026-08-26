// src/ui/__tests__/queryComposer.test.ts
//
// TASK-004 — Dialect query composer: filter WHERE + OFFSET/LIMIT paging +
// sort dispatch. Pure string-assertion tests (no mocks, no DOM), mirroring
// the style of src/adapters/__tests__/postgres.sortQuery.test.ts — one `it`
// per numbered case from the task's §Test Cases table (19 cases, incl. the
// typed-value cases 15-19).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildFilterWhere,
  buildOrderByClause,
  buildPagedQuery,
  buildPagedQueryTerms,
  composeSortQuery,
  parseOrderBy,
} from "../queryComposer";
import { getTableSortQuery } from "../../adapters/postgres";
import { getTableSortQuery as mssqlGetTableSortQuery } from "../../adapters/mssql";
import { getTableSortQuery as mysqlGetTableSortQuery } from "../../adapters/mysql";

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

  // TASK-006 Case 8 — unit (dispatch): composeSortQuery's mssql arm equals the
  // adapter helper byte-identically; postgres still equals its helper too (the
  // dispatch did not drift).
  it("composeSortQuery(mssql) equals the adapter helper; postgres still equals too", () => {
    const originalSql = "SELECT * FROM t";
    const whereFromBar = "age > 18";
    const column = "name";
    const direction = "DESC" as "ASC" | "DESC";
    expect(
      composeSortQuery("mssql", originalSql, whereFromBar, column, direction),
    ).toBe(mssqlGetTableSortQuery(originalSql, whereFromBar, column, direction));
    expect(
      composeSortQuery("postgres", originalSql, whereFromBar, column, direction),
    ).toBe(getTableSortQuery(originalSql, whereFromBar, column, direction));
  });

  // TASK-006 Case 9 — unit (no dead export): mssql.getTableSortQuery is
  // reachable only through composeSortQuery, and the composer's mssql arm holds
  // no duplicated T-SQL (it is a one-line delegation, not a copy-paste).
  // Source-text assertion plus a behavioral one.
  it("mssql.getTableSortQuery is wired through composeSortQuery, not duplicated", () => {
    const source = readFileSync(
      new URL("../queryComposer.ts", import.meta.url),
      "utf8",
    );
    // The composer imports the adapter helper and never re-derives the sort
    // wrapper for mssql: no bracket-quoting string building of its own.
    expect(source).toContain('from "../adapters/mssql"');
    expect(source).not.toMatch(/quoteIdent\([^)]*"mssql"\)/);
    expect(source).not.toContain("replace(/]/g");
    // The mssql arm is a single one-line delegation — getTableSortQuery( is
    // called exactly once in the module (the import does not match `(`).
    expect(source.match(/getTableSortQuery\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /if \(dialect === "mssql"\)[\s\S]*?return getTableSortQuery\(originalSql, whereFromBar, column, direction\);/,
    );
    // Behavioral: composeSortQuery("mssql", …) still returns the full T-SQL —
    // proving the export is wired, not orphaned.
    expect(composeSortQuery("mssql", "SELECT 1", "", "name", "ASC")).toBe(
      "SELECT * FROM (SELECT 1) vsdb_sort ORDER BY [name] ASC",
    );
  });

  // ---------------------------------------------------------------------------
  // TASK-005 — MySQL sort twin delegation. The composer's mysql arm delegates
  // to `getTableSortQuery` (src/adapters/mysql.ts) exactly as the mssql arm
  // delegates to its twin; no inline backtick composition remains.
  // ---------------------------------------------------------------------------

  // Case 1 — happy: helper and composer parity
  it("mysql helper and composer parity (TASK-005 case 1)", () => {
    const sql = composeSortQuery("mysql", "SELECT 1", "", "name", "ASC");
    expect(sql).toBe("SELECT * FROM (SELECT 1) vsdb_sort ORDER BY `name` ASC");
    expect(sql).toBe(mysqlGetTableSortQuery("SELECT 1", "", "name", "ASC"));
  });

  // Case 2 — edge (injection): backtick payload stays one identifier via the delegated helper
  it("mysql injection payload is one backtick-quoted identifier (TASK-005 case 2)", () => {
    const sql = composeSortQuery("mysql", "SELECT 1", "", "n`; DROP TABLE x--", "ASC");
    expect(sql).toBe(
      "SELECT * FROM (SELECT 1) vsdb_sort ORDER BY `n``; DROP TABLE x--` ASC",
    );
    // No free DROP token outside the quoted identifier: strip the single
    // backtick-quoted identifier and the remainder contains no DROP.
    expect(sql).toContain("ORDER BY `n``; DROP TABLE x--` ASC");
    expect(sql.match(/DROP/g)).toHaveLength(1); // only inside the one quoted identifier
    expect(sql).toMatch(/ORDER BY `n``; DROP TABLE x--` ASC$/);
  });

  // Case 3 — edge (boundaries): whitespace WHERE omitted, non-empty WHERE outer, DESC, empty SQL
  it("mysql boundaries: whitespace WHERE omitted, non-empty WHERE outer, DESC preserved (TASK-005 case 3)", () => {
    expect(composeSortQuery("mysql", "SELECT 1", "   ", "n", "ASC")).not.toMatch(
      /\bWHERE\b/,
    );
    expect(
      composeSortQuery("mysql", "SELECT * FROM t", "age > 18", "name", "DESC"),
    ).toBe(
      "SELECT * FROM (SELECT * FROM t) vsdb_sort WHERE age > 18 ORDER BY `name` DESC",
    );
    expect(composeSortQuery("mysql", "", "", "n", "ASC")).toBe(
      "SELECT * FROM () vsdb_sort ORDER BY `n` ASC",
    );
  });

  // Dispatch source contract: the mysql arm is a delegation, not an inline duplicate.
  it("composeSortQuery's mysql arm delegates to the adapter helper, not an inline duplicate (TASK-005)", () => {
    const source = readFileSync(
      new URL("../queryComposer.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "../adapters/mysql"');
    expect(source).toMatch(/mysqlGetTableSortQuery\(/);
    expect(source).not.toMatch(/quoteIdent\([^)]*"mysql"\)/);
    expect(source).not.toContain("replace(/`/g");
    // The unaliased mssql call and aliased mysql call are each present once.
    expect(source.match(/getTableSortQuery\(/g)).toHaveLength(1);
    expect(source.match(/mysqlGetTableSortQuery\(/g)).toHaveLength(1);
    // Behavioral parity across all four args (non-trivial WHERE + DESC).
    const originalSql = "SELECT * FROM t WHERE id>5";
    const whereFromBar = "age > 18";
    expect(
      composeSortQuery("mysql", originalSql, whereFromBar, "name", "DESC"),
    ).toBe(
      mysqlGetTableSortQuery(originalSql, whereFromBar, "name", "DESC"),
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

// ---------------------------------------------------------------------------
// TASK-001 — ORDER BY parser + clause builder + paging tiebreaker + (Blanks)
// opt-in. Cases 1-18 below; all pre-existing blocks above stay untouched.
// ---------------------------------------------------------------------------

describe("parseOrderBy (TASK-001)", () => {
  // Case 1 — unit (happy): single bare identifier
  it("parses a single bare identifier", () => {
    expect(parseOrderBy("name")).toEqual({
      ok: true,
      terms: [{ column: "name", direction: "ASC" }],
    });
  });

  // Case 2 — unit (happy): multi-term with directions
  it("parses a multi-term orderBy with per-term directions", () => {
    expect(parseOrderBy("a, b DESC")).toEqual({
      ok: true,
      terms: [
        { column: "a", direction: "ASC" },
        { column: "b", direction: "DESC" },
      ],
    });
  });

  // Case 4 — edge (malformed input): function call rejected
  it("rejects a function call with a plain-column error", () => {
    const r = parseOrderBy("lower(name)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/plain column/i);
  });

  // Case 5 — edge (malformed input): parenthesised / dotted / ordinal
  it("rejects parenthesised, dotted, and ordinal terms", () => {
    for (const input of ["(a)", "t.a", "1"]) {
      const r = parseOrderBy(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  // Case 6 — edge (boundary): empty / whitespace-only is NOT an error
  it("empty and whitespace-only input yields zero terms, not an error", () => {
    expect(parseOrderBy("")).toEqual({ ok: true, terms: [] });
    expect(parseOrderBy("   ")).toEqual({ ok: true, terms: [] });
  });

  // Case 7 — edge (malformed input): empty term between commas rejected
  it("rejects an empty term between commas", () => {
    expect(parseOrderBy("a, ").ok).toBe(false);
    expect(parseOrderBy("a,,b").ok).toBe(false);
  });

  // Case 8 — edge (injection): quote-escape payload is not an identifier
  it("rejects a quote-escape payload as a term column", () => {
    const r = parseOrderBy('name"; DROP TABLE t--');
    expect(r.ok).toBe(false);
    if (r.ok) {
      for (const t of r.terms) expect(t.column).not.toContain('"');
    }
  });

  // Case 9 — edge (dialect capability): NULLS parsed + native on postgres
  it("parses NULLS LAST/FIRST and renders natively on postgres", () => {
    const last = parseOrderBy("a NULLS LAST", "postgres");
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.terms[0].nulls).toBe("LAST");
      expect(buildOrderByClause(last.terms, "postgres")).toBe(
        `"a" ASC NULLS LAST`,
      );
    }
    const first = parseOrderBy("a NULLS FIRST", "postgres");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.terms[0].nulls).toBe("FIRST");
      expect(buildOrderByClause(first.terms, "postgres")).toBe(
        `"a" ASC NULLS FIRST`,
      );
    }
  });

  // Case 10 — edge (dialect capability): NULLS rejected on mysql/mssql
  it("rejects NULLS on mysql and mssql with no emulation", () => {
    for (const dialect of ["mysql", "mssql"] as const) {
      const r = parseOrderBy("a NULLS LAST", dialect);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/NULLS/i);
    }
  });

  // Case 10b — unit (happy): active-dialect quoted identifier canonicalized
  it("canonicalizes an active-dialect quoted identifier", () => {
    const pg = parseOrderBy('"First Name"', "postgres");
    expect(pg.ok).toBe(true);
    if (pg.ok) expect(pg.terms[0].column).toBe("First Name");
    const my = parseOrderBy("`First Name`", "mysql");
    expect(my.ok).toBe(true);
    if (my.ok) expect(my.terms[0].column).toBe("First Name");
    const ms = parseOrderBy("[First Name]", "mssql");
    expect(ms.ok).toBe(true);
    if (ms.ok) expect(ms.terms[0].column).toBe("First Name");
    // doubled delimiter escapes are un-doubled
    const esc = parseOrderBy('"a""b"', "postgres");
    expect(esc.ok).toBe(true);
    if (esc.ok) expect(esc.terms[0].column).toBe('a"b');
    // omitted dialect accepts all three styles
    for (const input of ['"x y"', "`x y`", "[x y]"]) {
      const r = parseOrderBy(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.terms[0].column).toBe("x y");
    }
  });

  // Case 10c — edge (dialect mismatch): mismatched quote style rejected
  it("rejects a mismatched quote style under a live dialect", () => {
    const cases: Array<[string, "postgres" | "mysql" | "mssql"]> = [
      ["`First Name`", "postgres"],
      ["[First Name]", "postgres"],
      ['"First Name"', "mysql"],
      ['"First Name"', "mssql"],
      ["First Name DESC", "postgres"],
    ];
    for (const [input, dialect] of cases) {
      const r = parseOrderBy(input, dialect);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  // Case 10d — edge (injection): quoted payload re-quoted, not passed through
  it("re-quotes a quoted payload instead of passing it through", () => {
    const r = parseOrderBy('"a"" OR 1=1--"', "postgres");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(buildOrderByClause(r.terms, "postgres")).toBe(
        `"a"" OR 1=1--" ASC`,
      );
    }
  });
});

describe("buildOrderByClause (TASK-001)", () => {
  // Case 3 — unit (happy): quotes per dialect
  it("quotes terms per dialect", () => {
    const terms = [
      { column: "a", direction: "ASC" as const },
      { column: "b", direction: "DESC" as const },
    ];
    expect(buildOrderByClause(terms, "postgres")).toBe(`"a" ASC, "b" DESC`);
    expect(buildOrderByClause(terms, "mysql")).toBe("`a` ASC, `b` DESC");
    expect(buildOrderByClause(terms, "mssql")).toBe("[a] ASC, [b] DESC");
  });
});

describe("buildPagedQueryTerms (TASK-001)", () => {
  const sql = "SELECT * FROM t";
  const where = "";

  // Case 11 — unit (happy): composite-PK tiebreaker appended in declared order
  it("appends every tiebreaker in declared order", () => {
    const terms = [{ column: "name", direction: "ASC" as const }];
    const q = buildPagedQueryTerms(
      sql, where, terms, 0, 500, "postgres", ["tenant_id", "id"],
    );
    expect(q).toBe(
      `SELECT * FROM (SELECT * FROM t) vsdb_page ORDER BY "name" ASC, "tenant_id" ASC, "id" ASC LIMIT 500 OFFSET 0`,
    );
  });

  // Case 12 — edge (duplicate): existing PK component not doubled
  it("does not double an existing PK component", () => {
    const terms = [{ column: "tenant_id", direction: "DESC" as const }];
    const q = buildPagedQueryTerms(
      sql, where, terms, 0, 500, "postgres", ["tenant_id", "id"],
    );
    expect(q).toContain(`ORDER BY "tenant_id" DESC, "id" ASC`);
    expect(q.match(/"tenant_id"/g)).toHaveLength(1);
  });

  // Case 13 — edge (boundary): empty terms + tiebreakers === buildPagedQuery
  it("with no terms and no tiebreakers is byte-identical to buildPagedQuery", () => {
    for (const dialect of ["postgres", "mssql"] as const) {
      expect(
        buildPagedQueryTerms(sql, where, [], 100, 50, dialect, []),
      ).toBe(buildPagedQuery(sql, where, "", 100, 50, dialect));
    }
  });
});

describe("buildFilterWhere — columnTypes (TASK-001)", () => {
  // Case 14 — edge (type safety): string-typed column gets the whitespace
  // arm (TASK-004: empty + whitespace-only cells — tabs/newlines, not just
  // spaces — match the client's JS `String.trim() === ""` classifier).
  it("a string-typed column gets the whitespace empty-string arm", () => {
    expect(
      buildFilterWhere(
        { n: { values: ["(Blanks)", "a"] } },
        "postgres",
        { columnTypes: { n: "varchar" } },
      ),
    ).toBe(`("n" IS NULL OR "n" ~ '^[[:space:]]*$' OR "n" IN ('a'))`);
  });

  // Case 14b — edge (dialect): mysql and mssql whitespace predicates differ
  it("mysql and mssql emit their own whitespace predicates", () => {
    expect(
      buildFilterWhere(
        { n: { values: ["(Blanks)", "a"] } },
        "mysql",
        { columnTypes: { n: "varchar" } },
      ),
    ).toBe(`(\`n\` IS NULL OR \`n\` REGEXP '^[[:space:]]*$' OR \`n\` IN ('a'))`);
    expect(
      buildFilterWhere(
        { n: { values: ["(Blanks)", "a"] } },
        "mssql",
        { columnTypes: { n: "varchar" } },
      ),
    ).toBe(`([n] IS NULL OR [n] NOT LIKE '%[^ \t\r\n\f\v]%' OR [n] IN ('a'))`);
  });

  // Case 15 — regression (back-compat): no options ⇒ today's output
  it("without options the output is byte-identical to cycle V", () => {
    expect(
      buildFilterWhere({ n: { values: ["(Blanks)", "a"] } }, "postgres"),
    ).toBe(`("n" IS NULL OR "n" IN ('a'))`);
  });

  // Case 16 — edge (type safety): non-string types keep bare IS NULL
  it("non-string types keep a bare IS NULL", () => {
    for (const t of ["int4", "numeric", "timestamptz", "bool", "date"]) {
      expect(
        buildFilterWhere(
          { num: { values: ["(Blanks)"] } },
          "postgres",
          { columnTypes: { num: t } },
        ),
      ).toBe(`"num" IS NULL`);
    }
  });

  // Case 17 — edge (boundary): unknown / missing / empty type ⇒ NULL-only
  it("unknown, missing, and empty types default to NULL-only", () => {
    expect(
      buildFilterWhere({ n: { values: ["(Blanks)"] } }, "postgres"),
    ).toBe(`"n" IS NULL`);
    expect(
      buildFilterWhere(
        { n: { values: ["(Blanks)"] } }, "postgres", { columnTypes: {} },
      ),
    ).toBe(`"n" IS NULL`);
    expect(
      buildFilterWhere(
        { n: { values: ["(Blanks)"] } },
        "postgres",
        { columnTypes: { n: "" } },
      ),
    ).toBe(`"n" IS NULL`);
  });

  // Case 18 — edge (dialect capability): string-type family coverage
  it("string-type detection covers all dialects' families", () => {
    const stringTypes = [
      "char", "varchar", "character varying", "text", "TINYTEXT",
      "MEDIUMTEXT", "LONGTEXT", "nvarchar(50)", "NCHAR", "enum('a','b')",
      "set('x')", "citext", "cstring",
    ];
    for (const t of stringTypes) {
      expect(
        buildFilterWhere(
          { c: { values: ["(Blanks)"] } },
          "postgres",
          { columnTypes: { c: t } },
        ),
      ).toBe(`("c" IS NULL OR "c" ~ '^[[:space:]]*$')`);
    }
    // false-positive probes stay NULL-only
    for (const t of ["context_id", "textbook_code"]) {
      expect(
        buildFilterWhere(
          { c: { values: ["(Blanks)"] } },
          "postgres",
          { columnTypes: { c: t } },
        ),
      ).toBe(`"c" IS NULL`);
    }
  });
});

// Fix round 1 — reviewer findings (IMPORTANT): comma inside a quoted identifier,
// and unbounded string-type prefix matching.
describe("parseOrderBy — quoted identifier containing a comma (fix round 1)", () => {
  it("parses a pg quoted identifier with an embedded comma as ONE term", () => {
    expect(parseOrderBy('"my,col" DESC', "postgres")).toEqual({
      ok: true,
      terms: [{ column: "my,col", direction: "DESC" }],
    });
  });
  it("parses a mysql backtick identifier with an embedded comma", () => {
    expect(parseOrderBy("`last, first`", "mysql")).toEqual({
      ok: true,
      terms: [{ column: "last, first", direction: "ASC" }],
    });
  });
  it("parses an mssql bracket identifier with an embedded comma next to other terms", () => {
    expect(parseOrderBy("id, [my,col] DESC", "mssql")).toEqual({
      ok: true,
      terms: [
        { column: "id", direction: "ASC" },
        { column: "my,col", direction: "DESC" },
      ],
    });
  });
});

describe("isStringColumnType false positives (fix round 1)", () => {
  it("charset, enumeration, and setting are NOT string types", () => {
    for (const t of ["charset", "enumeration", "setting"]) {
      expect(
        buildFilterWhere(
          { c: { values: ["(Blanks)"] } },
          "postgres",
          { columnTypes: { c: t } },
        ),
      ).toBe(`"c" IS NULL`);
    }
  });
  it("known string families still get the whitespace arm", () => {
    for (const t of ["char", "character varying(30)", "varchar(255)", "set('x,y')"]) {
      expect(
        buildFilterWhere(
          { c: { values: ["(Blanks)"] } },
          "postgres",
          { columnTypes: { c: t } },
        ),
      ).toBe(`("c" IS NULL OR "c" ~ '^[[:space:]]*$')`);
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-004 — whitespace (Blanks): type safety, per-dialect TRIM SQL, and the
// single shared stripTrailingSemicolon source contract.
// ---------------------------------------------------------------------------

describe("buildFilterWhere — whitespace blanks (TASK-004)", () => {
  // Case 2 — edge (type safety): non-string columns stay NULL-only.
  it("non-string columns stay NULL-only: no TRIM() is ever emitted", () => {
    for (const t of ["int4", "numeric", "timestamptz", "bool", "date"]) {
      expect(
        buildFilterWhere(
          { num: { values: ["(Blanks)"] } },
          "postgres",
          { columnTypes: { num: t } },
        ),
      ).toBe(`"num" IS NULL`);
    }
    // unknown type ⇒ NULL-only too
    expect(
      buildFilterWhere({ n: { values: ["(Blanks)"] } }, "postgres", {
        columnTypes: { n: "mystery_type" },
      }),
    ).toBe(`"n" IS NULL`);
    const sql = buildFilterWhere(
      { n: { values: ["(Blanks)"] } },
      "postgres",
      { columnTypes: { n: "int4" } },
    );
    expect(sql).not.toContain("TRIM(");
  });

  // Case 3 — edge (dialect/escaping): string blanks SQL quotes safely per
  // dialect; the embedded delimiter stays escaped inside TRIM; a normal
  // selected value remains in the IN list.
  it("string-column blanks emit IS NULL OR TRIM(col) = '' per dialect", () => {
    const filters = { n: { values: ["(Blanks)", "a"] } };
    expect(
      buildFilterWhere(filters, "postgres", { columnTypes: { n: "varchar" } }),
    ).toBe(`("n" IS NULL OR "n" ~ '^[[:space:]]*$' OR "n" IN ('a'))`);
    expect(
      buildFilterWhere(filters, "mysql", { columnTypes: { n: "varchar" } }),
    ).toBe("(`n` IS NULL OR `n` REGEXP '^[[:space:]]*$' OR `n` IN ('a'))");
    expect(
      buildFilterWhere(filters, "mssql", { columnTypes: { n: "varchar" } }),
    ).toBe("([n] IS NULL OR [n] NOT LIKE '%[^ \t\r\n\f\v]%' OR [n] IN ('a'))");
  });

  it("embedded delimiter stays escaped inside TRIM()", () => {
    expect(
      buildFilterWhere(
        { 'a"b': { values: ["(Blanks)"] } },
        "postgres",
        { columnTypes: { 'a"b': "varchar" } },
      ),
    ).toBe(`("a""b" IS NULL OR "a""b" ~ '^[[:space:]]*$')`);
  });
});

describe("shared stripTrailingSemicolon (TASK-004 case 5)", () => {
  it("queryComposer imports the shared helper and declares no local copy", () => {
    const source = readFileSync(
      new URL("../queryComposer.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{[^}]*stripTrailingSemicolon[^}]*\}\s*from\s*"\.\.\/core\/text"/,
    );
    expect(source).not.toMatch(/function\s+stripTrailingSemicolon\s*\(/);
  });
});
