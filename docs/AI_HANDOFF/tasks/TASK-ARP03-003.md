# TASK-ARP03-003 — Panel state: limited statements ride the wire without an error toast

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (ARP-03.3)

## Goal

Make the panel honor the runner's `resultLimited` marker. The limit must be surfaced to the webview on the
`state` wire post (so it renders distinct copy — TASK-ARP03-004) and must NOT be presented as an error: the
"Load more failed" toast is suppressed for a limited statement, mirroring the existing cancel-suppression
branch. Because the runner's budget close sets `cursorClosed`, a stale/defensive throw that slips past the
runner's graceful no-op must also be swallowed in the panel for a limited statement.

The panel ALSO owns the save-refresh leak pin: `handleSaveEdits` (`src/ui/resultsPanel.ts:1242`) and
`refreshManualStatement` (`:674`) build the refreshed statement as `{ ...r, result, batched, durationMs }`.
For a limited statement 002 sets BOTH `r.resultLimited = true` AND `r.cursorClosed = true`; the `...r`
spread copies both onto a statement whose cursor is NEW and open. After `adopt()` installs it, a later
`loadMore` hits the runner's new limited-entry guard and silently no-ops (gate closed on a healthy cursor),
and `cursorClosed=true` excludes the fresh cursor from `run()`'s stale-cursor sweep
(`src/core/queryRunner.ts:177-187`), pinning the max=1 pool client. Both save/refresh paths MUST strip
`resultLimited` and `cursorClosed` from the spread so the fresh cursor stays reachable. `handleRequery`
(`:1880`) builds `newStmt` WITHOUT `...r` (fresh object), so requery naturally clears the markers — do not
change it.

RED cases (fail on base `main @ f17cc6f`):
1. A done statement carrying `resultLimited: true` → every `state` post carries it (sanitize must not drop it).
2. `runner.loadMore` rejects while the statement is `resultLimited` → NO "Load more failed" toast
   (unit-level, defensive — see case 2 note).
3. A genuine loadMore error on a NON-limited statement still toasts (regression pin — GREEN on base).
4. Save/refresh of a limited statement → the refreshed statement in the `state` post has `resultLimited`
   and `cursorClosed` stripped (leak pin — RED on base: the `{ ...r }` spread copies both).

Deliverable: panel-side suppression of the error toast for limited statements + a pin that `resultLimited`
survives `sanitizeStatementResult` on the wire + the save-refresh marker-strip (case 4).

## Target Files

- `src/ui/resultsPanel.ts` — only. Do NOT touch `src/core/queryRunner.ts` (TASK-ARP03-002),
  `src/ui/messages.ts`, or `src/ui/resultsGridModel.ts` (see Discussion). The `resultLimited` field is
  ADDITIVE on `StatementResult` (produced by TASK-ARP03-002) — the panel only reads it.
- `src/ui/__tests__/resultsPanel.test.ts` — ADD cases; keep all existing blocks intact.

## Test Cases (REQUIRED — TDD)

