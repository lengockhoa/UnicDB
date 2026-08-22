# PLAN — Cycle 2026-08-22-C

Base: `main` (HEAD 8b69a55, v1.3.1 released) · Release target: **1.3.2**

## §1 Intent

User (nguyên văn): "Tôi muốn cái table này có theme theo theme của VSCode tôi dùng theme đen thui mà cái table này trắng. Tôi muốn bộ filter ở trên nữa. Tôi muốn cập nhật nó sao mà filter giống như bên excel á. Tôi thấy nó hay hơn search cũng thân thiện với người dùng hơn."

Hai vấn đề:

1. **Bug theme**: Results grid (AG Grid `ag-theme-quartz`) render trắng/light mặc dù webview đang ở VS Code dark theme. Root cause: `ag-theme-quartz.css` set cứng `--ag-background-color: #fff` (line 11) và các input AG Grid dùng UA-default (nền trắng) — `webview/styles.css` chỉ override sizing vars (`--ag-row-height`...), không override màu. Webview đã có sẵn bộ `--vscode-*` CSS vars (styles.css đã dùng 58 lần).
2. **Excel-like filter**: hiện tại mỗi cột chỉ có floating text filter (1 ô text chạy contains) + quick search box. User muốn filter kiểu Excel: menu filter per-column với nhiều điều kiện (Contains / Equals / Starts With / Not Equal…) + kết hợp AND/OR.

Success: mở VSDB Results trên VS Code dark → grid nền tối, chữ sáng, header/menu/input filter đều theo theme (và tự theo light theme nếu user đổi theme — KHÔNG hard-code đen). Mỗi cột có nút menu filter với đầy đủ điều kiện kiểu Excel Text/Number Filters. Quick search box giữ nguyên. Load-more không rơi vòng lặp khi column filter đang active.

## §2 Scope

**In-scope**
- `webview/styles.css`: map AG Grid theme tokens → `--vscode-*` (kèm fallback cho browser smoke harness).
- `webview/main.ts`: column filter defs kiểu Excel (`agTextColumnFilter` / `agNumberColumnFilter` + `filterParams`), biến `colFilterActive` gate load-more, footer `filtered` flag tính cả column filter.
- `package.json` version 1.3.2 + `README.md` Results grid bullet.
- Test: 2 file test mới theo pattern `src/ui/__tests__/webviewBundle.test.ts`.

**Out-of-scope**
- AG Grid Enterprise / Set Filter (checkbox list) — xem §3.
- Đổi search box, pagination, column pinning UX mới.
- Queued (cycle sau): "Results panel: AI assist tab" (giữ trong INDEX.md).

**Wave constraint**: W1 = TASK-401 (styles.css) ∥ TASK-402 (main.ts) — file disjoint. W2 = TASK-403 (package.json + README).

## §3 Approach

### (a) Theme — map root tokens, để quartz tự derive

`webview/styles.css` import SAU `ag-theme-quartz.css` trong bundle (main.ts:21-23 → esbuild giữ thứ tự import) nên rule `.ag-theme-quartz {...}` ở styles.css thắng cascade cùng specificity. Quartz v36 derive phần lớn màu từ 4 root token bằng `color-mix` (đã verify trong `ag-theme-quartz.css`):

| AG Grid var | Map tới | Derived tự động nhờ root |
|---|---|---|
| `--ag-background-color` | `var(--vscode-editor-background, #1e1e1e)` | header bg (mix 2%), menu bg (3%), panel bg, odd-row, tooltip, control panel |
| `--ag-foreground-color` | `var(--vscode-foreground, #cccccc)` | border (mix 15%), secondary-border, header text (secondary-foreground), icon color, chip |
| `--ag-active-color` | `var(--vscode-focusBorder, #007fd4)` | row hover (mix 12%), selected row (mix 8%), checkbox checked, input focus border |
| `--ag-header-column-resize-handle-color` | `var(--vscode-panel-border, #3c3c3c)` | (không derive từ 3 root trên — map trực tiếp) |

