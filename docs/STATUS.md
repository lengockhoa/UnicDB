# VSDB Status

- Last meaningful update: 2026-09-02
- Updated by: Claude (session continuation)
- Status confidence: high

## Current state

- HEAD: `d4eb18a` (main, synced with origin)
- Latest release: **v1.45.0** (ARP-09 redacted support diagnostics + release-confidence profiles; GitHub release live, vsix `vsdb-1.45.0.vsix` published)
- Suite baseline: **3189 passed | 2 skipped** (typecheck + compile exit 0; release hygiene 20/20)
- No pending tasks; no handoff worktrees/branches lingering in the cycle flow

## Recently shipped (this session's cycles)

| Cycle | Release | Tasks | Approval | Notes |
|---|---|---|---|---|
| ARP-07 | v1.43.0 | 4/4 | round 1 | Successful-DDL cache/context invalidation |
| ARP-08 | v1.44.0 | 4/4 | round 1 | Console draft recovery (workspaceState, debounced, exactly-once flush) |
| ARP-09 | v1.45.0 | 5/5 | round 1 after R4.5 | Redacted diagnostics + `profile:fast`/`profile:release` |

## Documented follow-ups not yet scheduled (the "làm sạch sẽ" backlog)

These were captured across the three cycles as advisory/known-gap items but never planned.
They are the natural input for the next `ukit:handoff-fullstack` cycle.

1. **`browseCommands.ts:169-193` unguarded finally** — known from the original advisory; missing try/finally can leave partial table-load state on error paths. Read first to confirm scope (file may have moved).
2. **MSSQL `[insert]` bracket false positive** — the schema-impact classifier / dangerousStatement scanner trips on MSSQL bracket-quoted identifiers like `[insert]`. The class is known; fix belongs in `src/core/dangerousStatement.ts` (and the new `src/core/schemaImpact.ts` if it has the same gap), with a regression pin. Likely a small, verify-first cycle.
3. **ARP-07 form-view/AI plan-apply invalidation gap** — the `extension.ts` host seam at `runStatements` invalidates schema caches on successful DDL, but `tableCommands.ts:runDdl` and `aiChatPanel.ts:plan-apply` run `adapter.runQuery` directly and are NOT wired. Either route them through the seam (a real cycle) or close the gap explicitly.
4. **ARP-08 minor — snapshot `name` field uncapped** — R2 noted that the draft snapshot codec caps tabs (20) and buffer (64 000) but the `name` field is uncapped. Tiny cycle; add a cap and pin.
5. **Cleanup verification cosmetic** — `git worktree list` shows several `.claude/worktrees/agent-*` detached entries owned by the harness; these are NOT part of the handoff cycle flow and will be reclaimed when the harness ages them out. No action required from the orchestrator.

## Next-cycle guidance

- A new `ukit:handoff-fullstack` invocation will start with `Phase: P1` and the orchestrator should batch items 1–4 above into a single **Cleanup Cycle** (e.g. `CYC-CLEANUP-1`) or split into sequential cycles ordered by scope (start with item 2 — smallest, verify-first, ships a clean cap on a known false positive — then item 4, then item 3, then item 1).
- All three follow-ups live in `src/` and are compatible with the same TDD worktree discipline used in ARP-07..09.
- Item 5 is a non-issue; the `.claude/worktrees/agent-*` lines are out of cycle scope.

## Open question (not blocking)

The user has not yet chosen which item to plan next. The orchestrator will await `/ukit:handoff-fullstack` with an explicit Problem/feature — the four follow-ups above are listed in priority order if a single-sentence problem is supplied.
