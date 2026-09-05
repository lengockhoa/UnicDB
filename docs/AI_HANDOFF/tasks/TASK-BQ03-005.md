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
3. **Console path shares `runStatements`** (extension.ts:1841) — the header fix covers Console runs automatically. CodeLens (`UnicDB.runStatement`) also funnels into `runStatements`. Verify all three entry points with one harness test if cheap, at minimum pin the editor path.
4. **Do not** add a `useLegacySql` setting, UI toggle, or config key — out of scope by plan §2. The `GoogleSQL` marker is static copy.
5. The dangerous-confirm gate (`confirmDangerousStatements`) runs before `runStatements` body — unrelated to this task; do not touch it.
6. RED-first: test #1 fails against current code (header has no BigQuery facts); verify, then implement.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
$ cd .worktrees/task-bq03-005 && npx vitest run src/extension.test.ts --reporter=verbose 2>&1 | tail -30
...
 Test Files  1 failed (1)
      Tests  5 failed | 110 passed (115)
   Start at  10:43:56
   Duration  1.76s (transform 432ms, transform 1ms, collect 579ms, tests 998ms, environment 0ms, prepare 38ms)
```

5 of the 6 new tests failed RED (test #6 was the regression pin for the prior
non-BQ header format, which is byte-identical and so already passed):

- #1 header carries all four facts — FAIL: header was
  `Run at <ISO> — bigquery@/` (active.bigquery connection has empty
  host/database); missing the four-fact segment entirely.
- #2 GoogleSQL marker — FAIL: no `GoogleSQL` substring.
- #3 jobRef-less placeholder — FAIL: no `—` in header.
- #4 HTML escape — FAIL: hostile jobRef pieces not escaped.
- #5 error path keeps header honest — FAIL: error envelope shape did
  not match TASK-BQ03-001's sanitized form (out of scope; this test
  pins a sanitized Error shape from the BQ-03.1 contract — see
  NOTES below.

RED confirmed. Proceeded to implementation.

Verification Output:
```
$ cd .worktrees/task-bq03-005 && npx vitest run src/extension.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-bq03-005

 ❯ src/extension.test.ts:1780:37
    1778|
    1779|  it("npm run compile emits dist/schemaForm.js (esbuild config wired)"…
    1780|    expect(schemaFormBundlePresent).toBe(true);
       |                                     ^
    1781|  });

 Test Files  1 failed (1)
      Tests  1 failed | 114 passed (115)
```

The single failing test (`TASK-003 — UnicDB.createSchema extension wiring >
npm run compile emits dist/schemaForm.js`) is a pre-existing bundle
test that requires `npm run compile` to populate `dist/schemaForm.js`.
The worktree's `dist/` is empty because the build hasn't been run for
this branch. This failure is NOT caused by my changes — `git diff` on
extension.test.ts shows only my +376-line append, no edits to the
schemaForm test. All 6 new BQ-03.5 tests pass; all 108 pre-existing
extension tests still pass. The frozen-surface gate is clean
(`bigqueryTypes.ts` and `bigqueryAdc.ts` byte-untouched).

```
$ cd .worktrees/task-bq03-005 && npm run typecheck
> UnicDB@1.49.0 typecheck
> tsc --noEmit
(exit 0)
```

```
$ cd .worktrees/task-bq03-005 && npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-bq03-005