**Input rule riêng (quan trọng nhất — đây là chỗ "trắng" lộ rõ nhất):** floating-filter inputs + filter menu inputs là `<input>`/`<textarea>` thật → UA stylesheet mặc định nền trắng chữ đen. Thêm rule specificity cao hơn element-rule của quartz:

```css
.ag-theme-quartz input.ag-input-field-input,
.ag-theme-quartz textarea.ag-input-field-input {
  background-color: var(--vscode-input-background, #2b2b2b);
  color: var(--vscode-input-foreground, #cccccc);
  border-color: var(--vscode-input-border, #3c3c3c);
}
```

Fallback colors là dark (`#1e1e1e`/`#cccccc`/`#2b2b2b`) để `.cache/webview-repro/aggrid.html` (body `#1e1e1e`) render đúng dark khi smoke test ngoài VS Code. Trong VS Code mọi `--vscode-*` đều được define → fallback không bao giờ dùng → light theme user vẫn thấy light grid (đúng yêu cầu "theo theme VS Code tôi dùng", không hard-code đen).

Rejected: `ag-theme-quartz-auto` (dark qua `prefers-color-scheme` OS — không phải VS Code theme, sai semantic); copy toàn bộ `ag-theme-quartz-dark` (không theo được light theme); map 20+ token riêng lẻ (thừa — color-mix đã derive).

### (b) Filter UX — Excel Text/Number Filters bằng Community

AG Grid **Set Filter (checkbox list per column) là ENTERPRISE-only** — bị từ chối vì: (1) licence thương phí vi phạm constraint MIT/Community-only của repo, (2) bundle Enterprise từ CDN vi phạm webview CSP. Trong Community, tương đương hành vi *Excel Text Filters* là `agTextColumnFilter` / `agNumberColumnFilter` với `filterOptions` tường minh + multi-condition AND/OR (`maxNumConditions: 2`) — chính là dropdown Excel "Text Filters → Contains / Equals / Begins With…" khi mở menu header.

Thiết kế trong `renderGrid()` (main.ts:419-435):
- `spec.kind === "number"` → `filter: "agNumberColumnFilter"`, `filterParams: { filterOptions: ["equals","notEqual","lessThan","lessThanOrEqual","greaterThan","greaterThanOrEqual","inRange","blank","notBlank"], defaultOption: "equals", maxNumConditions: 2, debounceMs: 200 }`
- kind string/boolean → `filter: "agTextColumnFilter"`, `filterParams: { filterOptions: ["contains","notContains","equals","notEqual","startsWith","endsWith","blank","notBlank"], defaultOption: "contains", maxNumConditions: 2, debounceMs: 200, caseSensitive: false }`
- Giữ `floatingFilter: true` (hàng filter nhanh trên đầu) + search box (user: filter hay hơn, nhưng search giữ làm phụ).

**Gate load-more khi column filter active (bug mới do feature này mở ra):** `quickFilterActive` (main.ts:123) chỉ track search box. Khi column filter lược bớt row hiển thị, `onBodyScroll` (main.ts:597) thấy "near bottom" → `dispatchLoadMore` → append thêm → vẫn filtered → lặp vô hạn fetch. Fix:
- Thêm `let colFilterActive = false;`
- Hook `onFilterChanged` trên grid (event option của `createGrid`, main.ts:493-515): `colFilterActive = api.isColumnFilterPresent()` (GridApi v36 method, đã verify `gridApi.d.ts:867`; quick filter không set cờ này).
- Gate 3 chỗ: `__checkLoadMore` (main.ts:551), `dispatchLoadMore` (main.ts:580), `onBodyScroll` (main.ts:597): thêm `|| colFilterActive`.
- Reset `colFilterActive = false` khi: grid recreate (tab switch / first render — filter model mất theo grid) và branch `statementReset || columnsChanged` (main.ts:519, columnDefs swap → filter không còn hợp lệ).
- Footer (main.ts:641): `const filtered = displayed !== loaded && (quickFilterActive || colFilterActive);`

