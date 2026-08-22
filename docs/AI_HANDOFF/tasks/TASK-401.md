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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec401
SUMMARY: Added 4-token `--ag-*` → `--vscode-*` mapping (with fallbacks) + input filter rule (with border-style/width per reviewer note) in `webview/styles.css`; new test `src/ui/__tests__/webviewTheme.test.ts` validates cascade order and ruleset contents against `dist/webview.css`.
TEST_PLAN_FOLLOWED: task §Test Cases (3 tests: 1 happy + 2 edge — cascade order, input rule with border-style/width)
FILES_CHANGED:
  - webview/styles.css: added 2 new rulesets after line 133 (4 root token mappings + 1 input ruleset with border-color/-style/-width)
  - src/ui/__tests__/webviewTheme.test.ts: (new) 3 test cases reading dist/webview.css
TESTS_ADDED:
  - src/ui/__tests__/webviewTheme.test.ts: "maps the 4 quartz root tokens to --vscode-* with fallbacks", "override block sits AFTER any base quartz `--ag-background-color: #fff` so cascade wins", "input rule declares --vscode-input-background, --vscode-input-foreground, --vscode-input-border together"
VERIFICATION:
  command: npx vitest run src/ui/__tests__/webviewTheme.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck
  result: 11 pass / 0 fail (3 new + 8 existing) ; typecheck exit 0
  output_excerpt: |
    ✓ src/ui/__tests__/webviewTheme.test.ts  (3 tests) 2ms
    ✓ src/ui/__tests__/webviewBundle.test.ts  (8 tests) 883ms
    Test Files  2 passed (2)
    Tests  11 passed (11)
    > vsdb@1.3.1 typecheck
    > tsc --noEmit
ISSUES: none — RED was confirmed before GREEN: 3/3 tests failed for expected reasons (no mapping, override at -1 vs base at 52695, no input ruleset), then passed after CSS edit. Esbuild's import order (ag-grid base quartz CSS → webview/styles.css in webview/main.ts) naturally places the override after the base, satisfying test #2.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review (reviewer must use a different model per handoff policy)
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart (matches handoff.reviewer.model=unic-smart)
EXECUTOR_MODEL: unic-code (differs — isolation OK)
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/webviewTheme.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck
  result: 11 pass / 0 fail (3 theme + 8 bundle); typecheck exit 0; compile OK
TEST_PLAN_COVERAGE: all-followed (3/3: happy mapping regexes; edge cascade order — verified in dist: base `#fff` at lines 1112+7376, override at 8880 (last); edge input ruleset asserts 5 declarations incl. border-style/width per plan-reviewer note; RED evidence có concrete indices -1 vs 52695)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ui/__tests__/webviewTheme.test.ts:62-70 — khi ag-grid đổi base CSS và bỏ `--ag-background-color: #fff`, test #2 tự hạ cấp thành existence check (branch baseIdx === -1) → cascade-order guarantee silently mất. Đã có comment giải thích, chấp nhận được; nếu muốn chặt hơn thì expect base present thay vì fall-through.
    - webview/styles.css fallback colors là dark-only (#1e1e1e...) — đúng spec task (kèm dark fallback; VS Code luôn inject --vscode-* nên fallback hầu như không dùng). Không cần sửa.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: CSS mapping đúng 4 token spec, không map thêm; input rule có đủ border-color/style/width; sizing vars cũ giữ nguyên (diff 0 deletion). Selector `ag-input-field-input` unique trong dist nên regex test #3 khớp đúng ruleset.
