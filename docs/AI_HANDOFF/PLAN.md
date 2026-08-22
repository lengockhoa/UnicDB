# PLAN — Results Panel: thay VirtualGrid bằng AG Grid Community + fix Cancel

Cycle: 2026-08-22-A · Base: main · Planner: Planner (unic-smart)

## §1 Intent

**Vấn đề (3 bug đã verify trong browser thật, xem `.cache/webview-repro/scroll.html`):**
1. Grid trống ở viewport trên — custom `VirtualGrid` (webview/grid.ts) rebuild DOM khi state mới đến, rAF render với stale scrollTop → startIdx quá lớn → 0 rows render (đo thực tế: scrollTop=471 stale, rowsRendered=0).
2. Chạy SELECT mới → không thấy gì (cùng cơ chế stale-scroll).
3. Nút Cancel disable trong khi loadMore đang fetch — host không `setBusy(true)` quanh `runner.loadMore()`.

**Yêu cầu user:** dùng AG Grid ("bộ đó cực kỳ tốt, display + filter tốt"). Reference UI (QAS tool nội bộ) yêu cầu: per-column filter, sortable, row selection (checkbox), search box, ellipsis truncation cho cột dài (UUID/JSON), row count "176 row(s)", footer bar.

**Success definition:** Results panel dùng AG Grid Community (bundle local qua esbuild, không CDN) hiển thị mọi StatementResult; sort/filter/quick-filter/selection/copy hoạt động; batched infinite scroll (loadMore) tiếp tục hoạt động; 3 bug trên biến mất; Cancel enabled + hủy được fetch đang chờ; version 1.3.0.

## §2 Scope

**In scope:**
- `ag-grid-community` (MIT, ^36.1.0) qua npm, bundle vào `dist/webview.js` (iife, es2022, browser) + CSS (ag-grid.css + theme Quartz) bundle vào `dist/webview.css` qua esbuild CSS import. KHÔNG CDN (CSP chỉ cho `cspSource`).
- Pure-logic module `src/ui/resultsGridModel.ts`: column inference, loadMore state machine + in-flight gate, append-delta, cancel-more, copy text, footer text — unit test không cần AG Grid thật.
- `webview/main.ts`: thay `VirtualGrid` bằng AG Grid (client-side row model + `applyTransaction` append — xem §3), toolbar thêm search box (quick filter), giữ tabs + Messages tab + ok-message non-SELECT + copy protocol.
- Host: `resultsPanel.ts` bọc `setBusy(true/false)` quanh loadMore; cancel-during-loadMore không toast error.
- Version 1.3.0 + README feature bullet + build vsix (release GitHub do orchestrator).

**Out of scope:**
- Enterprise features (range selection, clipboard service, set filter, side bar) — license trả phí, CẤM.
- Sửa queryRunner.ts (cancel-during-loadMore đã hoạt động qua `currentBatched`; không đụng).
- Schema Explorer, connection form, adapters, parser.
- Edit-table features từ reference UI (Commit/paste-Excel/CSV toggle) — read-only results cycle.
- Đổi message protocol `src/ui/messages.ts` (đóng băng).

**File ownership (không task cùng wave share file):**
- W1: TASK-201 (package.json, package-lock.json, webview/main.ts-chỉ-css-imports, src/ui/__tests__/agGridSmoke.test.ts) · TASK-202 (src/ui/resultsGridModel.ts, src/ui/__tests__/resultsGridModel.test.ts) · TASK-204 (src/ui/resultsPanel.ts, src/ui/__tests__/resultsPanel.test.ts) — disjoint tuyệt đối.
- W2: TASK-203 (webview/main.ts, webview/styles.css, webview/grid.ts [delete], esbuild.js, src/ui/__tests__/webviewBundle.test.ts, .cache/webview-repro/aggrid.html) — deps 201+202.
- W3: TASK-205 (package.json version, README.md) — deps 201+203+204.

## §3 Approach

