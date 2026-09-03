// src/adapters/bigqueryPages.ts
//
// TASK-BQ03-002 — BigQuery result page bridge (pure helpers).
//
// Purity contract (HARD CONSTRAINT):
//   - NO `@google-cloud/bigquery`, NO `vscode`, NO I/O.
//   - Only `./bigqueryTypes` imports (frozen surface, import-only).
//   - Deterministic across calls: a second `first()` yields byte-equal output.
//
// Exports:
//   - createBigQueryPageFetcher(deps): token-verbatim continuation helper that
//     wraps a raw `getQueryResults` tuple into a bounded `BigQueryPageFetch`.
//   - formatBigQueryCell(value, field?): display formatter for `BigQueryValue`
//     cells that preserves INT64/NUMERIC/BIGNUMERIC/BYTES/JSON/temporal/RECORD/
//     REPEATED display semantics WITHOUT `Number()` coercion.
//
// Byte-budget choice (documented per task Discussion #2):
//   We compare ONE figure per page — `totalBytesProcessed` from the raw wire
//   response (forwarded verbatim through the frozen `toBigQueryPage` mapper).
//   When present, it is the page-level bytes-projected value (BigQuery
//   reports `totalBytesProcessed` as a per-query cumulative figure; for
//   paged reads we treat it as the page-level projection because per-page
//   bytes are not surfaced in the installed client's wire contract). When
//   absent, we fall back to a row-bytes estimate: sum of `JSON.stringify`-
//   derived byte lengths of each row — advisory at the seam, never used
//   to mutate or accumulate all results.
//
//   This module MARKS pages (`limited: true`) but NEVER truncates or
//   accumulates: a budget-exceeding page is delivered as-is with the flag
//   set, so the caller can decide how to surface the bound.

import {
  toBigQueryPage,
  type BigQueryPage,
  type BigQueryRawQueryResponse,
  type BigQuerySchemaField,
  type BigQueryValue,
} from "./bigqueryTypes";

// ===========================================================================
// Public types
// ===========================================================================

/**
 * One page of a BigQuery query result, as returned by the page fetcher.
 *
 *   - `page`:   the contract `BigQueryPage` (frozen mapper output)
 *   - `rows`:   `unknown[][]` — the rows projected to JS-array shape; downstream
 *               consumers cast through `BigQueryValue` as needed
 *   - `limited`: true iff the page was marked over-budget by the byte check;
 *                the rows themselves are NOT mutated or accumulated
 */
export interface BigQueryPageFetch {
  page: BigQueryPage;
  rows: unknown[][];
  limited: boolean;
}

/**
 * Options passed to the `fetch` dependency. `maxResults` and `pageToken` are
 * forwarded from `first()` (no token) / `next()` (last seen token).
 */
export interface BigQueryFetchOptions {
  maxResults?: number;
  pageToken?: string;
}

/** The raw-page fetcher dependency. The client's `Job.getQueryResults` is
 *  structurally compatible with this signature. */
export type BigQueryRawFetch = (
  opts: BigQueryFetchOptions,
) => Promise<unknown>;

/**
 * Constructor deps for the page bridge. `byteBudget` is advisory at the seam;
 * omitting it disables byte-budget marking (`limited` is always false).
 */
export interface BigQueryPageFetcherDeps {
  fetch: BigQueryRawFetch;
  byteBudget?: number;
}

/**
 * The page-fetcher handle. `first()` returns the first page (token-less call).
 * `next()` returns the next page when the last seen token is non-null, or
 * `null` once the last seen `pageToken` is `null` (EOF). `exhausted` flips
 * to `true` once the last seen token is `null`.
 */
export interface BigQueryPageFetcher {
  first(): Promise<BigQueryPageFetch>;
  next(): Promise<BigQueryPageFetch | null>;
  readonly exhausted: boolean;
}

// ===========================================================================
// Internal helpers — pure, no I/O
// ===========================================================================

