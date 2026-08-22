# TASK-402 — Excel-like column filters + colFilterActive gating

Cycle 2026-08-22-C · P0 · Size M · Deps: (none) · Wave 1

## Goal

Nâng per-column filter lên chuẩn Excel (Text Filters / Number Filters: Contains, Equals, Starts With, Not Equal, blank… + AND/OR tối đa 2 điều kiện) bằng AG Grid Community duy nhất, đồng thời chặn load-more vòng lặp khi column filter đang active (bug mới do feature mở ra).

**Fix #3 (user-reported, cùng file): mỗi dòng đang render 2 checkbox.** Root cause: cấu hình lai — colDef custom `__select__` (`checkboxSelection: true`, main.ts:436-459) KẾT HỢP grid-level `rowSelection` (v36 auto-tạo selection column riêng). Sửa: bỏ hẳn colDef `__select__`, dùng auto selection column của v36 qua `rowSelection.selectionColumnDef` (gridOptions.d.ts:1676): `{ pinned: "left", width: 40, resizable: false, sortable: false, filter: false, suppressHeaderMenuButton: true, suppressMovable: true, lockPosition: "left" }` (SelectionColumnDef subset — KHÔNG đặt checkboxSelection/field). Kết quả: đúng 1 checkbox mỗi dòng + 1 checkbox header (select filtered). Test regression: `.ag-row .ag-selection-checkbox` đếm đúng 1 mỗi row, không còn cột `__select__` thừa.
## Action

1. **Column filter defs** trong `renderGrid()` (`webview/main.ts`, block `baseCols` build từ `specs`, hiện `filter: true` ở line ~423). Thay `filter: true` bằng filter + filterParams theo `spec.kind`:

```ts
// kind === "number":
filter: "agNumberColumnFilter",
filterParams: {
  filterOptions: ["equals", "notEqual", "lessThan", "lessThanOrEqual",
    "greaterThan", "greaterThanOrEqual", "inRange", "blank", "notBlank"],
  defaultOption: "equals",
  maxNumConditions: 2,
  debounceMs: 200,
},
// kind string/boolean:
filter: "agTextColumnFilter",
filterParams: {
  filterOptions: ["contains", "notContains", "equals", "notEqual",
    "startsWith", "endsWith", "blank", "notBlank"],
  defaultOption: "contains",
  maxNumConditions: 2,
  debounceMs: 200,
  caseSensitive: false,
},
```

Giữ nguyên `floatingFilter: true`. KHÔNG dùng `agSetColumnFilter` — Set Filter là AG Grid Enterprise (licence thương phí + CDN vi phạm CSP) — bị từ chối.

2. **State**: thêm `let colFilterActive = false;` cạnh `quickFilterActive` (line 123).

3. **Hook filter change**: trong `createGrid(gridHost, {...})` options (line 493-515) thêm event:

```ts
onFilterChanged: (e: FilterChangedEvent) => {
  colFilterActive = e.api.isColumnFilterPresent();
  updateFooterNow();
},
```

import thêm `type FilterChangedEvent` từ `ag-grid-community`. (`isColumnFilterPresent(): boolean` — GridApi v36, dist/types/src/api/gridApi.d.ts:867.)

4. **Gate load-more 3 chỗ** — thêm `|| colFilterActive` vào guard:
   - `__checkLoadMore` (line ~551): `if (loadMoreInFlight || busy || quickFilterActive || colFilterActive) return;`
   - `dispatchLoadMore` (line ~580): tương tự.
   - `onBodyScroll` (line ~597): tương tự.

5. **Reset cờ**: `colFilterActive = false;` trong 2 branch: (a) grid recreate — `isFirstRender || tabSwitched` (filter model mất theo grid instance), (b) branch `statementReset || columnsChanged || syncResult.isReset` (columnDefs swap → filter không còn hợp lệ).

6. **Footer** (`updateFooter`, line ~641): `const filtered = displayed !== loaded && (quickFilterActive || colFilterActive);`

