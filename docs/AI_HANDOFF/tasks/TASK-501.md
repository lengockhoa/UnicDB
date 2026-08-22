# TASK-501 — Grid edit model + paste TSV + undo + toolbar

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
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

<!-- Executor report dưới đây -->
