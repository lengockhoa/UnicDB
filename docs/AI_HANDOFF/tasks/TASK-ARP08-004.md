# TASK-ARP08-004 — Extension wiring: workspaceState as draftMemento + retained singleton/history guarantees

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §3, §4, §5, §7

## Goal

Wire `ConsolePanelOptions.draftMemento` to `context.workspaceState` in `commandOpenConsole` so drafts are workspace-scoped, while proving (by test) that the singleton behavior and the `globalState`-backed history guarantees are retained unchanged. This is the roadmap-sanctioned `extension.ts` change ("only if scope/options change").

## Target Files

- `src/extension.ts` — `commandOpenConsole` (currently `extension.ts:1584-1633`) gains a `draftMemento: vscode.Memento` parameter and passes `draftMemento` into `new ConsolePanel({...})` (`1591-1630`); the `UnicDB.openConsole` registration (`753-754`) passes `context.workspaceState`. `context.globalState` stays the history memento (`memento` option) — unchanged. Singleton `if (!consolePanel)` guard and `onDispose → consolePanel = null` untouched.
- `src/extension.test.ts` (existing file) — new describe block `ARP-08 — console draft memento wiring` using the existing `activateWithConsole` pattern (`extension.test.ts:2081-2120`) and `makeCtx()` (already provides `workspaceState` with `get`/`update` spies at `extension.test.ts:272-300`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 1 | happy | activate with a seeded draft in `ctx.workspaceState.get` (return `encodeConsoleDraftSnapshot(...)` for `CONSOLE_DRAFTS_KEY`), invoke `UnicDB.openConsole` | `ConsolePanel` is constructed with `draftMemento` pointing at `ctx.workspaceState` — assert via the constructor options captured through the `createWebviewPanel`/panel harness, or via a follow-up `updateBuffer`→flush observing `ctx.workspaceState.update` receiving `CONSOLE_DRAFTS_KEY` |
| 2 | happy | invoke `UnicDB.openConsole` twice | exactly ONE `createWebviewPanel` call with viewType `UnicDB.console` — singleton retained |
| 3 | edge (history scope) | activate with a mock `QueryRunner.run` returning a result; run `SELECT 1` through the console handler | `ctx.globalState.update` is called with `CONSOLE_HISTORY_KEY` (history scope unchanged); `ctx.workspaceState.get` is called with `CONSOLE_DRAFTS_KEY`; the two keys never cross (assert no `globalState` call with `CONSOLE_DRAFTS_KEY`) |
| 4 | edge (teardown) | open the console, then `deactivate()` | the console panel is disposed (module singleton nulled) — deactivate still tears down; reopen creates a fresh panel |
| 5 | edge (not-expected-close) | if the executor finds 001/002 already wired such that extension.ts needs NO edit, close as not-needed with recorded evidence (diff + test proof) | otherwise, normal wiring + tests above |

## Test Files

- `src/extension.test.ts` — new `describe("ARP-08 — console draft memento wiring")`. Reuse `makeCtx()` (line 272), the `activateWithConsole`-style helper (line 2081), `state.registeredCommands`, `vscodeMock.window.createWebviewPanel` (tagging `UnicDB.console`), and the `TASK-003` describe's `findConsolePanelCall`/panel-harness pattern (lines 2151-2188). Drive `deactivate()` in `afterEach` like the `TASK-003` block (line 2074-2078).

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
  - `CONSOLE_DRAFTS_KEY = "UnicDB.consoleDrafts"` (produced by TASK-ARP08-001) — used to seed the `workspaceState` spy and assert key separation.
  - Existing `commandOpenConsole(mgr, runner, panel, memento)` signature at `extension.ts:1584-1589`.
- Produces: extension wiring only — `commandOpenConsole` signature becomes `commandOpenConsole(mgr, runner, panel, memento, draftMemento: vscode.Memento)`; registration passes `context.workspaceState`. No public API change.

---

## Discussion

- Registration is at `extension.ts:753-754`: `vscode.commands.registerCommand("UnicDB.openConsole", () => commandOpenConsole(mgr, runner, panel, context.globalState))` — this is the only call site of `commandOpenConsole`; update it to pass `context.workspaceState` as the fifth argument. `commandOpenConsoleCreateTab` (`1640-1643`) does NOT construct the panel and needs no change.
- The existing `TASK-003 — UnicDB.openConsole wiring` describe (lines 2055-2230) must stay green: it asserts one panel, `consolePanel.js`/`webview.css` HTML, full-buffer run routing, and save-cancellation. Do not weaken those pins; the ARP-08 wiring must compose with them.
- Test #3 key-separation pin is the privacy-scope guard on the extension side: `globalState` gets `CONSOLE_HISTORY_KEY`, `workspaceState` gets `CONSOLE_DRAFTS_KEY`, and neither appears in the other's call log.
- If the executor closes as not-needed, record in the Executor Report: the `git diff --stat` for `src/extension.ts`/`src/extension.test.ts` (expected empty-ish), the §Test Cases results, and a one-line rationale. Do NOT close without that evidence — a bare "verify only" with no pins is not a close.

---

## Executor Report

- Executor tool/model: claude-code / unic-code
- Date: 2026-09-02
- Mode: Handoff (verify-first → wiring landed, real edit per §Acceptance prediction)
- Step-1 verification (before any edit): `commandOpenConsole` (`src/extension.ts:1584-1589`) constructed ConsolePanel with only `{ extensionUri, memento, onAutocomplete, onRun, onDispose }` — no `draftMemento`. `grep -n workspaceState src/extension.ts` → 0 hits pre-edit. Wave-2 option exists (`src/ui/consolePanel.ts:90,143,162`) and is consumed by `hydrateDrafts`/`persistDrafts`/`handleClearDrafts`. ⇒ NOT-NEEDED close does NOT apply; real wiring required.

### RED (actual output, pre-implementation)

```
 FAIL  src/extension.test.ts > ARP-08 — console draft memento wiring > #1 happy: seeded workspaceState draft hydrates the Console — draftMemento is wired to workspaceState, not globalState
     → expected [ { id: 'tab-mtjiv9je-sodemp', …(3) } ] to deeply equal [ { id: 't1', name: 'Saved', …(2) } ]
 FAIL  src/extension.test.ts > ARP-08 — console draft memento wiring > #3 edge/history-vs-draft scope: run → globalState.update(CONSOLE_HISTORY_KEY); edit+dispose → workspaceState.update(CONSOLE_DRAFTS_KEY); keys never cross
     → expected false to be true // Object.is equality  (at: expect(ctx.workspaceState.get.mock.calls.some(([k]) => k === CONSOLE_DRAFTS_KEY)).toBe(true))

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed | 97 skipped (101)
```

RED for the expected reason: without `draftMemento` the seeded workspaceState snapshot is never read (#1 got the default empty "Query 1" tab) and `workspaceState.get(CONSOLE_DRAFTS_KEY)` is never called (#3). #2/#4 passed pre-edit because singleton/deactivate guarantees were already correct — they now pin those guarantees against regression, per §Goal.

### Implementation

- `src/extension.ts` — `commandOpenConsole` gains fifth parameter `draftMemento: vscode.Memento` and forwards it into `new ConsolePanel({...})`; the single registration site (`UnicDB.openConsole`, formerly `753-754`) now passes `context.workspaceState`. NOTHING else changed: `context.globalState` remains the history `memento`; singleton `if (!consolePanel)` guard, `onDispose → consolePanel = null`, `onRun`/`runStatements`, `deactivate()` teardown untouched; `commandOpenConsoleCreateTab` untouched (never constructs the panel).
- `src/extension.test.ts` — new describe `ARP-08 — console draft memento wiring` (4 tests) reusing `makeCtx()` (workspaceState/globalState get+update spies), the `activateWithConsole` pattern, and the `findConsolePanelCall`-style panel harness; `deactivate()` driven in `afterEach` like the TASK-003 block. Existing TASK-003 pins NOT weakened.

### GREEN + Verification (fresh, this turn)

| # | §Test Cases | Result |
|---|---|---|
| 1 | happy: seeded workspaceState draft hydrates; `workspaceState.get(CONSOLE_DRAFTS_KEY)` called | PASS |
| 2 | happy: double `UnicDB.openConsole` → exactly one `createWebviewPanel("UnicDB.console")` | PASS |
| 3 | edge key separation: `globalState.update(CONSOLE_HISTORY_KEY)` on run; `workspaceState.update(CONSOLE_DRAFTS_KEY)` on edit+dispose flush; no key ever appears in the other memento's call log | PASS |
| 4 | edge teardown: `deactivate()` disposes the panel and nulls the singleton; reopen creates a fresh (second) panel | PASS |
| 5 | not-expected-close | N/A — wiring was absent (see step-1 evidence); real edit performed |

```
$ npx vitest run src/extension.test.ts
 ✓ src/extension.test.ts  (101 tests) 809ms
 Test Files  1 passed (1)
      Tests  101 passed (101)

$ npx vitest run src/ui/__tests__/consolePanel.test.ts
 ✓ src/ui/__tests__/consolePanel.test.ts  (29 tests) 19ms
 Test Files  1 passed (1)
      Tests  29 passed (29)

$ npx tsc --noEmit            → exit 0
$ npm run typecheck           → exit 0
$ npm run compile             → esbuild: build complete, exit 0
```

git status --porcelain (worktree): only `M src/extension.test.ts`, `M src/extension.ts`. No git add/commit/push performed. No changes to `consolePanel.ts` / `consolePanelMessages.ts` / webview files / `package.json`.

Note: orchestrator step list said `src/ui/__tests__/extension.test.ts`; that path does not exist in this repo — the task file's contract (`src/extension.test.ts`, lines 14-15, 27-29) governs and was followed. Verification used the task file's §Verification Commands (vitest run src/extension.test.ts + npm run typecheck) plus the orchestrator's extra asks (consolePanel.test.ts, tsc --noEmit, npm run compile) — all pass.

ISSUES: none.

HANDOFF_TO_REVIEWER: yes — STATUS DONE, handoff.reviewer.enabled=true, reviewer model unic-smart ≠ executor unic-code.

---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/extension.test.ts && npx tsc --noEmit
  result: 101/101 PASS; tsc exit 0
TEST_PLAN_COVERAGE: all-followed — PLAN §4 rows 31-34 (#1-#4 implemented); #5 not-needed N/A with step-1 evidence (grep workspaceState -> 0 hits pre-edit; wave-2 draftMemento option confirmed consumed)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: draftMemento = context.workspaceState is threaded at the single call site (extension.ts:756-762) and forwarded into new ConsolePanel({ draftMemento }); history stays globalState under CONSOLE_HISTORY_KEY via the unchanged `memento` option. Singleton guard, onDispose -> consolePanel = null, and deactivate teardown untouched; commandOpenConsoleCreateTab never constructs the panel, so no signature ripple. Test #3 key-separation pin asserts real routing (globalState.update never sees CONSOLE_DRAFTS_KEY; workspaceState.get sees it) — not a tautology. Wave-3 commit 7ce8afd touches only extension.ts + extension.test.ts (file disjointness held). RED evidence real: 2 failed for the missing-wiring reason; #2/#4 passed pre-edit because they pin already-correct guarantees.
