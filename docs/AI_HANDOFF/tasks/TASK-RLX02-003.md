# TASK-RLX02-003 — Surface cross-dialect cancellation through runner and panel

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_RLX02.md` §1–§3

## Goal

Make the MySQL and SQL Server seams observable end-to-end in the existing runner, `vsdb.cancelQuery` command, and ResultsPanel state flow. Cancellation must wait for best-effort adapter cleanup, reach a terminal `cancelled` result when work was in flight, clear busy state, and never turn a late cancel into a UI error.

## Target Files

- `src/core/queryRunner.ts` — preserve the RLX-01 active-adapter window and terminal cancellation gate while exercising the now-implemented dialect seams; adjust only if source tests expose a runner lifecycle gap.
- `src/core/__tests__/queryRunner.test.ts` — add dialect-shaped deferred adapter seam tests covering in-flight cancel, post-settlement no-op, and `BatchedQuery.cancel()` exclusivity.
- `src/ui/resultsPanel.ts` — preserve/strengthen the awaited `runner.cancel()` then busy-clear/message-state flow if the focused panel test exposes a lifecycle gap.
- `src/ui/__tests__/resultsPanel.test.ts` — test the webview `"cancel"` message waits for the cancellation promise, clears busy, and produces no late UI error.
- `src/extension.ts` — make `vsdb.cancelQuery` await `runner.cancel()` before `panel.setBusy(false)` so command-path busy cleanup cannot outrun adapter cleanup.
- `src/extension.test.ts` — extend the existing command-registration fixture to assert the command’s await ordering and terminal panel state behavior.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | `cancelled MySQL/MSSQL-shaped active run ends cancelled before command busy false` | A deferred adapter with `cancelActiveQuery()` resolves only after its cleanup signal; `vsdb.cancelQuery` does not call `panel.setBusy(false)` until that signal resolves, and the associated runner result is exactly `status: "cancelled"`. | Extension command capture plus real/deferred `QueryRunner` adapter fixture. |
| 2 | edge — post-settlement ordering | `late cancel preserves done state and emits no cancellation UI error` | After `QueryRunner.run(...)` has settled `done`, a command or panel cancel calls no seam, result stays `done`, and `showErrorMessage` receives no `VSDB:`, `Load more failed:`, or `VSDB requery failed:` cancellation message. | Immediate successful non-batched adapter and ResultsPanel fake webview. |
| 3 | edge — cursor exclusivity | `active BatchedQuery owns cancellation rather than adapter seam` | While initial `fetchBatch()` is deferred, `BatchedQuery.cancel()` and `close()` are called once; an available `cancelActiveQuery()` spy is never called and final status is `cancelled`. | Existing `makeBatched` deferred-fetch fixture. |
| 4 | edge — deferred webview cancellation | `webview cancel keeps busy until runner cancellation settles` | Dispatching `{ type: "cancel" }` calls `runner.cancel()` exactly once; while its controllable promise is pending, the panel remains busy and posts no `busy: false` state; only after it resolves does the panel clear/post `busy: false`, with no error notification. | ResultsPanel fake webview with an in-flight busy state and a `runner.cancel()` deferred promise. |
| 5 | regression | `existing provider-race and panel load-more silent-cancel behavior remain green` | Cancel before adapter-provider resolution still calls neither `runQuery` nor the late adapter seam; a load-more cancellation still re-posts state/busy false without a `Load more failed:` toast. | Existing RLX-01 QueryRunner and ResultsPanel fixtures. |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` — runner terminal status, provider race, and cursor-seam exclusivity.
- `src/ui/__tests__/resultsPanel.test.ts` — webview cancel/busy/error-suppression behavior.
- `src/extension.test.ts` — `vsdb.cancelQuery` command awaiting/ordering behavior.

## Verification Commands

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts src/ui/__tests__/resultsPanel.test.ts src/extension.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] `QueryRunner.cancel(): Promise<void>` keeps `BatchedQuery.cancel(): Promise<void>` exclusive whenever `currentBatched` exists and invokes `activeAdapter.cancelActiveQuery?.()` only during the live non-batched `runQuery` window.
- [ ] An in-flight cancel settles as `StatementResult.status === "cancelled"`; post-settlement cancel does not call the seam and preserves `status === "done"`.
- [ ] The `vsdb.cancelQuery` command awaits `runner.cancel()` before `panel.setBusy(false)`.
- [ ] ResultsPanel’s `"cancel"` message path clears busy after awaiting runner cancellation, posts/re-posts terminal state through the existing flow, and suppresses late cancellation errors.
- [ ] Focused verification commands pass and reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-RLX02-001
- TASK-RLX02-002

## Interfaces