**Lựa chọn cốt lõi — client-side row model + append transaction, KHÔNG dùng Infinite Row Model.** Mọi state message từ host đã mang **toàn bộ** rows đã load (`r.result.rows` đầy đủ, không phải window). Dữ liệu luôn memory-resident trong webview:
- Client-side model: AG Grid tự virtualize rendering (hết cửa bug windowing tự viết), sort/filter/quick-filter LOCAL trên toàn bộ rows đã load (đúng constraint "sort/filter local trên loaded rows"). Infinite Row Model chỉ sort được trên block đã fetch và `refreshInfiniteCache` chính là lớp rủi ro reset scroll — cùng họ bug đang fix.
- LoadMore: `onBodyScroll` → `checkLoadMore()`: nếu `model` còn `hasMore`, không có quick filter active, và `api.getLastDisplayedRow() >= loaded - 10` → `postToHost({type:'loadMore', index})`. Gate 1-lần nằm trong model (onNeedMore dedup đến khi state mới về).
- State mới về: `model.sync(index, …)` → nếu cùng statement (không reset) và rows tăng → `api.applyTransaction({add: delta, addIndex})` — KHÔNG `setRowData` → scroll position giữ nguyên (bug 1+2 chết).
- Query mới (reset): `shouldResetGrid(results)` = có bất kỳ status `'running'` → `model.reset()` + `setRowData` + scroll top.

**Bundle/CSS:** `webview/main.ts` import `ag-grid-community/styles/ag-grid.css` + `ag-theme-quartz.css` + `./styles.css` (custom override đứng cuối). esbuild tự emit CSS imports → `dist/webview.css`, ghi đè bản copy từ `copyWebviewCss()` (chạy trước build). Nếu package exports không resolve `ag-grid-community/styles/*`, fallback import relative `../node_modules/ag-grid-community/styles/*.css`. TASK-203 xóa hẳn `copyWebviewCss()` (clean cutover). `connectionForm` link `dist/webview.css` — styles.css nằm trong bundle nên form không mất style; TASK-203 chỉ xóa rule `.vsdb-grid*` của VirtualGrid, giữ mọi selector connection form đang dùng.

**Grid features (Community, đúng reference UI):** `sortable:true, filter:true, resizable:true` mọi cột; `floatingFilter:true` (text filter — icon/row filter từng cột); `rowSelection:{mode:'multiRow', checkboxes:true, headerCheckbox:true}`; toolbar search input → `api.setQuickFilter(text)`; ellipsis qua `cellStyle` + `valueFormatter: formatCell` + `enableBrowserTooltips` (hover thấy full UUID/JSON); footer `N row(s)` từ `api.getDisplayedRowCount()` (event `modelUpdated`). Copy: range selection là Enterprise → dùng row checkboxes + handler keydown Ctrl/Cmd+C trên grid host → `selectionToText(selectedRows)` (tab-separated) → `postToHost({type:'copy'})` — giữ protocol cũ.

**Column mapping:** cells đã sanitize sẵn (BigInt→string/number, Date→ISO) nên kinds thực tế: number/boolean/string. `inferColumns(columns, rows)` lấy first non-null cell mỗi cột → `ColumnSpec{field, headerName, kind, alignRight}`. `formatCell` giữ nguyên hành vi, dời verbatim từ `webview/grid.ts` vào model module.

**Host busy/cancel (TASK-204):** `handleMessage('loadMore')` → `setBusy(true)` → `await runner.loadMore()` → post state → `finally setBusy(false)`. Webview Cancel button `disabled=!busy` → giờ enabled đúng lúc batch đang fetch. Cancel-during-loadMore: fetchBatch reject (cursor đã cancel qua `currentBatched`) → catch: nếu `runner.isCancelled()` hoặc message khớp /cancel/i → nuốt toast, chỉ re-post state; lỗi thật khác → toast như cũ.

**Trade-offs:** vsix phình ~1MB (ag-grid min) — chấp nhận cho chất lượng grid production. jsdom test cho bundle thật hơi chatty (stub ResizeObserver) nhưng cho regression net thật cho bug 1/2 mà không cần VS Code.

