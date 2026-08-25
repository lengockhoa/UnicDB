// src/ui/queryComposer.ts
//
// TASK-004 — Dialect query composer (server-side filter + paging + sort
// dispatch). Pure-logic SQL composition: turns an AG Grid set-filter model
// into a WHERE clause, adds OFFSET/LIMIT-style paging, and dispatches the
// sort helper per dialect.
//
// Constraint highlights:
//   - No DOM, no vscode, no DB driver — the postgres/mysql sort arms are
//     composed inline byte-identical to the adapters' helpers so this module
//     stays importable from the webview bundle (browser platform) without
//     dragging the pg/mysql2 drivers in. The mssql arm is the single
//     exception (TASK-006): it delegates to `getTableSortQuery`
//     (src/adapters/mssql.ts) — consumed host-side by TASK-005, never from
//     the webview — so the T-SQL lives in exactly one place.
//   - Zero hand-rolled escaping: every identifier goes through `quoteIdent`,
//     every value through `sqlLiteral`.
//   - Filter values arrive as String()-coerced display strings. Numeric,
//     boolean, null and temporal literals MUST come from the caller-supplied
//     `typed[]` (via `sqlLiteral`); the display string is NEVER type-sniffed
//     (a `varchar` `'007'` must stay a quoted string).
import { sqlLiteral, SET_FILTER_BLANKS_DISPLAY } from "./resultsGridModel";
import { quoteIdent, type Dialect } from "../core/saveStatements";
import { getTableSortQuery } from "../adapters/mssql";

/**
 * AG Grid set-filter model as returned by GridApi.getFilterModel(), plus an
 * optional parallel array of the ORIGINAL (uncoerced) cell values.
 *
 * `values` is display text — AG Grid's set filter stores what the checkbox
 * showed, i.e. String()-coerced. `typed[i]` is the raw value behind
 * `values[i]` and is what buildFilterWhere prefers when present.
 * `typed` is optional and MUST be ignored unless typed.length === values.length.
 */
export interface ColumnFilterModel {
  [field: string]: { values: string[]; typed?: unknown[] };
}

/**
 * Canonical ISO-8601 timestamp shape as produced by `Date.toISOString()`
 * (which is what `formatCell` uses to display Date cells). Only typed values
 * that match THIS exact shape are treated as temporal — a bare numeric-looking
 * display string like `"007"` never matches, so no type sniffing leaks in
 * through the back door.
 */
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Serialize a typed value to an ISO timestamp string, or null when the
 *  value is not temporal (Date instance or canonical ISO string). */
function isoStringOf(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && ISO_TIMESTAMP_RE.test(v)) return v;
  return null;
}

/**
 * Literal for a typed cell value, routed through `sqlLiteral`.
 *
 * Temporal values get one extra dialect step that `sqlLiteral` does not do:
 * a `Date` (or canonical ISO string) is emitted with the `Z` suffix and the
 * `T` separator for postgres (which parses full ISO), but as a UTC-naive
 * `'YYYY-MM-DD HH:mm:ss.SSS'` literal for mysql/mssql (MSSQL `datetime2`
 * raises a conversion error on the trailing `Z`).
 *
 * Numbers/bigints come out unquoted, booleans as TRUE/FALSE, null as NULL —
 * all from `sqlLiteral`, never reimplemented here.
 */
function typedLiteral(v: unknown, dialect: Dialect): string {
  const iso = isoStringOf(v);
  if (iso !== null && dialect !== "postgres") {
    return sqlLiteral(iso.replace("T", " ").replace(/Z$/, ""));
  }
  return sqlLiteral(v);
}

/**
 * Build the WHERE clause for an AG Grid set-filter model.
 *
 *   buildFilterWhere({ name: { values: ["a","b"] } }, "postgres")
 *     → `"name" IN ('a', 'b')`
 *
 * - Columns AND-join (AG Grid's multi-column set-filter semantics).
 * - `(Blanks)` display entries become `col IS NULL` and OR-join with the
 *   column's IN list; a blanks-only column yields a bare `col IS NULL`
 *   (never an empty `IN ()`, which is a syntax error on all three dialects).
 * - Values go through `sqlLiteral`. When `typed` is present AND
 *   `typed.length === values.length`, the literal is built from `typed[i]`
 *   (unquoted numbers, TRUE/FALSE, dialect-normalized timestamps); otherwise
 *   it falls back to the display string as a string literal. No type
 *   sniffing from display strings. A typed null/undefined at an index routes
 *   that entry to the IS NULL branch.
 *
 * Returns `""` when nothing is filtered — the caller then omits the WHERE
 * entirely.
 */
