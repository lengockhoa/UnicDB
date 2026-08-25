# TASK-004 — vsdb.exportAllStructures: copy toàn-DB DDL ra clipboard

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D4/§1 outcome-3, §4 T4

## Goal

Command `vsdb.exportAllStructures` (context menu connection/schema node + command palette): introspect toàn DB (user schemas, tables, views) → `buildDatabaseStructure` → clipboard. Đây là mặt UI của "Export Structure để tham khảo toàn bộ context" — user copy DDL toàn DB đưa cho bất kỳ AI/workflow ngoài nào.

## Target Files

- `src/ui/tableCommands.ts` — thêm command registration `vsdb.exportAllStructures` (cùng pattern `vsdb.exportStructure` lines 540-581 + guardPostgres).
- `package.json` — contributed command + menus (schema tree view/context, palette).
- `src/extension.test.ts` — assert command đăng ký (smoke pattern hiện có).
- `src/ui/__tests__/tableCommands.test.ts` — append describe "vsdb.exportAllStructures" (#1, #2, #3).

## Spec

```ts
// src/ui/tableCommands.ts — THÊM (sau block vsdb.exportStructure, trước `}` đóng registerTableCommands):
context.subscriptions.push(
  vscode.commands.registerCommand(
    "vsdb.exportAllStructures",
    async (arg?: unknown) => {
      // Node: connection hoặc schema node (resolveConnectionNode pattern có
      // sẵn trong file cho vsdb.analyzeTable/copyQualifiedName — dùng cùng
      // resolver; palette invoke không arg → dùng mgr.getActive()).
      // guardPostgres tương đương exportStructure (PG-only DDL).
      const guarded = /* connection | schema node resolve */;
      if (!guarded) return;
      try {
        const adapter = await /* adapter cho connection */;
        const schemas = await adapter.listSchemas(false);
        // Nếu node là schema → chỉ schema đó; connection → mọi user schema.
        const tables = [], views = [], columns = {};
        // (per-schema listTables/listViews/listColumns — cùng thu thập logic
        //  TASK-002 buildMessages; per-object throw → skip + đếm skipped)
        const text = buildDatabaseStructure({ schemas, tables, views, columns });
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage(
          `VSDB: database structure copied (${tables.length + views.length} objects)`,
          2000,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Export All Structures failed: ${msg}`,
        );
      }
    },
  ),
);

