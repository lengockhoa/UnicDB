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
(`onBodyScroll`, `webview/main.ts:2450`) nor the `__UnicDBCheckLoadMoreForHost` hook (`:2121-2127`) posts a
`loadMore` again — even when `rowCount` is `null` (no total), which is the load-bearing case the flag must
close.

**Precedence (review finding 3).** `updateFooter` (`:3248-3267`) composes `footerText(loaded, total, ...) +
transactionOpen + duration`. For a limited statement 002 keeps `rowCount = rows.length`, so `footerText`'s
`total != null` branch (`resultsGridModel.ts:414-416`) would render "10000 of 10000" — the truncation copy
must WIN OVER that output entirely. `updateFooter` short-circuits on `r.resultLimited` BEFORE calling
`footerText(...)`: when set, the footer is the truncation copy alone (never appended onto a count).

RED cases (fail on base `main @ f17cc6f`):
1. `state` with `{ batched: true, resultLimited: true, rowCount: 20, rows: 20 }` → footer shows the
   truncation copy and NO `\d+ of \d+` total; `.UnicDB-error` absent.
2. The same limited statement with `rowCount: null` → `__UnicDBCheckLoadMoreForHost` posts NO `loadMore`.
3. Distinctness: EOF, empty, and cancelled each keep their existing copy (regression pins — GREEN on base).
   Cancelled is re-anchored: a cancelled statement has no `result`, so NO footer renders — assert the
   truncation marker is absent and the cancelled tab badge `⌀` / `.UnicDB-msg-cancelled` card is present.

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
| 1 | happy | limited state shows truncation copy that REPLACES footerText (precedence) | `dispatchState` a done statement `{ status: "done", batched: true, resultLimited: true, result: { columns, rows: 20 rows, rowCount: 20, durationMs: 5 } }` → `.UnicDB-grid-footer` textContent contains the truncation marker (e.g. "truncated"/"limit") and does NOT match `/\d+ of \d+/` (no "20 of 20" — `updateFooter` short-circuits on `resultLimited` before `footerText`'s total branch); `.UnicDB-error` element absent. **RED on base** (footer = "20 of 20", no marker) | harness `loadBundle()` + `dispatchState` + `selectState` from `webviewBundle.test.ts` pattern; query `.UnicDB-grid-footer` in `root` |
| 2 | edge: gate | limited statement never posts loadMore (rowCount: null) | a limited state with `rowCount: null` (total unknown — `resultsGridModel.ts:325` EOF branch cannot close `hasMore`, so ONLY `resultLimited` closes the gate in this shape), then `window.__UnicDBCheckLoadMoreForHost()` → NO `loadMore` message in `received`. **RED on base** (`hasMore` stays true when `rowCount` null → `loadMore` posted) | dispatch `{ batched: true, resultLimited: true, result: { columns, rows: 20 rows, rowCount: null, durationMs: 5 } }`; assert `received` has no `{ type: "loadMore" }` |
| 3 | edge | distinct from EOF | done statement `{ batched: false, result: { rowCount: 20 } }` (EOF) → footer is plain footerText output ("N rows" / "N of N"), NOT the truncation marker | selectState; EOF-shaped result |
| 4 | edge | distinct from empty | empty `results` → `.UnicDB-empty` "No results yet." placeholder, truncation marker absent | `selectState({ results: [] })` |
| 5 | edge | distinct from cancel (re-anchored — no footer exists) | cancelled statement `{ status: "cancelled" }` has NO `result` → `renderGrid` returns early (`webview/main.ts:1634-1640`) and `updateFooterNow` blanks the footer (`:3274-3277`). Assert: truncation marker appears NOWHERE, AND the cancelled tab badge `⌀` renders (`tabBadge` `:1089`; `.UnicDB-tab.UnicDB-tab-cancelled` class at `:1120`) — or `selectTab` to messages and assert `.UnicDB-msg-card.UnicDB-msg-cancelled` with `Statement 1 — CANCELLED` (`:3296-3300`). **GREEN on base** (pin) | `selectState` with a cancelled-shaped result (no `result` field) |
| 6 | edge: gate regression | non-limited streaming still load-mores | done statement `{ batched: true, resultLimited: false, result: { rows: 20 rows, rowCount: null } }` → `__UnicDBCheckLoadMoreForHost` posts a `loadMore` message (streaming unchanged). **GREEN on base** (pin) | same harness; assert `received` contains `{ type: "loadMore", index }` |

## Test Files

- `src/ui/__tests__/webviewResultLimit.test.ts` — NEW file: `@vitest-environment jsdom`; stub
  `acquireVsCodeApi` + `ResizeObserver` + `matchMedia`; load `dist/webview.js` via `(0, eval)(bundleSrc)`;
  skip when `dist/webview.js` is missing (mirror `webviewBundle.test.ts` `describeIfBundle`); reuse the
  `buildRows`/`selectState`/`dispatchState`/`__UnicDBCheckLoadMoreForHost` helpers. Must run AFTER
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
- [ ] Case 1 GREEN: distinct truncation copy in `.UnicDB-grid-footer` REPLACING the `N of N` total
      (asserted via no `/\d+ of \d+/` match); no `.UnicDB-error`.
- [ ] Case 2 GREEN: limited statement never posts `loadMore` via the hook when `rowCount: null` — only
      `resultLimited` closes the gate in that shape.
- [ ] Cases 3-5 GREEN: EOF / empty keep their copy; cancelled renders NO footer (re-anchored to the `⌀`
      tab badge / `.UnicDB-msg-cancelled` card) and no truncation marker anywhere (limit is its own state).
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
  - `updateFooter(footer, model, api, r)` — `webview/main.ts:3248` (owns the `.UnicDB-grid-footer`
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
  renders its own distinct marker — the `⌀` tab badge (`tabBadge`, `:1089`; `.UnicDB-tab-cancelled`, `:1120`)
  or the `.UnicDB-msg-card.UnicDB-msg-cancelled` card with `Statement 1 — CANCELLED` on the messages tab
  (`:3296-3300`).
- **Keep the webview mirror minimal.** `resultLimited?: boolean` is the only field to add to the
  `StatementResult` interface at `webview/main.ts:120-143`; do not replicate `RETAINED_ROW_CAP`.
- **Test robustness.** Build modest row arrays (≤ a few hundred) — the webview never reads the cap
  constant, so there is no need to construct 10k rows in jsdom. Assert on `received` messages and the
  `.UnicDB-grid-footer`/`.UnicDB-empty`/`.UnicDB-error` elements.
- (no comments yet)

---

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (base bundle, before webview/main.ts changes):
> npx vitest run src/ui/__tests__/webviewResultLimit.test.ts
 FAIL ... > 1. limited state shows truncation copy that REPLACES footerText (precedence)
   AssertionError: expected '20 of 20  ⏱ 5ms' to match /truncated/i
   - Expected: /truncated/i
   + Received: "20 of 20  ⏱ 5ms"
 FAIL ... > 2. limited statement never posts loadMore (rowCount: null — gate closed by flag)
   AssertionError: expected [ { type: 'loadMore', index: +0 } ] to have a length of +0 but got 1
 Test Files  1 failed (1) | Tests  2 failed | 4 passed (6)
→ exactly the predicted failures: footer "20 of 20" with no marker; loadMore posted
  despite resultLimited with rowCount null. Pins 3-6 GREEN on base as planned.

IMPLEMENTATION SUMMARY (webview/main.ts only):
- StatementResult mirror: added `resultLimited?: boolean` (additive, optional).
- renderGrid model sync (~:1774): `model.sync(..., !!r.batched && !r.resultLimited, ...)` —
  forces hasMore off for limited statements, closing the gate for both the
  onBodyScroll trigger and __UnicDBCheckLoadMoreForHost even when rowCount is null.
- updateFooter: short-circuits on `r.resultLimited` BEFORE footerText(...) — footer
  becomes "result truncated — some rows were not loaded" (+ transaction/duration
  suffixes), REPLACING footerText's "N of N" / "N rows" output entirely.
- No changes to resultsGridModel.ts / messages.ts / queryRunner.ts / resultsPanel.ts.

VERIFICATION OUTPUT (all in this worktree, current turn):
- npm run compile → "esbuild: build complete" (exit 0)
- npx vitest run src/ui/__tests__/webviewResultLimit.test.ts → Tests 6 passed (6)
- npm run typecheck → exit 0
- npm run compile (final) → exit 0
- Neighboring suites (webviewBundle, webviewEdit, webviewRequery, webviewRetry,
  webviewExport, webviewFilters, webviewToolbar, webviewTheme, webviewKeybinding,
  webviewPostCommit, webviewSaveEdits, webviewSetFilter, webviewServerFilter,
  webviewServerSort, webviewDistinctValues, webviewCommitRefresh, webviewPerTableTabs,
  webviewSqlHighlight, resultsGridModel, resultsGridModelEdit, resultsGridModelNull,
  resultsGridModelSetFilter) → Test Files 22 passed (22), Tests 234 passed (234)
- git status: only webview/main.ts modified + the NEW test file untracked.

ISSUES: none.

HANDOFF_TO_REVIEWER: yes — all acceptance criteria met except the verdict itself.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```

---

## Reviewer Report

REVIEWER_MODEL: unic-smart
ROUND: 1
VERDICT: approved_minor
Findings:
- (minor) src/ui/__tests__/webviewResultLimit.test.ts:161 — `itIfBundle` is declared via `it.runIf(...)` but never used (every case uses plain `it`). Harmless because `describeIfBundle` (line 162) already skips the whole suite when `dist/webview.js` is missing, but it is a dead declaration that deviates from the `webviewBundle.test.ts` convention it mirrors — use `itIfBundle` or drop the constant.
- (minor) webview/main.ts:3275-3281 — the truncation branch recomposes the `transactionOpen` + `durationMs` suffixes that the normal path also composes (3291-3294). Small duplication; acceptable, but the suffix expression could be hoisted once.
- (minor/note) The plan/task claim that a cancelled statement "renders NO footer — updateFooterNow blanks it (webview/main.ts:1634-1640, 3274-3277)" is not literally true in production: the cancelled early-return at main.ts:1639-1644 never calls `updateFooterNow()`, so a real running→cancelled transition leaves the PREVIOUS terminal statement's footer text (potentially a prior "result truncated" copy) in place. This is pre-existing staleness that affects all footer states equally (not introduced by this diff), and the new test passes only because each case loads a fresh bundle. Distinctness of a freshly-rendered cancelled state holds; the plan's stated mechanism is just inaccurate.
- (minor/note) Accessibility: `.UnicDB-grid-footer` (webview/main.ts:1045-1047) is a plain `<div>` with no `role="status"`/`aria-live`. The truncation copy is real readable text (not a visual-only signal) and is at parity with every existing footer state, but it is not announced as a live-region change. If screen-reader announcement of the truncation is intended, the footer would need `role="status"`/`aria-live="polite"` — a broader change out of this task's scope.
- Verified GREEN (fresh re-run, not trusting executor): `npm run compile` (exit 0), `npx vitest run src/ui/__tests__/webviewResultLimit.test.ts` (6/6), `npm run typecheck` (exit 0), full `src/ui/__tests__/webview*.test.ts` suite (19 files / 154 tests). RED_OUTPUT contains real assertion output ("20 of 20" without marker; loadMore posted). All 6 plan test cases implemented (≥2 edge); scope limited to webview/main.ts + the new test file.

### Fix round 1 note

Minor round-1 findings applied as a sidecar of the TASK-ARP03-002 fix round (no behavior change): (1) the unused `itIfBundle` constant was dropped from `src/ui/__tests__/webviewResultLimit.test.ts` — `describeIfBundle` already gates the whole suite, so plain `it` per case matches effective behavior; (2) the `transactionOpen` + durationMs suffix composition in `webview/main.ts` `updateFooter` was hoisted into a single `suffix` const shared by the truncation branch and the normal path (output byte-identical). VERIFICATION: `npm run compile` → exit 0; `npx vitest run src/ui/__tests__/webviewResultLimit.test.ts` → 6 passed (6); `npm run typecheck` → exit 0; full `npm test` → 3007 passed | 2 skipped (0 failed).
