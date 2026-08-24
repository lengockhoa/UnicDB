# TASK-007 (grid B) — Excel editing: dirty highlight + add/delete-row commit

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 G2; spec `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` §B

## Goal

Grid như Excel: cell đã edit đổi màu (highlight vs original), row mới highlight, row deleted strikethrough; commit (Cmd/Ctrl+Enter hoặc nút check) chạy toàn bộ pending (UPDATE/INSERT/DELETE) một batch, báo lỗi per-row, refresh grid về DB truth, clear highlights (new baseline). Cơ sở: EditState + NewRowMarker/DeleteRowMarker + buildSaveStatements INSERT/DELETE ĐÃ CÓ — task bổ sung highlight + commit flow hoàn chỉnh.

## Target Files

- `webview/main.ts` — cellClassRules/getRowClass đọc editState + row markers; commit handler hoàn chỉnh (per-row errors, refresh, clear highlights); disable AG Grid built-in undo khi TASK-008 unified stack land (không đụng trong task này ngoài hook comment).
- `webview/styles.css` — thêm `.vsdb-cell-dirty`, `.vsdb-row-new`, `.vsdb-row-deleted` (highlight + strikethrough).
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — append describe (#3, #4 pure-logic qua EditState).
- `tests/webviewEditHighlight.test.ts` (NEW) — jsdom test webview render highlight + commit flow (pattern esbuild-transform + jsdom như aiChatPanelWebview.test.ts:24-37).

## Spec

1. **Dirty highlight**: AG Grid `cellClassRules` hoặc cellValueChanged handler add/remove class `vsdb-cell-dirty` trên cell (`params.colDef.field` + rowId trong editState). Revert (undo path cũ/TASK-008) → remove class. Commit success → clear toàn bộ (editState.clear() đã có + refreshGrid áp dụng rowRenderer refresh).
2. **New-row highlight**: row có `__vsdb_new_row__` → `getRowClass` trả `vsdb-row-new` (nền xanh nhạt). Sau commit success + refresh: row biến thành row thường (có rowId/ctid mới từ DB).
3. **Deleted-row highlight**: row có dirty entry mang DeleteRowMarker (markDirty rowId,0,{__vsdb_deleted__...} — main.ts:1734 hiện có) → `getRowClass` trả `vsdb-row-deleted` + CSS `text-decoration: line-through; opacity: .6`.
4. **Commit flow** (main.ts commit handler + host saveEdits): đã post saveEdits batch. Bổ sung: sau saveResult ok → re-query bảng (post requery message hoặc host tự re-run original query — chọn theo flow hiện có, ghi report) → editState.clear() + refresh cells (highlight biến mất). saveResult có per-row errors (đọc resultsPanel saveResult payload shape hiện có — nếu host chưa gửi per-row errors thì bổ sung payload field `rowErrors?: Array<{rowId: number; error: string}>`, CẢ HAI bên đồng thời vì cùng repo) → banner liệt kê; rows lỗi giữ dirty.
5. **No-op guard**: 0 dirty → không post saveEdits (hiện có — giữ, lock bằng test).

CSS (styles.css):
```css
.vsdb-cell-dirty { background: var(--vsdb-dirty-bg, rgba(255,166,0,.25)) !important; }
.vsdb-row-new .ag-cell { background: rgba(60,170,255,.12); }
.vsdb-row-deleted .ag-cell { text-decoration: line-through; opacity: .6; }
```
(Giữ var() fallback — theme VS Code dark/light đều đọc được.)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | edit cell → cell có class vsdb-cell-dirty | jsdom: dispatch cellValueChanged (hoặc gọi handler) → cell element classList chứa `vsdb-cell-dirty` | webview jsdom harness NEW test file |
| 2 | happy | add row → row class vsdb-row-new; delete row → vsdb-row-deleted + line-through CSS rule tồn tại | getRowClass / DOM class assert; styles.css parse có selector `.vsdb-row-deleted` với `line-through` | jsdom + read styles.css |
| 3 | edge | commit khi 0 dirty → no-op | KHÔNG postMessage saveEdits (spy postMessage) | editState rỗng |
| 4 | edge | commit 1 row lỗi → rowErrors banner + row lỗi giữ dirty, rows OK cleared | saveResult `{ok:true, rowErrors:[{rowId:1,error:"..."}]}` → banner text chứa error; row 1 cell còn class dirty; rows khác mất | jsdom fake saveResult message |
| 5 | regression | saveResult ok → refresh + clear highlights (new baseline) | sau saveResult ok: editState.dirtyCount===0; không cell nào còn vsdb-cell-dirty; grid re-query posted | jsdom |
| 6 | regression | buildSaveStatements INSERT/DELETE markers (đã có) vẫn pass | existing saveStatementsInline tests pass nguyên | full file |

## Test Files

- `tests/webviewEditHighlight.test.ts` (NEW — jsdom, esbuild transform pattern từ src/ui/__tests__/aiChatPanelWebview.test.ts:24-37) — #1, #2, #3, #4, #5.
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — #6 guard (chạy nguyên file trong Verification).

## Verification Commands

```bash
npx vitest run tests/webviewEditHighlight.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts src/adapters/__tests__/saveStatementsInline.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test §Test Cases PASS.
- [ ] Edit/add/delete highlight đúng CSS class; commit success clear toàn bộ (new baseline); per-row error giữ dirty row.
- [ ] Không thay đổi saveEdits message shape ngoài field rowErrors addition (2 bên cùng land).

Ghi chú mapping (review #3): module `saveStatements` sống ở `src/core/saveStatements.ts` nhưng test files của nó nằm ở `src/adapters/__tests__/saveStatements{,Inline,Parser}.test.ts` (xác nhận qua `.cache/index/tests-map.json`). Task này KHÔNG sửa `src/core/saveStatements.ts` — không nằm trong Target Files; các test verification chạy như regression net thuần (markers INSERT/DELETE đã có từ TASK-501, task lock hành vi qua E2E webview flow).

## Dependencies
- TASK-006 (wave 2 batch A, sau T6 — rowErrors host-side emit đụng `src/ui/resultsPanel.ts` mà T6 cũng sửa; T7 đụng webview/main.ts + styles.css, disjoint với T2/T4 trong batch)

## Interfaces

- Consumes: `EditState` (markDirty/undo/clear/snapshot — src/ui/resultsGridModel.ts:655+); NewRowMarker/DeleteRowMarker (src/core/saveStatements.ts:41-52); commit handler + makeIconButton toolbar (webview/main.ts:512-546); saveEdits/saveResult message flow.
- Produces: (a) CSS classes `vsdb-cell-dirty`/`vsdb-row-new`/`vsdb-row-deleted` trong webview/styles.css; (b) saveResult payload extension `rowErrors?: Array<{rowId:number; error:string}>` (host + webview đồng bộ — TASK-006 không đụng payload); (c) commit-complete contract: saveResult ok ⇒ editState.clear() + re-query. TASK-008 (undo stack) tiêu thụ (a)+(c).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: T6 và T7 cùng cycle song song nhưng KHÔNG share file. T6 đụng resultsPanel.ts; nếu commit-flow per-row error cần thêm rowErrors vào payload resultsPanel.ts gửi — ĐÓ là đụng file T6. Quyết định: T7 implement rowErrors với payload field OPTIONAL (host cũ chưa gửi → banner chung "N rows failed" fallback) → T7 không bắt buộc sửa resultsPanel.ts; nếu cần host-side emit, ghi vào Discussion tag @TASK-006 executor hoặc làm phần host trong T6 fix round.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
