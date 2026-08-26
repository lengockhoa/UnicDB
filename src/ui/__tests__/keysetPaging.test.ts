// src/ui/__tests__/keysetPaging.test.ts
//
// TASK-004 (cycle Y) — pure keyset/cursor paging composer.
//
// TDD contract (task §Test Cases + Discussion #5):
//   - assertBrowseShape: structural gate, non-null ONLY for plain
//     `SELECT * | col-list FROM <single table>` statements (no
//     DISTINCT/GROUP/HAVING/window/set-ops outside quotes/comments,
//     strips one trailing `;`). Consistent with parseFromClause
//     provenance — the producer types must stay in sync.
//   - composeKeysetQuery: OR-of-ANDs keyset predicate (portable across
//     postgres/mysql/mssql — NO row-value constructor) replacing OFFSET
//     only when a last-row key is present AND the total order is proven;
//     page 0 (no key) is BYTE-IDENTICAL to buildPagedQueryTerms (the
//     cycle-W guarantee the frozen resultsPanelOrderBy.test.ts pins).
//   - Missing-PK projection widening (contract A): gated explicit
//     projections gain the missing PK columns; hiddenColumns marks the
//     appended names so the host can strip them from the displayed result
//     while the values stay positionally available for the paging key.
//   - Every fallback path is today's behaviour, unchanged.
import { describe, it, expect } from "vitest";
import {
  assertBrowseShape,
  composeKeysetQuery,
} from "../keysetPaging";
import { buildPagedQuery, buildPagedQueryTerms } from "../queryComposer";
import { stripTrailingSemicolon } from "../../core/text";
import { parseFromClause } from "../../core/saveStatements";

const PG_PAGE_DEFAULTS = {
  where: "",
  terms: [],
  tiebreakers: ["id"],
  offset: 0,
  limit: 500,
  dialect: "postgres",
} as const;

function pageDefaults(
  overrides: Partial<Parameters<typeof composeKeysetQuery>[0]> = {},
): Parameters<typeof composeKeysetQuery>[0] {
  return { ...PG_PAGE_DEFAULTS, baseSql: "SELECT * FROM t", ...overrides };
}

// ---------------------------------------------------------------------------
// §Case 1 — happy: page two uses a stable cursor, not deep OFFSET
// ---------------------------------------------------------------------------

describe("composeKeysetQuery — case 1: second page keys off the last row", () => {
  it("postgres deep page: dialect-quoted keyset predicate + LIMIT, and OFFSET 500000 gone", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT * FROM public.events",
      where: "",
      terms: [{ column: "created_at", direction: "DESC" }],
      tiebreakers: ["id"],
      lastKey: [
        { column: "created_at", value: "2026-01-01T00:00:00Z" },
        { column: "id", value: 42 },
      ],
      offset: 500000,
      limit: 500,
      dialect: "postgres",
    });
    const pred =
      '("created_at" < \'2026-01-01T00:00:00Z\') OR ("created_at" = \'2026-01-01T00:00:00Z\' AND "id" > 42)';
    expect(r.sql).toContain(pred);
    expect(r.sql).toContain("LIMIT 500");
    expect(r.sql).not.toContain("OFFSET");
  });

  it("the keyset SQL preserves a bar/filter WHERE by AND-ing it ahead of the predicate", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT * FROM events",
      where: 'status = \'open\'',
      terms: [{ column: "id", direction: "ASC" }],
      tiebreakers: ["id"],
      lastKey: [{ column: "id", value: 7 }],
      offset: 500,
      limit: 100,
      dialect: "postgres",
    });
    expect(r.sql).toBe(
      "SELECT * FROM (SELECT * FROM events) vsdb_page WHERE status = 'open' AND (\"id\" > 7) ORDER BY \"id\" ASC LIMIT 100",
    );
  });
});

// ---------------------------------------------------------------------------
// §Case 2 — dialect: MSSQL emits no row-value constructor
// ---------------------------------------------------------------------------

describe("composeKeysetQuery — case 2: composite key is an OR-of-ANDs on mssql", () => {
  it("two-column PK with mixed DESC/ASC directions brackets and quotes per T-SQL", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT * FROM dbo.orders",
      where: "",
      terms: [{ column: "region", direction: "DESC" }],
      tiebreakers: ["tenant_id", "id"],
      lastKey: [
        { column: "region", value: "EMEA" },
        { column: "tenant_id", value: 9 },
        { column: "id", value: 120 },
      ],
      offset: 2500,
      limit: 500,
      dialect: "mssql",
    });
    expect(r.sql).toContain(
      "([region] < 'EMEA') OR ([region] = 'EMEA' AND [tenant_id] > 9) OR ([region] = 'EMEA' AND [tenant_id] = 9 AND [id] > 120)",
    );
    // No row-value constructor anywhere, and the MSSQL LIMIT equivalent.
    expect(r.sql).not.toMatch(/\bROW\s*\(|\bVALUES\b|\bFETCH\b/i);
    expect(r.sql).toContain("TOP 500 ");
    expect(r.sql).not.toContain("OFFSET");
  });

  it("mysql composes the same portable predicate with backtick quoting", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT * FROM orders",
      where: "",
      terms: [{ column: "region", direction: "DESC" }],
      tiebreakers: ["tenant_id", "id"],
      lastKey: [
        { column: "region", value: "EMEA" },
        { column: "tenant_id", value: 9 },
        { column: "id", value: 120 },
      ],
      offset: 2500,
      limit: 500,
      dialect: "mysql",
    });
    expect(r.sql).toContain(
      "(`region` < 'EMEA') OR (`region` = 'EMEA' AND `tenant_id` > 9) OR (`region` = 'EMEA' AND `tenant_id` = 9 AND `id` > 120)",
    );
    expect(r.sql).toContain("LIMIT 500");
  });
});

