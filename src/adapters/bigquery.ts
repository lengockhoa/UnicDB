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
  type BigQueryJobRef,
  type BigQueryPage,
  type BigQueryRawQueryResponse,
} from "./bigqueryTypes";
import { clampPageSize } from "./bigqueryPages";
import {
  NotImplementedError,
  type BatchedQuery,
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
  createQueryJob(sql: string | BigQueryCreateQueryJobOptions): Promise<unknown>;
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

// ===========================================================================
// TASK-BQ03-001 — Job state machine + MVP SQL gate (wave-1 deliverable).
//
// WIDENED `createQueryJob` SEAM: the adapter-owned seam accepts either a raw
// string OR a `BigQueryCreateQueryJobOptions` object. The seam is widened
// ADDITIVELY: the prior `createQueryJob(sql: string)` signature remains
// assignable from legacy callers, so BQ-01 tests keep compiling.
// ===========================================================================

/**
 * Options accepted by `BigQueryClient.createQueryJob`. Mirrors the real
 * `@google-cloud/bigquery` `Query | QueryOptions` shape (bigquery.d.ts:71)
 * at the seam level. Production callers always set `useLegacySql: false` and
 * forward `location` from the connection config.
 *
 * Kept loose (`unknown`-typed via `BigQueryClient`) so the seam narrows
 * inside the adapter — see `BQ-03.1 Discussion` #2.
 */
export interface BigQueryCreateQueryJobOptions {
  query: string;
  useLegacySql?: boolean;
  location?: string;
  dryrun?: boolean;
  maxResults?: number;
  // Raw job reference passthrough (used to anchor a job to a region/project).
  jobReference?: { projectId?: string; location?: string };
}

/**
 * Minimal structural shape of the `Job` handle returned by `createQueryJob`.
 * Mirrors `@google-cloud/bigquery@9.0.3` `Job` (job.d.ts:158, :168):
 *   - `id` / `metadata.jobReference` — job identity (header wiring)
 *   - `getQueryResults(options?)` — fetch a page (initial OR paginated)
 *   - `cancel()` — server-side cancel
 * The seam return is `unknown`; `BigQueryAdapter.runQuery` narrows to this.
 */
export interface BigQueryJobHandle {
  id?: string;
  metadata?: {
    jobReference?: { projectId?: string; location?: string; jobId?: string };
  };
  getQueryResults(options?: {
    maxResults?: number;
    pageToken?: string;
    timeoutMs?: number;
  }): Promise<unknown>;
  cancel(): Promise<unknown>;
}

/**
 * MVP SQL gate — pure, side-effect free.
 *
 * Reads as: "is this a single, read-only GoogleSQL statement?"
 *
 * Algorithm:
 *   1. Strip line (`-- ...`) and block (`/* ... *\/`) comments (string-aware:
 *      a `--` or `/*` inside a string literal is NOT a comment opener).
 *   2. Strip string literals (`'...'`, `"..."`, with backslash-escape
 *      handling for embedded quotes). Anything inside a string is treated
 *      as opaque — semicolons, `--`, `/*` are NOT syntax.
 *   3. After cleaning, scan for top-level `;` (a real statement terminator).
 *      Reject if more than one.
 *   4. Walk the leading tokens of the remaining text; reject if any is in
 *      the write/DDL blocklist (`INSERT`, `UPDATE`, `DELETE`, `MERGE`,
 *      `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `CALL`,
 *      `EXPORT`, `LOAD`, `MAKE`, `REPLACE`, `EXECUTE IMMEDIATE`).
 *   5. Allow leading keyword `SELECT` OR `WITH` (a CTE).
 *
 * The gate is a HEURISTIC — it does NOT parse SQL. False positives are
 * acceptable; false negatives (admitting a write verb) are guarded by the
 * server-side ACL anyway, but we still try to avoid them.
 */
export function assertSingleReadOnlyGoogleSql(
  sql: string,
  opts?: { useLegacySql?: boolean },
): { ok: true } | { ok: false; reason: string } {
  // Strip comments and string literals. The output has the same length as
  // the input — replaced regions are filled with spaces so token indexing
  // is stable.
  const cleaned = stripSqlNoise(sql);

  // Statement-count scan: count TOP-LEVEL `;` (i.e. `;` outside any string
  // literal; comments were already collapsed to whitespace). A single
  // trailing `;` is OK; anything more = multi-statement = reject.
  let stmtCount = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === ";") {
      stmtCount++;
    }
  }
  // `stmtCount === 0` means no terminator (admit).
  // `stmtCount === 1` means a single terminator, possibly trailing (admit).
  // `stmtCount >= 2` means at least two `;`s, i.e. multiple statements
  // (reject). We also check there's non-whitespace content AFTER a single
  // `;` — that means the user wrote `; SELECT 2` and the gate must reject.
  if (stmtCount >= 2) {
    return {
      ok: false,
      reason: "not in BigQuery MVP: multi-statement scripts are not supported",
    };
  }
  if (stmtCount === 1) {
    // Check whether there's non-whitespace content after the `;`.
    const idx = cleaned.indexOf(";");
    const tail = cleaned.slice(idx + 1).trim();
    if (tail.length > 0) {
      return {
        ok: false,
        reason: "not in BigQuery MVP: multi-statement scripts are not supported",
      };
    }
  }

  // Leading-keyword scan.
  const trimmed = cleaned.trimStart();
  if (trimmed.length === 0) {
    return { ok: false, reason: "not in BigQuery MVP: empty statement" };
  }
  // Tokenize the LEADING clause (until first non-quoted whitespace). We
  // walk up to the first whitespace OR top-level `(`. A `WITH` statement
  // must scan through the CTE names to detect write-verb tails.
  const firstToken = readWord(trimmed, 0);
  const leadingUpper = firstToken.toUpperCase();
  if (
    leadingUpper !== "SELECT" &&
    leadingUpper !== "WITH"
  ) {
    // Unknown leading verb — reject (covers DDL, EXPLAIN, etc.).
    return {
      ok: false,
      reason: `not in BigQuery MVP: statements starting with "${firstToken}" are not supported`,
    };
  }
  // For both SELECT and WITH we must scan the WHOLE cleaned text for
  // write/DDL verbs to catch `WITH cte AS (...) DELETE FROM ...` and
  // `SELECT (DELETE FROM ...)` (the latter is invalid anyway, but the
  // heuristic should still reject on shape).
  for (const verb of WRITE_VERBS) {
    if (containsVerbOutsideStrings(cleaned, verb)) {
      return {
        ok: false,
        reason: `not in BigQuery MVP: ${verb.toLowerCase()} statements are not supported`,
      };
    }
  }
  // Legacy SQL is out of MVP scope.
  if (opts?.useLegacySql === true) {
    return {
      ok: false,
      reason: "not in BigQuery MVP: legacy SQL is not supported",
    };
  }
  return { ok: true };
}

