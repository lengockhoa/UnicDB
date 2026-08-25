# TASK-004 -- NULL cell display + cell value viewer

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.4

## Goal

Render null cell values as italic "(NULL)" text in the grid. Add a cell value viewer (double-click overlay) that shows the full raw cell value for any cell. The underlying data remains null -- the formatter only changes display.

## Target Files

- `webview/main.ts` (existing, 2677 lines) -- modify `valueFormatter` in `renderGrid()` to render null as `(NULL)` span; add `cellDoubleClicked` listener for value viewer overlay
- `webview/styles.css` (existing) -- add `.vsdb-null` italic style and `.vsdb-value-viewer` overlay styles

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `null value renders "(NULL)" in italic span` | Grid cell HTML contains `class="vsdb-null"` and text `(NULL)` | Cell with null value |
| 2 | unit | `non-null value renders normally` | Grid cell HTML does NOT contain `vsdb-null` | Cell with `"hello"` |
| 3 | unit | `undefined value renders "(NULL)" same as null` | Grid cell contains `vsdb-null` class | Cell with undefined |
| 4 | unit | `valueFormatter preserves underlying data` | AG Grid `getValue()` still returns null | Null cell |
| 5 | edge | `double-click on null cell enters edit mode` | AG Grid cell editor activates | Null cell double-clicked |
| 6 | edge | `value viewer overlay shows full content for long strings` | Overlay text matches full value | 500-char string |

## Test Files

- `src/ui/__tests__/resultsGridModelNull.test.ts` (new) -- tests for null rendering logic in valueFormatter

## Verification Commands

```bash
npm test src/ui/__tests__/resultsGridModelNull.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] Grid renders "(NULL)" italic text for null/undefined cell values
- [ ] Double-click on null cell still enters edit mode
- [ ] Double-click on read-only cell shows value viewer overlay
- [ ] Value viewer displays full cell content as plain text
- [ ] `.vsdb-null` CSS class styled as italic, muted color
- [ ] `.vsdb-value-viewer` overlay styled with padding, border, monospace font
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: existing `valueFormatter` in `webview/main.ts` renderGrid()
- Produces: updated `valueFormatter` returning HTML for null; `cellDoubleClicked` handler; CSS classes `.vsdb-null`, `.vsdb-value-viewer`

---

## Discussion

**Executor note (TASK-004, cycle U):** design decisions taken while implementing:
- `valueFormatter` (via `formatDataCell`) now returns the text `(NULL)` for null/undefined, and a new `cellRenderer` wraps it in `<span class="vsdb-null">(NULL)</span>`. valueFormatter alone cannot attach a CSS class, so the renderer pair implements the "italic span" contract; display-only — row data keeps the real null (editors/copy/export read `getValue`, untouched).
- Non-null cells are rendered via `textContent` on a plain span (never innerHTML), so cell values can never inject markup.
- `onCellDoubleClicked` defers one tick, then checks `api.getEditingCells()`: editable cells (all data columns) keep AG Grid's default double-click-to-edit; when NO editor started (read-only column), the `.vsdb-value-viewer` overlay opens with the full raw value (`formatCell`, plain text). Test 6 makes its column read-only via `setGridOption("columnDefs", ... editable: false)` to exercise the read-only path.
- jsdom finding: custom cellRenderer GUI attaches on the next animation frame (the default formatter text path is synchronous), so tests 1-3 await one tick before asserting DOM; test 6 also ticks after the defs swap (under full-suite load the flush is not synchronous).
- csvMode ("raw" toggle) intentionally still shows `(NULL)` for null — toggling never hides nullness.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Command: `npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts` (after baseline `npm run compile`, before implementation)

  ❯ src/ui/__tests__/resultsGridModelNull.test.ts  (8 tests | 5 failed) 708ms
   FAIL  src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — NULL cell display + value viewer > 1. null value renders "(NULL)" in an italic .vsdb-null span
     → expected +0 to be 1 // Object.is equality   (nullSpans.length 0 vs 1)
   FAIL  src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — NULL cell display + value viewer > 3. undefined value renders "(NULL)" same as null
     → expected +0 to be 1 // Object.is equality   (nullSpans.length 0 vs 1)
   FAIL  src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — NULL cell display + value viewer > 6. value viewer overlay shows full content for long strings (read-only cell)
     → AssertionError: expected null to be truthy   (no .vsdb-value-viewer overlay)
   FAIL  src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — styles.css contract (.vsdb-null / .vsdb-value-viewer) > .vsdb-null is styled italic + muted
     → AssertionError: expected null to be truthy   (no .vsdb-null rule in styles.css)
   FAIL  src/ui/__tests__/resultsGridModelNull.test.ts > TASK-004 — styles.css contract (.vsdb-null / .vsdb-value-viewer) > .vsdb-value-viewer overlay has padding, border, monospace font
     → AssertionError: expected null to be truthy   (no .vsdb-value-viewer rule in styles.css)
   Test Files  1 failed (1)
        Tests  5 failed | 3 passed (8)

  The 3 pre-passing tests lock already-correct behavior (non-null render, underlying data stays null, dblclick→edit) and stay green after implementation.
Verification Output: |
  1) `npm test src/ui/__tests__/resultsGridModelNull.test.ts`
   ✓ src/ui/__tests__/resultsGridModelNull.test.ts  (8 tests) 716ms
   Test Files  1 passed (1)
        Tests  8 passed (8)

  2) `npm test`
   Test Files  86 passed | 1 skipped (87)
        Tests  1267 passed | 2 skipped (1269)
   Duration  9.22s
   (skips are pre-existing: src/ai/omp/__tests__/acpLiveSmoke.test.ts — live ACP smoke, self-skips; unrelated to TASK-004. Full suite re-run a second time: same result — stable.)

  3) `npm run typecheck`
   > tsc --noEmit
   (no output, exit code 0)

  Note: `npm run compile` was run after editing webview/main.ts so bundle tests read the new dist/webview.js.
Status: PASS
Note: |
  none — all 6 task Test Cases (plus 2 CSS-contract checks) green; only Target Files (webview/main.ts, webview/styles.css) + the task's Test File were modified; no git commands run.
