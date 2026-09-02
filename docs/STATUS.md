# VSDB Status

- Last meaningful update: 2026-09-02
- Updated by: Claude (session continuation)
- Status confidence: high

## Current state

- HEAD: `fc81131` (main, synced with origin)
- Latest release: **v1.47.0** (BQ-01 BigQuery connection foundation; GitHub release live, vsix `vsdb-1.47.0.vsix` published; 4/4 tasks approved — 3 `approved_minor` round 1 + 002 `approved_minor` after R4.5 round 2; BQ-00 surface byte-untouched; ADC external; INT64/BIGNUMERIC precision pinned end-to-end)
- Suite baseline: **3251 passed | 2 skipped** (typecheck + compile exit 0; release hygiene 20/20; was 3209|2 at v1.46.0; +42 new tests across BQ-01)
- No pending tasks; no handoff worktrees/branches lingering in the cycle flow

## Recently shipped (this session's cycles)

| Cycle | Release | Tasks | Approval | Notes |
|---|---|---|---|---|
| ARP-07 | v1.43.0 | 4/4 | round 1 | Successful-DDL cache/context invalidation |
| ARP-08 | v1.44.0 | 4/4 | round 1 | Console draft recovery (workspaceState, debounced, exactly-once flush) |
| ARP-09 | v1.45.0 | 5/5 | round 1 after R4.5 | Redacted diagnostics + `profile:fast`/`profile:release` |
| BQ-00 | v1.46.0 | 4/4 | R2 + R4.5 round 1 (1 critical_block + 1 changes_requested resolved) | BigQuery feasibility spike: package+bundle proof, pure types + `toBigQueryPage`, ADC classifier + seam, ADR 0004; no real ADC; no existing-driver changes |
| BQ-01 | v1.47.0 | 4/4 | R2 + R4.5 round 2 (002 critical_block → 2 fix rounds, 003 + 004 changes_requested resolved round 1) | BigQuery connection foundation: `BigQueryAdapter` (DbAdapter) + adapter-owned `BigQueryClientFactory` wraps BQ-00 seam with `{skipParsing:true}`; pure config validator + redaction; factory + ConnectionManager zero-SecretStorage admission + post-dispose fail-fast; form BQ field group + submit gate + copy-safe ADC remediation; ripple narrowing on `extension.ts` / `browseCommands.ts` / `resultsPanel.ts` for `DriverType+="bigquery"`; BQ-00 surface byte-untouched; INT64/BIGNUMERIC branded precision pinned end-to-end |

## Documented follow-ups not yet scheduled (the "làm sạch sẽ" backlog)

These were captured across prior cycles as advisory/known-gap items but never planned.
They are the natural input for the next `ukit:handoff-fullstack` cycle.

1. **`browseCommands.ts:169-193` unguarded finally** — known from the original advisory; missing try/finally can leave partial table-load state on error paths. Read first to confirm scope (file may have moved).
2. **MSSQL `[insert]` bracket false positive** — the schema-impact classifier / dangerousStatement scanner trips on MSSQL bracket-quoted identifiers like `[insert]`. The class is known; fix belongs in `src/core/dangerousStatement.ts` (and the new `src/core/schemaImpact.ts` if it has the same gap), with a regression pin. Likely a small, verify-first cycle.
3. **ARP-07 form-view/AI plan-apply invalidation gap** — the `extension.ts` host seam at `runStatements` invalidates schema caches on successful DDL, but `tableCommands.ts:runDdl` and `aiChatPanel.ts:plan-apply` run `adapter.runQuery` directly and are NOT wired. Either route them through the seam (a real cycle) or close the gap explicitly.
4. **ARP-08 minor — snapshot `name` field uncapped** — R2 noted that the draft snapshot codec caps tabs (20) and buffer (64 000) but the `name` field is uncapped. Tiny cycle; add a cap and pin.
5. **BQ-00 R4.5 minors** — `DECL_RE` unused at `bigqueryPackage.test.ts:236` (minor) + 2 doc nits in `0004-bq-00-feasibility-contract.md` (BigQueryValue line cite, "§Hard constraints" section reference). Optional; can be folded into BQ-02.
6. **BQ-01 R4.5 carried minors** — `bigquery.ts: never-connected throws BigQueryClosedError, durationMs hardcoded 0, inline import type annotations` (per R4.5 round 2 reviewer for 002). Optional; can be folded into BQ-02.
7. **Cleanup verification cosmetic** — `git worktree list` shows several `.claude/worktrees/agent-*` detached entries owned by the harness; these are NOT part of the handoff cycle flow and will be reclaimed when the harness ages them out. No action required from the orchestrator.

## Next-cycle guidance

- BQ-01 is shipped; BQ-02 (BigQuery resource explorer + table preview) is the natural next cycle per `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §4. BQ-02 wires real `NotImplementedError` placeholders that 002 deferred (listColumns on INFORMATION_SCHEMA, etc.) and adds lazy project/dataset/table/view discovery.
- The 4 follow-up items above are still valid Cleanup Cycle candidates if BQ-02 is deferred; item 2 is still the smallest (verify-first, closes a real false-positive class).
- All follow-ups live in `src/` and are compatible with the same TDD worktree discipline used in ARP-07..09 + BQ-00..01.
- Item 7 is a non-issue; the `.claude/worktrees/agent-*` lines are out of cycle scope.
- **A lesson learned this cycle:** worktree-local files do NOT survive orchestrator-side `git worktree remove` calls if the agent didn't commit before returning. The worktree commit MUST happen inside the executor's session, before the orchestrator copies back. Two wave-2 task files were lost and rebuilt during this cycle; the retry added the commit-inside-worktree contract and zero further losses occurred.
