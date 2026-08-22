# TASK-401 — Grid theme theo VS Code (CSS var mapping)

Cycle 2026-08-22-C · P0 · Size S · Deps: (none) · Wave 1

## Goal

Fix Results grid trắng trên VS Code dark theme: map AG Grid quartz root color tokens → `--vscode-*` CSS vars (kèm dark fallback) + style input filter chống nền trắng UA-default. Grid tự theo theme VS Code (dark → dark, light → light), KHÔNG hard-code đen.

## Action

1. `webview/styles.css` — mở rộng block `.ag-theme-quartz { ... }` hiện có (line 127-133, chỉ chứa sizing vars) thêm 4 root token mapping:
   - `--ag-background-color: var(--vscode-editor-background, #1e1e1e);`
   - `--ag-foreground-color: var(--vscode-foreground, #cccccc);`
   - `--ag-active-color: var(--vscode-focusBorder, #007fd4);`
   - `--ag-header-column-resize-handle-color: var(--vscode-panel-border, #3c3c3c);`
   (Quartz v36 tự derive ~20 màu còn lại từ 4 token này qua color-mix: header bg, menu bg, panel bg, border, row hover, selected row, checkbox… — KHÔNG map thêm token nào khác.)
2. Thêm rule riêng cho input filter (floating filter + filter menu là `<input>`/`<textarea>` thật, UA stylesheet cho nền trắng):

```css
.ag-theme-quartz input.ag-input-field-input,
.ag-theme-quartz textarea.ag-input-field-input {
  background-color: var(--vscode-input-background, #2b2b2b);
  color: var(--vscode-input-foreground, #cccccc);
  border-color: var(--vscode-input-border, #3c3c3c);
}
```

3. KHÔNG đổi: `--ag-row-height/--ag-header-height/--ag-grid-size/--ag-font-size/--ag-font-family` (giữ nguyên), các class non-grid khác.
4. Tạo test mới `src/ui/__tests__/webviewTheme.test.ts` (node-env, đọc file `dist/webview.css` — pattern load như webviewBundle nhưng không cần jsdom; chạy sau `npm run compile`).

## Target Files

- `webview/styles.css` — thêm 4 token mapping + 1 input rule (Task này OWN duy nhất file này)
- `src/ui/__tests__/webviewTheme.test.ts` — (new) test artifact bundle CSS

## Interfaces

- Consumes: (none — webview CSS vars `--vscode-*` do VS Code webview inject sẵn)
- Produces: (none — pure CSS, task khác không phụ thuộc symbol)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `dist/webview.css` chứa đủ 4 mapping `--ag-*: var(--vscode-*, fallback)` | mỗi mapping khớp regex `--ag-background-color:\s*var\(--vscode-editor-background,` v.v. xuất hiện ≥1 lần | `npm run compile` đã chạy |
| 2 | edge (cascade order) | Block override nằm SAU base quartz token trong bundle | `css.indexOf('--ag-background-color: #fff') < css.indexOf('--ag-background-color: var(--vscode-editor-background')` — esbuild giữ thứ tự import; sai thứ tự → override thua cascade → test fail | đọc dist/webview.css |
| 3 | edge (input rule, loại khác #2 — chống bug UA-white-input) | Rule `.ag-input-field-input` set `--vscode-input-background` + `--vscode-input-foreground` + `--vscode-input-border` | cả 3 declaration present trong cùng ruleset `input.ag-input-field-input, textarea.ag-input-field-input` | đọc dist/webview.css |

Ghi chú TDD: test fail khi file/chuỗi không có trong dist → RED trước khi sửa styles.css là hợp lệ (chạy compile với styles.css chưa sửa).

## Test Files

- `src/ui/__tests__/webviewTheme.test.ts` — (new) 3 test ở trên, pattern đọc-bundle như `src/ui/__tests__/webviewBundle.test.ts` (readFileSync `dist/webview.css`, skip-if-missing guard).

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewTheme.test.ts
npm run typecheck
```

(`typecheck` không cover webview/ — tsconfig exclude; webview verify qua compile + test trên artifact. Không có lint script trong package.json — N/A.)

## Acceptance Criteria

- [ ] 3 test PASS fresh
- [ ] `dist/webview.css` có 4 mapping + input rule đúng thứ tự cascade
- [ ] Quick filter input (floating filter row) không còn nền trắng trên dark theme
- [ ] `webviewBundle.test.ts` vẫn pass (không regression DOM)

## Dependencies

- (none — chạy song song TASK-402 ở wave 1, file disjoint)

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
