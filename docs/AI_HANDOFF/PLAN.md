# PLAN — BQ-FOLLOWUP: 3 small BigQuery backlog items

## §1 Intent

**Problem.** Three independent small items in the BigQuery backlog — all
advisory, none user-blocking, but they round out the BQ surface so future
work doesn't need to revisit them.

1. **`pageSize` configurability** — `BigQueryAdapter.runQuery` calls
   `bigquery.getQueryResults` with a fixed default `maxResults`. There's no
   per-query knob for the user to widen / narrow the page size for
   latency-sensitive or batch-load scenarios.
2. **`useLegacySql` UI toggle** — the seam correctly honors
   `opts?.useLegacySql === true`, but the SQL editor form / connection
   form has no toggle that ever sets it to `true`. So the legacy-SQL path
   is permanently unreachable from the UI.
3. **Locale-aware temporal formatting in `formatBigQueryCell`** — the
   `field` parameter is threaded end-to-end and the comment says it's
   reserved for locale-formatted temporal types. The branch is not
   implemented; `TIMESTAMP` / `DATETIME` / `TIME` / `DATE` render verbatim
   (raw BQ string output).

**Success definition.** After this cycle:
1. `BigQueryAdapter.runQuery` accepts an optional `pageSize?: number`
   parameter; when omitted, the existing default is used; when provided,
   it's clamped to `[1, 10000]` and passed to `getQueryResults({maxResults})`.
2. The SQL editor form gains a "Use legacy SQL" checkbox. Default state
   is `false` (matches current behaviour — GoogleSQL). When checked,
   `opts.useLegacySql = true` is threaded through to the BQ adapter.
3. `formatBigQueryCell(value, field?)` honors `field.type === "TIMESTAMP" /
   "DATETIME" / "TIME" / "DATE"` and produces a locale-formatted output
   when `field.formatOptions` is present (BQ schema-side
   `{dateFormat, timeFormat, timezone, locale}`). When `formatOptions`
   is absent, the existing verbatim branch fires (no regression).
   Locale formatting uses `Intl.DateTimeFormat` (Node 22+) — no extra deps.

**Out of scope this cycle:**
- `formatBigQueryCell` RECORD/REPEATED grid rendering (BQ-03 separate cycle).
- DRIVER-level SQL dialect selector (this only adds per-statement toggle).
- BQ timezone conversion (honor BQ's `formatOptions.timezone` but no UI).
- Making `pageSize` user-configurable from the UI (this cycle only plumbs).
- Changing legacy-SQL-on-by-default for BQ projects (project metadata side-channel).

## §2 Scope

**In scope (touched files):**

`pageSize` plumbing:
- `src/adapters/bigqueryPages.ts` — `createBigQueryPageFetcher` accepts
  optional `pageSize?: number` in `Opts`. When provided, clamp to
  `[1, 10000]` and pass through as `maxResults`. Default keeps existing.
- `src/adapters/bigquery.ts` — `BigQueryAdapter.runQuery` accepts optional
  `opts.pageSize?: number` and threads through to `BatchedQuery`.

`useLegacySql` toggle:
- `src/adapters/bigquery.ts` — already honors `opts.useLegacySql`; this
  cycle only wires the UI. The actual flag-plumbing code is byte-untouched.
- `src/extension.ts` — `runStatements` opts gain `useLegacySql?: boolean`
  sourced from a new form field. Form lives in the existing SQL editor
  area; pin the exact file in TASK-BQF-002 §Target Files during execution.

Locale temporal:
- `src/adapters/bigqueryPages.ts` — `formatBigQueryCell(value, field?)`
  reads `field?.type` for `"DATE" | "TIME" | "DATETIME" | "TIMESTAMP"`.
  If `field.formatOptions` is present, build `Intl.DateTimeFormat` per
  the BQ spec; otherwise fall through to the existing verbatim branch.

Tests (TDD-embedded; see §4):
- `src/adapters/__tests__/bigqueryPageSize.test.ts` (new) — clamp + thread.
- `src/adapters/__tests__/bigqueryLegacySql.test.ts` (new) — toggle wiring.
- `src/adapters/__tests__/bigqueryLocaleFormat.test.ts` (new) — locale branch.
- `src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts` (new) — frozen-surface
  guard: BQ-00 / BQ-01 / BQ-02 / BQ-03 / BQ-04 surfaces byte-untouched.

**Out of scope (deferred):**
- `formatBigQueryCell` RECORD/REPEATED grid wiring (BQ-03).
- UI knob for `pageSize` (this cycle only plumbs).
- DRIVER-level SQL dialect selector.

**Same-wave isolation.** Three tasks, three disjoint surfaces:
- TASK-BQF-001: `bigqueryPages.ts` (pageSize param) + `bigquery.ts` (runQuery opts).
- TASK-BQF-002: `extension.ts` (form wiring) + `bigquery.ts` (no change — flag
  already honored).
- TASK-BQF-003: `bigqueryPages.ts` (formatBigQueryCell locale branch).
- TASK-BQF-001 + TASK-BQF-003 both touch `bigqueryPages.ts` — wave them in series.
  Wave 1 = BQF-001, Wave 2 = BQF-002, Wave 3 = BQF-003.

## §3 Approach

**Why plumb `pageSize` without a UI knob.** The BQ follow-up backlog
explicitly says "surface a per-`BatchedQuery` tunable if real-world
latency warrants". This cycle only plumbs the param so callers (future
form, future AI agent, future tests) can set it.