RED-first: write cases 1, 2 and 4 FIRST, run them, paste the RED output (expect: toast fires / field
missing / markers leak), then implement. Case 3 is expected GREEN on base (regression pin).

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | limited statement rides the wire | render a done statement `{ status: "done", resultLimited: true, result: { rows, rowCount } }` → every `state` post has `results[0].resultLimited === true` (survives `sanitizeStatementResult`); `showErrorMessage` NOT called during render. **RED on base** (resultLimited dropped by the fixture since the field is new / no sanitize guarantee) | `makeRunnerStub`-style runner; a done `StatementResult` with `resultLimited: true`; `waitForPostMessage` helper |
| 2 | edge (unit-level, defensive) | loadMore rejection on a limited statement is silent at the panel boundary | `runner.loadMore(0)` rejects (`cursor closed`) while `lastResults[0].resultLimited === true` → **no** `showErrorMessage` call (limited branch mirrors the cancel branch at `src/ui/resultsPanel.ts:760-778`); a `state` post reposts `lastResults`. Label the test as DEFENSIVE/UNIT-LEVEL: the real runner's limited-entry guard makes `loadMore` a no-throw no-op, so this branch is reachable ONLY through a synthetic rejecting stub at the panel boundary — it pins the panel's own suppression code, not a runner path. **RED on base** (today the toast fires — no `resultLimited` check) | `makeRunnerStub` with `loadMore` rejecting; pre-populate `lastResults[0].resultLimited = true`; spy `vscode.window.showErrorMessage` |
| 3 | edge (regression pin) | genuine loadMore error on a non-limited statement still toasts | `runner.loadMore(0)` rejects with `connection refused`, `resultLimited` absent → "Load more failed: connection refused" toast fires exactly once. **GREEN on base** (pin) | `makeRunnerStub` with `loadMore` rejecting; no `resultLimited` |
| 4 | edge (leak pin) | save/refresh of a limited statement clears the markers | render a limited statement `{ status: "done", batched: true, resultLimited: true, cursorClosed: true, result: {...} }`; drive the refresh path so `handleSaveEdits`'s auto-refresh (`:1242-1250`, simplest) or `refreshManualStatement` (`:674-679`) builds the new statement (stub `runner.runSql` to resolve a FRESH non-limited `StatementResult` with `batched: <newBatched>`) → the LAST `state` post's `results[0]` has `resultLimited` absent/falsy AND `cursorClosed` absent/falsy; a following `{ type: "loadMore" }` dispatch reaches the runner stub (fresh cursor is not gated). **RED on base**: the `{ ...r }` spread carries `resultLimited: true` / `cursorClosed: true` onto the fresh cursor | AUTO path (preferred): non-manual default — dispatch `{ type: "saveEdits", ... }` with the case-7/8 `saveContext` stub (`getDriver: "mysql"`, `listPkColumns` resolving), `runSql` stubbed to return a fresh non-limited result; the auto-refresh runs inside `handleSaveEdits` (`:1234-1250`). ALTERNATIVE: manual-commit flow precedent at `:1449-1496` (stub `beginTransaction` + `transaction.commit` + `runSql`; dispatch `saveEdits` then `commitTransaction` — `refreshManualStatement` needs `manualStatementIndex` set at `:1161`). Assert the LAST `state` post, not intermediate ones |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` — ADD cases 1-4. Reuse `makeRunnerStub()` (`:87-92`), the
  `FakeWebview`/`FakeWebviewPanel` classes, and `waitForPostMessage`. For case 2, use a stub whose
  `loadMore` rejects and pre-set `lastResults` via an initial render with `resultLimited: true`. For case 4
  (leak pin), drive the save/refresh flow so the `{ ...r }` spread actually runs: pre-render a limited
  statement, stub `runner.runSql` to resolve a FRESH non-limited result, and trigger the refresh via the
  AUTO path — dispatch `{ type: "saveEdits", ... }` with the case-7/8 `saveContext` stub
  (`getDriver: () => "mysql"`, `listPkColumns` resolving) so the non-manual default auto-refresh runs
  inside `handleSaveEdits` (`:1234-1250`). `runSql` is called twice (save bundle `:1194`, refresh SELECT
  `:1234`) — a single mock returning a fresh non-limited result is fine. Fallback: the manual-commit flow
  precedent at `:1449-1496` (stub `beginTransaction` + `transaction.commit`; dispatch `saveEdits` then
  `commitTransaction`) reaches `refreshManualStatement` (`:674-679`), which needs `manualStatementIndex`
  set at `:1161`. Whichever trigger is used, the loaded assertion is unchanged: the LAST `state` post's
  refreshed statement has `resultLimited` and `cursorClosed` stripped, and a later `loadMore` reaches the
  runner stub.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
npm run compile
npm test
```

(Selection per RULES: `resultsPanel.ts` → `.cache/index/tests-map.json` maps to the resultsPanel suite —
the focused run above pins the primary file. **Full `npm test` is the mandated release-boundary net for at
least one task in this cycle — this is that task.** No lint script; typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: cases 1, 2 and 4 fail on base `f17cc6f` BEFORE implementation; case 3 GREEN
      on base.
- [ ] Case 1 GREEN: `resultLimited` rides every `state` post for a limited statement; no render-time error.
- [ ] Case 2 GREEN (unit-level, defensive): "Load more failed" toast suppressed for a limited statement
      against a synthetic rejecting stub; stale state reposted. Labeled defensive — the real runner never
      rejects for a limited statement.
- [ ] Case 3 GREEN unchanged (non-limited errors still toast).
- [ ] Case 4 GREEN (leak pin): after a save/refresh of a limited statement, the refreshed statement in the
      `state` post has `resultLimited` and `cursorClosed` stripped, and a following `loadMore` dispatch
      reaches the runner stub (fresh cursor not gated).
- [ ] Full `npm test` exit 0 (release-boundary net).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] No change to `queryRunner.ts`, `messages.ts`, or `resultsGridModel.ts` (disjoint ownership).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `TASK-ARP03-002` (wave 3 — consumes the `resultLimited` field and the runner's graceful no-op behavior;
  must NOT start before 002 is approved).

