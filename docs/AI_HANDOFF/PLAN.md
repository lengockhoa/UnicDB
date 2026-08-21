# Handoff Plan

Status: `active`
Cycle: `2026-08-21-A`

## 1. Intent / Goal

Xây **VSDB v1** — VS Code extension chạy SQL trực tiếp từ editor (PostgreSQL / MySQL(MariaDB) / SQL Server) theo design doc đã duyệt `docs/plans/2026-08-21-vsdb-extension-design.md`. Yêu cầu gốc của user: **"một version chạy được đã, tôi sẽ tự improve sau"** — tức v1 phải hoàn chỉnh end-to-end và cài được lên máy team (vsix + install script), KHÔNG phải làm mọi tính năng nice-to-have. Ngôn ngữ giao diện extension (README, thông báo): tiếng Việt (theo ngôn ngữ repo).

Phải chạy được: connection CRUD (SecretStorage/WorkspaceState, không file config trong repo), Cmd+Enter/Ctrl+Enter chạy selection hoặc statement tại con trỏ, grid kết quả webview (tabs/statement, load-more 500, cancel), status bar, Schema Explorer tree, CodeLens ▶ Run, đóng gói vsce → GitHub Releases + install script 1 dòng cho team.

## 2. Scope

- In scope (v1):
  - Scaffold TypeScript + esbuild + vitest + vsce packaging
  - Types (`ConnectionConfig`, `DriverType`) + statement parser thuần (string literal, dollar-quote, comment, BEGIN..END)
  - DbAdapter interface + 3 adapter (pg server-side cursor; mysql2/tedious streaming cùng một AsyncIterable batch 500 rows)
  - Metadata queries: tables/views/routines/columns cho cả 3 DB
  - ConnectionManager: add/edit/delete, test-connect trước khi lưu, active connection theo workspace, idle timeout 10 phút
  - queryRunner (AsyncIterable, batch 500, cancel) + results webview panel (tabs, virtual scroll, Load 500 more, Messages, copy tab-separated)
  - Schema tree (Activity Bar, lazy load, context menu Generate SELECT / Copy qualified name / Refresh)
  - Cmd+Enter + nút ▶ title bar + CodeLens `vsdb.showRunLens` (mặc định bật — parser đã có ranges nên phí thêm rất ít)
  - Icon 128×128, README tiếng Việt, `scripts/build.sh`, `scripts/install-vsdb.sh` (curl | bash, detect latest release, fallback CLI path macOS)
- Out of scope (để cycle sau): export CSV/Excel, edit data trong grid, ER diagram, sync connection nhiều máy, multi-workspace fancy, publish Marketplace, query history, format SQL; Load all button (deferred to v1.1 — Load 500 more is enough for v1); Metadata cache 60s in schema tree + manual test checklist for grid UI (deferred).
- Risk surface (file share giữa task):
  - `docker/docker-compose.yml` — TASK-003 tạo một lần với đủ 3 service (postgres/mysql/mssql); TASK-004 chỉ REUSE, không sửa → khác wave nên không conflict.
  - `src/adapters/types.ts` — TASK-003 tạo; TASK-004 chỉ consume.
  - `package.json` — TASK-001 tạo full manifest (commands/keybindings/menus/views/config); TASK-008 chỉ bump version + repository/publisher metadata. Không task nào khác được đụng.
  - `src/extension.ts` — chỉ TASK-001 (stub) và TASK-007 (wiring thật) đụng; khác wave.

## 3. Approach

Theo design doc §2: TypeScript, esbuild bundle (`--bundle --platform=node --external:vscode --format=cjs`), drivers pg/mysql2/tedious (pure-JS, bundle sạch). Adapter pattern — 3 driver cùng interface `DbAdapter`; grid code uniform qua batch-500 AsyncIterable.

