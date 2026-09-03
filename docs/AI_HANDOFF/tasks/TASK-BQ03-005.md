# TASK-BQ03-005 — Command integration: GoogleSQL selection + copy-safe BigQuery result header

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (BQ-03.5), §3 Approach "Command integration", §4 row 15

## Goal

Wire the last mile in `src/extension.ts`: for a BigQuery connection the run path selects GoogleSQL (never silently legacy SQL), and the Results header carries the BigQuery identity — data project, billing project, location, and a job link/ID — in a copy-safe (HTML-escaped, credential-free) form. No panel/runner/adapter changes.

## Target Files

- `src/extension.ts` — (a) in the shared `runStatements` path, build the header per driver: for `driver === "bigquery"`, compose a BigQuery header line including data project, billing project, location and job identity when available (read from the statement's result/jobRef via the adapter contract; absent → render the fields as "—", never omit the line); (b) ensure the GoogleSQL choice is explicit and surfaced in that header (`sql: GoogleSQL` marker) — no `useLegacySql` is ever set by host code; (c) keep the existing non-BigQuery header byte-identical.
- `src/extension.test.ts` — add a "BQ-03.5 BigQuery command integration" describe block using the existing registered-command harness. Existing tests untouched.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | BigQuery header carries all four facts | run one statement on a bigquery connection (fake adapter via the harness) → the header passed to `panel.render` contains data project, billing project, location and job ID/link segments, e.g. `... bigquery@data-proj/billing-proj @ US — job bq:US:job123 (GoogleSQL)` (exact composition per implementation, asserted on all four substrings) | fake ConnectionManager/adapter returning a jobRef-bearing result |
| 2 | happy | GoogleSQL selected and surfaced | header contains the `GoogleSQL` marker; the fake adapter received NO `useLegacySql` option (or `useLegacySql: false`); legacy SQL is never silently chosen | spy adapter |
| 3 | edge (empty) | missing job identity degrades gracefully | result without a jobRef (e.g. gate-rejected run, or legacy path) → header still renders with `—` placeholders for the missing facts; no crash, no `undefined` leaking into the string | jobRef-less result fixture |
| 4 | edge (malformed/copy-safe) | header is copy-safe | jobRef pieces containing HTML-hostile characters (`<script>` as a project id, `"` in a location) → the header string HTML-escapes them (no raw `<`, `>`, `"` pass through into the posted state); credentials (if any config field ever appears) never do | hostile jobRef fixture |
| 5 | edge (permission/denied) | job error keeps header honest | adapter rejects with `BigQueryJobError`-shaped error (category+location) → the run surfaces the sanitized error through the existing error path; header (posted with the error state) still shows the connection facts, never the raw Google message or SQL | rejecting fake adapter |
| 6 | regression | non-BigQuery headers byte-identical | postgres/mysql/mssql run → header remains exactly `Run at <ISO> — <driver>@<host>/<database>` (existing format at extension.ts:1971); existing extension tests verbatim green | current test file |

## Test Files

- `src/extension.test.ts` — appended describe block; existing describes untouched.

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npm run typecheck
npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts   # integration counterpart stays green
```

(`npm run typecheck` is the static gate — **no lint script exists** in this repo.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] BigQuery runs surface GoogleSQL (marker in header; never silent legacy SQL).
- [ ] Header shows data project, billing project, location, job link/ID — HTML-escaped, credential-free, `—` for missing facts.
- [ ] Non-BigQuery header format unchanged (regression #6).
- [ ] Errors through this path remain sanitized (no raw Google message, no SQL text).
- [ ] Existing extension tests stay green unmodified; `npm run typecheck` exits 0.

## Dependencies

- TASK-BQ03-001 (consumes the jobRef/error envelope shape the adapter now produces), TASK-BQ03-004 (consumes the pinned panel render contract — header flows through `render(results, header)` unchanged)

## Interfaces

- Consumes: `runStatements` (extension.ts:1949) and its `header` construction (:1971); `ResultsPanel.render(results, header, opts)` (resultsPanel.ts:321); `mgr.getActive()` (`ConnectionConfig.driver === "bigquery"`, `cfg.bigquery.billingProject`, `cfg.bigquery.location` — see `BigQueryConnectionFields` in `src/config/types.ts`); TASK-BQ03-001's produced `jobRef: BigQueryJobRef` on the batched handle and `BigQueryJobError` envelope.
- Produces: header string format only (user-facing copy). Format pinned in test #1: `Run at <ISO> — bigquery@<dataProject>/<billingProject> @ <location> — job <link-or-id> (GoogleSQL)`; missing segments render `—`.

---

## Discussion

### 2026-09-03 · planner · unic-smart
Grounding notes for the executor:

1. **Where the job identity comes from**: after `runner.run` settles, the runner's `getResults()` entries carry `batched` (normalized to boolean by sanitize) — the RAW runner result (pre-sanitize) is what `runStatements` sees via `runner.getResults()`. `StatementResult.batched` at rest is the live handle whose `jobRef` TASK-BQ03-001 exposes. Read it there; if the handle is gone (settled/EOF-closed by 03.3), degrade to `—`. Do NOT reach into the adapter's internals.
2. **Copy-safe**: the header flows into the webview's `header` field and is displayed; use the same escaping posture as the panel's `escapeHtml` (resultsPanel.ts:2259) — but escape in extension.ts where the string is BUILT, since the webview may render it as text anyway. Pin the escaping in test #4 regardless of where rendering applies it.
3. **Console path shares `runStatements`** (extension.ts:1841) — the header fix covers Console runs automatically. CodeLens (`vsdb.runStatement`) also funnels into `runStatements`. Verify all three entry points with one harness test if cheap, at minimum pin the editor path.
4. **Do not** add a `useLegacySql` setting, UI toggle, or config key — out of scope by plan §2. The `GoogleSQL` marker is static copy.
5. The dangerous-confirm gate (`confirmDangerousStatements`) runs before `runStatements` body — unrelated to this task; do not touch it.
6. RED-first: test #1 fails against current code (header has no BigQuery facts); verify, then implement.

---

## Executor Report

## Reviewer Verdict