**Alternatives rejected:** (a) Infinite Row Model — xem trên; (b) fix VirtualGrid windowing — bug ở thiết kế rebuild-DOM, AG Grid thay thế rẻ hơn sửa; (c) CDN JS/CSS — vi phạm CSP webview; (d) Enterprise — license trả phí.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| unit (201) | ag-grid smoke jsdom | createGrid + rowData 3 dòng → `getDisplayedRowCount()===3` |
| unit (202) | inferColumns | int/bigint-sample cột → kind number + alignRight; string/date-ISO → string; boolean → boolean |
| unit (202) | loadMore gate | requestWindow vượt loaded + hasMore → onNeedMore fire ĐÚNG 1 lần; gọi lại trước sync → không fire lần 2 |
| unit (202) | append delta + EOF | sync thêm 500 rows → appendDelta trả đúng 500 rows mới; EOF → total=rows.length |
| edge (202) | cancelMore | sau cancelMore(), requestWindow đáy không bao giờ fire onNeedMore |
| unit (202) | selectionToText | 2 rows × 2 cols → `a\tb\nc\td`; null cell → chuỗi rỗng |
| unit (202) | shouldResetGrid/footerText | có status running → true, all-terminal → false; footer batched vs filtered exact strings |
| bundle (203) | 3 statements render | state msg (select 200 rows + insert ok-message + error) → 4 tabs, `getDisplayedRowCount()===200`, ok-message element tồn tại |
| edge (203) | reset query mới (bug 2) | state 200 rows → state running → state 50 rows → count===50, không stale |
| edge (203) | batched loadMore (bug 1) | state 500 batched → `checkLoadMore()` → postToHost nhận `loadMore`; state 1000 rows → applyTransaction add (count 1000, không setRowData toàn bộ) |
| unit (204) | busy quanh loadMore | busy:true postMessage gửi TRƯỚC khi runner.loadMore resolve; busy:false + state sau |
| edge (204) | cancel trong loadMore | loadMore reject "cancelled" → KHÔNG showErrorMessage; busy:false |
| edge (204) | lỗi thật | loadMore reject generic → showErrorMessage "Load more failed: …" |
| regression (204) | full resultsPanel suite | các test cũ (sanitize BigInt, postMessage rejection) vẫn pass |
| smoke (205) | version + package | `package.json` 1.3.0; `npm run package` sinh vsdb-1.3.0.vsix |

## §5 Verification Commands

Không có lint script trong repo (scripts: compile/watch/test/test:integration/typecheck/package) → typecheck là gate thay thế, bắt buộc trong mọi task.

```bash
# TASK-201
npm install && npx tsc --noEmit && npx vitest run src/ui/__tests__/agGridSmoke.test.ts && npm run compile
# TASK-202
npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts
# TASK-203
npm run compile && npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/webviewBundle.test.ts
# TASK-204
npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsPanel.test.ts
# TASK-205
npx tsc --noEmit && npx vitest run && npm run compile && npm run package
# Wave boundary (mọi task): npx vitest run   # full suite regression net
```

## §6 Acceptance Criteria

- [ ] Grid AG Grid hiển thị rows ở MỌI scroll position; SELECT mới thay grid ngay không stale (bug 1, 2 chết — TASK-203)
- [ ] Per-column filter (floating text filter), sort, resize, checkbox selection, search box quick filter, ellipsis + tooltip, footer "N row(s)" (TASK-203)
- [ ] Batched infinite scroll: cuộn gần đáy → loadMore → rows append, scroll không nhảy (TASK-202+203)
- [ ] Cancel enabled trong lúc loadMore fetch; click hủy được fetchBatch đang chờ; không toast lỗi cancel (TASK-204)
- [ ] Non-SELECT ok-message, statement tabs, Messages tab, copy tab-separated, BigInt/Date sanitize — giữ nguyên (TASK-203, regression suite)
- [ ] `npx tsc --noEmit` + `npx vitest run` full pass; `npm run compile` 3 bundles + webview.css chứa AG Grid CSS (TASK-201/203)
- [ ] Version 1.3.0, vsix build được (TASK-205)

