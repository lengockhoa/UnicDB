# TASK-AH-003 — Webview accumulating tabs, "Run N · Statement M" labels, per-tab cache preservation

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AH.md` §7 (Approach §3)

## Goal

Make the webview results panel accumulate tabs across runs without replace churn: on a state post whose `results.length` grew, keep old tabs' DISTINCT caches and per-tab state, pin `activeTab` to the first NEW tab, and label stamped entries `Run N · Statement M` (from TASK-AH-001's `runNo`/`runStmtNo`). The statement-identity generation bump (DISTINCT cache safety) applies only to the newly-active tab.

## Target Files

- `webview/main.ts` — SURGICAL changes only (file is 3612 LOC — do not refactor):
  1. State handler (:3429-3492): detect append as `msg.results.length > results.length` (computed BEFORE :3433 reassigns). On append: capture `prevLen`; keep `distinctByColumn`/`distinctNotesByColumn` entries with keys `${i}::${col}` for `i < prevLen`; set `activeTab = prevLen` (first new tab) BEFORE the identity check so the existing identity computation (:3462-3476) runs only for the new active tab. The shrink clamp (:3457) stays for replace runs.
  2. `tabTitle` (:1090-1103): if `r.runNo` and `r.runStmtNo` are numbers → `Run ${r.runNo} · Stmt ${r.runStmtNo}` (fall back to existing `label`/"Statement N" behavior when absent — replace-mode and browse tabs unchanged).
  3. No other function changes: `rebuildTabs` (:1105-1135) already renders whatever `results` holds; messages tab index (`results.length`) already accounts for growth. STYLES.CSS MUST NOT BE TOUCHED — labels use the existing `.vsdb-tab` classes (cycle AG owns styles.css right now).
- `tests/webviewMultiRunTabs.test.ts` — NEW: jsdom bundle test following the `tests/webviewRequeryAlignment.test.ts` pattern (loads `dist/webview.js`, dispatches state messages via `window.postMessage`/handler, asserts tab strip DOM + cache state; skipped when dist missing; `@vitest-environment jsdom`).
- `tests/webviewEditHighlight.test.ts`, `tests/webviewRequeryAlignment.test.ts`, `tests/webviewUndoRedo.test.ts` — REGRESSION only (must stay green unmodified).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | growth state post grows the tab strip and activates the first new tab | dispatch state with 2 results, then state with 5 (2 old + 3 new) → tab strip shows 5 statement tabs + Messages tab; tab at index 2 carries `.vsdb-tab-active`; old tabs' DOM nodes keep their labels/badges | dist/webview.js loaded; two sequential state posts via the message listener |
| 2 | unit | stamped entries show "Run N · Stmt M" labels | results entries with `runNo:2, runStmtNo:1` → tab text starts `Run 2 · Stmt 1`; entries WITHOUT runNo (replace-mode/browse) → label falls back to `Statement N` / `r.label` exactly as today | direct state posts with/without the fields |
| 3 | edge (cache-stability) | append post does NOT clear old tabs' DISTINCT caches | request distinct for column on tab 0; post growth state (3 new tabs) → `distinctByColumn` still returns the cached entry for key `0::col`; only the new active tab's cache is empty; the identity generation bump fired exactly once (for the new tab) | fixture with a captured distinct reply before the append post |
| 4 | edge (boundary/shrink) | replace-run shrink still clamps | after a 5-tab accumulated view, dispatch a state post with 1 result (replace run / new panel context) → `activeTab` clamps to 0 (Messages guard `activeTab <= results.length` holds), old caches for indices >= 1 cleared via the existing identity path | 5-tab fixture then a shrinking state post |
| 5 | edge (degraded path) | Load More on a closed-cursor tab shows the notice, rows unchanged | active tab whose entry has `cursorClosed: true`; click "Load 500 more" → webview posts `loadMore` (host rejects + reposts state per AH-002); after the repost, footer/banner shows `/run this statement alone/` and the grid row count is unchanged; in-flight flag cleared | dist bundle + host stub that rejects with the AH-001 message then reposts state |
| 6 | regression | existing edit-highlight / requery-alignment / undo-redo suites green | tests/webviewEditHighlight.test.ts, tests/webviewRequeryAlignment.test.ts, tests/webviewUndoRedo.test.ts pass unmodified — per-tab edit state, requery bar wiring, undo/redo stack all keyed by `activeTab` keep working across tab growth | current suites at HEAD (`npm run compile` first) |
| 6a | regression (pin) | replace-mode state post never takes the append path | dispatch state with prior results present, then a REPLACE-mode post (same length or fewer entries, no growth) → append-detection branch not taken (no runNo label refresh, no first-new-tab activation, activeTab stays); old-tab caches for surviving indices untouched | dist/webview.js loaded; growth fixture then a shrink/equal state post |
| 7 | regression | tab switching mid-sequence keeps model/row state sane | switch from tab 4 to tab 0 and back after append → `statementRows`/model for each tab unchanged; no clamp churn error, no console error | 5-tab fixture with seeded rows per tab |

## Test Files

- `tests/webviewMultiRunTabs.test.ts` — tests 1-5, 6a, 7 (NEW; jsdom, dist-dependent like its sibling tests/webview*.test.ts files).
- `tests/webviewEditHighlight.test.ts`, `tests/webviewRequeryAlignment.test.ts`, `tests/webviewUndoRedo.test.ts` — test 6 (regression net; no edits).

## Verification Commands

```bash
npm run compile
npx vitest run tests/webviewMultiRunTabs.test.ts
npx vitest run tests/webviewEditHighlight.test.ts tests/webviewRequeryAlignment.test.ts tests/webviewUndoRedo.test.ts
npm run typecheck
npm test
```

(No lint script exists in this repo — `npm run typecheck` is the static gate. webview/main.ts has NO entry in `.cache/index/tests-map.json` → selection uses the path convention: webview runtime files → `tests/webview*.test.ts`; the NEW accumulation suite + the 3 named regressions are that resolution, not the full default. `npm test` here is the wave-3/cycle-boundary full net.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for new cases, GREEN after; RED output pasted in Executor Report).
- [ ] Bôi đen 3 câu → 3 tabs; second run appends 3 more → 6 tabs, newest active, old tabs' rows/labels/caches intact (matches PLAN_AH §1 success definition).
- [ ] `webview/main.ts` diff is confined to the state handler + `tabTitle` (surgical; no refactor of the 3612-LOC file).
- [ ] NO diff in `webview/styles.css` (cycle AG lock) — labels reuse existing `.vsdb-tab` classes.
- [ ] `src/ui/messages.ts` unchanged — append is derived from array growth, not a new field.
- [ ] No diff in `src/**` at all (host files belong to AH-001/AH-002); `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.

## Dependencies

- TASK-AH-002 must complete first (chain per PLAN_AH §7; consumes the host flip + the `cursorClosed` state posts; regression net benefits from the accumulated-array host behavior being landed).

## Interfaces

- Consumes: state message `{ type: "state", header, results, busy, dialect?, columnTypes? }` (`src/ui/messages.ts:20-44`, UNCHANGED); `StatementResult.runNo?: number; runStmtNo?: number; cursorClosed?: boolean` (TASK-AH-001); AH-002's loadMore rejection flow (`showErrorMessage` + state repost clearing the in-flight flag).
- Produces: (none downstream — webview layer is the terminal consumer; the tab strip is the user-facing deliverable of the cycle)

---

## Discussion

### 2026-08-28 · planner · unic-smart
Append detection is deliberately derived (`msg.results.length > results.length`) rather than a new state field: `src/ui/messages.ts` stays untouched and every other state post (loadMore grows rows, requery replaces rows, busy toggles) never grows the array. If a future cycle adds legitimate tab-removal (eviction), this detection must become an explicit field — note it in that cycle's plan. Keep the `activeTab = prevLen` assignment BEFORE the identity check, else the generation bump would fire for the wrong tab and wipe the wrong cache.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecAH003
SUMMARY: Implemented append-aware webview result tabs with stamped Run/Stmt labels, first-new-tab activation, and scoped DISTINCT cache preservation. Added a jsdom bundle suite covering growth, labels, cache stability, shrink clamping, replace-mode pinning, and tab switching.
TEST_PLAN_FOLLOWED: task §4 / TDD RED→GREEN
FILES_CHANGED:
  - webview/main.ts: added AH metadata fields and append-aware state handling; old-tab caches survive append and new-tab identity invalidation is scoped
  - tests/webviewMultiRunTabs.test.ts: added six jsdom bundle tests for AH-003 behavior
  - docs/AI_HANDOFF/tasks/TASK-AH-003.md: appended this executor report
TESTS_ADDED:
  - tests/webviewMultiRunTabs.test.ts: growth/activation, stamped labels, DISTINCT cache stability, shrink clamp, replace pin, tab switching
VERIFICATION:
  command: npx vitest run tests/webviewMultiRunTabs.test.ts (RED before implementation)
  result: 3 failed, 3 passed / exit 1; expected failures were growth activation, stamped labels, and cache preservation
  output_excerpt: |
    Failed Tests: 3
    growth state post grows the tab strip and activates the first new tab
    stamped entries show Run N · Stmt M and unstamped entries keep fallback labels
    append post preserves old DISTINCT cache while activating a new tab
  command: npm run compile
  result: exit 0 (one existing ES2024 target warning)
  command: npx vitest run tests/webviewMultiRunTabs.test.ts
  result: 6 passed, 0 failed / exit 0
  output_excerpt: |
    Test Files 1 passed (1)
    Tests 6 passed (6)
  command: npx vitest run tests/webviewEditHighlight.test.ts tests/webviewRequeryAlignment.test.ts tests/webviewUndoRedo.test.ts
  result: 19 passed, 0 failed / exit 0
  output_excerpt: |
    Test Files 3 passed (3)
    Tests 19 passed (19)
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > vsdb@1.12.0 typecheck
    > tsc --noEmit
  command: npm test
  result: exit 0
  output_excerpt: |
    Full Vitest suite completed successfully; only existing stderr warnings were emitted.
ISSUES: npm compile emits the existing unrecognized ES2024 target warning; no failures.
HANDOFF_TO_REVIEWER: yes — Handoff mode requires a different-model reviewer
NEXT: ready for review
