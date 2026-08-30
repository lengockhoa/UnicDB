# TASK-AIX01-002 — Bounded file search pure module

Status: pending · Wave: 1 · Plan: PLAN_AIX01.md §5
Reviewer verdict: (none yet)

## Scope

`src/ai/grounding/fileSearch.ts` + tests.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: fileSearch.test.ts per PLAN §4 row 2; capture failing output.
2. GREEN: searchWorkspaceFiles over pre-read contents (deterministic
   ranking, MAX_FILE_HITS=8, MAX_CONTEXT_LINES=40), glob matcher,
   isProbablyBinary + containsSecretHeuristic with excluded list.

## Acceptance

- fileSearch ~10 tests green
- `npm run typecheck` exit 0
- Targeted vitest file(s) pass; no unrelated file touched
