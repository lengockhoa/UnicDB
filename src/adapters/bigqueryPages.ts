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
 *
 * TASK-BQF-001: `pageSize` clamps to `[1, 10000]` and is forwarded as
 * `maxResults` on every `fetch()` call (BQ REST API cap). When omitted, no
 * `maxResults` override is sent — current default behaviour byte-identical.
 */
export interface BigQueryPageFetcherDeps {
  fetch: BigQueryRawFetch;
  byteBudget?: number;
  pageSize?: number;
}

/**
 * TASK-BQF-001 — clamp `pageSize` to BQ's `[1, 10000]` window.
 * Below floor (≤ 0) → 1 (BQ API minimum). Above ceiling → 10000 (BQ API cap).
 * Non-integer / NaN → undefined (no override; preserves current default).
 * Exported for direct use by `BigQueryAdapter.runQuery` (which threads the
 * clamped value into its inline fetcher closure before delegating to
 * `createBigQueryPageFetcher`).
 */
export function clampPageSize(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw)) return undefined;
  if (!Number.isInteger(raw)) return undefined;
  if (raw < 1) return 1;
  if (raw > 10000) return 10000;
  return raw;
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

  // TASK-BQF-001 — resolve pageSize once at construction. Clamp to
  // `[1, 10000]` per BQ REST API limit; undefined when absent or invalid.
  const clampedPageSize = clampPageSize(deps.pageSize);

  const callFetch = async (
    pageToken?: string,
  ): Promise<BigQueryPageFetch> => {
    const raw = (await deps.fetch({
      ...(clampedPageSize !== undefined ? { maxResults: clampedPageSize } : {}),
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
 *   - STRING / JSON / BYTES → raw text verbatim.
 *   - DATE / DATETIME / TIME / TIMESTAMP → raw text verbatim when no `field`
 *     context is provided. When `field.type` matches a temporal BQ type AND
 *     `field.locale` is set, format via `Intl.DateTimeFormat` (TASK-BQF-003).
 *     Invalid temporal strings fall back to verbatim.
 *   - BOOLEAN → "true" / "false".
 *   - FLOAT64 (branded `number`) → standard numeric string.
 *   - null → "" (agreed empty marker).
 *   - REPEATED (Array<{ v }>) → single-line, deterministic, element order
 *     preserved; elements wrapped per RECORD/REPEATED.
 *   - RECORD ({ f: BigQueryValue[] }) → single-line, deterministic, child
 *     order preserved; INT64 children stay strings.
 *
 * The `field` argument is optional context (schema column descriptor). It is
 * currently used only for the locale-aware temporal branch (TASK-BQF-003);
 * other branches are decided by the value's brand, not by the field.
 *
 * TASK-BQF-003 widening: the parameter type is a local `BigQuerySchemaFieldLike`
 * structural alias (rather than the frozen `BigQuerySchemaField`) so we can
 * carry an optional `locale` without editing the frozen `bigqueryTypes.ts`.
 * `BigQuerySchemaField` remains structurally assignable to this alias
 * (every key is optional), so callers using the frozen type keep working.
 *
 * Per PLAN.md §2 Out of scope, this helper is NOT wired into the results grid
 * in this cycle (BQ-04 or later). RECORD/REPEATED keep the existing
 * `ResultsPanel` rendering. The function ships tested + exported.
 */

// ---------------------------------------------------------------------------
// TASK-BQF-003 — locale-aware temporal formatting
// ---------------------------------------------------------------------------

/**
 * Temporal BQ types this branch recognizes. The list mirrors the BQ wire
 * shape: DATE = `YYYY-MM-DD`, TIME = `HH:MM:SS[.fff]`,
 * DATETIME = `YYYY-MM-DD HH:MM:SS[.fff]`,
 * TIMESTAMP = `YYYY-MM-DD HH:MM:SS[.fff] [timezone]`.
 *
 * Anything not in this set falls through to the verbatim string branch —
 * we do NOT try to coerce arbitrary strings into dates.
 */
const TEMPORAL_TYPES = new Set(["DATE", "TIME", "DATETIME", "TIMESTAMP"]);

/**
 * Build a `Date` from a BQ temporal wire string. Returns `undefined` when the
 * string is empty or unparseable, so the caller can fall back to verbatim.
 *
 * Behavior:
 *   - DATE `2024-09-05`                    → parsed as UTC midnight.
 *   - TIME `12:34:56`                      → synthesized as today + time UTC,
 *                                            so Intl.DateTimeFormat can render
 *                                            a time-of-day consistently.
 *   - DATETIME `2024-09-05 12:34:56`       → parsed as UTC.
 *   - TIMESTAMP `2024-09-05T12:34:56Z`     → parsed via `new Date(...)` so the
 *                                            ISO-8601 timezone offset is honored.
 *
 * The TIME branch is intentionally narrow: `new Date("12:34:56")` returns an
 * `Invalid Date`, so we synthesize a UTC anchor. `Intl.DateTimeFormat` with
 * `hour` / `minute` / `second` renders the time-of-day correctly even though
 * the anchor date is not the user's local date.
 */
function parseBqTemporal(type: string, value: string): Date | undefined {
  if (!value) return undefined;
  if (type === "DATE") {
    // YYYY-MM-DD → Date(UTC midnight).
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return undefined;
    const [, y, mo, d] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    return Number.isNaN(dt.getTime()) ? undefined : dt;
  }
  if (type === "TIME") {
    // HH:MM:SS[.fff] → synthesize today UTC at that time-of-day.
    const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(value);
    if (!m) return undefined;
    const [, hh, mm, ss, frac] = m;
    const ms = frac ? Number(`0.${frac}`) * 1000 : 0;
    const dt = new Date(Date.UTC(1970, 0, 1, Number(hh), Number(mm), Number(ss), Math.round(ms)));
    return Number.isNaN(dt.getTime()) ? undefined : dt;
  }
  if (type === "DATETIME") {
    // YYYY-MM-DD HH:MM:SS[.fff] (no offset) → parsed as UTC.
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(value);
    if (!m) return undefined;
    const [, y, mo, d, hh, mm, ss, frac] = m;
    const ms = frac ? Number(`0.${frac}`) * 1000 : 0;
    const dt = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss), Math.round(ms)),
    );
    return Number.isNaN(dt.getTime()) ? undefined : dt;
  }
  if (type === "TIMESTAMP") {
    // ISO-8601 with offset → `new Date` honors the offset.
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? undefined : dt;
  }
  return undefined;
}

/**
 * Pick the `Intl.DateTimeFormat` options that match a BQ temporal type.
 * DATE → date only, TIME → time only, DATETIME / TIMESTAMP → both.
 */
function temporalFormatOptions(type: string): Intl.DateTimeFormatOptions | undefined {
  if (type === "DATE") return { year: "numeric", month: "2-digit", day: "2-digit" };
  if (type === "TIME") return { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  if (type === "DATETIME" || type === "TIMESTAMP") {
    return {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    };
  }
  return undefined;
}

/**
 * Format a BQ temporal string via `Intl.DateTimeFormat` (TASK-BQF-003).
 *
 * Returns `undefined` when the type is not temporal OR when parsing fails,
 * so the caller can fall back to the verbatim string (the safe default).
 *
 * `locale` is forwarded as-is to `Intl.DateTimeFormat` — invalid tags fall
 * back to the runtime default, which is acceptable for display purposes.
 */
function formatTemporalString(
  type: string,
  value: string,
  locale: string,
): string | undefined {
  if (!TEMPORAL_TYPES.has(type)) return undefined;
  const dt = parseBqTemporal(type, value);
  if (!dt) return undefined;
  const opts = temporalFormatOptions(type);
  if (!opts) return undefined;
  try {
    return new Intl.DateTimeFormat(locale, opts).format(dt);
  } catch {
    // Invalid locale tag → Intl throws. Fall back to verbatim.
    return undefined;
  }
}


/**
 * TASK-BQF-003 — local structural alias extending the frozen
 * `BigQuerySchemaField` with an optional `locale` opt for locale-aware
 * temporal formatting. The frozen type stays untouched; callers passing
 * `BigQuerySchemaField` are still assignable (every key is optional here too).
 */
export interface BigQuerySchemaFieldLike {
  name?: string;
  type?: string;
  mode?: string;
  fields?: BigQuerySchemaFieldLike[];
  /** TASK-BQF-003 — BCP-47 locale tag for `Intl.DateTimeFormat`. */
  locale?: string;
}

export function formatBigQueryCell(
  value: BigQueryValue | null | undefined,
  field?: BigQuerySchemaFieldLike,
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
  // INT64 / NUMERIC / BIGNUMERIC / STRING / JSON / BYTES (base64) flow
  // through this branch verbatim. Temporal strings (DATE / TIME / DATETIME /
  // TIMESTAMP) ALSO flow through verbatim UNLESS the `field.locale` opt is
  // supplied (TASK-BQF-003) — then we attempt locale-aware formatting and
  // fall back to the raw string on parse failure.
  if (typeof value === "string") {
    if (field?.type && field.locale) {
      const formatted = formatTemporalString(field.type, value, field.locale);
      if (formatted !== undefined) return formatted;
    }
    return value;
  }

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