# TASK-DBX04-001 — FK graph pure module

Status: pending · Wave: 1 · Plan: PLAN_DBX04.md §4
Reviewer verdict: (none yet)

## Scope

`src/core/er/fkGraph.ts` + `src/core/er/__tests__/fkGraph.test.ts`.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: write fkGraph.test.ts per PLAN §3 row 1; run; capture failing
   output (module absent) into the executor report.
2. GREEN: implement buildErGraph + ErGraph/ErNode/ErEdge exactly per
   PLAN §2 (closed-world edge drop, conkey 1-based ordinals,
   self-references kept, deterministic order).

## Acceptance

- fkGraph.test.ts ~8 tests green; determinism asserted
- `npm run typecheck` exit 0
- Targeted vitest file(s) pass; no unrelated file touched
