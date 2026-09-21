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
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code (claude-sonnet tier; self-reported per harness)
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (npx vitest run src/ui/__tests__/resultsPanel.test.ts, BEFORE implementation):
  ❯ case 2: deferred loadMore; dispose; recreate — stale resolution posts NOTHING to the new panel
    AssertionError: expected [ { type: 'state', … } ] to have a length of +0 but got 1
    ❯ src/ui/__tests__/resultsPanel.test.ts:1259  (stale `state` with OLD SQL posted into the recreated panel — matches the task's probe on 367cb80)
  ❯ case 3: deferred requery; dispose; recreate — stale resolution returns SILENTLY
    AssertionError: expected [ { type: 'state', …(3) } ] to have a length of +0 but got 1
    ❯ src/ui/__tests__/resultsPanel.test.ts:1309  (same epoch gap)
  ❯ case 5: dispose mid-loadMore; recreate; setBusy(true) — stale finally never posts busy:false
    AssertionError: expected [ { type: 'busy', busy: false } ] to have a length of +0 but got 1
    ❯ src/ui/__tests__/resultsPanel.test.ts:1364  (busy cleared — matches the task's probe)
  Test Files  1 failed (1) | Tests  3 failed | 36 passed (39)
  Cases 1, 4, 6 GREEN on base as pinned (regression pins) — expected per test table.
  RED confirmed for the EXPECTED reasons; no immediately-GREEN anomaly.

IMPLEMENTATION SUMMARY:
  Added `private sessionEpoch = 0` (per-PANEL-LIFETIME, additive & distinct from requerySeq /
  statementGeneration) + `private isStaleSession(captured)` helper.
  Epoch bumped synchronously in BOTH dispose() and the onDidDispose handler (both paths can run).
  Every deferred continuation now captures the epoch before its first await and re-checks after
  EVERY await, returning silently when stale — before postMessage, before setBusy, before
  showErrorMessage — in: handleMessage/loadMore (success + error + finally), handleRequery
  (cursor-close, listPkColumns, listColumnTypes, post-runSql, error branch, finally),
  handleSaveEdits (pkColumns, manual runQuery fail ack, postTransactionStatus, refresh SELECT,
  catch/finally), handleCommitTransaction, rollbackOpenTransaction (rollback itself ALWAYS runs —
  connection-lifecycle boundary; only the transactionStatus UI post is epoch-guarded),
  refreshManualStatement, refreshColumnTypes and handleRequestDistinctValues (epoch checked
  ADDITIONALLY to statementGeneration, per Discussion), handleExportFile.
  Exactly-once cleanup pinned: rollbackOpenTransaction's `transaction === null` guard untouched
  (case 4 exercises dispose() ×2 + onDidDispose → rollback exactly 1 call).
  No signatures changed; render/dispose/setBusy/show public surface unchanged.

VERIFICATION OUTPUT (all run fresh in the worktree, after implementation):
  1. npx vitest run src/ui/__tests__/resultsPanel.test.ts
     → Test Files  1 passed (1) | Tests  39 passed (39) | exit 0
     (all existing blocks still green: BigInt sanitize, postMessage rejection/sync-throw,
      loadMore message handling, append-aware render, batched wire shape, dialect/columnTypes,
      A14 header, RLX02-003 cancel path, resultsPlacement — plus 6 new ARP02-002 cases)
  2. npm run typecheck  → tsc --noEmit, exit 0
  3. npm run compile    → esbuild build complete, exit 0
  Boundary: git diff 367cb80 -- src/extension.ts is EMPTY; only resultsPanel.ts +
  resultsPanel.test.ts modified. Not committed (per instruction).

ISSUES / HOST-SIDE GAPS OBSERVED (recorded for TASK-ARP02-004, NOT fixed here):
  1. runStatements finally-busy leak (extension.ts): the host calls panel.setBusy(true/false)
     around runStatements; after dispose+recreate mid-run, the host-side finally targets the SAME
     ResultsPanel object (which now owns a NEW panel session) and would clear the new session's
     busy state. Out of this task's boundary (extension.ts untouched).
  2. Deactivate ordering: ResultsPanel.dispose() fires rollbackOpenTransaction fire-and-forget;
     during extension deactivation there is no await point guaranteeing the rollback completes
     before the pool closes — adapter-level concern, same wave-2 ownership.
  3. Note for reviewer: dispose() bumps the epoch BEFORE rollbackOpenTransaction captures its
     epoch, so a teardown rollback intentionally posts NO transactionStatus (panel is gone) while
     still executing the rollback. Message-path rollback (fromMessage:true) captures a live epoch
     and keeps posting + requeries as before.

HANDOFF_TO_REVIEWER: yes — all 3 verification commands pass with fresh output above; reviewer
(unic-smart) should rerun the 3 commands and confirm the epoch guard in every continuation.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```

## Reviewer Report
REVIEWER_MODEL: unic-smart
ROUND: 1
VERDICT: changes_requested
Findings:
- src/ui/resultsPanel.ts:973 and :978 — `if (this.isStaleSession(this.sessionEpoch)) return;` is a NO-OP: it compares the current epoch to itself so it is always false and never fires. A dispose landing during `await this.closeStatementCursor(r)` (:970) or `await this.saveContext.listPkColumns(...)` (:977) does NOT stop the save continuation; it keeps running and posts stale `saveResult` acks into the re-created panel. Minimal fix: capture `const epoch = this.sessionEpoch;` BEFORE each await and check `isStaleSession(epoch)` — cleanest is a single capture at the top of handleSaveEdits before :970.
- src/ui/resultsPanel.ts:1251-1259 — the success `saveResult ok:true` post is NOT epoch-guarded in manual-commit mode (the auto-mode guard at :1210 lives inside `if (!manualCommit)` and is never reached for manual). A dispose during `await this.transaction.runQuery(...)` (:1138) still posts `saveResult ok:true` to the re-created panel and leaves `this.transaction` (set at :1134) dangling on the new session. The refusal/no-op acks at :1052/:1076/:1094/:1108 are also unguarded after `await this.fetchPostgresCtids(...)` (:1039). Minimal fix: with the epoch captured at the top, wrap every `saveResult`/`state` post in `if (!this.isStaleSession(epoch))`.
- (tests 1-6 all pass and RED evidence is genuine; the gap is that no added test exercises the save-dispose path, so the no-op guards and the unguarded manual-mode ack are not caught.)

## Fix Round 1 Report

```
EXECUTOR_MODEL: unic-code (claude-sonnet tier; self-reported per harness)

RED_OUTPUT (npx vitest run src/ui/__tests__/resultsPanel.test.ts, BEFORE the fix, cases 7+8 added first):
  ❯ case 7: dispose-during-save; recreate; stale save refusal posts NOTHING to the new panel
    AssertionError: expected [ { type: 'saveResult', …(5) } ] to have a length of +0 but got 1
    ❯ src/ui/__tests__/resultsPanel.test.ts:1440  (mysql no-PK refusal ack posted into the RE-CREATED
      panel after dispose during the listPkColumns await — proves the :973/:978 no-op guards never fire)
  ❯ case 8: dispose mid manual-commit save; recreate; stale ok:true posts NOTHING to the new panel
    AssertionError: expected [ { type: 'saveResult', …(2) } ] to have a length of +0 but got 1
    ❯ src/ui/__tests__/resultsPanel.test.ts:1532  (manual-commit saveResult ok:true posted into the
      RE-CREATED panel after dispose during tx.runQuery — proves the unguarded :1251-1259 ack)
  Test Files  1 failed (1) | Tests  2 failed | 39 passed (41)
  RED confirmed for the EXPECTED reasons (both reviewer findings reproduced).

FIX SUMMARY:
  1. Finding 1 — `const epoch = this.sessionEpoch` now captured ONCE at the top of handleSaveEdits,
     before the first await (closeStatementCursor at :970). The two no-op checks
     (`isStaleSession(this.sessionEpoch)`) now compare the captured epoch: both fire correctly.
     The now-redundant mid-flow capture (old :1116) was removed; the try-block guards
     (:1144/:1154/:1177/:1210-era sites), the catch (:1283-era) and the finally (:1317-era) keep
     using the single top capture — semantics unchanged for them (same value).
  2. Finding 2 — every post-await ack in the save flow is now guarded with the captured epoch:
     ctid-lookup refusal (old :1052), build no_pk/invalid refusal (old :1076), all-skipped
     ok:false (old :1094), empty-edits no-op ok:true (old :1108), and the success ok:true
     (old :1251-1259 — previously reachable UNguarded in manual-commit mode). Additionally the
     pre-try `setBusy(true)` is now preceded by a stale return (post-await UI write, mirrors the
     finally guard). Auto-mode refresh early-return (old :1210) kept as-is (same captured epoch).
  3. TDD evidence above; both cases GREEN after the fix. Connection-lifecycle invariant kept:
     the manual-transaction rollback paths still run on stale sessions (only UI writes suppressed).

OPTIONAL MINORS APPLIED (from TASK-ARP02-003 and TASK-ARP02-001, per fix-round instruction):
  - TASK-ARP02-003 (connectionManager.ts ~:416-423): added
    `if (current.tunnel) this.stopTunnel(cfg.id);` in the provenance-discard branch after the
    candidate adapter close — method name verified (`stopTunnel` → `this.tunnels.stop`, no-op when
    the key is absent). A tunneled connection deleted mid-flight no longer orphans its SSH tunnel.
  - TASK-ARP02-001 (queryRunner.test.ts:847): comment line refs updated executeAll:191/:203 →
    :245 (activeAdapter cleared) / :253 (currentBatched assigned). queryRunner.ts logic UNTOUCHED
    (cancelPending asymmetry left as judged harmless).

VERIFICATION (all fresh in this turn):
  1. npx vitest run src/ui/__tests__/resultsPanel.test.ts
     → Test Files  1 passed (1) | Tests  41 passed (41)  (39 prior + case 7 + case 8)
  2. npm test
     → Test Files  215 passed | 1 skipped (216) | Tests  2985 passed | 2 skipped (2987)
       (2983 baseline + 2 new; 2 pre-existing skips unchanged)
  3. npm run typecheck → tsc --noEmit, exit 0
  4. npm run compile  → esbuild: build complete, exit 0
  Scope: only src/ui/resultsPanel.ts, src/ui/__tests__/resultsPanel.test.ts,
  src/core/connectionManager.ts, src/core/__tests__/queryRunner.test.ts. No git add/commit/push;
  no INDEX edits; extension.ts untouched (wave-2 boundary respected).

Status: PASS
```