**Why a checkbox for `useLegacySql`.** The seam already honors the flag
(BQ-01 deliverable). A checkbox in the existing form is the minimal UI.

**Why `Intl.DateTimeFormat`.** Node 22 has full `Intl.DateTimeFormat`
support for the BQ `formatOptions` spec. Map BQ's `dateFormat` /
`timeFormat` / `timezone` / `locale` → `Intl.DateTimeFormat` options
one-to-one. No date-fns / luxon / moment dep added.

**Why clamp `pageSize` to `[1, 10000]`.** BQ's `getQueryResults.maxResults`
caps at 10000 (per BQ REST API docs). The preview-SQL builder already
clamps to `[1, 1000]`; we use 10000 here because `runQuery` is the
"load more" path and users explicitly want a big batch.

**Rejected alternatives.**
- *Use moment.js for temporal formatting.* — 200KB dep for a single branch.
- *Pre-format in the BQ adapter before sending to the webview.* —
  Couples adapter to display locale; better to keep raw BQ strings in the
  pipeline and format at the display layer.

## §4 Test Plan

**TASK-BQF-001 — pageSize plumbing**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `createBigQueryPageFetcher({pageSize: 500})` passes `maxResults: 500` to `getQueryResults` | match | mock BQ client |
| 2 | unit | `createBigQueryPageFetcher({pageSize: 50000})` clamps to `maxResults: 10000` | match | over ceiling |
| 3 | edge | `createBigQueryPageFetcher({pageSize: 0})` clamps to `maxResults: 1` | match | below floor |
| 4 | edge | `createBigQueryPageFetcher({pageSize: -5})` clamps to `maxResults: 1` | match | negative |
| 5 | regression | `createBigQueryPageFetcher({})` (no pageSize) keeps current default (no `maxResults` override) | no override | absent |
| 6 | integration | `BigQueryAdapter.runQuery` threads `opts.pageSize` to the BatchedQuery | match | mock client |

**TASK-BQF-002 — useLegacySql toggle**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `BigQueryAdapter.runQuery` with `opts.useLegacySql: false` produces GoogleSQL job | match | mock createQueryJob |
| 2 | unit | `BigQueryAdapter.runQuery` with `opts.useLegacySql: true` produces legacy SQL job | match | mock |
| 3 | regression | `BigQueryAdapter.runQuery` with no `useLegacySql` keeps current default (`false`) | match | absent |
| 4 | integration | form submission with checked legacy-SQL checkbox sets `opts.useLegacySql: true` | match | mock form state |

**TASK-BQF-003 — locale temporal formatting**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `formatBigQueryCell("2026-09-05", {type:"DATE", ...})` without `formatOptions` returns the raw string | verbatim | no formatOptions |
| 2 | unit | `formatBigQueryCell("2026-09-05", {type:"DATE", ..., formatOptions:{dateFormat:"YEAR_MONTH_DAY"}})` returns a locale-formatted date | match | with formatOptions |
| 3 | edge | `formatBigQueryCell("2026-09-05T12:00:00Z", {type:"TIMESTAMP", ..., formatOptions:{timezone:"America/Los_Angeles", ...}})` returns formatted in LA tz | match | with formatOptions + tz |
| 4 | regression | empty `value` keeps empty marker | `""` | null |
| 5 | regression | non-temporal field (e.g. `STRING`) keeps verbatim branch | match | STRING |

**Test files:**
- `src/adapters/__tests__/bigqueryPageSize.test.ts` (new — TASK-BQF-001; 6 cases)
- `src/adapters/__tests__/bigqueryLegacySql.test.ts` (new — TASK-BQF-002; 4 cases)
- `src/adapters/__tests__/bigqueryLocaleFormat.test.ts` (new — TASK-BQF-003; 5 cases)
- `src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts` (new — frozen-surface guard)

Total: 15 cases + guard = 16 across 4 files.

## §5 Verification

```bash
npm run typecheck
npm run compile
npm test src/adapters/__tests__/bigqueryPageSize.test.ts
npm test src/adapters/__tests__/bigqueryLegacySql.test.ts
npm test src/adapters/__tests__/bigqueryLocaleFormat.test.ts
npm test src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts
npm test   # full suite, must keep 3579|2 baseline or better
npm run verify:fast
```

## §6 Acceptance

- [ ] Every test in §4 passes (15 cases + guard = 16 across 4 files).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] Full suite green (current 3579|2 baseline preserved or better).
- [ ] BQ-00 / BQ-01 / BQ-02 / BQ-03 / BQ-04 frozen surfaces byte-identical.
- [ ] CHANGELOG updated for v1.51.5.
- [ ] **Release: v1.51.5 published to GitHub** at R5.

## §7 Task Split

| Task | Wave | Title | Files |
|------|------|-------|-------|
| TASK-BQF-001 | 1 | pageSize plumbing | `src/adapters/bigqueryPages.ts`, `src/adapters/bigquery.ts`, `src/adapters/__tests__/bigqueryPageSize.test.ts` (new) |
| TASK-BQF-002 | 2 | useLegacySql UI toggle | `src/extension.ts` (form wiring), `src/adapters/__tests__/bigqueryLegacySql.test.ts` (new) |
| TASK-BQF-003 | 3 | Locale temporal formatting | `src/adapters/bigqueryPages.ts`, `src/adapters/__tests__/bigqueryLocaleFormat.test.ts` (new) |
| BQF-GUARD | 4 | Frozen-surface guard | `src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts` (new) |