## §7 Global Constraints

- AG Grid **Community only**: cấm import `ag-grid-enterprise`, cấm range selection/clipboard service/set filter/license key.
- Cấm load JS/CSS từ CDN — mọi asset qua esbuild bundle (CSP `script-src cspSource`).
- Message protocol `src/ui/messages.ts` đóng băng: state/busy/loadMore(index)/cancel/copy(text)/ready.
- Pure logic phải sống ở `src/ui/resultsGridModel.ts` (trong tsc include) — webview/main.ts KHÔNG được typecheck bởi tsc (tsconfig include src/**), rủi ro type phải chặn bằng compile + bundle test.
- npm (không yarn); không thêm devDep nào ngoài `jsdom`.
- Version bump đúng rule user: giữa = major update → 1.2.2 → 1.3.0.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (a) TASK-201 phải thêm css imports vào main.ts ngay ở W1 để pipeline CSS được chứng minh thật (chứ không đợi W2); (b) bỏ ý sửa queryRunner.ts — cancel-during-loadMore đã reachable qua `currentBatched` (queryRunner.ts:276), TASK-204 chỉ đụng resultsPanel; (c) chốt client-side row model thay Infinite Row Model — data memory-resident, ghi rõ rationale §3; (d) tsconfig không typecheck webview/ — phát hiện và ghi vào §7.
Known gaps: (1) Selector CSS nào của styles.css thuộc connection form chưa liệt kê từng dòng — TASK-203 chỉ được XÓA rule `.vsdb-grid*`/`.vsdb-scroll*`/`.vsdb-spacer*`/`.vsdb-viewport*` (VirtualGrid-only), mọi thứ khác giữ; connectionForm regression = test suite + mở form thủ công. (2) ag-grid `styles/*` exports-map resolve chưa verify cục bộ (không install trong planning) — fallback relative-path import đã ghi trong TASK-201 Discussion. (3) Browser smoke cuối (Playwright/`.cache/webview-repro/aggrid.html`) là của orchestrator trước release, không phải gate executor.

## Plan Review Log

### Round 1 — 2026-08-22 · unic-smart (PlanRev2)

Status: Approved

COMPLETENESS:
  - none — bugs, approach, waves, file ownership, tests, commands, version bump all specified; known gaps self-declared and acceptable.
CONSISTENCY:
  - minor (advisory): §3 + Self-Audit gap (1) delete-glob `.vsdb-grid*` also matches `.vsdb-grid-footer` (webview/main.ts:185) and `.vsdb-grid-host` (main.ts:150) which must be KEPT — TASK-203.md line 15 already says "footer `.vsdb-grid-footer` giữ" and re-adds `.vsdb-grid-host`; task text governs, executor must not glob-delete those two.
CLARITY:
  - minor (advisory): §7 "rủi ro type phải chặn bằng compile + bundle test" overstates esbuild — esbuild transpiles without type diagnostics (catches only resolve/syntax errors). The real net is the jsdom smoke/bundle tests; `npm run compile` passing must not be read as type safety.
SCOPE:
  - none — Results panel + version only; out-of-scope list explicit (queryRunner, protocol, adapters, Enterprise).
YAGNI:
  - none — every feature maps to reference-UI/user requirements; Enterprise/CDN/protocol changes rejected.

NOTES: Plan claims cross-checked against repo: tsconfig excludes webview/ and **/*.test.ts (so tsc never sees AG Grid types — plan's mitigation acknowledged); package.json has no lint script, typecheck gate correct; messages.ts matches frozen set; cancel-during-loadMore reachable via currentBatched (queryRunner.ts:274) and isCancelled() exists (queryRunner.ts:78); styles.css `.vsdb-row` is connectionForm-only and untouched by deletion list. Minor items are advisory — task files disambiguate; no flawed build expected.
