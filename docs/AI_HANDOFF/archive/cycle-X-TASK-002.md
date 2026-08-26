# TASK-002 — Adversarial audit: results grid, webview, query UI

- Status: `done`
- Owner: `claude-code/bao-sonnet`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.1

## Goal

Review the shipped `v1.6.3..v1.6.6` UI/webview diff adversarially, emphasizing asynchronous ownership and SQL round trips, and write an evidence-backed report. Do not implement fixes in this task.

## Target Files

- `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md` **(new)** — severity-ranked findings, reviewed-file coverage, false-positive dispositions, and recommended fix/test paths.

## Test Cases (REQUIRED — audit contract)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | Changed-file coverage | Every changed production file under `src/ui/` and `webview/` in the tag range is reviewed or explicitly excluded with reason, with results-grid/query-composer/message paths reviewed in depth. | `git diff --name-only v1.6.3..v1.6.6` |
| 2 | edge — stale/ordering | Async ownership trace | Tab switches, stale DISTINCT replies, sort/filter requery, load-more, retry, commit-refresh, listeners, timers, and grid replacement each have a disposition; findings state a reproducible event order. | Changed `resultsPanel`, `messages`, grid model, and webview code |
| 3 | edge — malformed/empty | SQL and empty-state trace | Empty results, duplicate columns, null/undefined values, invalid ORDER BY/filter input, rejected host replies, and missing metadata are checked against concrete expected UI/SQL outcomes. | UI diff plus neighboring tests |
| 4 | regression — report quality | No speculative finding | Every P0–P3 row has severity, `file:line`, trigger, expected/actual, smallest fix, and exact proposed test file; unsupported suspicions are rejected explicitly. | Completed audit report |

## Test Files

- N/A — no executable behavior changes. The independently verifiable deliverable is `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md`; confirmed defects receive separate TDD tasks after Wave 1.

## Verification Commands

```bash
git diff --check v1.6.3..v1.6.6
git diff --name-only v1.6.3..v1.6.6 -- src/ui webview
test -s docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md
npm run typecheck
```

`package.json` has no lint script.

## Acceptance Criteria

- [ ] The report includes scope/method, reviewed-file checklist, findings table, rejected observations, and follow-up disposition.
- [ ] Every actionable item satisfies all evidence fields in test case 4.
- [ ] SQL composition is traced from webview model through messages/results panel to generated SQL, not reviewed as disconnected snippets.
- [ ] P0/P1 findings are mandatory; small/medium P2 findings are proposed for TASK-006/007; if unrelated P0/P1 findings require more tasks, propose TASK-008 onward rather than deferring or mis-grouping them; huge P2/P3 findings are proposed for the queue.
- [ ] No source, test, manifest, or dependency file is modified.
- [ ] All verification commands exit 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: Git range `v1.6.3..v1.6.6`; `HostMsg`/webview message shapes in `src/ui/messages.ts` and `webview/main.ts`; PLAN §7 global constraints.
- Produces: `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md` rows with fields `Severity | Evidence (file:line) | Trigger | Expected | Actual | Proposed fix | Proposed test | Disposition`.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Prioritize wrong behavior, stale state, leaks, and SQL correctness. Source size or duplicated comments alone are not findings without demonstrated impact.

### 2026-08-26 · executor · bao-sonnet
Report path decision: wrote the full report at `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md` (the path this task's own Verification Commands test) and a one-line pointer at `docs/AI_HANDOFF/notes/cycle-x-audit-grid.md` (the path in the orchestrator dispatch) so both verifications resolve. `git diff --check v1.6.3..v1.6.6` exits 2 on two whitespace defects INSIDE the audited range — documented as P3-1 in the report rather than fixed (audit is read-only on source); the other three verification commands pass.

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: N/A — audit task, no TDD (report task)
Verification Output: notes file written at docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md — 14 findings (P0:0 P1:5 P2:6 P3:3)
Status: PASS
Note: git diff --check exits 2 on 2 pre-existing range-internal whitespace defects (documented as P3-1, read-only constraint prevented fixing); npm run typecheck exit 0; test -s notes file exit 0; git status shows only the new notes/ dir — no src/, webview/, or test file modified.

---
