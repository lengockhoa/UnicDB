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
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

IMPLEMENTATION SUMMARY:
- src/ui/resultsPanel.ts (3 changes, panel only):
  1. loadMore catch branch: `resultLimited` is captured from
     `this.lastResults[msg.index]` BEFORE the await and suppresses the
     "Load more failed" toast in the catch (`!cancelled && !limited && !stale`),
     mirroring the existing cancel branch. Stale `lastResults` still re-post
     as `state`. Cancel regex / isCancelled path untouched.
  2. refreshManualStatement: `const { resultLimited, cursorClosed, ...rest } = r;`
     then `{ ...rest, result, batched, durationMs }` — markers stripped from
     the fresh statement (leak pin).
  3. handleSaveEdits auto-refresh: same destructure-strip before building
     `newStmt` (leak pin). handleRequery untouched (fresh object, already
     correct per plan).
- No changes to queryRunner.ts, resultBatcher.ts, messages.ts, resultsGridModel.ts,
  webview/ — verified via `git status` (only the 2 owned files modified).
- No git add/commit/push performed.

RED_OUTPUT (first run, before implementation — `npx vitest run src/ui/__tests__/resultsPanel.test.ts`):
 ❯ src/ui/__tests__/resultsPanel.test.ts  (45 tests | 2 failed) 276ms
   ❯ ... > ARP03-003 #2 (DEFENSIVE/UNIT-LEVEL) — loadMore rejection on a limited statement is silent at the panel boundary, stale state reposted
     → expected [ Array(1) ] to have a length of +0 but got 1
   ❯ ... > ARP03-003 #4 (leak pin) — save/refresh of a limited statement strips resultLimited + cursorClosed from the fresh statement; a later loadMore reaches the runner
     → expected true to be falsy
 ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL ... #2 — AssertionError: expected [ Array(1) ] to have a length of +0 but got 1
   ❯ src/ui/__tests__/resultsPanel.test.ts:1658:38
     1658|     expect(showErrMock().mock.calls).toHaveLength(0);
 FAIL ... #4 — AssertionError: expected true to be falsy
   ❯ src/ui/__tests__/resultsPanel.test.ts:1767:34
     1767|     expect(posted.resultLimited).toBeFalsy();
 Test Files  1 failed (1)
      Tests  2 failed | 43 passed (45)

RED DEVIATION (case 1): #1 was GREEN on base, not RED as the task table
predicted ("resultLimited dropped by the fixture"). The Discussion section's
own analysis is why: `sanitizeStatementResult` is a plain `{ ...r }` spread,
so a top-level additive field passes through on base automatically — there is
no code path on base that strips it, so no honest test of that shape can fail
on base. #1 is kept as the wire pin for 03.4 (asserts resultLimited survives
sanitize on the render post AND a later "ready" re-post, with no render-time
error). The two behavior-changing cases this task owns (#2 toast fires on
base; #4 markers leak via the { ...r } spread) were both RED as required; #3
was GREEN on base as pinned.

VERIFICATION OUTPUT (all inside the worktree, compile run before npm test
per fresh-worktree note):
1. `npx vitest run src/ui/__tests__/resultsPanel.test.ts`
   → " ✓ src/ui/__tests__/resultsPanel.test.ts  (45 tests) 259ms
      Test Files  1 passed (1)
      Tests  45 passed (45)" — exit 0
2. `npm run compile`  (run before npm test; fresh worktree had no dist/)
   → "esbuild: build complete" — exit 0
3. `npm run typecheck`
   → "tsc --noEmit" clean, no output — exit 0
4. `npm test` (release-boundary net, this task)
   → " Test Files  215 passed | 1 skipped (216)
      Tests  2999 passed | 2 skipped (3001)" — exit 0

ISSUES: none.
HANDOFF_TO_REVIEWER: yes — set pending_review; reviewer model must differ
from unic-code per handoff.reviewer config.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```

## Reviewer Report

REVIEWER_MODEL: unic-smart
ROUND: 1
VERDICT: approved_minor
Findings:
- leak pin closed in production, not just by the test: both `{ ...r }` save/refresh sites now destructure the markers out — `refreshManualStatement` (src/ui/resultsPanel.ts:681) and `handleSaveEdits` auto-refresh (src/ui/resultsPanel.ts:1265) use `const { resultLimited, cursorClosed, ...rest } = r` before building the fresh statement; `handleRequery` (:1904-1911) is untouched and already builds fresh without `...r`. Confirmed against runner mechanics: `loadMoreImpl`'s limited-entry guard (src/core/queryRunner.ts:397-399) no-ops on a leaked `resultLimited`, and `run()`'s stale-cursor sweep (:201-203) excludes a leaked `cursorClosed` from draining the max=1 pool client — both are now closed.
- no false persistence: `render()` replaces `this.lastResults` wholesale (:320); the marker lives only on genuinely limited runner results; save/refresh strips it; requery builds a fresh object. A fresh query cannot inherit the limited gate.
- toast suppression scope correct: `limited` is captured pre-await from `this.lastResults[msg.index]?.resultLimited === true` (:764); the runner's guard makes a limited statement a no-throw no-op, so the suppressed rejection is only reachable via a synthetic stub — real errors on non-limited statements still toast (case 3 pins exactly-once). Stale `lastResults` (retained rows + marker) are re-posted as `state` in the catch (:788-795), so the user keeps seeing the retained rows.
- RED evidence authentic: the pasted RED_OUTPUT line numbers match the current test file exactly — case #2 assertion `expect(showErrMock().mock.calls).toHaveLength(0)` at resultsPanel.test.ts:1658, case #4 `expect(posted.resultLimited).toBeFalsy()` at :1767. Both failures are the genuine base defects (toast fired when it must be silent; marker leaked across the save-refresh spread).
- case #1 GREEN-on-base deviation is acceptable: PLAN.md's own Discussion documents that `sanitizeStatementResult` is a plain `{ ...r }` spread (:2176-2189), so a top-level additive field passes through on base — an honest test of that shape cannot be RED. The executor kept it as a wire pin (render + ready re-post + no render-time error), the same treatment as regression pin #3. The two behavior-changing cases (#2, #4) were RED-proven, and the plan-review-mandated leak pin is the load-bearing requirement and was RED on base.
- verification rerun (fresh, worktree): `npx vitest run src/ui/__tests__/resultsPanel.test.ts` → 45/45 PASS; `npm run typecheck` → exit 0; `npm run compile` → exit 0; `npm test` (release-boundary net) → 216 files passed | 1 skipped, 3005 passed | 2 skipped, exit 0.
- model isolation: EXECUTOR_MODEL=unic-code (self-reported), REVIEWER_MODEL=unic-smart, config handoff.reviewer.model=unic-smart — differs from executor, check satisfied.
- minor (non-blocking): the manual-commit refresh path's strip (`refreshManualStatement` :681) is not directly pinned by a new test — case 4 drives only the AUTO path (`handleSaveEdits` :1265). The manual-site fix is present and symmetric, and the plan allowed either trigger, but a future regression at :681 alone would not be caught by this suite. Add a manual-flow variant (stub `beginTransaction`/`transaction.commit` per the :1449-1496 precedent) if the cycle allows; not required for this handoff.
- minor (non-blocking): executor's reported full-suite count (215 files / 2999 tests) differs from the fresh rerun (216 / 3005) — the +6 tests are ARP03-004's `webviewResultLimit.test.ts`, present in the same wave commit; the authoritative fresh run passes, so this is a reporting artifact only.
