# TASK-RLX-002 — Coalesce SchemaCache stale refreshes

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Ensure concurrent stale reads of the same SchemaCache slot share one adapter introspection while retaining TTL, stale-on-error, and invalidation safety.

## Target Files

- `src/ui/schemaCache.ts` — add keyed single-flight refresh coordination and an invalidation generation guard without changing public cache method signatures.
- `src/ui/__tests__/schemaCache.test.ts` — add deterministic coalescing, failure, and invalidate-during-refresh tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy / unit | concurrent stale table reads coalesce | Two `getTables("public")` calls make exactly one `adapter.listTables("public")` call and both return refreshed `[ { name: "orders", schema: "public" } ]`. | Deferred `listTables`; TTL 0 or expired cache. |
| 2 | edge — failure | shared refresh rejection returns stale to all | Both calls resolve the existing `users` cache value; neither rejects; one refresh call occurs. | Seeded stale cache then deferred rejection. |
| 3 | edge — invalidation race | invalidate defeats old response | A response started before `invalidate()` does not populate cache; the next call fetches and returns `invoices`. | Deferred first response, then invalidate, then distinct second response. |

## Test Files

- `src/ui/__tests__/schemaCache.test.ts` — SchemaCache unit tests using existing fake `DbAdapter` pattern.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/schemaCache.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Same-key concurrent stale/missing reads share a single adapter request.
- [ ] Different cache keys do not accidentally share results.
- [ ] Existing stale-on-error behavior returns prior data (or existing empty/undefined fallback) without throwing.
- [ ] `invalidate(): void` prevents an earlier in-flight response from becoming fresh cache state.
- [ ] Public `SchemaCache` method signatures and default `ttlMs: 60_000` remain unchanged.
- [ ] Tests 1–3 pass after observed RED, and both verification commands pass.

## Dependencies

- none

## Interfaces

- Consumes: `SchemaCache(adapterProvider: SchemaAdapterProvider, options?: SchemaCacheOptions)`, `getTables(schema?: string): Promise<TableInfo[]>`, and `invalidate(): void` from `src/ui/schemaCache.ts`; `DbAdapter.listTables(schema?: string): Promise<TableInfo[]>` from `src/adapters/types.ts`.
- Produces: unchanged public SchemaCache API with same-key single-flight behavior and invalidation-safe commits.

---

## Discussion

### 2026-08-31 · planner · unic-smart
Keep this VS Code-free and test with deferred promises. Do not debounce callers, alter TTL policy, or cancel adapter introspection during invalidation.

---

## Executor Report

(pending)

## Reviewer Verdict

(pending)
