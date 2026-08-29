# TASK-AH-002 — ResultsPanel append-aware render + editor run path threads {append:true}

- Status: `done`
- Owner: `unic-code`
- Reviewer: `main verification`
- Parent plan: `docs/AI_HANDOFF/PLAN_AH.md` §7 (Approach §3)

## Goal

Thread the editor run path through append mode: `runStatements` in extension.ts passes `{ append: true }` and renders with the pre-run array length as `appendBase`. `ResultsPanel.render()` gains an append-aware mode where per-statement caches (DISTINCT, column types, requery sources, table map) are invalidated ONLY for indices >= appendBase, so old tabs keep their caches. Load More rejections from closed cursors surface through the existing error path.

## Target Files

- `src/ui/resultsPanel.ts` — `render(results: StatementResult[], header: string, opts?: { appendBase?: number })` (extends :215); when `opts.appendBase` is a number >= 0: scope `distinctCache` / `columnTypesByStatement` / `whereByStatement` / `tableByStatement` pruning + `manualStatementIndex` reset + `statementGeneration` bump to indices >= appendBase (old-tab entries survive); without opts, byte-identical to today. `handleMessage` "loadMore" catch (:581-598) needs no code change — the AH-001 rejection message already flows to `showErrorMessage` + state repost; add test coverage pinning that surfacing.
- `src/extension.ts` — `runStatements` body ONLY (~:807-844): capture `const appendBase = runner.getResults().length` before the run; `runner.run(rewritten, onUpdate, { append: true })` at :832; `panel.render(results, header, { appendBase })` at :836. Nothing else in the file changes.
- `src/ui/__tests__/resultsPanel.test.ts` — EXTEND (append-render cases).
- `src/ui/__tests__/resultsPanelRequery.test.ts` — REGRESSION extend (requery-by-index on the accumulated array).
- `src/extension.test.ts` — EXTEND (editor path passes append; cursor-discipline context).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | runStatements threads append + render carries appendBase | editor Run with 2 statements → `QueryRunner.prototype.run` called with `{ append: true }` as 3rd arg; `panel.render` 2nd state post carries `appendBase` = pre-run length (0 on first run of the session) | vscode mock harness (existing `makeCtx` pattern, extension.test.ts:1693+) |
| 2 | unit | append render preserves old-tab caches | panel with cached distinct/where/columnTypes for index 0; `render(accumulated, header, {appendBase:1})` → index-0 cache entries still present; index >= 1 has no stale entries | resultsPanel.test.ts fixture: render once, populate caches via a distinct request, then append-render |
| 3 | edge (cache-scoping/boundary) | appendBase at array edge / beyond length | `appendBase === results.length` (no new tabs visible yet) → NO cache entry invalidated, generation NOT bumped; `appendBase` > length → no throw, treated as full-preserve | direct `render()` calls on a fresh panel |
| 4 | edge (error state) | statement error in run 2 keeps old tabs intact | run1 done; append run2 where stmt 2 of 2 rejects → `lastResults` still contains run-1 entries with original `result`/`rows`; run-2 stmt 1 done, stmt 2 `status==="error"` with `error` string; state reposted | adapter mock: runQuery resolves then rejects |
| 5 | edge (error-message kind) | loadMore on a closed-cursor tab surfaces the message once | post a `loadMore` for a `cursorClosed` entry → `showErrorMessage` called exactly once with message matching `/run this statement alone/`; a `state` message is reposted (in-flight flag cleared); `busy` returns to false | runner stub whose `loadMore` rejects with the AH-001 message |
| 6 | regression | requery-by-index lands on the right tab with the accumulated array | after append (2 runs × 2 stmts), post `requery` with `index: 2` (run-2 stmt-1) → requery SQL built from entry 2's table/where (assert against entry 0's — must differ); `adopt(2, ...)` swaps entry 2 only; existing resultsPanelRequery.test.ts assertions on indices stay green | accumulated `lastResults` fixture (2 runs) |
| 7 | regression | non-append callers unchanged | browse/retry/save-refresh `render()` calls without opts behave as today: existing suites in resultsPanel.test.ts / resultsPanelSaveEdits.test.ts / resultsPanelRetry.test.ts green unchanged | current suites at HEAD |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` — tests 1-5 (EXTEND).
- `src/ui/__tests__/resultsPanelRequery.test.ts` — test 6 (EXTEND).
- `src/extension.test.ts` — test 1 host-side assertions + regression context (EXTEND; follow the existing `runQueryFromEditor` describe blocks ~:1690+).
- `src/ui/__tests__/resultsPanelSaveEdits.test.ts`, `src/ui/__tests__/resultsPanelRetry.test.ts` — regression only (no edits expected; listed as the boundary net for test 7).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/extension.test.ts
npm run typecheck
npm test
npm run compile
```

