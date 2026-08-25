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
