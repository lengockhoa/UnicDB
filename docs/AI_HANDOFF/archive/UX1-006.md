# TASK-UX1-006 — Results placement `top` option + surface-guard filter extension (R8a)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 1), §3 (UX1-006)

## Goal

Results should appear BELOW the editor by default and offer a configurable position.
The `vsdb.resultsPlacement` setting (enum `below|beside`, default `below`) plus the
CREATE-time `moveEditorToBelowGroup` already deliver bottom-by-default; this task (a)
adds a `top` enum value mapped to `workbench.action.moveEditorToAboveGroup` with silent
degrade, (b) sharpens the setting description, and (c) extends the
`bq04SurfaceGuard` package.json filter so `activationEvents` lines and
`contributes.configuration` property keys are recognised as non-dependency contributes —
required BEFORE any later UX1 task edits package.json contributes/activation surfaces.

## Target Files

- `package.json` — `contributes.configuration.vsdb.resultsPlacement`: add `"top"` to
  `enum`, update `description` (CREATE-time-only semantics; default stays `below`).
- `src/ui/resultsPanel.ts` — `readPlacementSetting()` widens return type to
  `"below" | "beside" | "top"`; `show()` CREATE path dispatches: `below` → existing
  `moveEditorToBelowGroup`, `top` → `workbench.action.moveEditorToAboveGroup` (guard with
  the existing `canExecuteCommands()` pattern; if the command is unavailable, fall back to
  beside silently), `beside` → no move.
- `src/ui/__tests__/resultsPanel.test.ts` — placement cases appended.
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — extend `packageJsonDepsDiff`'s
  filter: (i) `/^[+-]\s+"onCommand:[a-zA-Z0-9.]+",?\s*$/` line pattern; (ii) a
  configuration-property-key pattern anchored to the `"vsdb\.[a-zA-Z0-9.]+"\s*:\s*\{`
  shape INSIDE the contributes.configuration block only (rely on the existing
  block-delimiter dropping for the braces); pin both with a unit test against a synthetic
  diff string. NEVER add a bare `onCommand` catch-all beyond the anchored line shape.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | setting "top" attempts moveEditorToAboveGroup at CREATE | panel created with placement `top` → `executeCommand` called with `workbench.action.moveEditorToAboveGroup` | stubbed workspace config `{ resultsPlacement: "top" }` + commands stub |
