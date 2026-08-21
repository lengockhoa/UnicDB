# TASK-007 — Schema Explorer tree + command wiring + activation

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (design §4, §6)

## Goal

Hoàn thiện extension: TreeDataProvider Schema Explorer (connections → Tables/Views/Routines → columns, lazy load, metadata cache 60s, context menu Generate SELECT / Copy qualified name / Refresh, click connection đổi active), hiện thực 10 command đã khai báo trong package.json (TASK-001), CodeLens "▶ Run" theo setting `vsdb.showRunLens`, và `activate()` wiring toàn bộ.

## Target Files

- `src/ui/schemaTree.ts` — `class SchemaTreeProvider implements vscode.TreeDataProvider<VsdbNode>`:
  - Node types: connection (active có chấm xanh) / category (Tables, Views, Routines) / table / view / routine / column; node "Add Connection" khi rỗng; lazy `getChildren` gọi adapter metadata; cache 60s + refresh.
  - Context menu qua `package.json` (đã có từ TASK-001): Generate SELECT → `INSERT INTO editor: SELECT * FROM <qualified> LIMIT 100;` tại con trỏ; Copy qualified name; Refresh.
- `src/extension.ts` — thay stub bằng wiring thật:
  - Đăng ký `ConnectionManager`, `createStatusBar`, `SchemaTreeProvider` (view `vsdb.schemaTree`), `ResultsPanel`, `QueryRunner`.
  - `vsdb.runQuery` / `vsdb.runStatement` (CodeLens): lấy editor → `sqlToRun(...)` (TASK-002) → QueryRunner.run → ResultsPanel.render; không connection → QuickPick gợi ý Add.
  - `vsdb.addConnection`: QuickPick driver → InputBox name/host/port(default 5432|3306|1433 theo driver)/user/password/database → `mgr.addConnection` (test-connect trong đó).
  - `vsdb.editConnection` / `vsdb.deleteConnection` / `vsdb.selectConnection` (QuickPick đổi active) / `vsdb.cancelQuery` / `vsdb.generateSelect` / `vsdb.copyQualifiedName` / `vsdb.refreshSchema`.
  - CodeLensProvider: `provideCodeLenses` dùng `splitStatements` lấy ranges → lens "▶ Run" command `vsdb.runStatement` với range; chỉ khi `vsdb.showRunLens` true; filter `languageId == 'sql'`.
- `src/ui/__tests__/schemaTree.test.ts` — unit với mock adapter + mock vscode tree types.
- `src/extension.test.ts` — smoke: import activate không throw (vscode mock).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | Tree: connection → 3 category → children | getChildren(connection) → [Tables, Views, Routines]; getChildren(Tables) → tables từ mock adapter | mock DbAdapter listTables |
| 2 | unit | Lazy + cache 60s | expand 2 lần trong 60s → adapter.listTables gọi 1 lần; sau refresh → gọi lại | vi.useFakeTimers |
| 3 | edge | Connection chưa kết nối / adapter throw | children = node lỗi "Connect failed" (không crash tree) | mock adapter throw |
| 4 | unit | Generate SELECT đúng template | từ table `users` schema `public` → `SELECT * FROM public.users LIMIT 100;` (postgres); MySQL không schema → `SELECT * FROM \`users\` LIMIT 100;` | node table postgres + mysql |
| 5 | unit | runQuery không connection | showQuickPick được gọi với option "Add Connection" (spy) | manager active = null |
| 6 | edge | Editor không phải .sql | command thoát sớm, không throw | activeTextEditor languageId 'markdown' |

## Test Files

- `src/ui/__tests__/schemaTree.test.ts`
- `src/extension.test.ts`

## Verification Commands

```bash
npx tsc --noEmit
npm test
npm run compile
```

(Manual smoke sau khi compile: mở Extension Development Host `F5`, docker compose up postgres, Cmd+Enter chạy `SELECT 1;` — ghi kết quả vào Executor Report.)

## Acceptance Criteria

- [ ] 6 test trên PASS; `npm test` toàn bộ PASS.
- [ ] `activate()` đăng ký đủ 10 command + tree view + status bar + CodeLens; F5 smoke chạy được end-to-end với docker postgres.
- [ ] Cmd+Enter chỉ trigger trên file `.sql` (when clause).
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (manifest + stub), TASK-002 (parser), TASK-003+004 (adapters), TASK-005 (ConnectionManager), TASK-006 (QueryRunner + ResultsPanel)

## Interfaces

- Consumes: toàn bộ Produces của TASK-002 (`sqlToRun`, `splitStatements`), TASK-003/004 (`createAdapter`, `DbAdapter`), TASK-005 (`ConnectionManager`, `createStatusBar`), TASK-006 (`QueryRunner`, `ResultsPanel`, `StatementResult`).
- Produces: extension chạy được end-to-end — `activate(context: vscode.ExtensionContext): void` wiring tất cả. TASK-008 chỉ packaging, không đổi code.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
