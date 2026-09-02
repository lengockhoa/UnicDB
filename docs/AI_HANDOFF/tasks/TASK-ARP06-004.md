# TASK-ARP06-004 — Per-turn usage accounting + bounded-session budget (agent)

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3/§4 (ARP-06.4)

## Goal

`runAgent` reports exact per-turn usage accounting; unknown usage is never invented; aborted turns never
fabricate usage; the ONLY hard stop remains the approved `maxSteps` budget.

## Target Files

- `src/ai/agent.ts` — add `TurnUsageSummary` type + pure `summarizeTurnUsage(steps)` helper; attach
  `usage: TurnUsageSummary` to `AgentRunResult` (computed by `runAgent` on every resolution path,
  budget-exhausted path included). NO new hard stop.
- `src/ai/__tests__/agent.test.ts` — extend with the accounting pins.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | exact cumulative usage across steps | `summarizeTurnUsage` → `{ inputTokens:8, outputTokens:10, unknown:false, steps:3 }`; `runAgent(...).usage` matches | 3 steps with usage `1/1`, `2/3`, `5/6` |
| 2 | edge: unknown | all-unknown usage never invented | every step `{0,0}` → `{ 0, 0, unknown:true, steps:N }` — no fabricated cost | steps all `{0,0}` |
| 3 | edge: mixed | partial unknowns are summed, not treated as unknown | `{0,0}`, `{5,3}`, `{0,0}` → `{ inputTokens:5, outputTokens:3, unknown:false, steps:3 }` | mixed steps |
| 4 | edge: empty | budget-capped with zero completed steps | `{ 0, 0, unknown:true, steps:0 }`; `stoppedOnBudget:true` | tool-only model, `maxSteps` exhausted before a no-tool reply |
| 5 | edge: aborted | aborted turn returns no invented usage | abort path rethrows (no `AgentRunResult`); the resolved-result path never fabricates usage | `AbortError` mid-run |
| 6 | edge: budget | hard stop remains ONLY `maxSteps` | `stoppedOnBudget:true`, usage reflects completed steps only; run completes exactly `maxSteps` steps with no new token-based kill | tool-only model, `maxSteps: 3` |

## Test Files

- `src/ai/__tests__/agent.test.ts` — extended (tests above). Existing suite already has usage fixtures
  (`usage: { inputTokens: 1, outputTokens: 1 }`), `stoppedOnBudget`, and `maxSteps` tests; the new cases
  add the summary helper + `AgentRunResult.usage` + unknown/empty/abort/budget-only-stop pins.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/agent.test.ts
npm run typecheck
npm run compile
```

No lint script exists — `npm run typecheck` is the static gate. Selection per RULES: `agent.ts` →
tests-map `[agent.test.ts, agentStream.test.ts]` — the pinned target is `agent.test.ts`; `agentStream.test.ts`
runs in the cycle `npm test` net.

## Acceptance Criteria

- [ ] `summarizeTurnUsage` is pure and exported; `AgentRunResult.usage` is present on both resolution
      paths (normal completion AND budget exhaustion).
- [ ] All-unknown → `unknown:true`, never invented cost; mixed → summed real values, `unknown:false`;
      empty → `{0,0,unknown:true,steps:0}`.
- [ ] Abort path never resolves an `AgentRunResult` with fabricated usage.
- [ ] No new hard stop: `stoppedOnBudget` semantics unchanged, `maxSteps` is the only termination lever.
- [ ] RED evidence pasted before any production change; production logic changed ONLY if a pin was RED.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — reads the existing `ProviderResult.usage` from `provider.ts` (unchanged; ARP-06.3 pins that
  contract, it does not change it).

## Interfaces

- Consumes:
  - `ProviderResult.usage: { inputTokens: number; outputTokens: number }` (existing, from `provider.ts`).
  - `AgentStep { messages: ChatMessage[]; result: ProviderResult }` (existing, `agent.ts:64-68`).
- Produces:
  - `export interface TurnUsageSummary { inputTokens: number; outputTokens: number; unknown: boolean; steps: number }`
  - `export function summarizeTurnUsage(steps: readonly AgentStep[]): TurnUsageSummary` (pure).
  - `AgentRunResult` gains `usage: TurnUsageSummary` (in addition to the existing `steps`, `history`,
    `finalText`, `stoppedOnBudget`). **Consumed by TASK-ARP06-005.**

---

## Discussion

(no comments yet)

---

## Executor Report

```
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Claude:feature-implementer
```

RED_OUTPUT (actual failing output after writing §Test Cases 1-6, before any production change):

```
 FAIL  src/ai/__tests__/agent.test.ts > runAgent — per-turn usage accounting (TASK-ARP06-004) > test #1 exact cumulative usage across steps — helper and AgentRunResult agree
 FAIL  src/ai/__tests__/agent.test.ts > runAgent — per-turn usage accounting (TASK-ARP06-004) > test #2 all-unknown usage is never invented (zeros stay zeros, unknown:true)
 FAIL  src/ai/__tests__/agent.test.ts > runAgent — per-turn usage accounting (TASK-ARP06-004) > test #3 partial unknowns are summed, not treated as unknown
 FAIL  src/ai/__tests__/agent.test.ts > runAgent — per-turn usage accounting (TASK-ARP06-004) > test #4 empty steps → zeros/unknown:true; budget-capped run reports usage from completed steps only
