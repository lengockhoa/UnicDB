// src/ui/bigQueryPreview.ts
// TASK-BQ02-002 — Pure-module GoogleSQL preview SELECT builder for BigQuery.
//
// Produces a single bounded preview statement:
//   SELECT * FROM `<project>`.`<dataset>`.`<table>` LIMIT <n>
//
// Quoting: backtick delimiter, doubling escape for embedded backticks
// (GoogleSQL identifier rules). Three-part reference ONLY when caller passes a
// non-empty `project`; two-part otherwise. LIMIT is clamped to
// [1, BIGQUERY_PREVIEW_MAX_LIMIT] with default 100.
//
// This module is intentionally pure (no vscode import) so it can be unit-tested
// without adapter mocks. TASK-BQ02-003's preview dispatch and any future BQ-03
// paged-query builder consume these exports verbatim.
export const BIGQUERY_PREVIEW_MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

export interface BigQueryPreviewArgs {
  dataset: string;
  table: string;
  project?: string;
  limit?: number;
}

/**
 * Backtick-quote a BigQuery identifier, doubling any embedded backticks.
 * Caller guarantees `id` is non-empty; the surrounding backticks are always
 * appended.
 */
function quoteBqId(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/**
 * Clamp `limit` into [1, BIGQUERY_PREVIEW_MAX_LIMIT]. `undefined` → default.
 * Non-finite / NaN / non-number inputs collapse to default.
 */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n <= 0) return BIGQUERY_PREVIEW_MAX_LIMIT;
  if (n > BIGQUERY_PREVIEW_MAX_LIMIT) return BIGQUERY_PREVIEW_MAX_LIMIT;
  return n;
}

/**
 * Build a bounded preview SELECT for a BigQuery table.
 *
 * @example two-part
 *   buildBigQueryPreviewSql({ dataset: "my ds", table: "tbl" })
 *   // → SELECT * FROM `my ds`.`tbl` LIMIT 100
 *
 * @example three-part
 *   buildBigQueryPreviewSql({ project: "p", dataset: "d", table: "t" })
 *   // → SELECT * FROM `p`.`d`.`t` LIMIT 100
 */
export function buildBigQueryPreviewSql(p: BigQueryPreviewArgs): string {
  const qualifiedTable = quoteBqId(p.table);
  const qualifiedDataset = quoteBqId(p.dataset);
  const tableRef =
    p.project && p.project.length > 0
      ? `${quoteBqId(p.project)}.${qualifiedDataset}.${qualifiedTable}`
      : `${qualifiedDataset}.${qualifiedTable}`;
  const limit = clampLimit(p.limit);
  return `SELECT * FROM ${tableRef} LIMIT ${limit}`;
}