filter:  src/adapters/__tests__/bigqueryJobs.test.ts
include: src/**/*.test.ts, tests/**/*.test.ts
exclude:  node_modules, dist, **/*.integration.test.ts
watch exclude:  **/node_modules/**

 No test files found, exiting with code 1
```

The third verification command fails because TASK-BQ03-001's
`src/adapters/__tests__/bigqueryJobs.test.ts` has not yet been merged
into the base branch (5de036d) that this worktree was created from.
The file is BQ-03.1's deliverable and the task spec assumes it has
landed ("integration counterpart stays green"). It will land
independently of this work. This is a pre-existing state issue, not
caused by my changes. No action possible from this task.

Status: PASS
Note:
- Files changed: `src/extension.ts` (added `buildBigQueryHeader` +
  `escapeHtmlText` helpers and rewired `runStatements` to surface
  driver-specific header + post-settle job identity re-render),
  `src/extension.test.ts` (appended TASK-BQ03-005 describe block,
  +376 lines; existing tests untouched).
- Implementation strategy: built a single header string before
  `runner.run` for the `onUpdate` callback path (BigQuery header with
  placeholders for job identity, byte-identical format for non-BQ
  drivers). After `runner.run` settles, rebuilt once more with the live
  jobRef surfaced from `StatementResult.batched.jobRef` (BQ-03.1's
  wire shape), then re-rendered. This keeps the seam in `extension.ts`
  alone and never touches `src/adapters/bigquery.ts`,
  `src/core/queryRunner.ts`, or `src/ui/resultsPanel.ts` per hard
  constraint.
- Data project precedence: `jobRef.projectId` (job-time truth) >
  `cfg.bigquery.datasetProject` (override) > `cfg.bigquery.billingProject`
  (legacy fallback). Allows the header to surface the actual job
  owner's project ID when the run settles.
- Job identity: canonical console link
  `https://console.cloud.google.com/bigquery?project=<billing>&j=bq:<location>:<jobId>`
  per spec; falls back to `—` when jobId is missing.
- HTML escape: mirrors `escapeHtml` posture from resultsPanel.ts:2259
  (`& < > " '`); em-dash `—` is intentionally NOT escaped so the
  format-pinned missing-segment markers render literally.
- Dialect choice: GoogleSQL marker is static copy in the header —
  no `useLegacySql` option is ever set or read by host code, per
  task §"Hard constraints".
- Test #5 note: the fixture builds a sanitized `Error` instance with
  `name = "BigQueryJobError"` and message
  `"BigQuery job failed: api_denied (US)"` (the contract shape from
  TASK-BQ03-001 §Interfaces). When the runner rejects with this
  envelope, `runStatements`'s catch branch forwards the message to
  `vscode.window.showErrorMessage` — pre-existing surface. The test
  pins that the forwarded message keeps the category + location,
  contains NO raw SQL or Google payload. Once BQ-03.1 lands, this
  exact fixture shape will be `BigQueryJobError`'s runtime instance.
- `activateFresh`-style harness in tests re-uses `vi.resetModules()`
  to drop the module-level `runScriptTerminal` singleton between
  tests — pattern is consistent with existing TASK-505 / TASK-606
  describes.

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/extension.test.ts && npm run typecheck && npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts
  result: 115 pass / 0 fail; tsc exit 0; 29 pass / 0 fail
TEST_PLAN_COVERAGE: partial — tests #1-#6 implemented and pass, but §Discussion.3's append-mode seam (2nd run in session) is untested, and hostile-escape test #4 covers `<script>` in projectId / `"` in location / `&"` in jobId but never injects hostile chars into billingProject (review focus requires billing-project injection too; billingProject appears twice in the header — the `bigquery@dp/billing` segment and the link's `project=` param).
FINDINGS:
  critical:
    - (none)
  important:
    - src/extension.ts:2088 — post-settle re-render reads `results[0]?.batched`, but `runner.run(..., { append: true })` returns the FULL accumulated array (`return this.results.slice()`, queryRunner.ts:281), not this invocation's slice. On the 2nd+ BigQuery run in one session the header re-render shows the PREVIOUS run's job link stamped with the current run's ISO time (stale close at queryRunner.ts:246-249 sets `cursorClosed` only; `close()` at bigquery.ts:688-698 never clears `jobRef`). Also degrades multi-statement runs where statement 0 errors and a later statement owns the job (header falls back to `—` despite a live jobRef). Fix: slice from the already-computed `appendBase` (extension.ts:2053) — `results.slice(appendBase)` — and pick the first entry with a batched jobRef among THIS run's statements. Add an append-mode regression test: run twice on the same runner, assert header's job link equals run-2's jobId. All 6 current tests use a fresh runner via `vi.resetModules()`, which is why this never fired.
  minor:
    - src/extension.test.ts (test #4) — add a hostile billingProject case (e.g. `<script>` as billingProject); it is interpolated into two distinct positions in the header (identity segment + link `project=` param) and is currently only ever tested clean.
    - src/extension.ts:2048-2051 — `baseHeader` is assigned then aliased to `const header` unused elsewhere; drop the extra alias for clarity (cosmetic).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Frozen-surface constraint verified clean — commit a96a142 touches only src/extension.ts (+98) and src/extension.test.ts (+376); adapters/bigquery.ts, core/queryRunner.ts, ui/resultsPanel.ts untouched by this task. Pre-existing bundle test (schemaForm) passed in my run only because main-repo dist/ is populated; matches executor's worktree explanation, not counted as a fix. Escaping posture matches resultsPanel.ts:2306-2313; webview renders header via textContent (webview/main.ts:588), so extension-side escaping is defense-in-depth per plan. No useLegacySql anywhere in host code; adapter seam sets `useLegacySql: false` (bigquery.ts:810).

## R4.5 Round 1 Fix Report
EXECUTOR_MODEL: unic-code
RED_OUTPUT:
```
R4.5 #1 (slice fix reverted to buggy `results[0]?.batched`):
 FAIL  src/extension.test.ts > TASK-BQ03-005 — BigQuery command integration (header + copy-safety) > R4.5 #1 append-mode: 2nd BigQuery run in same session shows the NEW run's job link
AssertionError: expected 'Run at 2026-09-03T04:47:44.106Z — big…' to match /\(second-job\)/
- Expected: /\(second-job\)/
+ Received: "Run at 2026-09-03T04:47:44.106Z — bigquery@data-proj/proj-billing @ US — job https://console.cloud.google.com/bigquery?project=proj-billing&amp;j=bq:US:first-job (first-job) (GoogleSQL)"
   ❯ src/extension.test.ts:4539:25
    4537|     const finalHeader = renderCalls[renderCalls.length - 1]!.header;
    4538|     // The NEW run's jobId must appear in the header (parenthesised at…
    4539|     expect(finalHeader).toMatch(/\(second-job\)/);
       |                         ^
    4540|     // The PRIOR run's jobId must NOT appear.
    4541|     expect(finalHeader).not.toMatch(/first-job/);

Tests  1 failed | 1 passed | 115 skipped (117)

(R4.5 #2 hostile billingProject — passes by design; the R4.5 fix targets
the post-settle slice, not the escape helper. Both R4.5 tests are present
in the final GREEN run.)
```

Verification Output:
```
$ cd .worktrees/r45-bq03-005 && npx vitest run src/extension.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/r45-bq03-005

 ❯ src/extension.test.ts  (117 tests | 1 failed) 1217ms
   ❯ src/extension.test.ts > TASK-003 — UnicDB.createSchema extension wiring > npm run compile emits dist/schemaForm.js (esbuild config wired)
     → expected false to be true // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed | 116 passed (117)
   Start at  11:47:20
   Duration  2.05s

All 8 BQ-03.5 tests pass (#1 happy, #2 GoogleSQL marker, #3 edge empty,
#4 hostile escape, #5 sanitized error, #6 legacy byte-identical,
R4.5 #1 append-mode, R4.5 #2 hostile billingProject). The single
remaining failure is the pre-existing TASK-003 schemaForm bundle test
that requires `npm run compile` to populate `dist/schemaForm.js` —
unrelated to this task, present in the base branch.

$ cd .worktrees/r45-bq03-005 && npm run typecheck
> UnicDB@1.49.0 typecheck
> tsc --noEmit
EXIT=0

$ cd .worktrees/r45-bq03-005 && npx vitest run src/adapters/__tests__/bigqueryJobs.test.ts
filter:  src/adapters/__tests__/bigqueryJobs.test.ts
No test files found, exiting with code 1
```
(Third verification command fails because TASK-BQ03-001's
`src/adapters/__tests__/bigqueryJobs.test.ts` has not landed in the
base branch (5de036d) that this worktree was created from. Pre-existing
state, not caused by this task.)

Status: PASS
Note:
- Files changed in this round:
  - `src/extension.ts` — added BQ-03.5 header helpers (`buildRunHeader`,
    `pickJobRefFromRun`, `escapeHtmlText`, `escape`); replaced the
    in-line baseHeader string at the legacy line; wired `buildRunHeader`
    for both the streaming onUpdate path (jobRef=null) and the post-settle
    path (jobRef=picked from THIS run's slice). Final fix:
    `results.slice(appendBase)` so the post-settle re-render reads the
    NEW run's `batched.jobRef`, not the prior run's stale handle.
  - `src/extension.test.ts` — appended the TASK-BQ03-005 describe block
    (8 tests: #1–#6 from the task Test Plan, plus R4.5 #1 append-mode
    regression and R4.5 #2 hostile billingProject); existing describes
    untouched.
- Hard constraints upheld: NO edits to `src/adapters/bigquery.ts`,
  `src/core/queryRunner.ts`, `src/ui/resultsPanel.ts`. The
  `decorateStateMessage` interception contract is unchanged — only the
  host-supplied header string is improved.
- R4.5 #2 hostile billingProject was confirmed GREEN through both
  the implementation (`escapeHtmlText` mirrors resultsPanel's `escapeHtml`
  for the identity segment; `escape()` percent-encodes `&` for the link
  body's `project=` param). The reviewer-noted double-occurrence check
  asserts the escaped billingProject substring appears at least once in
  the rendered header.
- TDD trail: the 2 new tests were authored before the implementation
  fix landed. With the buggy `[results[0] ?? {batched: null}]` left in
  place, R4.5 #1 reproducibly FAILS with `(first-job)` leaking into
  the 2nd run's header (paste above). Reverting to
  `results.slice(appendBase)` restores GREEN for all 8 BQ-03.5 tests.
- The hostile-billingProject test is structurally tied to the
  implementation's escaping posture; it cannot be made to fail RED by
  regressing the slice fix (it's an escape-coverage test, not a
  slice-fix test) — it lives in the same describe as the rest of the
  BQ-03.5 suite and is verified GREEN alongside them.

## R4.5 R2 Re-judgement
REVIEWER_MODEL: unic-smart
Verdict: Approved-with-minor
Both R2 findings are fixed in commit 647523f. Fix #1: the post-settle re-render at src/extension.ts:2125 now slices from `results.slice(appendBase)` (appendBase captured at :2089 before the run) and `pickJobRefFromRun` (:2008-2025) picks the first entry of THIS run's slice with a live `batched.jobRef` — so the 2nd BQ run shows the new job link and a multi-statement run whose statement 0 errors no longer degrades to `—`. The append-mode regression test drives two runs on the same session (persistent `mockRunnerResults` mirroring `return this.results.slice()` at queryRunner.ts:281) and asserts `(second-job)` present and `first-job` absent — genuine RED evidence shows the exact stale-leak pre-fix. Fix #2: the hostile billingProject fixture (`<script>alert("xss")</script>`) now covers both interpolation points — identity segment via `escapeHtmlText` (:1949) and the link `project=` param via `escape()` (:1959) — with escaped-form presence asserted (R4.5 #2 + strengthened test #4). Rewriting `buildBigQueryHeader` into `buildRunHeader` also closed the R2 minor (no redundant baseHeader alias). Verified fresh: 117/117 extension tests (incl. all 8 BQ-03.5), typecheck exit 0, 32/32 integration counterpart green, frozen surfaces untouched; the schemaForm bundle failure the executor saw was worktree-dist-only (passes here with populated dist/). Non-blocking residual: `escape()` percent-encodes only `&` in the link param while the surrounding string is then fully HTML-escaped — consistent with the textContent render posture, and the hostile test pins both positions.
