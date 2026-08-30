# TASK-DBX04-003 — ER panel host + webview + wiring

Status: done · Wave: 2 · Plan: PLAN_DBX04.md §4
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

## Executor Report

### 2026-08-30 · executor · omp-direct/unic-code

TDD RED→GREEN evidence:
- TASK-DBX04-001 RED: `Error: Failed to load url ../fkGraph ... Does the file exist?` → GREEN 8/8.
- TASK-DBX04-002 RED: `Failed to load url ../layout` / `../svgExport` → GREEN after implementation. One test failure during GREEN (parents-above-children) exposed an in-edge direction bug (inEdges keyed by target instead of source); fixed by mapping child→parents.
- TASK-DBX04-003 RED: `Failed to load url ../erPanel` → GREEN 14/14 (service 8 + panel 4 + html 2 within file). One fixture call bug (options passed in schema slot) corrected.
- TASK-DBX04-004: scaffold guards GREEN immediately (word-boundary regexes, DBX-03 lesson applied); T18 laterCycles list extended with vsdb.relationshipExplorer — extension.test.ts 75/75.

Verification: targeted 32/32 (er core+service+panel) then scaffold+extension 75/75; full suite 2380 passed | 2 skipped; typecheck exit 0; esbuild builds dist/erPanel.js (ctx10).

Files: src/core/er/{fkGraph,layout,svgExport}.ts + 3 test files, src/ui/{erService,erPanel,erPanelHtml}.ts, webview/erPanelMain.ts, src/extension.ts, package.json, esbuild.js, src/__tests__/dbx04Scaffold.test.ts, src/extension.test.ts.

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart

Commands run:
- `npm run typecheck` — passed.
- `npx vitest run src/core/er src/ui/__tests__/erService.test.ts src/ui/__tests__/erPanel.test.ts src/__tests__/dbx04Scaffold.test.ts src/extension.test.ts` — failed: `erPanel.test.ts` cannot resolve the `vscode` module (0 tests collected).
- `npx vitest run src/core/er src/ui/__tests__/erService.test.ts src/__tests__/dbx04Scaffold.test.ts` — passed (36 tests).
- `npx vitest run src/ui/__tests__/erPanel.test.ts` — failed (same unresolved `vscode` import).
- `node -e 'console.log(JSON.stringify({nodes:new Map([["public.users",{x:24}]])}))'` — produced `{"nodes":{}}`.

Findings:
- **important — src/ui/erPanel.ts:115-121:** `LayoutResult.nodes` is a `Map`, but this host posts it directly through the webview JSON message channel. `Map` serializes as `{}`; `layoutNodes` consequently receives no positions and the renderer skips every box and edge. Convert it to `Array.from(layout.nodes.entries())` (or a record) before posting.
- **important — src/core/er/fkGraph.ts:83-85:** `confrelidname` is compared unchanged with schema-qualified graph IDs. The PostgreSQL query supplies `confrelid::regclass::text`, which emits an unqualified name for relations visible in `search_path` (the normal `public` case); for example `users` cannot match `public.users`, so valid FK edges are counted as dropped and omitted.
- **important — src/ui/erService.ts:67-76:** The service slices alphabetically before fetching details, so its degree-ranking branch is unreachable for ordinary capped schemas. A table after the first 200 with the highest FK degree is never inspected and cannot be selected, contrary to the specified top-200-by-degree cap.
- **important — webview/erPanelMain.ts:141-154:** The webview applies each wheel zoom locally without a bound, then ignores the host's `er_zoom_set` reply. The host clamp at `src/ui/erPanel.ts:95-97` therefore has no effect; repeated scrolling can exceed the required 0.25..4 range.
- **minor — src/ui/erPanel.ts:101-108:** A rejected `workspace.fs.writeFile` escapes the async message handler, producing no user-visible export failure. Existing export paths catch this rejection and show an error; apply the same handling here.

## Executor Fix Round 1 (post-review)

### 2026-08-30 · executor · omp-direct/unic-code

Addresses all CHANGES-REQUESTED findings (unic-smart):

1. **Map serialization (P1)** — host now posts `layout.nodes` as `Object.fromEntries(map)`; webview `layoutNodes` already accepts a record. Regression test drives `post()` against a fake panel and JSON-round-trips the message asserting nodes is a non-array object.
2. **FK target normalization (P1)** — buildErGraph resolves search_path-bare `confrelidname` ("users") to the unique captured table with that bare name; ambiguity (bare name matching 2+ schemas) is NOT guessed and counts as dropped. Tests: bare-name resolution + ambiguity refusal.
3. **Cap selection (P1)** — service now fetches details for ALL listed tables (per-table catch), builds the full graph, then ranks top-`maxNodes` by FK degree (tie-break by id). Alphabetical pre-slice removed; the degree contract is live code. Existing cap tests updated to the corrected call shape.
4. **Zoom clamp (P1)** — webview applies the 0.25..4 clamp locally against the model's natural viewBox before each wheel step, and honors the host `er_zoom_set` acknowledgment by reconciling its viewBox accumulator.
5. **Export failure reporting (P2)** — writeFile rejection is caught and surfaced via showErrorMessage; success path unchanged.
6. **Test isolation (P1)** — erPanel.test.ts mocks the vscode module before importing erPanel.ts; the mandated targeted command now runs standalone.

Fresh verification: targeted (er + service + panel + scaffold + extension) 114/114; full suite 2387 passed | 2 skipped; typecheck exit 0; esbuild builds dist/erPanel.js.
