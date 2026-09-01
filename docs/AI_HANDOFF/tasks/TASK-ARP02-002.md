# TASK-ARP02-002 — Panel-close race: session-lifetime guard so late completion cannot render as a new session

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP02.md` §3, §4 (ARP-02.2)

## Goal

Make every deferred continuation of `ResultsPanel` inert after the panel is disposed. `postMessage` already
no-ops when `this.panel` is null (`src/ui/resultsPanel.ts:435`); the leak is the RE-CREATED panel — after
`dispose()` + `render()`, `this.panel` is non-null again, so a stale completion posts old results and
clears the new session's busy state. Confirmed RED by probe on `main @ 367cb80`: dispose during a deferred
`loadMore`, then `render()` recreates the panel; the stale resolution posts a `state` message with the OLD
SQL into the NEW panel.

Deliverable: a **session epoch** on the panel, bumped synchronously in `dispose()` (`:401-412`) and the
`onDidDispose` handler (`:277-285`); every deferred continuation captures it at entry and re-checks after
every await before `postMessage`/`setBusy`/toast, returning silently when stale. Exactly-once cleanup
(`rollbackOpenTransaction`'s `transaction === null` guard `:590-593`) is pinned, not regressed.

**Boundary: this task owns `resultsPanel.ts` ONLY.** The `runStatements` finally-busy leak and deactivate
ordering are extension-host surfaces owned by TASK-ARP02-004 (wave 2). If a host gap is visible from here,
RECORD it in the Executor Report; do NOT fix `src/extension.ts`.

## Target Files

- `src/ui/resultsPanel.ts` — only. Do NOT touch `src/core/queryRunner.ts` / `src/core/connectionManager.ts`
  (TASK-ARP02-001 / -003) and NOT `src/extension.ts` (TASK-ARP02-004).
- `src/ui/__tests__/resultsPanel.test.ts` — ADD cases; keep all existing blocks intact.

## Test Cases (REQUIRED — TDD)

RED-first: write cases 2 and 5 FIRST, run them, paste the RED output, then implement. Cases 1, 4, 6 are
expected GREEN on base (regression pins).

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | close idle panel → exactly-once cleanup, no message | `dispose()` (and/or `onDidDispose`) with no open tx → `rollbackOpenTransaction` no-ops (0 calls); no `postMessage`; no toast | `makeRunnerStub` (`resultsPanel.test.ts:87-92`), FakeWebview/FakeWebviewPanel `:12-42` |
| 2 | edge: dispose-during-run | deferred `loadMore`; `dispose()`; `render()` recreates panel; stale resolves → no post into the NEW panel | stale resolution posts NO `state` with old SQL to the recreated panel (`postMessage` spy on the new panel sees 0 stale `state`); no error toast. **RED on 367cb80** (probe: 1 stale post) | runner stub whose `loadMore` returns a deferred promise; `render()` twice |
| 3 | edge: dispose-during-run | deferred `handleRequery`; dispose; recreate; stale resolves → silent return | `showErrorMessage` NOT called; no `state` post; no busy write (stale path returns silently). **RED on 367cb80** (same epoch gap) | `saveContext` + runner `runSql` deferred; dispatch `requery` |
| 4 | edge: one-cleanup | `dispose()` twice + panel `onDidDispose` | rollback executed exactly **once** (guarded by `transaction === null` at `:590-593`) | open fake `DbTransaction` in `this.transaction` |
| 5 | edge: busy | dispose during run; new run `setBusy(true)`; stale finally must not clear | `busy:false` NEVER posted to the recreated panel after the stale continuation settles. **RED on 367cb80** (probe: busy cleared) | stale deferred `loadMore`; after recreate, `setBusy(true)` then resolve stale |
| 6 | regression | postMessage after dispose (panel null) is a silent no-op | existing post sites keep `if (!this.panel) return` behavior; `render()` after dispose still creates a working panel | existing fixtures |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` — ADD cases 1-6. Reuse FakeWebview/FakeWebviewPanel `:12-42`,
  `makeRunnerStub` `:87-92`, `lastPanel`/`createCalls` bookkeeping `:44-49`. For case 3 reuse the
  requery fixture style from `resultsPanelRequery.test.ts` (dispatch `requery` with a deferred
  `runner.runSql`).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `resultsPanel.ts` → `.cache/index/tests-map.json` lists 7 suites
`[resultsPanel.test.ts, resultsPanelDistinctValues, resultsPanelOrderBy, resultsPanelRequery,
resultsPanelRetry, resultsPanelSaveEdits, resultsPanelServerFilter]`. The pinned new-test target is
`resultsPanel.test.ts`; the 6 sibling suites are exercised by the wave/cycle `npm test` net, NOT per-task.
No lint script; typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: case 2 (and 5) fail on base 367cb80 BEFORE implementation (probe: stale
      `state` posted into the recreated panel; busy cleared).
- [ ] After fix: case 2 GREEN (no stale post to the recreated panel), case 3 GREEN (requery stale → silent),
      case 5 GREEN (busy not cleared by a stale finally).
- [ ] Case 4 GREEN: cleanup exactly-once across `dispose()` ×2 + `onDidDispose`.
- [ ] `git diff 367cb80 -- src/extension.ts` is EMPTY (this task did not touch the host).
- [ ] All existing `resultsPanel.test.ts` blocks (BigInt sanitize, postMessage rejection, save, loadMore
      message handling) still green.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Executor Report records any host-side gap observed (e.g. `runStatements` finally busy, deactivate
      ordering) for TASK-ARP02-004's gate — without fixing it here.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `none` (wave 1 — parallel with TASK-ARP02-001 and TASK-ARP02-003; no shared files). TASK-ARP02-004
  (wave 2) consumes this task's session-epoch behavior if it exists.

## Interfaces

- Consumes:
  - `QueryRunner.loadMore(index: number)` / `cancel()` / `runSql(sql)` — `src/core/queryRunner.ts`.
  - `rollbackOpenTransaction(options?: { fromMessage?: boolean })` — `resultsPanel.ts:587-606`.
  - `requerySeq` (`:147`), `statementGeneration` (`:163`) — existing data-staleness guards (keep them;
      the epoch is additive and distinct).
- Produces: no public API. Internal only: a private session epoch and a private guard helper checked at
  each continuation resume. `render()`/`dispose()`/`setBusy()`/`show()` signatures unchanged.

## Discussion

- The session epoch is bumped in BOTH `dispose()` and the `onDidDispose` handler (they can both run).
  Continuations capture it before their first await and compare after every await; the guard is checked
  before `postMessage`, before `setBusy`, and before `showErrorMessage` in the error paths (cases 2/3/5).
- `refreshColumnTypes` (`:532-576`) and `handleRequestDistinctValues` (`:1295`) already use
  `statementGeneration`; the epoch must be checked ADDITIONALLY (generation is per-statement-set, not
  per-panel-lifetime).
- The manual-transaction rollback on dispose is a connection-lifecycle boundary and must keep running on
  dispose (do NOT skip it for a new session) — only UI writes are suppressed. `rollbackOpenTransaction`
  posts `transactionStatus` via `postMessage`; guard that post by epoch too.
- (no comments yet)

---

## Executor Report

```
(write here: STATUS / EXECUTOR_TOOL / EXECUTOR_MODEL / EXECUTOR_SUBAGENT / RED_OUTPUT /
 VERIFICATION output / ISSUES / HANDOFF_TO_REVIEWER)
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
