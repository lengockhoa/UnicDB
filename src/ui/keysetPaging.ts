// src/ui/keysetPaging.ts
//
// TASK-004 (cycle Y) — keyset (cursor) paging and safe missing-PK projection.
//
// Contract A — direct-browse only, enforced by a structural gate:
//   `assertBrowseShape` accepts ONLY plain single-table statements —
//   `SELECT *` or an explicit simple identifier list followed by exactly one
//   FROM — with no DISTINCT / GROUP BY / HAVING / window / set-operator /
//   UNION / join / scalar-subquery shape OUTSIDE string literals and
//   comments. Single-table provenance is delegated to the proven
//   string/comment-aware scanner `parseFromClause` (saveStatements.ts); this
//   module layers the projection/tail checks on top and never re-implements
//   table parsing. Under that gate AND a proven total order, the last visible
//   row's key becomes a portable OR-of-ANDs keyset predicate (NO row-value
//   constructor — works on postgres, mysql AND mssql) replacing deep OFFSET.
//   Missing PK columns of a gated explicit projection can be appended
//   ("hidden columns") so paging keys stay available; the caller strips them
//   from the displayed result. Every other shape keeps today's OFFSET
//   behaviour byte-identically.
//
// Pure module: no DOM, no vscode, no driver import. Dependencies are the
// browser-safe `quoteIdent`, `stripTrailingSemicolon` and queryComposer's
// composing helpers — the same import set resultsPanel already carries.
import { parseFromClause, quoteIdent, type Dialect } from "../core/saveStatements";
import { stripTrailingSemicolon } from "../core/text";
import {
  buildOrderByClause,
  buildPagedQuery,
  type OrderByTerm,
} from "./queryComposer";

// ---------------------------------------------------------------------------
// Shared string/comment-aware scanning primitives
// ---------------------------------------------------------------------------

interface ScanState {
  inString: boolean;
  /** Open block-comment nesting depth (nested per the SQL standard). */
  inBlockComment: number;
  inLineComment: boolean;
}

/** Starting at code position `i` (outside strings/comments), skip forward
 *  through strings and comments. Returns the next code position, or -1 when
 *  the input is drained. `s` carries state across calls. */