TypeError: summarizeTurnUsage is not a function
 FAIL  src/ai/__tests__/agent.test.ts > runAgent — per-turn usage accounting (TASK-ARP06-004) > test #6 maxSteps is the ONLY hard stop — huge reported usage never kills the run early
AssertionError: expected undefined to deeply equal { inputTokens: 2700, …(3) }  — out.usage === undefined
      Tests  5 failed | 28 passed (33)
```

Note: test #5 (abort) passed on base — it pins existing frozen TASK-002 abort behavior
(`AbortError` mid-run rethrows, no re-request). GREEN-on-base pin, permitted: the task
spec's acceptance criterion for abort is "never resolves a fabricated AgentRunResult",
which the base already guarantees and the pin locks.

Verification Output (all three §Verification Commands, fresh in this turn):

```
$ npx vitest run src/ai/__tests__/agent.test.ts
 ✓ src/ai/__tests__/agent.test.ts  (33 tests) 14ms
 Test Files  1 passed (1)
      Tests  33 passed (33)
   Start at  06:37:59
   Duration  209ms (transform 53ms, setup 0ms, collect 46ms, tests 14ms, environment 0ms, prepare 36ms)

$ npm run typecheck
> tsc --noEmit
exit 0

$ npm run compile
esbuild: build complete
exit 0
```

Status: PASS

```
SUMMARY: Added exported pure `summarizeTurnUsage(steps)` + `TurnUsageSummary` and attached
`usage: TurnUsageSummary` to `AgentRunResult` on BOTH resolution paths (normal completion and
budget exhaustion). No new hard stop — maxSteps untouched as the only termination lever; abort
path still rethrows and never resolves a fabricated result.
TEST_PLAN_FOLLOWED: task §Test Cases (all 6) + §Verification Commands.
FILES_CHANGED:
  - src/ai/agent.ts: TurnUsageSummary interface + pure exported summarizeTurnUsage() +
    usage field on AgentRunResult, computed on both return paths (stoppedOnBudget true and false).
  - src/ai/__tests__/agent.test.ts: 6 new accounting pins (exact sum, all-unknown, mixed partial,
    empty + budget-capped, abort rethrow, maxSteps-only hard stop with huge usage).
TESTS_ADDED:
  - src/ai/__tests__/agent.test.ts: runAgent — per-turn usage accounting (TASK-ARP06-004):
    test #1..#6 per task §Test Cases.
VERIFICATION:
  command: npx vitest run src/ai/__tests__/agent.test.ts && npm run typecheck && npm run compile
  result: 33 pass / 0 fail; typecheck exit 0; compile exit 0
  output_excerpt: |
     Test Files  1 passed (1)
          Tests  33 passed (33)
     > tsc --noEmit  (exit 0)
     esbuild: build complete  (exit 0)
ISSUES: one mid-green hiccup — 3 pre-existing trace tests build steps from untyped mocks without
a `usage` object; summarizeTurnUsage initially crashed reading `.inputTokens` of undefined.
Fixed defensively: missing `usage` counts as NOT reported (0/0), consistent with the
"reported or unknown — never invented" policy. provider.ts itself always sets usage; no
provider change was needed or made.
HANDOFF_TO_REVIEWER: yes — all acceptance criteria met except the review verdict itself.
NEXT: ready for review (TASK-ARP06-005 can consume the interface now).
```

Interface shape for TASK-ARP06-005 (exact, produced here):

```ts
export interface TurnUsageSummary {
  inputTokens: number;   // sum of reported input tokens over completed steps
  outputTokens: number;  // sum of reported output tokens over completed steps
  unknown: boolean;      // true iff NO completed step reported a nonzero count
  steps: number;         // completed step count folded into this summary
}
// AgentRunResult.usage: TurnUsageSummary — present on every resolved result
// (stoppedOnBudget true AND false). Abort paths rethrow: no result, no usage.
```

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
