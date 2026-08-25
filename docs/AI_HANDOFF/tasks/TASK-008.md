# TASK-008 -- Schema-aware autocomplete (CompletionItemProvider + cache)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.8

## Goal

Register a VS Code CompletionItemProvider for SQL that offers schema, table, and column name completions from adapter introspection. Add a schema cache with 60s TTL to avoid hammering the adapter on every keystroke.

## Target Files

- `src/ui/sqlCompletionProvider.ts` (new) -- CompletionItemProvider implementation
- `src/ui/schemaCache.ts` (new) -- cache with TTL wrapping adapter introspection
- `src/extension.ts` (existing) -- register the provider via `vscode.languages.registerCompletionItemProvider`
- `src/ui/__tests__/sqlCompletionProvider.test.ts` (new) -- provider unit tests
- `src/ui/__tests__/schemaCache.test.ts` (new) -- cache unit tests

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `provideCompletions returns tables for dot trigger` | CompletionItems with table names and Class kind | Mock adapter with tables ["users","orders"] |
| 2 | unit | `provideCompletions returns columns after table dot` | Column CompletionItems with Property kind for "users." | Mock adapter with columns for "users" |
| 3 | unit | `provideCompletions returns schemas` | Schema CompletionItems with Module kind | Mock adapter with schemas |
| 4 | unit | `provideCompletions filters by prefix` | Only items matching "us" returned from ["users","orders"] | Prefix "us" |
| 5 | edge | `provideCompletions with no active connection` | Returns empty array, no error | No active connection |
| 6 | edge | `provideCompletions handles adapter error gracefully` | Returns empty array, no exception thrown | Adapter throws on listTables |
| 7 | unit | `SchemaCache returns cached data within TTL` | Second call returns same data without calling adapter | Cache populated, called twice within 60s |
| 8 | edge | `SchemaCache invalidate clears cache` | Next call fetches fresh from adapter | Cache populated then invalidated |
| 9 | edge | `SchemaCache adapter failure preserves previous cache` | Stale data returned, no error thrown | Cache populated, adapter fails on refresh |

## Test Files

- `src/ui/__tests__/sqlCompletionProvider.test.ts` (new)
- `src/ui/__tests__/schemaCache.test.ts` (new)

## Verification Commands

```bash
npm test src/ui/__tests__/sqlCompletionProvider.test.ts
npm test src/ui/__tests__/schemaCache.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] Typing in SQL editor triggers schema-aware completions (schemas, tables, columns)
- [ ] Dot trigger after schema name shows tables in that schema
- [ ] Dot trigger after table name shows columns of that table
- [ ] Prefix filtering works correctly
- [ ] Cache returns cached data within TTL (60s default)
- [ ] `invalidate()` clears all cached entries
- [ ] `refreshSchema` command invalidates the cache
- [ ] Graceful handling when no connection is active
- [ ] All existing tests still pass
- [ ] `npm run typecheck` clean

## Dependencies

- (none -- new files only, no collision with any existing task)

## Interfaces

- Consumes: `DbAdapter.listTables()`, `DbAdapter.listColumns()`, `DbAdapter.listSchemas()` from `src/adapters/types.ts` (existing)
- Produces: `SqlCompletionProvider` class; `SchemaCache` class with `getTables()`, `getColumns()`, `getSchemas()`, `invalidate()`; registered provider in extension.ts

---

## Discussion

(chua co comment)

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
❯ src/ui/__tests__/sqlCompletionProvider.test.ts  (0 test)
⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯
 FAIL  src/ui/__tests__/sqlCompletionProvider.test.ts [ src/ui/__tests__/sqlCompletionProvider.test.ts ]
Error: Failed to load url ../sqlCompletionProvider (resolved id: ../sqlCompletionProvider) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-008/src/ui/__tests__/sqlCompletionProvider.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17
 Test Files  1 failed (1)
      Tests  no tests
   Duration  222ms

❯ src/ui/__tests__/schemaCache.test.ts  (0 test)
⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯
 FAIL  src/ui/__tests__/schemaCache.test.ts [ src/ui/__tests__/schemaCache.test.ts ]
Error: Failed to load url ../schemaCache (resolved id: ../schemaCache) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-008/src/ui/__tests__/schemaCache.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17
 Test Files  1 failed (1)
      Tests  no tests
   Duration  181ms
```
Verification Output:
```
$ npm test src/ui/__tests__/sqlCompletionProvider.test.ts src/ui/__tests__/schemaCache.test.ts
 ✓ src/ui/__tests__/schemaCache.test.ts  (3 tests) 1ms
 ✓ src/ui/__tests__/sqlCompletionProvider.test.ts  (6 tests) 3ms
 Test Files  2 passed (2)
      Tests  9 passed (9)

$ npm test            (first run failed on 2 pre-existing dist/ artifact tests — dist/schemaForm.js, dist/webview.css missing; fixed by `npm run compile` per task instructions, then re-run)
 Test Files  87 passed | 1 skipped (88)
      Tests  1268 passed | 2 skipped (1270)
   Duration  9.95s

$ npm run compile
 dist/extension.js      4.8mb
 dist/webview.js        2.2mb
 dist/webview.css      19.7kb
 esbuild: build complete

$ npm run typecheck
 > tsc --noEmit
 (no output — clean, exit 0)
```
Status: PASS
Note: Decisions recorded: (1) registration of `vscode.languages.registerCompletionItemProvider` in extension.ts is availability-guarded because `src/extension.test.ts`'s partial vscode mock (outside this task's editable files) stubs only `registerCodeLensProvider`; unguarded call would throw in every activate() smoke test. Real VS Code always has the API. (2) `vsdb.refreshSchema` now calls `schemaCache.invalidate()` before `tree.refresh()`. (3) Test #6 uses the dot-trigger path (`public.`) since listTables is what that path calls; test #4 keyword list intentionally contains no "us"-prefixed keywords. (4) schemaCache is vscode-free (no mock needed in its tests).
