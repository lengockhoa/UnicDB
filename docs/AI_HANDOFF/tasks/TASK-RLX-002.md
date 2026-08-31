# TASK-RLX-002 — Coalesce SchemaCache stale refreshes

- Status: `pending_review`
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

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  RUN v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-rlx-002
   ❯ src/ui/__tests__/schemaCache.test.ts  (9 tests | 3 failed) 208ms
     ❯ ... TASK-RLX-002 single-flight coalescing > #1 concurrent stale getTables(schema) coalesce into one adapter call
       → expected "spy" to be called 1 times, but got 2 times
     ❯ ... #2 shared refresh rejection returns stale value to every caller
       → expected "spy" to be called 2 times, but got 3 times
     ❯ ... #3 invalidate defeats a refresh that started before it
       → expected "spy" to be called 2 times, but got 1 times
   Test Files  1 failed (1)
   Tests  3 failed | 6 passed (9)
  Note: a first RED run failed for the wrong reason (sync call-count assertions
  ran before the cache reached adapter.listTables → "got 0 times"). Tests were
  corrected with a microtask flush before mid-flight assertions; the RED above
  is the corrected, wrong-reason-free run. #1 shows duplicate adapter calls (no
  coalescing), #2 shows 3 calls (each caller refreshed alone), #3 shows the
  pre-invalidate response populating cache (next read served without fetch).
Verification Output: |
  $ npx vitest run src/ui/__tests__/schemaCache.test.ts
   ✓ src/ui/__tests__/schemaCache.test.ts  (9 tests) 4ms
   Test Files  1 passed (1)
   Tests  9 passed (9)
   Start at  21:09:30
   Duration  208ms
  $ npm run typecheck
  > vsdb@1.26.0 typecheck
  > tsc --noEmit
  (exit 0, no errors)
  Regression net (7 dependent files): 44 passed (44) — schemaCache, sqlCatalog,
  sqlCompletionProvider, sqlNavigationProvider, sqlSemanticTokens, dbx01/03 scaffold.
Status: PASS
Note: none — public signatures and default ttlMs 60_000 unchanged; invalidate()
stays synchronous, does not cancel adapter I/O; different keys use distinct
in-flight slots (`tables:public` vs `tables:all` vs `columns:<s>.<t>` etc.).

## Reviewer Verdict

(pending)

---

## Executor Report (fix round 1)

EXECUTOR_TOOL: claude-code (main session)
EXECUTOR_MODEL: unic-code

Fix applied: When `fetch()` threw SYNCHRONOUSLY, the async IIFE body settled during its
sync phase — before `this.inflight.set(key, work)` on the following line had run — so the
inner `finally`'s identity check compared `undefined === undefined` (deleted nothing) and
the already-settled dead promise was then registered permanently. Every later caller
coalesced onto that dead entry and could never retry fresh; even `invalidate()` never
cleared the inflight map. Fix: both `fetchEntry` and `fetchEntryDdl` now create the work
promise as `Promise.resolve().then(async () => { ...same body... })`, deferring the body
one microtask so registration always completes first; the existing `finally` cleanup then
runs normally on every throw path (sync throw and async rejection alike). Callers still
receive the stale-on-error fallback (`[]` / prior cache), never a hang.

RED_OUTPUT (regression test "sync-throwing provider leaves no stuck in-flight entry" against the round-1 implementation):
```
 FAIL  src/ui/__tests__/schemaCache.test.ts > SchemaCache — TASK-RLX-002 single-flight coalescing > sync-throwing provider leaves no stuck in-flight entry
AssertionError: expected [] to be [ Array(1) ] // Object.is equality

- Expected
+ Received

- Array [
-   Object {
-     "name": "orders",
-     "schema": "public",
-   },
- ]
+ Array []

 ❯ src/ui/__tests__/schemaCache.test.ts:229:5
    229|     await expect(cache.getTables("public")).resolves.toBe(fresh);

 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```
Part (a) passed — first caller got the stale-on-error `[]` fallback without hanging;
part (b) failed for exactly the reported reason — the second load coalesced onto the
dead registry entry and returned `[]` instead of calling the recovered provider
(call count stayed 1, expected 2).

Verification: `npx vitest run src/ui/__tests__/schemaCache.test.ts` → 10 passed (10),
1 file passed. `npm run typecheck` → exit 0, no errors. Regression net: sqlCatalog,
sqlCompletionProvider, sqlNavigationProvider, sqlSemanticTokens → 26 passed (26).

Status: PASS
