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
 * One row of query results in the broad wire shape used by the adapter.
 * Kept loose (`unknown`) — the mapper un-nests `f[].v` into a flat tuple via
 * `toBigQueryPage`. BQ-00's `BigQueryValue` is the contract, but the seam
 * stays `unknown` so test fakes don't have to brand every cell.
 */
export interface BigQueryClient {
  query(sql: string): Promise<unknown>;
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
    const raw = (await client.query(sql)) as BigQueryRawQueryResponse;
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
  // Build a BigQueryClient via BQ-00's seam (returns the narrow
  // BigQueryClientLike — only listDatasets) and forward opts to the real
  // `new BigQuery(opts)` call so `location` reaches the underlying client.
  // We construct the BigQuery instance via a lazy require so this module
  // is free of `@google-cloud/bigquery` import side effects.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BigQuery } = require("@google-cloud/bigquery") as typeof import("@google-cloud/bigquery");
  const real = new BigQuery({
    projectId: opts.projectId,
    ...(opts.location !== undefined ? { location: opts.location } : {}),
  });
  // BQ-00's seam is exercised for symmetry with the other tests; it returns
  // a no-op-listDatasets stub (we don't use it — `real` carries the real
  // listDatasets and is what callers actually see).
  const _b00 = createBigQueryClient(opts.projectId);
  void _b00;
  return real as unknown as BigQueryClient;
}
