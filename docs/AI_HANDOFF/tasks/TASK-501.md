# TASK-501 — Grid edit model + paste TSV + undo + toolbar

- Status: `pending_review`
- Owner: `executor/feature-implementer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Pure-logic edit state (dirty map + undo stack + add/delete row) và TSV paste parser trong `src/ui/resultsGridModel.ts`, wire vào `webview/main.ts` (cell edit đánh dirty, paste handler, undo/refresh/CSV toggle buttons). KHÔNG post host trong task này (save edits là TASK-503).

## Target Files

- `src/ui/resultsGridModel.ts` — append `EditState` class: `markDirty(rowId,col,new,old)`, `undo()`, `clear()`, `dirtyCount`, `snapshot()`; `parseTsvPaste(text, opts)`; `applyPasteToDirty(state, anchor, parsed, colCount, rowCount)` (clip out-of-bounds).
- `webview/main.ts` — colDefs thêm `editable: true`; `cellValueChanged` → `editState.markDirty`; `paste` event trên gridWrap → `parseTsvPaste` + apply; toolbar thêm Refresh / Add Row / Delete Row / Undo / CSV toggle (CSV toggle = hiển thị giá trị raw vs formatCell); keyboard Cmd/Ctrl+Enter handled ở TASK-503 (task này chỉ giữ edit state).
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — mới.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | markDirty hai cell khác row | dirty map có 2 entry, `dirtyCount=2` | fresh state |
| 2 | unit | markDirty same cell lần 2 | ghi đè value mới, không nhân entry, undo stack vẫn 1 bước cho cell đó (coalesce liên tiếp) | dirty 1 lần rồi edit tiếp |
| 3 | edge | undo stack rỗng | `undo()` trả null, state không đổi | fresh state |
| 4 | edge | undo 2 bước | pop đúng thứ tự LIFO, restore old value (dirty entry removed nếu trở về old) | 2 markDirty |
| 5 | unit | parseTsvPaste happy `a\tb\nc\td` | `[[a,b],[c,d]]` | string |
| 6 | edge | parseTsvPaste CRLF + trailing `\r\n` + empty line cuối | không sinh row rỗng | `"a\tb\r\nc\td\r\n\r\n"` |
| 7 | edge | parseTsvPaste row thiếu cell | pad `""` theo max width | `"a\tb\nc"` |
| 8 | unit | applyPaste clip out-of-bounds | cells ngoài (rowCount, colCount) bỏ, không throw | paste 3 cols vào grid 2 cols |
| 9 | regression | clear() sau reset state (tab switch/new query) | dirty map rỗng | dirty rồi clear |
| 10 | integration (jsdom, `src/ui/__tests__/webviewEdit.test.ts`) | cellValueChanged → dirty; paste event → dirty đúng vùng | state snapshot đúng | webview bundle eval |

## Test Files

- `src/ui/__tests__/resultsGridModelEdit.test.ts`
- `src/ui/__tests__/webviewEdit.test.ts` (bundle eval pattern như `webviewFilters.test.ts`)

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsGridModelEdit.test.ts src/ui/__tests__/webviewEdit.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước, GREEN sau).
- [ ] Không regression suite hiện có.
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces:
  - `class EditState { markDirty(rowId: number, colIndex: number, newValue: unknown, oldValue: unknown): void; undo(): { rowId: number; colIndex: number } | null; clear(): void; get dirtyCount(): number; snapshot(): Array<{ rowId: number; colIndex: number; value: unknown }>; }`
  - `function parseTsvPaste(text: string): string[][]`
  - `function applyPasteToDirty(state: EditState, anchorRow: number, anchorCol: number, parsed: string[][], colCount: number, rowCount: number): void`
  - TASK-503 dùng `EditState.snapshot()` để build save payload.

---

## Discussion

(chưa có comment)

---


## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Implemented EditState + parseTsvPaste + applyPasteToDirty in src/ui/resultsGridModel.ts; wired editable cells, paste handler, and Refresh/Add Row/Delete Row/Undo/CSV toggle toolbar buttons in webview/main.ts.
TEST_PLAN_FOLLOWED: task §4 (Test Cases 1–10)
FILES_CHANGED:
  - src/ui/resultsGridModel.ts: appended `class EditState`, `function parseTsvPaste`, `function applyPasteToDirty` (pure-logic, no DOM/ag-grid imports)
  - webview/main.ts: imported EditState/parseTsvPaste/applyPasteToDirty; added `editable:true` + `cellValueChanged` handler; added `paste` listener on gridWrap; added 5 toolbar buttons (Refresh/Add Row/Delete Row/Undo/CSV toggle); added `formatDataCell` (csvMode-aware formatter); exposed `__vsdb.editState`/`addRow`/`deleteRow`/`refresh`/`toggleCsv`/`undo`
  - src/ui/__tests__/resultsGridModelEdit.test.ts: NEW — 11 tests covering EditState/parseTsvPaste/applyPasteToDirty
  - src/ui/__tests__/webviewEdit.test.ts: NEW — 5 bundle-eval tests covering cell edit, paste wiring, undo, toolbar exposure, CSV toggle
TESTS_ADDED:
  - src/ui/__tests__/resultsGridModelEdit.test.ts: markDirty × 2 / coalesce / undo empty / undo LIFO × 2 / clear / snapshot / parseTsvParse happy / CRLF + trailing empty / pad short row / applyPaste clip cols / applyPaste clip rows
  - src/ui/__tests__/webviewEdit.test.ts: cellValueChanged→markDirty / paste wiring / undo / toolbar exposure / CSV toggle flips formatter
VERIFICATION:
  command: npm run compile
  result: dist/webview.js rebuilt (2.2mb), dist/extension.js rebuilt (4.6mb) — esbuild complete
  command: npx vitest run src/ui/__tests__/resultsGridModelEdit.test.ts src/ui/__tests__/webviewEdit.test.ts
  result: Test Files 2 passed (2) / Tests 16 passed (16) / exit 0
  command: tsc --noEmit (npm run typecheck shell wrapper hits the package.json corruption introduced by a concurrent peer agent — `tsc --noEmit` direct invocation is the equivalent and exits 0)
  result: exit 0
RED_OUTPUT:
  - resultsGridModelEdit (before impl): "TypeError: parseTsvPaste is not a function" at line 124; "TypeError: EditState is not a constructor" at lines 136 and 159. "Test Files 1 failed (1) / Tests 11 failed (11)".
  - webviewEdit (before impl): "AssertionError: expected 'undefined' to be 'function'" on `w.addRow`; "TypeError: w.toggleCsv is not a function". "Test Files 1 failed (1) / Tests 5 failed (5)".
ISSUES:
  - parseTsvPaste implementation interprets "trailing empty rows" as ALL trailing empty rows (not just one) — required dropping multiple trailing empty lines to make test 6 ("a\tb\r\nc\td\r\n\r\n") green. This matches Excel paste behavior.
  - Test 10e CSV toggle: the valueFormatter is a closure over `formatDataCell`, which reads csvMode at call time. Test 10e must call the "before" formatter BEFORE toggling, or the assertion sees the post-toggle behavior. Documented in the test.
  - Concurrent peer (Exec505 running) corrupted package.json during my run (extra `{` and `]` in commands array, line 118). Outside Target Files — left untouched. `tsc --noEmit` direct invocation is unaffected; `npm run typecheck` shell wrapper will fail until peer fixes package.json.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
<!-- Executor report dưới đây -->
