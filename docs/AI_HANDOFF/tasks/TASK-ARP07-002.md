# TASK-ARP07-002 — Schema cache race: invalidate-during-fetch (verify-first)

- Status: `pending_review`
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

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: Claude:feature-implementer

**Approach note.** Task file Test Cases are marked REQUIRED, and Acceptance Criterion 2 ("If no
source change was needed … regression pinned") requires the DDL-named regression pins to exist —
so the 3 test-only pins were added to the harness (test file only, explicitly in Target Files).
Expected outcome held: GREEN against current `schemaCache.ts` with zero source change.
Mutation-sensitivity probe run per cycle brief to prove non-tautology.

**Probe method.** Temporarily replaced the commit gate `if (this.generation === startGen)`
(schemaCache.ts:374, fetchEntry) with `if (true)` — the exact guard the invariant rests on —
ran the suite, captured RED, then restored the line. Restore proven byte-identical:
sha256 before probe `1e64e63589cf60a2a052ce8924efc8b44f878db4bb8a1f2c2369046fd27234ad` ==
after probe `1e64e63589cf60a2a052ce8924efc8b44f878db4bb8a1f2c2369046fd27234ad`;
`git status --porcelain src/ui/schemaCache.ts` → empty.

RED_OUTPUT (probe — guard mutated off, expected failures on all stale-commit pins):
```
 FAIL  src/ui/__tests__/schemaCache.test.ts > SchemaCache — TASK-RLX-002 single-flight coalescing > #3 invalidate defeats a refresh that started before it
AssertionError: expected "spy" to be called 2 times, but got 1 times
 FAIL  src/ui/__tests__/schemaCache.test.ts > SchemaCache — TASK-ARP07-002 DDL invalidation race > #1 DDL-shaped: invalidate lands while a completion lookup is in flight → stale response never commits; next getTables refetches fresh
AssertionError: expected "spy" to be called 2 times, but got 1 times
 FAIL  src/ui/__tests__/schemaCache.test.ts > SchemaCache — TASK-ARP07-002 DDL invalidation race > #3 invalidate during CONCURRENT tables + columns fetches → neither family commits stale data; both keys refetch
AssertionError: expected "spy" to be called 2 times, but got 1 times
 Test Files  1 failed (1)
      Tests  3 failed | 20 passed (23)
```
Probe RED analysis: with the gate off, the stale pre-invalidate response commits into the cache
slot, so the post-invalidate "refetch" is served from the stale commit and the fresh-refetch
`toHaveBeenCalledTimes(2)` assertions fail — exactly the invariant these pins defend. ARP-07
`#2` (invalidate BEFORE fetch) correctly stays green under this mutation: it never has an
in-flight fetch, so it does not exercise the commit gate.

Verification Output (Verification Commands, fresh, after restore):
```
> UnicDB@1.42.0 test
> vitest run src/ui/__tests__/schemaCache.test.ts
 ✓ src/ui/__tests__/schemaCache.test.ts  (23 tests) 7ms
 Test Files  1 passed (1)
      Tests  23 passed (23)

> UnicDB@1.42.0 typecheck
> tsc --noEmit
typecheck exit: 0
```
Full-suite regression net (wave boundary): `npm test` → 217 passed | 1 skipped (218 files),
3097 passed | 2 skipped (skips pre-existing on base).

Status: PASS

Note: verify-only closed no-change — generation guard (schemaCache.ts:74, 288-308, 374) already
covers DDL-invalidation; DDL-scenario regression pinned. No source file touched; only
schemaCache.test.ts (3 new pins in a new `TASK-ARP07-002` describe block) + this task file
changed. Gap test not needed — no gap found.

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
VERIFICATION_RERUN:
  command: npm test src/ui/__tests__/schemaCache.test.ts && npm run typecheck
  result: 23 pass / 0 fail; typecheck exit 0
TEST_PLAN_COVERAGE: all-followed (3 pins added in new TASK-ARP07-002 describe block)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: git diff 76e4bac..HEAD -- src/ui/schemaCache.ts is EMPTY (verified independently — byte-identical, no diff); sha256 before==after + clean git status corroborate the probe-restore claim. Sensitivity probe genuine: with the commit gate `if (this.generation === startGen)` replaced by `if (true)`, pins #1 and #3 fail with real assertion output (`expected "spy" to be called 2 times, but got 1`); pin #2 correctly stays green under the mutation (no in-flight fetch at invalidate time) exactly as documented. The 3 pins are non-tautological and cover the DDL invalidation races: stale response settles its own caller but never commits, both single- and multi-family (tables + columns) refetch fresh, invalidate-before-fetch opens no phantom stale window. Verify-only task closed no-change as required.
