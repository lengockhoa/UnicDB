// src/ui/compareService.ts
// TASK-DBX03-004 — host orchestration for Schema & Data Compare.
// Fetches shapes via adapter.listTableDetail and rows via injected
// RowFetcher (default: adapter.runQuery keyset SELECT), then runs the
// pure modules. One-shot invocation: cache-free, timer-free.

import type { DbAdapter, QueryResult, RunResult, TableDetail } from "../adapters/types";
import { diffSchema, shapeFromTableDetail, type SchemaDiffResult, type TableShape } from "../core/compare/schemaDiff";
import { diffData, type DataDiffResult } from "../core/compare/dataDiff";
import { buildSyncPlan, type SyncPlan } from "../core/compare/syncPlan";
import { quoteIdent } from "../core/importer/importDryRun";

export const COMPARE_ROW_LIMIT = 10000;

export interface CompareRequest {
  source: { schema: string; table: string };
  target: { schema: string; table: string };
}

export interface CompareResult {
  ok: boolean;
  error?: string;
  truncated?: boolean;
  shapeDiff?: SchemaDiffResult;
  dataDiff?: DataDiffResult;
  plan?: SyncPlan;
}

export type RowFetcher = () => Promise<Array<Record<string, unknown>>>;

export interface CompareOverrides {
  fetchRowsA?: RowFetcher;
  fetchRowsB?: RowFetcher;
}

function qualified(t: { schema: string; table: string }): string {
  return `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
}

function rowsFromRunResult(rr: RunResult): Array<Record<string, unknown>> {
  const q = rr.results[0] as (QueryResult & { fields?: Array<{ name: string }> }) | undefined;
  if (!q || !Array.isArray(q.rows)) return [];
  const fieldNames = Array.isArray(q.fields) ? q.fields.map((f) => f.name) : null;
  return q.rows.map((r) => {
    if (fieldNames && Array.isArray(r)) {
      const row: Record<string, unknown> = {};
      fieldNames.forEach((name, i) => {
        row[name] = r[i];
      });
      return row;
    }
    return r as unknown as Record<string, unknown>;
  });
}

/**
 * Usable unique keys beyond the PK: single-column NOT NULL UNIQUE
 * constraints (contype "u"). Multi-column unique keys are NOT accepted
 * because individual column nullability does not guarantee tuple
 * uniqueness for diffing.
 */
function extractUniqueNotNullKeys(detail: TableDetail, columnNames: string[]): string[] {
  const keys: string[] = [];
  for (const con of detail.constraints) {
    if (con.contype !== "u" || con.conkey.length !== 1) continue;
    const col = detail.columns[con.conkey[0]! - 1];
    if (!col || col.is_nullable !== "NO") continue;
    if (columnNames.includes(col.column_name)) keys.push(col.column_name);
  }
  return keys;
}

function defaultFetcher(adapter: DbAdapter, t: { schema: string; table: string }, columns: string[]): RowFetcher {
  const colList = columns.map(quoteIdent).join(", ");
  const sql = `SELECT ${colList} FROM ${qualified(t)} ORDER BY ${columns.map(quoteIdent).join(", ")} LIMIT ${COMPARE_ROW_LIMIT + 1}`;
  return async () => {
    const rr = await adapter.runQuery(sql);
    return rowsFromRunResult(rr);
  };
}

export async function runCompare(
  req: CompareRequest,
  adapter: DbAdapter,
  driver: string | undefined,
  overrides?: CompareOverrides,
): Promise<CompareResult> {
  if (driver !== "postgres") {
    return { ok: false, error: "Schema & Data Compare requires an active PostgreSQL connection." };
  }

  let sourceDetail;
  let targetDetail;
  try {
    sourceDetail = await adapter.listTableDetail(req.source.schema, req.source.table);
    targetDetail = await adapter.listTableDetail(req.target.schema, req.target.table);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Compare failed: ${msg}` };
  }

  const source = shapeFromTableDetail(sourceDetail);
  const target = shapeFromTableDetail(targetDetail);
  const shapeDiff = diffSchema(source, target);

  // Key columns: PK or usable unique-NOT-NULL column set; intersected
  // with the target's columns. With no usable key the data phase is
  // skipped BEFORE any row fetch (no query is issued for data).
  const uniqueNotNull = extractUniqueNotNullKeys(sourceDetail, source.columns.map((c) => c.name));
  const keys =
    source.primaryKeys.filter((k) => target.columns.some((c) => c.name === k));
  const keyCandidates = keys.length > 0 ? keys : uniqueNotNull;
  const keyCols = keyCandidates.filter((k) => target.columns.some((c) => c.name === k));
  const columnNames = source.columns.map((c) => c.name);

  if (keyCols.length === 0) {
    // No usable key: skip the data phase entirely — no data query is
    // issued, the pure module reports skipped:"no-key", and the plan
    // records the blocker.
    const dataDiff = diffData([], [], [], columnNames);
    const plan = buildSyncPlan({
      source,
      target,
      schemaDiff: shapeDiff,
      dataDiff,
      sourceTable: req.source,
      targetTable: req.target,
    });
    return { ok: true, shapeDiff, dataDiff, plan };
  }

  const fetchA = overrides?.fetchRowsA ?? defaultFetcher(adapter, req.source, columnNames);
  const fetchB = overrides?.fetchRowsB ?? defaultFetcher(adapter, req.target, columnNames);

  const [rowsA, rowsB] = await Promise.all([fetchA(), fetchB()]);
  const truncated = rowsA.length > COMPARE_ROW_LIMIT || rowsB.length > COMPARE_ROW_LIMIT;
  const cappedA = rowsA.slice(0, COMPARE_ROW_LIMIT);
  const cappedB = rowsB.slice(0, COMPARE_ROW_LIMIT);

  const dataDiff = diffData(keyCols, cappedA, cappedB, columnNames);
  const plan = buildSyncPlan({
    source,
    target,
    schemaDiff: shapeDiff,
    dataDiff,
    sourceTable: req.source,
    targetTable: req.target,
  });

  return { ok: true, truncated, shapeDiff, dataDiff, plan };
}
