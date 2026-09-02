// src/adapters/bigquery.ts
//
// TASK-BQ01-002 — `BigQueryAdapter implements DbAdapter` (BQ-01 cycle).
//
// HARD CONSTRAINTS (per task Discussion 2026-09-02 + Acceptance Criteria):
//   - BQ-00 surface (bigqueryAdc.ts, bigqueryTypes.ts) is FROZEN. This module
//     imports them verbatim and never edits them.
//   - The adapter owns its OWN factory type `BigQueryClientFactory` with a
//     broader method set than BQ-00's `BigQueryClientLike` (listDatasets-only):
//     query, getQueryResults, createQueryJob, cancel, listDatasets, getDataset,
//     getTable. The default implementation wraps BQ-00's `createBigQueryClient`
//     and forwards `{projectId, location}` to the underlying `new BigQuery(opts)`
//     call (isolated in a lazy `require`, so the GCP client only materializes
//     at factory-call time, not at module import).
//   - ADC external: never import credentials / OAuth tokens / service-account
//     JSON. `BigQueryConnectError` carries the typed `AdcDiagnostic` (category
//     + FIXED remediation, never raw err text).
//   - `close()` is idempotent.
//   - Reuse BQ-00's `toBigQueryPage` for response normalization; INT64 / NUMERIC
//     / BIGNUMERIC cells stay branded strings (no `Number` coercion).
//   - Unimplemented introspection surfaces (listSchemas / listTables / ...) throw
//     `NotImplementedError("bigquery")` — BQ-02 wires real introspection.
//
// No `@google-cloud/bigquery` import at module top-level: the lazy `require`
// in the default factory keeps the module import-time side-effect free and
// keeps the seam observable in tests without touching the real GCP client.

import {
  createBigQueryClient,
  runAdcSmoke,
  type AdcDiagnostic,
  type BigQueryClientLike,
} from "./bigqueryAdc";
import {
  toBigQueryPage,
  type BigQueryPage,
  type BigQueryRawQueryResponse,
} from "./bigqueryTypes";
import {
  NotImplementedError,
  type ColumnInfo,
  type DbAdapter,
  type QueryResult,
  type RoutineInfo,
  type RunResult,
  type SchemaInfo,
  type TableDetail,
  type TableInfo,
  type ViewInfo,
} from "./types";
import type { ConnectionConfig } from "../config/types";
import { validateBigQueryConnection } from "../config/types";

// ===========================================================================
// Adapter-owned types
// ===========================================================================

/**
 * Options accepted by the adapter's `BigQueryClient.query` seam. Mirrors
 * the `skipParsing` flag on the real `@google-cloud/bigquery`
 * `Query`/`QueryOptions` shape (bigquery.d.ts:71). The adapter ALWAYS
 * forwards `{ skipParsing: true }` on the production path so that:
 *   - `mergeSchemaWithRows_` is NOT invoked (bigquery.js:1334-1336), so
 *     INT64 cells are NOT coerced to JS Number (precision preserved past
 *     `Number.MAX_SAFE_INTEGER`).
 *   - `delete res.rows` (bigquery.js:1343, job.js:406) is NOT run, so
 *     element 2 of the returned TUPLE retains the wire-format `f[].v`
 *     cells that `toBigQueryPage` consumes.
 */
export interface BigQueryQueryOptions {
  skipParsing?: boolean;
}