/**
 * Resolve a per-page byte figure for the budget check. Prefers
 * `totalBytesProcessed` (forwarded verbatim by `toBigQueryPage`); falls back
 * to a row-bytes estimate when absent. Returns `undefined` for empty pages
 * with no `totalBytesProcessed` (nothing to compare — caller treats it as
 * `limited: false`).
 */
function resolvePageBytes(
  page: BigQueryPage,
  rows: unknown[][],
): number | undefined {
  if (page.totalBytesProcessed !== undefined) {
    const n = Number(page.totalBytesProcessed);
    // `Number()` on a stringified non-negative integer is safe (within the
    // 53-bit precision window — BigQuery reports bytes < 2^53 in CI fixtures).
    // Guard against NaN just in case (e.g. malformed wire data).
    return Number.isFinite(n) ? n : undefined;
  }
  // Fallback: row-bytes estimate via JSON serialization (advisory only —
  // never used to mutate or accumulate the page).
  if (rows.length === 0) return undefined;
  let total = 0;
  for (const row of rows) {
    try {
      total += JSON.stringify(row).length;
    } catch {
      // Cycles or unserializable values — fall back to a conservative row
      // size of 1 KiB so the budget check still has SOME signal.
      total += 1024;
    }
  }
  return total;
}

/**
 * Check the page against the configured budget. Returns `true` iff the page
 * is over budget (and `limited` should be set). When no budget is configured,
 * always returns `false`.
 */
function checkBudget(
  bytes: number | undefined,
  budget: number | undefined,
): boolean {
  if (budget === undefined) return false;
  if (bytes === undefined) return false;
  return bytes > budget;
}

/**
 * Wrap a raw `BigQueryRawQueryResponse` (or anything the frozen mapper
 * accepts) into a `BigQueryPageFetch`. Centralizes the `toBigQueryPage` +
 * budget-check seam so `first()` and `next()` share it.
 */
function buildFetchResult(
  raw: BigQueryRawQueryResponse,
  budget: number | undefined,
): BigQueryPageFetch {
  // Compose the frozen mapper — do NOT reimplement the wire-to-contract
  // mapping (TASK-BQ03-002 test #11).
  const page = toBigQueryPage(raw);
  const rows = page.rows as unknown[][];
  const bytes = resolvePageBytes(page, rows);
  const limited = checkBudget(bytes, budget);
  return { page, rows, limited };
}

// ===========================================================================
// createBigQueryPageFetcher — page bridge factory
// ===========================================================================

/**
 * Build a `BigQueryPageFetcher` from a raw `getQueryResults` shim.
 *
 * - `first()` calls `fetch({})` (no token).
 * - `next()` calls `fetch({ pageToken: <last seen token> })` and returns the
 *   resulting `BigQueryPageFetch`. Returns `null` once the last seen token
 *   is `null` (terminal page) and `exhausted` flips to `true`.
 *
 * The token is preserved VERBATIM through the frozen `toBigQueryPage` mapper
 * (no trim, no decode, no normalize). `pageToken === null` is the only
 * signal for "no more pages" — row count NEVER decides continuation.
 */
export function createBigQueryPageFetcher(
  deps: BigQueryPageFetcherDeps,
): BigQueryPageFetcher {
  // Closure-held state. `lastToken === null` after a terminal page signals
  // exhaustion. The fetcher is single-threaded JS (no concurrent `next()`).
  let lastToken: string | null | undefined = undefined;
  let exhaustedFlag = false;

  const callFetch = async (
    pageToken?: string,
  ): Promise<BigQueryPageFetch> => {
    const raw = (await deps.fetch({
      ...(pageToken !== undefined ? { pageToken } : {}),
    })) as BigQueryRawQueryResponse;
    return buildFetchResult(raw, deps.byteBudget);
  };

  return {
    async first(): Promise<BigQueryPageFetch> {
      const result = await callFetch(undefined);
      lastToken = result.page.pageToken;
      if (lastToken === null) exhaustedFlag = true;
      return result;
    },
    async next(): Promise<BigQueryPageFetch | null> {
      // Already terminal? No more pages.
      if (exhaustedFlag || lastToken === null) {
        exhaustedFlag = true;
        return null;
      }
      // No first() yet → behave like first() but keep contract semantics
      // (lastToken is still undefined, so we call fetch without a token).
      const result = await callFetch(lastToken);
      lastToken = result.page.pageToken;
      if (lastToken === null) exhaustedFlag = true;
      return result;
    },
    get exhausted(): boolean {
      return exhaustedFlag;
    },
  };
}

