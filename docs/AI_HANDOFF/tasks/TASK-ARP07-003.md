# TASK-ARP07-003 — AI schema cache: invalidate-during-hydration stale-commit fix

- Status: `pending_review`
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

### RED — confirmed (before fix)

Command: `npx vitest run src/ai/__tests__/schemaContextResolver.test.ts`

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-arp07-003

 ❯ src/ai/__tests__/schemaContextResolver.test.ts  (15 tests | 2 failed) 1116ms
   ❯ src/ai/__tests__/schemaContextResolver.test.ts > schemaContextCache — invalidate during in-flight hydration (ARP-07) > does NOT commit an entry for a hydration invalidated mid-flight (next resolve re-hydrates)
     → expected "spy" to be called 2 times, but got 1 times
   ❯ src/ai/__tests__/schemaContextResolver.test.ts > schemaContextCache — invalidate during in-flight hydration (ARP-07) > resolve() AFTER invalidate() starts a FRESH hydration instead of returning the stale in-flight one
     → expected "spy" to be called 2 times, but got 1 times

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/__tests__/schemaContextResolver.test.ts > schemaContextCache — invalidate during in-flight hydration (ARP-07) > does NOT commit an entry for a hydration invalidated mid-flight (next resolve re-hydrates)
AssertionError: expected "spy" to be called 2 times, but got 1 times
 ❯ src/ai/__tests__/schemaContextResolver.test.ts:368:24

 FAIL  src/ai/__tests__/schemaContextResolver.test.ts > schemaContextCache — invalidate during in-flight hydration (ARP-07) > resolve() AFTER invalidate() starts a FRESH hydration instead of returning the stale in-flight one
AssertionError: expected "spy" to be called 2 times, but got 1 times
 ❯ src/ai/__tests__/schemaContextResolver.test.ts:400:47

 Test Files  1 failed (1)
      Tests  2 failed | 13 passed (15)
   Start at  08:18:09
   Duration  1.30s (transform 29ms, setup 0ms, collect 28ms, tests 1.12s, environment 0ms, prepare 41ms)
```

Both regression tests fail exactly on the unconditional-commit gap: after invalidate()
during an in-flight hydration, the stale entry is committed / the stale in-flight
promise is returned, so no second adapter call happens. Edge test #3 (idempotent
invalidate on empty cache) passes pre-fix as expected; all 13 pre-existing tests pass.

### Fix implemented

`src/ai/schemaContextCache.ts` (only source file touched):
- Added `generation` counter (starts 0).
- `hydrate(startGen)` commits `entry` only `if (generation === startGen)` — an
  `invalidate()` landing mid-flight makes the stale hydration's commit a no-op
  (mirrors the resolver's identity/race-guard discipline).
- `invalidate()` now does `entry = null; generation++; inflight = null;` — a
  post-invalidate `resolve()` no longer coalesces onto the stale in-flight promise.
- The old hydration's `finally` uses an ownership check
  (`if (inflight === p) inflight = null;`) so it cannot null a NEW promise
  installed after invalidate() dropped the reference.
- Public interface unchanged: `resolve(scope): Promise<SchemaContext>`,
  `invalidate(): void`. Resolver identity/race guard untouched.

One test-fixture iteration during GREEN: the first version of test #1's gated
`listColumns` returned `stale_col` on EVERY call, so the post-fix assertion
(`columns[0].name === "id"`) could not distinguish fresh data; fixture now
returns gated stale data for call 1 and immediate fresh data for call 2+.
(RED assertions and call-count expectations were unchanged by this adjustment.)

### Verification Output (after fix)

Command: `npm test src/ai/__tests__/schemaContextResolver.test.ts` (worktree)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-arp07-003

 ✓ src/ai/__tests__/schemaContextResolver.test.ts  (15 tests) 162ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  08:20:07
   Duration  330ms (transform 24ms, setup 0ms, collect 23ms, tests 162ms, environment 0ms, prepare 43ms)
```

Command: `npm run typecheck`

```
> vsdb@1.42.0 typecheck
> tsc --noEmit

(no errors, exit 0)
```

Extra (beyond task commands, shared-scope confidence): `npm test` (full suite)

```
 Test Files  217 passed | 1 skipped (218)
      Tests  3097 passed | 2 skipped (3099)
   Duration  17.39s
```

### Acceptance Criteria check

- [x] Regression tests #1 and #2 FAIL on current commit (RED output above), PASS after fix.
- [x] `SchemaContextCache` public interface unchanged.
- [x] Resolver identity/race guard untouched; existing cache tests (#4) pass (all 13 pre-existing pass).
- [x] No other source file touched (git diff: only schemaContextCache.ts, schemaContextResolver.test.ts, this task file).
- [ ] Reviewer verdict — pending (Phase 4).

### Summary block

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Claude:feature-implementer
RED_OUTPUT: confirmed — 2 failed | 13 passed (15): both ARP-07 regression tests failed with
`expected "spy" to be called 2 times, but got 1 times` (schemaContextResolver.test.ts:368 and :400),
i.e. the stale hydration committed and the post-invalidate resolve coalesced onto it, so no second
adapter call ever ran. Full output captured above.
Verification Output: `npm test src/ai/__tests__/schemaContextResolver.test.ts` → 15 passed (15);
`npm run typecheck` → exit 0, no errors; bonus `npm test` full suite → 3097 passed | 2 skipped, 0 failed.
Status: PASS
Note: none — one in-lane test-fixture refinement during GREEN (stale-data stub now scoped to call 1
only so the fresh-data assertion is meaningful); RED assertions unchanged. Boundaries respected:
no extension.ts / schemaCache.ts / schemaImpact.ts changes; no git operations; INDEX.md untouched.


## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm test src/ai/__tests__/schemaContextResolver.test.ts
  result: 15 pass / 0 fail
  command: npm run typecheck
  result: exit 0, no errors
  command: npm test (full suite)
  result: 3120 pass / 2 skip / 0 fail
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/__tests__/schemaContextResolver.test.ts:432 — file ends without trailing newline; cosmetic only.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Generation guard (commit iff generation===startGen) + inflight drop + ownership-checked finally (`if (inflight === p)`) closes the invalidate-during-hydrate race and the post-invalidate coalescing gap; no new leak path (invalidate nulls inflight directly; stale finally no-ops against a newer promise). Resolver untouched; TTL re-hydration and normal coalescing preserved. INDEX.md not updated per run instruction.
