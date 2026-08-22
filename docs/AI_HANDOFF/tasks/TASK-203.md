# TASK-203 — Thay VirtualGrid bằng AG Grid trong webview

Status: ready
Owner: -
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Render Results panel bằng AG Grid Community (client-side row model + `applyTransaction` append), đủ feature set theo reference UI: per-column floating text filter, sort, resize, checkbox selection, search box quick filter, ellipsis + tooltip, footer row count. Giữ tabs + Messages tab + ok-message + copy protocol + infinite scroll loadMore. Xóa `webview/grid.ts`.

## Target Files

- `webview/main.ts` — renderGrid dùng AG Grid; import `createGrid` + types từ ag-grid-community; dùng `src/ui/resultsGridModel.ts` cho logic (import relative `../src/ui/resultsGridModel`)
- `webview/styles.css` — xóa rule VirtualGrid-only (`.vsdb-grid*`, `.vsdb-scroll`, `.vsdb-viewport`, `.vsdb-spacer`), thêm: `.vsdb-grid-host { flex:1 }`, search input `.vsdb-search-input`, footer `.vsdb-grid-footer` giữ, theme class `ag-theme-quartz` sizing (row height ~28px). GIỮ mọi selector khác (connection form dùng chung file này)
- `webview/grid.ts` — DELETE (VirtualGrid chết; formatCell đã dời sang resultsGridModel)
- `esbuild.js` — xóa `copyWebviewCss()` (dist/webview.css giờ là CSS bundle output của esbuild)
- `src/ui/__tests__/webviewBundle.test.ts` (new) — jsdom test chạy `dist/webview.js` thật qua repro page pattern `.cache/webview-repro/scroll.html`
- `.cache/webview-repro/aggrid.html` (new) — repro page cập nhật cho AG Grid (3 step: render 200 rows, reset query mới, batched loadMore)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | happy | 3 statements render đủ | jsdom load bundle; state msg 3 statements (SELECT 200 rows + INSERT ok-message + SELECT error) → 4 tabs (3 statement + Messages); tab 0 active → `.vsdb-grid-host` chứa grid AG (`[class*=ag-root]`), displayed rows = 200 |
| 2 | happy | quick filter lọc | `api.setQuickFilter` (qua search input `.vsdb-search-input` dispatch input event với text match 1 row) → `getDisplayedRowCount() === 1`; footer hiển thị filtered count |
| 3 | happy | selection + copy | select 2 rows (qua `api.forEachNode` set selected hoặc click checkbox trong DOM) → dispatch Ctrl/Cmd+C trên grid host → `postToHost` nhận `{type:"copy"}` với text tab-separated 2 dòng |
| 4 | edge | reset query mới (BUG 2 regression) | state 200 rows → state mới có `status:"running"` → state 50 rows → displayed = 50, KHÔNG còn row cũ nào |
| 5 | edge | batched loadMore không reset (BUG 1 regression) | state 500 rows batched → call `window.__checkLoadMore()` (expose) → `__received` chứa `{type:"loadMore",index:0}` đúng 1 lần; gửi state 1000 rows → displayed = 1000 VÀ scroll container KHÔNG bị setRowData toàn bộ (verify qua `applyTransaction` path: `api.getDisplayedRowCount()===1000` và model.sync trả delta — assert qua `__received` không nhận state nào thừa) |
| 6 | edge | non-SELECT ok-message giữ nguyên | tab 1 (0 columns, 0 rows, commandTag INSERT, rowCount 1) → `.vsdb-ok-message` text chứa `✓ INSERT — 1 row affected` |
| 7 | edge | error tab | tab 2 status error → `.vsdb-error` hiện message |

## Test Files

- `src/ui/__tests__/webviewBundle.test.ts` (new) — `// @vitest-environment jsdom`, đọc `dist/webview.js` + `dist/webview.css` từ disk, eval trong jsdom với `acquireVsCodeApi` stub + `__received` array (pattern y hệt `.cache/webview-repro/scroll.html`). TRƯỚC test: stub ResizeObserver/matchMedia. Test runner phải `npm run compile` trước (note trong file: skip-with-message nếu dist/webview.js không tồn tại).

## Verification Commands

```bash
npm run compile && npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/webviewBundle.test.ts
```

## Acceptance Criteria

- [ ] AG Grid render mọi scroll position; SELECT mới reset sạch (bug 1+2); loadMore append không nhảy scroll
- [ ] Floating filter từng cột + sort + resize + checkbox selection + search box + ellipsis (cellStyle text-overflow) + tooltip (`enableBrowserTooltips`) + footer "N row(s)" cập nhật theo filter
- [ ] `webview/grid.ts` bị xóa; KHÔNG còn reference VirtualGrid trong webview/
- [ ] `dist/webview.css` = esbuild CSS bundle (ag-grid + quartz + styles.css custom cuối file); connectionForm (dùng cùng webview.css) không mất style — `npx vitest run` full suite pass (connectionForm.test.ts xanh)
- [ ] Message protocol không đổi: chỉ postToHost ready/copy/loadMore/cancel như cũ
- [ ] LoadMore gate: quick-filter đang active (filter changed) → KHÔNG auto loadMore (tránh fetch vô hạn khi user lọc)
- [ ] 7 test trên pass

## Dependencies

TASK-201 (ag-grid dependency + CSS imports trong main.ts), TASK-202 (resultsGridModel interface)

## Interfaces

Consumes: `ag-grid-community` `createGrid` (TASK-201); `createResultsGridModel/inferColumns/selectionToText/shouldResetGrid/footerText/formatCell` (TASK-202).
Produces: webview grid hoàn chỉnh; repro page `.cache/webview-repro/aggrid.html` (orchestrator smoke browser trước release).

## Discussion

### 2026-08-22 · planner · unic-smart
Grid instance phải TỒN TẠI 1 lần trong lifecycle host element — KHÔNG `createGrid` lại mỗi render() (leak). render() chỉ append container `.vsdb-grid-host`; grid tạo lazy lần đầu vào container, các lần sau tái dùng + update columns/rows. Khi switch tab sang statement khác (columns khác) → `api.setGridOption('columnDefs', ...)` + `setRowData` (tab switch là reset hợp lệ). Khi trở lại tab cũ, dùng lại toàn bộ rows của statement đó từ state message (memory-resident). Copy: range selection là Enterprise → checkbox row selection + keydown handler Ctrl/Cmd+C (preventDefault) → selectionToText → postToHost copy. Sort/filter là client-side của AG Grid trên rows đã load — đúng constraint.
