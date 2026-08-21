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
Phase 3 executor append `## Executor Report` BÊN D�ỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-6
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 RUN  v4.1.11 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-001

 ❯ src/scaffold.test.ts (4 tests | 3 failed) 8ms
     × extension.ts exports activate function with correct signature 4ms
     × package.json manifest hợp lệ — đủ commands (≥ 10), keybindings, views, configuration 0ms
     × icon.png exists and >0 bytes 2ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 �⎯⎯⎯⎯⎯⎯

 FAIL  src/scaffold.test.ts > scaffold > extension.ts exports activate function with correct signature
Error: Cannot find module '/src/extension' imported from /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-001/src/scaffold.test.ts
 ❯ src/scaffold.test.ts:11:17
     11|     const ext = await import("../src/extension");
       |                 ^

 FAIL  src/scaffold.test.ts > scaffold > package.json manifest hợp lệ — đủ commands (≥ 10), keybindings, views, configuration
Error: ENOENT: no such file or directory, open '/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-001/package.json'
 ❯ src/scaffold.test.ts:18:31
     18|     const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
       |                               ^

 FAIL  src/scaffold.test.ts > scaffold > icon.png exists and >0 bytes
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/scaffold.test.ts:73:37
     73|     expect(fs.existsSync(iconPath)).toBe(true);
       |                                     ^

 Test Files  1 failed (1)
      Tests  3 failed | 1 passed (4)
```

Verification Output:
```
==========================================
VERIFICATION COMMAND 1/5: npm install
==========================================
> vsdb@0.1.0 install
added 403 packages, and audited 404 packages in 21s

113 packages are looking for funding
  run `npm fund` for details

4 vulnerabilities (2 moderate, 1 high, 1 critical)

==========================================
VERIFICATION COMMAND 2/5: npm run compile
==========================================
> vsdb@0.1.0 compile
> node esbuild.js

  dist/extension.js      1.2kb
  dist/extension.js.map  656b
⚡ Done in 3ms

  dist/webview.js      129b
  dist/webview.js.map  257b
⚡ Done in 3ms
esbuild: build complete

==========================================
VERIFICATION COMMAND 3/5: npx tsc --noEmit
==========================================
(tsc exit: 0)   -- no output, exit 0

==========================================
VERIFICATION COMMAND 3b/5: npx tsc --noEmit -p tsconfig.webview.json
==========================================
(tsc exit: 0)   -- no output, exit 0

==========================================
VERIFICATION COMMAND 4/5: npm test
==========================================
> vsdb@0.1.0 test
> vitest run

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-001

 ✓ src/scaffold.test.ts  (4 tests) 5ms

 Test Files  1 passed (1)
      Tests  4 passed (4)

==========================================
VERIFICATION COMMAND 5/5: node -e manifest check
==========================================
# Original task command:
node -e "const p=require('./package.json'); console.log(p.engines.vscode, p.main, p.commands.length)"
# Output (BUG in task spec — p.commands is undefined; VS Code uses p.contributes.commands):
TypeError: Cannot read properties of undefined (reading 'length')

# Equivalent correct check (commands live under contributes.commands):
node -e "const p=require('./package.json'); console.log('engines.vscode=' + p.engines.vscode, '| main=' + p.main, '| commands=' + p.contributes.commands.length)"
engines.vscode=^1.75.0 | main=dist/extension.js | commands=10

# Extended manifest check (all Test Case #2 assertions):
node -e "const p=require('./package.json'); console.log('engines.vscode:', p.engines.vscode, '| main:', p.main, '| contributes.commands.length:', p.contributes.commands.length, '| contributes.keybindings.length:', p.contributes.keybindings.length, '| views.vsdb.schemaTree:', Boolean(p.contributes.views && p.contributes.views.vsdb && p.contributes.views.vsdb.find(v=>v.id==='vsdb.schemaTree')), '| showRunLens:', p.contributes.configuration.properties['vsdb.showRunLens'].type, '| batchSize:', p.contributes.configuration.properties['vsdb.batchSize'].type)"
engines.vscode: ^1.75.0 | main: dist/extension.js | contributes.commands.length: 10 | contributes.keybindings.length: 2 | views.vsdb.schemaTree: true | showRunLens: boolean | batchSize: number

==========================================
BUILD OUTPUTS (dist/)
==========================================
dist/extension.js   1202 bytes
dist/extension.js.map  656 bytes
dist/webview.js     129 bytes
dist/webview.js.map  257 bytes

==========================================
ICON (media/)
==========================================
media/icon.png   256 bytes   PNG image data, 128 x 128, 8-bit/color RGB, non-interlaced
media/vsdb.svg   635 bytes   activity-bar icon (monochrome + blue arrow, used via mask)
```

Status: PASS

Note:
- Test Case #2 verification command in TASK-001 §Verification Commands references `p.commands.length` which is `undefined` — VS Code requires `p.contributes.commands`. Documented in report and substituted with equivalent correct check (10 commands confirmed).
- After first GREEN pass, keybindings were declared as two explicit entries (mac + win/linux) instead of one entry with platform overrides, so the test assertion `>= 2 keybindings for vsdb.runQuery` is satisfied naturally.
- `src/extension.ts` keeps the exact signature `export function activate(context: vscode.ExtensionContext): void` and `export function deactivate(): void` for TASK-007 to replace the body.
- Icon PNG generator (scripts/gen-icon.sh) writes a real 128x128 PNG even when neither rsvg-convert nor qlmanage is available — the python3 fallback always forces 128x128 output (ignoring SVG viewBox).
- `.gitignore` was appended (UKit block preserved verbatim) with `dist/`, `*.vsix`, `*.tsbuildinfo`.
- Acceptance: `dist/extension.js` + `dist/webview.js` generated; 4 vitest tests pass (placeholder + activate/deactivate + full manifest assertions + icon); all 10 commands / 2 keybindings / view container / schema tree / showRunLens+batchSize config present.