7. Tạo `src/ui/__tests__/webviewFilters.test.ts` — copy pattern loadBundle/dispatchState/buildRows từ `src/ui/__tests__/webviewBundle.test.ts` (jsdom-env, eval `dist/webview.js`, stub acquireVsCodeApi/ResizeObserver/matchMedia; guard skip nếu dist thiếu).

## Target Files

- `webview/main.ts` — filter defs + colFilterActive + gates + footer (Task này OWN duy nhất file này)
- `src/ui/__tests__/webviewFilters.test.ts` — (new)

## Interfaces

- Consumes: `inferColumns(r.result.columns, r.result.rows): ColumnSpec[]` với `ColumnSpec.kind: "number" | "boolean" | "string"` (src/ui/resultsGridModel.ts:28); `footerText(loaded, total, hasMore, displayed, filtered): string` (resultsGridModel.ts:287); GridApi: `isColumnFilterPresent(): boolean`, `setFilterModel(model: FilterModel | null): void`, `getDisplayedRowCount(): number`.
- Produces: (none — hành vi DOM/grid nội bộ, không task nào sau này consume symbol)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Text column filter contains | `api.setFilterModel({name:{filterType:"text",type:"contains",filter:"beta"}})` → `getDisplayedRowCount()===1` và footer text match `/1 of 3/` | state 3 rows [1 alpha / 2 beta / 3 gamma], cols ["id","name"] |
| 6 | regression (user-reported double checkbox) | 1 checkbox mỗi dòng | mỗi `.ag-row` chứa đúng 1 `.ag-selection-checkbox`; không tồn tại cột header `col-id="__select__"` | fixture test 1 |
| 7 | happy (header select-filtered) | Header checkbox chỉ chọn filtered rows | header checkbox click với filter active → `getSelectedRows().length === displayed` (không phải tổng rows) | fixture test 1 + filter contains "beta" |
| 3 | edge (blocking — concurrency-class, chặn vòng lặp fetch) | Column filter active + batched + checkLoadMore | gọi `window.__vsdbCheckLoadMoreForHost()` → received KHÔNG chứa `{type:"loadMore"}` (gate chặn) | batched: 50 rows loaded, rowCount 1000, filter name contains "name-1" |
| 4 | edge (transition on→off, loại khác #3) | Clear filter → load-more mở lại | `setFilterModel(null)` → `onFilterChanged` chạy → `__vsdbCheckLoadMoreForHost()` → received CÓ `{type:"loadMore", index:0}` | tiếp trạng thái test 3, model hasMore=true |
| 5 | regression | Trên code hiện tại (trước fix), test 3 | RED: loadMore BỊ post khi column filter active — repro bug vòng lặp | fixture test 3 |

## Test Files

- `src/ui/__tests__/webviewFilters.test.ts` — (new) 5 test ở trên.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts
npm run typecheck
```

(bundle test cũ là regression net cho quick filter/selection/reset paths. `typecheck` không cover webview/ — tsconfig exclude; không có lint script — N/A.)

## Acceptance Criteria

- [ ] 5 test PASS fresh (kể cả test 4 — transition filter on→off)
- [ ] Mỗi cột dữ liệu: menu header → filter đa điều kiện Excel; number column dùng number filter, text/boolean dùng text filter
- [ ] Floating filter row + quick search box hành vi cũ giữ nguyên (webviewBundle.test.ts pass)
- [ ] Không có `{type:"loadMore"}` nào được post khi column filter active
- [ ] KHÔNG import gì từ `ag-grid-enterprise` (grep bundle: 0 match)

## Dependencies

- (none — chạy song song TASK-401 ở wave 1; TASK-401 owns styles.css, task này owns main.ts, disjoint)

## Discussion

### 2026-08-22 · planner · unic/unic-smart
Lưu ý executor: `onFilterChanged` trong createGrid options là event callback — nhận event có `.api`. Test set filter qua `setFilterModel` sẽ trigger callback thật → `colFilterActive` cập nhật. Nếu callback không fire trong jsdom (edge AG Grid), fallback: đọc `api.isColumnFilterPresent()` trực tiếp trong `__checkLoadMore` thay vì tin cờ — nhưng ưu tiên cờ + event như thiết kế, chỉ fallback nếu RED không giải thích được.

(chưa có comment khác)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
