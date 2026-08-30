# TASK-DBX04-003 — ER panel host + webview + wiring

Status: pending · Wave: 2 · Plan: PLAN_DBX04.md §4
Reviewer verdict: (none yet)

## Scope

`src/ui/erService.ts`, `src/ui/erPanel.ts`, `src/ui/erPanelHtml.ts`,
`webview/erPanelMain.ts`, `src/extension.ts`
(vsdb.relationshipExplorer), `package.json` command, `esbuild.js`
erPanelConfig (ctx10).

## Steps (TDD: RED first — capture failing output, then GREEN)

1. RED: erService.test.ts + erPanel.test.ts per PLAN §3 rows 4-5;
   capture failing output.
2. GREEN: implement service (driver gate BEFORE adapter calls;
   per-table catch; 200-node cap + truncated), panel host (singleton,
   zoom clamp 0.25..4, isErPanelMessage guard, export save dialog),
   CSP shell, textContent-only webview (pan/zoom via viewBox,
   XMLSerializer export), extension command with schema QuickPick,
   package.json + esbuild entry.
3. Compile: `npm run compile` must include dist/erPanel.js.

## Acceptance

- erService ~8 + erPanel ~6 tests green; compile clean with new entry
- `npm run typecheck` exit 0
- Targeted vitest file(s) pass; no unrelated file touched
