# TASK-102 — Setting vsdb.hideSystemSchemas

Status: ready
Owner: claude-code
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Thêm configuration `vsdb.hideSystemSchemas` (boolean, default true) vào package.json contributes.configuration.

## Target Files

- `package.json` — contributes.configuration: thêm `vsdb.hideSystemSchemas`

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | package.json declares hideSystemSchemas | `contributes.configuration` chứa key `vsdb.hideSystemSchemas`, type boolean, default true |
| 2 | edge | default value đúng true | parse JSON → default === true (user cài mới không thấy pg_catalog) |

## Test Files

- `src/scaffold.test.ts` (sửa — thêm case đọc package.json) HOẶC file test hiện có cùng vai trò

## Verification Commands

```bash
cd .worktrees/task-102 && npx vitest run src/scaffold.test.ts && npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Setting hiện trong VS Code Settings UI với mô tả
- [ ] Test pass

## Dependencies

(none)

## Interfaces

Produces: config key `vsdb.hideSystemSchemas: boolean` (default true) — TASK-103 consume qua `vscode.workspace.getConfiguration("vsdb").get("hideSystemSchemas")`.

## Discussion

### 2026-08-21 · planner · unic-smart
Chỉ package.json — KHÔNG đụng extension.ts (thuộc TASK-103 wave sau, tránh share file giữa wave).

## Executor Report

EXECUTOR_MODEL: unic-code

RED_OUTPUT: `npx vitest run src/scaffold.test.ts` failed as expected: `package.json declares hideSystemSchemas setting enabled by default` → `expected undefined to be truthy` at `src/scaffold.test.ts:133`.

Verification Output:

```bash
npx vitest run src/scaffold.test.ts && npx tsc --noEmit
```

Result: PASS — `src/scaffold.test.ts` 5 tests passed; `npx tsc --noEmit` completed with exit code 0.

Status: PASS