export function buildFilterWhere(
  filters: ColumnFilterModel,
  dialect: Dialect,
): string {
  const predicates: string[] = [];
  for (const [field, model] of Object.entries(filters)) {
    const values = model.values;
    if (!Array.isArray(values) || values.length === 0) continue;
    const typed = model.typed;
    const useTyped = Array.isArray(typed) && typed.length === values.length;

    const quoted = quoteIdent(field, dialect);
    let hasNull = false;
    const inList: string[] = [];
    values.forEach((display, i) => {
      const isBlank =
        display === SET_FILTER_BLANKS_DISPLAY ||
        (useTyped && (typed[i] === null || typed[i] === undefined));
      if (isBlank) {
        hasNull = true;
        return;
      }
      inList.push(useTyped ? typedLiteral(typed[i], dialect) : sqlLiteral(display));
    });

    const parts: string[] = [];
    if (hasNull) parts.push(`${quoted} IS NULL`);
    if (inList.length > 0) parts.push(`${quoted} IN (${inList.join(", ")})`);
    if (parts.length === 0) continue;

    predicates.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }
  return predicates.join(" AND ");
}

/** Strip a single trailing `;` (and surrounding whitespace) from a SQL
 *  statement so wrapping it in a subquery never nests a stray terminator.
 *  Mirrors the guard composeRequery uses (resultsGridModel.ts). Interior
 *  `;` inside string literals stays intact. */
function stripTrailingSemicolon(sql: string): string {
  const m = /^(.*?)(\s*;?\s*)$/s.exec(sql);
  if (!m) return sql;
  const body = m[1] ?? "";
  if (body.trim().length === 0) return sql.trim();
  return body.trimEnd();
}

/**
 * Wrap a composed inner SELECT with paging.
 *
 *   buildPagedQuery("SELECT * FROM t", "", "", 1000, 500, "postgres")
 *     → `SELECT * FROM (SELECT * FROM t) vsdb_page LIMIT 500 OFFSET 1000`
 *
 * The inner SQL is wrapped verbatim in a `vsdb_page` subquery so the
 * caller-supplied WHERE / ORDER BY / paging clauses apply at the outer
 * level regardless of what the inner query already contains. A trailing
 * `;` on the inner SQL is stripped before wrapping.
 *
 * - postgres/mysql: `LIMIT {limit} OFFSET {offset}` (offset is emitted even
 *   when 0).
 * - mssql: `OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY`. T-SQL
 *   rejects OFFSET without an ORDER BY, so when the caller supplies none an
 *   `ORDER BY (SELECT NULL)` placeholder is injected (kept when the caller
 *   DOES supply an ORDER BY).
 */
export function buildPagedQuery(
  sql: string,
  where: string,
  orderBy: string,
  offset: number,
  limit: number,
  dialect: Dialect,
): string {
  const inner = stripTrailingSemicolon(sql).trim();
  const whereClause = where.trim().length ? ` WHERE ${where.trim()}` : "";
  const orderClause = orderBy.trim().length
    ? ` ORDER BY ${orderBy.trim()}`
    : dialect === "mssql"
      ? ` ORDER BY (SELECT NULL)`
      : "";
  const pageClause =
    dialect === "mssql"
      ? ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
      : ` LIMIT ${limit} OFFSET ${offset}`;
  return `SELECT * FROM (${inner}) vsdb_page${whereClause}${orderClause}${pageClause}`;
}

/**
 * Dispatch the table-sort composition per dialect.
 *
 * postgres/mysql: composed inline byte-identical to the adapters' helpers —
 * the same subquery wrap, quoted identifier and ASC/DESC whitelist — keeping
 * this module free of the pg/mysql2 drivers so it stays importable from the
 * webview bundle. mssql (TASK-006): delegates to `getTableSortQuery`
 * (src/adapters/mssql.ts) so the T-SQL lives in exactly one place; the
 * adapter's `ORDER BY [col] ASC|DESC` is also what T-SQL `OFFSET/FETCH`
 * paging (see `buildPagedQuery`) can attach to.
 *
 *   composeSortQuery("postgres", "SELECT 1", "", "name", "ASC")
 *     → `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY "name" ASC`
 *   composeSortQuery("mssql", "SELECT 1", "", "name", "ASC")
 *     → `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY [name] ASC`
 */
export function composeSortQuery(
  dialect: Dialect,
  originalSql: string,
  whereFromBar: string,
  column: string,
  direction: "ASC" | "DESC",
): string {
  if (dialect === "mssql") {
    return getTableSortQuery(originalSql, whereFromBar, column, direction);
  }
  const inner = originalSql.trim();
  const quotedColumn = quoteIdent(column, dialect);
  const dir = direction === "DESC" ? "DESC" : "ASC";
  const whereClause = whereFromBar.trim().length
    ? ` WHERE ${whereFromBar.trim()}`
    : "";
  return `SELECT * FROM (${inner}) vsdb_sort${whereClause} ORDER BY ${quotedColumn} ${dir}`;
}
