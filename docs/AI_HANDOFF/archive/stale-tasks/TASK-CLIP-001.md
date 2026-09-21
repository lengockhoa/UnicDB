# TASK-CLIP-001 — Clipboard copy matrix shapes (bundle + pure test pin)

<!--
Template fields all present. This task is TESTS-ONLY: it adds test files that pin the
existing copy pipeline (copySelectionToHost / copyCellRangeToHost / selectionRangeToText)
across every selection shape the user asked for. No production file is touched, so it can
run in wave 1 fully parallel with TASK-CLIP-002.
-->

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (TASK-CLIP-001), §4 rows CLIP-001, §5 wave 1

## Goal

Pin, at the jsdom bundle level and the pure-model level, that Cmd/Ctrl+C copies the correct
TSV matrix for every selection shape: a single cell, an N×M rectangle, checkbox-selected
rows, a single-column strip, with hidden columns excluded and the no-selection no-op guard
holding. These tests are the contract every later wave must keep green.

## Target Files

- `src/ui/__tests__/webviewClipboardCopy.test.ts` — (new) jsdom bundle-eval copy-shape suite.
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — (existing) append a column-strip
  (1-wide range) `selectionRangeToText` case only if the existing describe blocks lack it.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `1x1 range Cmd+C copies the single cell` | exactly 1 post `{type:"copy"}`; `text` === `"alpha"`, no `\t`, no `\n` | 3×2 state rows `[[1,"alpha"],[2,"beta"],[3,"gamma"]]`; mousedown+mouseup on `.ag-row[row-index="0"] [col-id="name"]` |
