# TASK-303 — Filter command + view/title menu

Cycle 2026-08-22-B · P0 · Size S · Deps: TASK-302

## Goal

UI entry cho tree filter: command `vsdb.filterSchemaTree` mở input box (QuickInput), gõ text → `provider.setFilter(text)`; context key `vsdb.schemaTreeFilterActive` điều khiển button clear trên view title bar. Theo reference UI: placeholder "Filter schemas, tables, columns, routines…".
1. `package.json` contributes (view id = `vsdb.schemaTree`, mọi menu entry kèm `"when": "view == vsdb.schemaTree"` theo pattern package.json:167-183):
   - commands: `{"command":"vsdb.filterSchemaTree","title":"Filter Schema Tree","category":"VSDB","icon":"$(filter)"}` và `{"command":"vsdb.clearSchemaTreeFilter","title":"Clear Schema Tree Filter","category":"VSDB","icon":"$(close)"}`.
   - `menus.view/title` group `navigation`: filterSchemaTree (when: view == vsdb.schemaTree); clearSchemaTreeFilter (when: view == vsdb.schemaTree && vsdb.schemaTreeFilterActive).
2. `src/extension.ts`: register 2 commands:
   - filterSchemaTree: `const text = await vscode.window.showInputBox({ prompt: 'Filter schemas, tables, columns, routines…', placeHolder: 'Filter…', value: provider.getFilter() }); if (text === undefined) return; provider.setFilter(text); await vscode.commands.executeCommand('setContext', 'vsdb.schemaTreeFilterActive', text.length > 0);`
   - clearSchemaTreeFilter: `provider.setFilter(''); await vscode.commands.executeCommand('setContext', 'vsdb.schemaTreeFilterActive', false);`
3. Không đổi view welcome content.

## Interfaces

- Consumes: `SchemaTreeProvider.setFilter/getFilter` (TASK-302).
- Produces: commands + context key (VS Code surface, không task khác consume).

## Test Cases

| Loại | Test | Expected |
|------|------|----------|
| happy | package.json contributes chứa 2 command + menu entries với when đúng | assert qua đọc package.json |
| happy | extension.test.ts: registerCommands smoke bao gồm 2 command mới (pattern hiện tại — check command list tồn tại) | pass |
| edge | showInputBox trả undefined (Esc) → filter không đổi | pass (executor: chỉ cần logic branch — nếu input undefined, không gọi setFilter) |

## Test Files

- `src/extension.test.ts` (append smoke)

## Verification Commands

```bash
npm run typecheck
npx vitest run src/extension.test.ts
node -e "const p=require('./package.json'); if(!p.contributes.commands.some(c=>c.command==='vsdb.filterSchemaTree')) process.exit(1); console.log('contributes OK')"
```

## Acceptance Criteria

- [ ] Filter button trên tree view title bar; click → input box; nhập → tree lọc
- [ ] Filter active → button clear xuất hiện; click → tree full
- [ ] Esc (undefined) → không đổi filter
- [ ] jq/node contributes check pass

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec303
SUMMARY: TASK-303 implemented — package.json contributes 2 commands + view/title menu entries (when clauses); extension.ts registers 2 command handlers (filterSchemaTree + clearSchemaTreeFilter) wiring provider.setFilter/getFilter + setContext vsdb.schemaTreeFilterActive.
TEST_PLAN_FOLLOWED: task §Test Cases (3 inline cases)
FILES_CHANGED:
  - package.json: contributes.commands (added filterSchemaTree, clearSchemaTreeFilter); contributes.menus.view/title (added 2 entries)
  - src/extension.ts: registered 2 new commands after refreshSchema (#11 filterSchemaTree + #12 clearSchemaTreeFilter)
  - src/extension.test.ts: appended TASK-303 describe block (3 cases)
  - docs/AI_HANDOFF/tasks/TASK-303.md: this report
  - docs/AI_HANDOFF/INDEX.md: status → pending_review
TESTS_ADDED:
  - src/extension.test.ts: "TASK-303 — filter command + view/title menu" (3 tests)
VERIFICATION:
  command: npm run typecheck
  result: pass, exit 0, no errors
  command: npx vitest run src/extension.test.ts
  result: 11 pass / 0 fail, exit 0
  command: node -e "JSON.parse(require('fs').readFileSync('package.json','utf-8'))"
  result: "json OK"
  command: node -e "const p=require('./package.json'); if(!p.contributes.commands.some(c=>c.command==='vsdb.filterSchemaTree')) process.exit(1); if(!p.contributes.commands.some(c=>c.command==='vsdb.clearSchemaTreeFilter')) process.exit(2); console.log('contributes OK')"
  result: "contributes OK"
RED_OUTPUT (truncated last lines):
```
 FAIL  src/extension.test.ts > TASK-303 — filter command + view/title menu > package.json contributes khai báo 2 command mới với icon + menu entries đúng when
 AssertionError: expected undefined not to be undefined
 FAIL  src/extension.test.ts > TASK-303 — filter command + view/title menu > register 2 command mới: vsdb.filterSchemaTree + vsdb.clearSchemaTreeFilter
 AssertionError: expected false to be true
 FAIL  src/extension.test.ts > TASK-303 — filter command + view/title menu > showInputBox trả undefined (Esc) → setFilter KHÔNG được gọi
 AssertionError: expected undefined not to be undefined
 Tests  3 failed (RED confirmed before implementation)
```
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

## Reviewer Verdict

(reviewer điền)
