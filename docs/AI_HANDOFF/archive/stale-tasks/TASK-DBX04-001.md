# TASK-DBX04-001 — FK graph pure module

Status: done · Wave: 1 · Plan: PLAN_DBX04.md §4
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

## Executor Report

### 2026-08-30 · executor · omp-direct/unic-code

TDD RED→GREEN evidence:
- TASK-DBX04-001 RED: `Error: Failed to load url ../fkGraph ... Does the file exist?` → GREEN 8/8.
- TASK-DBX04-002 RED: `Failed to load url ../layout` / `../svgExport` → GREEN after implementation. One test failure during GREEN (parents-above-children) exposed an in-edge direction bug (inEdges keyed by target instead of source); fixed by mapping child→parents.
- TASK-DBX04-003 RED: `Failed to load url ../erPanel` → GREEN 14/14 (service 8 + panel 4 + html 2 within file). One fixture call bug (options passed in schema slot) corrected.
- TASK-DBX04-004: scaffold guards GREEN immediately (word-boundary regexes, DBX-03 lesson applied); T18 laterCycles list extended with UnicDB.relationshipExplorer — extension.test.ts 75/75.

Verification: targeted 32/32 (er core+service+panel) then scaffold+extension 75/75; full suite 2380 passed | 2 skipped; typecheck exit 0; esbuild builds dist/erPanel.js (ctx10).

Files: src/core/er/{fkGraph,layout,svgExport}.ts + 3 test files, src/ui/{erService,erPanel,erPanelHtml}.ts, webview/erPanelMain.ts, src/extension.ts, package.json, esbuild.js, src/__tests__/dbx04Scaffold.test.ts, src/extension.test.ts.
