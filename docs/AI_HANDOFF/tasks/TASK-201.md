# TASK-201 — ag-grid-community dependency + bundle pipeline

Status: ready
Owner: -
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Cài `ag-grid-community` (MIT, ^36.1.0) qua npm, chứng minh esbuild bundle JS (iife) + CSS (ag-grid.css + theme Quartz) vào `dist/webview.js` / `dist/webview.css` mà không CDN, kèm smoke test jsdom chạy grid thật.

## Target Files

- `package.json` + `package-lock.json` — thêm dependency `ag-grid-community: ^36.1.0` + devDependency `jsdom` (cho vitest)
- `webview/main.ts` — CHỈ THÊM 2 dòng import CSS (xuống đầu file): `import "ag-grid-community/styles/ag-grid.css";` và `import "ag-grid-community/styles/ag-theme-quartz.css";`. TUYỆT ĐỐI không sửa logic khác (TASK-203 sở hữu phần còn lại).
- `src/ui/__tests__/agGridSmoke.test.ts` (new) — jsdom smoke grid thật

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | happy | createGrid render 3 rows | jsdom + `createGrid(el, {columnDefs:[{field:'a'},{field:'b'}], rowData:[{a:1,b:'x'},{a:2,b:'y'},{a:3,b:'z'}]})` → `api.getDisplayedRowCount() === 3` |
| 2 | happy | quartz CSS bundle chứa grid css | đọc `dist/webview.css` sau compile → chứa `.ag-theme-quartz` và `.ag-root` (minified ok — grep prefix) |
| 3 | edge | grid rỗng không throw | `rowData: []` → `getDisplayedRowCount() === 0`, no exception |

## Test Files

- `src/ui/__tests__/agGridSmoke.test.ts` (new)

## Verification Commands

```bash
npm install && npm run compile && npx tsc --noEmit && npx vitest run src/ui/__tests__/agGridSmoke.test.ts
```

(vitest.config.ts cần `environment: "jsdom"` cho file này — dùng `// @vitest-environment jsdom` pragma trong test file, không đổi config global. Stub `ResizeObserver` + `matchMedia` trước `createGrid`.)

## Acceptance Criteria

- [ ] `package.json` có `ag-grid-community` ^36.1.0 dependencies, `jsdom` devDependencies
- [ ] `npm run compile` pass; `dist/webview.js` chứa bundle ag-grid (grep `ag-grid` trong dist); `dist/webview.css` chứa `.ag-theme-quartz`
- [ ] `dist/webview.css` KHÔNG chứa URL `http`/`https` tới CDN (grep `https?://` không match asset remote)
- [ ] 3 test smoke pass
- [ ] styles.css custom (`.vsdb-*`) vẫn nằm cuối `dist/webview.css` (import thứ tự đúng)

## Dependencies

none

## Interfaces

Produces: npm package `ag-grid-community` cài sẵn; CSS imports trong `webview/main.ts` (TASK-203 giữ 2 dòng này); `dist/webview.css` giờ là bundle output của esbuild (TASK-203 xóa `copyWebviewCss()`).

## Discussion

### 2026-08-22 · planner · unic-smart
Nếu `import "ag-grid-community/styles/ag-grid.css"` không resolve (exports map của ag-grid có thể không expose `./styles/*`): fallback import relative từ webview: `import "../node_modules/ag-grid-community/styles/ag-grid.css"` — esbuild chấp nhận. Ghi nhận fallback nào dùng được vào Executor Report.