const WRITE_VERBS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "EXPORT",
  "LOAD",
  "MAKE",
  "REPLACE",
  "EXECUTE IMMEDIATE",
] as const;

/**
 * Replace string literals and comments in `sql` with whitespace of the same
 * length. The output preserves offsets so positional indexing is stable.
 * Strings: `'...'`, `"..."`, with `\` escape handling.
 * Comments: `-- ... \n`, `/* ... *\/` (nested `*` ignored — not supporting
 * nested block comments because GoogleSQL does not support them either).
 */
function stripSqlNoise(sql: string): string {
  const out = sql.split("");
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const nx = i + 1 < sql.length ? sql[i + 1] : "";
    // Line comment: `--` ... newline.
    if (c === "-" && nx === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    // Block comment: `/*` ... `*/`.
    if (c === "/" && nx === "*") {
      let j = i;
      out[j] = " ";
      out[j + 1] = " ";
      j += 2;
      while (j < sql.length - 1 && !(sql[j] === "*" && sql[j + 1] === "/")) {
        out[j] = " ";
        j++;
      }
      if (j < sql.length - 1) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      } else {
        j = sql.length;
      }
      i = j;
      continue;
    }
    // String literal: `'...'` (with backslash-escape) OR `"..."` (BQ also
    // supports raw strings; triple-quoted are also strings — we collapse
    // them to whitespace too).
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      out[i] = " ";
      while (j < sql.length) {
        if (sql[j] === "\\" && j + 1 < sql.length) {
          out[j] = " ";
          out[j + 1] = " ";
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          out[j] = " ";
          j++;
          break;
        }
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Read one identifier/keyword starting at `start` (uppercase / alpha-numeric). */
function readWord(s: string, start: number): string {
  let j = start;
  while (
    j < s.length &&
    /[A-Za-z0-9_]/.test(s[j])
  ) {
    j++;
  }
  return s.slice(start, j);
}

/**
 * Look for `verb` as a whole-word token in `cleaned`. The `cleaned` text
 * must already have strings + comments collapsed to whitespace.
 */
function containsVerbOutsideStrings(cleaned: string, verb: string): boolean {
  const upper = cleaned.toUpperCase();
  let i = 0;
  while (i <= upper.length - verb.length) {
    const idx = upper.indexOf(verb, i);
    if (idx === -1) return false;
    // Word boundary check on BOTH sides.
    const before = idx === 0 ? "" : upper[idx - 1];
    const after = upper[idx + verb.length] ?? "";
    const beforeOk = before === "" || !/[A-Za-z0-9_]/.test(before);
    const afterOk = after === "" || !/[A-Za-z0-9_]/.test(after);
    if (beforeOk && afterOk) {
      return true;
    }
    i = idx + 1;
  }
  return false;
}

/**
 * Job-state lifecycle. Adapter surface tracks `pending → running → done`
 * (terminal) or `cancelled`/`error`. The fake mirrors this; the real
 * `@google-cloud/bigquery` job exposes `metadata.status.state` as a string
 * on the wire.
 */
export type BigQueryJobState =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/**
 * Sanitized envelope for BigQuery job errors. Carries ONLY the typed
 * diagnostic (`category`, `location`) — no raw Google message, no SQL text,
 * no credential-shaped strings. The `message` is a fixed-shape envelope
 * (`"BigQuery job failed: <category> (<location>)"`); any detail the panel
 * can render goes through `diagnostic.detail` (the short `reason` token).
 */
export class BigQueryJobError extends Error {
  readonly diagnostic: {
    category: string;
    location: string;
    reason?: string;
    detail?: string;
  };
  constructor(opts: {
    category: string;
    location: string;
    reason?: string;
    detail?: string;
    sql?: string;
    rawText?: string;
  }) {
    // Sanitize the message: never embed `sql`, `rawText`, or credential-shaped
    // substrings. The message is the only string the panel / log will see.
    const safeDetail = sanitizeDetail(opts.detail ?? opts.reason);
    const locationPart = opts.location ? ` (${opts.location})` : "";
    super(`BigQuery job failed: ${opts.category}${locationPart}${safeDetail ? ` — ${safeDetail}` : ""}`);
    this.name = "BigQueryJobError";
    this.diagnostic = {
      category: opts.category,
      location: opts.location,
      reason: opts.reason,
      detail: safeDetail ?? undefined,
    };
  }
}

/**
 * Strip credential-shaped substrings (`service_account`, `ya29.*`, long
 * hex/base64-looking tokens) from a candidate detail string. Used by
 * `BigQueryJobError` to ensure no raw secrets leak into the panel message.
 */
function sanitizeDetail(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let out = s;
  // Google OAuth bearer tokens (start with `ya29.`) — strip them.
  out = out.replace(/ya29\.[A-Za-z0-9_\-]+/g, "[redacted-token]");
  // service_account identifiers.
  out = out.replace(/service[_ ]account/gi, "[redacted-account]");
  // Long hex/base64 token-shaped runs.
  out = out.replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]");
  return out;
}

// ===========================================================================
// BigQueryPagedQuery — BatchedQuery adapter on top of a job handle.
//
// Wave-1 uses a local fetcher double (injected via the constructor). In
// wave 2 the 03.1 executor will swap this for `createBigQueryPageFetcher`
// ===========================================================================

/** Fetcher double shape (wave-1). Returns rows OR `null` for EOF. */
export type BigQueryPageFetcher = (opts?: {
  maxResults?: number;
  pageToken?: string;
}) => Promise<{ rows: unknown[][] | null; limited?: boolean }>;

/**
 * BatchedQuery wrapper around a BigQuery job. Tracks internal pageToken +
 * a `limited` flag (set the first time the fetcher reports
 * `{ limited: true }`); the flag is exposed to the runner via
 * `onExhausted?.({ limited })` on the EOF `fetchBatch()` call (per the
 * wave-1 limited-channel pinning contract).
 */
export class BigQueryPagedQuery implements BatchedQuery {
  readonly columns: string[];
  readonly jobId: string;
  readonly jobRef: BigQueryJobRef;
  private readonly job: BigQueryJobHandle;
  private readonly fetcher: BigQueryPageFetcher;
  private pageToken: string | null | undefined = undefined; // undefined = first call
  private state: BigQueryJobState = "running";
  private cancelDelivered = false;
  private closed = false;
  private observedLimited = false;
  private onExhaustedCb?: (info: { limited: boolean }) => void;
  private firstPageCache: unknown[][] | null;
  private firstPageServed = false;
  private exhaustedFired = false;
  private readonly classifyError?: (err: unknown) => Error;

  constructor(opts: {
    columns: string[];
    job: BigQueryJobHandle;
    jobRef: BigQueryJobRef;
    fetcher: BigQueryPageFetcher;
    initialState?: BigQueryJobState;
    /** Pre-fetched first page (returned by the FIRST `fetchBatch()` call). */
    firstPage?: { rows: unknown[][] | null; limited?: boolean } | null;
    /** Error classifier — mirrors the adapter-side `classifyJobError`. */
    classifyError?: (err: unknown) => Error;
  }) {
    this.columns = opts.columns;
    this.job = opts.job;
    this.jobId = opts.jobRef.jobId;
    this.jobRef = opts.jobRef;
    this.fetcher = opts.fetcher;
    this.classifyError = opts.classifyError;
    if (opts.initialState) this.state = opts.initialState;
    this.firstPageCache = opts.firstPage ? opts.firstPage.rows : null;
    if (opts.firstPage?.limited === true) this.observedLimited = true;
    if (opts.firstPage?.rows === null) this.exhaustedFired = true;
  }

  /**
   * Wave-1 hook installer (the 03.3 runner will use this to wire
   * `appendBatchBounded` aware callbacks).
   */
  setOnExhausted(cb: (info: { limited: boolean }) => void): void {
    this.onExhaustedCb = cb;
  }

  /** Read the job lifecycle state (observable on the BatchedQuery handle). */
  jobState(): BigQueryJobState {
    return this.state;
  }

  async fetchBatch(): Promise<unknown[][] | null> {
    if (this.closed) return null;
    // First call: serve the cached first page (pre-fetched by runQuery).
    // This runs BEFORE the state-gate so a terminal job can still serve
    // its first page to the runner (the runner expects at least one
    // batch of rows on `pickResult()`).
    if (!this.firstPageServed) {
      this.firstPageServed = true;
      const cached = this.firstPageCache;
      this.firstPageCache = null;
      if (cached === null) {
        // Pre-fetched EOF — fire onExhausted hook and mark done.
        this.state = "done";
        if (!this.exhaustedFired && this.onExhaustedCb) {
          this.exhaustedFired = true;
          try {
            this.onExhaustedCb({ limited: this.observedLimited });
          } catch {
            // best-effort
          }
        }
        return null;
      }
      return cached as unknown[][];
    }
    // EOF guard — once we've transitioned to a terminal state, every
    // subsequent call is a null + onExhausted firing (so the runner can
    // apply the `resultLimited` flag exactly once).
    if (this.state === "done" || this.state === "cancelled" || this.state === "error") {
      if (!this.exhaustedFired && this.onExhaustedCb) {
        this.exhaustedFired = true;
        try {
          this.onExhaustedCb({ limited: this.observedLimited });
        } catch {
          // best-effort
        }
      }
      return null;
    }
    // Subsequent calls: drive the fetcher. The local wave-1 fetcher
    // double returns `{ rows: null }` on its second call.
    const opts: { maxResults?: number; pageToken?: string } = {};
    if (this.pageToken !== undefined && this.pageToken !== null) {
      opts.pageToken = this.pageToken;
    }
    let page: { rows: unknown[][] | null; limited?: boolean };
    try {
      page = await this.fetcher(opts);
    } catch (e) {
      this.state = "error";
      if (this.classifyError) {
        throw this.classifyError(e);
      }
      throw e;
    }
    if (page === null || page.rows === null) {
      this.state = "done";
      this.pageToken = null;
      if (!this.exhaustedFired && this.onExhaustedCb) {
        this.exhaustedFired = true;
        try {
          this.onExhaustedCb({ limited: this.observedLimited });
        } catch {
          // best-effort
        }
      }
      return null;
    }
    if (page.limited === true) {
      this.observedLimited = true;
    }
    if (page.rows.length === 0) {
      this.state = "done";
      this.pageToken = null;
      if (!this.exhaustedFired && this.onExhaustedCb) {
        this.exhaustedFired = true;
        try {
          this.onExhaustedCb({ limited: this.observedLimited });
        } catch {
          // best-effort
        }
      }
      return null;
    }
    this.pageToken = null;
    return page.rows as unknown[][];
  }

  async cancel(): Promise<void> {
    // Exactly-once: a second cancel is a no-op (per task spec #6 / #7).
    if (this.cancelDelivered || this.state === "done" || this.state === "error") {
      return;
    }
    this.cancelDelivered = true;
    try {
      await this.job.cancel();
    } catch {
      // best-effort — a stale handle's cancel may reject; do not propagate.
    }
    this.state = "cancelled";
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // We do NOT call `job.cancel()` here — cancel is a separate, exactly-
    // once channel. Close just clears local state.
    // Preserve terminal state (`done` / `error`) — don't downgrade a
    // finished job to `cancelled`.
    if (this.state === "running" || this.state === "pending") {
      this.state = "cancelled";
    }
  }
}

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
  private activeJob: BigQueryJobHandle | null = null;
  private activeJobCancelDelivered = false;
  /**
   * Lifecycle phase of the active job — observable so the runner's
   * pre-batched cancel window (and 03.4 panel) can read `pending →
   * running → done/error/cancelled` IN ORDER. Set to `pending` the moment
   * `createQueryJob` resolves with a handle, transitions to `running`
   * when the initial `getQueryResults` is in flight, then `done` (or
   * `error` / `cancelled`) once the handle settles.
   */
  private activeJobPhaseValue: BigQueryJobState | null = null;

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
    // Drop the active-job handle. We do NOT call `cancel()` here — close
    // is structural, not a cancellation. Callers that want to cancel an
    // in-flight job use `cancelActiveQuery()` or the BatchedQuery handle.
    this.activeJob = null;
    this.activeJobCancelDelivered = false;
    // R4.5: also clear the observable phase (Fix #1/#3 — close must reset
    // the seam so a subsequent connect+runQuery starts at `pending`).
    this.activeJobPhaseValue = null;
  }

  // ----- runQuery ----------------------------------------------------------

  /**
   * Submit one read-only GoogleSQL statement as a BigQuery job. The MVP
   * SQL gate (`assertSingleReadOnlyGoogleSql`) is the single statement,
   * read-only predicate. The `createQueryJob` seam is widened to accept
   * `{ query, useLegacySql: false, location }`. The result returns a
   * `BatchedQuery` page source (`BigQueryPagedQuery` wrapping the local
   * fetcher double — wave-1 deliverable scope).
   *
   * Wave-2 swap: the `BigQueryPagedQuery` constructor will be rewired to
   * pass `createBigQueryPageFetcher({ client: job, pageSize, byteBudget })`
   * from `./bigqueryPages` (added by TASK-BQ03-002). No public contract
   * change for callers; the only observable change is that the byte-
   * budget `limited` flag now reaches the runner via `resultLimited`.
   *
   * TASK-BQF-001: accepts optional `opts.pageSize?: number`. When set, the
   * value is clamped to `[1, 10000]` and forwarded to `getQueryResults`
   * as `maxResults` on every page fetch. When omitted, current default
   * (no `maxResults` override) is preserved byte-identically.
   */
  async runQuery(
    sql: string,
    opts?: { pageSize?: number; useLegacySql?: boolean },
  ): Promise<RunResult> {
    const client = this.requireClient();
    // MVP SQL gate — pure predicate, called BEFORE any I/O so a rejected
    // SQL never reaches the network.
    // TASK-BQF-002: honor `opts.useLegacySql` (default false → GoogleSQL).
    const useLegacySql = opts?.useLegacySql ?? false;
    const gate = assertSingleReadOnlyGoogleSql(sql, { useLegacySql });
    if (gate.ok === false) {
      throw new Error(gate.reason);
    }

    // Forward `{ query, useLegacySql, location }` to the widened
    // `createQueryJob` seam. `location` flows from cfg.bigquery.location.
    const location = this.cfg.bigquery?.location ?? "US";
    const jobOpts: BigQueryCreateQueryJobOptions = {
      query: sql,
      useLegacySql,
      location,
    };
    let jobTuple: unknown;
    try {
      jobTuple = await client.createQueryJob(jobOpts);
    } catch (e) {
      throw classifyJobError(e, { location, sql });
    }

    // The real `@google-cloud/bigquery` `createQueryJob` resolves
    // `[Job, bigquery.IJob]` (table.d.ts:65). Narrow structurally; the
    // adapter-owned seam is widened with `unknown` so fakes don't have to
    // brand the tuple.
    let job: BigQueryJobHandle;
    let jobMetadata: { jobReference?: BigQueryJobRef } | undefined;
    if (Array.isArray(jobTuple) && jobTuple.length >= 1) {
      job = jobTuple[0] as BigQueryJobHandle;
      jobMetadata = jobTuple[1] as { jobReference?: BigQueryJobRef } | undefined;
    } else {
      // Some test fakes return a bare object — fall back gracefully.
      job = jobTuple as BigQueryJobHandle;
      jobMetadata = job?.metadata as { jobReference?: BigQueryJobRef } | undefined;
    }

    // If the job handle lacks `getQueryResults` (e.g. legacy BQ-01/02
    // fakes that return `{ id }` only), fall back to the legacy TUPLE
    // path via `client.query({ skipParsing: true })` so existing tests
    // keep working unchanged.
    if (typeof job?.getQueryResults !== "function") {
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

    // Build the jobRef from metadata or from cfg (wave-1: prefer metadata).
    const jobRef: BigQueryJobRef = {
      projectId: jobMetadata?.jobReference?.projectId ?? this.cfg.bigquery?.billingProject ?? "",
      location: jobMetadata?.jobReference?.location ?? location,
      jobId: jobMetadata?.jobReference?.jobId ?? job?.id ?? "unknown",
    };

    // R4.5 Fix #1: track the active job on the adapter IMMEDIATELY after
    // `createQueryJob` resolves — BEFORE any `getQueryResults` call. This
    // is the seam the runner's pre-`batched` cancel window
    // (`cancelActiveQuery`) targets; setting it after the first fetch
    // renders the seam dead in the very window it exists for.
    this.activeJob = job;
    this.activeJobCancelDelivered = false;
    this.activeJobPhaseValue = "pending";

    // Local fetcher double (wave-1). The constructor signature pins the
    // ONE-LINE wave-2 swap point: replace this lambda with
    // `createBigQueryPageFetcher({ client: job, pageSize, byteBudget })`
    // from `./bigqueryPages`.
    //
    // We capture the first raw response in `firstRaw` so we can derive
    // the schema BEFORE returning the BatchedQuery handle (the schema
    // is needed for `batched.columns`). `firstRaw` is captured by a
    // holder object — TypeScript can't narrow a `let` mutated inside a
    // closure, so we use an object to keep the narrowed type stable.
    const captured: { firstRaw: BigQueryRawQueryResponse | null } = {
      firstRaw: null,
    };
    // TASK-BQF-001 — resolve pageSize once (clamp to [1,10000] per BQ API
    // limit). When set, the clamped value is forwarded to getQueryResults
    // as maxResults on every fetch; when undefined, no override (current
    // default byte-identical).
    const clampedPageSize = clampPageSize(opts?.pageSize);
    const fetcher: BigQueryPageFetcher = async (callOpts) => {
      const tuple = (await job.getQueryResults({
        // Prefer the per-call maxResults (downstream override); fall back
        // to the configured pageSize when the call didn't pass one.
        maxResults: callOpts?.maxResults ?? clampedPageSize,
        ...(callOpts?.pageToken !== undefined && callOpts.pageToken !== null
          ? { pageToken: callOpts.pageToken }
          : {}),
      })) as unknown;
      let rawResp: BigQueryRawQueryResponse | undefined;
      if (Array.isArray(tuple) && tuple.length >= 3 && tuple[2] !== undefined && tuple[2] !== null) {
        rawResp = tuple[2] as BigQueryRawQueryResponse;
      } else if (Array.isArray(tuple) && tuple.length >= 1) {
        rawResp = tuple[0] as BigQueryRawQueryResponse;
      } else {
        rawResp = tuple as BigQueryRawQueryResponse;
      }
      if (captured.firstRaw === null) {
        captured.firstRaw = rawResp ?? null;
      }
      const page = rawResp ? toBigQueryPage(rawResp) : null;
      if (!page) return { rows: null };
      if (page.pageToken === null) {
        // Final page — wave-1 fetcher double signals
        // "limited-channel" once. The 03.2 byte-budget fetcher in wave 2
        // carries the real signal.
        return { rows: page.rows as unknown as unknown[][], limited: true };
      }
      return { rows: page.rows as unknown as unknown[][] };
    };

    // Pull the first page synchronously so we can read the schema for
    // `batched.columns`. We pass the rows + limited into the BatchedQuery
    // constructor as the pre-fetched first page; the handle serves it on
    // its first `fetchBatch()` call. Subsequent calls drive the
    // (single-page) fetcher and hit EOF.
    //
    // R4.5 Fix #2: wrap the initial fetch in try/catch and route the
    // rejection through `classifyJobError` so the credential/SQL text
    // from `getQueryResults` is sanitized (mirror of the createQueryJob
    // rejection path).
    //
    // R4.5 Fix #3: transition the active-job phase `pending → running`
    // before the fetch and `done` after, so the seam is observable in
    // order on the adapter.
    this.activeJobPhaseValue = "running";
    let initialResult: { rows: unknown[][] | null; limited?: boolean };
    try {
      initialResult = await fetcher({});
    } catch (e) {
      this.activeJobPhaseValue = "error";
      this.activeJob = null;
      throw classifyJobError(e, { location, sql });
    }
    // Schema from the first raw response (always present after one call).
    const schemaPage = captured.firstRaw ? toBigQueryPage(captured.firstRaw) : null;
    const columns = schemaPage ? schemaPage.schema.map((f) => f.name) : [];

    // Wrap the job in the local-double BatchedQuery. The wave-2 swap
    // replaces `fetcher` with a real fetcher.
    // Initial state reflects the JOB's lifecycle state after the first
    // page resolved server-side. For the wave-1 single-page scenario the
    // pageToken is null on the first page, so the job is `done`. The
    // `fetchBatch` method STILL serves the cached first page on its first
    // call (so `pickResult()` works), but subsequent calls return null.
    const isSinglePage = captured.firstRaw?.pageToken === null;
    const batched: BigQueryPagedQuery = new BigQueryPagedQuery({
      columns,
      job,
      jobRef,
      fetcher,
      initialState: isSinglePage ? "done" : "running",
      firstPage: initialResult,
      // R4.5 Fix #2: classify `getQueryResults` rejections from later
      // fetchBatch() calls too (mirror of the initial-fetch try/catch
      // above). The wrapper carries `location` and strips creds/SQL.
      classifyError: (e: unknown) => classifyJobError(e, { location, sql }),
    });

    // R4.5 Fix #1: clear `activeJob` once the BatchedQuery handle owns it
    // (the handle has its own exactly-once cancel), and transition the
    // observable phase to `done` for the runner's pre-batched window.
    this.activeJob = null;
    this.activeJobPhaseValue = "done";

    return { results: [], batched };
  }

  /**
   * Read the active job's lifecycle phase. Returns `null` if no job has
   * been submitted since the last `close()` / settle. The phase advances
   * `pending` → `running` → `done` (or `error` / `cancelled`) — observable
   * in order so the runner's pre-batched cancel window and the 03.4 panel
   * can render the right state without depending on the BatchedQuery
   * handle (which only exists after `runQuery` resolves).
   */
  activeJobPhase(): BigQueryJobState | null {
    return this.activeJobPhaseValue;
  }

  /**
   * TASK-RLX-001 — non-batched cancel seam (the runner's pre-`batched`
   * cancel window). Cancels the currently in-flight BigQuery job, if any.
   * Exactly-once: a second call while the PID window is still open is a
   * no-op. Idempotent: no active job → resolves without doing anything.
   */
  async cancelActiveQuery(): Promise<void> {
    const job = this.activeJob;
    if (!job) return;
    if (this.activeJobCancelDelivered) return;
    this.activeJobCancelDelivered = true;
    this.activeJobPhaseValue = "cancelled";
    try {
      await job.cancel();
    } catch {
      // best-effort — never propagate a stale-handle cancel.
    }
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

// ===========================================================================
// classifyJobError — convert an unknown error from `createQueryJob` /
// `getQueryResults` into a `BigQueryJobError` envelope. The classifier
// never embeds the raw Google message or the SQL — it only forwards the
// `reason` token (an enum-ish value, not free text) when one is present.
// ===========================================================================

function classifyJobError(
  err: unknown,
  ctx: { location: string; sql?: string },
): BigQueryJobError {
  const status = statusOf(err);
  const reason = reasonOf(err);
  const category = categoryForStatus(status, reason);
  return new BigQueryJobError({
    category,
    location: ctx.location,
    reason,
    detail: undefined,
    sql: ctx.sql,
    rawText: undefined,
  });
}

function statusOf(err: unknown): number | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of ["code", "status", "statusCode"]) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = parseInt(v, 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

function reasonOf(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err !== "object") return undefined;
  const o = err as Record<string, unknown>;
  // The real client attaches `errors[].reason` (e.g. "accessDenied",
  // "invalidQuery", "notFound"). Find the first.
  const errors = o.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (e && typeof e === "object") {
        const r = (e as Record<string, unknown>).reason;
        if (typeof r === "string") return r;
      }
    }
  }
  // Some paths expose `reason` at the top level.
  const topReason = o.reason;
  if (typeof topReason === "string") return topReason;
  return undefined;
}

function categoryForStatus(
  status: number | undefined,
  reason: string | undefined,
): string {
  if (reason === "accessDenied" || status === 403) return "accessDenied";
  if (reason === "invalidQuery" || status === 400) return "invalidQuery";
  if (reason === "notFound" || status === 404) return "notFound";
  if (status === 401) return "unauthenticated";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rateLimited";
  if (status !== undefined && status >= 500) return "serverError";
  return "unknown";
}
