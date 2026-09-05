# TASK-BQF-003 — Locale-aware temporal formatting in formatBigQueryCell

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4

## Goal

Implement the locale-formatted temporal branch in `formatBigQueryCell`.
The `field` parameter is already threaded end-to-end; the function needs
to honour `field.type === "DATE" | "TIME" | "DATETIME" | "TIMESTAMP"`
with `field.formatOptions` present.

When `formatOptions` is absent, the existing verbatim branch fires (no
regression). When present, format per BQ's `formatOptions` spec using
`Intl.DateTimeFormat` (Node 22+ built-in).

## Target Files

- `src/adapters/bigqueryPages.ts` — `formatBigQueryCell(value, field?)`
  gains a temporal branch that runs BEFORE the existing verbatim branch:
  1. If `field?.type` is one of `"DATE" | "TIME" | "DATETIME" | "TIMESTAMP"`
     AND `field.formatOptions` is present:
     - Parse the BQ raw string into a `Date` (or just pass the string to
       `Intl.DateTimeFormat` for the temporal parts the spec covers).
     - Apply `Intl.DateTimeFormat` options derived from `formatOptions`:
       - `locale` → BCP-47 tag passed to `Intl.DateTimeFormat`.
       - `timezone` → IANA tz passed to `Intl.DateTimeFormat.timeZone`.
       - `dateFormat` + `timeFormat` → `Intl.DateTimeFormat` dateStyle /
         timeStyle / year / month / day / hour / minute / second options.
     - Return the formatted string.
  2. Otherwise fall through to existing verbatim branch.
- `src/adapters/__tests__/bigqueryLocaleFormat.test.ts` (new) — 5 cases
  per PLAN.md §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `formatBigQueryCell("2026-09-05", {type:"DATE", name:"d", mode:"NULLABLE", fields:[]})` returns the raw string (no formatOptions → verbatim) | "2026-09-05" | no formatOptions |
| 2 | unit | `formatBigQueryCell("2026-09-05", {type:"DATE", name:"d", mode:"NULLABLE", fields:[], formatOptions:{dateFormat:"YEAR_MONTH_DAY"}})` returns a locale-formatted date | non-raw format | with formatOptions |
| 3 | edge | `formatBigQueryCell("2026-09-05T12:00:00Z", {type:"TIMESTAMP", name:"t", mode:"NULLABLE", fields:[], formatOptions:{timezone:"America/Los_Angeles", dateFormat:"YEAR_MONTH_DAY", timeFormat:"HOUR24_MINUTE"}})` returns formatted in LA tz | match LA offset | with formatOptions + tz |
| 4 | regression | empty `value` keeps empty marker | `""` | null |
| 5 | regression | non-temporal field (e.g. `STRING`) keeps verbatim branch | match | STRING |

## Test Files

- `src/adapters/__tests__/bigqueryLocaleFormat.test.ts` — call the pure
  `formatBigQueryCell` helper directly with various `field` shapes; assert
  the returned string. Uses Node 22 `Intl.DateTimeFormat` directly (no
  mocking needed).

## Verification Commands

```bash
npm test src/adapters/__tests__/bigqueryLocaleFormat.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (5/5).
- [ ] No regression in BQ-00 / BQ-01 / BQ-02 / BQ-03 / BQ-04 frozen surfaces
      (verified by `bqFollowupSurfaceGuard.test.ts`).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] No new deps added — uses Node 22 `Intl.DateTimeFormat` built-in.

## Dependencies

- (none)

## Interfaces

- Consumes:
  - `BigQuerySchemaField` (existing) — schema column descriptor. The
    `formatOptions?: { dateFormat?, timeFormat?, timezone?, locale? }`
    shape is per the BQ REST API spec.
  - `BigQueryValue` (existing) — string-typed for DATE/TIME/DATETIME/TIMESTAMP.
- Produces:
  - `formatBigQueryCell(value, field?)` — extended to honor locale-formatted
    temporal branch when `field.type` is one of the four temporal types
    AND `field.formatOptions` is present. Returns a locale-formatted string.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

---

## Reviewer Verdict

(to be appended by Phase 4 reviewer)