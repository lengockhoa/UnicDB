# TASK-ARP08-003 — Webview draft UX: debounced flush, flush-before-switch, Clear drafts, restore pre-input

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §3, §4, §5, §7

## Goal

Make the console webview flush buffer edits to the host: a debounced (~500ms) `updateBuffer` post on editor input, an immediate flush of the pending buffer on `visibilitychange→hidden` / `beforeunload` and BEFORE `switchTab`/`closeTab` (which fixes the latent switch-clobber divergence), and a `Clear drafts` toolbar button that clears locally and posts `{ type: "clearDrafts" }` so the old draft can never be resurrected. Restore-pre-input is verified through the existing `state` render path.

## Target Files

- `webview/consolePanelMain.ts` — add a per-tab dirty flag + a single trailing-edge debounce timer (~500ms, latest-wins); `flushPending()` posts `{ type: "updateBuffer", tabId, buffer }` for the current tab when dirty; call it on debounce expiry, `visibilitychange`→hidden, `beforeunload`, and before posting `switchTab` / `closeTab`; add a `Clear drafts` toolbar button (no confirm dialog — the click IS the confirmation) that clears the local active buffer + textarea, cancels the pending debounce, resets dirty, and posts `{ type: "clearDrafts" }`. Do NOT touch host-side buffer logic and do NOT add any host→webview message.
- `src/ui/__tests__/consolePanelBundle.test.ts` (existing jsdom bundle test) — new describe blocks for the ARP-08 webview behavior.
- `src/ui/__tests__/consoleTabs.test.ts` (existing host test) — ONE neighbor pin (test #30 in PLAN §4): the host receives `updateBuffer` and does NOT reply with a `state` message (silent `setBuffer`, no render loop).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 1 | happy | loadBundle; set editor value `"SELECT 1"` + dispatch an `input` event; `vi.advanceTimersByTime(500)` | received posts include exactly `{ type: "updateBuffer", tabId, buffer: "SELECT 1" }` |
| 2 | happy | click the new Clear button | received posts include `{ type: "clearDrafts" }`; editor value is empty; no `confirm`/`window.confirm` called (explicit click is the confirmation) |
| 3 | edge (restore pre-input) | dispatch a `window` `MessageEvent` with `{ type: "state", tabs: [{id:"tab-1", name:"Query 1", buffer:"SELECT * FROM t", active:true}], activeTabId: "tab-1", history: [] }` | `editorEl().value === "SELECT * FROM t"` after render |
| 4 | edge (latest-wins) | three rapid `input` events (`A`→`B`→`C`) under one 500ms window | exactly ONE `updateBuffer` posted, carrying `"C"` |
| 5 | edge (flush-on-unload) | set editor value + `input`; dispatch `beforeunload` WITHOUT advancing timers | `updateBuffer` posted immediately (no 500ms wait) |
| 6 | edge (flush-on-hidden) | set editor value + `input`; override `document.visibilityState` to `"hidden"` and dispatch `visibilitychange` | `updateBuffer` posted immediately. If jsdom refuses the override, fall back: assert `beforeunload` and debounce both exercise the SAME `flushPending` (shared function) and record the limitation in Discussion |
| 7 | regression (divergence) | set editor value + `input` in tab A; immediately click tab B (within the debounce window) | the received message sequence contains `updateBuffer`(A) strictly BEFORE `switchTab`(B) |
| 8 | edge (clear cannot resurrect) | set editor value + `input`; click Clear; `vi.advanceTimersByTime(500)` | NO `updateBuffer` carries the pre-clear text; `clearDrafts` was posted; editor value empty |
| 9 | edge (no postState loop — consoleTabs.test.ts) | host-side: post `updateBuffer` into the console panel handler, then check the panel's `webview.postMessage` mock | NO `{ type: "state" }` message was posted in reply (silent `setBuffer`); the tab buffer IS updated |

## Test Files

- `src/ui/__tests__/consolePanelBundle.test.ts` — new `describe("webview/consolePanelMain.ts bundle — ARP-08 draft recovery")`. Use `vi.useFakeTimers()` for debounce tests + `vi.advanceTimersByTime(500)`, and `afterEach(() => vi.useRealTimers())`. The existing `loadBundle()` helper (`consolePanelBundle.test.ts:22-40`) returns the posted messages; add a small helper that pushes a `state` `MessageEvent` on `window` for test #3. REQUIRES `npm run compile` first (it reads `dist/consolePanel.js`).
- `src/ui/__tests__/consoleTabs.test.ts` — add ONE test to the existing tab-registry describe (the `panelHarness` + `until` helpers already exist there; the host mock's `dispose` fires `onDidDispose`). Do not modify the file's existing tests.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/consolePanelBundle.test.ts src/ui/__tests__/consoleTabs.test.ts
npm run typecheck
```

(`npm run compile` MUST precede the vitest run in a fresh worktree — the bundle test reads `dist/consolePanel.js`.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED→GREEN).
- [ ] Editor input posts a debounced, latest-wins `updateBuffer`; pending buffer flushes immediately on `visibilitychange→hidden`, `beforeunload`, and before `switchTab`/`closeTab`.
- [ ] Switch-away/back divergence fixed: host buffers can no longer be stale-clobbered because the webview flushes before switching (regression-pinned in the bundle test).
- [ ] `Clear drafts` posts `clearDrafts`, clears locally, cancels the pending debounce, and cannot resurrect the pre-clear text.
- [ ] Restore pre-input verified: a `state` message with a non-empty buffer renders into the textarea (existing `render()` line 87 path).
- [ ] Host `updateBuffer` handling stays silent — pinned in `consoleTabs.test.ts` (no `state` reply → no render loop).
- [ ] No new host→webview message type; `consolePanelMessages.ts` is NOT modified (TASK-ARP08-001 owns it); `consolePanel.ts` is NOT modified (TASK-ARP08-002 owns it).
- [ ] Bundle compilation verified: `consolePanelBundle.test.ts` green after `npm run compile`.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP08-001 (the `clearDrafts` message shape and guard must exist; the webview posts the plain object and the guard accepts it).

## Interfaces

- Consumes:
  - `{ type: "clearDrafts" }` webview→host message (guarded by `isConsoleToHostMessage` — produced by TASK-ARP08-001; the webview posts the plain object, it does not import the guard).
  - Existing host→webview `state` message shape: `{ type: "state", tabs: Array<{id,name,buffer,active}>, activeTabId: string, history: string[] }` (unchanged — used by the restore-pre-input pin).
  - Existing `updateBuffer` message shape: `{ type: "updateBuffer", tabId: string, buffer: string }` (already guarded at `consolePanelMessages.ts:92-95`).
- Produces: webview behavior only — no exported API, no source-file interface change.

---

## Discussion

- Debounce design: one module-level timer + one per-tab dirty map is enough — `dirtyByTab: Set<string>` plus `pendingFlushTimer`. `on input` → set local buffer (existing behavior), add tab to dirty set, reset the single 500ms timer. Timer fires → `flushPending()` posts `updateBuffer` for the ACTIVE dirty tab only (latest-wins per active tab; a background dirty tab flushes when the user returns to it via the flush-before-switch hook). Simplest correct variant acceptable; the test pins are: one `updateBuffer` per debounce window with the final value (#4), and `updateBuffer` before `switchTab` (#7).
- `flushPending()` must be idempotent and cheap — it removes the tab from the dirty set and posts if the tab still exists. It is the single function shared by the debounce timer, `visibilitychange`, `beforeunload`, and the switch/close pre-post hooks, so test #5/#6/#7 all exercise the same code path.
- jsdom `visibilityState` is read-only; if `Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })` does not stick, drop test #6 to a comment + the Discussion note and rely on #5 (beforeunload) + #4 (debounce) — the flush function is identical. Record what you tried.
- Clear button placement: the existing toolbar (`consolePanelMain.ts:69-78`) — add `<button id="consoleClearDraftsBtn" class="vsdb-console-secondary">Clear drafts</button>` next to History. Click handler: cancel the pending timer, clear `dirtyByTab` for the active tab, set local buffer `""` + `e.value = ""`, then `post({ type: "clearDrafts" })`. No confirm dialog (PLAN §3).
- The `state` handler already clobbers `tabs` (`327-341`) — that is fine AFTER the flush-before-switch fix because the host now has the latest buffer before it pushes state. Do not weaken the `state` handler.
