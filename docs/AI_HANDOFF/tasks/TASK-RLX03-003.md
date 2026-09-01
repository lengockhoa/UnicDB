# TASK-RLX03-003 — Invalidate SchemaCache on adapter replacement

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_RLX03.md` §1–§3

## Goal

Make the existing global SchemaCache invalidate before returning any fresh-TTL entry from a newly resolved `DbAdapter`. This prevents stale cross-connection and post-reconnect schema data while retaining stale-on-error/null behavior and RLX-01’s single-flight/generation guarantees.

## Target Files

- `src/ui/schemaCache.ts` — observe resolved non-null adapter identity inside the existing provider-resolution path and invoke the existing generation-based `invalidate(): void` before cache freshness is evaluated for a replacement adapter.
- `src/ui/__tests__/schemaCache.test.ts` — extend the existing deferred adapter/clock unit suite with adapter-transition, pre-transition in-flight, null/throw fallback, and same-adapter single-flight assertions.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | `adapter B transition replaces fresh schema and table cache families` | After A caches `getSchemas()`, `getTables()`, and `getTables("public")`, changing provider output to B makes each next lookup call its B method exactly once and return B’s distinct values despite A’s TTL still being fresh. This shared case covers `schemasEntry`, `tablesAllEntry`, and `tablesBySchema`. | Two inspectable fake `DbAdapter` objects, fixed injected `now`, provider variable initially A then B. |
| 2 | edge — cache-ordering/catalog | `adapter B transition replaces every pre-resolve column and catalog/DDL cache family` | After A caches `getColumns("users", "public")`, `getViews("public")`, `getRoutines("public")`, `getSequences("public")`, `getConstraints("public", "users")`, and `getObjectDdl("view", "public", "v_users")`, switching to catalog-and-objectDdl-capable B makes each next lookup call B and return its distinct B value, never A’s fresh value. This shared case covers `columnsByKey`, `viewsBySchema`, `routinesBySchema`, `sequencesBySchema`, `constraintsByKey`, and `ddlByKey`. | A and B advertise the required `catalog` and `objectDdl` capabilities and expose distinct inspection results; fixed injected clock preserves fresh TTL. |
| 3 | edge — in-flight ordering | `A response begun before adapter B transition cannot commit after invalidation` | Deferred A result still resolves to its original caller, but after provider changes to B, a B read fetches `new`; a later within-TTL read remains `new` and never returns/commits A’s old response. | Existing `deferred<T>()` helper with fixed clock, A and B adapters. |
| 4 | edge — unavailable provider | `null and throwing provider keep cached stale data without changing adapter identity` | With A’s cached list, provider `null` and provider rejection both resolve to the exact A list; neither clears cache nor calls a replacement adapter. | Provider variable returning A, then null, then a rejected promise. |
| 5 | regression | `same adapter still coalesces concurrent expired reads` | Two expired `getTables("public")` reads while provider returns the same adapter call `listTables("public")` once and both resolve to the same refreshed list. | Existing RLX-01 deferred/single-flight fixture with `ttlMs: 0`. |

`hasCatalog()` has no cache entry: it resolves the current adapter and returns only its declared capability, so it needs no stale-entry transition fixture. The `inflight` map is coordination state rather than a cached data family; case 3 covers its generation-boundary behavior.

## Test Files

- `src/ui/__tests__/schemaCache.test.ts` — all listed identity-transition and cache-contract tests.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/schemaCache.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] The first resolved non-null adapter establishes cache identity without a spurious extra fetch; every later different non-null adapter calls the existing `invalidate(): void` before a cache freshness decision.
- [ ] The existing `generation` guard prevents a pre-transition in-flight result from overwriting entries belonging to the replacement adapter.
- [ ] A null/throwing provider still follows the source-proven stale-on-error result and does not erase the last resolved identity merely because an adapter is temporarily unavailable.
- [ ] Existing key-level single-flight, TTL semantics, catalog capability gates, DDL null semantics, and public `SchemaAdapterProvider`/`SchemaCache` method signatures remain unchanged.
- [ ] All listed tests pass and reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: `export type SchemaAdapterProvider = () => Promise<DbAdapter | null> | DbAdapter | null`, `SchemaCache.constructor(adapterProvider: SchemaAdapterProvider, options: SchemaCacheOptions = {})`, `private async resolveAdapter(): Promise<DbAdapter | null>`, `invalidate(): void`, and `getTables(schema?: string): Promise<TableInfo[]>` from `src/ui/schemaCache.ts`; `DbAdapter.listTables(schema?: string): Promise<TableInfo[]>` from `src/adapters/types.ts`.
- Produces: unchanged public signatures; `SchemaCache` now treats a different resolved non-null `DbAdapter` object identity as an adapter-generation boundary and invokes its existing `invalidate(): void` before serving a fresh cached entry.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Every public cache lookup already awaits `resolveAdapter()` before it calls `fetchEntry`, and `invalidate()` already increments `generation` before clearing all slots. Put identity observation there so every schema/table/catalog/DDL lookup shares the boundary and no extension-only connection-id convention is invented. Do not invalidate on `null` or provider throw: lines 296–302 intentionally preserve stale completion results when `getAdapter()` cannot currently resolve.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT: |
  npx vitest run src/ui/__tests__/schemaCache.test.ts — BEFORE implementation:

   ❯ src/ui/__tests__/schemaCache.test.ts  (19 tests | 3 failed) 13ms
   ❯ ... > TASK-RLX03-003 ... > #1 adapter B transition replaces fresh schema and table cache families
     → expected "spy" to be called 1 times, but got 0 times
   ❯ ... > #2 adapter B transition replaces every pre-resolve column and catalog/DDL cache family
     → expected [ { name: 'A_col', …(2) } ] to deeply equal [ { name: 'B_col', …(2) } ]
        - "name": "B_col",  + "name": "A_col"
   ❯ ... > #3 A response begun before adapter B transition cannot commit after invalidation
     → expected [ { name: 'old', schema: 'public' } ] to be [ { name: 'new', schema: 'public' } ]
        - "name": "new",  + "name": "old"

  Test Files  1 failed (1)
       Tests  3 failed | 16 passed (19)

  All three identity-transition tests failed for exactly the expected reasons
  (A's fresh-TTL entries served instead of calling B; A's stale response
  returned/committed after transition). #4 null/throw-stale and #5
  same-adapter single-flight passed immediately — correct, they pin EXISTING
  behavior as regression guards (task table marks #5 "regression"; #4 asserts
  the source-proven stale-on-error contract that the plan says must be
  retained, not introduced).

Implementation summary:
- `src/ui/schemaCache.ts`: added `private adapterIdentity: DbAdapter | null`
  and identity observation at the END of the existing `resolveAdapter()`
  (provider-resolution path): first non-null adapter only records identity
  (no spurious invalidate); a DIFFERENT later non-null adapter calls the
  existing `invalidate(): void` BEFORE the caller reads any cache slot or
  evaluates freshness; null/throw leaves identity untouched.
- Also moved the `existing` slot read to AFTER `await this.resolveAdapter()`
  in `getColumns`, `getViews`, `getRoutines`, `getConstraints`,
  `getSequences`, `getObjectDdl` — these six captured `existing` BEFORE
  resolution, so a transition-invalidate would have been evaluated against a
  pre-invalidation snapshot (stale slot leaked into fetchEntry's freshness
  check). `getSchemas`/`getTables` already read after resolution.
- `src/ui/__tests__/schemaCache.test.ts`: added inspectable `DbAdapter`
  factory + 5 tests (§Test Cases #1-#5). Existing fixtures that constructed
  a NEW adapter object per provider call were normalized to hold ONE stable
  adapter reference — adapter identity is now load-bearing, and a per-call
  new object encodes "connection changes every call". Test intent unchanged;
  production provider (extension.ts) already returns a stable cached ref.

Verification Output: |
  1) npx vitest run src/ui/__tests__/schemaCache.test.ts
     ✓ src/ui/__tests__/schemaCache.test.ts  (19 tests) 7ms
     Test Files  1 passed (1)
          Tests  19 passed (19)

  2) npm run typecheck
     > tsc --noEmit   (clean, no output, exit 0)

  3) npm run compile
     ⚡ Done in 139ms
       dist/extension.js      5.2mb ⚠️
       dist/extension.js.map  9.0mb
     ⚡ Done in 191ms
     esbuild: build complete

  Extra (touched-module consumers, not required by task):
  npx vitest run src/ui/__tests__/sqlCompletionProvider.test.ts
    src/ui/__tests__/sqlSemanticTokens.test.ts src/ui/__tests__/sqlCatalog.test.ts
    src/ui/__tests__/sqlNavigationProvider.test.ts src/__tests__/dbx01Scaffold.test.ts
    src/__tests__/dbx03Scaffold.test.ts
     Test Files  6 passed (6) | Tests  38 passed (38)

Status: PASS
Note: none — no lint script exists (per task file); acceptance criteria all hold: first non-null adapter establishes identity without extra fetch, different adapter invalidates before freshness evaluation, null/throw keeps stale + identity, generation guard blocks pre-transition commit, RLX-01 single-flight/TTL/capability-gate/DDL-null semantics unchanged, public signatures unchanged.

## Reviewer Verdict

VERDICT: critical_block
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
FINDINGS:
  critical:
    - src/ui/schemaCache.ts:356 — after an adapter transition invalidates generation, a same-key B lookup still returns A's pre-transition promise from `inflight`; it can return A schema data to B. Clear or generation-scope inflight work at the adapter boundary so B starts its own request while A may only settle its original caller.
  important:
    - src/ui/__tests__/schemaCache.test.ts:580 — case #3 resolves A before issuing B's lookup, so the adapter transition/invalidation occurs only at line 594 after A has committed. Start B's lookup while A remains deferred and assert that B does not coalesce onto A's old promise.
  minor: none
NEXT_STATUS_FOR_INDEX: critical_block

## Executor Report (fix round 1)

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT: |
  New test #3b `B lookup during A's unresolved refresh starts B's own request
  instead of A's promise` — run BEFORE the fix (TDD):

   ❯ src/ui/__tests__/schemaCache.test.ts  (20 tests | 1 failed) 11ms
   ❯ ... > #3b B lookup during A's unresolved refresh starts B's own request instead of A's promise
     → expected [ { name: 'old', schema: 'public' } ] to be [ { name: 'new', schema: 'public' } ] // Object.is equality
        - "name": "new",  + "name": "old"

  Test Files  1 failed (1)
       Tests  1 failed | 19 passed (20)

  Exactly the reviewer-predicted cross-adapter leak: `pendingB` (B's
  post-transition same-key lookup) resolved with A's pre-transition data
  (`old`) coalesced from the `inflight` map, instead of B's own `new` data.

