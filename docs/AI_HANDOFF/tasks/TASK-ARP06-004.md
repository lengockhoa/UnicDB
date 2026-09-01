# TASK-ARP06-004 — Per-turn usage accounting + bounded-session budget (agent)

- Status: `ready`
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

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