/**
 * One row of query results in the broad wire shape used by the adapter.
 * Kept loose (`unknown`) — the mapper un-nests `f[].v` into a flat tuple via
 * `toBigQueryPage`. BQ-00's `BigQueryValue` is the contract, but the seam
 * stays `unknown` so test fakes don't have to brand every cell.
 *
 * TASK-BQ02-001: the seam is WIDENED here for real enumeration. The legacy
 * members (`query`, `getQueryResults`, `createQueryJob`, `cancel`,
 * `listDatasets`, `getDataset`, `getTable`) are KEPT so BQ-01 tests keep
 * compiling; the runtime instance satisfies BOTH sets structurally (verified
 * at runtime against `@google-cloud/bigquery@9.0.3`).
 *
 * New members mirror the real client's instance shape:
 *   - `getDatasets(opts?)` → PagedResponse of dataset objects with metadata
 *   - `dataset(id)` → handle exposing `getTables(opts?)`, `getRoutines(opts?)`,
 *     `table(id)` (sub-handle with `getMetadata(opts?)`).
 *
 * The widened `table` handle carries `getMetadata()` ONLY — no `getRows`
 * member (no MVP caller; `getRows` Number-coerces INT64; re-evaluate in BQ-03).
 */

// ---- Widened seam additions (BQ-02) --------------------------------------

/** Raw row of the `ITableList.tables[]` array (types.d.ts:5983..6045). */
export interface RawTableListItem {
  clustering?: { fields?: string[] };
  creationTime?: string;
  expirationTime?: string;
  friendlyName?: string;
  id?: string;
  kind?: string;
  labels?: Record<string, string>;
  rangePartitioning?: unknown;
  requirePartitionFilter?: boolean;
  tableReference?: { projectId?: string; datasetId?: string; tableId?: string };
  timePartitioning?: { type?: string; field?: string; expirationMs?: string; requirePartitionFilter?: boolean };
  type?: string;
  view?: unknown;
}

/** Raw `ITable` metadata (subset relevant to BQ-02 introspection). */
export interface RawTableMetadata {
  schema?: { fields?: Array<{ name?: string; type?: string; mode?: string; fields?: unknown[] }> };
  numRows?: string;
  numBytes?: string;
  creationTime?: string;
  timePartitioning?: { type?: string; field?: string; expirationMs?: string; requirePartitionFilter?: boolean };
  clustering?: { fields?: string[] };
  type?: string;
  tableReference?: { projectId?: string; datasetId?: string; tableId?: string };
  labels?: Record<string, string>;
  requirePartitionFilter?: boolean;
}

/** Raw `IDataset` metadata subset. */
export interface RawDatasetMetadata {
  id?: string;
  datasetReference?: { datasetId?: string; projectId?: string };
  location?: string;
  friendlyName?: string;
}

/** Dataset handle (mirrors `Dataset` instance surface used by BQ-02). */
export interface BigQueryDatasetHandle {
  getTables(opts?: { maxResults?: number }): Promise<[Array<{ id?: string; metadata?: RawTableListItem }>, unknown, unknown]>;
  getRoutines(opts?: { maxResults?: number }): Promise<[Array<{ id?: string; metadata?: { routineReference?: { routineId?: string } } }>, unknown, unknown]>;
  table(id: string): { getMetadata(opts?: unknown): Promise<[RawTableMetadata, unknown]> };
}

