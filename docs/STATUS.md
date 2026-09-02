# VSDB Status

- Last meaningful update: 2026-09-03
- Updated by: Claude (BQ-02 cycle close-out)
- Status confidence: high

## Current state

- HEAD: `bdcd16a` (main, synced with origin)
- Latest release: **v1.49.0** (BQ-02 BigQuery resource explorer + table preview; GitHub release live at https://github.com/lengockhoa/VSDB/releases/tag/v1.49.0, vsix `vsdb-1.49.0.vsix` 1.98 MB published; 4/4 tasks `approved_minor`; R4.5 1 fix round for CHANGELOG mechanical corrections only; BQ-00 frozen surface byte-untouched)
- Suite baseline: **3316 passed | 2 skipped** (typecheck + compile exit 0; was 3283|2 at v1.48.0; **+33 new tests** across BQ-02: 14 in bigquery.test.ts + 7 in bigQueryPreview.test.ts + 4 in browseCommands.test.ts + 7 in schemaTree.test.ts + 1 in schemaTreeCatalog.test.ts)
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

## Documented follow-ups not yet scheduled (the "làm sạch sẽ" backlog)

The CL-01 cycle closed items 2, 3, 4, 5, 6 from the prior backlog. Two non-issues remain:

1. **`browseCommands.ts:169-193` unguarded finally** — **verified already fixed at HEAD** (try :148 / catch :178 / finally :181-183; cited line range 169-193 doesn't exist at the post-BQ-01 base). No action required.
2. **Cleanup verification cosmetic** — `git worktree list` shows several `.claude/worktrees/agent-*` detached entries owned by the harness; these are NOT part of the handoff cycle flow and will be reclaimed when the harness ages them out. No action required from the orchestrator.

## Next-cycle guidance

- v1.49.0 is shipped; **BQ-03** (GoogleSQL query jobs + paged grid) is the natural next cycle per `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §5. BQ-03 adds the `BigQueryJobRef` continuation, opaque page token, `job.cancel()` cancel-after-terminal, and Load More affordance the BQ-02 preview path is bounded against.
- All remaining follow-ups are non-issues; the explicit backlog is empty. Future cycles will need a fresh user request.
- **Lessons carried forward:** the 3c copy-back fix (use `git -C "$WORKTREE" diff --name-only $BASE` not `HEAD~`) carried from CL-01 worked cleanly across both BQ-02 waves; the stray `docs/AI_HANDOFF/PLAN_AIX09.md` orphan re-appears after every `git add docs/AI_HANDOFF/` because the orchestrator's git-add glob picks it up untracked — the dedicated `git rm --cached` + re-commit dance adds one extra commit per release. Consider a `.gitignore` entry or a dedicated `git add` of the touched files (e.g. `git add docs/AI_HANDOFF/PLAN.md docs/AI_HANDOFF/INDEX.md docs/AI_HANDOFF/ACTIVE.md docs/AI_HANDOFF/RUN.md docs/AI_HANDOFF/tasks/`) to skip the orphan pickup entirely.
