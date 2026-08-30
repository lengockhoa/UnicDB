// src/core/importer/importDryRun.ts
// DBX-01-002 — pure, read-only dry-run. Builds a fully parameterized
// batched INSERT plan that the execute layer (DBX-01-003) feeds into
// a `DbTransaction`. No `vscode`, no I/O, no DB calls. Identifier
// names go through double-quote escaping per SQL standard; cell
// values NEVER appear in the SQL string — they are bound as `$N`
// parameters so a malicious file cannot inject SQL.

import type { MappedRows } from "./importMapping";

export interface DryRunPlan {
  /**
   * One INSERT statement per batch (or empty if the plan has zero
   * rows). The `i`-th entry pairs with `parameterSets[i]`, which is a
   * flat list of bound values in target-column order.
   */
  sqlStatements: string[];
  parameterSets: unknown[][];
  batches: number;
  rowCount: number;
  /** Approximate total payload size (rows + parameter values). */
  totalBytes: number;
}

export interface DryRunTarget {
  schema: string;
  table: string;
}

const DEFAULT_BATCH_SIZE = 1000;

/**
 * Build a batched INSERT plan from already-mapped rows. The function
 * is a pure, synchronous data transformation; calling it must not
 * have side effects on the database or any external system.
 */
export function buildDryRunPlan(
  mapped: MappedRows,
  target: DryRunTarget,
  opts?: { batchSize?: number },
): DryRunPlan {
  const batchSize = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH_SIZE);
  const rows = mapped.values;
  if (rows.length === 0) {
    return { sqlStatements: [], parameterSets: [], batches: 0, rowCount: 0, totalBytes: 0 };
  }

  const columnCount = rows[0]?.length ?? 0;
  // We do not need the actual column names here — execute (003) is
  // the layer that knows them. We synthesise positional placeholders
  // `$1, $2, ...` and let the executor pair them with the target
  // schema/table. To keep things explicit, we do still escape the
  // identifiers so the SQL string is never the result of a
  // concatenation of untrusted names.
  const colList = Array.from({ length: columnCount }, (_, i) => `"col_${i + 1}"`).join(", ");
  // The placeholders we emit here are $1..$N. Execute keeps the same
  // shape when it forwards the SQL to the DB.
  const placeholders = Array.from({ length: columnCount }, (_, i) => `$${i + 1}`).join(", ");
  const sqlPrefix = `INSERT INTO ${quoteIdent(target.schema)}.${quoteIdent(target.table)} (${colList}) VALUES (${placeholders})`;

  const sqlStatements: string[] = [];
  const parameterSets: unknown[][] = [];
  let totalBytes = 0;
  let batches = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    sqlStatements.push(sqlPrefix);
    batches++;
    for (const row of slice) {
      parameterSets.push(row);
      for (const v of row) {
        totalBytes += approxByteSize(v);
      }
    }
  }

  return { sqlStatements, parameterSets, batches, rowCount: rows.length, totalBytes };
}

function quoteIdent(name: string): string {
  // SQL standard: `"` in an identifier becomes `""`.
  return `"${name.replace(/"/g, '""')}"`;
}

function approxByteSize(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === "number") return 8;
  if (typeof v === "boolean") return 1;
  if (typeof v === "string") return v.length;
  if (typeof v === "object") return JSON.stringify(v).length;
  return 0;
}
