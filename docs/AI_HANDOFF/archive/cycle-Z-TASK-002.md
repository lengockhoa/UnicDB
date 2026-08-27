# TASK-002 — Build Console webview bundle and interactions

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.2

## Goal

Implement the Console panel's browser UI: empty SQL textarea, Run and Save toolbar controls, Cmd/Ctrl+Enter execution, and an in-webview right-click menu. Register its browser entry with the existing esbuild configuration so compilation emits `dist/consolePanel.js`.

## Target Files

- `webview/consolePanelMain.ts` (new) — render and wire the Console textarea, toolbar, shortcut, and custom context menu using `ConsoleToHostMessage` payloads.
- `webview/styles.css` — add Console-specific toolbar, editor, and context-menu styling consistent with the existing webview stylesheet. It remains emitted as `dist/webview.css` by the existing `webview/main.ts` import; TASK-003 owns linking that asset into Console HTML.
- `esbuild.js` — add the `webview/consolePanelMain.ts` → `dist/consolePanel.js` browser build config to both watch and normal build arrays.
- `src/ui/__tests__/consolePanelBundle.test.ts` (new) — jsdom bundle test that loads `dist/consolePanel.js` after compile.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | Run button posts editor SQL | Clicking Run with textarea value `SELECT 1` posts exactly `{ type: "runConsole", sql: "SELECT 1" }`. | Bundle loaded in jsdom with mocked `acquireVsCodeApi`. |
| 2 | happy | Save button posts editor SQL | Clicking Save with textarea value `SELECT 2` posts exactly `{ type: "saveConsoleAsSql", sql: "SELECT 2" }`. | Loaded bundle and mocked API. |
| 3 | edge-empty | empty execution is ignored | Clicking Run with an empty textarea posts no run message. | Empty textarea. |
| 4 | edge-shortcut | only Cmd/Ctrl+Enter executes | Cmd+Enter or Ctrl+Enter posts the run message and calls `preventDefault`; plain Enter posts nothing. | Textarea value `SELECT 3`. |
| 5 | edge-interaction | custom context menu saves SQL | `contextmenu` prevents the browser menu, exposes a `Save as SQL file` item, and choosing it posts `{ type: "saveConsoleAsSql", sql: "SELECT 4" }`. | Right-click textarea with SQL text. |

## Test Files

- `src/ui/__tests__/consolePanelBundle.test.ts` (new) — jsdom tests for the emitted browser bundle and all listed user interactions.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/consolePanelBundle.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate. `npm run compile` must precede the bundle test because it reads `dist/consolePanel.js`.

## Acceptance Criteria

- [ ] Compile emits `dist/consolePanel.js` from the new Console entry in normal and watch modes.
- [ ] The UI exposes an initially empty textarea plus visible Run and Save controls.
- [ ] Run emits the validated run message via its button or Cmd/Ctrl+Enter, while plain Enter does not execute.
- [ ] Right-click displays `Save as SQL file` and sends the validated save message; the visible Save control sends the same message.
- [ ] The targeted bundle test and `npm run typecheck` pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001

## Interfaces

- Consumes: `ConsoleToHostMessage`, including `{ type: "runConsole"; sql: string }` and `{ type: "saveConsoleAsSql"; sql: string }`, from `src/ui/consolePanelMessages.ts` (TASK-001).
- Produces: browser bundle `dist/consolePanel.js` from `webview/consolePanelMain.ts`; it posts only `ConsoleToHostMessage` values through VS Code's `postMessage` API. Its Console CSS rules are emitted in the existing `dist/webview.css` output because `webview/main.ts` imports `webview/styles.css`; TASK-003 must link that existing asset rather than add a second CSS pipeline.

---

## Discussion

### 2026-08-27 · planner · bao-opus
`esbuild.js` is the verified bundler path: it separately declares each browser entry and lists every config in both its watch and normal-build Promise arrays. The UI intentionally uses the existing shared `webview/styles.css`, not a new stylesheet or optional SQL highlighting. `webview/main.ts` imports that stylesheet, producing `dist/webview.css`; TASK-003's HTML contract links it with `asWebviewUri`, avoiding an additional CSS bundle.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:

```
npx vitest run src/ui/__tests__/consolePanelBundle.test.ts   (before any implementation)

Error: dist/consolePanel.js missing — run `npm run compile` before this test
 ❯ loadBundle src/ui/__tests__/consolePanelBundle.test.ts:24:11
 ❯ src/ui/__tests__/consolePanelBundle.test.ts:119:22
 ...
 FAIL  ... > #7 edge-interaction: contextmenu prevented, exposes 'Save as SQL file', choosing it posts the save message
Error: dist/consolePanel.js missing — run `npm run compile` before this test

 Test Files  1 failed (1)
      Tests  7 failed (7)
```

(Re-confirmed after adding menu-visibility assertions — still 7 failed / 7.)

Verification Output:

Command 1 — `npm run compile` (worktree root):
```
  dist/consolePanel.js      3.0kb
  dist/consolePanel.js.map  7.8kb
⚡ Done in 8ms
  dist/webview.js        2.2mb ⚠️
  dist/webview.css      23.9kb
  ...
esbuild: build complete
```
`dist/consolePanel.js` emitted; Console CSS rules (8 `vsdb-console*` matches) confirmed inside `dist/webview.css`. Bundler path edited: `esbuild.js` (repo root) — added `consolePanelConfig` to both the watch context/Promise array and the normal-build Promise array.

