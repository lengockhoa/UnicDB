# TASK-BQF-001 — pageSize plumbing (BigQuery getQueryResults maxResults)

- Status: `pending_review`
- Owner: feature-implementer (unic-code / sonnet)
- Reviewer: - (assigned by Phase 4)
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4

## Goal

Add an optional `pageSize?: number` parameter to `BigQueryAdapter.runQuery`
and thread it through `createBigQueryPageFetcher` so `bigquery.getQueryResults`'s
`maxResults` is configurable per-query. Default behaviour is unchanged
(no `maxResults` override). When `pageSize` is provided, clamp to
`[1, 10000]` (BQ API limit) before passing through.

## Target Files

- `src/adapters/bigqueryPages.ts` — `createBigQueryPageFetcher` accepts
  `Opts.pageSize?: number`. When set, clamp `[1, 10000]` and pass
  `maxResults` in the `getQueryResults` call. When unset, current default
  unchanged (no `maxResults` override).
- `src/adapters/bigquery.ts` — `BigQueryAdapter.runQuery` accepts
  `opts.pageSize?: number` in addition to existing opts, threads to the
  BatchedQuery that wraps `getQueryResults`.
- `src/adapters/__tests__/bigqueryPageSize.test.ts` (new) — 6 cases per
  PLAN.md §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | pageSize=500 → maxResults=500 in getQueryResults call | match | mock BQ client |
| 2 | unit | pageSize=50000 → clamp to maxResults=10000 | match | over ceiling |
| 3 | edge | pageSize=0 → clamp to maxResults=1 | match | below floor |
| 4 | edge | pageSize=-5 → clamp to maxResults=1 | match | negative |
| 5 | regression | pageSize omitted → no maxResults override (current default) | no override | absent |
| 6 | integration | `BigQueryAdapter.runQuery({sql, pageSize: 100})` threads pageSize=100 to the BatchedQuery | match | mock client |

## Test Files

- `src/adapters/__tests__/bigqueryPageSize.test.ts` — mock BQ client with
  `getQueryResults` spy, drive `createBigQueryPageFetcher` with various
  pageSize values, assert the `maxResults` arg.

## Verification Commands

```bash
npm test src/adapters/__tests__/bigqueryPageSize.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (6/6).
- [ ] No regression in BQ-00 / BQ-01 / BQ-02 / BQ-03 / BQ-04 frozen surfaces
      (verified by `bqFollowupSurfaceGuard.test.ts`).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] Default behaviour (no pageSize) is byte-identical — no `maxResults`
      override passed to BQ.

## Dependencies

- (none)

## Interfaces

- Consumes:
  - `Opts.maxResults?: number` — existing field on `createBigQueryPageFetcher`'s
    `Opts`. We do NOT remove it; we add `pageSize` as a parallel field that
    clamps before setting `maxResults`.
- Produces:
  - `Opts.pageSize?: number` — new optional field. When set, takes precedence
    over `maxResults` (after clamping). When unset, `maxResults` behaviour
    unchanged.
  - `BigQueryAdapter.runQuery` `opts.pageSize?: number` — new optional field
    threaded through to BatchedQuery.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

---

## Reviewer Verdict

(to be appended by Phase 4 reviewer)