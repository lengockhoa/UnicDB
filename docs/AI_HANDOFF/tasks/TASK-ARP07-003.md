# TASK-ARP07-003 — AI schema cache: invalidate-during-hydration stale-commit fix

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §4, §5, §6

## Goal

Close a REAL race in `schemaContextCache.ts`: `hydrate()` commits its cache entry unconditionally
(`schemaContextCache.ts:175-180`), so an `invalidate()` that lands while a hydration is in flight does
NOT stop the stale (pre-DDL) entry from committing. After the fix, `invalidate()` must (a) prevent a
pre-invalidate hydration from committing its entry, and (b) stop a post-invalidate `resolve()` from
coalescing onto a pre-invalidate hydration. Preserve the resolver's connection identity/race guard
(unchanged) and the return-by-reference cache-hit contract.

## Target Files

- `src/ai/schemaContextCache.ts` — add a `generation` counter: `hydrate()` captures `startGen` and commits
  `entry` only if `generation === startGen`; `invalidate()` bumps `generation` and drops the in-flight
  hydration reference using an ownership check (the old hydration's `finally` must not null a NEW promise
  installed after the drop). Interface unchanged.
- `src/ai/__tests__/schemaContextResolver.test.ts` — add the two RED-first regression tests + idempotence edge.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | regression (RED first) | invalidate() during an in-flight hydration → hydration resolves → entry must NOT be committed; next `resolve` re-hydrates | RED on current commit (`listTables`/`listColumns` NOT re-called because stale entry committed); GREEN after fix (entry null → `resolve` calls adapter again) | cache with slow `listColumns` (a `Promise` gate the test resolves AFTER `invalidate()`); assert adapter call count after two resolves |
| 2 | regression (RED first) | resolve() AFTER invalidate() while a pre-invalidate hydration is still pending → starts a FRESH hydration, does not return the stale in-flight one | RED on current commit (post-invalidate resolve returns the in-flight stale context, no new adapter call); GREEN after fix (a new adapter call starts) | begin hydrate, `invalidate()`, then `resolve()`; assert a NEW `listTables` invocation began before the old one settled |
| 3 | edge (idempotent) | `invalidate()` twice with no hydration; `invalidate()` on empty cache | no-op, no throw; next `resolve` re-hydrates exactly once | fresh cache, `invalidate()`, `invalidate()`, then `resolve` — adapter called once |
| 4 | happy (contract kept) | existing cache tests unchanged | pass: "repeated resolve same connection → same reference" (`schemaContextResolver.test.ts:167`), "invalidate() refreshes" (`187`), "connection change re-hydrates" (`206`), "invalidate clears entire cache" (`316`) | existing fixtures |

## Test Files

- `src/ai/__tests__/schemaContextResolver.test.ts` — the roadmap-correct file and where the cache tests
  already live. NOTE: the tests-map entry for `src/ai/schemaContextCache.ts` is stale — it resolves to
  `src/ai/tools/__tests__/schemaContext.test.ts`, which only tests `formatSchemaContext`. Run the resolver
  file, not the map's file.

## Verification Commands

```bash
npm test src/ai/__tests__/schemaContextResolver.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Regression tests #1 and #2 FAIL on the current commit (run first), PASS after the fix.
- [ ] `SchemaContextCache` public interface unchanged: `resolve(scope: string): Promise<SchemaContext>` and `invalidate(): void` signatures identical.
- [ ] Resolver identity/race guard untouched; existing cache tests (#4) pass.
- [ ] No other source file touched.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `createSchemaContextCache(deps: ResolverDeps, opts?: SchemaContextCacheOptions): SchemaContextCache` (existing, `schemaContextCache.ts:129`); `SchemaContextCache.invalidate(): void` (existing, `217-219`).
- Produces: the same `SchemaContextCache` interface with the internal fix. Consumed by TASK-ARP07-004, which calls `acSchemaCache.invalidate()`.

---

## Discussion

(no comments yet)

---

## Executor Report

<!-- Phase 3 executor appends below. -->

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->
