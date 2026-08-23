// Adapter-agnostic pg_catalog introspection. Pure SQL constants + pure mapper.
// No vscode/pg imports — SQL strings and row-mappers only.
//
// §Contract: types live in src/core/ddl/createTable.ts (owned by TASK-001).
// This file imports them; if TASK-001 hasn't merged, the type-only placeholder
// in createTable.ts is shape-compatible (drop-in superset).

import type {
  ColumnSpec,
  TableSpec,
  KeySpec,
} from "./createTable";

/** Row shape returned by INTROSPECT_COLUMNS_SQL */
export interface PgColumnRow {
  column_name: string;
  format_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}

/** Row shape returned by INTROSPECT_CONSTRAINTS_SQL */
export interface PgConstraintRow {
  conname: string;
  contype: "p" | "u" | "f" | "c";
  conkey: number[];
  confrelidname: string | null;
  confkeycols: string[] | null;
  consrc: string;
}

/**
 * SQL returning columns for one table from pg_catalog.
 * Uses $1=schema, $2=table — never interpolates raw identifiers.
 * Mirrors postgres.ts listColumns style.
 */
export const INTROSPECT_COLUMNS_SQL = (
  _schema: string,
  _table: string,
): string => `
  SELECT a.attname AS column_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS format_type,
         (CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END) AS is_nullable,
         pg_get_expr(ad.adbin, ad.adrelid) AS column_default
    FROM pg_attribute a
    JOIN pg_class c
      ON c.oid = a.attrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad
      ON ad.adrelid = a.attrelid
     AND ad.adnum  = a.attnum
   WHERE n.nspname = $1
     AND c.relname = $2
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum
`;

/**
 * SQL returning one row per pg_constraint for the table.
 * $1=schema, $2=table.
 */
export const INTROSPECT_CONSTRAINTS_SQL = (
  _schema: string,
  _table: string,
): string => `
  SELECT con.conname,
         con.contype,
         con.conkey,
         con.confrelid::regclass::text AS confrelidname,
         (
           SELECT array_agg(ra.attname ORDER BY ord.ord)
             FROM unnest(con.confkey) WITH ORDINALITY AS ord(attnum, ord)
             JOIN pg_attribute ra
               ON ra.attrelid = con.confrelid
              AND ra.attnum = ord.attnum
         ) AS confkeycols,
         pg_get_constraintdef(con.oid, true) AS consrc
    FROM pg_constraint con
    JOIN pg_class     c ON c.oid  = con.conrelid
    JOIN pg_namespace n ON n.oid  = c.relnamespace
   WHERE n.nspname = $1
     AND c.relname = $2
   ORDER BY con.contype, con.conname
`;

/**
 * Normalize a CHECK expression: strip leading "CHECK " and ALL outer paren
 * layers that wrap the whole expr. Inner parens (e.g. `(a > 0)`) are preserved.
 */
function normalizeCheckExpr(consrc: string): string {
  let expr = consrc.trim();
  const checkPrefix = "CHECK ";
  if (expr.toUpperCase().startsWith(checkPrefix)) {
    expr = expr.slice(checkPrefix.length).trim();
  }
  while (expr.length >= 2 && expr.startsWith("(") && expr.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i !== expr.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) break;
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

/** Strip schema prefix from a fully-qualified regclass text. */
function stripSchemaPrefix(qname: string): string {
  const dot = qname.lastIndexOf(".");
  return dot >= 0 ? qname.slice(dot + 1) : qname;
}

/**
 * Parse a PostgreSQL text[] literal as returned by node-pg without a custom
 * type parser (e.g. "{id,name}"), or pass through if already an array.
 * Defensive: malformed input → [rawString] so downstream type checks fail
 * loudly instead of silently passing `undefined` through.
 */
function parseTextArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw !== "string") return [];
  const s = raw.trim();
  if (s === "" || s === "{}") return [];
  // Strip outer braces if present.
  const inner = s.startsWith("{") && s.endsWith("}")
    ? s.slice(1, -1)
    : s;
  if (inner === "") return [];
  // Quoted elements may contain escaped quotes / commas inside; the
  // minimum useful split for pg_constraint.confkeycols is
  // comma-separated bare identifiers — split on unquoted commas.
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "," && !inQuote) {
      parts.push(stripQuotes(buf));
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(stripQuotes(buf));
  return parts.filter((p) => p !== "");

  function stripQuotes(v: string): string {
    const t = v.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      return t.slice(1, -1).replace(/""/g, '"');
    }
    return t;
  }
}

/**
 * - Columns preserve input order (attnum asc).
 * - Every column carries originalName === name.
 * - PK member columns carry isPrimaryKey:true (out-of-band property).
 * - Keys follow conkey attnum order, NOT sorted alphabetically.
 * - FK references strip the schema prefix from regclass text.
 * - Unknown contype → skipped silently.
 */
export function rowsToSpec(
  schema: string,
  table: string,
  colRows: PgColumnRow[],
  conRows: PgConstraintRow[],
): TableSpec {
  // attnum (1-indexed) → column name resolver for conkey arrays.
  // Our INTROSPECT_COLUMNS_SQL returns rows in attnum asc order, so positional
  // index+1 matches the attnum emitted by pg_catalog.
  const attnumToName = new Map<number, string>();
  for (let i = 0; i < colRows.length; i++) {
    attnumToName.set(i + 1, colRows[i].column_name);
  }

  const pkAttnums = new Set<number>();
  const keys: KeySpec[] = [];

  for (const con of conRows) {
    if (con.contype === "p") {
      const cols = con.conkey.map((n) => attnumToName.get(n) ?? `#${n}`);
      const pk: KeySpec = {
        kind: "primaryKey",
        columns: cols,
        name: con.conname,
      };
      for (const n of con.conkey) pkAttnums.add(n);
      keys.push(pk);
    } else if (con.contype === "u") {
      const cols = con.conkey.map((n) => attnumToName.get(n) ?? `#${n}`);
      const uq: KeySpec = {
        kind: "unique",
        columns: cols,
        name: con.conname,
      };
      keys.push(uq);
    } else if (con.contype === "f") {
      const cols = con.conkey.map((n) => attnumToName.get(n) ?? `#${n}`);
      const refTable = con.confrelidname
        ? stripSchemaPrefix(con.confrelidname)
        : "";
      const refCols = parseTextArray(con.confkeycols);
      const fk: KeySpec = {
        kind: "foreignKey",
        columns: cols,
        references: { table: refTable, columns: refCols },
        name: con.conname,
      };
      keys.push(fk);
    } else if (con.contype === "c") {
      const ck: KeySpec = {
        kind: "check",
        expr: normalizeCheckExpr(con.consrc),
        name: con.conname,
      };
      keys.push(ck);
    }
    // Unknown contype → skipped silently.
  }

  const columns: ColumnSpec[] = colRows.map((r, idx) => {
    const col: ColumnSpec = {
      name: r.column_name,
      type: r.format_type,
      nullable: r.is_nullable === "YES",
      originalName: r.column_name,
    };
    if (r.column_default !== null) col.default = r.column_default;
    if (pkAttnums.has(idx + 1)) col.isPrimaryKey = true;
    return col;
  });

  return {
    name: table,
    schema,
    columns,
    keys,
  };
}