| 2 | happy | `2x2 rectangle copies rows tab-joined, lines newline-joined` | 1 `copy` msg; `text` === `"1\talpha\n2\tbeta"` | same state; mousedown (0,id) then mousemove to (1,name) then window mouseup |
| 3 | happy | `checkbox row selection copies 2 rows` | 1 `copy` msg; 2 `\n`-lines each containing `\t` | `api.forEachNode` setSelected rows 0-1 (pattern: `webviewBundle.test.ts` #3) |
| 4 | happy | `single-column strip drag copies one column` | `text` === `"alpha\nbeta\ngamma"` (1 line per row, no `\t`) | mousedown (0,name), mousemove (2,name), mouseup |
| 5 | edge (shape) | `hidden column excluded from range copy` | `text` === `"alpha\nbeta"` — col `id` values never leak | 2×2 range then `__UnicDB.debugSetSpecs` with `id` hidden (`webview/main.ts:4510`) |
| 6 | edge (empty) | `Cmd+C with no selection and no focused cell posts nothing` | zero `copy` messages | fresh bundle, state dispatched, no selection/focus; guard `webview/main.ts:4065` |
| 7 | edge (boundary) | `range clipped to displayed rows` | copy contains only displayed rows (drag end row beyond `getDisplayedRowCount()-1` clamps) | 3-row state; range endRow = 9 via Shift+Arrow ×N or direct mousemove past grid |
| 8 | regression | existing `webviewBundle.test.ts` #3 + `webviewExport.test.ts` #3 copy cases | unchanged GREEN | existing files |

## Test Files

- `src/ui/__tests__/webviewClipboardCopy.test.ts` — (new) contains tests #1-#7.
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — pure-side column-strip case if missing.

## Verification Commands

```bash
npm run typecheck
npm run compile        # REQUIRED — bundle tests eval dist/webview.js; a self-skip is a FAIL
npx vitest run src/ui/__tests__/webviewClipboardCopy.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
```

## Acceptance Criteria

- [ ] All §Test Cases GREEN (no silent bundle skips — `dist/webview.js` present).
- [ ] Zero production files modified (`git status` shows only the two test files).
- [ ] `npm run typecheck` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes:
  - `copySelectionToHost()` / `copyCellRangeToHost(range)` — existing, `webview/main.ts:4031/4090`, triggered by capture-phase Cmd/Ctrl+C keydown on `.UnicDB-grid-host`.
  - `__UnicDB.debugSetSpecs(specs: readonly ColumnSpec[]): void` — existing seam, `webview/main.ts:4510`.
  - `window.__UnicDB` debug object + stubbed `acquireVsCodeApi` sink (pattern: `webviewKeybinding.test.ts:106-120`).
  - Pure: `selectionRangeToText(rows: unknown[][], range: CellRange): string` — `src/ui/resultsGridModel.ts:1352`.
- Produces: (none) — test-only task; later waves must keep these cases GREEN.

## Discussion

### 2026-09-10 · planner · unic/unic-smart
-> @executor: build the range by dispatching real `mousedown`/`mousemove` `MouseEvent`s on
rendered `.ag-cell` elements (bubbling to `gridWrap`) — `findCellFromEvent`
(`webview/main.ts:1308`) resolves via `col-id` + `row-index` attributes. Do NOT reach into
module-scope `cellRange` (not exported); the DOM path is the same one users drive.

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: ImplementClipboardCopyTests
SUMMARY: Added the jsdom bundle copy-shape suite for 1x1, 2x2, checkbox-row, single-column, hidden-column, no-selection, and displayed-row-boundary cases. Added the missing pure-model single-column strip assertion; no production files changed.
TEST_PLAN_FOLLOWED: task §Test Cases / TDD RED-GREEN
FILES_CHANGED:
  - src/ui/__tests__/webviewClipboardCopy.test.ts: added seven bundle-eval clipboard copy shape tests and shared DOM/event fixtures.
  - src/ui/__tests__/resultsGridModelEdit.test.ts: added the pure selectionRangeToText single-column strip case.
  - docs/AI_HANDOFF/tasks/TASK-CLIP-001.md: appended this executor report.
TESTS_ADDED:
  - src/ui/__tests__/webviewClipboardCopy.test.ts: `1x1 range Cmd+C copies the single cell`; `2x2 rectangle copies rows tab-joined, lines newline-joined`; `checkbox row selection copies 2 rows`; `single-column strip drag copies one column`; `hidden column excluded from range copy`; `Cmd+C with no selection and no focused cell posts nothing`; `range clipped to displayed rows`.
  - src/ui/__tests__/resultsGridModelEdit.test.ts: `single-column strip returns one value per line`.
RED_OUTPUT: |
  npx vitest run src/ui/__tests__/webviewClipboardCopy.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts (exit 1)
  ❯ src/ui/__tests__/webviewClipboardCopy.test.ts  (7 tests | 1 failed) 765ms
  ❯ src/ui/__tests__/webviewClipboardCopy.test.ts > webview/main.ts clipboard copy shapes (TASK-CLIP-001) > 1x1 range Cmd+C copies the single cell
  ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
  FAIL  src/ui/__tests__/webviewClipboardCopy.test.ts > webview/main.ts clipboard copy shapes (TASK-CLIP-001) > 1x1 range Cmd+C copies the single cell
  AssertionError: expected 'alpha' to be 'not-alpha' // Object.is equality
  ❯ src/ui/__tests__/webviewClipboardCopy.test.ts:180:28
  Test Files 1 failed | 1 passed (2)
VERIFICATION:
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > UnicDB@1.53.42 typecheck
    > tsc --noEmit
    Wall time: 1.42s
  command: npm run compile
  result: exit 0
  output_excerpt: |
    > node esbuild.js
    dist/renameForm.js 6.2kb
    dist/renameForm.js.map 13.0kb
  command: npx vitest run src/ui/__tests__/webviewClipboardCopy.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
  result: 41 pass, 0 fail, exit 0
  output_excerpt: |
    ✓ src/ui/__tests__/resultsGridModelEdit.test.ts  (34 tests) 4ms
    ✓ src/ui/__tests__/webviewClipboardCopy.test.ts  (7 tests) 824ms
    Test Files 2 passed (2)
    Tests 41 passed (41)
    Duration 1.28s
    Warning: Unrecognized target environment "ES2024" (tsconfig.json)
ISSUES: TypeScript emits the existing ES2024 target warning during Vitest transform; typecheck, compile, and all targeted tests pass.
HANDOFF_TO_REVIEWER: no — reviewer is not assigned for this tests-only task (Reviewer: -).
NEXT: Ready for wave 1 integration and main-agent review.

## Reviewer Verdict

(appended by Phase 4)
## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run typecheck
  result: exit 0
  command: npm run compile
  result: exit 0; dist/webview.js freshly built (no bundle-test self-skip — copy suite ran 7 tests, not 0)
  command: npx vitest run src/ui/__tests__/webviewClipboardCopy.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
  result: 41 pass / 0 fail, exit 0 (7 copy-shape + 34 pure-model)
TEST_PLAN_COVERAGE: all-followed — §4 cases #1-#7 implemented with behavior-level assertions through the real DOM/event path (mousedown/mousemove/capture-phase Ctrl+C keydown on .UnicDB-grid-host); pure-model column-strip case added (resultsGridModelEdit.test.ts:313). RED_OUTPUT contains a real failing run (AssertionError 'alpha' vs 'not-alpha', exit 1), proving the sentinel assertion executes.
FINDINGS:
  critical:
    - (none)
  important:
    - (none)
  minor:
    - webviewClipboardCopy.test.ts:65-66,166-167 — the existsSync(dist/webview.js) gate self-skips the whole describe block when the bundle is stale/missing; INDEX wave-boundary rule already mandates npm run compile first and the R2 gate caught it (7 tests ran), but a suite-level "bundle loaded" sanity assert would make a silent skip impossible to confuse with green.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Tests-only task confirmed — commit a7e4a98 touches only the two test files (plus handoff docs). Pins verified against current HEAD cc81b71: wave-2/3 production changes to webview/main.ts (+58/−7) kept all 41 GREEN; production seams match the pinned contract (row clamp webview/main.ts:4141, visible-column filter webview/main.ts:4144-4151, empty-selection guard webview/main.ts:4110). Case #8 (existing webviewBundle/webviewExport copy regressions) is covered by the closeout full-suite gate, not this task's commands.
