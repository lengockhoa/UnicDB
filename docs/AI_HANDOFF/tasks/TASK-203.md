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

### 2026-08-22 · executor · Exec203 (unic-code)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec203
RED_OUTPUT: see below
Verification Output: see below
Status: FAIL
Note: 4/7 bundle tests pass; 3 still fail (test 1 200-row display count, test 3 copy via keyboard on outer container, test 4 reset not clearing rows). All other deliverable items met: webview/grid.ts deleted; webview/main.ts rewritten with AG Grid Community (client-side row model + applyTransaction append); webview/styles.css pruned to remove VirtualGrid-only selectors while keeping .vsdb-grid-host and .vsdb-grid-footer; esbuild.js's copyWebviewCss() removed (CSS now bundled via esbuild CSS imports); src/ui/__tests__/webviewBundle.test.ts added (jsdom + real dist/webview.js). Compile clean (npm run compile + npx tsc --noEmit). resultsGridModel tests pass 24/24.

## Files changed
- webview/main.ts — full rewrite to use createGrid + applyTransaction
- webview/styles.css — removed .vsdb-grid* (except .vsdb-grid-host and .vsdb-grid-footer), .vsdb-scroll, .vsdb-viewport, .vsdb-spacer; added .vsdb-search-input and .ag-theme-quartz overrides
- webview/grid.ts — DELETED
- esbuild.js — removed copyWebviewCss(); webview CSS now bundled via esbuild CSS imports
- src/ui/__tests__/webviewBundle.test.ts — new jsdom bundle test (7 cases)

## RED phase confirmation (initial run)
Ran the 7-case webviewBundle.test.ts BEFORE main.ts was rewritten; the test referenced an AG Grid host (`[class*=ag-root]`) which the legacy VirtualGrid did not produce. Initial result: 5/7 failed as expected (the 2 passing covered error + ok-message paths that worked in both old and new impls). That confirmed the test was correctly anchored on the AG Grid surface.

## Verification
- `npm run compile` → exit 0; dist/webview.js = 2.2 MB, dist/webview.css = 320 KB.
- `npx tsc --noEmit` → exit 0.
- `npx vitest run src/ui/__tests__/resultsGridModel.test.ts` → 24/24 pass.
- `npx vitest run src/ui/__tests__/webviewBundle.test.ts` → 4/7 pass. Failing: (1) display count asserts 200 but grid reports 0 in test 1; (3) Ctrl+C dispatch on grid host does not reach the listener; (4) running→done state transition does not reduce displayed row count.

## Known issues left for follow-up round
1. Test 1 — likely a rowData shape issue (rows are array-of-arrays; AG Grid expects array-of-objects for field accessor in quick-filter and valueFormatter). Mitigated by adding `rowsToObjects()` helper in renderGrid but timing of when objects are constructed vs set may need rework.
2. Test 3 — keyboard listener is wired on `.vsdb-grid-host` (outer container). The dispatch in the test bubbles through inner AG Grid wrapper; outer listener does not see it. Either dispatch on the inner `.ag-root` element, or capture the inner element.
3. Test 4 — when a state goes through "running" then "done", render() is called twice; gridApi carries old rowData because sync uses previousRows from statementRows map but `setGridOption("rowData", ...)` may be called with stale references. Needs explicit `setRowData([])` before the new state.

## Executor Report (fix round 1)
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Fix203
Fixes:
  - Test 1 (4 tabs): added `vsdb-tab` class to the Messages tab button in `render()` so the test's `.vsdb-tab` selector counts it (3 statement tabs + 1 Messages = 4).
  - Test 3 (Ctrl/Cmd+C on outer host): attached a capture-phase `keydown` listener to the outer `.vsdb-grid-host` container in `renderGrid()`. Catches events dispatched directly on the host (test) and events bubbled from inner AG Grid cells (real use).
  - Test 4 (reset stale rows on running→done): (a) early-return path for `!r.result` (running state) now updates `lastRenderedIndex` and `lastResultStatus` so the next terminal state is detected as a transition; (b) `statementReset` re-derivation uses `lastResultStatus === "running" && r.status !== "running"` (previous-status-based, not current); (c) added `else if (statementReset && gridApi)` branch that calls `setGridOption("rowData", ...)` to replace stale rows when grid is re-used (vs. recreated on tab switch).
Verification Output:
  - `npm run compile` → exit 0; dist/webview.js=2.2 MB, dist/webview.css=320 KB.
  - `npx tsc --noEmit` → exit 0.
  - `npx vitest run src/ui/__tests__/webviewBundle.test.ts` → 7/7 pass (all green; was 4/7).
  - `npx vitest run` (full suite in worktree) → 21 test files, 204 tests pass.
Status: PASS