### (c) Test strategy

`tsconfig` exclude `webview/` → lỗi TS trong webview chỉ bắt được qua esbuild compile + bundle test (pattern đã có: `src/ui/__tests__/webviewBundle.test.ts` eval `dist/webview.js` trong jsdom). TASK-401 test trên artifact `dist/webview.css` (CSS custom properties không cascade được trong jsdom `getComputedStyle` → assert trực tiếp trên shipped bundle: mapping present + đúng thứ tự cascade sau quartz defaults). TASK-402 test hành vi qua `window.__vsdb.gridApi.setFilterModel(...)` + `window.__vsdbCheckLoadMoreForHost()`.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy (401) | dist/webview.css chứa 4 mapping `--ag-*` → `--vscode-*` kèm fallback | mỗi var xuất hiện đúng 1 lần trong block override |
| edge-1 (401) | Thứ tự cascade: block override nằm SAU base quartz trong dist/webview.css | `indexOf(quartz base) < indexOf(override)` — sai thứ tự = override thua cascade |
| edge-2 (401) | Input rule `.ag-input-field-input` map `--vscode-input-background/foreground` | present — chống bug input trắng (UA default) |
| happy (402) | Column filter `setFilterModel({name:{filterType:"text",type:"contains",filter:"beta"}})` | displayed = 1, footer text "1 of 3" |
| happy (402) | Number filter `setFilterModel({id:{filterType:"number",type:"greaterThan",filter:2}})` | displayed = đúng subset số dòng thỏa điều kiện |
| edge-1 (402) | Batched (50 loaded / rowCount 1000) + column filter active + gọi `__vsdbCheckLoadMoreForHost()` | KHÔNG post `{type:"loadMore"}` — chặn vòng lặp fetch |
| edge-2 (402) | Clear filter (`setFilterModel(null)`) → checkLoadMore | loadMore ĐƯỢC post lại (transition on→off) |
| regression (402) | Cùng edge-1 chạy trên code hiện tại | RED: loadMore bị post khi filter active (bug repro) |
| happy (403) | version == 1.3.2, README bullet Results grid cập nhật (theme + Excel-style filter) | pass |
| boundary (403) | Full suite `npx vitest run` | 19+ files / 222+ tests pass (regression net cho cả cycle) |

## §5 Verification Commands

Scripts có thật trong `package.json`: `compile` (esbuild), `typecheck` (tsc --noEmit), `test` (vitest run). Không có lint script — N/A. Lưu ý: `typecheck` KHÔNG cover `webview/` (tsconfig exclude) — webview được verify qua `compile` (esbuild parse lỗi là fail) + bundle test.

- TASK-401: `npm run compile && npx vitest run src/ui/__tests__/webviewTheme.test.ts && npm run typecheck`
- TASK-402: `npm run compile && npx vitest run src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck`
- TASK-403: `npm run compile && npx vitest run` + version/README asserts (xem task file)

Wave boundary (W2): full `npx vitest run` bắt buộc — regression net.

## §6 Acceptance Criteria

- [ ] Grid + header + filter menu + floating filter input theo VS Code theme (dark user → dark; không hard-code) — TASK-401
- [ ] Mỗi cột dữ liệu có menu filter đa điều kiện kiểu Excel (text/number theo `ColumnSpec.kind`), AND/OR ≤2 conditions — TASK-402
- [ ] Column filter active → load-more bị chặn; clear filter → hoạt động lại; footer "X of Y" đúng khi column filter active — TASK-402
- [ ] Quick search box + floating filter row hành vi cũ không đổi (bundle test cũ vẫn pass) — TASK-402
- [ ] Version 1.3.2, README Results grid bullet cập nhật, full suite pass — TASK-403

## §7 Task Split

