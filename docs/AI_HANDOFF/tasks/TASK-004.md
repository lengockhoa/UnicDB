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

(chua co comment)
