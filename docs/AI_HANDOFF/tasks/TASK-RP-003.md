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

## Executor Report

- Status: DONE
- Worktree: /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-003
- Branch: handoff/task-rp-003
- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: -

### RED_OUTPUT (verbatim — vitest on the new test, before any package.json edit)

```
> UnicDB@1.51.6 test
> vitest run src/ui/__tests__/resultsPanelViewManifest.test.ts

▲ [WARNING] Unrecognized target environment "ES2024" [tsconfig.json]

    ../../tsconfig.json:3:14:
      3 │     "target": "ES2024",
        ╵               ~~~~~~~~

▲ [WARNING] Unrecognized target environment "ES2024" [tsconfig.json]

    tsconfig.json:3:14:
      3 │     "target": "ES2024",
        ╵               ~~~~~~~~

The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-003

 ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts  (4 tests | 4 failed) 5ms
   ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 1: panel views container + webview view are declared
     → expected false to be true // Object.is equality
   ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 2: resultsPlacement configuration property is gone
     → expected true to be false // Object.is equality
   ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 3: manifest is valid JSON with activation event and intact UnicDB config keys
     → expected [ 'onLanguage:sql', …(45) ] to include 'onView:UnicDB.results'
   ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 4: view id matches ResultsPanel.viewId from TASK-RP-001
     → expected undefined not to be undefined

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 1: panel views container + webview view are declared
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts:110:45
    108| 
    109|     // 1. panel container exists with the right shape
    110|     expect(Array.isArray(containers.panel)).toBe(true);
       |                                             ^
    111|     const panelContainer = (containers.panel as Array<Record<string, u…
    112|       (c) => c.id === "UnicDB-results",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 2: resultsPlacement configuration property is gone
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts:147:48
    145|     const { json, raw } = loadManifest();
    146|     const props = json.contributes.configuration?.properties ?? {};
    147|     expect("UnicDB.resultsPlacement" in props).toBe(false);
       |                                                ^
    148|     // Catches leftovers in descriptions / titles / anywhere in the fi…
    149|     expect(raw.includes("resultsPlacement")).toBe(false);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 3: manifest is valid JSON with activation event and intact UnicDB config keys
AssertionError: expected [ 'onLanguage:sql', …(45) ] to include 'onView:UnicDB.results'
 ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts:158:35
    156|     // test before the expect() block. Also sanity-check the activatio…
    157|     expect(Array.isArray(json.activationEvents)).toBe(true);
    158|     expect(json.activationEvents).toContain("onView:UnicDB.results");
       |                                   ^
    159| 
    160|     // Pre-existing config keys still present.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  src/ui/__tests__/resultsPanelViewManifest.test.ts > TASK-RP-003 — package.json manifest guards for Results panel home > case 4: view id matches ResultsPanel.viewId from TASK-RP-001
AssertionError: expected undefined not to be undefined
 ❯ src/ui/__tests__/resultsPanelViewManifest.test.ts:178:24
    176|     const views = json.contributes.views ?? {};
    177|     const panelViews = views["UnicDB-results"] as Array<Record<string,…
    178|     expect(panelViews).toBeDefined();
       |                        ^
    179|     expect(panelViews[0]!.id).toBe(viewIdFromCode);
    180| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯

 Test Files  1 failed (1)
      Tests  4 failed (4)
   Start at  11:40:34
   Duration  427ms (transform 125ms, setup 0ms, collect 257ms, tests 5ms, environment 0ms, prepare 48ms)
```

Cases 1 and 2 fail for the exact reasons called out in the task plan
(`Array.isArray(containers.panel)` is false because `panel` is absent;
`"UnicDB.resultsPlacement" in props` is true because the property is
present at the old line 689). Cases 3 and 4 also fail, as expected,
because the activation event and the `UnicDB-results` view key are not
yet declared — they are intrinsically coupled to the same edit set.

### Verification Output (after the four manifest edits)

`npm test src/ui/__tests__/resultsPanelViewManifest.test.ts`

```
> UnicDB@1.51.6 test
> vitest run src/ui/__tests__/resultsPanelViewManifest.test.ts

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-003

 ✓ src/ui/__tests__/resultsPanelViewManifest.test.ts  (4 tests) 3ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  11:41:17
   Duration  421ms
```

`npm test src/ui/__tests__/resultsPanelViewProvider.test.ts` (TASK-RP-001 regression)

```
> UnicDB@1.51.6 test
> vitest run src/ui/__tests__/resultsPanelViewProvider.test.ts

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-003

 ✓ src/ui/__tests__/resultsPanelViewProvider.test.ts  (6 tests) 83ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

`npm run typecheck`

```
> UnicDB@1.51.6 typecheck
> tsc --noEmit
(no output → exit 0)
```

`npm run compile`

```
> UnicDB@1.51.6 compile
> node esbuild.js

  dist/webview.js        2.3mb ⚠️
  dist/webview.css      38.7kb
  dist/webview.js.map    4.1mb
  dist/webview.css.map  74.2kb

  dist/extension.js       6.4mb ⚠️
  dist/extension.js.map  11.3mb

esbuild: build complete
```

`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('manifest JSON OK')"`

```
manifest JSON OK
```

Sanity grep on the manifest after the edit:

```
$ grep -n "onView:UnicDB.results\|UnicDB-results\|UnicDB.resultsPlacement\|resultsPlacement" package.json
82:    "onView:UnicDB.results"
623:      "UnicDB-results": [
641:          "id": "UnicDB-results",
```

Zero occurrences of `resultsPlacement` remain.

### Files Changed

- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-003/package.json` — added `onView:UnicDB.results` to `activationEvents`; added `contributes.views["UnicDB-results"]` (webview view entry); added `contributes.viewsContainers.panel`; deleted the `UnicDB.resultsPlacement` configuration property block. All other contributes keys untouched (activitybar container, commands, keybindings, menus including `webview/UnicDB.results/context`, viewsWelcome, grammars).
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-rp-003/src/ui/__tests__/resultsPanelViewManifest.test.ts` — new test file, 4 cases.

### Note

- No git add/commit/push performed (orchestrator handles it).
- `docs/AI_HANDOFF/INDEX.md` was not touched.
- Task file (`docs/AI_HANDOFF/tasks/TASK-RP-003.md`) had `## Executor Report` appended as required; orchestrator sets task status to `pending_review` separately.