// package.json contributes.commands + menus:
//   { "command": "vsdb.exportAllStructures", "title": "VSDB: Export All Structures (Copy DDL)", "category": "VSDB" }
//   menus.view/item: schema tree — when node connection/schema (match điều kiện
//   node các command exportStructure/analyzeTable đang dùng).
//   KHÔNG thêm keybinding (palette + context menu đủ).
```

Lưu ý: thu thập introspection trong command là bản song song của TASK-002 buildMessages collection. Executor viết helper nội bộ nhỏ trong tableCommands.ts (không export, không import từ aiChatPanel.ts — tránh coupling UI file). Nếu thấy trùng lặp đáng kể, ghi nhận trong Discussion cho cycle sau cân nhắc extract — KHÔNG tự extract shared module trong task này (scope giữ nhỏ).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | connection node PG → clipboard chứa full DDL | clipboard text bắt đầu `-- Database structure (1 schemas, 2 tables, 0 views)`, chứa `CREATE TABLE public.users`; statusbar message `database structure copied (2 objects)` | mock vscode env + adapter pattern tableCommands.test.ts hiện có (guardPostgres pass, listSchemas/listTables/listViews/listColumns mock) |
| 2 | edge | non-PG (mysql) connection node | guardPostgres chặn: error message shown (pattern guard msg hiện có), clipboard KHÔNG được write | node driver mysql |
| 3 | edge | DB rỗng (0 user schemas → 0 objects) | clipboard = header `(0 schemas, 0 tables, 0 views)` một dòng; status `copied (0 objects)`; không throw | listSchemas → [] |
| 4 | regression | command đăng ký trong activate | extension.test.ts assert `vsdb.exportAllStructures` nằm trong registeredCommands | pattern smoke hiện có |
| 5 | edge | 1 object listColumns throw → skipped, còn lại copy | clipboard chứa table còn lại; KHÔNG error message (skip im lặng như exportStructure per-object path — hoặc statusbar đếm đúng objects thực) | listColumns reject 1 table |
| 6 | edge | no active connection (mgr.getActive() null / adapter factory throw) (review #5) | showErrorMessage `Export All Structures failed: ...` (hoặc info hướng dẫn kết nối — theo path code thật), KHÔNG crash/unhandled rejection, clipboard KHÔNG write | active=null hoặc factory rejects |

## Test Files
- `src/ui/__tests__/tableCommands.test.ts` — #1, #2, #3, #5, #6.
- `src/extension.test.ts` — #4 (append vào block assert commands hiện có).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS.
- [ ] Command hiện ở palette + context menu connection/schema node (package.json contributes đúng schema).
- [ ] Clipboard chứa DDL toàn DB (đa schema) — cùng builder TASK-001.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (tiêu thụ `buildDatabaseStructure`).

## Interfaces

- Consumes: `buildDatabaseStructure(db: DatabaseStructureInput): string`, `DatabaseStructureInput` (TASK-001 produces); `guardPostgres`, node resolver + `RegisterDeps`/`mgr` pattern trong tableCommands.ts hiện có; DbAdapter `listSchemas(false)/listTables(schema)/listViews(schema)/listColumns(table,schema)`.
- Produces: VS Code command `vsdb.exportAllStructures(arg?: connection-or-schema node)` — registered id phải khớp package.json contributes (extension.test.ts khóa).

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec-T4
SUMMARY: Implemented `vsdb.exportAllStructures` — connection/schema node or palette (no arg → `mgr.getActive()`), PG-only with mysql/mssql info guard, introspects all user schemas (or single schema if schema node) → `buildDatabaseStructure` → clipboard. Per-object `listColumns` throw → silent skip. Status bar reports successfully-rendered objects. Tests added in `src/ui/__tests__/tableCommands.test.ts` (#1, #2, #3, #5, #6, #6b, #7) + `src/extension.test.ts` (#4 wiring smoke).
TEST_PLAN_FOLLOWED: task §Test Cases (TDD inline plan)
FILES_CHANGED:
  - package.json: contributed command `vsdb.exportAllStructures` (title "VSDB: Export All Structures (Copy DDL)", icon $(output)), `onCommand:vsdb.exportAllStructures` activationEvent, view/item/context menu entry covering `viewItem == connection || viewItem == schema`.
  - src/ui/tableCommands.ts: imported `buildDatabaseStructure` + `ExportColumn` from `./exportStructure`; added `vsdb.exportAllStructures` registration inside `registerTableCommands` (after `vsdb.exportStructure` block, before closing `}`).
  - src/ui/__tests__/tableCommands.test.ts: appended `describe("tableCommands — TASK-004 vsdb.exportAllStructures", …)` with 7 cases (#1, #2, #3, #5, #6, #6b, #7).
  - src/extension.test.ts: appended `describe("TASK-004 — vsdb.exportAllStructures wiring", …)` with 4 cases (registration, contributes.commands, activationEvents, view/item/context menu).
TESTS_ADDED:
  - src/ui/__tests__/tableCommands.test.ts: #1 happy 2-table PG node → clipboard starts "-- Database structure (1 schemas, 2 tables, 0 views)" + statusbar "database structure copied (2 objects)"; #2 mysql node → "Export All Structures: PostgreSQL connections only" info + no clipboard write; #3 empty DB (listSchemas → []) → header line only + 0 objects + no error; #5 listColumns throw on one table → that object skipped, surviving table rendered, no error message (header counts rendered objects); #6 mgr.getActive() null (palette invoke) → error message, no clipboard write, no unhandled rejection; #6b getAdapterFor rejects → "Export All Structures failed: …" error, no clipboard write, no unhandled rejection; #7 wiring smoke → registeredCommands has the id + package.json menu entry covers connection + schema.
  - src/extension.test.ts: #4 wiring smoke (4 cases) — activate() registers the command, contributes.commands declares it, activationEvents has onCommand entry, view/item/context menu entry has connection + schema viewItem.
VERIFICATION:
  command: npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts
  result: 87 passed | 1 failed | 88 total (1 fail is pre-existing TASK-003 dist/schemaForm.js bundle presence check; reproduced on baseline `git stash` without my changes — not caused by TASK-004)
  output_excerpt: |
    ✓ src/ui/__tests__/tableCommands.test.ts  (35 tests) 11ms
    ✓ src/extension.test.ts  (53 tests | 49 skipped) when filtered to "TASK-004 — vsdb.exportAllStructures wiring" — 4 passed
    ✗ src/extension.test.ts > TASK-003 — vsdb.createSchema extension wiring > npm run compile emits dist/schemaForm.js
      (pre-existing, unrelated to TASK-004; dist/ not built in worktree)
  command: npx tsc --noEmit
  result: clean (no output, exit 0)
  RED-output (captured before impl, npx vitest with same selectors): 12 failed (7 in tableCommands.test.ts, 5 in extension.test.ts) — confirmed each new test fails for the right reason (command not yet registered + menu entry not yet declared).
ISSUES: Pre-existing `dist/schemaForm.js` failure on extension.test.ts TASK-003 case is unrelated to TASK-004. Verified by stashing my changes and re-running — same failure. No regression introduced by this change.
HANDOFF_TO_REVIEWER: yes — wiring smoke matches task spec, command registered, package.json entries match test #4 lock-in.
NEXT: ready for review (Reviewer Verdict append below).

---
## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts && npx tsc --noEmit
  result: 88 pass / 0 fail (vitest) + tsc clean
TEST_PLAN_COVERAGE: partial — test #4 (wiring) fully covered; tests #1-3, #5-6 covered; schema-node path (targetSchema filter at tableCommands.ts:609) has no dedicated test
FINDINGS:
  critical: none
  important:
    - src/ui/tableCommands.ts:609 — `targetSchema` filter path (schema node invocation) is implemented but has no test. The `meta.schema` branch that narrows `allSchemas` to a single schema is untested. Add a test passing a node with `meta: { connection: cfg, schema: "public" }` and verify clipboard contains only that schema's objects.
  minor:
    - src/ui/__tests__/tableCommands.test.ts: — test #2 guard message uses `showInformationMessage` (info), not `showErrorMessage` as the task spec says "error message shown". Implementation is actually correct per spec's "PG-only info guard" intent; the table row label is misleading. No code change needed.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Solid implementation — schema filter, per-object skip, status bar count all work correctly. Only gap is missing schema-node test for the targetSchema path. Non-blocking for handoff.