// ---------------------------------------------------------------------------
// §Case 3 — query shape: DISTINCT/aggregate is never widened
// ---------------------------------------------------------------------------

describe("assertBrowseShape — case 3: gate refuses shapes that cannot prove one source table", () => {
  const refused = [
    ["DISTINCT", "SELECT DISTINCT region FROM sales"],
    ["GROUP BY", "SELECT region, COUNT(*) FROM sales GROUP BY region"],
    ["HAVING", "SELECT region FROM sales GROUP BY region HAVING COUNT(*) > 1"],
    ["window fn", "SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM t"],
    ["UNION", "SELECT id FROM a UNION SELECT id FROM b"],
    ["INTERSECT", "SELECT id FROM a INTERSECT SELECT id FROM b"],
    ["EXCEPT", "SELECT id FROM a EXCEPT SELECT id FROM b"],
    ["subquery projection", "SELECT (SELECT MAX(x) FROM m) FROM t"],
    ["join", "SELECT a.id FROM a JOIN b ON b.a_id = a.id"],
    ["comma join", "SELECT a.id FROM a, b"],
    ["cte", "WITH c AS (SELECT 1) SELECT * FROM c"],
    ["aggregates", "SELECT COUNT(*) FROM t"],
    ["aliased expr", "SELECT UPPER(name) FROM t"],
  ] as const;

  it.each(refused)("refuses %s", (_label, sql) => {
    expect(assertBrowseShape(sql)).toBeNull();
  });

  it("provenance agrees with parseFromClause for the accepted single-table shapes", () => {
    const sql = "SELECT id, name FROM analytics.facts";
    const shape = assertBrowseShape(sql);
    expect(shape).toEqual({ columns: ["id", "name"], schema: "analytics", table: "facts" });
    const parsed = parseFromClause(sql);
    expect(shape?.table).toBe(parsed?.table);
    expect(shape?.schema).toBe(parsed?.schema);
  });
});

describe("assertBrowseShape — accepted gated shapes", () => {
  it("star projection, qualified table, stray trailing ;", () => {
    expect(assertBrowseShape("SELECT * FROM public.events;")).toEqual({
      columns: "*",
      schema: "public",
      table: "events",
    });
  });

  it("unqualified table and quoted/bracketed column styles resolve to logical names", () => {
    expect(assertBrowseShape('SELECT "First Name", [Region], salary FROM staff')).toEqual({
      columns: ["First Name", "Region", "salary"],
      table: "staff",
    });
  });

  it("skips strings and comments when hunting forbidden tokens (comment mentioning union)", () => {
    const sql = "SELECT id -- union breaker comment\nFROM t /* distinct */ WHERE x = 'no union here'";
    const shape = assertBrowseShape(sql);
    expect(shape?.columns).toEqual(["id"]);
    expect(shape?.table).toBe("t");
  });
});

// ---------------------------------------------------------------------------
// §Guards — fallbacks and byte-identity guarantees
// ---------------------------------------------------------------------------

