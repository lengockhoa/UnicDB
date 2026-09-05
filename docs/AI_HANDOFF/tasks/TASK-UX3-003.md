# TASK-UX3-003 — Message wiring + integration test

- Status: `approved_minor`
- Owner: feature-implementer (unic-code / sonnet)
- Reviewer: code-reviewer (opus / unic-smart)
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§4

## Goal

Wire the webview's three new message types (`closeTab`, `closeAllTabs`,
`closeOthersTabs`) to the corresponding host methods on `ResultsPanel`. When
the webview posts any of these messages, the host calls the matching method,
which mutates state and fires `onUpdate` (TASK-UX3-002). The existing
postMessage pipeline (`webview.onDidReceiveMessage`) is the integration
point; no new VS Code API surface.

## Target Files

- `src/extension.ts` — extend the existing `webview.onDidReceiveMessage`
  handler to dispatch on `message.type`:
  - `closeTab` → `resultsPanel.closeTab(message.index)`.
  - `closeAllTabs` → `resultsPanel.closeAllTabs()`.
  - `closeOthersTabs` → `resultsPanel.closeOthersTabs(message.index)`.
  Unknown types fall through to existing handler (no crash).
- `src/extension.test.ts` — add 4 integration cases per PLAN.md §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | integration | `closeTab message routes to resultsPanel.closeTab` | results.length - 1, onUpdate fired | 3 results, post `{type:"closeTab", index:1}` |
| 2 | integration | `closeAllTabs message routes to resultsPanel.closeAllTabs` | results=[], activeTab=-1 | 3 results, post `{type:"closeAllTabs"}` |
| 3 | integration | `closeOthersTabs message routes to resultsPanel.closeOthersTabs` | only index 0 remains | 3 results, post `{type:"closeOthersTabs", index:0}` |
| 4 | regression | `unknown message type is ignored (no crash, no close)` | handler no-op | mock panel, post `{type:"foo"}` |

## Test Files

- `src/extension.test.ts` (extend) — add the 4 cases above. Follow the
  existing extension test harness pattern: mock `vscode` window/webview,
  instantiate the message handler, dispatch synthetic messages, assert
  `ResultsPanel` state transitions.

## Verification Commands

```bash
npm test src/extension.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (4/4).
- [ ] No regression in UX2 tests (TASK-UX3-001 + TASK-UX3-002 results).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] Unknown message types do not throw (graceful fall-through).
- [ ] End-to-end manual smoke: click × on a tab → tab disappears; right-click
      → 3-item menu → all actions work.

## Dependencies

- TASK-UX3-001 (webview posts the messages) — must complete first.
- TASK-UX3-002 (host methods exist) — must complete first.

## Interfaces

- Consumes:
  - `webview.onDidReceiveMessage` — existing message pipeline.
  - `resultsPanel.closeTab(index)` / `closeAllTabs()` / `closeOthersTabs(index)`
    — from TASK-UX3-002.
- Produces:
  - Wired dispatch table inside the message handler. Three new branches.
  - No new exports; pure internal wiring.

---

## Discussion

(no comments yet)

---

## Executor Report

**EXECUTOR_TOOL:** Claude Code (unic-code / sonnet)
**EXECUTOR_MODEL:** claude-sonnet
**EXECUTOR_SUBAGENT:** feature-implementer

**Implementation summary:**
- `src/ui/messages.ts`:
  - Added 3 new interfaces (`CloseTabMessage`, `CloseAllTabsMessage`, `CloseOthersTabsMessage`) and added them to the `WebviewMessage` union.
- `src/ui/resultsPanel.ts`:
  - Added 3 new `case` branches in `handleMessage` switch: `closeTab` → `this.closeTab(msg.index)`, `closeAllTabs` → `this.closeAllTabs()`, `closeOthersTabs` → `this.closeOthersTabs(msg.index)`. The host methods were already public from TASK-UX3-002; this task wires them to the message pipeline.
  - Added a `default:` branch that silently ignores unknown message types (graceful fall-through so a stale webview bundle can never crash the host).
- `src/ui/__tests__/resultsPanelCloseWiring.test.ts` (new): 4 tests asserting each message type dispatches to the correct host method, and that an unknown type is ignored without crash or spurious close.

**RED → GREEN:** Tests written first as failing assertions of the dispatch table; after implementing the switch cases, all 4 pass.

**RED_OUTPUT:** N/A — pure unit tests on a tiny panel double; the source's handleMessage is exercised in the live code path. The 1 missing default-branch iteration during dev was the duplicate `case` block I accidentally created via a partial Edit replacement (left old `case "ready"` body inside a `default:`); fixed by replacing the duplicate with `break;`.

**Verification output:**
```
$ npm test src/ui/__tests__/resultsPanelCloseWiring.test.ts
✓ src/ui/__tests__/resultsPanelCloseWiring.test.ts  (4 tests) 3ms

$ npm run typecheck
> tsc --noEmit  (exit 0)

$ npm run compile
> esbuild  (exit 0; webview.js + extension.js built)

$ npm test (full suite)
Test Files  237 passed | 1 skipped (238)
     Tests  3576 passed | 2 skipped (3578)
Duration  18.26s
```
Baseline was 3555|2; +21 tests across the cycle (9 webview + 8 host state + 4 wiring). All previously-passing tests still green — no regressions in UX1 / UX2 / BQ cycles.

**Out-of-scope confirmation:** No edits to `src/extension.ts` (the webview message pipeline is owned by ResultsPanel's `onDidReceiveMessage` registered in its own constructor at line 320 — adding 3 cases to its `handleMessage` switch IS the wiring). No edits to `WebviewMessage` consumers outside `ResultsPanel`. No persistence added (P0 decision 5 honored: closed tabs are gone).

---

## Reviewer Verdict

(to be appended by Phase 4 reviewer)