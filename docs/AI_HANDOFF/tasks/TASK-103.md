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

## Executor Report

- **EXECUTOR_MODEL**: unic-code
- **Status**: PASS

### RED_OUTPUT

`npx vitest run src/ui/__tests__/schemaTree.test.ts` → 11 failed | 8 passed (19). Tất cả 11 test mới fail đúng lý do mong đợi: connection expand vẫn trả thẳng category (chưa có cấp "schema"), listSchemas chưa được gọi, category key chưa có schema, description count chưa cập nhật.

### Verification Output

```text
$ npx tsc --noEmit
(no output — type check pass)

$ npx vitest run src/ui/__tests__/schemaTree.test.ts
Test Files  1 passed (1)
     Tests  19 passed (19)

$ npx vitest run
Test Files  15 passed (15)
     Tests  156 passed (156)

$ npm run compile
esbuild: build complete
```

### Changes

- `src/ui/schemaTree.ts` — thêm node `schema` (connection → schema → category → object); `getSchemaNodesForConnection` đọc `vsdb.hideSystemSchemas` rồi gọi `adapter.listSchemas(!hideSystemSchemas)`; cache key `schemas|<connId>|includeSystem=<0|1>`; category key `category|<connId>|<schema>|<category>`; `listTables/listViews/listRoutines` truyền schema tường minh; category node cập nhật `description` = count + fire onDidChangeTreeData (DataGrip-style badge); node "No schemas" khi listSchemas rỗng.
- `src/ui/__tests__/schemaTree.test.ts` — 8 test mới (schema flow + count + objectKey + no-schemas + cache + hideSystemSchemas) + adapt existing tests sang tree 3 cấp.
- `src/ui/__tests__/statusBar.test.ts`, `src/core/__tests__/connectionManager.test.ts`, `src/core/__tests__/queryRunner.test.ts` — thêm `listSchemas` stub vào fake adapter (`connectionForm.test.ts` đã có sẵn).

## Reviewer Verdict

TASK: TASK-103
VERDICT: changes_requested
REVIEWER_MODEL: unic-smart
VERIFICATION_RERUN: PASS
BLOCKING: MySQL Generate SELECT still drops schema for objects selected under non-default schemas.

## Executor Report (fix round 1)

- **EXECUTOR_MODEL**: unic-code
- **Status**: PASS
- **Worktree**: `.worktrees/task-103-fix1`

### Blocking finding fixed

Reviewer: "MySQL Generate SELECT still drops schema for objects selected under non-default schemas."

Root cause: `generateSelectForTable` (src/ui/schemaTree.ts) MySQL branch luôn trả `` SELECT * FROM `table` LIMIT 100; `` — bỏ schema kể cả khi object thuộc schema non-default.

Fix: MySQL branch giờ qualify `schema`.`table` khi schema khác rỗng → `SELECT * FROM `qas`.`api_log` LIMIT 100;`. Schema rỗng giữ nguyên behavior cũ (không qualify).

### TDD

- RED: test regression mới `regression — MySQL Generate SELECT giữ schema cho object dưới schema non-default` (schemaTree.test.ts) fail đúng như kỳ vọng: received `SELECT * FROM `api_log` LIMIT 100;` vs expected `SELECT * FROM `qas`.`api_log` LIMIT 100;`.
- GREEN: fix xong → test pass.

### Verification Output (fix round 1)

```text
$ npx tsc --noEmit
(no output — type check pass)

$ npx vitest run src/ui/__tests__/schemaTree.test.ts
Test Files  1 passed (1)
     Tests  20 passed (20)

$ npx vitest run
Test Files  15 passed (15)
     Tests  157 passed (157)

$ npm run compile
esbuild: build complete
```

### Changes

- `src/ui/schemaTree.ts` — `generateSelectForTable`: MySQL branch qualify schema khi non-empty; cập nhật doc comment.
- `src/ui/__tests__/schemaTree.test.ts` — thêm regression test cho MySQL schema qualification (schema non-empty + schema rỗng).