(No lint script exists in this repo — `npm run typecheck` is the static gate. Full `npm test` here is the wave-boundary net for wave 2. Tests-map for src/ui/resultsPanel.ts lists all 7 resultsPanel suites — tests 1-7 select the 3 named + 2 boundary files, which is the resolved selection, not the full default.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for new cases, GREEN after; RED output pasted in Executor Report).
- [ ] `runStatements` is the ONLY changed region of extension.ts; `runner.run` 3rd arg `{ append: true }`; no other call site gains append.
- [ ] `render()` without opts is semantically identical to today (regressions 6-7 green).
- [ ] Old-tab caches (DISTINCT / column types / requery sources) survive an append render.
- [ ] No diff in `webview/main.ts`, `webview/styles.css`, `src/ui/messages.ts`, `src/adapters/**`, `src/ai/**`, `src/core/ddl/**`, `src/core/sqlFormat.ts`.
- [ ] `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.

## Dependencies

- TASK-AH-001 must complete first (consumes the `opts` param, `runNo`/`runStmtNo`/`cursorClosed` fields and the loadMore rejection message).

## Interfaces

- Consumes: `QueryRunner.run(statements: ParsedStatement[], onUpdate: (results: StatementResult[]) => void, opts?: { append?: boolean }): Promise<StatementResult[]>`; `StatementResult.cursorClosed?: boolean` + `loadMore(index)` rejecting with `/run this statement alone/` (all from TASK-AH-001); existing `ResultsPanel.render(results, header)` call sites.
- Produces: `ResultsPanel.render(results: StatementResult[], header: string, opts?: { appendBase?: number }): void` — AH-003 relies on the state message shape being UNCHANGED (`{ type:"state", header, results, busy }`, `src/ui/messages.ts:20-44`) and on `appendBase` being host-side only (never posted to the webview).

---

## Discussion

### 2026-08-28 · planner · unic-smart
extension.ts coordination: this file is also owned by pending cycle AF-004 (wave 3, not yet dispatched — AF is at wave 1/2 per RUN.md). This task's edit is confined to the `runStatements` body (:807-844); AF-004's planned console/format edits are disjoint regions. If AF-004 dispatches before this cycle completes, the wave-commit ordering per RUN.md resolves it — do not rebase AF-004's assumptions, they touch different hunks. Also note: the Console `onRun` (extension.ts:709) routes through this same `runStatements`, so console runs accumulate into the shared panel too — that is intentional (there is exactly one results panel) and within the user's "results panel" scope.

-> @reviewer: verify the extension.ts diff hunk is inside runStatements only.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecAH002
SUMMARY: Added append-aware ResultsPanel cache invalidation and threaded append mode plus pre-run base length through the editor run path. Added regression coverage for cache scoping, edge bases, editor wiring, and closed-cursor loadMore error surfacing.
TEST_PLAN_FOLLOWED: task §Test Cases (TDD)
FILES_CHANGED:
  - src/ui/resultsPanel.ts: added optional appendBase render mode with scoped cache/generation/manual-index handling.
  - src/extension.ts: runStatements now captures appendBase, passes { append: true }, and renders with appendBase.
  - src/ui/__tests__/resultsPanel.test.ts: added append cache, boundary, and closed-cursor loadMore tests.
  - src/extension.test.ts: added editor append threading/render-base test.
TESTS_ADDED:
  - src/ui/__tests__/resultsPanel.test.ts: closed-cursor loadMore surfaces the run-alone message once and reposts state; append-aware render cache and edge-base cases.
  - src/extension.test.ts: AH-002 editor run threads append mode and pre-run appendBase.
RED: confirmed — new panel tests initially failed 2 cases (appendBase unsupported/wholesale cache behavior); editor test initially failed because runner.run lacked the third append options argument. Closed-cursor regression passed against the existing error path.
VERIFICATION:
  command: npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/extension.test.ts
  result: 115 pass, 0 fail
  output_excerpt: |
    Test Files 3 passed (3)
    Tests 115 passed (115)
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > vsdb@1.13.0 typecheck
    > tsc --noEmit
  command: npm run compile
  result: exit 0
  output_excerpt: |
    > node esbuild.js
    dist/schemaForm.js 3.0kb
  command: npm test
  result: exit 0
  output_excerpt: |
    Full suite completed successfully; stderr contained only existing test diagnostics.
ISSUES: Existing ES2024 target warning from esbuild/Vitest and expected stderr diagnostics from existing tests; no task failures.
HANDOFF_TO_REVIEWER: no — no reviewer enablement is configured in the available handoff config; orchestrator may review separately.
NEXT: released in v1.13.0; main verification passed