| ID | Title | Size | Deps | Wave | Files owns |
|---|---|---|---|---|---|
| TASK-401 | Grid theme theo VS Code (CSS var mapping) | S | none | 1 | webview/styles.css, src/ui/__tests__/webviewTheme.test.ts (new) |
| TASK-402 | Excel-like column filters + colFilterActive gating | M | none | 1 | webview/main.ts, src/ui/__tests__/webviewFilters.test.ts (new) |
| TASK-403 | Version 1.3.2 + README + full-suite boundary | S | 401, 402 | 2 | package.json, README.md |

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: nothing
Known gaps: none — visual verification cuối (mở VS Code thật) thuộc về user sau khi install vsix; smoke trong pipeline dùng .cache/webview-repro/aggrid.html + bundle tests (harness có sẵn từ cycle A).

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Plan Review Log

### Round 1 — 2026-08-22 · unic/unic-smart
Status: Approved

COMPLETENESS:
  - none — đủ 7 mục; task files TASK-401/402/403 có đủ 7 fields (ID/Title/Priority/Size/Deps/Wave/Files owns); test plan mỗi task ≥ happy + 2 edge khác loại (401: content + cascade-order; 402: loop-block + clear-transition + RED regression)
CONSISTENCY:
  - none — mọi claim đối chiếu code OK: main.ts:123 quickFilterActive, :493 createGrid, :550 __checkLoadMore, :578 dispatchLoadMore, :592 onBodyScroll, :519 columnsChanged branch, :641 footer; `isColumnFilterPresent()` đúng tại gridApi.d.ts:867 và quick filter không set cờ (isQuickFilterPresent riêng, :939); onFilterChanged là public event hợp lệ v36; quartz derive (header/menu/panel/border/hover/selected) từ đúng 4 root token qua color-mix (ag-theme-quartz.css:8-110); styles.css import SAU quartz (main.ts:21-23) → cascade cùng specificity thắng
CLARITY:
  - none — filterParams ghi tường minh theo kind (text vs number vs boolean→text), maxNumConditions/caseSensitive/debounceMs rõ; Community-only (Set Filter = Enterprise) ghi rõ kèm 2 lý do; không lint script là thật trong package.json → N/A hợp lệ
SCOPE:
  - none — W1 = 401 (styles.css + webviewTheme.test.ts) ∥ 402 (main.ts + webviewFilters.test.ts) file-disjoint; W2 = 403 (package.json + README.md) tách đúng
YAGNI:
  - none — 4 root token + 1 input rule là tối thiểu đúng (đã reject map 20+ token thừa vì color-mix tự derive); input rule dùng specificity cao hơn rule UA-white, đúng chỗ bug lộ rõ nhất

NOTES: 2 minor non-blocking cho executor: (1) §3(b) reset `colFilterActive = false` cứng trong branch `statementReset || columnsChanged` (main.ts:519) — nếu colId sống sót qua columnDefs swap, AG Grid giữ filter model mà không phát filterChanged → footer đếm lệch đến lần filter kế tiếp; nên gán `colFilterActive = gridApi.isColumnFilterPresent()` sau `setGridOption("columnDefs", …)` thay vì hard false. (2) Input rule set `border-color` nhưng quartz không set border-style/width cho `.ag-input-field-input` (ag-theme-quartz.css:239-263 chỉ min-height/radius/padding) — background/color vẫn fix đúng bug trắng, border có thể không hiện (cosmetic).

## Plan Review Log

### Round 1 — findings applied without re-review (2026-08-22 · orchestrator unic/unic-smart)
- Round 1 (PlanRevC, unic-smart): **Approved** — 0 blocking, 2 minor executor notes (colFilterActive re-poll sau columnDefs swap; input border cần border-style/width) → đã ghi chú vào TASK-402 Action.
- Post-approval additions (user reports 2+3, same cycle C scope, same files):
  - Double-checkbox mỗi dòng (user report #3): thêm Fix #3 vào TASK-402 Goal + test cases 6,7 — bỏ colDef `__select__`, dùng v36 `rowSelection.selectionColumnDef`.
  - Queued cycle D (user report #2 — edit/paste/export/ctid): ghi vào INDEX queued section, KHÔNG vào cycle C.
