# TASK-DBX04-002 — Layout + SVG export pure modules

Status: pending · Wave: 1 · Plan: PLAN_DBX04.md §4
Reviewer verdict: (none yet)

## Scope

`src/core/er/layout.ts`, `src/core/er/svgExport.ts` + tests.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: layout.test.ts + svgExport.test.ts per PLAN §3 rows 2-3;
   capture failing output.
2. GREEN: layoutErGraph (layered, cycle-safe via visited set,
   deterministic) and renderErSvg (XML-escaped, deterministic,
   viewBox = layout dims). Import types from `./fkGraph`.

## Acceptance

- layout ~8 + svgExport ~7 tests green; cycle fixtures terminate
- `npm run typecheck` exit 0
- Targeted vitest file(s) pass; no unrelated file touched
