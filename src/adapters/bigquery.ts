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
  type DbAdapter,
  type QueryResult,
  type RunResult,
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
 */
export interface BigQueryClient {
  query(sql: string, opts?: BigQueryQueryOptions): Promise<unknown>;
  getQueryResults(jobId: string, opts?: unknown): Promise<unknown>;
  createQueryJob(sql: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  listDatasets(projectId?: string): Promise<Array<{ id?: string }>>;
  getDataset(id: string): Promise<unknown>;
  getTable(datasetId: string, tableId: string): Promise<unknown>;
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
    const resolved = (await client.query(sql, { skipParsing: true })) as unknown;
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
      durationMs: 0,
    };
    return { results: [result] };
  }

  // ----- introspection (BQ-02 scope — throw NotImplementedError) ----------

  async listSchemas(_includeSystem: boolean): Promise<import("./types").SchemaInfo[]> {
    throw new NotImplementedError("bigquery");
  }
  async listTables(_schema?: string): Promise<import("./types").TableInfo[]> {
    throw new NotImplementedError("bigquery");
  }
  async listViews(_schema?: string): Promise<import("./types").ViewInfo[]> {
    throw new NotImplementedError("bigquery");
  }
  async listRoutines(_schema?: string): Promise<import("./types").RoutineInfo[]> {
    throw new NotImplementedError("bigquery");
  }
  async listColumns(_table: string, _schema?: string): Promise<import("./types").ColumnInfo[]> {
    throw new NotImplementedError("bigquery");
  }
  async listRoutineParams(
    _schema: string,
    _routine: string,
  ): Promise<Array<{ name: string | null; dataType: string }>> {
    throw new NotImplementedError("bigquery");
  }
  async estimateTableRows(_schema: string, _table: string): Promise<number | null> {
    throw new NotImplementedError("bigquery");
  }
  async estimateTableRowsBatch(
    _schema: string,
    _tables: readonly string[],
  ): Promise<Map<string, number | null>> {
    throw new NotImplementedError("bigquery");
  }
  async listTableDetail(
    _schema: string,
    _table: string,
  ): Promise<import("./types").TableDetail> {
    throw new NotImplementedError("bigquery");
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
      // Not connected — refuse rather than lazy-build. Callers should
      // connect() explicitly. (BQ-02 may revisit; tests #6 expects the
      // closed-error, which the closed branch returns.)
      throw new BigQueryClosedError();
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