Command 2 — `npx vitest run src/ui/__tests__/consolePanelBundle.test.ts`:
```
 ✓ src/ui/__tests__/consolePanelBundle.test.ts  (7 tests) 22ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

Command 3 — `npm run typecheck`:
```
> vsdb@1.6.8 typecheck
> tsc --noEmit
typecheck exit: 0
```

Extra gate check — per-file webview tsc (`tsc --noEmit -p tsconfig.webview.json`): pre-existing baseline has 25 TS2451/TS2393 errors from script-style entries (aiSettingsFormMain x10, connectionFormMain x10, schemaFormMain x5, newTableFormMain x1). My first draft (script-style) added +4; final version is module-style via trailing `export {}` and contributes ZERO new errors (grouped counts match the true measured baseline exactly). Isolated per-file check of consolePanelMain.ts passes clean.

Aggregate — `npm test` (not required by task, run for confidence):
```
 Test Files  114 passed | 1 skipped (115)
      Tests  1679 passed | 2 skipped (1681)
```

Status: PASS
Note:
- Consumes TASK-001's contract behaviorally: webview entries cannot import across the tsconfig.webview rootDir (TS6059 house rule documented in main.ts), so consolePanelMain.ts mirrors the two `ConsoleToHostMessage` shapes structurally exactly like every other entry; the wire payloads are pinned by tests #3/#4/#7 to be exactly `{ type: "runConsole", sql }` / `{ type: "saveConsoleAsSql", sql }`.
- Whitespace-only editor content is treated as empty (no post) in Run/Save/context-menu paths.
- `git stash list` shows a pre-existing unrelated stash (`task-007-fix-wip`) that was already there before this task; untouched.

---

## Executor Report (fix round 1)

Blocking finding addressed: right-click context menu ignored Escape and stayed open after Cmd/Ctrl+Enter execution (webview/consolePanelMain.ts ~:147).

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

Scope kept tight — one implementation file + one test file:
- `webview/consolePanelMain.ts`: added a document-level capture-phase `keydown` closer (`Escape` → hide, mirroring main.ts's overlay pattern; stopPropagation so the webview host doesn't also process it). Wired `hideContextMenu()` into the Cmd/Ctrl+Enter handler **before** `postRun()`. Click-away close already existed (kept as-is); menu is a singleton via `ensureContextMenu`, now explicitly commented/verified as never stacking.
- `src/ui/__tests__/consolePanelBundle.test.ts`: added tests #8 (Escape closes open menu; reopen works with exactly one `.vsdb-console-contextmenu` node) and #9 (Ctrl/Cmd+Enter closes menu at execution while still posting runConsole exactly once per keystroke; document-body click closes an open menu without posting; triple right-click yields exactly 1 menu node + 1 context item).

RED_OUTPUT:

```
npx vitest run src/ui/__tests__/consolePanelBundle.test.ts   (before the fix)

 FAIL ... > #8 edge-dismissal: Escape closes the open context menu
AssertionError: expected false to be true // Object.is equality
 ❯ src/ui/__tests__/consolePanelBundle.test.ts:201
 FAIL ... > #9 edge-dismissal: Cmd/Ctrl+Enter closes the menu at execution; click-away closes it; reopen never stacks duplicates
AssertionError: expected false to be true // Object.is equality
 ❯ src/ui/__tests__/consolePanelBundle.test.ts:225:25
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```

Both failures are the exact finding (#8 Escape left menu open; #9 shortcut-run left menu open); all 7 pre-existing tests still passed in RED state.

Verification Output (worktree /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002-fix):

Command 1 — `npm run compile`:
```
  dist/consolePanel.js      3.3kb
  dist/consolePanel.js.map  8.6kb
esbuild: build complete
```

Command 2 — `npx vitest run src/ui/__tests__/consolePanelBundle.test.ts`:
```
 ✓ src/ui/__tests__/consolePanelBundle.test.ts  (9 tests)
 Test Files  1 passed (1)
      Tests  9 passed (9)
```
All three console suites together (`consolePanelBundle` + `consolePanel` + `consolePanelMessages`): 3 files, 22 tests, all pass.

Command 3 — `npm run typecheck`:
```
> vsdb@1.6.8 typecheck
> tsc --noEmit
(exit 0, no output = clean)
```

Command 4 — aggregate `npm test`:
```
 Test Files  115 passed | 1 skipped (116)
      Tests  1693 passed | 2 skipped (1695)
```

Extra gate — per-file webview tsc (`tsc --noEmit -p tsconfig.webview.json`): `consolePanelMain.ts` contributes ZERO errors after the edit (grep across all 38 reported errors matches 0 of that file; remaining errors are the documented pre-existing script-style baselines in untouched entries).

Status: PASS

Note:
- Env: fresh worktree had no node_modules (same trap TASK-003's executor hit); symlinked parent repo's node_modules in — code untouched by this.
- Click-away needed no code (already present); it is now pinned by test #9 against regressions.
- No git add/commit/push performed, per instructions.


## Reviewer Verdict (round 2)
VERDICT: approved
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: done
