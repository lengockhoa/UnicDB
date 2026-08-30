# TASK-DBX04-004 — Scaffold hygiene + registration + regression

Status: done · Wave: 3 · Plan: PLAN_DBX04.md §4
Reviewer verdict: (none yet)

## Scope

`src/__tests__/dbx04Scaffold.test.ts`, `src/extension.test.ts`.

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: dbx04Scaffold.test.ts (purity: no vscode in core/er + service +
   html; webview: no innerHTML/insertAdjacentHTML/eval/new Function;
   word-boundary regexes) + extend extension.test.ts later-cycles list
   with vsdb.relationshipExplorer; capture failing output.
2. GREEN: fix any violation the guards surface.
3. Full regression: `npx vitest run` — expect prior total + ~49 new
   tests, 0 failed; `npm run typecheck`.

## Acceptance

- scaffold ~5 tests green; extension registration asserts new command;
  full suite green
- `npm run typecheck` exit 0

## Executor Report

### 2026-08-30 · executor · omp-direct/unic-code

TDD RED→GREEN evidence:
- TASK-DBX04-001 RED: `Error: Failed to load url ../fkGraph ... Does the file exist?` → GREEN 8/8.
- TASK-DBX04-002 RED: `Failed to load url ../layout` / `../svgExport` → GREEN after implementation. One test failure during GREEN (parents-above-children) exposed an in-edge direction bug (inEdges keyed by target instead of source); fixed by mapping child→parents.
- TASK-DBX04-003 RED: `Failed to load url ../erPanel` → GREEN 14/14 (service 8 + panel 4 + html 2 within file). One fixture call bug (options passed in schema slot) corrected.
- TASK-DBX04-004: scaffold guards GREEN immediately (word-boundary regexes, DBX-03 lesson applied); T18 laterCycles list extended with vsdb.relationshipExplorer — extension.test.ts 75/75.

Verification: targeted 32/32 (er core+service+panel) then scaffold+extension 75/75; full suite 2380 passed | 2 skipped; typecheck exit 0; esbuild builds dist/erPanel.js (ctx10).

Files: src/core/er/{fkGraph,layout,svgExport}.ts + 3 test files, src/ui/{erService,erPanel,erPanelHtml}.ts, webview/erPanelMain.ts, src/extension.ts, package.json, esbuild.js, src/__tests__/dbx04Scaffold.test.ts, src/extension.test.ts.
