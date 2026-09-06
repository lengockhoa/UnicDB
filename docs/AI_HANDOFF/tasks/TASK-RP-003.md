# TASK-RP-003 — Manifest: panel views container + view + activation; DELETE resultsPlacement

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Architectural choice), §6 AC1, AC2

## Goal

Declare the bottom-panel home for the Results webview view in `package.json` and delete the
`UnicDB.resultsPlacement` configuration property entirely — no alias, no default, no fallback.
After this task the manifest matches what TASK-RP-001's code registers.

## Target Files

- `package.json` —
  1. `contributes.viewsContainers` (line ~623): ADD a `"panel"` key next to `"activitybar"`:
     `"panel": [{ "id": "UnicDB-results", "title": "UnicDB Results", "icon": "media/UnicDB.svg" }]`.
  2. `contributes.views` (line ~611): ADD a `"UnicDB-results"` key next to `"UnicDB"`:
     `"UnicDB-results": [{ "type": "webview", "id": "UnicDB.results", "name": "Results" }]`.
     (Keep the existing `"UnicDB"` activitybar views untouched.)
  3. `activationEvents`: ADD `"onView:UnicDB.results"`.
  4. `contributes.configuration.properties` (line ~689): DELETE the whole
     `"UnicDB.resultsPlacement"` property block.
- `src/ui/__tests__/resultsPanelViewManifest.test.ts` — (new) manifest tests below (plain `readFileSync` + `JSON.parse` of `package.json`, no vscode mock).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `panel views container + webview view are declared` | `contributes.viewsContainers.panel` is an array containing `{ id: "UnicDB-results", title: "UnicDB Results" }` with non-empty `icon`; `contributes.views["UnicDB-results"]` contains exactly `{ type: "webview", id: "UnicDB.results" }`; existing `views.UnicDB` (schemaTree, adminTree) untouched. RED before this task's edit (no `panel` key) | `JSON.parse(readFileSync("package.json"))` |
| 2 | edge (negative) | `resultsPlacement configuration property is gone` | `contributes.configuration.properties` does NOT have the key `UnicDB.resultsPlacement`; also a whole-JSON string scan `raw.includes("resultsPlacement") === false` (catches leftovers in descriptions too). RED before the edit (property at line 689) | same manifest object + raw string |
| 3 | edge (consistency / malformed guard) | `manifest is valid JSON with activation event and intact UnicDB config keys` | `JSON.parse` throws never; `activationEvents` includes `"onView:UnicDB.results"`; pre-existing configuration keys (`UnicDB.batchSize`, `UnicDB.showRunLens`) still present; `"webview/UnicDB.results/context"` menu key still present (Help Grid menu intact) | same manifest object |
| 4 | unit (cross-check with code) | `view id matches ResultsPanel.viewId from TASK-RP-001` | `import { ResultsPanel } from "../../ui/resultsPanel"` (with the suite's vscode mock) and assert `ResultsPanel.viewId === manifest.contributes.views["UnicDB-results"][0].id === "UnicDB.results"` and `ResultsPanel.viewId + focus container` — `viewsContainers.panel[0].id + ".focus" === "UnicDB-results.focus"` | vscode mocked minimally (Uri/window/commands/workspace/env) as in `resultsPanel.test.ts` |

## Test Files

- `src/ui/__tests__/resultsPanelViewManifest.test.ts` — (new) cases 1–4.

## Verification Commands

```bash
npm test src/ui/__tests__/resultsPanelViewManifest.test.ts
npm test src/ui/__tests__/resultsPanelViewProvider.test.ts
npm run typecheck
npm run compile
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('manifest JSON OK')"
```

(No lint script exists in this repo — `typecheck` + `compile` are the static gates.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (cases 1, 2 RED before the manifest edit).
- [ ] `package.json` contains zero occurrences of the string `resultsPlacement`.
- [ ] `node -e` JSON parse of package.json succeeds (no trailing-comma/brace mistakes).
- [ ] `contributes.views.UnicDB`, all `commands`, `keybindings`, `menus`, `grammars` unchanged (diff limited to the four edits listed in Target Files).
- [ ] `npm run typecheck` and `npm run compile` pass.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-RP-001 must complete first (its `ResultsPanel.viewId` static + rewritten
  `resultsPanel.test.ts` remove the old T3a test that asserts the setting IS declared —
  deleting the property before that rewrite would leave the full suite red).

## Interfaces

- Consumes: `ResultsPanel.viewId` static constant (`= "UnicDB.results"`) and the provider
  implementation from TASK-RP-001.
- Produces (TASK-RP-004 relies on):
  - `contributes.viewsContainers.panel[0].id === "UnicDB-results"` (focus command
    `UnicDB-results.focus` is what `show()` executes)
  - `contributes.views["UnicDB-results"][0] === { type: "webview", id: "UnicDB.results" }`
  - `activationEvents` contains `"onView:UnicDB.results"`
  - `UnicDB.resultsPlacement` absent from `contributes.configuration.properties`

---

## Discussion

### 2026-09-06 · planner · unic-smart
- Container id is `UnicDB-results` (hyphen) while the view id is `UnicDB.results` (dot): the
  container id becomes the `"<id>.focus"` command and hyphen keeps the two namespaces visually
  distinct; the dot view id preserves the `webview/UnicDB.results/context` Help-Grid menu
  contribution — do not "normalize" either.
- `media/UnicDB.svg` already exists (used by the activitybar container) — reuse it; panel
  container icons render best as a monochrome SVG.
- The `engines.vscode: ^1.75.0` floor fully supports panel-area webview views; do not raise it.
- Ordering note: this task follows TASK-RP-001 so the suite is green at every wave boundary
  (old T3a in `resultsPanel.test.ts` reads this file from disk and asserts the property EXISTS).

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
