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

(pending)