export interface BigQueryClient {
  query(sql: string, opts?: BigQueryQueryOptions): Promise<unknown>;
  getQueryResults(jobId: string, opts?: unknown): Promise<unknown>;
  createQueryJob(sql: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  // Legacy seam members (BQ-01). The real client's `listDatasets`/`dataset`
  // names satisfy both old and new call sites — see comment above.
  listDatasets(projectId?: string): Promise<Array<{ id?: string }>>;
  getDataset(id: string): Promise<unknown>;
  getTable(datasetId: string, tableId: string): Promise<unknown>;
  // Widened seam members (BQ-02). Real client method names (verified against
  // @google-cloud/bigquery@9.0.3 — see task Discussion #1).
  getDatasets(
    opts?: { maxResults?: number; pageToken?: string },
  ): Promise<[Array<{ id?: string; metadata?: RawDatasetMetadata }>, unknown, unknown]>;
  dataset(id: string): BigQueryDatasetHandle;
}

/**
 * Adapter-OWNED factory — broader than BQ-00's `BigQueryClientLike` seam.
 * The default implementation wraps BQ-00's `createBigQueryClient` and
 * forwards `{projectId, location}` to the underlying `new BigQuery(opts)` call.
 *
 * The BQ-00 signature only forwards `{projectId}` and returns the narrower
 * `BigQueryClientLike` (listDatasets-only), which cannot carry location or
 * support tests #4-#6. Hence the adapter owns this richer surface.
 */
export type BigQueryClientFactory = (
  opts: { projectId: string; location?: string },
) => BigQueryClient;

/**
 * Connection failure (ADC / API / location). Carries ONLY the typed diagnostic
 * envelope — no raw err message, no env slot, no token. Re-daction by
 * construction: the error has no field that could carry leaked text.
 */
export class BigQueryConnectError extends Error {
  readonly diagnostic: AdcDiagnostic;
  constructor(diagnostic: AdcDiagnostic) {
    super(`BigQuery connect failed: ${diagnostic.category}`);
    this.name = "BigQueryConnectError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Post-`close()` operation request — lifecycle violation, NOT a connection
 * failure. Does not carry a diagnostic.
 */
export class BigQueryClosedError extends Error {
  constructor() {
    super("BigQueryAdapter is closed");
    this.name = "BigQueryClosedError";
  }
}

/**
 * Operation request before any `connect()` succeeded — distinct from
 * `BigQueryClosedError` so callers can disambiguate a never-connected
 * adapter from a post-close one. Does not carry a diagnostic.
 */
export class BigQueryNotConnectedError extends Error {
  constructor() {
    super("BigQueryAdapter is not connected");
    this.name = "BigQueryNotConnectedError";
  }
}

// ===========================================================================
// BigQueryAdapter
// ===========================================================================

export class BigQueryAdapter implements DbAdapter {
  private readonly cfg: ConnectionConfig;
  private readonly clientFactory: BigQueryClientFactory;
  private client: BigQueryClient | null = null;
  private closed = false;

  constructor(cfg: ConnectionConfig, clientFactory?: BigQueryClientFactory) {
    // Constructor pre-condition: a valid BigQuery config (BQ-01-001 validator).
    // Failing this is a programmer error, not a runtime ADC failure — throw
    // synchronously rather than deferring to connect().
    const v = validateBigQueryConnection(cfg);
    if (!v.ok) {
      throw new Error(`Invalid BigQuery connection config: ${v.reason}`);
    }
    this.cfg = cfg;
    this.clientFactory = clientFactory ?? defaultBigQueryClientFactory;
  }

  // ----- lifecycle ---------------------------------------------------------

  async connect(): Promise<void> {
    if (this.closed) {
      throw new BigQueryClosedError();
    }
    if (this.client !== null) {
      // Idempotent re-connect after a successful connect(): do not rebuild.
      return;
    }
    const projectId = this.cfg.bigquery?.billingProject ?? "";
    const location = this.cfg.bigquery?.location;
    this.client = this.clientFactory({ projectId, location });

    // ADC smoke through the narrow BQ-00 seam. `BigQueryAdapter` already
    // typed the client as the broader `BigQueryClient`, but `runAdcSmoke`
    // takes the narrower `BigQueryClientLike`; the structural contract
    // (listDatasets with the same signature) is satisfied — the cast is
    // safe and one-way.
    const smoke = await runAdcSmoke(
      this.client as unknown as BigQueryClientLike,
    );
    if (smoke !== "ok") {
      // Drop the half-constructed client so a subsequent connect() can
      // try again (the previous run's executor report did the same).
      this.client = null;
      throw new BigQueryConnectError(smoke);
    }
  }

  async close(): Promise<void> {
    // Idempotent: subsequent close() is a no-op.
    if (this.closed) return;
    this.closed = true;
    this.client = null;
  }

  // ----- runQuery ----------------------------------------------------------

  async runQuery(sql: string): Promise<RunResult> {
    const client = this.requireClient();
    // The real `@google-cloud/bigquery` `client.query(sql)` resolves a
    // TUPLE — `PagedResponse<RowMetadata, Query, QueryResultsResponse>`
    // (node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts:33, :49,
    // :1119). Concretely: `[RowMetadata[]]` when no further pages, or
    // `[RowMetadata[], Query | null, QueryResultsResponse]` when paginated.
    //
    //   - Element 0 (`RowMetadata[]`) is the PARSED form. INT64 cells are
    //     coerced to JS Number — branded-string precision is LOST past
    //     `Number.MAX_SAFE_INTEGER` (see `mergeSchemaWithRows_`,
    //     bigquery.js:1338). Feeding element 0 into `toBigQueryPage` would
    //     either yield zero rows (Map shape vs `{f:[]}`) or lose precision.
    //   - Element 2 (`QueryResultsResponse` = `IGetQueryResultsResponse |
    //     `IQueryResponse`) is the RAW apiResponse. It carries the wire-
    //     format `f[].v` cells with branded strings preserved verbatim.
    //     This is what `toBigQueryPage` expects.
    //
    // **CRITICAL (R4.5 round-2 fix):** the adapter ALWAYS forwards
    // `{ skipParsing: true }` to the underlying client. Without this:
    //   (a) `bigquery.js:1338` runs `mergeSchemaWithRows_` which
    //       Number-coerces INT64 cells (precision lost past
    //       MAX_SAFE_INTEGER), and
    //   (b) `bigquery.js:1343` then `delete res.rows`, stripping the raw
    //       wire-format cells from element 2 of the TUPLE — so
    //       `toBigQueryPage` yields an empty `rows` array and the
    //       production path silently produces `{columns:[], rows:[],
    //       rowCount:0}`. (See `node_modules/@google-cloud/bigquery/build/
    //       src/job.js:388, 398-407` for the same delete in the polling
    //       path.)
    // With `skipParsing: true`:
    //   - `bigquery.js:1334-1335` short-circuits: `rows = res.rows` (raw,
    //     no merge, no Number coercion). `delete res.rows` is NOT run.
    //   - Element 2 of the TUPLE keeps `rows: [{f: [{v: "..."}]}]`
    //     verbatim, and `toBigQueryPage` consumes the wire-format `f[].v`
    //     strings unchanged.
    //
    // The tuple unwrap is: prefer element 2 (raw apiResponse) when
    // present. There is NO 1-element fallback — under `skipParsing: true`
    // element 0 is `RawTableRow[]` (an array, not a response object), and
    // feeding it into `toBigQueryPage` would silently produce an empty
    // page (R4.5 round-1 minor finding).
    //
    // Measure durationMs around `client.query(...)` so the result reflects
    // the wire round-trip; `commandTag` stays undefined because the wire
    // response does not carry a statement tag (BQ-02 will wire a real
    // source when introspection lands).
    const queryStartedAt = Date.now();
    const resolved = (await client.query(sql, { skipParsing: true })) as unknown;
    const durationMs = Date.now() - queryStartedAt;
    const tuple = Array.isArray(resolved) ? (resolved as unknown[]) : null;
    const raw: BigQueryRawQueryResponse =
      tuple !== null && tuple.length >= 3 && tuple[2] !== undefined && tuple[2] !== null
        ? (tuple[2] as BigQueryRawQueryResponse)
        : (resolved as BigQueryRawQueryResponse);
    const page: BigQueryPage = toBigQueryPage(raw);
    const result: QueryResult = {
      columns: page.schema.map((f) => f.name),
      rows: page.rows as unknown as unknown[][],
      rowCount: page.rows.length,
      commandTag: undefined,
      durationMs,
    };
    return { results: [result] };
  }

  // ----- introspection (BQ-02 — real enumeration) --------------------------

  /**
   * Datasets-as-schemas: list datasets via the widened seam
   * `client.getDatasets({})`. The flag `includeSystem` is accepted but
   * ignored — BigQuery's `getDatasets` returns user-visible datasets only;
   * there is no separate "system datasets" list scope.
   */
  async listSchemas(_includeSystem: boolean): Promise<SchemaInfo[]> {
    const client = this.requireClient();
    const [datasets] = await client.getDatasets({});
    const out: SchemaInfo[] = [];
    for (const ds of datasets ?? []) {
      // Prefer `metadata.datasetReference.datasetId`; fall back to top-level
      // `id` ("project:datasetId") split, or to the object id verbatim.
      const refName =
        ds?.metadata?.datasetReference?.datasetId ??
        (typeof ds?.id === "string" && ds.id.includes(":")
          ? ds.id.split(":")[1]
          : ds?.id) ??
        "";
      if (refName) {
        out.push({ name: refName });
      }
    }
    return out;
  }

  /**
   * `getTables` returns a PagedResponse `[tableObjs, nextQuery, apiResponse]`.
   * Each `tableObj` carries `{ id, metadata: ITableList.tables[] element }`.
   * `type` selects the slice: `TABLE` only.
   */
  async listTables(schema?: string): Promise<TableInfo[]> {
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    const [tableObjs] = await ds.getTables({ maxResults: 1000 });
    const out: TableInfo[] = [];
    for (const t of tableObjs ?? []) {
      const ttype = t?.metadata?.type;
      const tid = t?.metadata?.tableReference?.tableId ?? t?.id ?? "";
      if (ttype === "TABLE" && tid) {
        out.push({ name: tid, schema: schema ?? "" });
      }
    }
    return out;
  }

  /** Same fixture; `VIEW` and `MATERIALIZED_VIEW` only (excludes TABLE + EXTERNAL). */
  async listViews(schema?: string): Promise<ViewInfo[]> {
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    const [tableObjs] = await ds.getTables({ maxResults: 1000 });
    const out: ViewInfo[] = [];
    for (const t of tableObjs ?? []) {
      const ttype = t?.metadata?.type;
      const tid = t?.metadata?.tableReference?.tableId ?? t?.id ?? "";
      if ((ttype === "VIEW" || ttype === "MATERIALIZED_VIEW") && tid) {
        out.push({ name: tid, schema: schema ?? "" });
      }
    }
    return out;
  }

  /**
   * Map `dataset.getRoutines({})` PagedResponse. Each routine carries
   * `metadata.routineReference.routineId`. `kind` is hardcoded `"function"`
   * per task Discussion #5 (roadmap defers routine depth to BQ-07b).
   */
  async listRoutines(schema?: string): Promise<RoutineInfo[]> {
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    const [routineObjs] = await ds.getRoutines({ maxResults: 1000 });
    const out: RoutineInfo[] = [];
    for (const r of routineObjs ?? []) {
      const rid = r?.metadata?.routineReference?.routineId;
      if (rid) {
        out.push({ name: rid, kind: "function", schema: schema ?? "" });
      }
    }
    return out;
  }

  /**
   * `client.dataset(s).table(t).getMetadata()` resolves
   * `[metadata, apiResponse]` (ServiceObject shape — service-object.d.ts:167).
   * Map the `metadata.schema.fields` into `ColumnInfo[]`. REPEATED gets
   * `<type> REPEATED` suffix per task spec §3; nested RECORD kept as one
   * `RECORD` column (NOT flattened).
   */
  async listColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    const [metadata] = await ds.table(table).getMetadata();
    const fields = metadata?.schema?.fields ?? [];
    return fields.map((f) => {
      const name = f?.name ?? "";
      const type = f?.type ?? "";
      const mode = f?.mode ?? "NULLABLE";
      // Compose the dataType: REPEATED gets the suffix; other modes use type only.
      const dataType = mode === "REPEATED" ? `${type} REPEATED` : type;
      const nullable = mode !== "REQUIRED";
      return {
        name,
        dataType,
        nullable,
        isPrimaryKey: false,
      };
    });
  }

  /**
   * `listRoutineParams` deferred — no MVP consumer (roadmap §9 sub-cycle
   * BQ-07b). The `routineType` is not exposed by BigQuery's `Routines.list`
   * response, so we cannot map to `kind: "procedure"` without widening the
   * shared `RoutineInfo` type. Re-evaluate when BQ-07b lands.
   */
  async listRoutineParams(
    _schema: string,
    _routine: string,
  ): Promise<Array<{ name: string | null; dataType: string }>> {
    throw new NotImplementedError("bigquery");
  }

  /**
   * Single-table row estimate: read `table.getMetadata()` and parse `numRows`
   * (a STRING on the wire). Parse with `Number()` ONLY if ≤ MAX_SAFE_INTEGER;
   * past-safe-integer values resolve to `null` ("unknown") per the
   * DbAdapter contract.
   */
  async estimateTableRows(schema: string, table: string): Promise<number | null> {
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    const [metadata] = await ds.table(table).getMetadata();
    const v = metadata?.numRows;
    if (typeof v !== "string" || v.length === 0) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }

  /**
   * Batch row estimate. Per DbAdapter contract (types.ts:151-154):
   *   - empty `tables` -> empty Map, NO client calls
   *   - dropped tables are OMITTED (never null, never throw)
   *   - per-table failure (e.g. table not found) -> OMIT
   *
   * The mssql adapter follows the same best-effort pattern.
   */
  async estimateTableRowsBatch(
    schema: string,
    tables: readonly string[],
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (tables.length === 0) return out;
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    // Concurrent metadata reads — independent I/O.
    const results = await Promise.allSettled(
      tables.map(async (t) => {
        const [metadata] = await ds.table(t).getMetadata();
        const v = metadata?.numRows;
        if (typeof v !== "string" || v.length === 0) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null;
        return n;
      }),
    );
    tables.forEach((t, i) => {
      const r = results[i];
      if (r.status === "fulfilled" && r.value !== null) {
        out.set(t, r.value);
      }
      // rejected or null-valued: OMIT (drop, never null in Map)
    });
    return out;
  }

  /**
   * `listTableDetail`: returns `TableDetail.columns` (mapped from
   * `metadata.schema.fields`) + `TableDetail.constraints` (stringly-typed
   * metadata facts: `timePartitioning`, `clustering`, `numRows`,
   * `numBytes`, `creationTime`). The `numRows` fact is preserved VERBATIM
   * when the wire string is past MAX_SAFE_INTEGER (never coerced via Number)
   * — pins §1 success definition 3 "without BigInt precision loss".
   */
  async listTableDetail(schema: string, table: string): Promise<TableDetail> {
    const client = this.requireClient();
    const ds = client.dataset(schema ?? "");
    const [metadata] = await ds.table(table).getMetadata();
    const fields = metadata?.schema?.fields ?? [];
    const columns: TableDetail["columns"] = fields.map((f) => {
      const name = f?.name ?? "";
      const type = f?.type ?? "";
      const mode = f?.mode ?? "NULLABLE";
      const is_nullable: "YES" | "NO" = mode === "REQUIRED" ? "NO" : "YES";
      return {
        column_name: name,
        format_type: type,
        is_nullable,
        column_default: null,
      };
    });
    const constraints: TableDetail["constraints"] = [];
    const tp = metadata?.timePartitioning;
    if (tp) {
      // Partitioning fact: e.g. "DAY(ts)" or "DAY(_PARTITIONTIME)" if no field.
      const tpType = tp.type ?? "";
      const tpField = tp.field ?? "";
      const tpExpr = tpField ? `${tpType}(${tpField})` : tpType;
      constraints.push({
        conname: "partitioning",
        consrc: tpExpr,
        contype: "meta",
        conkey: [],
        confrelidname: null,
        confkeycols: null,
      });
    }
    const cl = metadata?.clustering;
    if (cl?.fields && cl.fields.length > 0) {
      constraints.push({
        conname: "clustering",
        consrc: `(${cl.fields.join(", ")})`,
        contype: "meta",
        conkey: [],
        confrelidname: null,
        confkeycols: null,
      });
    }
    // numRows: verbatim string OR "unknown" past MAX_SAFE_INTEGER.
    // NEVER Number()-coerced past safe integer (success def 3).
    if (typeof metadata?.numRows === "string" && metadata.numRows.length > 0) {
      const v = metadata.numRows;
      const n = Number(v);
      const safe = Number.isFinite(n) && Number.isSafeInteger(n);
      constraints.push({
        conname: "numRows",
        consrc: safe ? v : "unknown",
        contype: "meta",
        conkey: [],
        confrelidname: null,
        confkeycols: null,
      });
    }
    if (typeof metadata?.numBytes === "string" && metadata.numBytes.length > 0) {
      constraints.push({
        conname: "numBytes",
        consrc: metadata.numBytes,
        contype: "meta",
        conkey: [],
        confrelidname: null,
        confkeycols: null,
      });
    }
    if (typeof metadata?.creationTime === "string" && metadata.creationTime.length > 0) {
      constraints.push({
        conname: "creationTime",
        consrc: metadata.creationTime,
        contype: "meta",
        conkey: [],
        confrelidname: null,
        confkeycols: null,
      });
    }
    return { columns, constraints };
  }

  // ----- testConnection ----------------------------------------------------

  async testConnection(): Promise<void> {
    // Delegate to the same ADC smoke the constructor runs. If the adapter
    // is not yet connected, lazy-connect.
    if (this.client === null && !this.closed) {
      await this.connect();
      return;
    }
    const client = this.requireClient();
    const smoke = await runAdcSmoke(client as unknown as BigQueryClientLike);
    if (smoke !== "ok") {
      throw new BigQueryConnectError(smoke);
    }
  }

  // ----- internals ---------------------------------------------------------

  private requireClient(): BigQueryClient {
    if (this.closed) {
      throw new BigQueryClosedError();
    }
    if (this.client === null) {
      // Not connected (and not closed) — refuse rather than lazy-build.
      // Callers should connect() explicitly. Distinct from the closed
      // case so callers can disambiguate a never-connected adapter
      // from a post-close one. (BQ-02 may revisit.)
      throw new BigQueryNotConnectedError();
    }
    return this.client;
  }
}

// ===========================================================================
// Default factory — wraps BQ-00's `createBigQueryClient` and forwards
// `{projectId, location}` to a lazy-required `new BigQuery(opts)` call.
//
// The lazy `require` keeps the module import-time free of
// `@google-cloud/bigquery` side effects. The real `new BigQuery(...)`
// happens ONLY when the default factory is called (production usage), not
// at module load (so test imports don't materialize the GCP client).
// ===========================================================================

function defaultBigQueryClientFactory(opts: {
  projectId: string;
  location?: string;
}): BigQueryClient {
  // Per task Interfaces block + Discussion 2026-09-02: the default
  // implementation wraps BQ-00's `createBigQueryClient` and forwards
  // `{projectId, location}` to the underlying `new BigQuery(opts)` call.
  //
  // The seam is the SINGLE source of the client — we feed BQ-00's
  // `createBigQueryClient` an `impl` that constructs `new BigQuery`
  // with the merged options, and the seam's return value is what the
  // adapter keeps. No second `new BigQuery` is built, no discarded
  // intermediate. The lazy `require` keeps module import-time free of
  // `@google-cloud/bigquery` side effects; the real `new BigQuery(...)`
  // happens ONLY when the default factory is called (production usage).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BigQuery } = require("@google-cloud/bigquery") as typeof import("@google-cloud/bigquery");
  const real = createBigQueryClient(opts.projectId, (b00Opts) => {
    return new BigQuery({
      projectId: b00Opts.projectId ?? opts.projectId,
      ...(opts.location !== undefined ? { location: opts.location } : {}),
    }) as unknown as BigQueryClientLike;
  });
  return real as unknown as BigQueryClient;
}
