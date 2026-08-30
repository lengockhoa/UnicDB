# TASK-AIX01-004 — Scaffold hygiene + full regression

Status: pending · Wave: 3 · Plan: PLAN_AIX01.md §5
Reviewer verdict: (none yet)

## Scope

`src/__tests__/aix01Scaffold.test.ts`.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: purity guards (no vscode in src/ai/grounding/*, no network
   imports, no eval, word-safe secret patterns); capture failing output.
2. GREEN: fix violations.
3. Full regression: `npx vitest run` 0 failed; `npm run typecheck`.

## Acceptance

- scaffold ~5 green; full suite green
- `npm run typecheck` exit 0
