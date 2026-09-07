// src/core/schemaEnforce.ts
// Pure helper that prepends a `SET search_path` statement so any SQL run
// on a Postgres adapter executes in the user-selected schema (and falls
// back to `public` when the pinned name doesn't resolve an object).
//
// Why this exists (DataGrip parity):
//   - PostgreSQL's default `search_path` is `"$user", public`. Most
//     users want functions/tables they create to land in the schema
//     they're working in, not in `public`. DataGrip's schema dropdown
//     re-routes every statement by `SET search_path` — that's the
//     minimal contract we mirror here.
//
// Contract:
//   - `withSchemaSearchPath(sql, schema)` returns a NEW string with
//     `SET search_path TO "<schema>", public;` prepended. Original `sql`
//     is not mutated.
//   - Empty / whitespace-only `sql` returns `""` (no point issuing a
//     bare `SET search_path` against nothing).
//   - If the SQL already leads with `SET search_path`, we don't double-
//     prepend — the user's explicit choice wins.
//   - The schema name is always quoted with double-quotes; embedded
//     `"` is escaped by doubling (`""`). This is the standard Postgres
//     quoted-identifier rule, and avoids `search_path` injection on a
//     schema name that somehow contains a quote.
//   - Empty / whitespace `schema` returns the original SQL unchanged
//     (caller already filters non-string inputs — but be defensive).
//
// Dialect scope:
//   - Postgres (and Postgres-compatible forks) accept `SET search_path`.
//     Other adapters (MySQL, MSSQL, BigQuery) are NOT wrapped here — the
//     wrapper in `connectionManager.resolveAdapter` only fires when
//     `cfg.driver === "postgres"`. This file stays driver-agnostic so
//     tests don't have to spin a driver.
//
// Why prepend and not session-level `SET search_path` once:
//   - Pool clients are shared. A session-level `SET` on a pooled client
//     leaks into the next checkout and breaks isolation. Per-statement
//     `SET` is the only safe shape, and is what DataGrip uses too.
import { maskLiteralsAndComments } from "./dangerousStatement";

/**
 * Prepend a `SET search_path TO "<schema>", public;` statement to `sql`
 * so the user's pinned schema becomes the first place Postgres looks
 * for unqualified names. The original `sql` is never mutated.
 *
 * @param sql    The user's SQL (one or more statements).
 * @param schema The schema to pin (DataGrip-parity). Trimmed; empty / null
 *               returns `sql` unchanged.
 */
export function withSchemaSearchPath(
  sql: string,
  schema: string | undefined | null,
): string {
  if (typeof sql !== "string" || sql.length === 0) return sql ?? "";
  if (typeof schema !== "string") return sql;
  const trimmed = schema.trim();
  if (trimmed.length === 0) return sql;
  if (alreadySetsSearchPath(sql)) return sql;
  return `SET search_path TO "${escapeDoubleQuote(trimmed)}", public;\n${sql}`;
}

/**
 * Escape an embedded `"` for a Postgres quoted identifier by doubling it.
 * Standard SQL rule — Postgres follows it without an extension. Names
 * returned by `listSchemas()` are pg_namespace.nspname values and never
 * contain `"`, but the escape keeps the helper safe against a future
 * caller that pre-validates identifiers itself.
 */
function escapeDoubleQuote(name: string): string {
  return name.replace(/"/g, '""');
}

/**
 * Cheap detection — does the SQL already lead with a `SET search_path`?
 * Used so we don't double-prepend when the user explicitly picked a
 * different schema in their own statement (their choice wins).
 *
 * We mask literals/comments first so a `SET search_path` inside a string
 * or comment doesn't trigger a false positive (mirrors the
 * `dangerousStatement.ts` discipline used elsewhere).
 */
function alreadySetsSearchPath(sql: string): boolean {
  const masked = maskLiteralsAndComments(sql);
  return /^\s*SET\s+search_path\b/i.test(masked);
}