Quyết định kỹ thuật đã chốt (executor KHÔNG tự đổi):
- **Test framework: vitest** — dùng chung pipeline transform với esbuild (không phải cấu hình ts-node/register như mocha), watch nhanh, đủ cho cả unit + integration. Mocha sẽ thêm 1 lớp cấu hình TS không cần thiết.
- **engines.vscode `^1.75.0`, `@types/vscode` pin `1.75.0`** — floor bảo thủ; mọi API dùng tới (TreeDataProvider, WebviewPanel, CodeLens, SecretStorage) có từ ≤1.72. Máy dev 1.132 chạy thoải mái.
- **Bundling: bundle mọi thứ trừ `vscode`**. `.vscodeignore` loại `src/`, `webview/`, `tests/`, `docker/`, `node_modules/`, `docs/`.
- **Streaming adapter (thống nhất, grid code không biết driver nào):** Postgres = `pg` cursor API; MySQL = `mysql2` `query().stream()`; MSSQL = `tedious` `request.on('row')` gom batch. Cả 3 expose `fetchBatch(): Promise<any[] | null>` (null = hết) bên trong `runQuery(sql): AsyncIterable<QueryResult>`. KHÔNG dùng re-execute-để-load-more. Nếu streaming 1 driver hỏng runtime → adapter tự fallback batch nội bộ nhưng GIỮ NGUYÊN interface.
- **Webview:** HTML/CSS/JS thuần (webview/main.ts, grid.ts, styles.css), không React — v1 chỉ cần grid + tabs; virtual scroll tự viết render ~30 rows.
- **Contributions khai báo ĐẦY ĐỦ trong package.json ngay từ TASK-001** (commands, keybindings cmd+enter/ctrl+enter, menus editor/title + view/item, viewsContainers activitybar, views, configuration `vsdb.showRunLens`/`vsdb.batchSize`) — task sau chỉ implement handler, không đụng package.json (tránh conflict).

Wave structure (không task cùng wave share file):
- W1: TASK-001 (scaffold)
- W2: TASK-002 (parser) ∥ TASK-003 (DbAdapter + postgres + docker compose)
- W3: TASK-004 (mysql+mssql) ∥ TASK-005 (connectionManager + statusBar)
- W4: TASK-006 (queryRunner + results webview)
- W5: TASK-007 (schemaTree + command wiring + activation)
- W6: TASK-008 (packaging + distribution)

## 4. Test Plan (REQUIRED — TDD-style)

| # | Loại | Tên test | File | Expect | Pre-state |
|---|------|----------|------|--------|-----------|
| 1 | unit | Parser tách nhiều statement | `src/core/__tests__/statementParser.test.ts` | 3 statements | `"SELECT 1;\nSELECT 2;\nSELECT 3;"` |
| 2 | edge | `;` trong string literal `'a;b'` | `src/core/__tests__/statementParser.test.ts` | 1 statement, không tách giữa string | `"SELECT 'a;b' AS x;"` |
| 3 | edge | Dollar-quote `$$...;...$$` | `src/core/__tests__/statementParser.test.ts` | body chứa `;` vẫn 1 statement | hàm plpgsql với `$$ BEGIN; END $$` |
| 4 | edge | Comment `--` và `/* */` chứa `;` | `src/core/__tests__/statementParser.test.ts` | `;` trong comment không phải boundary | `"SELECT 1 -- note; here\n;\nSELECT /* x;y */ 2;"` |
| 5 | edge | Khối `BEGIN...END` = 1 statement | `src/core/__tests__/statementParser.test.ts` | khối PL/pgSQL/T-SQL nguyên vẹn | BEGIN...END chứa `;` bên trong |
| 6 | edge | Con trỏ trước statement đầu / file rỗng | `src/core/__tests__/statementParser.test.ts` | offset 0 → statement đầu; rỗng → mảng rỗng | `""`, `"  \n"` |
| 7 | unit | ConnectionManager CRUD với vscode mock | `src/core/__tests__/connectionManager.test.ts` | add lưu state + secret; delete xoá cả 2; active nhớ theo workspace | mock Memento + SecretStorage |
| 8 | edge | ConnectionManager: sai password / delete connection đang active | `src/core/__tests__/connectionManager.test.ts` | lỗi connect propagate rõ; delete active → đóng adapter + clear active | mock adapter throw |
| 9 | integration | Postgres: connect + query + batch + cancel | `src/adapters/__tests__/postgres.integration.test.ts` | query generate_series trả batch 500 + load more; cancel giữa query | docker compose up postgres |
| 10 | integration | MySQL/MSSQL: connect + query + metadata + sai password | `src/adapters/__tests__/mysql.integration.test.ts`, `mssql.integration.test.ts` | rows đúng; listTables/listColumns đúng; sai password → lỗi rõ | docker compose services mysql/mssql |
| 11 | unit | Row batching thuần (cap 500, append, count) | `src/core/__tests__/resultBatcher.test.ts` | batch đầu 500, append giữ thứ tự, total đúng | mảng 1.200 rows fake |
| 12 | edge | QueryRunner: statement lỗi giữa batch | `src/core/__tests__/queryRunner.test.ts` | statements trước giữ kết quả, đánh dấu index lỗi, dừng chuỗi | mock adapter throw ở stmt 2 |

