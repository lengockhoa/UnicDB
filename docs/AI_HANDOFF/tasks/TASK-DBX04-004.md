# TASK-DBX04-004 — Scaffold hygiene + registration + regression

Status: pending · Wave: 3 · Plan: PLAN_DBX04.md §4
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
