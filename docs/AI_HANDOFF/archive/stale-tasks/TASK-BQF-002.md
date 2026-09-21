# TASK-BQF-002 — useLegacySql UI toggle

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4

## Goal

Wire a "Use legacy SQL" checkbox into the SQL editor form so users can
opt into BQ legacy SQL. The checkbox is unchecked by default (GoogleSQL,
the current behaviour). When checked, `opts.useLegacySql = true` is
threaded from the form through `runStatements` to `BigQueryAdapter.runQuery`.

The BQ adapter already honors the flag (BQ-01 seam). This task is purely
the UI + form-to-options plumbing.

## Target Files

- `src/extension.ts` — investigate where `runStatements` options are
  built. Add a `useLegacySql?: boolean` field to the options shape.
  Source from the form's checkbox state.
- The form itself — investigate which form collects SQL editor options
  (likely `src/ui/resultsPanel.ts` query bar OR a separate
  `src/ui/queryForm.ts` OR inline in `src/extension.ts:runStatements`).
  Pin the exact file during execution.
- `src/adapters/__tests__/bigqueryLegacySql.test.ts` (new) — 4 cases per
  PLAN.md §4. Tests the adapter's `useLegacySql` flag handling (already
  works) and verifies that the form → opts wiring is correct.

## Test Cases (REQUIRED — TDD)

| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `BigQueryAdapter.runQuery` with `opts.useLegacySql: false` produces GoogleSQL job | match | mock createQueryJob |
| 2 | unit | `BigQueryAdapter.runQuery` with `opts.useLegacySql: true` produces legacy SQL job | match | mock |
| 3 | regression | `BigQueryAdapter.runQuery` with no `useLegacySql` keeps current default (`false`) | match | absent |
| 4 | integration | form submission with checked legacy-SQL checkbox sets `opts.useLegacySql: true` in the runStatements payload | match | mock form state |

## Test Files

- `src/adapters/__tests__/bigqueryLegacySql.test.ts` — mock BQ
  `createQueryJob`, drive adapter with various `useLegacySql` values,
  assert `useLegacySql` is set on the job config. Form integration test
  is host-side; pin exact location during execution.

## Verification Commands

```bash
npm test src/adapters/__tests__/bigqueryLegacySql.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (4/4).
- [ ] No regression in BQ-00 / BQ-01 / BQ-02 / BQ-03 / BQ-04 frozen surfaces.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] Default state is unchecked (GoogleSQL) — matches current behaviour.

## Dependencies

- (none) — the BQ adapter already honors the flag; task is UI plumbing only.

## Interfaces

- Consumes:
  - `RunStatementOptions` — existing options shape in `src/extension.ts:runStatements`.
  - `BigQueryAdapter.runQuery` `opts.useLegacySql?: boolean` — already
    supported (BQ-01 deliverable).
- Produces:
  - `RunStatementOptions.useLegacySql?: boolean` — new optional field.
  - Form UI: a checkbox labelled "Use legacy SQL" in the SQL editor form.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

---

## Reviewer Verdict

(to be appended by Phase 4 reviewer)