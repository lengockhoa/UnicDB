# TASK-DBX02-002 — Catalog and FK completion

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX02.md` §3

## Goal

Write RED tests first, then extend the existing `SqlCompletionProvider` to complete PostgreSQL views, routines, and sequences, and annotate local FK column completions. Preserve tables/schemas/keywords, no-connection silence, and never-crash behavior.

## Target Files

- `src/ui/sqlCompletionProvider.ts` — additive catalog completion only; retain the existing `hasConnection` guard and `try/catch`.
- `src/ui/__tests__/sqlCompletionProvider.test.ts` — extend the existing lightweight `vscode` mock and provider fixtures.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | RED→GREEN unit | root completion includes view, routine, and sequence | `v_orders` is `CompletionItemKind.Interface`, `detail: "view · public"`, `insertText: "v_orders"`; `fn_total` is `CompletionItemKind.Function`, `detail: "function · public"`, `insertText: "fn_total"`; `order_seq` is `CompletionItemKind.Value`, `detail: "bigint · public"`, `insertText: "order_seq"`; unchanged table/keyword items remain | root rows `public.v_orders`, function `public.fn_total`, sequence `public.order_seq bigint` |
| 2 | edge—relationship | `orders.` exposes FK local column metadata | `user_id` is a Property with `label`/`insertText` `user_id` and detail `integer · FK → public.users.id` | `orders.user_id → public.users.id` |
| 3 | edge—lazy scope | `orders.` completion sees unrelated table in cache | fetches constraints for `orders` only and never for `audit_log` | tables `orders`, `audit_log`; per-table spies |
| 4 | edge—connection/error | no active connection or resolver rejection | returns `[]` without invoking catalog successfully or throwing | `hasConnection=false`; rejected resolver |

## Test Files

- `src/ui/__tests__/sqlCompletionProvider.test.ts` — all completion tests above, written RED before the provider change.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/sqlCompletionProvider.test.ts
npm run typecheck
npm run compile
```

`src/ui/sqlCompletionProvider.ts` maps to this existing test file in `.cache/index/tests-map.json`; `package.json` has no lint script.

## Acceptance Criteria

- [ ] RED output precedes the smallest GREEN provider change.
- [ ] Existing schemas/tables/columns/keywords preserve their current expected labels and kinds.
- [ ] Views, routines, and sequences have concrete catalog-derived label/detail/kind behavior.
- [ ] In the existing `<table>.` context, FK metadata decorates the syntactically valid local-column completion; it does not insert a fictitious relationship path.
- [ ] No-active-connection and resolver failure remain silent (`[]`), with no new cache/debounce/controller.
- [ ] No `as any`/`: any`, adapter call, or PostgreSQL SQL is added to this provider.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DBX02-001

## Interfaces

- Consumes: change `SqlCompletionProviderDeps` in `src/ui/sqlCompletionProvider.ts` to exact shape `SqlCompletionProviderDeps { cache: SchemaCache; catalog: CatalogResolver; hasConnection?: () => boolean }`; `CatalogResolver.listRootRows(): Promise<readonly CatalogRootRow[]>` and `CatalogResolver.listForeignKeys(schema: string, table: string): Promise<readonly CatalogForeignKeyRow[]>` from TASK-DBX02-001.
- Produces: the existing `SqlCompletionProvider implements vscode.CompletionItemProvider` with the required `catalog` dependency; TASK-DBX02-005 constructs it as `new SqlCompletionProvider({ cache: schemaCache, catalog: catalogResolver, hasConnection: () => mgr.getActive() !== null })`.

---

## Discussion

### 2026-08-30 · planner · unic/unic-smart
Completion remains a UI projection: catalog loading/cache policy belongs to TASK-DBX02-001, not here. Keep the verified `<table>.` trigger and do not replace it with a language server.

---

---
## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
Status: PASS
Note: Extension of `SqlCompletionProvider` with optional `resolver` + `isPostgres` deps. `<table>.` trigger also yields FK target completions (schema-qualified when schema differs); root prefix also yields views/routines/sequences from `resolver.listRootRows()`; quiet [] on non-PostgreSQL/no connection. 10/10 provider tests pass. Committed as part of wave 2.
