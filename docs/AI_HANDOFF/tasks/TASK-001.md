# TASK-001 — Project scaffold: package.json + esbuild + vitest + icon

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §7

## Goal

Tạo skeleton VS Code extension VSDB: manifest package.json khai báo ĐẦY ĐỦ mọi contributions (commands, keybindings, menus, views, configuration), cấu hình esbuild bundle (main + webview), vitest, tsconfig, .vscodeignore, icon 128×128, .gitignore bổ sung, Makefile. `npm run compile` + `npm test` phải xanh với extension entry stub + 1 placeholder test.

## Target Files

- `package.json` — manifest đầy đủ: name `vsdb`, publisher `lengockhoa`, engines.vscode `^1.75.0`, main `dist/extension.js`, activationEvents, 10 commands (`vsdb.addConnection`, `vsdb.editConnection`, `vsdb.deleteConnection`, `vsdb.selectConnection`, `vsdb.runQuery`, `vsdb.cancelQuery`, `vsdb.generateSelect`, `vsdb.copyQualifiedName`, `vsdb.refreshSchema`, `vsdb.runStatement` cho CodeLens), keybindings `cmd+enter`+`ctrl+enter` → `vsdb.runQuery` (when `editorTextFocus && resourceLangId == sql`), menus: `editor/title` (nút ▶ khi sql), `view/item` (schema tree context menu), `view/title`; `viewsContainers.activitybar` id `vsdb` icon `media/vsdb.svg`; `views.vsdb` id `vsdb.schemaTree` type tree; `configuration` với `vsdb.showRunLens` (boolean, default true) và `vsdb.batchSize` (number, default 500); scripts: `compile`, `watch`, `test` (vitest run), `test:integration`, `typecheck`, `package` (vsce package), `vscode:prepublish` = `npm run compile`; devDeps: typescript, esbuild, vitest, @types/vscode@1.75.0, @vscode/vsce; deps: pg, mysql2, tedious, @types/pg.
- `tsconfig.json` — `target ES2022`, `module commonjs` (extension) + project reference hoặc tsconfig riêng cho webview nếu cần; `strict: true`, `outDir dist`.
- `esbuild.js` — build 2 entry: `src/extension.ts` → `dist/extension.js` (platform node, external vscode, format cjs, bundle) và `webview/main.ts` → `dist/webview.js`; minify prod.
- `src/extension.ts` — stub `export function activate() {}` / `deactivate()` (TASK-007 thay bằng wiring thật).
- `webview/main.ts`, `webview/grid.ts`, `webview/styles.css` — placeholder rỗng (TASK-006 fill).
- `vitest.config.ts` — include `src/**/*.test.ts`, exclude `*.integration.test.ts`.
- `vitest.integration.config.ts` — include `src/adapters/__tests__/*.integration.test.ts`, testTimeout 30s.
- `src/scaffold.test.ts` — placeholder test (import extension activate, expect typeof function).
- `.vscodeignore` — loại `src/`, `webview/`, `tests/`, `docker/`, `node_modules/`, `docs/`, `.cache/`, `*.map` (nếu không sourcemap).
- `media/icon.png` (128×128) + `media/vsdb.svg` (activity bar icon, đơn sắc dùng mask) — trụ database + mũi tên xanh; script generate `scripts/gen-icon.sh` dùng sẵn `rsvg-convert`/`sips` hoặc commit PNG trực tiếp từ SVG viết tay.
- `Makefile` — targets: `build`, `watch`, `test`, `package`, `db-up`, `db-down`. `db-up`/`db-down` chạy `docker compose -f docker/docker-compose.yml up -d` / `down`.
- `.gitignore` — bổ sung `dist/`, `*.vsix` (giữ nguyên các dòng UKit hiện có).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | Placeholder vitest chạy được | `npm test` exit 0, 1 test pass | scaffold mới |
| 2 | edge | package.json manifest hợp lệ | script node parse JSON + assert đủ keys: main, engines.vscode, commands ≥ 10, keybindings có cmd+enter & ctrl+enter, views.vsdb.schemaTree tồn tại | `package.json` vừa tạo |
| 3 | edge | tsconfig strict không vỡ stub | `npx tsc --noEmit` exit 0 | scaffold mới |

## Test Files

- `src/scaffold.test.ts` — placeholder + manifest assertions (đọc package.json bằng fs).

## Verification Commands

```bash
npm install
npm run compile
npx tsc --noEmit
npm test
node -e "const p=require('./package.json'); console.log(p.engines.vscode, p.main, p.commands.length)"
```

## Acceptance Criteria

- [ ] `npm run compile` sinh `dist/extension.js` + `dist/webview.js`.
- [ ] `npm test` PASS (≥2 test).
- [ ] Manifest chứa đủ commands/keybindings/menus/views/configuration như Goal.
- [ ] Icon `media/icon.png` 128×128 tồn tại (file >0 byte).
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces:
  - `package.json` contributions: commands `vsdb.addConnection|editConnection|deleteConnection|selectConnection|runQuery|cancelQuery|generateSelect|copyQualifiedName|refreshSchema|runStatement`; config `vsdb.showRunLens: boolean`, `vsdb.batchSize: number`.
  - `src/extension.ts` stub: `export function activate(context: vscode.ExtensionContext): void` — TASK-007 thay nội dung, GIỮ signature.
  - Build outputs: `dist/extension.js` (main), `dist/webview.js`.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
