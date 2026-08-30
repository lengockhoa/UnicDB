# TASK-AIX01-001 — Selection + attribution pure modules

Status: pending · Wave: 1 · Plan: PLAN_AIX01.md §5
Reviewer verdict: (none yet)

## Scope

`src/ai/grounding/selection.ts`, `src/ai/grounding/attribution.ts` + tests.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: selection.test.ts + attribution.test.ts per PLAN §4 rows 1,3;
   capture failing output (module absent).
2. GREEN: extractSelection (blank-edge trim, 8_000-char cap +
   truncated, line clamp, empty -> null), formatSelectionBlock,
   AttributionRecord (dedupe by ref, order-stable, footer).

## Acceptance

- selection ~8 + attribution ~6 tests green
- `npm run typecheck` exit 0
- Targeted vitest file(s) pass; no unrelated file touched
