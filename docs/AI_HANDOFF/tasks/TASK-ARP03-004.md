# TASK-ARP03-004 — Webview UX: distinct truncated state + Load More gate closes

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (ARP-03.4)

## Goal

Make the webview render a distinct, accessible truncated state for a `resultLimited` statement and close
its Load More gate. The truncation must be distinguishable from empty / EOF / cancel: the footer shows
dedicated copy (composed in `updateFooter`, since `footerText` lives in `resultsGridModel.ts` which is out
of scope), and the grid model's `hasMore` is forced false so neither the scroll trigger
(`onBodyScroll`, `webview/main.ts:2450`) nor the `__vsdbCheckLoadMoreForHost` hook (`:2121-2127`) posts a
`loadMore` again — even when `rowCount` is `null` (no total), which is the load-bearing case the flag must
close.

**Precedence (review finding 3).** `updateFooter` (`:3248-3267`) composes `footerText(loaded, total, ...) +
transactionOpen + duration`. For a limited statement 002 keeps `rowCount = rows.length`, so `footerText`'s
`total != null` branch (`resultsGridModel.ts:414-416`) would render "10000 of 10000" — the truncation copy
must WIN OVER that output entirely. `updateFooter` short-circuits on `r.resultLimited` BEFORE calling
`footerText(...)`: when set, the footer is the truncation copy alone (never appended onto a count).

RED cases (fail on base `main @ f17cc6f`):
1. `state` with `{ batched: true, resultLimited: true, rowCount: 20, rows: 20 }` → footer shows the
   truncation copy and NO `\d+ of \d+` total; `.vsdb-error` absent.
2. The same limited statement with `rowCount: null` → `__vsdbCheckLoadMoreForHost` posts NO `loadMore`.
3. Distinctness: EOF, empty, and cancelled each keep their existing copy (regression pins — GREEN on base).
   Cancelled is re-anchored: a cancelled statement has no `result`, so NO footer renders — assert the
   truncation marker is absent and the cancelled tab badge `⌀` / `.vsdb-msg-cancelled` card is present.

Deliverable: `resultLimited?: boolean` on the webview `StatementResult` mirror, `hasMore` forced off at the
model sync for limited statements, and a dedicated footer truncation marker that REPLACES `footerText`'s
output.

## Target Files

- `webview/main.ts` — only. Do NOT touch `src/ui/resultsGridModel.ts`, `src/ui/messages.ts`, or
  `src/core/queryRunner.ts` (disjoint ownership; `footerText`/`footerText`-adjacent logic stays untouched).
- `src/ui/__tests__/webviewResultLimit.test.ts` — NEW bundle test (jsdom + `dist/webview.js`), following
  the `webviewBundle.test.ts` convention. Do NOT edit `webviewBundle.test.ts`.

## Test Cases (REQUIRED — TDD)

