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
import { stripTrailingSemicolon } from "../core/text";
import { quoteIdent, type Dialect } from "../core/saveStatements";
import { getTableSortQuery } from "../adapters/mssql";
import { getTableSortQuery as mysqlGetTableSortQuery } from "../adapters/mysql";

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
 * Options for `buildFilterWhere`. `columnTypes` maps a column name to its
 * DECLARED DB type (e.g. `ColumnInfo.dataType`: "varchar", "int4",
 * "nvarchar(50)"). A string-typed column's `(Blanks)` predicate also matches
 * `''` (`col IS NULL OR col = ''`); absent / unknown / empty type ⇒ false ⇒
 * bare `col IS NULL` (cycle-V behaviour). The decision is static from the
 * declared type — NEVER derived from sniffing loaded row values (PLAN §3.3:
 * row-sniffing is page-dependent and inert for an all-NULL varchar window).
 */
export interface FilterWhereOptions {
  columnTypes?: Record<string, string>;
}

/** True when a declared DB type is in the string family, so `(Blanks)` should
 *  also match `''`. Normalized via trim().toLowerCase(); matches by bounded
 *  prefix / exact-name families so `context_id` and `textbook_code` stay
 *  false. Unknown ⇒ false — the failure mode is "fix did not fire", never a
 *  type error against an integer/date column. */
