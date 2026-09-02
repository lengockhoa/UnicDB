# TASK-ARP08-004 — Extension wiring: workspaceState as draftMemento + retained singleton/history guarantees

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §3, §4, §5, §7

## Goal

Wire `ConsolePanelOptions.draftMemento` to `context.workspaceState` in `commandOpenConsole` so drafts are workspace-scoped, while proving (by test) that the singleton behavior and the `globalState`-backed history guarantees are retained unchanged. This is the roadmap-sanctioned `extension.ts` change ("only if scope/options change").

## Target Files

- `src/extension.ts` — `commandOpenConsole` (currently `extension.ts:1584-1633`) gains a `draftMemento: vscode.Memento` parameter and passes `draftMemento` into `new ConsolePanel({...})` (`1591-1630`); the `vsdb.openConsole` registration (`753-754`) passes `context.workspaceState`. `context.globalState` stays the history memento (`memento` option) — unchanged. Singleton `if (!consolePanel)` guard and `onDispose → consolePanel = null` untouched.
- `src/extension.test.ts` (existing file) — new describe block `ARP-08 — console draft memento wiring` using the existing `activateWithConsole` pattern (`extension.test.ts:2081-2120`) and `makeCtx()` (already provides `workspaceState` with `get`/`update` spies at `extension.test.ts:272-300`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 1 | happy | activate with a seeded draft in `ctx.workspaceState.get` (return `encodeConsoleDraftSnapshot(...)` for `CONSOLE_DRAFTS_KEY`), invoke `vsdb.openConsole` | `ConsolePanel` is constructed with `draftMemento` pointing at `ctx.workspaceState` — assert via the constructor options captured through the `createWebviewPanel`/panel harness, or via a follow-up `updateBuffer`→flush observing `ctx.workspaceState.update` receiving `CONSOLE_DRAFTS_KEY` |
| 2 | happy | invoke `vsdb.openConsole` twice | exactly ONE `createWebviewPanel` call with viewType `vsdb.console` — singleton retained |
| 3 | edge (history scope) | activate with a mock `QueryRunner.run` returning a result; run `SELECT 1` through the console handler | `ctx.globalState.update` is called with `CONSOLE_HISTORY_KEY` (history scope unchanged); `ctx.workspaceState.get` is called with `CONSOLE_DRAFTS_KEY`; the two keys never cross (assert no `globalState` call with `CONSOLE_DRAFTS_KEY`) |
| 4 | edge (teardown) | open the console, then `deactivate()` | the console panel is disposed (module singleton nulled) — deactivate still tears down; reopen creates a fresh panel |
| 5 | edge (not-expected-close) | if the executor finds 001/002 already wired such that extension.ts needs NO edit, close as not-needed with recorded evidence (diff + test proof) | otherwise, normal wiring + tests above |

## Test Files

- `src/extension.test.ts` — new `describe("ARP-08 — console draft memento wiring")`. Reuse `makeCtx()` (line 272), the `activateWithConsole`-style helper (line 2081), `state.registeredCommands`, `vscodeMock.window.createWebviewPanel` (tagging `vsdb.console`), and the `TASK-003` describe's `findConsolePanelCall`/panel-harness pattern (lines 2151-2188). Drive `deactivate()` in `afterEach` like the `TASK-003` block (line 2074-2078).

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED→GREEN).
- [ ] `draftMemento` is wired to `context.workspaceState` in `commandOpenConsole`; history remains `globalState` under `CONSOLE_HISTORY_KEY`.
- [ ] Singleton behavior retained: one panel per open; `onDispose` nulls the singleton; deactivate disposes + nulls.
- [ ] If the wiring turns out to be already correct (evidence: 001/002 options landed such that extension.ts needs no edit), the task may close as not-needed per the ARP-04-004/ARP-05-004 precedent — but that close REQUIRES recorded evidence (diff review + the §Test Cases pins passing) in the Executor Report. Expected outcome this cycle: a real edit, because `commandOpenConsole` currently passes only `globalState` and nothing supplies `draftMemento`.
- [ ] No changes to `consolePanel.ts` / `consolePanelMessages.ts` / webview files (owned by 001-003); no `package.json` change.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP08-001 (the `CONSOLE_DRAFTS_KEY` constant and `encodeConsoleDraftSnapshot`/`parseConsoleDraftSnapshot` used in the wiring tests).
- TASK-ARP08-002 (the `ConsolePanelOptions.draftMemento` option this task consumes — wave 3 runs only after wave 2).

## Interfaces

- Consumes:
  - `ConsolePanelOptions.draftMemento?: vscode.Memento` (produced by TASK-ARP08-002).
  - `CONSOLE_DRAFTS_KEY = "vsdb.consoleDrafts"` (produced by TASK-ARP08-001) — used to seed the `workspaceState` spy and assert key separation.
  - Existing `commandOpenConsole(mgr, runner, panel, memento)` signature at `extension.ts:1584-1589`.
- Produces: extension wiring only — `commandOpenConsole` signature becomes `commandOpenConsole(mgr, runner, panel, memento, draftMemento: vscode.Memento)`; registration passes `context.workspaceState`. No public API change.

---

## Discussion

- Registration is at `extension.ts:753-754`: `vscode.commands.registerCommand("vsdb.openConsole", () => commandOpenConsole(mgr, runner, panel, context.globalState))` — this is the only call site of `commandOpenConsole`; update it to pass `context.workspaceState` as the fifth argument. `commandOpenConsoleCreateTab` (`1640-1643`) does NOT construct the panel and needs no change.
- The existing `TASK-003 — vsdb.openConsole wiring` describe (lines 2055-2230) must stay green: it asserts one panel, `consolePanel.js`/`webview.css` HTML, full-buffer run routing, and save-cancellation. Do not weaken those pins; the ARP-08 wiring must compose with them.
- Test #3 key-separation pin is the privacy-scope guard on the extension side: `globalState` gets `CONSOLE_HISTORY_KEY`, `workspaceState` gets `CONSOLE_DRAFTS_KEY`, and neither appears in the other's call log.
- If the executor closes as not-needed, record in the Executor Report: the `git diff --stat` for `src/extension.ts`/`src/extension.test.ts` (expected empty-ish), the §Test Cases results, and a one-line rationale. Do NOT close without that evidence — a bare "verify only" with no pins is not a close.