Webview grid virtual-scroll: **manual checklist** trong `docs/testing-checklist.md` (DOM testing trong webview không đáng giá ở v1). Unit test chỉ cover logic thuần (resultBatcher), không test DOM.

Integration ở mức nhẹ cho v1: docker compose + make target là đủ; integration test dùng `describe.skipIf(!process.env.VSDB_IT)` để không-docker không fail.

## 5. Verification Commands

```bash
npm install
npm run compile          # esbuild prod build, exit 0
npx tsc --noEmit         # typecheck src/ + webview/
npm test                 # vitest run — unit tests
npm run test:integration # cần docker compose up (make db-up)
npm run package          # vsce package → *.vsix
bash scripts/install-vsdb.sh --local   # smoke install qua CLI macOS
```

## 6. Acceptance Criteria

- [ ] Mọi unit test PASS (`npm test` exit 0).
- [ ] Integration test PASS trên 3 DB khi `docker compose -f docker/docker-compose.yml up -d`.
- [ ] `npm run compile` + `npx tsc --noEmit` exit 0 — không TS error.
- [ ] `vsce package` ra `.vsix`; cài `code --install-extension --force` chạy được: mở `.sql`, Cmd+Enter chạy query lên docker postgres, grid hiện 500 rows + Load more + Cancel hoạt động.
- [ ] Schema Explorer hiện tree connections → Tables/Views/Routines → columns (lazy load).
- [ ] `install-vsdb.sh` detect latest release qua GitHub API, download vsix, install bằng `code` CLI (detect PATH, fallback `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`).
- [ ] Reviewer verdict APPROVED / APPROVED-WITH-MINOR cho mọi task.
- [ ] README.md (tiếng Việt): one-liner install + usage + troubleshooting.

## 7. Task Split (Phase 2 — TDD-embedded, MANDATORY)

8 task TASK-001..TASK-008 — chi tiết + Test Cases riêng trong `tasks/TASK-00N.md`; INDEX.md cập nhật status `ready`.

W1: 001 scaffold → W2: 002 parser ∥ 003 adapter-interface+postgres+docker → W3: 004 mysql+mssql ∥ 005 connectionManager+statusBar → W4: 006 queryRunner+webview → W5: 007 schemaTree+wiring → W6: 008 packaging.

## Planner Report
PLANNER_MODEL: claude-opus-4-8

## Plan Review Log

### Round 1
Reviewer: claude-opus-4-8 (code-reviewer)
Verdict: Approved
Findings (all minor, non-blocking — no plan restructure required):
1. [Completeness] §2/§4 — Design §5 có nút "Load all" (cảnh báo >100k rows) nhưng plan không đưa vào in-scope lẫn out-of-scope. Fix: thêm 1 dòng hoặc vào in-scope của TASK-006 webview, hoặc vào out-of-scope (Load 500 more lặp lại là đủ cho v1).
2. [Completeness] §2/§4 — Design §8: fallback khi SecretStorage lỗi (hỏi password mỗi lần) và khi không mở workspace (lưu global state) không được nhắc trong plan/test. Fix: TASK-005 nên có guard 1-dòng cho 2 case này (ít nhất ghi chú trong task file).
3. [Clarity] §5 Verification dùng `make db-up` nhưng không task nào được giao tạo Makefile. Fix: chỉ định rõ TASK-003 (cùng task tạo docker-compose) hoặc TASK-001 (scaffold) thêm make targets `db-up`/`db-down`.
4. [Clarity] §3/§7 — `src/adapters/factory.ts` (có trong design §2) không rõ TASK-003 hay TASK-004 tạo. Fix: giao cho TASK-003 (cùng interface + postgres), TASK-004 chỉ thêm 2 case.
5. [Completeness, minor] §2 — Metadata cache 60s và manual-test schema tree (design §6/§9) không được nhắc; cache có thể bỏ cho v1 (YAGNI) nhưng nên ghi vào out-of-scope để executor không tự thêm.

### Round 1 — findings applied
- §2: thêm Load all + metadata cache/manual-checklist vào out-of-scope
- TASK-005: thêm 2 fallbacks từ design §8 (SecretStorage error, no-workspace)
- TASK-001: thêm Makefile (build/watch/test/package/db-up/db-down)
- TASK-004/003: làm rõ factory.ts ownership — TASK-003 tạo (postgres), TASK-004 mở rộng (mysql+mssql)
