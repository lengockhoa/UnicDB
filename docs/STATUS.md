# VSDB Status

- Last meaningful update: 2026-09-02
- Updated by: Claude (session continuation)
- Status confidence: high

## Current state

- HEAD: `56c6b91` (main, synced with origin)
- Latest release: **v1.48.0** (CL-01 cleanup cycle; GitHub release live, vsix `vsdb-1.48.0.vsix` published; 4/4 tasks approved — 3 `approved` + 1 `approved_minor`; zero R4.5 fix rounds needed; BQ-00 surface byte-untouched)
- Suite baseline: **3283 passed | 2 skipped** (typecheck + compile exit 0; release hygiene 20/20; was 3251|2 at v1.47.0; +32 new tests across CL-01)
- No pending tasks; no handoff worktrees/branches lingering in the cycle flow

## Recently shipped (this session's cycles)

| Cycle | Release | Tasks | Approval | Notes |
|---|---|---|---|---|
| ARP-07 | v1.43.0 | 4/4 | round 1 | Successful-DDL cache/context invalidation |
| ARP-08 | v1.44.0 | 4/4 | round 1 | Console draft recovery (workspaceState, debounced, exactly-once flush) |
| ARP-09 | v1.45.0 | 5/5 | round 1 after R4.5 | Redacted diagnostics + `profile:fast`/`profile:release` |
| BQ-00 | v1.46.0 | 4/4 | R2 + R4.5 round 1 (1 critical_block + 1 changes_requested resolved) | BigQuery feasibility spike: package+bundle proof, pure types + `toBigQueryPage`, ADC classifier + seam, ADR 0004; no real ADC; no existing-driver changes |
| BQ-01 | v1.47.0 | 4/4 | R2 + R4.5 round 2 (002 critical_block → 2 fix rounds, 003 + 004 changes_requested resolved round 1) | BigQuery connection foundation: `BigQueryAdapter` (DbAdapter) + adapter-owned `BigQueryClientFactory` wraps BQ-00 seam with `{skipParsing:true}`; pure config validator + redaction; factory + ConnectionManager zero-SecretStorage admission + post-dispose fail-fast; form BQ field group + submit gate + copy-safe ADC remediation; ripple narrowing on `extension.ts` / `browseCommands.ts` / `resultsPanel.ts` for `DriverType+="bigquery"`; BQ-00 surface byte-untouched; INT64/BIGNUMERIC branded precision pinned end-to-end |
| CL-01 | v1.48.0 | 4/4 | R2 round 1 (3 approved + 1 approved_minor; zero R4.5 fix rounds) | Cleanup cycle: MSSQL bracket-quoted identifier masking in `dangerousStatement.ts` + dialect threading in `connectionManager.guardAdapter`; ARP-07 invalidation wiring closed for form-DDL + AI plan-apply; console draft snapshot `name` cap (200); BQ-00 + BQ-01 R4.5 carried minors folded (`BigQueryNotConnectedError` distinct from `BigQueryClosedError`, `durationMs` measured, 6 inline imports lifted, unused `DECL_RE` removed, 2 ADR 0004 doc nits); BQ-00 surface byte-untouched |

## Documented follow-ups not yet scheduled (the "làm sạch sẽ" backlog)

The CL-01 cycle closed items 2, 3, 4, 5, 6 from the prior backlog. Two remain:

1. **`browseCommands.ts:169-193` unguarded finally** — **verified already fixed at HEAD** (try :148 / catch :178 / finally :181-183; cited line range 169-193 doesn't exist at the post-BQ-01 base). No action required.
2. **Cleanup verification cosmetic** — `git worktree list` shows several `.claude/worktrees/agent-*` detached entries owned by the harness; these are NOT part of the handoff cycle flow and will be reclaimed when the harness ages them out. No action required from the orchestrator.

## Next-cycle guidance

- v1.48.0 is shipped; BQ-02 (BigQuery resource explorer + table preview) is the natural next cycle per `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §4. BQ-02 wires real `NotImplementedError` placeholders that 002 deferred (listColumns on INFORMATION_SCHEMA, etc.) and adds lazy project/dataset/table/view discovery.
- All remaining follow-ups are now in harness-scope or non-issues; the explicit backlog is empty. Future cycles will need a fresh user request.
- **A lesson learned this cycle:** the orchestrator's 3c copy-back loop ran `git -C "$WORKTREE" diff --name-only HEAD~` after the worktree's most recent commit was the executor-report commit (added after the source commit), so `HEAD~` referenced the source commit and the diff returned no file paths. The worktree commits were real (`86a5e4b`, `e6c0f36`, `aebb453`, `37d94ec`) but the cp step never ran. Recovery: checkout the source changes from the dangling commits via `git show <sha> -- src/ | git apply --include='src/*'`. Suite was 3283|2 GREEN after the recovery, +32 new tests. The cp-loop should use `git -C "$WORKTREE" diff --name-only $BASE` (the branch's base, not HEAD~) to be robust against multi-commit worktrees.