## Interfaces

- Consumes:
  - `StatementResult.resultLimited?: boolean` — produced by `QueryRunner` (TASK-ARP03-002).
  - `QueryRunner.loadMore(index: number): Promise<StatementResult[]>` — `src/core/queryRunner.ts:341`.
  - `sanitizeStatementResult(r: StatementResult): StatementResult` — `src/ui/resultsPanel.ts:2152` (spread;
    top-level `resultLimited` passes through automatically).
  - `WebviewMessage` `"loadMore"` — `src/ui/messages.ts`.
- Produces: no new public API. Panel behavior only:
  - The loadMore catch branch (`:760-778`) treats `lastResults[msg.index]?.resultLimited === true` like the
    existing cancelled branch — swallow, no toast, re-post `lastResults` as `state`.
  - The save/refresh paths MUST strip the markers from the `{ ...r }` spread — both `refreshManualStatement`
    (`:674-679`) and `handleSaveEdits`'s refresh (`:1242-1250`):
    ```ts
    const { resultLimited, cursorClosed, ...rest } = r;
    const newStmt: StatementResult = { ...rest, result: freshResult, batched: refreshed.batched, durationMs: Date.now() - start };
    ```
    Destructuring out both fields leaves them undefined on the fresh statement (`cursorClosed` falsy →
    `run()`'s stale sweep at `src/core/queryRunner.ts:177-187` will close the new cursor; `resultLimited`
    undefined → the runner's limited-entry guard won't gate a healthy cursor). Do NOT touch `handleRequery`
    (`:1880`) — it builds fresh without `...r` and already clears the markers.

## Discussion

- **Field placement.** `resultLimited` lives on `StatementResult` (top level), NOT on `r.result`, so
  `sanitizeStatementResult`'s spread at `:2157-2163` carries it through automatically. If the executor
  discovers a case where the field is nested, that is a bug to surface in the Executor Report — the wire
  contract for 03.4 is a top-level statement field mirroring the webview `StatementResult` type.
- **Stale-throw belt-and-braces (unit-level, defensive).** The runner (03.2) already returns a graceful
  no-op for a limited statement, so a rejection here is defensive/stale and reachable ONLY through a
  synthetic rejecting stub at the panel boundary — the test pins the panel's own suppression branch, not a
  runner path. Keep case 2 labeled as such. The panel suppression mirrors the cancel branch's existing
  `isCancelled?.() || /cancel/i` predicate at `:764-766`: read `resultLimited` from
  `lastResults[msg.index]` BEFORE the await overwrites it, and suppress the toast when set. Do NOT widen
  the cancel regex or the `isCancelled` path.
- **Save-refresh leak pin (case 4, why it is load-bearing).** 002 sets `resultLimited` AND `cursorClosed`
  together. The `{ ...r }` spreads in `handleSaveEdits` (`:1242`) and `refreshManualStatement` (`:674`)
  copy BOTH onto a statement whose cursor is NEW and open. Two silent failures follow: (a) the runner's
  limited-entry guard (`if (r.resultLimited) return this.results.slice()`) no-ops `loadMore` on a healthy
  cursor; (b) `cursorClosed = true` excludes the fresh cursor from `run()`'s stale-cursor sweep
  (`queryRunner.ts:177-187`), so it is never drained/closed and pins the Postgres max=1 pool client until
  `connectionTimeoutMillis`. `handleRequery` (`:1880`) builds fresh without `...r` and is the ONLY correct
  model — do not "fix" it. `handleSaveEdits` and `refreshManualStatement` both refresh via
  `this.runner.runSql(r.sql)` (`:1234` / `:671`), so stubbing `runSql` to resolve a fresh non-limited
  result is the shared seam for case 4.
- **Why not messages.ts / resultsGridModel.ts.** `StateMessage` already spreads `results` and the webview
  model reads `StatementResult` fields directly (TASK-ARP03-004 owns the model sync). Editing `messages.ts`
  or `resultsGridModel.ts` would collide with 03.4's wave (same-wave disjointness) for no benefit.
- (no comments yet)

---

## Executor Report

```
(write here: STATUS / EXECUTOR_TOOL / EXECUTOR_MODEL / EXECUTOR_SUBAGENT / RED_OUTPUT /
 IMPLEMENTATION SUMMARY / VERIFICATION OUTPUT / ISSUES / HANDOFF_TO_REVIEWER)
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
