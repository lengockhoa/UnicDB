# TASK-ARP07-002 — Schema cache race: invalidate-during-fetch (verify-first)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §4, §5, §6

## Goal

Prove that `SchemaCache` already defeats a stale commit when `invalidate()` lands while a completion
fetch is in flight (the exact race the successful-DDL wiring in TASK-ARP07-004 will drive), and pin it
with a feature-named regression test. VERIFY-FIRST: **modify `src/ui/schemaCache.ts` only if the new
test exposes a gap — expected: no source change needed.**

## Target Files

- `src/ui/__tests__/schemaCache.test.ts` — add the DDL-scenario regression tests below.
- `src/ui/schemaCache.ts` — ONLY if a new test fails (expected: none). The generation guard at
  `schemaCache.ts:74` + `invalidate()` bump at `288-308` + commit gate `if (this.generation === startGen)`
  at `374` already implement the invariant.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | `#3`-style variant named for DDL: invalidate lands while a completion lookup is in flight → pre-invalidate response never becomes cache state; next `getTables` refetches fresh | passes against CURRENT code; cache slot empty after invalidate; awaiting caller still resolves (with the old data it was promised) | existing harness at `schemaCache.test.ts:194-227` — `const inflight = cache.getTables("public"); cache.invalidate(); await inflight` |
| 2 | edge (order) | invalidate BEFORE a fetch starts | normal fresh fetch, no stale window; cached entry is the fresh adapter data | fresh `SchemaCache`, `invalidate()`, then `getTables` |
| 3 | edge (boundary — multi-family) | invalidate during concurrent tables + columns fetches | neither family commits stale data; subsequent lookups for both keys refetch | two keys in flight (`getTables("public")` + `getColumns("users","public")`), then `invalidate()`, assert both slots empty after resolve |

## Test Files

- `src/ui/__tests__/schemaCache.test.ts` — add to the existing `TASK-RLX-002 single-flight coalescing` describe block (or a new ARP-07 block). Follow the existing harness (fake adapter provider, `SchemaCache` instance).

## Verification Commands

```bash
npm test src/ui/__tests__/schemaCache.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] New tests pass against the current `schemaCache.ts`.
- [ ] If no source change was needed, the Executor Report states explicitly: "no change required — generation guard (schemaCache.ts:74,288-308,374) already covers DDL-invalidation; regression pinned."
- [ ] If a test DID fail, fix only the minimal gap in `schemaCache.ts` and record the failing-then-passing evidence.
- [ ] No other source file touched.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `SchemaCache.invalidate(): void` (existing public API, `schemaCache.ts:288`).
- Produces: (none — no new API; the DDL seam uses the same public `invalidate()`).

---

## Discussion

(no comments yet)

---

## Executor Report

<!-- Phase 3 executor appends below. -->

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->
