# TASK-AIC-004 — Add Console ghost-text autocomplete

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§7

## Goal

Add AI ghost-text suggestions to the VSDB Console textarea, using AIC-002's sole debounce/cancellation service plus Console-specific rendering/acceptance and stale-response lifecycle handling, while preserving Console tabs, query execution/results, history, formatting, and existing context-menu behavior.

## Target Files

- `src/ui/consolePanel.ts` — inject autocomplete callback, validate/request per active tab, suppress stale responses, and clean lifecycle state.
- `src/ui/consolePanelMessages.ts` — add validated Console webview/host autocomplete message shapes.
- `webview/consolePanelMain.ts` — post input changes without a second debounce, render an escaped positioned ghost overlay without mutating textarea value, accept it atomically via Tab/right-arrow at an eligible caret position, and clear it on edits/tab switches/dispose.
- `src/ui/__tests__/consolePanel.test.ts` — extend Console host behavior tests.
- `src/ui/__tests__/consolePanelMessages.test.ts` — extend untrusted message guard tests.
- `src/ui/__tests__/consolePanelBundle.test.ts` — extend compiled Console DOM/event tests after `npm run compile`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | Console ghost overlay accepts into active buffer atomically | AIC-002's debounced request for `SELECT * FROM us` yields visible escaped overlay `ers` while textarea value is unchanged; Tab accepts exactly `ers` at once into active tab buffer and posts one valid acceptance update. | jsdom Console bundle, controlled host response, active tab. |
| 2 | edge — stale lifecycle | newer edit/tab switch rejects old response | After request A, changing input or switching tabs means late response A does not render or mutate either tab; pending ghost state clears. | Deferred host response and two tabs. |
| 3 | edge — interaction boundary | accept only at eligible cursor location | Tab/right-arrow with selection or cursor not at the buffer end does not insert ghost text and preserves preexisting textarea/browser behavior; Escape/edit clears ghost text. | textarea selection/caret fixtures. |
| 4 | edge — failure/unavailable | failed or absent completion is non-disruptive | Unavailable/failed/cancelled host response shows no ghost and no per-keystroke modal/toast; Run, Format, History, and context menu still perform current message behavior. | Host sends empty/error outcome and existing controls. |
| 5 | regression | host rejects malformed autocomplete webview messages | `isConsoleToHostMessage` rejects malformed IDs/SQL/request sequence and routes no callback; valid existing run/format/history messages remain accepted. | Unknown postMessage fixtures. |

## Test Files

- `src/ui/__tests__/consolePanel.test.ts` — Console host injection and lifecycle tests.
- `src/ui/__tests__/consolePanelMessages.test.ts` — message guard tests.
- `src/ui/__tests__/consolePanelBundle.test.ts` — compiled browser-side ghost-text, acceptance, and existing-control regression tests.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/consolePanel.test.ts src/ui/__tests__/consolePanelMessages.test.ts src/ui/__tests__/consolePanelBundle.test.ts
npm run typecheck
# Manual: open Console, type SQL, verify overlay alignment/value immutability, then accept ghost text.
```

No lint script is defined in `package.json`. `consolePanelBundle.test.ts` reads `dist/consolePanel.js`, so compile must precede the focused test. The manual overlay check is mandatory because jsdom cannot validate visual alignment.

## Acceptance Criteria

- [ ] Console gets ghost text driven by the AIC-002 callback (the sole debounce/cancellation owner) and explicit, guarded Tab/right-arrow acceptance.
- [ ] Ghost text is an HTML-escaped positioned overlay, never mutates actual SQL/tab buffer until the one atomic acceptance update, and is visually smoke-tested.
- [ ] Every request is scoped to current tab/input sequence; tab changes, edits, disposal, cancellation, unavailable config, provider failure, and connection-clearing outcomes leave no stale insertion or disruptive notification.
- [ ] Existing Console run, selection run, statement run, results routing, history, format, save, tab, shortcut, and context-menu behavior remain intact.
- [ ] All inbound autocomplete messages receive the same strict runtime validation as existing Console messages.
- [ ] All named test cases and verification commands pass with fresh output.
- [ ] Reviewer verdict is `approved` or `approved_minor`.

## Dependencies

- TASK-AIC-002

## Interfaces

- Consumes: AIC-002 `SqlAutocompleteService` request method resolving `Promise<string | null>` for caller scope tab ID; current `ConsolePanelOptions.onRun: (sql: string) => void | Promise<void>`; existing `ConsoleToHostMessage` and `ConsoleHostToWebviewMessage` discriminated unions guarded by `isConsoleToHostMessage(value: unknown): value is ConsoleToHostMessage`.
- Produces: additive validated request/response/clear Console message variants and an additive `ConsolePanelOptions` autocomplete callback seam used by AIC-005; host owns per-tab request sequence/cancellation, webview owns overlay presentation only; no change to `onRun` signature or Console runner semantics.

---

## Discussion

### 2026-08-29 · planner · unic-smart
The Console is a native webview textarea, so it cannot consume VS Code inline completions. It shares only AIC-002's service with the editor, renders a custom escaped overlay, and explicitly accepts it. Do not send Console history/results to the service; AIC-005 supplies active connection/schema/dialect context and triggers clear outcomes on connection change.

---
