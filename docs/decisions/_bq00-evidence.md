# BQ-00 evidence — pagination + cancellation method names (scratch)

> Scratch evidence file owned by TASK-BQ00-001. The leading `_` marks it
> non-ADR; ADR 0004 (TASK-BQ00-004) cites this file by path. Do not promote to
> a real ADR without a re-evaluation pass.
>
> Source of truth: the installed `.d.ts` files at the version pinned by this
> task. Every entry below is what `src/adapters/__tests__/bigqueryPackage.test.ts`
> test #7 actually located in the installed package, plus the surrounding
> declarations needed for the return-shape record.

## Pinned package

| Field | Value |
|-------|-------|
| Package | `@google-cloud/bigquery` |
| Pinned version | `9.0.3` (declared `^9.0.3`) |
| `engines.node` | `>=22` |
| Dev runtime | `v22.22.1` (compatible) |
| Major | `9` |

Fallback pin `^8.3.1` was **not** needed: 9.0.3 installs cleanly, loads under
Node without credentials, and bundles under the extension's exact esbuild
options. Probe bundle size: **1,193,010 bytes** (with the probe entry
`import { BigQuery } from "@google-cloud/bigquery"; console.log(BigQuery);`).

## Method-name evidence

All four roadmap line-67 names were located as declarations in the installed
`.d.ts`. File paths are repo-relative from the worktree root; line numbers
were captured by test #7 (regex `\bNAME\s*\(` over the raw text).

### `BigQuery.getQueryResults` — on `Job`

**File:** `node_modules/@google-cloud/bigquery/build/src/job.d.ts`
**Line:** 234 (first overload); overloads at 235, 236
**Signatures:**

```ts
getQueryResults(options?: QueryResultsOptions): Promise<QueryRowsResponse>;
getQueryResults(options: QueryResultsOptions, callback: QueryRowsCallback): void;
getQueryResults(callback: QueryRowsCallback): void;
```

**Return shape:**

- Promise overload resolves to `QueryRowsResponse`
- `QueryRowsResponse` is exported from `bigquery.d.ts:49` as
  `PagedResponse<RowMetadata, Query, QueryResultsResponse>` — i.e. a paginated
  response object (not a bare array) carrying row metadata plus a `nextQuery`
  cursor. This is the auto-paginated form: callers should not need to call
  `getQueryResults` again themselves.

**Doc context:** `job.d.ts` lines 163–233 document the `getQueryResults`
manual-pagination form (passing `nextQuery` back in to page through results).

### `BigQuery.query` — on `BigQuery`

**File:** `node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts`
**Lines:** 1119–1124 (overloads)
**Signatures:**

```ts
query(query: string, options?: QueryOptions): Promise<QueryRowsResponse>;
query(query: Query, options?: QueryOptions): Promise<SimpleQueryRowsResponse>;
query(query: string, options: QueryOptions, callback?: QueryRowsCallback): void;
query(query: Query, options: QueryOptions, callback?: SimpleQueryRowsCallback): void;
query(query: string, callback?: QueryRowsCallback): void;
query(query: Query, callback?: SimpleQueryRowsCallback): void;
```

**Return shape:**

- String-SQL form resolves to `QueryRowsResponse` (the paged form — same type
  as `getQueryResults`).
- Object-`Query` form resolves to `SimpleQueryRowsResponse`, which
  `bigquery.d.ts:51` defines as `[RowMetadata[], bigquery.IJob]` — a tuple
  of `[rows, job]` rather than a paginated response object. This is the
  difference VSDB must respect: the string form auto-paginates, the object
  form returns the raw `[rows, job]` tuple.

### `BigQuery.createQueryJob` — on `BigQuery`

**File:** `node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts`
**Lines:** 782–783 (overloads)
**Signatures:**

```ts
createQueryJob(options: Query | string): Promise<JobResponse>;
createQueryJob(options: Query | string, callback: JobCallback): void;
```

**Return shape:**

- Promise overload resolves to `JobResponse` — defined as `[Job, bigquery.IJob]`
  in the `table.d.ts` import line (`bigquery.d.ts:22` imports
  `JobResponse, JobCallback` from `./table`).
- The `Job` instance returned in the tuple is the handle VSDB needs to call
  `cancel()` and `getQueryResults()` on. So a BQ-00 driver must destructure
  the tuple (`const [job] = await bq.createQueryJob(...);`) and operate on
  the `Job`, not the raw API response.

### `Job.cancel` — on `Job`

**File:** `node_modules/@google-cloud/bigquery/build/src/job.d.ts`
**Lines:** 158–159 (overloads)
**Signatures:**

```ts
cancel(): Promise<CancelResponse>;
cancel(callback: CancelCallback): void;
```

**Return shape (roadmap line-67 cancellation-return-shape mandate):**

- Promise overload resolves to `CancelResponse`.
- `CancelResponse` is defined in `job.d.ts:27` as
  `export type CancelResponse = [bigquery.IJobCancelResponse];` — a **tuple**
  of one element: the raw `IJobCancelResponse` (a status object with the
  BigQuery job-cancel API response; carries no job metadata, only the cancel
  acknowledgement).
- `CancelCallback` (`job.d.ts:26`) is `RequestCallback<bigquery.IJobCancelResponse>`
  — the standard `(err, response) => void` node-style callback.
- **Implication for VSDB:** `job.cancel()` is **not** `void`. It returns a
  promise that resolves to a tuple; the cancel acknowledgement is wrapped in
  `[apiResponse]`. To know whether cancellation succeeded the caller must
  inspect the tuple element (no `job.status` is bundled in the response —
  cancel just acknowledges the request, separate `getMetadata()` is required
  to confirm the job actually stopped).

## Build options proven (probe options)

Test #2/#3/#5 ran esbuild with these options, exactly matching `esbuild.js`:

```js
{
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  write: false,
}
```

with a virtual stdin entry of `import { BigQuery } from "@google-cloud/bigquery"; console.log(BigQuery);`.

The probe:

- Built cleanly with `errors.length === 0`.
- Produced a `1,193,010`-byte CJS bundle.
- Contained no inline PEM private-key blocks after stripping regex literals
  (the credential-safety gate).
- Did not resolve or inline `require("vscode")` or any vscode API surface.

## What this evidence does NOT cover

- Network behaviour (no live project, no ADC flow).
- The `queryAsStream_` / `getQueryResultsAsStream_` internal underscore
  variants (`bigquery.d.ts:1142`, `job.d.ts:243`) — internal API surface,
  not safe to depend on.
- Streaming or job-pagination token types beyond what the four declared
  methods already expose.

ADR 0004 should cite this file for: client major (9.x), pinned exact version
(9.0.3), engine-floor outcome (>=22 satisfied), the four method signatures
above, the `Job.cancel() → Promise<CancelResponse>` return shape (tuple of
`[IJobCancelResponse]`), and the `Job` instance extracted from `JobResponse`
as the handle for `cancel` / `getQueryResults`.