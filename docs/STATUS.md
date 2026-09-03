# VSDB Status

- Last meaningful update: 2026-09-03
- Updated by: Claude (BQ-03 cycle close-out)
- Status confidence: high

## Current state

- HEAD: `75cdb08` (main, synced with origin; tag `v1.50.0`)
- Latest release: **v1.50.0** (BQ-03 GoogleSQL query jobs + paged Results grid; GitHub release live at https://github.com/lengockhoa/VSDB/releases/tag/v1.50.0, vsix `vsdb-1.50.0.vsix` 1.99 MB published; 5/5 tasks `approved_minor` after R4.5 R1; BQ-00 frozen surface byte-untouched; BQ-01 narrow `BigQueryClientLike` + `BatchedQuery` interface unchanged)
- Suite baseline: **3385 passed | 2 skipped** (typecheck + compile exit 0; was 3316|2 at v1.49.0; **+69 new tests** across BQ-03: 32 in bigqueryJobs.test.ts (new) + 12 in bigqueryPages.test.ts (new) + 10 in queryRunner.test.ts + 7 in resultsPanel.test.ts + 8 in extension.test.ts)
- No pending tasks; no handoff worktrees/branches lingering in the cycle flow

## Recently shipped (this session's cycles)

| Cycle | Release | Tasks | Approval | Notes |
|---|---|---|---|---|
| ARP-07 | v1.43.0 | 4/4 | round 1 | Successful-DDL cache/context invalidation |
| ARP-08 | v1.44.0 | 4/4 | round 1 | Console draft recovery (workspaceState, debounced, exactly-once flush) |
| ARP-09 | v1.45.0 | 5/5 | round 1 after R4.5 | Redacted diagnostics + `profile:fast`/`profile:release` |
| BQ-00 | v1.46.0 | 4/4 | R2 + R4.5 round 1 (1 critical_block + 1 changes_requested resolved) | BigQuery feasibility spike: package+bundle proof, pure types + `toBigQueryPage`, ADC classifier + seam, ADR 0004; no real ADC; no existing-driver changes |
| BQ-01 | v1.47.0 | 4/4 | R2 + R4.5 round 2 (002 critical_block → 2 fix rounds, 003 + 004 changes_requested resolved round 1) | BigQuery connection foundation: `BigQueryAdapter` (DbAdapter) + adapter-owned `BigQueryClientFactory` wraps BQ-00 seam with `{skipParsing:true}`; pure config validator + redaction; factory + ConnectionManager zero-SecretStorage admission + post-dispose fail-fast; form BQ field group + submit gate + copy-safe ADC remediation; ripple narrowing on `extension.ts` / `browseCommands.ts` / `resultsPanel.ts` for `DriverType+="bigquery"`; BQ-00 surface byte-untouched; INT64/BIGNUMERIC branded precision pinned end-to-end |
| CL-01 | v1.48.0 | 4/4 | R2 round 1 (3 approved + 1 approved_minor; zero R4.5 fix rounds) | Cleanup cycle: MSSQL bracket-quoted identifier masking in `dangerousStatement.ts` + dialect threading in `connectionManager.guardAdapter`; ARP-07 invalidation wiring closed for form-DDL + AI plan-apply; console draft snapshot `name` cap (200); BQ-00 + BQ-01 R4.5 carried minors folded; BQ-00 surface byte-untouched |
| BQ-02 | v1.49.0 | 4/4 | R2 + R4.5 round 1 (001/002/003 approved_minor; 004 changes_requested → 1 mechanical CHANGELOG fix round → approved_minor) | BigQuery resource explorer + table preview: real `BigQueryAdapter.listSchemas/listTables/listViews/listColumns/listRoutines/listTableDetail/estimateTableRows[Batch]` via real `@google-cloud/bigquery@9.0.3` client metadata calls (`getDatasets` → `dataset(id).getTables()` → `table(id).getMetadata()`; `dataset(id).getRoutines()`); pure `buildBigQueryPreviewSql` (backtick-quoted, 3-part when project differs, LIMIT default 100 / ceiling 1000, clamp `[1, 1000]`); Schema Explorer bigquery wiring (cloud icon, `bigquery@<billingProject>` cost-safe tooltip, dataset-not-schema labels, row-count batch suppressed); preview click path through `vsdb.browseTableData` end-to-end; BQ-00 frozen surface byte-untouched; +33 tests over v1.48.0; R4.5 1 round (CHANGELOG path drift + false review-evidence claim + per-bullet test count reconciliation) |
| BQ-03 | v1.50.0 | 5/5 | R2 + R4.5 round 1 (002/004 approved_minor; 001/003/005 changes_requested → 1 R4.5 R1 → all approved_minor) | GoogleSQL query jobs + paged Results grid: real `BigQueryAdapter.runQuery` → BigQuery job via new `createQueryJob` seam + `BigQueryPagedQuery implements BatchedQuery` + MVP SQL gate (string-literal/comment-aware semicolon scan + `SELECT`/`WITH` allowlist + 16-token write/DDL blocklist incl. `WITH cte AS (SELECT 1) SELECT * FROM cte` positive control) + sanitized `BigQueryJobError` (both `createQueryJob` AND `getQueryResults` rejection paths route through `classifyJobError`); pure `bigqueryPages.ts` (`createBigQueryPageFetcher` token-verbatim + 20 MB-aware `byteBudget`; `formatBigQueryCell` deliverable-but-unwired); runner EOF→`close()` + `cursorClosed` + per-index isolation + `setOnExhausted` installer for the `limited` channel + `appendBatchBounded` mirror + `StatementResult.pending?:boolean` (additive); ResultsPanel distinct pending/running/cancelled/limited/error + token-gated silent Load More + `statementGeneration` guard; `runStatements` builds copy-safe header (data/billing project + location + job link/ID `https://console.cloud.google.com/bigquery?project=<billing>&j=bq:<location>:<jobId>`, HTML-escaped) + GoogleSQL surfaced (never silent legacy) + append-mode 2nd-run slices from `appendBase`; BQ-00 frozen surface byte-untouched; `BatchedQuery` interface frozen; +69 tests over v1.49.0; R4.5 1 round (cancelActiveQuery timing + getQueryResults classifyJobError + pending observability + setOnExhausted installer duck-type + append-mode slice + hostile billingProject escape) |

## Documented follow-ups not yet scheduled (the "làm sạch sẽ" backlog)

The CL-01 cycle closed items 2, 3, 4, 5, 6 from the prior backlog. Two non-issues remain:

1. **`browseCommands.ts:169-193` unguarded finally** — **verified already fixed at HEAD** (try :148 / catch :178 / finally :181-183; cited line range 169-193 doesn't exist at the post-BQ-01 base). No action required.
2. **Cleanup verification cosmetic** — `git worktree list` shows several `.claude/worktrees/agent-*` detached entries owned by the harness; these are NOT part of the handoff cycle flow and will be reclaimed when the harness ages them out. No action required from the orchestrator.

## Next-cycle guidance

- v1.50.0 is shipped; backlog is empty. The natural follow-ups (none scheduled) would be:
  - **BQ-04** — wire `formatBigQueryCell` into the results grid (deliverable-but-unwired this cycle, named follow-up).
  - **`pageSize` configurability** — `getQueryResults` `maxResults` is fixed at one default this cycle; surface a per-`BatchedQuery` tunable if real-world latency warrants.
  - **`useLegacySql: true` UI toggle** — currently honored at the seam but no UI sets it; surface a "Use legacy SQL" toggle in the editor.
- All remaining follow-ups are non-issues; the explicit backlog is empty. Future cycles will need a fresh user request.
- **Lessons carried forward (updated for BQ-03):**
  - The 3c copy-back fix (use `git -C "$WORKTREE" diff --name-only $BASE` not `HEAD~`) carried from CL-01 / BQ-02 worked cleanly across all 3 BQ-03 waves + the R4.5 R1 round.
  - The stray `docs/AI_HANDOFF/PLAN_AIX09.md` orphan re-appears after every `git add docs/AI_HANDOFF/` because the orchestrator's git-add glob picks it up untracked. The BQ-03 cycle confirmed the lesson: scoped `git add` of the touched files (e.g. `git add docs/AI_HANDOFF/PLAN.md docs/AI_HANDOFF/INDEX.md docs/AI_HANDOFF/ACTIVE.md docs/AI_HANDOFF/RUN.md docs/AI_HANDOFF/tasks/`) skips the orphan pickup entirely. The extra `git rm --cached` + re-commit dance has been eliminated.
  - **NEW: worktrees branched from `$BASE` (which predates the plan commit) don't see the task file** — BQ-03 had 4 worktrees (002, 003, 004, 005 R4.5) hit this and had to `git show <plan-commit>:` the file. Cheap fix: pre-populate via `git show` at worktree creation, or have the executor's prompt explicitly say "task file may be missing — `git show 3969c25:docs/AI_HANDOFF/tasks/TASK-xxx.md` to restore."
  - **NEW: when a R4.5 fix changes a file the wave's executor was supposed to deliver, the R4.5 worktree (also branched from `$BASE`) may need to rebuild the surface from scratch** — 005's R4.5 executor did this. Costly but correct; alternative is branching the R4.5 worktrees from the wave-3 commit, which makes the diff harder to reason about.
  - **NEW: lite-tier subagents without Bash access fail verification tasks** — the R1 lite-tier subagent returned `HAND_BACK_REASON: Bash not available`. Inline the verification on the orchestrator for non-trivial R-lanes.
  - **NEW: hook-protected `package-lock.json`** — direct `Edit` is blocked; use `npm install --package-lock-only` to sync after bumping `package.json`.