function isStringColumnType(declared: string | undefined): boolean {
  if (!declared) return false;
  const t = declared.trim().toLowerCase();
  if (t.length === 0) return false;
  // Exact base tokens (optionally with a modifier/size suffix like "(50)" or
  // "('a','b')"). Family-bounded: `charset`, `enumeration`, `setting` etc. do
  // NOT match — an unknown type must stay false (NULL-only `(Blanks)`).
  if (/^(character varying|character|char|varchar|nchar|nvarchar|enum|set)(\s*\(|$)/.test(t)) {
    return true;
  }
  // TEXT family — exact base names or the (tiny|medium|long)text suffix rule.
  if (/^(tiny|medium|long)?text$/.test(t) || t === "ntext") return true;
  if (t === "citext" || t === "cstring") return true;
  return false;
}

/** Match a string column that is entirely whitespace — the server-side twin
 *  of the client's `String.trim() === ""` blank classifier (resultsGridModel
 *  `isBlankFilterValue`). Plain `TRIM(col) = ''` strips spaces only on every
 *  dialect and would return zero rows for a tab-only cell the client already
 *  grouped into `(Blanks)`, so emit a whitespace-complete predicate per
 *  dialect: POSIX `[[:space:]]` regex for postgres/mysql, a negated LIKE char
 *  class for mssql (which has no built-in regex). Empty string matches all
 *  three. */
function blankStringPredicate(quoted: string, dialect: Dialect): string {
  if (dialect === "mssql") return `${quoted} NOT LIKE '%[^ \t\r\n\f\v]%'`;
  if (dialect === "mysql") return `${quoted} REGEXP '^[[:space:]]*$'`;
  return `${quoted} ~ '^[[:space:]]*$'`;
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
  options?: FilterWhereOptions,
): string {
  const predicates: string[] = [];
  for (const [field, model] of Object.entries(filters)) {
    const values = model.values;
    if (!Array.isArray(values) || values.length === 0) continue;
    const typed = model.typed;
    const useTyped = Array.isArray(typed) && typed.length === values.length;

    const quoted = quoteIdent(field, dialect);
    const stringTyped = isStringColumnType(options?.columnTypes?.[field]);
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
    if (hasNull && stringTyped) parts.push(blankStringPredicate(quoted, dialect));
    if (inList.length > 0) parts.push(`${quoted} IN (${inList.join(", ")})`);
    if (parts.length === 0) continue;

    predicates.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }
  return predicates.join(" AND ");
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
 * A single ORDER BY term as parsed by `parseOrderBy`. `column` is the
 * UNQUOTED logical name (delimiters already stripped, escapes un-doubled) —
 * exactly what `quoteIdent` expects, so a raw user identifier never reaches
 * SQL unquoted.
 */
export interface OrderByTerm {
  column: string;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}

export type ParseOrderByResult =
  | { ok: true; terms: OrderByTerm[] }
  | { ok: false; error: string };

/** Bare identifier charset — the same set `SIMPLE_ORDER_BY_RE` accepted in
 *  cycle V, so today's accepted inputs are a strict subset of this parser's. */
const BARE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Per-dialect quoted-identifier unquote: strip the matching delimiters and
 *  un-double the embedded escape. Returns the logical name, or null when the
 *  token is not quoted in THIS style (or the quotes are unbalanced). */
function unquoteIdent(token: string, style: "pg" | "backtick" | "bracket"): string | null {
  const [open, close] =
    style === "pg" ? ['"', '"'] : style === "backtick" ? ["`", "`"] : ["[", "]"];
  if (token.length < 2 || !token.startsWith(open) || !token.endsWith(close)) return null;
  // Guard: the trailing delimiter must not itself be an escaped one.
  if (token.length >= 2 * open.length + close.length + 0) {
    // For pg/mysql the escape is the doubled delimiter: a token like `"a""`
    // would end with the delimiter but its inner remainder ends with an
    // escape — treat as unbalanced below via the scan.
  }
  let inner = "";
  let i = open.length;
  while (i < token.length) {
    if (token.startsWith(token[i] === close ? close : "", i) && token[i] === close) {
      // possible close or doubled escape
      if (token.startsWith(close + close, i)) {
        inner += close;
        i += close.length * 2;
        continue;
      }
      // real close — must be the last char
      if (i === token.length - close.length) return inner;
      return null;
    }
    inner += token[i];
    i += 1;
  }
  return null;
}

/** Reject any logical identifier that quoting cannot make safe (mirrors
 *  `isSafeIdent` in saveStatements): empty or embedded control characters. */
function isSafeLogicalIdent(name: string): boolean {
  return name.length > 0 && !/[\x00-\x1f]/.test(name);
}

/**
 * Parse a multi-term ORDER BY string into typed terms.
 *
 * Accepted column forms (exactly two — nothing else):
 *  1. Bare `[A-Za-z_][A-Za-z0-9_$]*`.
 *  2. Already quoted in the ACTIVE dialect's style (`"…"` pg, `` `…` `` mysql,
 *     `[…]` mssql); delimiters stripped and doubled escapes un-doubled into a
 *     logical name. When `dialect` is omitted all three styles are accepted
 *     (pure-builder use); a mismatched live style is NOT unquoted — it only
 *     passes as a bare token if it matches the bare charset (which delimiters
 *     never do), otherwise it is rejected with the standard error.
 *
 * Grammar per term: `identifier [ASC|DESC] [NULLS FIRST|NULLS LAST]`.
 * Function calls, parentheses, dotted qualifiers, ordinals and `*` are all
 * rejected. Empty / whitespace-only input is `{ ok: true, terms: [] }` — the
 * normal state of the requery bar, meaning "no ORDER BY clause".
 *
 * `NULLS` under mysql/mssql is rejected (`{ ok: false }` naming the clause):
 * those dialects have no NULLS syntax and this cycle does not emulate it.
 */
export function parseOrderBy(orderBy: string, dialect?: Dialect): ParseOrderByResult {
  const trimmed = orderBy.trim();
  if (trimmed.length === 0) return { ok: true, terms: [] };
  const rawTerms = splitTopLevel(trimmed);
  const terms: OrderByTerm[] = [];
  for (const raw of rawTerms) {
    const text = raw.trim();
    if (text.length === 0) {
      return { ok: false, error: "ORDER BY contains an empty term." };
    }
    // Split the column part from the trailing ASC/DESC/NULLS keywords. The
    // column part may be quoted (and therefore contain spaces), so the
    // keyword split must respect quotes: scan for the LAST run of keywords.
    const parsed = splitTermKeywords(text);
    if (parsed === null) {
      return { ok: false, error: `"${text}" is not a plain column name with optional ASC/DESC/NULLS — expressions are not supported in ORDER BY.` };
    }
    let { column, direction, nulls } = parsed;
    // Resolve the column token: quoted-in-active-style first, then bare.
    const logical = resolveColumnToken(column, dialect);
    if (logical === null) {
      return { ok: false, error: `"${column}" is not a plain column name (or a correctly quoted identifier) usable in ORDER BY.` };
    }
    if (nulls && dialect && dialect !== "postgres") {
      return { ok: false, error: `NULLS ${nulls} is not supported by the ${dialect} dialect; only PostgreSQL renders NULLS FIRST/LAST natively.` };
    }
    terms.push({ column: logical, direction, ...(nulls ? { nulls } : {}) });
  }
  return { ok: true, terms };
}

/** Split an ORDER BY string on commas that are OUTSIDE any quoted identifier,
 *  honoring each style's doubled escape ("" / `` / ]]) so a comma inside a
 *  quoted identifier — `"my,col"` — stays in one term. */
function splitTopLevel(orderBy: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  const openers: Record<string, string> = { '"': '"', "`": "`", "[": "]" };
  while (i < orderBy.length) {
    const ch = orderBy[i];
    const close = openers[ch];
    if (close) {
      // Copy the whole quoted section (including delimiters) verbatim.
      let j = i + 1;
      while (j < orderBy.length) {
        if (orderBy[j] === close) {
          if (j + 1 < orderBy.length && orderBy[j + 1] === close) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      // Unterminated quote: copy the rest; the term parser rejects it later.
      const end = j < orderBy.length ? j + 1 : orderBy.length;
      current += orderBy.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts;
}

/** Split `ident[ ASC|DESC][ NULLS FIRST|NULLS LAST]` respecting quoted identifiers.
 *  Returns null when the keyword section is malformed or empty. */
function splitTermKeywords(text: string): { column: string; direction: "ASC" | "DESC"; nulls?: "FIRST" | "LAST" } | null {
  // Find where the identifier ends: scan right while the char is a bare
  // identifier char OR we are inside a quoted section (quotes may contain
  // spaces and escaped delimiters). The first whitespace AFTER the identifier
  // starts the keyword section — but a bare identifier never contains a
  // space, so the split point is simply the first whitespace that is not
  // inside quotes.
  const quotePairs: Array<[string, string]> = [['"', '"'], ["`", "`"], ["[", "]"]];
  let identEnd = text.length;
  let i = 0;
  while (i < text.length) {
    const pair = quotePairs.find(([o]) => text[i] === o);
    if (pair) {
      const [, c] = pair;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === c) {
          if (j + 1 < text.length && text[j + 1] === c) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      if (j >= text.length) return null; // unterminated quote
      i = j + 1;
      continue;
    }
    if (/\s/.test(text[i])) { identEnd = i; break; }
    i += 1;
  }
  const column = text.slice(0, identEnd).trim();
  const rest = text.slice(identEnd).trim();
  if (column.length === 0) return null;
  if (rest.length === 0) return { column, direction: "ASC" };
  const m = /^(ASC|DESC)?\s*(?:(NULLS)\s+(FIRST|LAST))?$/i.exec(rest);
  if (!m) return null;
  const direction = (m[1] ? m[1].toUpperCase() : "ASC") as "ASC" | "DESC";
  const nulls = m[3] ? (m[3].toUpperCase() as "FIRST" | "LAST") : undefined;
  return { column, direction, ...(nulls ? { nulls } : {}) };
}

/** Resolve a column token to its logical (unquoted) name, or null when it is
 *  not accepted. Bare charset first; then the active dialect's quote style
 *  (or all three when no dialect is supplied). */
function resolveColumnToken(token: string, dialect?: Dialect): string | null {
  if (BARE_IDENT_RE.test(token)) return token;
  const styles: Array<"pg" | "backtick" | "bracket"> = dialect
    ? dialect === "postgres"
      ? ["pg"]
      : dialect === "mysql"
        ? ["backtick"]
        : ["bracket"]
    : ["pg", "backtick", "bracket"];
  for (const s of styles) {
    const logical = unquoteIdent(token, s);
    if (logical !== null && isSafeLogicalIdent(logical)) return logical;
  }
  return null;
}

/**
 * Render parsed terms as a dialect-quoted ORDER BY clause (without the
 * `ORDER BY` keyword). Every identifier goes through `quoteIdent` — quoted
 * input is canonicalized, never passed through. `NULLS FIRST|LAST` renders
 * natively (postgres); parseOrderBy already rejected `nulls` under
 * mysql/mssql, so this branch is postgres-only in practice.
 */
export function buildOrderByClause(terms: OrderByTerm[], dialect: Dialect): string {
  return terms
    .map((t) => {
      const ident = quoteIdent(t.column, dialect);
      const nulls = t.nulls ? ` NULLS ${t.nulls}` : "";
      return `${ident} ${t.direction}${nulls}`;
    })
    .join(", ");
}

/**
 * `buildPagedQuery` over parsed ORDER BY terms plus PK tiebreakers (PLAN §3.2).
 *
 * Every tiebreaker column NOT already present in `terms` (exact, case-
 * sensitive identifier comparison — we always emit quoted, so `"Id"` and
 * `"id"` are genuinely different columns) is appended `ASC` in its declared
 * PK order. With all PK components trailing the user terms, ordering is total
 * and OFFSET/FETCH pages are disjoint and gap-free. `tiebreakers: []` (no
 * usable full PK) keeps the output byte-identical to `buildPagedQuery` — the
 * UI makes no gap-free promise then.
 */
export function buildPagedQueryTerms(
  sql: string,
  where: string,
  terms: OrderByTerm[],
  offset: number,
  limit: number,
  dialect: Dialect,
  tiebreakers: string[],
): string {
  const existing = new Set(terms.map((t) => t.column));
  const all = [...terms];
  for (const pk of tiebreakers) {
    if (!existing.has(pk)) {
      all.push({ column: pk, direction: "ASC" });
      existing.add(pk);
    }
  }
  const orderBy =
    all.length > 0 ? buildOrderByClause(all, dialect) : "";
  return buildPagedQuery(sql, where, orderBy, offset, limit, dialect);
}

/**
 * Dispatch the table-sort composition per dialect.
 *
 * postgres: composed inline byte-identical to the adapter helper — keeping
 * this module free of the pg driver so it stays importable from the webview
 * bundle. mysql/mssql (TASK-005/TASK-006): delegates to the adapter twins
 * `getTableSortQuery` (src/adapters/mysql.ts, src/adapters/mssql.ts) so each
 * dialect's SQL lives in exactly one place; both arms are consumed host-side
 * only (the webview never imports the mysql2/tedious drivers). The adapters'
 * `ORDER BY col ASC|DESC` is also what dialect paging (`buildPagedQuery`) can
 * attach to.
 *
 *   composeSortQuery("postgres", "SELECT 1", "", "name", "ASC")
 *     → `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY "name" ASC`
 *   composeSortQuery("mysql", "SELECT 1", "", "name", "ASC")
 *     → `SELECT * FROM (SELECT 1) vsdb_sort ORDER BY `name` ASC`
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
  if (dialect === "mysql") {
    return mysqlGetTableSortQuery(originalSql, whereFromBar, column, direction);
  }
  const inner = originalSql.trim();
  const quotedColumn = quoteIdent(column, dialect);
  const dir = direction === "DESC" ? "DESC" : "ASC";
  const whereClause = whereFromBar.trim().length
    ? ` WHERE ${whereFromBar.trim()}`
    : "";
  return `SELECT * FROM (${inner}) vsdb_sort${whereClause} ORDER BY ${quotedColumn} ${dir}`;
}
