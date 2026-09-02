// src/adapters/bigqueryTypes.ts
//
// TASK-BQ00-002 — pure boundary types + the named mapper `toBigQueryPage` +
// the `hasNextPage` helper that maps BigQuery's async-job + paged-result API
// into VSDB's adapter world.
//
// HARD CONSTRAINT: this module MUST NOT import from `@google-cloud/bigquery` or
// `vscode`. The client's response contract is captured ONLY as the locally
// declared `BigQueryRawQueryResponse` type below — the field names were
// validated against the installed client's `.d.ts` in this task's Discussion:
//   - IGetQueryResultsResponse (types.d.ts:2075..2124):
//       jobReference, schema, pageToken?, rows?, totalBytesProcessed?
//   - IJobReference (types.d.ts:3149..3162):
//       projectId?, location?, jobId?
//   - ITableSchema / ITableFieldSchema (types.d.ts:5858..5900, 6142..6147):
//       fields: Array<ITableFieldSchema> with name?, type?, mode?, fields?
//   - ITableRow / ITableCell (types.d.ts:6132..6137, 5711):
//       { f?: Array<{ v?: any }> }
// The mapper `toBigQueryPage` un-nests `rows[].f[].v` into `BigQueryValue[][]`
// and lifts `jobReference` into the strongly-typed `BigQueryJobRef` shape used
// everywhere downstream.

// ===========================================================================
// Boundary types — pure VSDB code. No runtime client import.
// ===========================================================================

/**
 * Reference to a BigQuery job. Async-job + paged-result API uses this triple
 * to resume pagination via `GetQueryResults` (see `BigQueryPageRequest`).
 */
export interface BigQueryJobRef {
  projectId: string;
  location: string; // BigQuery location, e.g. "US" | "EU" | region
  jobId: string;
}

/**
 * One column / field in a BigQuery result schema.
 * `fields` is present when `type === "RECORD"` — nested RECORD schemas recurse
 * through the same shape.
 */
export interface BigQuerySchemaField {
  name: string;
  type: string; // e.g. "STRING" | "INT64" | "NUMERIC" | "BIGNUMERIC" | "RECORD" | ...
  mode: "NULLABLE" | "REQUIRED" | "REPEATED";
  fields?: BigQuerySchemaField[];
}

/**
 * One BigQuery value. Decimal / int classes are contractually canonical
 * STRINGS — never JS `number`. The client's wire-format already returns them
 * as strings, and any `Number` coercion would silently lose precision past
 * `Number.MAX_SAFE_INTEGER`. FLOAT64 alone is `number`.
 *
 *   - string      → STRING, INT64, NUMERIC, BIGNUMERIC, DATE/TIME family,
 *                   BYTES (b64), JSON
 *   - boolean
 *   - number      → FLOAT64 only
 *   - null
 *   - BigQueryValue[]  → REPEATED
 *   - { [field: string]: BigQueryValue }  → RECORD
 */
export type BigQueryValue =
  | string
  | boolean
  | number
  | null
  | BigQueryValue[]
  | { [field: string]: BigQueryValue };

/**
 * One page of a BigQuery query result.
 *
 * `pageToken` is the continuation handle:
 *   - non-null → more pages available; pass it to the next request
 *   - null     → final page (no more results)
 *
 * Ownership rule (pinned by tests #2/#3): continuation is decided by the
 * token, NEVER by row count. An empty page with a non-null token still
 * continues.
 */
export interface BigQueryPage {
  jobRef: BigQueryJobRef;
  schema: BigQuerySchemaField[];
  rows: BigQueryValue[][];
  totalBytesProcessed?: string; // bytes as string (may exceed safe integer)
  totalBytesBilled?: string;
  pageToken: string | null; // null = final page
}

/**
 * Request shape for the next page of a paginated result. Token (when present)
 * flows through verbatim — no parse, no trim, no truncate.
 */
export interface BigQueryPageRequest {
  jobRef: BigQueryJobRef;
  pageToken?: string;
  maxResults?: number;
}

// ===========================================================================
// Raw response shape — declared locally to keep this file free of imports
// from `@google-cloud/bigquery`. Field names mirror the installed client's
// `.d.ts` (see Discussion for file:line refs).
// ===========================================================================

/** Local mirror of the client's `ITableCell` (`{ v?: any }`). */
interface RawTableCell {
  v?: unknown;
}

/** Local mirror of the client's `ITableRow` (`{ f?: ITableCell[] }`). */
interface RawTableRow {
  f?: RawTableCell[];
}

/**
 * Local mirror of the client's `ITableFieldSchema`. `name` and `type` are
 * required in practice but the client marks them optional; we keep the
 * optionality on the raw side and enforce it in the mapped output.
 */
