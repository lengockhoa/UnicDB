// src/core/bqDialect.ts
//
// TASK-BQ04-001 — pure stamping helper for the additive `dialect?` +
// `schemaFields?` markers on `StatementResult`. Extracted from
// `src/extension.ts` `runStatements` so the BQ-04 contract is unit-testable
// without a VS Code / panel handle.
//
// Contract:
//   - `stampBqDialect(runSlice, active)`:
//       - When `active?.driver === "bigquery"`, EVERY entry of `runSlice` is
//         returned with `dialect: "bigquery"` set. When the entry's batched
//         handle exposes a `columns` array, `schemaFields` is set to a
//         structural `{name?: string; type?: string; mode?: string}` list
//         ordered to match the column order (type/mode are `undefined` when
//         the seam does not surface them — the live `BigQueryPagedQuery`
//         exposes `columns: string[]` only, so we forward `name` and leave
//         `type`/`mode` undefined; TASK-BQ04-002 consumes the structural
//         shape and treats absent type/mode as "no declared metadata").
//       - For ANY OTHER driver, the returned array carries the same entries
//         unchanged (`dialect` stays `undefined`, `schemaFields` stays
//         `undefined`).
//       - `runSlice` entries are MUTATED in place (matches the runner's
//         pre-existing in-place mutation pattern on `result`/`durationMs`/
//         `status`) and the SAME reference is returned. Consumers should
//         not depend on identity, only on the observable post-stamp field
//         values.
//   - Pure: no I/O, no vscode, no adapter access. `active?.driver` is the
//     only driver input. The caller has already resolved the driver from
//     the connection manager by the time `runSlice` lands here.

import type { SqlDialect } from "./statementParser";
import type { StatementResult } from "./queryRunner";

/**
 * Driver identifier the active connection can carry. The set is the union of
 * `ConnectionConfig.driver` values that flow through the host's connection
 * manager — non-exhaustive but mirrors the values the stamp helper is
 * called with. Undefined means "no active connection".
 */
export type BqDialectDriver =
  | "bigquery"
  | "postgres"
  | "mysql"
  | "mssql"
  | undefined
  | null;

interface StatementResultWithBatchedColumns {
  batched?: BatchedQueryWithColumns | undefined;
}

interface BatchedQueryWithColumns {
  columns?: ReadonlyArray<unknown> | undefined;
}

/**
 * Per-column BQ schema field, ordered to match `result.columns`. `type` and
 * `mode` are `undefined` when the page source does not surface them — the
 * live `BigQueryPagedQuery` exposes only `columns: string[]`, so the
 * structural shape is `{ name: string, type: undefined, mode: undefined }`
 * per column. TASK-BQ04-002 consumers must treat absent `type`/`mode` as
 * "no declared metadata".
 */
export interface BqSchemaField {
  name?: string;
  type?: string;
  mode?: string;
}

/**
 * Stamp the additive `dialect?` + `schemaFields?` markers on the run slice
 * when the active driver is BigQuery. Non-BigQuery drivers leave the slice
 * untouched (`dialect`/`schemaFields` remain `undefined`).
 *
 * Returns the same reference as `runSlice` for caller chaining. The helper
 * mutates entries in place (the runner's pre-existing mutation pattern for
 * `result`/`durationMs`/`status`); callers must NOT rely on identity.
 */
export function stampBqDialect(
  runSlice: StatementResult[],
  active: { driver?: BqDialectDriver } | null | undefined,
): StatementResult[] {
  if (!active || active.driver !== "bigquery") {
    return runSlice;
  }
  for (const stmt of runSlice) {
    const ext = stmt as unknown as StatementResultWithBatchedColumns;
    stmt.dialect = "bigquery";
    const cols = readColumns(ext);
    if (cols && cols.length > 0) {
      stmt.schemaFields = cols.map((name) => ({ name: String(name) }));
    }
  }
  return runSlice;
}

/**
 * Read the column-name list from a statement's batched handle. The live
 * `BigQueryPagedQuery` exposes `columns: string[]`; structural typing lets
 * us accept any shape carrying a `columns` array without importing the
 * frozen `bigquery.ts`. Returns `undefined` when the handle does not
 * surface columns (e.g. non-batched statement, a typed-error result, or a
 * future seam that drops the field).
 */
function readColumns(stmt: StatementResultWithBatchedColumns): ReadonlyArray<unknown> | undefined {
  const batched = stmt.batched;
  if (!batched || !batched.columns) return undefined;
  return batched.columns;
}