Fix (critical):
- `src/ui/schemaCache.ts` — `invalidate()` now also calls `this.inflight.clear()`
  right after `this.generation += 1`. The single-flight registry is
  old-generation coordination state: entries created under the previous
  generation must not serve a lookup that resolves after the adapter
  transition. The bump+clear is synchronous in one turn, so no
  new-generation entry can be present yet — nothing live is stranded.
  A's original caller keeps its direct promise reference and still settles
  normally (the promise itself is untouched; only the shared registry is
  dropped). RLX-01 coalescing WITHIN one generation is unchanged — both
  existing single-flight suites (RLX-002 #1/#2/#3 and RLX03 #5) pass.

Fix (important):
- `src/ui/__tests__/schemaCache.test.ts` — new test #3b: start A's lookup
  (deferred, unresolved), switch provider to B, issue B's same-key lookup
  while A is STILL in flight. Asserts (a) B's caller receives B-data from
  B's OWN request (`bTables` called once, resolves `new`), (b) A's original
  caller still settles on A's own promise (`old`), (c) A's response never
  commits — the within-TTL read is served from B's committed entry with no
  extra B call. The existing test #3 already pinned the
  resolve-A-then-lookup-B ordering and is kept as a separate regression
  guard.

Verification Output: |
  1) npx vitest run src/ui/__tests__/schemaCache.test.ts
     ✓ src/ui/__tests__/schemaCache.test.ts  (20 tests) 7ms
     Test Files  1 passed (1) | Tests  20 passed (20)

  2) npm run typecheck
     > tsc --noEmit  (clean, exit 0)

  3) npm run compile
     ⚡ Done in 163ms — esbuild: build complete (exit 0)

  4) SchemaCache consumer guard (6 files the executor listed):
     npx vitest run src/ui/__tests__/sqlCompletionProvider.test.ts
       src/ui/__tests__/sqlSemanticTokens.test.ts src/ui/__tests__/sqlCatalog.test.ts
       src/ui/__tests__/sqlNavigationProvider.test.ts src/__tests__/dbx01Scaffold.test.ts
       src/__tests__/dbx03Scaffold.test.ts
     Test Files  6 passed (6) | Tests  38 passed (38)

Status: PASS
Note: none — inflight registry is now generation-scoped via the transition
boundary (invalidate clears it synchronously with the generation bump);
same-generation single-flight coalescing verified intact by all pre-existing
coalescing tests; no lint script exists (per task file).