interface RawTableFieldSchema {
  name?: string;
  type?: string;
  mode?: string;
  fields?: RawTableFieldSchema[];
}

/** Local mirror of the client's `ITableSchema`. */
interface RawTableSchema {
  fields?: RawTableFieldSchema[];
}

/** Local mirror of the client's `IJobReference`. */
interface RawJobReference {
  projectId?: string;
  location?: string;
  jobId?: string;
}

/**
 * The raw client response shape passed into `toBigQueryPage`. This matches the
 * installed client's `IGetQueryResultsResponse` (types.d.ts:2075..2124) so the
 * mapper accepts the wire response directly without coercion of field names.
 *
 * NOTE: this is a DECLARED shape, not an import — the source file remains free
 * of any runtime client coupling.
 */
export interface BigQueryRawQueryResponse {
  jobReference?: RawJobReference;
  schema?: RawTableSchema;
  rows?: RawTableRow[];
  pageToken?: string;
  totalBytesProcessed?: string;
  totalBytesBilled?: string;
}

// ===========================================================================
// Helper — continuation predicate (token-driven, NEVER row-count-driven).
// ===========================================================================

/**
 * `true` iff the page has more results to fetch. The continuation handle is
 * the `pageToken`; an empty page with a non-null token still continues. This
 * rule is pinned by tests #2 (null token → false) and #3 (non-null token →
 * true even when `rows` is empty).
 */
export function hasNextPage(
  page: Pick<BigQueryPage, "pageToken">,
): boolean {
  return page.pageToken !== null;
}

// ===========================================================================
// Named mapper — raw client response → contract `BigQueryPage`.
// Pure: deterministic, no I/O, no imports. Row cells `f[].v` are un-nested
// into a flat `BigQueryValue[]` per row. `pageToken` is preserved verbatim
// (no parse, no trim, no truncate) — the test #4 contract.
// ===========================================================================

/**
 * Default fallback for `mode` when the wire response omits it (the client
 * documents `NULLABLE` as the default — types.d.ts:5914).
 */
const DEFAULT_MODE: BigQuerySchemaField["mode"] = "NULLABLE";

/** Convert one raw `ITableFieldSchema` cell to the contract shape. */
function mapSchemaField(raw: RawTableFieldSchema): BigQuerySchemaField {
  const mode = (raw.mode ?? DEFAULT_MODE) as BigQuerySchemaField["mode"];
  return {
    name: raw.name ?? "",
    type: raw.type ?? "",
    mode,
    fields: raw.fields ? raw.fields.map(mapSchemaField) : undefined,
  };
}

/** Un-nest one raw row (`{ f: [{ v: any }, ...] }`) into a flat value tuple. */
function mapRow(raw: RawTableRow): BigQueryValue[] {
  const cells = raw.f ?? [];
  return cells.map((cell) => cell.v as BigQueryValue);
}

/**
 * Named mapper (plan-review mandate): raw client response → contract page.
 * Pure; no I/O, no client import.
 *
 * Contract guarantees:
 *   - `jobRef` is `{ projectId, location, jobId }` from `jobReference`
 *     (empty strings substituted for missing pieces so the type is satisfied).
 *   - `schema.fields` is recursively mapped from the wire shape; RECORDS
 *     keep their nested `fields` (test #5).
 *   - `rows` is `rows[].f[].v` un-nested (test #5/#6).
 *   - `pageToken` is preserved verbatim — never trimmed/decoded (test #4).
 *   - `totalBytesProcessed` / `totalBytesBilled` are forwarded as-is when
 *     present; they are contractually `string` to preserve bytes precision.
 *   - `pageToken === null` means final page (no further pages).
 */
export function toBigQueryPage(
  raw: BigQueryRawQueryResponse,
): BigQueryPage {
  const jobRef: BigQueryJobRef = {
    projectId: raw.jobReference?.projectId ?? "",
    location: raw.jobReference?.location ?? "",
    jobId: raw.jobReference?.jobId ?? "",
  };
  const schema: BigQuerySchemaField[] = (raw.schema?.fields ?? []).map(
    mapSchemaField,
  );
  const rows: BigQueryValue[][] = (raw.rows ?? []).map(mapRow);
  // The wire contract: pageToken is either present (string) or absent. We map
  // absence to `null` to make the "no further pages" case explicit at the type
  // level. A present-but-empty string still means "more pages" — the
  // client's `IGetQueryResultsResponse` documents non-empty tokens (and any
  // token the client hands us, including the empty string, is opaque).
  const pageToken: string | null = raw.pageToken === undefined ? null : raw.pageToken;
  return {
    jobRef,
    schema,
    rows,
    totalBytesProcessed: raw.totalBytesProcessed,
    totalBytesBilled: raw.totalBytesBilled,
    pageToken,
  };
}