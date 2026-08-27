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
