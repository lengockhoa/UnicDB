// src/ui/distinctValues.ts
//
// TASK-002 — Pure DISTINCT-values SQL builder. Composes the query the host
// runs to populate a set-filter dropdown with the distinct values of one
// column across the WHOLE table (the original statement wrapped as a
// subquery), plus the truncation helper that decides whether the returned
// list is complete. Pure module: imports only `quoteIdent` / `Dialect` from
// ../core/saveStatements — no vscode, no pg/mysql2/tedious, no DOM — so it
// stays importable from any context TASK-004 wires it into.
import { stripTrailingSemicolon } from "../core/text";
import { quoteIdent, type Dialect } from "../core/saveStatements";

/** Default cap on how many distinct values the dropdown fetches. Fetching
 *  `limit + 1` rows (the truncation probe) is deliberate: the extra row
 *  tells `takeDistinctValues` the table has MORE distinct values than the
 *  cap, so the webview can keep its loaded-rows fallback entries visible
 *  instead of silently pretending the list was exhaustive. */
export const DISTINCT_VALUES_LIMIT = 1000;

/**
 * Compose the DISTINCT-values query for a set-filter dropdown.
 *
 *   buildDistinctValuesQuery("SELECT * FROM t", "name", "postgres", "")
 *     → `SELECT DISTINCT "name" FROM (SELECT * FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001`
 *
 * The original SQL is wrapped verbatim in a `UnicDB_distinct` subquery
 * (deliberately different from `UnicDB_page` / `UnicDB_sort` so a nested
 * composition can never collide on the alias). The outer projection is
 * exactly one column and sorts by ordinal (`ORDER BY 1`), which is valid on
 * all three dialects, avoids re-quoting the column, and gives MSSQL the
 * deterministic ordering its `TOP` requires. `LIMIT limit + 1` is the
 * truncation probe consumed by `takeDistinctValues`.
 *
 * - postgres/mysql: `… ORDER BY 1 LIMIT {limit + 1}`
 * - mssql: `SELECT DISTINCT TOP ({limit + 1}) … ORDER BY 1` (T-SQL has no
 *   LIMIT).
 */
export function buildDistinctValuesQuery(
  sql: string,
  column: string,
  dialect: Dialect,
  /** Outer-level WHERE. DECIDED (PLAN.md §3.4/§2): TASK-004 calls this with
   *  `""` — the host retains no per-statement WHERE, so the DISTINCT list is
   *  base-statement scoped, not narrowed by the active filter. The parameter
   *  stays in the signature (cases 6-7 exercise it) so a follow-up cycle can
   *  scope it without a signature change. Keep it required. */
  where: string,
  limit?: number, // defaults to DISTINCT_VALUES_LIMIT
): string {
  const cap = limit ?? DISTINCT_VALUES_LIMIT;
  const probe = cap + 1;
  const inner = stripTrailingSemicolon(sql).trim();
  const quotedColumn = quoteIdent(column, dialect);
  const whereClause = where.trim().length ? ` WHERE ${where.trim()}` : "";
  if (dialect === "mssql") {
    return `SELECT DISTINCT TOP (${probe}) ${quotedColumn} FROM (${inner}) UnicDB_distinct${whereClause} ORDER BY 1`;
  }
  return `SELECT DISTINCT ${quotedColumn} FROM (${inner}) UnicDB_distinct${whereClause} ORDER BY 1 LIMIT ${probe}`;
}

/**
 * Reduce the probe-fetched rows to the dropdown's value list.
 *
 *   takeDistinctValues([[1], [2], [3]]) → { values: [1, 2, 3], truncated: false }
 *
 * Each row is expected to be a single-element array (one projected column,
 * see `StatementResult.result.rows: unknown[][]`). Ragged input — non-array
 * entries or empty arrays — is skipped, not crashed on; any non-empty
 * row contributes its FIRST cell as the value (extra columns ignored).
 * NULL survives as `null`. When the input has more than `limit` rows the
 * extra probe row(s) are dropped and `truncated: true` is reported.
 */
export function takeDistinctValues(
  rows: unknown[][],
  limit?: number, // defaults to DISTINCT_VALUES_LIMIT
): { values: unknown[]; truncated: boolean } {
  const cap = limit ?? DISTINCT_VALUES_LIMIT;
  const values: unknown[] = [];
  let truncated = false;
  let count = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 1) continue;
    count += 1;
    if (count > cap) {
      truncated = true;
      break;
    }
    values.push(row[0]);
  }
  return { values, truncated };
}