// ===========================================================================
// formatBigQueryCell — display formatter (deliverable-but-unwired this cycle)
// ===========================================================================

/**
 * Render a `BigQueryValue` as a display string. Preserves display semantics:
 *
 *   - INT64 / NUMERIC / BIGNUMERIC branded strings → canonical string (NO
 *     `Number()` coercion, no scientific notation, no rounding).
 *   - STRING / DATE / TIME / TIMESTAMP / DATETIME / JSON → raw text verbatim.
 *   - BYTES → base64 text verbatim (no decode).
 *   - BOOLEAN → "true" / "false".
 *   - FLOAT64 (branded `number`) → standard numeric string.
 *   - null → "" (agreed empty marker).
 *   - REPEATED (Array<{ v }>) → single-line, deterministic, element order
 *     preserved; elements wrapped per RECORD/REPEATED.
 *   - RECORD ({ f: BigQueryValue[] }) → single-line, deterministic, child
 *     order preserved; INT64 children stay strings.
 *
 * The `field` argument is optional context (schema column descriptor). It is
 * currently unused for STRING/NUMERIC-family — those branches are decided by
 * the value's brand, not by the field. Reserved for future schema-aware
 * rendering (e.g. locale-formatted temporal types).
 *
 * Per PLAN.md §2 Out of scope, this helper is NOT wired into the results grid
 * in this cycle (BQ-04 or later). RECORD/REPEATED keep the existing
 * `ResultsPanel` rendering. The function ships tested + exported.
 */
export function formatBigQueryCell(
  value: BigQueryValue | null | undefined,
  _field?: BigQuerySchemaField,
): string {
  // null / undefined → empty marker.
  if (value === null || value === undefined) return "";

  // BOOLEAN → "true" / "false".
  if (typeof value === "boolean") return value ? "true" : "false";

  // FLOAT64 (branded number) — emit the standard numeric representation.
  // The brand is stripped via String(); the value was assigned through the
  // brand so downstream consumers can rely on `typeof === "number"`.
  if (typeof value === "number") return String(value);

  // All string-typed values stay canonical — NO `Number()` coercion.
  // INT64 / NUMERIC / BIGNUMERIC / STRING / TIME / DATE / DATETIME / TIMESTAMP
  // / JSON / BYTES (base64) all flow through this branch verbatim.
  if (typeof value === "string") return value;

  // REPEATED — Array<{ v: BigQueryValue }>. Compact single-line, deterministic
  // child order, recursive cell rendering.
  if (Array.isArray(value)) {
    const parts = value.map((cell) => {
      // REPEATED cell is `{ v: BigQueryValue }` — extract `v` and recurse.
      if (cell && typeof cell === "object" && "v" in cell) {
        return formatBigQueryCell(cell.v as BigQueryValue);
      }
      // Defensive fallback for a bare value (shouldn't occur at the seam,
      // but keeps the formatter total).
      return formatBigQueryCell(cell as BigQueryValue);
    });
    return `[${parts.join(",")}]`;
  }

  // RECORD — { f: BigQueryValue[] }. Compact single-line, positional cells,
  // recursive rendering so nested INT64 children stay strings.
  if (typeof value === "object" && "f" in value) {
    const cells = (value as { f: BigQueryValue[] }).f ?? [];
    const parts = cells.map((c) => formatBigQueryCell(c));
    return `{${parts.join(",")}}`;
  }

  // Defensive fallback — should be unreachable given the `BigQueryValue`
  // union. JSON-serialize so nothing is silently dropped.
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}