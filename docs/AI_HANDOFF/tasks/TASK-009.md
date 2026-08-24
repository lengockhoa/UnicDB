# TASK-009 (grid D+E) — Requery bar alignment + set-filter popup alignment

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 G4; spec `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` §D+§E

## Goal

2 fix visual: (D) WHERE/ORDER BY bar — label + input + nút nằm CHUNG 1 baseline thẳng hàng, đều nhau, đẹp; (E) set-filter popup — "Select All" + từng item align trái cùng indent, không lệch loạn xạ.

## Target Files

- `webview/styles.css` — thêm rules `.vsdb-requery-bar` (flex, align-items:center, gap đều), `.vsdb-requery-label`/`.vsdb-requery-input`/`.vsdb-requery-run`/`.vsdb-requery-clear` (đồng height 26px); set-filter alignment rules.
- `webview/main.ts` — CHỈ nếu cần: set-filter alignment qua themeQuartz params (thêm param vào `themeQuartz.withParams` tại main.ts:1371) hoặc bỏ qua nếu CSS override đủ. Markup requery bar (main.ts:715-748) KHÔNG đổi trừ khi cần thêm wrapper class.
- `tests/webviewRequeryAlignment.test.ts` (NEW) — jsdom + styles.css parse asserts.

## Spec

Hiện trạng (grep evidence): `webview/styles.css` KHÔNG có rule `vsdb-requery` nào (0 match) — bar render chỉ nhờ default styles ⇒ label/input/button không cùng baseline (user: "không có thẳng hàng... phải đều đẹp và nằm chung 1 hàng").

**D — CSS additions (styles.css):**
```css
.vsdb-requery-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
}
.vsdb-requery-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .04em;
  white-space: nowrap;
  line-height: 26px;          /* cùng baseline với input/button */
}
.vsdb-requery-input {
  height: 26px;
  line-height: 24px;
  box-sizing: border-box;
  min-width: 0;               /* flex-shrink trong hàng */
}
.vsdb-requery-input.vsdb-requery-where { flex: 1 1 40%; }
.vsdb-requery-input.vsdb-requery-order { flex: 0 1 28%; }
button.vsdb-requery-run, button.vsdb-requery-clear {
  height: 26px;
  flex: 0 0 auto;
}
```
(Tinh chỉnh theo biến theme VS Code hiện dùng trong file — giữ nhất quán `--vscode-*` vars pattern của `.vsdb-btn`.)

**E — Set-filter popup:** AG Grid v36 JS Theming — popup render trong shadow DOM? Kiểm tra: AG Grid community v36 dùng theming API, popup item class `.ag-set-filter-item`. CSS override từ ngoài shadow DOM không xuyên được → ưu tiên **theme params** (`themeQuartz.withParams({ setFilterListItem... })` — tham số có thể không tồn tại; investigator: đọc node_modules/ag-grid-community types `ThemeParamValues`/quartz params list, tìm param liên quan alignment/padding). Fallback nếu không có param: `options.getRootNode().appendChild(styleEl)` nội bộ (main.ts inject `<style>` vào grid container) — chấp nhận được vì chính webview kiểm soát DOM. Quyết định + evidence ghi Executor Report.

Acceptance cuối cùng là HUMAN visual check (jsdom không render thật) — executor screenshot qua webview harness nếu khả thi, không thì ghi "cần human check" trong Executor Report (đã được chấp nhận trong PLAN Known gaps #4).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | requery bar CSS: 1 baseline | parse styles.css: `.vsdb-requery-bar` có `align-items: center` + `display: flex`; `.vsdb-requery-label`,`.vsdb-requery-input`,`.vsdb-requery-run`,`.vsdb-requery-clear` đều khai báo height/line-height 26px (regex assert từng rule) | read webview/styles.css |
| 2 | edge | jsdom: bar element class tồn tại + computed align | render main.ts (esbuild transform) → element `.vsdb-requery-bar` tồn tại, getComputedStyle (jsdom limited: assert stylesheet rule applied qua matchMedia/inline — tối thiểu: class đúng + CSS rule match selector) | jsdom harness |
| 3 | edge | set-filter alignment rule/param tồn tại | styles.css có rule `.ag-set-filter-item` (hoặc main.ts có theme param setFilterListItem*/wrapper style injection — 1 trong 2 đường, assert file content) | read styles.css / main.ts |
| 4 | regression | theme params hiện có không vỡ | themeQuartz.withParams call vẫn chứa các param cũ (assert source chứa các param names cũ — không bị thay vô tình) | read main.ts:1371 region |

## Test Files

- `tests/webviewRequeryAlignment.test.ts` (NEW) — #1-#4 (jsdom + file-read asserts).

## Verification Commands

```bash
npx vitest run tests/webviewRequeryAlignment.test.ts src/ui/__tests__/resultsGridModelSetFilter.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test §Test Cases PASS.
- [ ] Requery bar: 1 hàng thẳng, label/input/button cùng baseline + gap đều (human check hoặc screenshot note).
- [ ] Set-filter popup: Select All + items trái cùng cột (human check note).
- [ ] Không thay đổi hành vi requery (requery message flow nguyên vẹn — resultsGridModelRequery tests pass).
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-007 (cùng đụng webview/main.ts + webview/styles.css region thêm mới; chạy sau để tránh conflict)

## Interfaces

- Consumes: requery bar markup + class names (webview/main.ts:715-748: `vsdb-requery-bar/-label/-input vsdb-requery-where/-input vsdb-requery-order/-run/-clear`); themeQuartz.withParams call site (main.ts:1371); TASK-007 styles.css conventions (var fallback).
- Produces: CSS rules `.vsdb-requery-*` (webview/styles.css) + set-filter alignment mechanism (theme param hoặc injected style). Không consumer trong cycle này.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: quyết định E (set-filter) phải dựa trên evidence thật: đọc `node_modules/ag-grid-community` types để xem quartz theme có param alignment cho set-filter items không. Nếu KHÔNG có param → dùng style injection vào grid host container (webview controls DOM). Đừng đoán param name — grep types trước. Ghi kết luận + đường đã chọn vào Executor Report.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
