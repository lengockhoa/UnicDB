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

(executor điền)

## Reviewer Verdict

(reviewer điền)