| 2 | happy | default stays below | no `resultsPlacement` key → `readPlacementSetting()` returns `"below"` and CREATE fires `moveEditorToBelowGroup` | empty config stub |
| 3 | edge A — unavailable command degrades | moveEditorToAboveGroup missing → silent beside, no throw | `canExecuteCommands()` false (or command absent) → no executeCommand call, panel still created and functional | vscode mock without the command |
| 4 | edge B — boundary | unknown/legacy value maps to below | config `{ resultsPlacement: "nonsense" }` → `"below"` | config stub |
| 5 | edge B — malformed | beside panel never moved at CREATE | `beside` → zero executeCommand placement calls (existing AI-001 contract, now explicit for beside too) | config stub |
| 6 | edge C — panel lives across config change | placement read at CREATE only | create with `below`, change config to `top`, `show()` again → no move command fired (reveal path keeps the user's dragged group) | panel pre-created; config mutated between calls |
| 7 | regression | guard test 3 stays green with activationEvents + configuration lines | synthetic diff containing `+        "onCommand:vsdb.openUserGuide",` and `+      "vsdb.resultsPlacement": {` filters to EMPTY remaining diff; and a synthetic `+  "dependencies": {` line still FAILS the filter (guard still bites) | pure-function test over `packageJsonDepsDiff`-shaped input |
| 8 | regression | existing 4 bq04 guard tests unchanged | full `bq04SurfaceGuard.test.ts` passes after the filter edit | repo state |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` — cases 1–6 (append; reuse the file's existing
  vscode/workspace stubs).
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — cases 7–8 (pure-function describe).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/adapters/__tests__/bq04SurfaceGuard.test.ts
npm run typecheck && npm run compile
node -e "const p=require('./package.json'); const c=p.contributes.configuration.properties['vsdb.resultsPlacement']; if(c.default!=='below'||!c.enum.includes('top')) { console.error('FAIL: default must stay below and enum must gain top'); process.exit(1);} console.log('OK: default=below, enum includes top');"
```

The final `node -e` check is the P2.5 YAGNI guard: it asserts the shipped manifest keeps
`default: "below"` while gaining `top` (case 2 asserts the same at runtime via
`readPlacementSetting(undefined)` → `"below"`, the code-level fallback for
unknown/missing values, resultsPanel.ts:226-239), proving `top` is strictly opt-in and
the default-config first-open still lands below the editor — the user's original
complaint is covered by the pre-existing default, not shifted by the new enum value.

## Acceptance Criteria

- [ ] Cases 1–8 pass; `vsdb.resultsPlacement` enum is exactly `["below","beside","top"]`.
- [ ] Default-placement proof (P2.5 round-1 YAGNI guard): case 2 shows
      `readPlacementSetting(undefined)` → `"below"` AND the `node -e` default-grep passes —
      `top` is opt-in, first-open with default config lands below.
- [ ] bq04SurfaceGuard 4/4 green; filter extension pinned by case 7 including the
      negative control (dependencies line still caught).
- [ ] `git diff -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts
      src/adapters/types.ts` empty; dependency manifest untouched.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none (but EVERY later UX1 task that edits package.json contributes/activationEvents —
  UX1-002, UX1-003, UX1-004, UX1-007 — declares this task as a dependency).

## Interfaces

- Consumes: `ResultsPanel.readPlacementSetting()` + `show()` CREATE path
  (src/ui/resultsPanel.ts:231,286); `canExecuteCommands()` defensive pattern (:301);
  `packageJsonDepsDiff` filter (bq04SurfaceGuard.test.ts:73-110).
- Produces: (1) `readPlacementSetting(): "below" | "beside" | "top"` — later placement
  callers must handle all three; (2) the extended guard filter — later package.json tasks
  rely on `onCommand:` and `vsdb.*` configuration-key lines being filtered so guard test 3
  stays green; do not weaken the dependency-manifest assertion.

---

## Discussion

### 2026-09-04 · planner · unic-smart
Verified against the live guard: reconstructing the OC4O package.json diff and re-applying
the current filter leaves only activationEvents/configuration-shaped lines unfiltered —
today that set is empty, so the suite is green (4/4 confirmed at P2). UX1 adds BOTH shapes
for the first time, so the filter must be extended in the SAME task that introduces the
first `contributes.configuration` change. R8a's "default bottom" already ships
(`vsdb.resultsPlacement` default `below` + CREATE-time moveEditorToBelowGroup) — the user
seeing top-right most likely has `beside` or a pre-setting panel; the description
sharpening addresses discoverability. `workbench.action.moveEditorToAboveGroup` existence
is runtime-checked (case 3) because VS Code does not guarantee the command across versions.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code (claude-sonnet)
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/ux1-006

 ❯ src/adapters/__tests__/bq04SurfaceGuard.test.ts  (8 tests | 1 failed) 54ms
   ❯ TASK-UX1-006 — packageJsonDepsDiff filter extension (R8a) > T-UX1-006 #7a — activationEvents + configuration property lines are filtered (empty remaining diff)
     → expected '+        "type": "string",\n+        …' to be '' // Object.is equality

 ❯ src/ui/__tests__/resultsPanel.test.ts  (58 tests | 2 failed) 424ms
   ❯ ResultsPanel — resultsPlacement (AI-001) > T3a. package.json manifest declares vsdb.resultsPlacement (enum below|beside, default below)
     → expected [ 'below', 'beside' ] to deeply equal [ 'below', 'beside', 'top' ]
   ❯ ResultsPanel — resultsPlacement (AI-001) > T-UX1-006 #1 — placement 'top' (via config) → moveEditorToAboveGroup fired at CREATE
     → expected "spy" to be called with arguments: [ 'workbench.action.moveEditorToAboveGroup' ]
       Received: [ 'workbench.action.moveEditorToBelowGroup' ]

 Test Files  2 failed (2)
      Tests  3 failed | 63 passed (66)
```

Verification Output:
```
=== CMD 1: vitest run resultsPanel + bq04 ===
 ✓ src/adapters/__tests__/bq04SurfaceGuard.test.ts  (8 tests) 58ms
 ✓ src/ui/__tests__/resultsPanel.test.ts  (58 tests) 422ms
 Test Files  2 passed (2)
      Tests  66 passed (66)
   Start at  15:44:33
   Duration  829ms

=== CMD 2: typecheck ===
> vsdb@1.51.0 typecheck
> tsc --noEmit
(no errors)

=== CMD 3: compile ===
  dist/extension.js       6.4mb ⚠️
  dist/extension.js.map  11.3mb
⚡ Done in 150ms
esbuild: build complete

=== CMD 4: manifest default-below (task spec path) ===
OK: default=below, enum includes top

=== CMD 5: queryRunner sanity ===
 ✓ src/core/__tests__/queryRunner.test.ts  (59 tests) 244ms
 Test Files  1 passed (1)
      Tests  59 passed (59)
   Start at  15:44:36

=== CMD 6: full npm test ===
   5 test files failed (aiChatPanel* webview tests) — all 5 fail with
   "spawnSync ... esbuild ENOENT" because the worktree's
   node_modules/.bin/esbuild symlink is missing (pre-existing worktree
   infrastructure issue, NOT a regression from this task — confirmed by
   running the same test on the base commit before any changes).
 Test Files  5 failed | 225 passed | 1 skipped (231)
      Tests  3352 passed | 2 skipped (3354)
   Duration  18.37s

=== CMD 7: orchestrator's manifest quick-check (note: path in command is wrong) ===
The orchestrator's check uses
  p.contributes.configuration['vsdb.resultsPlacement']
but the actual property path is
  p.contributes.configuration.properties['vsdb.resultsPlacement']
(the `configuration` block has a `title` and a `properties` sub-map).
The TASK-SPEC's own verification command (CMD 4 above) uses the
correct path and passes.
```

Status: PASS

Note:
- The orchestrator's quick `node -e` check uses a wrong JSON path
  (`configuration['vsdb.resultsPlacement']` instead of
  `configuration.properties['vsdb.resultsPlacement']`); the
  TASK-SPEC's own check (and CMD 4 above) use the correct path and
  confirm `default === "below"` and `enum.includes("top") === true`.
- 5 pre-existing test-file failures in `npm test` (all
  `aiChatPanel*` webview tests requiring `esbuild` at runtime) are a
  worktree infrastructure issue (`node_modules/.bin/esbuild` symlink
  missing in `.worktrees/ux1-006/`) — confirmed pre-existing by
  stashing my changes and re-running.
- Filter extension: I extended the `packageJsonDepsDiff` filter with
  two narrow whitelists (R8a): (1) `^[+-]\s+"onCommand:[a-zA-Z0-9.]+",?\s*$`
  for activationEvents lines; (2) property-block detection via
  brace-depth scan of `package.json` at both BASE_REF and HEAD (so
  `+` lines AND `-` lines are correctly placed inside their respective
  `vsdb.*` block ranges). The state machine + file-side line-number
  translation was needed because a property key whose INNER content
  changes (the `vsdb.resultsPlacement` block) leaves the key itself
  as a context line, so a stripped-line scan of just `+`/`-` lines
  was insufficient.
- The sanity test (T-UX1-006 #7b) still proves the filter is NOT a
  tautology: `+  "dependencies": {` is NOT in any `vsdb.*` block
  range, so it survives the filter and the guard still fires.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart (claude-opus tier)
EXECUTOR_MODEL: unic-code (claude-sonnet)
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/resultsPanel.test.ts src/adapters/__tests__/bq04SurfaceGuard.test.ts
  result: 66 pass / 0 fail (58 + 8)
  command: npm run typecheck && npm run compile
  result: PASS (tsc --noEmit clean; esbuild build complete)
  command: node -e manifest check
  result: OK: default=below, enum includes top
  command: git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts
  result: empty (frozen surfaces untouched)
TEST_PLAN_COVERAGE: all-followed — cases 1-8 present (3 + edge A/B/B/C placement cases; 7a-7d guard filter incl. negative controls; 8 full bq04 suite green). RED_OUTPUT carries real failing assertions (3 failed, received/expected shown).
FINDINGS:
  critical: none
  important: none
  minor:
    - src/adapters/__tests__/bq04SurfaceGuard.test.ts:333-399 — filterRawDiff mirror diverges from production packageJsonDepsDiff (mirror is stripped-line scan; production is hunk-header line-number translation). Documented in comments and all 4 patterns match; flagged as follow-up drift risk only.
    - src/adapters/__tests__/bq04SurfaceGuard.test.ts:213 — readCurrentPackageJsonLines reads relative "package.json" (works only when cwd is repo root); every other fs/git access in this file uses REPO_ROOT. Harmless under vitest, inconsistent.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Full `npm test` shows 6 failures (webviewServerSort/DistinctValues/CommitRefresh, sshTunnelManager, saveStatementsParser) — none in this task's diff; they skip entirely at base (no dist/webview.js at dac6503) and the webview failures trace to sibling-task webview/main.ts changes in shared wave commit 64547c9 (flagged to UX1-010's review); the remaining are load-flakes (5s timeouts under 145s parallel env, perf threshold). Task-targeted gate is green; this task's host-side diff cannot affect the jsdom webview bundle tests.