function scanNextCodePos(sql: string, i: number, s: ScanState): number {
  let j = i;
  while (j < sql.length) {
    const c = sql[j];
    if (c === "'" && !s.inLineComment && s.inBlockComment === 0) {
      // Single-quoted literal; '' is one escaped delimiter.
      j++;
      while (j < sql.length) {
        if (sql.startsWith("''", j)) {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      continue;
    }
    if (c === "-" && sql[j + 1] === "-" && s.inBlockComment === 0) {
      while (j < sql.length && sql[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && sql[j + 1] === "*") {
      s.inBlockComment++;
      j += 2;
      continue;
    }
    if (c === "*" && sql[j + 1] === "/" && s.inBlockComment > 0) {
      s.inBlockComment--;
      j += 2;
      continue;
    }
    if (s.inBlockComment === 0) return j;
    j++;
  }
  return -1;
}

function isKeywordAt(lower: string, i: number, kw: string): boolean {
  if (i + kw.length > lower.length) return false;
  const before = i === 0 ? " " : lower[i - 1];
  const after = lower[i + kw.length] ?? " ";
  return (
    lower.startsWith(kw, i) &&
    !/[A-Za-z0-9_$]/.test(before) &&
    !/[A-Za-z0-9_$]/.test(after)
  );
}

function skipWs(sql: string, i: number): number {
  while (i < sql.length && /\s/.test(sql[i])) i++;
  return i;
}

/** Read one identifier at `i` (already at its first character). Accepts bare
 *  names plus `"…"`, `` `…` `` and `[…]` quoted styles, returning the LOGICAL
 *  name (delimiters stripped, escapes un-doubled), or null. */
function readIdentifier(
  sql: string,
  i: number,
): { name: string; end: number } | null {
  const c = sql[i];
  if (c === undefined) return null;
  if (c === '"' || c === "`" || c === "[") {
    const close = c === "[" ? "]" : c;
    let name = "";
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === close) {
        // Doubled escape ("" / `` / ]]) folds into one delimiter char
        // (mssql's ]] doubling folds to ']'; keep the bracket rule uniform).
        if (sql[j + 1] === close) {
          name += close === "]" ? "]" : close;
          j += close === "]" ? 2 : 2;
          continue;
        }
        return { name, end: j + 1 };
      }
      name += sql[j];
      j++;
    }
    return null; // unterminated quote
  }
  if (!/[A-Za-z0-9_$]/.test(c)) return null;
  let j = i;
  while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
  return { name: sql.slice(i, j), end: j };
}

/** Byte offset of the FIRST top-level FROM keyword outside strings/comments. */
function findFirstFrom(sql: string): number {
  const lower = sql.toLowerCase();
  const s: ScanState = { inString: false, inBlockComment: 0, inLineComment: false };
  let i = 0;
  for (;;) {
    i = scanNextCodePos(sql, i, s);
    if (i === -1) return -1;
    if (isKeywordAt(lower, i, "from")) return i;
    i++;
  }
}

// ---------------------------------------------------------------------------
// Structural gate
// ---------------------------------------------------------------------------

/** Result of the browse-shape gate for one SQL statement. */
export interface BrowseShape {
  /** `"*"` for star projections; otherwise the explicit projection list in
   *  written order, unquoted to logical names. */
  columns: string[] | "*";
  schema?: string;
  table: string;
}

/** Tokens that instantly disqualify the statement from the browse gate when
 *  they appear OUTSIDE the head's own keyword positions — i.e. in the
 *  projection list, immediately around the FROM reference, or in the tail.
 *  Scan is word-bounded, case-insensitive, string/comment-aware. */
const REFUSE_TOKENS = [
  "distinct",
  "group",
  "having",
  "over",
  "union",
  "intersect",
  "except",
  "minus",
  "window",
  "fetch",
] as const;

/** Tokens allowed to OPEN a tail clause after the table reference. Anything
 *  else appearing at a clause-start position keeps the statement ungated. */
const TAIL_CLAUSE_STARTERS = ["where", "order", "limit", "offset"] as const;

/**
 * Structural gate. Returns a non-null shape ONLY for a plain
 * `SELECT * | col-list FROM [[schema.]table][ trailing clauses…]` statement
 * (one optional trailing `;` stripped first). DISTINCT / aggregates /
 * GROUP BY / HAVING / window functions / set operators / joins / CTEs /
 * scalar-subquery projections all refuse (null). Consistent with
 * `parseFromClause`'s provenance scanning — for accepted statements the
 * returned (schema, table) IS `parseFromClause`'s result.
 */
export function assertBrowseShape(rawSql: string): BrowseShape | null {
  const sql = stripTrailingSemicolon(rawSql).trim();
  const lower = sql.toLowerCase();
  if (!/^select\b/.test(lower)) return null;

  const firstFrom = findFirstFrom(sql);
  if (firstFrom < 0) return null;

  // ---- head: the projection list between SELECT and FROM ------------------
  const columns = parseProjectionList(sql.slice(0, firstFrom));
  if (columns === null) return null;

  // Head must contain no refused tokens (a comment/literal mentioning them
  // is skipped by the scanner, which is the point of the gate).
  if (rangeHasRefusedToken(sql, 0, firstFrom)) return null;

  // ---- table reference directly after FROM --------------------------------
  let i = skipWs(sql, firstFrom + 4);
  // Consume [schema.]table — identifiers possibly quoted, dot-joined.
  let tableName = "";
  const firstIdent = readIdentifier(sql, i);
  if (!firstIdent) return null;
  tableName = firstIdent.name;
  let cursor = skipWs(sql, firstIdent.end);
  if (sql[cursor] === ".") {
    const second = readIdentifier(sql, skipWs(sql, cursor + 1));
    if (!second) return null;
    tableName = second.name;
    cursor = skipWs(sql, second.end);
  }

  // ---- tail: trailing clauses after the table reference --------------------
  if (tailIsUngated(sql, cursor)) return null;

  // Provenance cross-check: the shared host parser must agree on the table
  // identity for this statement (keeps producer typing in sync by contract).
  const parsed = parseFromClause(sql);
  if (!parsed || parsed.table.toLowerCase() !== tableName.toLowerCase()) {
    return null;
  }
  void lower;
  return {
    columns,
    ...(parsed.schema ? { schema: parsed.schema } : {}),
    table: parsed.table,
  };
}

/** True when any REFUSE_TOKEN occurs between `from` and `to` outside
 *  strings/comments. */
function rangeHasRefusedToken(sql: string, from: number, to: number): boolean {
  const lower = sql.toLowerCase();
  const s: ScanState = { inString: false, inBlockComment: 0, inLineComment: false };
  let i = from;
  while (i < to) {
    i = scanNextCodePos(sql, i, s);
    if (i === -1 || i >= to) break;
    for (const k of REFUSE_TOKENS) {
      if (isKeywordAt(lower, i, k)) return true;
    }
    if (sql[i] === "(") return true; // functions/subqueries in projection
    i++;
  }
  return false;
}

/** Walk the tail after the table reference. True (= refuse) when it carries
 *  any shape that breaks single-table browse provenance: comma joins or
 *  aliases directly beside the table reference, parens (subqueries/function
 *  calls), extra FROM/join, or refused tokens (GROUP/HAVING/set-ops/window/
 *  FETCH). A plain `WHERE <expression>` / `ORDER BY <cols>` / LIMIT/OFFSET
 *  tail is fine — gating only needs the projection + provenance, which are
 *  already fixed above it; expression interiors can hide nothing relevant. */
function tailIsUngated(sql: string, start: number): boolean {
  const lower = sql.toLowerCase();
  const s: ScanState = { inString: false, inBlockComment: 0, inLineComment: false };
  let i = start;
  // Only whitespace may sit between the table reference and whatever comes
  // next; any other first character there is an alias (…FROM t alias).
  let adjacentToTableRef = true;
  for (;;) {
    i = scanNextCodePos(sql, i, s);
    if (i === -1) return false; // drained — clean tail
    const c = sql[i];
    if (adjacentToTableRef) {
      if (/[\s;]/.test(c)) {
        i++;
        continue;
      }
      if (isKeywordAt(lower, i, "where") || isKeywordAt(lower, i, "order") ||
          isKeywordAt(lower, i, "limit") || isKeywordAt(lower, i, "offset")) {
        adjacentToTableRef = false;
        i++;
        continue;
      }
      return true; // alias / CROSS APPLY / second table …
    }
    if (c === "(" || c === "," || c === ")") return true;
    for (const k of REFUSE_TOKENS) {
      if (isKeywordAt(lower, i, k)) return true;
    }
    if (isKeywordAt(lower, i, "from") || isKeywordAt(lower, i, "join")) return true;
    i++;
  }
}

// ---------------------------------------------------------------------------
// Projection-list parsing
// ---------------------------------------------------------------------------

/** Parse the head (`SELECT <list>` text) into a projection spec.
 *  "*" for a bare star; an array of logical names for a simple list of
 *  identifiers (bare or quoted, any of the three styles); null otherwise —
 *  expressions, dotted refs, aliases, ordinals, multiple stars all refuse.
 *  Strings/comments inside the list are transparent to the splitter (they
 *  cannot appear in an accepted list anyway; their presence alongside real
 *  items yields null through the item grammar). */
function parseProjectionList(headText: string): string[] | "*" | null {
  const trimmed = headText.trim();
  if (!/^select\b/i.test(trimmed)) return null;
  const listText = trimmed.slice(6).trim();
  if (listText.length === 0) return null;
  if (listText === "*") return "*";

  const s: ScanState = { inString: false, inBlockComment: 0, inLineComment: false };
  const items: string[] = [];
  let itemStart = 0;
  let i = 0;
  for (;;) {
    i = scanNextCodePos(listText, i, s);
    if (i === -1) break;
    if (listText[i] === ",") {
      if (!pushProjectionItem(items, listText.slice(itemStart, i))) return null;
      itemStart = i + 1;
    }
    i++;
  }
  const tail = listText.slice(itemStart);
  if (!pushProjectionItem(items, tail)) return null;
  return items;
}

/** Validate ONE projection item: bare identifier or one quoted token.
 *  Comments are stripped first (the scanner may leave them mid-token). */
function pushProjectionItem(items: string[], rawItem: string): boolean {
  let item = rawItem
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (item.length === 0) return false;
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(item)) {
    items.push(item);
    return true;
  }
  const unquoted = unquoteSingleToken(item);
  if (unquoted !== null) {
    items.push(unquoted);
    return true;
  }
  return false;
}

/** Unquote ONE quoted-style token to its logical name; null otherwise. */
function unquoteSingleToken(token: string): string | null {
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "`" && last === "`")) {
    const inner = token.slice(1, -1);
    if (inner.includes(first)) {
      // Doubled escapes only — a stray raw delimiter refuses.
      return inner.split(first + first).join(first).includes(first)
        ? null
        : inner.split(first + first).join(first);
    }
    return inner;
  }
  if (first === "[" && last === "]") {
    const inner = token.slice(1, -1);
    if (inner.includes("]")) {
      return inner.split("]]").join("]").includes("]") ? null : inner.split("]]").join("]");
    }
    return inner;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keyset composition
// ---------------------------------------------------------------------------

/** One key component taken from the last visible row. */
export interface KeySetValue {
  column: string;
  value: unknown;
}

export interface ComposeKeysetQueryOptions {
  baseSql: string;
  where: string;
  terms: OrderByTerm[];
  /** Declared PK columns (candidate tiebreaker order). */
  tiebreakers: string[];
  /** Last visible row's ordered-column values; presence unlocks keyset. */
  lastKey?: KeySetValue[];
  offset: number;
  limit: number;
  dialect: Dialect;
  /** Contract A (ii): allow widening a gated explicit projection with the
   *  missing tiebreaker/PK columns (returned via `hiddenColumns`). */
  widenPkWithHidden?: boolean;
}

export interface ComposeKeysetQueryResult {
  sql: string;
  /** Column names appended by the projection widening, in declared PK order.
   *  Absent when nothing was appended. */
  hiddenColumns?: string[];
}

/**
 * Compose the next page's SQL.
 *
 *  - Page 0 without a key (`offset === 0 && !lastKey`) → byte-identical to
 *    `buildPagedQueryTerms(sql, where, terms, 0, limit, dialect, tiebreakers)`
 *    EXCEPT when `widenPkWithHidden` widens a gated missing-PK projection:
 *    the widening inserts hidden columns INSIDE the base projection, while
 *    the page composition itself stays identical.
 *  - Keyset lane: `lastKey` present AND the total order is proven
 *    (non-empty declared PK fully among the ordered columns) AND every key
 *    entry lines up with its ordered column carrying a plain value →
 *    the OR-of-ANDs lexicographic predicate replaces OFFSET entirely
 *    (postgres/mysql `LIMIT n`; mssql `TOP n`).
 *  - Anything else → today's OFFSET fallback verbatim.
 */
export function composeKeysetQuery(
  opts: ComposeKeysetQueryOptions,
): ComposeKeysetQueryResult {
  const { baseSql, where, terms, tiebreakers, offset, limit, dialect } = opts;
  const whereTrim = where.trim();

  // Ordered terms: retain every user-supplied field (including optional
  // fields added to OrderByTerm in parallel work), then append PK
  // tiebreakers without null ordering. This is the single source of truth
  // for both ORDER BY rendering and the keyset column/direction view.
  const allOrderedTerms: OrderByTerm[] = terms.map((t) => ({ ...t }));
  const seen = new Set(allOrderedTerms.map((t) => t.column));
  for (const pk of tiebreakers) {
    if (!seen.has(pk)) {
      allOrderedTerms.push({ column: pk, direction: "ASC" });
      seen.add(pk);
    }
  }
  const orderedColumns = allOrderedTerms.map(({ column, direction }) => ({
    column,
    direction,
  }));

  // ---- widening (Contract A ii) — applies on every lane --------------------
  let innerSql = stripTrailingSemicolon(baseSql).trim();
  let hiddenColumns: string[] | undefined;
  if (opts.widenPkWithHidden && orderedColumns.length > 0) {
    const widened = widenProjection(
      innerSql,
      orderedColumns.map((o) => o.column),
      dialect,
    );
    if (widened && widened.added.length > 0) {
      innerSql = widened.sql;
      hiddenColumns = widened.added;
    }
  }

  // ---- keyset eligibility ---------------------------------------------------
  const lastKey = opts.lastKey;
  const totalOrderProven =
    tiebreakers.length > 0 &&
    orderedColumns.length >= tiebreakers.length &&
    orderedColumns
      .slice(-tiebreakers.length)
      .every((o) => tiebreakers.includes(o.column));
  const isPlainValue = (v: unknown): boolean =>
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint" ||
    typeof v === "string" ||
    v instanceof Date;
  const usableKey =
    !!lastKey &&
    lastKey.length > 0 &&
    lastKey.every((k) => isPlainValue(k.value));
  // Raw scalar comparisons cannot model the null ranking emitted by
  // buildOrderByClause, so NULLS-ordered terms must always use OFFSET.
  const hasNullOrdering = terms.some((t) => t.nulls !== undefined);

  if (
    hasNullOrdering ||
    !usableKey ||

    !totalOrderProven ||
    lastKey!.length !== orderedColumns.length ||
    !orderedColumns.every((o, idx) => lastKey![idx]!.column === o.column)
  ) {
    // Fallback: legacy OFFSET composition (with whatever widening applied —
    // widening alone is OFFSET-safe because the full PK trails the order).
    return {
      sql: buildPagedQuery(
        innerSql,
        whereTrim,
        buildOrderByClause(allOrderedTerms, dialect),
        offset,
        limit,
        dialect,
      ),
      ...(hiddenColumns ? { hiddenColumns } : {}),
    };
  }

  // ---- portable OR-of-ANDs keyset predicate ---------------------------------
  const predicate = keysetPredicate(lastKey!, orderedColumns, dialect);
  const predicateWhere =
    whereTrim.length > 0 ? `${whereTrim} AND ${predicate}` : predicate;
  const orderBy = buildOrderByClause(allOrderedTerms, dialect);
  const sql =
    dialect === "mssql"
      ? `SELECT TOP ${limit} * FROM (${innerSql}) vsdb_page WHERE ${predicateWhere} ORDER BY ${orderBy}`
      : `SELECT * FROM (${innerSql}) vsdb_page WHERE ${predicateWhere} ORDER BY ${orderBy} LIMIT ${limit}`;
  return {
    sql,
    ...(hiddenColumns ? { hiddenColumns } : {}),
  };
}

/** Lexicographic "strictly after the last visible row" predicate.
 *
 *  Single column:  ("id" > 42)
 *  Composite:      (("a" < 1) OR ("a" = 1 AND "b" > 2))
 *
 *  Comparison direction follows the ordered column's direction (ASC → ">",
 *  DESC → "<"). Every identifier goes through `quoteIdent`; values through
 *  the same escaping posture as `sqlLiteral`. Plain (term, direction)
 *  tuples keep the clause free of row-value constructors on all three
 *  shipped dialects. NULL key values never reach here (eligibility filter). */
function keysetPredicate(
  key: Array<{ column: string; value: unknown }>,
  ordered: Array<{ column: string; direction: "ASC" | "DESC" }>,
  dialect: Dialect,
): string {
  const terms: string[] = [];
  for (let pos = 0; pos < key.length; pos++) {
    const conds: string[] = [];
    for (let j = 0; j < pos; j++) {
      conds.push(
        `${quoteIdent(key[j].column, dialect)} = ${literalForKey(key[j].value)}`,
      );
    }
    const cmp = ordered[pos].direction === "DESC" ? "<" : ">";
    conds.push(
      `${quoteIdent(key[pos].column, dialect)} ${cmp} ${literalForKey(key[pos].value)}`,
    );
    terms.push(`(${conds.join(" AND ")})`);
  }
  return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
}

/** Serialize a keyset comparison value. Values come from the host's own
 *  result rows (not user input) and mirror `sqlLiteral`'s escaping posture
 *  (single-quote doubling, no backslash escapes) without importing the
 *  grid model into this pure module. */
function literalForKey(v: unknown): string {
  if (typeof v === "number") {
    if (Number.isNaN(v) || !Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return `'${v.toISOString().replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Projection widening (missing-PK columns)
// ---------------------------------------------------------------------------

/** Rewrite a gated `SELECT <list> FROM …` statement, appending any `wanted`
 *  column missing from `<list>`. Appended names are inserted dialect-quoted.
 *  Star projections gain nothing (already carry every column). Non-gated
 *  statements return null — callers treat that as "leave unchanged". */
function widenProjection(
  innerSql: string,
  wanted: string[],
  dialect: Dialect,
): { sql: string; added: string[] } | null {
  const shape = assertBrowseShape(innerSql);
  if (!shape) return null;
  if (shape.columns === "*") return { sql: innerSql, added: [] };
  const existing = new Set(shape.columns.map((c) => c.toLowerCase()));
  const added: string[] = [];
  for (const w of wanted) {
    if (!existing.has(w.toLowerCase())) added.push(w);
  }
  if (added.length === 0) return { sql: innerSql, added: [] };

  const firstFrom = findFirstFrom(innerSql);
  if (firstFrom < 0) return null;
  const head = innerSql.slice(0, firstFrom).replace(/\s+$/, "");
  const quotedAdded = added.map((c) => quoteIdent(c, dialect));
  return {
    sql: `${head}, ${quotedAdded.join(", ")} ${innerSql.slice(firstFrom)}`,
    added,
  };
}