RED-first: write cases 1-2 FIRST, run them, paste the RED output (expect: footer shows "20 of 20" with no
truncation marker / `loadMore` posted for the limited statement), then implement. Case 3 cases are expected
GREEN on base.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | limited state shows truncation copy that REPLACES footerText (precedence) | `dispatchState` a done statement `{ status: "done", batched: true, resultLimited: true, result: { columns, rows: 20 rows, rowCount: 20, durationMs: 5 } }` → `.vsdb-grid-footer` textContent contains the truncation marker (e.g. "truncated"/"limit") and does NOT match `/\d+ of \d+/` (no "20 of 20" — `updateFooter` short-circuits on `resultLimited` before `footerText`'s total branch); `.vsdb-error` element absent. **RED on base** (footer = "20 of 20", no marker) | harness `loadBundle()` + `dispatchState` + `selectState` from `webviewBundle.test.ts` pattern; query `.vsdb-grid-footer` in `root` |
| 2 | edge: gate | limited statement never posts loadMore (rowCount: null) | a limited state with `rowCount: null` (total unknown — `resultsGridModel.ts:325` EOF branch cannot close `hasMore`, so ONLY `resultLimited` closes the gate in this shape), then `window.__vsdbCheckLoadMoreForHost()` → NO `loadMore` message in `received`. **RED on base** (`hasMore` stays true when `rowCount` null → `loadMore` posted) | dispatch `{ batched: true, resultLimited: true, result: { columns, rows: 20 rows, rowCount: null, durationMs: 5 } }`; assert `received` has no `{ type: "loadMore" }` |
| 3 | edge | distinct from EOF | done statement `{ batched: false, result: { rowCount: 20 } }` (EOF) → footer is plain footerText output ("N rows" / "N of N"), NOT the truncation marker | selectState; EOF-shaped result |
| 4 | edge | distinct from empty | empty `results` → `.vsdb-empty` "No results yet." placeholder, truncation marker absent | `selectState({ results: [] })` |
| 5 | edge | distinct from cancel (re-anchored — no footer exists) | cancelled statement `{ status: "cancelled" }` has NO `result` → `renderGrid` returns early (`webview/main.ts:1634-1640`) and `updateFooterNow` blanks the footer (`:3274-3277`). Assert: truncation marker appears NOWHERE, AND the cancelled tab badge `⌀` renders (`tabBadge` `:1089`; `.vsdb-tab.vsdb-tab-cancelled` class at `:1120`) — or `selectTab` to messages and assert `.vsdb-msg-card.vsdb-msg-cancelled` with `Statement 1 — CANCELLED` (`:3296-3300`). **GREEN on base** (pin) | `selectState` with a cancelled-shaped result (no `result` field) |
| 6 | edge: gate regression | non-limited streaming still load-mores | done statement `{ batched: true, resultLimited: false, result: { rows: 20 rows, rowCount: null } }` → `__vsdbCheckLoadMoreForHost` posts a `loadMore` message (streaming unchanged). **GREEN on base** (pin) | same harness; assert `received` contains `{ type: "loadMore", index }` |

## Test Files

- `src/ui/__tests__/webviewResultLimit.test.ts` — NEW file: `@vitest-environment jsdom`; stub
  `acquireVsCodeApi` + `ResizeObserver` + `matchMedia`; load `dist/webview.js` via `(0, eval)(bundleSrc)`;
  skip when `dist/webview.js` is missing (mirror `webviewBundle.test.ts` `describeIfBundle`); reuse the
  `buildRows`/`selectState`/`dispatchState`/`__vsdbCheckLoadMoreForHost` helpers. Must run AFTER
  `npm run compile`.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewResultLimit.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `webview/main.ts` has an EMPTY tests-map entry, so selection falls to the repo
convention — the `src/ui/__tests__/webview*.test.ts` bundle suite — and the new file is the pinned target.
`npm run compile` MUST precede the vitest run because the test loads `dist/webview.js`. No lint script;
typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: cases 1-2 fail on base `f17cc6f` BEFORE implementation; case 6 GREEN on base
      (pin); cases 3-5 GREEN (existing copy preserved).
- [ ] Case 1 GREEN: distinct truncation copy in `.vsdb-grid-footer` REPLACING the `N of N` total
      (asserted via no `/\d+ of \d+/` match); no `.vsdb-error`.
- [ ] Case 2 GREEN: limited statement never posts `loadMore` via the hook when `rowCount: null` — only
      `resultLimited` closes the gate in that shape.
- [ ] Cases 3-5 GREEN: EOF / empty keep their copy; cancelled renders NO footer (re-anchored to the `⌀`
      tab badge / `.vsdb-msg-cancelled` card) and no truncation marker anywhere (limit is its own state).
- [ ] Case 6 GREEN: non-limited streaming still load-mores (byte-for-byte prior behavior).
- [ ] `npm run typecheck` + `npm run compile` exit 0; the focused vitest run exits 0.
- [ ] Only `webview/main.ts` and the NEW test file modified — no `resultsGridModel.ts`/`messages.ts` change.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `TASK-ARP03-002` (wave 3 — consumes the `resultLimited` field produced by the runner and its graceful
  no-op contract; must NOT start before 002 is approved). Parallel with TASK-ARP03-003 (disjoint files).

## Interfaces

- Consumes:
  - `state` message results (`src/ui/messages.ts` shape): `StatementResult`-mirror objects.
  - `ResultsGridModel.sync(rows, index, hasMore, opts)` — `src/ui/resultsGridModel.ts:299` (third arg is
    the `hasMore` flag; caller is `webview/main.ts:1774`). `getState().hasMore()` gates the hook at `:2118`
    and the scroll trigger at `:2462`.
  - `updateFooter(footer, model, api, r)` — `webview/main.ts:3248` (owns the `.vsdb-grid-footer`
    textContent at `:3263-3266`).
- Produces (all inside `webview/main.ts`):
  ```ts
  // webview/main.ts — StatementResult mirror gains (additive, optional):
  //   resultLimited?: boolean;
  // model sync passes:  model.sync(r.result.rows, activeTab, !!r.batched && !r.resultLimited, {...})  // :1774
  // updateFooter REPLACES the footer text when r.resultLimited — short-circuit BEFORE footerText(...),
  // so the truncation copy wins over footerText's "N of N" total branch (resultsGridModel.ts:414-416):
  //   if (r.resultLimited) {
  //     footer.textContent = "result truncated — some rows were not loaded" + (duration suffix);
  //     return;
  //   }
  //   footer.textContent = footerText(loaded, total, hasMore, displayed, filtered) + ...  // unchanged
  ```
  No new public API; `dispatchLoadMore`/`postToHost`/message shapes unchanged.

## Discussion

- **Why the flag is load-bearing in the gate test.** The grid model's EOF-detection branch sets
  `hasMoreFlag = false` when `rowCount != null && incomingLen >= rowCount` (`resultsGridModel.ts:325`). A
  limited statement usually has `rowCount = rows.length`, which that branch already closes — so a naive
  test would pass without the flag. Case 2 uses `rowCount: null` (server returned no total) to prove the
  flag itself closes the gate; this mirrors a real limited run where the total was unknown.
- **Precedence (review finding 3) — truncation copy REPLACES footerText, never appends.** 002 keeps the
  limited statement's `rowCount = rows.length` (e.g. 10 000), so `footerText`'s `total != null` branch
  (`resultsGridModel.ts:414-416`) renders "10000 of 10000". `updateFooter` must short-circuit on
  `r.resultLimited` BEFORE composing `footerText(...)` (see Interfaces) — the truncation copy wins over
  the `N of N` output and over the plain `N rows` total-only copy. Case 1 uses `rowCount: 20` (total known,
  equal to loaded) specifically to prove this: without the short-circuit, the footer would read "20 of 20"
  with no marker.
- **Footer copy stays in the webview.** `footerText` lives in `resultsGridModel.ts`, which is OUT OF SCOPE
  (owned by no task this cycle; §7 forbids touching it). Compose the truncation marker in `updateFooter`
  by reading `r.resultLimited`. Pick exact copy that is clearly distinct from "N rows" and from the
  cancelled presentation; a suggested form is included above. Do NOT hardcode the numeric cap in the
  webview — read the flag, not the constant.
- **Cancel is re-anchored (review finding 2).** A cancelled statement has NO `result`, so `renderGrid`'s
  `!r.result` branch (`webview/main.ts:1634-1640`) returns early with `setCurrentStatement(null)` and
  `updateFooterNow` blanks the footer (`:3274-3277`). There is NO "existing cancelled copy" in the footer
  to assert against. Case 5 instead asserts the truncation marker appears nowhere AND the cancelled state
  renders its own distinct marker — the `⌀` tab badge (`tabBadge`, `:1089`; `.vsdb-tab-cancelled`, `:1120`)
  or the `.vsdb-msg-card.vsdb-msg-cancelled` card with `Statement 1 — CANCELLED` on the messages tab
  (`:3296-3300`).
- **Keep the webview mirror minimal.** `resultLimited?: boolean` is the only field to add to the
  `StatementResult` interface at `webview/main.ts:120-143`; do not replicate `RETAINED_ROW_CAP`.
- **Test robustness.** Build modest row arrays (≤ a few hundred) — the webview never reads the cap
  constant, so there is no need to construct 10k rows in jsdom. Assert on `received` messages and the
  `.vsdb-grid-footer`/`.vsdb-empty`/`.vsdb-error` elements.
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
