# TASK-103 — Schema nodes trong SchemaTreeProvider

Status: ready
Owner: claude-code
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Chèn cấp node "schema" vào tree (connection → schema → category → object), truyền schema tường minh vào mọi lời gọi list*, cập nhật cache key có schema.

## Target Files

- `src/ui/schemaTree.ts` — node schema mới, getChildren cho schema/schema-aware category, cache key `schemas|<connId>|includeSystem=<0|1>` và `category|<connId>|<schema>|<category>`, category count badge như DataGrip
- `src/ui/__tests__/schemaTree.test.ts` — test mới cho schema node flow + category count
- `src/ui/__tests__/connectionForm.test.ts`, `src/ui/__tests__/statusBar.test.ts`, `src/core/__tests__/queryRunner.test.ts`, `src/core/__tests__/connectionManager.test.ts` — update fake DbAdapter để có `listSchemas` stub nếu cần

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | connection expand → schema nodes | mock adapter.listSchemas(false) trả [app, public] → 2 node label đúng, contextValue "schema", collapsible |
| 2 | unit | schema expand → 3 categories | Tables/Views/Routines dưới schema node, như DataGrip folders |
| 3 | unit | category expand truyền schema + count | spy listTables gọi với "app"; category description/count cập nhật `2` |
| 4 | unit | table node objectKey gồm schema | `connId.app.users` |
| 5 | edge | listSchemas [] → node "no schemas" | 1 node không expand, không throw |
| 6 | edge | cache phân biệt schema | expand Tables của 2 schema → 2 entry riêng; sau refresh() rỗng |
| 7 | regression | qualifiedName vẫn schema.table | test hiện có vẫn pass |

## Test Files

- `src/ui/__tests__/schemaTree.test.ts` (sửa + thêm)

## Verification Commands

```bash
cd .worktrees/task-103 && npx tsc --noEmit && npx vitest run src/ui/__tests__/schemaTree.test.ts && npx vitest run && npm run compile
```

## Acceptance Criteria

- [ ] Tree: connection → schema → Tables/Views/Routines → objects
- [ ] Object schema bất kỳ: Generate SELECT + Copy Qualified Name dùng schema.table
- [ ] Test mới pass; full suite pass; esbuild compile pass

## Dependencies

TASK-101 (cần SchemaInfo + listSchemas trên DbAdapter)

## Interfaces

Consumes: `DbAdapter.listSchemas(includeSystem: boolean): Promise<SchemaInfo[]>` (TASK-101).
Produces: node contextValue `"schema"` mới; category `description` count badge sau khi loaded.

## Discussion

### 2026-08-21 · planner · unic-smart
Node schema dùng icon `$(symbol-namespace)`, label = tên schema. Category nodes giữ contextValue "category" (menu view/item/context khi `viewItem == table/view/...` không đổi — schema node chưa có context menu riêng, chỉ expand).