- Consumes: `MySqlAdapter.cancelActiveQuery(): Promise<void>` from TASK-RLX02-001; `MsSqlAdapter.cancelActiveQuery(): Promise<void>` from TASK-RLX02-002; `QueryRunner.run(statements: ParsedStatement[], onUpdate: (results: StatementResult[]) => void, opts?: { append?: boolean }): Promise<StatementResult[]>`, `QueryRunner.cancel(): Promise<void>`, and `QueryRunner.isCancelled(): boolean` from `src/core/queryRunner.ts`; `ResultsPanel.setBusy(busy: boolean): void` and `ResultsPanel.render(results: StatementResult[], header: string, opts?: { appendBase?: number }): void` from `src/ui/resultsPanel.ts`.
- Produces: awaited `vsdb.cancelQuery` command cleanup and an end-to-end terminal-state contract: an in-flight non-cursor run cancelled through an available dialect seam yields `StatementResult.status === "cancelled"`; a late cancel is a no-op with no UI error.

---

## Discussion

### 2026-09-01 · planner · unic-smart
The runner’s released seam/window already exists; this task must not redesign it or add `operationId`/`AbortSignal`. Source review identified a concrete command-path ordering defect: `src/extension.ts` currently fire-and-forgets `runner.cancel()` then clears busy immediately. Await cancellation so the visible lifecycle does not claim completion before adapter cleanup. Preserve ResultsPanel’s established silent cancel treatment.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/core/__tests__/queryRunner.test.ts src/ui/__tests__/resultsPanel.test.ts src/extension.test.ts
  (before the src/extension.ts fix)

   ❯ src/extension.test.ts  (82 tests | 2 failed) 466ms
     ❯ TASK-RLX02-003 — vsdb.cancelQuery awaits runner.cancel before setBusy(false) > Test #1 — deferred seam: panel.setBusy(false) only fires AFTER runner.cancel settles
       → expected [ [ false ] ] to have a length of +0 but got 1
   ⎯⎯⎯⎯⎯⎯⎯⎯
   FAIL  src/extension.test.ts > TASK-RLX02-003 … > Test #1 — deferred seam
   AssertionError: expected [ [ false ] ] to have a length of +0 but got 1
    ❯ src/extension.test.ts:2713:35
       2711|       (c) => c[0] === false,
       2712|     );
       2713|     expect(busyFalseDuringCancel).toHaveLength(0);
          |                                   ^
   ⎯⎯⎯⎯⎯⎯⎯⎯
   FAIL  src/extension.test.ts > TASK-003 — vsdb.createSchema extension wiring > npm run compile emits dist/schemaForm.js (esbuild config wired)
     → expected false to be true   (PRE-EXISTING, environmental: worktree had no dist/ until `npm run compile`; passes in the final GREEN run below)
   ⎯⎯⎯⎯⎯⎯⎯⎯
   Test Files  1 failed | 2 passed (3)
   Tests  2 failed | 145 passed (147)

  Notes on the other new tests:
  - queryRunner "Test #3b — cancel awaits an in-flight seam and settles
    status=cancelled" and resultsPanel "Test #4 — deferred webview cancel
    keeps busy:true until runner.cancel() settles" / "Test #2 —
    post-settlement cancel preserves done state" passed immediately on first
    run: the runner (RLX-01 activeAdapter window + awaited seam) and the
    panel ("cancel" case already awaits runner.cancel() then setBusy(false),
    silent-cancel suppression) ALREADY implement the contract. Per Target
    Files these act as regression locks ("adjust only if source tests expose
    a runner lifecycle gap" — none exposed). The genuinely RED test was the
    extension command path, matching the planner's Discussion finding.
Verification Output: |
  1) npx vitest run src/core/__tests__/queryRunner.test.ts src/ui/__tests__/resultsPanel.test.ts src/extension.test.ts
     ✓ src/core/__tests__/queryRunner.test.ts  (32 tests) 148ms
     ✓ src/ui/__tests__/resultsPanel.test.ts  (33 tests) 49ms
     ✓ src/extension.test.ts  (82 tests) 506ms
     Test Files  3 passed (3)
          Tests  147 passed (147)
     Start at  10:55:19 — Duration  1.35s
  2) npm run typecheck
     > vsdb@1.30.0 typecheck
     > tsc --noEmit
     (exit 0, no output)
  3) npm run compile
     dist/extension.js 5.2mb / dist/webview.js 2.2mb / dist/newTableForm.js /
     dist/connectionForm.js / dist/aiChatPanel.js …
     esbuild: build complete  (exit 0)
  Note: no lint script exists in package.json (as the task states).
Status: PASS
Note: The only production change is src/extension.ts `vsdb.cancelQuery` now
  awaiting runner.cancel() before panel.setBusy(false). Runner + panel seams
  were already correct from RLX-01/RLX02-001/002 — their new tests are
  regression locks only. Test-case #1's "MySQL/MSSQL-shaped" requirement is
  covered via the dialect-agnostic `cancelActiveQuery` seam shape (the same
  optional DbAdapter method both wave-1 adapters implement); the
  provider-race regression (test-case #5) stays green via existing
  "Test #2 — edge / race" and the loadMore silent-cancel panel tests. No
  git add/commit performed; dist/ artifacts from `npm run compile` remain
  untracked in the worktree.

