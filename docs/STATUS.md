# VSDB Status

- Last meaningful update: 2026-09-02
- Updated by: Claude (session continuation)
- Status confidence: high

## Current state

- HEAD: `089f2f0` (main, synced with origin)
- Latest release: **v1.46.0** (BQ-00 BigQuery provider feasibility + adapter contract spike; GitHub release live, vsix `vsdb-1.46.0.vsix` published; `@google-cloud/bigquery@^9.0.3` pinned; 4/4 tasks approved after R4.5 round 1 fixes)
- Suite baseline: **3209 passed | 2 skipped** (typecheck + compile exit 0; release hygiene 20/20; was 3189|2 at v1.45.0)
- No pending tasks; no handoff worktrees/branches lingering in the cycle flow

## Recently shipped (this session's cycles)

| Cycle | Release | Tasks | Approval | Notes |
|---|---|---|---|---|
| ARP-07 | v1.43.0 | 4/4 | round 1 | Successful-DDL cache/context invalidation |
| ARP-08 | v1.44.0 | 4/4 | round 1 | Console draft recovery (workspaceState, debounced, exactly-once flush) |
| ARP-09 | v1.45.0 | 5/5 | round 1 after R4.5 | Redacted diagnostics + `profile:fast`/`profile:release` |
| BQ-00 | v1.46.0 | 4/4 | R2 + R4.5 round 1 (1 critical_block + 1 changes_requested resolved) | BigQuery feasibility spike: package+bundle proof, pure types + `toBigQueryPage`, ADC classifier + seam, ADR 0004; no real ADC; no existing-driver changes |

## Documented follow-ups not yet scheduled (the "làm sạch sẽ" backlog)

These were captured across prior cycles as advisory/known-gap items but never planned.
They are the natural input for the next `ukit:handoff-fullstack` cycle.

1. **`browseCommands.ts:169-193` unguarded finally** — known from the original advisory; missing try/finally can leave partial table-load state on error paths. Read first to confirm scope (file may have moved).
2. **MSSQL `[insert]` bracket false positive** — the schema-impact classifier / dangerousStatement scanner trips on MSSQL bracket-quoted identifiers like `[insert]`. The class is known; fix belongs in `src/core/dangerousStatement.ts` (and the new `src/core/schemaImpact.ts` if it has the same gap), with a regression pin. Likely a small, verify-first cycle.
3. **ARP-07 form-view/AI plan-apply invalidation gap** — the `extension.ts` host seam at `runStatements` invalidates schema caches on successful DDL, but `tableCommands.ts:runDdl` and `aiChatPanel.ts:plan-apply` run `adapter.runQuery` directly and are NOT wired. Either route them through the seam (a real cycle) or close the gap explicitly.
4. **ARP-08 minor — snapshot `name` field uncapped** — R2 noted that the draft snapshot codec caps tabs (20) and buffer (64 000) but the `name` field is uncapped. Tiny cycle; add a cap and pin.
5. **BQ-00 R4.5 minors** — `DECL_RE` unused at `bigqueryPackage.test.ts:236` (minor) + 2 doc nits in `0004-bq-00-feasibility-contract.md` (BigQueryValue line cite, "§Hard constraints" section reference). Optional; can be folded into BQ-01.
6. **Cleanup verification cosmetic** — `git worktree list` shows several `.claude/worktrees/agent-*` detached entries owned by the harness; these are NOT part of the handoff cycle flow and will be reclaimed when the harness ages them out. No action required from the orchestrator.

## Next-cycle guidance

- BQ-00 is shipped; BQ-01 (ADC connection foundation) is the natural next cycle per `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §4. BQ-01 must use the BQ-00 boundary types and ADC classifier — it does NOT redo the spike.
- The 4 follow-up items above are still valid Cleanup Cycle candidates if BQ-01 is deferred; item 2 is still the smallest (verify-first, closes a real false-positive class).
- All follow-ups live in `src/` and are compatible with the same TDD worktree discipline used in ARP-07..09 + BQ-00.
- Item 6 is a non-issue; the `.claude/worktrees/agent-*` lines are out of cycle scope.

## Open question (not blocking)

The user has not yet chosen which to plan next: BQ-01 (BigQuery connection foundation, depends on this cycle's contracts) or one of the 4 follow-ups. The orchestrator will await `/ukit:handoff-fullstack` with an explicit Problem/feature.
