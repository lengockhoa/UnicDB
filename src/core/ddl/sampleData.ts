// src/core/ddl/sampleData.ts
// TASK-005 — Pure PostgreSQL INSERT … VALUES sample-data generator.
// No vscode imports, no I/O. Used by UnicDB.generateSampleData command (TASK-005).
//
// Spec (from task file §src/core/ddl/sampleData.ts):
//   generateSampleInserts(spec, n): string
//     - n <= 0 → ""
//     - INSERT INTO "schema"."table" ("a","b") VALUES
//        ( ... ),
//        ( ... );
//     - One statement, multi-row VALUES, 4-space indent.
//     - Values by lowercased type prefix:
//       int/serial/bigint/smallint → per-column counter 1..n
//       numeric/decimal/money      → (i+1).5
//       float/double/real          → (i+1).25
//       varchar/char/text          → 'row-<i+1> c<j>'
//       boolean                    → alternating true/false
//       date                       → '2026-01-<dd>' zero-pad 2 (dd=(i%28)+1)
//       timestamp / timestamp with time zone → '2026-01-<dd> 10:00:00'
//       uuid                       → '00000000-0000-0000-4000-0000000000<zero-pad(i+1,3)>'
//       json/jsonb                 → '{}'
//       default                    → 'v<j>-<i+1>'
//     - Column order = spec order; keys ignored; i from 0.
//     - `j` for varchar/char/text fallback: 1-based index AMONG string-typed
//       columns only (so test #1 [id integer, name varchar] → name is `c1`,
//       and dispatch test [a varchar, b char, c text] → a is `c1`, b is `c2`,
//       c is `c3`).
//     - `j` for default fallback: 1-based column index AMONG all columns.
import type { ColumnSpec, TableSpec } from "./createTable";

/** Pad `n` to `width` digits with leading zeros. */
function pad(n: number, width: number): string {
  const s = String(n);
  if (s.length >= width) return s;
  return "0".repeat(width - s.length) + s;
}

/** True khi lowercased type prefix khớp 1 trong các `prefixes`. */
function typeIs(type: string, prefixes: string[]): boolean {
  const lower = type.toLowerCase().trim();
  for (const p of prefixes) {
    if (lower === p) return true;
    if (lower.startsWith(p + " ") || lower.startsWith(p + "(")) return true;
  }
  return false;
}

function isStringType(type: string): boolean {
  return typeIs(type, ["varchar", "character varying", "char", "character", "text"]);
}

/**
 * Compute value literal cho column `col` ở row index `i` (0-based).
 * `stringIndex` is 1-based index among string-typed columns (c1, c2, ...).
 * `colIndex` is 1-based index among all columns (v1, v2, ...).
 */
function valueFor(
  col: ColumnSpec,
  stringIndex: number,
  colIndex: number,
  i: number,
): string {
  const n = i + 1;
  if (
    typeIs(col.type, [
      "integer",
      "int",
      "int2",
      "int4",
      "int8",
      "serial",
      "bigserial",
      "smallserial",
      "bigint",
      "smallint",
    ])
  ) {
    return String(n);
  }
  if (typeIs(col.type, ["numeric", "decimal", "money"])) {
    return `${n}.5`;
  }
  if (
    typeIs(col.type, [
      "float",
      "float4",
      "float8",
      "double",
      "double precision",
      "real",
    ])
  ) {
    return `${n}.25`;
  }
  if (isStringType(col.type)) {
    return `'row-${n} c${stringIndex}'`;
  }
  if (typeIs(col.type, ["boolean", "bool"])) {
    return i % 2 === 0 ? "true" : "false";
  }
  if (typeIs(col.type, ["date"])) {
    const dd = pad((i % 28) + 1, 2);
    return `'2026-01-${dd}'`;
  }
  if (
    typeIs(col.type, [
      "timestamp",
      "timestamptz",
      "timestamp with time zone",
      "timestamp without time zone",
    ])
  ) {
    const dd = pad((i % 28) + 1, 2);
    return `'2026-01-${dd} 10:00:00'`;
  }
  if (typeIs(col.type, ["uuid"])) {
    return `'00000000-0000-0000-4000-000000000${pad(n, 3)}'`;
  }
  if (typeIs(col.type, ["json", "jsonb"])) {
    return `'{}'`;
  }
  return `'v${colIndex}-${n}'`;
}

export function generateSampleInserts(spec: TableSpec, n: number): string {
  if (n <= 0) return "";
  if (spec.columns.length === 0) return "";

  const tableIdent = `"${spec.schema}"."${spec.name}"`;
  const colIdents = spec.columns.map((c) => `"${c.name}"`).join(",");

  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const parts: string[] = [];
    let stringIdx = 0;
    for (let j = 0; j < spec.columns.length; j++) {
      if (isStringType(spec.columns[j].type)) stringIdx++;
      parts.push(valueFor(spec.columns[j], stringIdx, j + 1, i));
    }
    rows.push(` (${parts.join(", ")})`);
  }

  return (
    `INSERT INTO ${tableIdent} (${colIdents}) VALUES\n` +
    rows.join(",\n") +
    ";\n"
  );
}