describe("composeKeysetQuery — fallback guards keep today's behaviour", () => {
  it("no tiebreakers (total order unprovable) → OFFSET path byte-identical to buildPagedQueryTerms", () => {
    const opts = pageDefaults({ tiebreakers: [], lastKey: [{ column: "id", value: 5 }] });
    const r = composeKeysetQuery(opts);
    expect(r.sql).toBe(
      buildPagedQueryTerms(opts.baseSql, "", [], 0, 500, "postgres", []),
    );
    expect(r.sql).toContain("OFFSET 0"); // legacy OFFSET composition kept verbatim
    expect(r.hiddenColumns).toBeUndefined();
  });

  it("a NULL key value refuses the keyset and keeps the OFFSET composition", () => {
    const r = composeKeysetQuery({ ...pageDefaults(), lastKey: [{ column: "id", value: null }] });
    expect(r.sql).toBe(buildPagedQueryTerms("SELECT * FROM t", "", [], 0, 500, "postgres", ["id"]));
  });

  it("truncated key (fewer entries than the ordered columns) falls back", () => {
    const r = composeKeysetQuery({
      ...pageDefaults(),
      terms: [{ column: "a", direction: "ASC" }],
      tiebreakers: ["b"],
      lastKey: [{ column: "a", value: 1 }],
    });
    expect(r.sql).toContain("OFFSET 0");
  });

  it("non-browse base SQL (DISTINCT) never widens nor keysets", () => {
    const opts = pageDefaults({
      baseSql: "SELECT DISTINCT region FROM sales",
      lastKey: [{ column: "region", value: 3 }],
    });
    const r = composeKeysetQuery(opts);
    expect(r.hiddenColumns).toBeUndefined();
    // Gate-refused SQL keeps today's OFFSET composition verbatim (full PK
    // did not survive the DISTINCT gate, so no tiebreaker is appended —
    // exactly buildPagedQueryTerms's cycle-W behaviour for pkTiebreakers []).
    expect(r.sql).toBe(
      buildPagedQuery(
        opts.baseSql,
        "",
        '"id" ASC',
        0,
        500,
        "postgres",
      ),
    );
    expect(r.sql).toContain("OFFSET 0");
  });

  it("page 0 without a key is byte-identical to buildPagedQueryTerms even with widening armed", () => {
    const sql = "SELECT name FROM public.users";
    const opts = pageDefaults({
      baseSql: sql,
      terms: [{ column: "name", direction: "ASC" }],
      tiebreakers: ["id"],
      widenPkWithHidden: true,
    });
    const r = composeKeysetQuery(opts);
    expect(r.hiddenColumns).toEqual(["id"]);
    expect(r.sql).toBe(
      `SELECT * FROM (SELECT name, "id" FROM public.users) vsdb_page ORDER BY "name" ASC, "id" ASC LIMIT 500 OFFSET 0`,
    );
  });
});

// ---------------------------------------------------------------------------
// §Widening (Contract A ii) — missing-PK projection
// ---------------------------------------------------------------------------

describe("composeKeysetQuery — missing-PK projection widening", () => {
  it("appends the missing PK columns to an explicit projection and marks them hidden", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT name FROM public.users",
      where: "",
      terms: [],
      tiebreakers: ["id"],
      offset: 0,
      limit: 500,
      dialect: "postgres",
      widenPkWithHidden: true,
    });
    expect(r.hiddenColumns).toEqual(["id"]);
    expect(r.sql).toContain('SELECT name, "id" FROM public.users');
  });

  it("composite PK appends only the genuinely missing parts, in declared order", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT name, tenant_id FROM events",
      where: "",
      terms: [],
      tiebreakers: ["tenant_id", "id"],
      offset: 0,
      limit: 100,
      dialect: "postgres",
      widenPkWithHidden: true,
    });
    expect(r.hiddenColumns).toEqual(["id"]);
    expect(r.sql).toContain('SELECT name, tenant_id, "id" FROM events');
  });

  it("already-projected PK leaves hiddenColumns unset", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT id, name FROM users",
      where: "",
      terms: [],
      tiebreakers: ["id"],
      offset: 0,
      limit: 100,
      dialect: "postgres",
      widenPkWithHidden: true,
    });
    expect(r.hiddenColumns).toBeUndefined();
  });

  it("keeps the statement's own trailing clauses verbatim after the widened list", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT name FROM t WHERE created_at > '2020-01-01' ORDER BY name",
      where: "",
      terms: [{ column: "name", direction: "ASC" }],
      tiebreakers: ["id"],
      offset: 100,
      limit: 50,
      dialect: "mysql",
      widenPkWithHidden: true,
    });
    expect(r.sql).toBe(
      "SELECT * FROM (SELECT name, `id` FROM t WHERE created_at > '2020-01-01' ORDER BY name) vsdb_page ORDER BY `name` ASC, `id` ASC LIMIT 50 OFFSET 100",
    );
  });

  it("keyword-named PK column gets dialect quoting in the widened list", () => {
    const r = composeKeysetQuery({
      baseSql: "SELECT label FROM logs",
      where: "",
      terms: [],
      tiebreakers: ["order"],
      offset: 0,
      limit: 10,
      dialect: "mysql",
      widenPkWithHidden: true,
    });
    expect(r.hiddenColumns).toEqual(["order"]);
    expect(r.sql).toContain("SELECT label, `order` FROM logs");
  });
});

// ---------------------------------------------------------------------------
// Pure-parser boundary details feeding both public functions
// ---------------------------------------------------------------------------

describe("stripTrailingSemicolon integration with the gate", () => {
  it("one trailing terminator stripped before the shape scan; interior semicolons refuse", () => {
    expect(stripTrailingSemicolon("SELECT * FROM t;")).toBe("SELECT * FROM t");
    // Two statements are not a single browse — gate refuses.
    expect(assertBrowseShape("SELECT 1; SELECT 2;")).toBeNull();
  });
});
