# PLAN — UX3: Closeable Tabs in Results Panel

## §1 Intent

**Problem.** The Results panel currently accumulates tabs forever. After running
several queries, the user has no way to remove a tab without closing the panel
or starting a new run that pushes the old tabs down. There is no × button on
each tab, no right-click "Close" menu, no way to close the active tab. The tab
strip becomes a wall of `Run N · Stmt M` labels that the user must scroll
through to find their current work.

**User P0 decisions (locked 2026-09-04):**
1. × button per tab, **visible on hover** (not always-on; reduces visual noise
   when user is just reading tabs).
2. Right-click menu gets: **Close Tab** (close hovered tab), **Close All Tabs**,
   **Close Other Tabs** (close all except hovered).
3. **Active tab IS closeable** — closing the active tab auto-activates the
   nearest tab (right if exists, else left, else no tab).
4. **Empty state** when no tabs left — show a friendly placeholder in the panel
   body ("No runs yet — run a query to see results here") instead of an empty
   grid.
5. **NO persistence** — closed tabs are gone (no Ctrl+Shift+T history, no
   workspaceState restore). Target release: **v1.51.4**.

**Success definition.** After this cycle:
1. Hovering any tab reveals a × button on its right edge. Clicking × closes
   that tab.
2. Right-clicking any tab shows a context menu with `Close Tab`, `Close All
   Tabs`, `Close Other Tabs`. Each item correctly handles the hovered tab and
   the case where closing would empty the strip.
3. Closing the active tab auto-activates the nearest tab (right first, then
   left). The new active tab's content re-renders.
4. When the last tab is closed, the panel body shows an empty-state message;
   the tabs strip shows no tabs but stays reserved (height preserved).
5. No persistence — closing the panel and reopening starts empty (or with
   whatever the next run produces).
6. Existing `tabTitle` / `tabBadge` / error-card path from UX2 is byte-untouched.
7. Existing render-pipeline (`onUpdate → ResultsPanel.render → webview.render`)
   continues to work; only the tab-strip DOM grows the close affordances.

**Out of scope this cycle:**
- Drag-to-reorder tabs.
- Tab persistence across sessions (Ctrl+Shift+T history, workspaceState).
- Middle-click to close (P1 deferral — hover button + right-click menu cover
  the user need).
- Pinning / unpinning tabs.
- Tab duplication.
- Modifying the Messages tab (it lives in a separate slot — left untouched).

## §2 Scope

**In scope (touched files):**

Render surface (webview-owned):
- `webview/main.ts` — `rebuildTabs()` (currently at `webview/main.ts:638`):
  - Add × button (`<button class="UnicDB-tab-close">`) per tab, hidden by default,
    visible on `.UnicDB-tab:hover`.
  - × button click stops propagation, fires `postMessage({type: "closeTab",
    index})` to host.
  - Right-click (`contextmenu` event) on tab fires
    `postMessage({type: "tabContextMenu", index, items: ["close", "closeAll",
    "closeOthers"]})` to host. Webview does NOT implement the menu itself —
    host shows the native VS Code context menu via `vscode.window.showQuickPick`
    or a custom webview menu. (Decision: **webview-rendered menu** in
    `webview/main.ts` to avoid host round-trip latency. Items render inline
    below the tab on right-click.)
- `webview/main.ts` — `renderGrid()` (or equivalent panel renderer): when
  `state.results.length === 0`, render an empty-state div with message
  "No runs yet — run a query to see results here" (or similar copy).
- `webview/main.ts` — `setCurrentStatement()`: after `results.splice(...)` /
  active-tab change, if `results.length === 0` → keep `activeTab = -1` and
  panel body renders empty state.

Host (state owner):
- `src/ui/resultsPanel.ts` — add `onDidChangeTabs` / `closeTab(index)` /
  `closeAllTabs()` / `closeOthersTabs(index)` methods to the existing
  ResultsPanel state holder. The host is the source of truth for `results[]`
  and `activeTab`; webview is purely a render consumer.
- `src/ui/resultsPanel.ts` — `closeTab(index)` removes results[i] and adjusts
  `activeTab`: if removing the active tab, set `activeTab = min(index,
  results.length - 1)`; if results.length becomes 0, set `activeTab = -1`.
  Fire the existing `onUpdate` so webview re-renders.
- `src/extension.ts` — wire host message handlers: when webview sends
  `closeTab` / `closeAllTabs` / `closeOthersTabs`, call the corresponding
  `resultsPanel.closeXxx(...)` method. Use the existing postMessage
  `webview.onDidReceiveMessage` pipeline.

Tests (TDD-embedded; see §4):
- `webview/__tests__/mainCloseTab.test.ts` (new) — 7 cases: × button DOM
  presence + visibility + click, context menu items, close active → nearest
  activation, empty state, close all, close others.
- `src/ui/__tests__/resultsPanelClose.test.ts` (new) — 5 cases:
  `closeTab` removes + adjusts active; `closeAllTabs` empties + activeTab = -1;
  `closeOthersTabs(index)` keeps index + removes rest; `closeTab(-1)` is a
  no-op; `closeTab` on empty array is a no-op.

**Out of scope (deferred):**
- Drag-to-reorder (P1 backlog).
- Tab persistence (P1 — user explicitly opted out for v1.51.4).
- Middle-click close (P1 — covered by × and right-click).
- Pin/unpin, duplicate, detach-to-window (P2+).
- Modifying the Messages tab — the Messages tab lives in a separate slot and
  is not part of `results[]`.

**Same-wave isolation.** Tasks must not modify the same file concurrently:
- TASK-UX3-001 = `webview/main.ts` only (× button + context menu DOM +
  empty-state DOM). Webview-only; no host changes. Test file
  `webview/__tests__/mainCloseTab.test.ts` (new).
- TASK-UX3-002 = `src/ui/resultsPanel.ts` only (host state owner methods:
  `closeTab` / `closeAllTabs` / `closeOthersTabs`). Test file
  `src/ui/__tests__/resultsPanelClose.test.ts` (new).
- TASK-UX3-003 = `src/extension.ts` only (wire host message handlers →
  ResultsPanel methods). Possibly minor `resultsPanel.ts` constructor change
  if needed for the wire-up.

**Wave structure:** Wave 1 = TASK-UX3-001 (webview render surface + tests).
Wave 2 = TASK-UX3-002 (host state methods + tests). Wave 3 = TASK-UX3-003
(message wiring + integration test). This wave structure is justified because
the host state methods (TASK-UX3-002) must exist before the message wiring
(TASK-UX3-003) can call them. The webview (TASK-UX3-001) ships its DOM first
in isolation because it depends on the existing `state.results` shape (which
won't change) — it just adds close affordances; the wiring wave glues them
together.

## §3 Approach

**Why host-owned close methods.** The `results[]` array lives in the host
(`ResultsPanel` in `src/ui/resultsPanel.ts`); the webview only renders it.
Adding close methods on the host keeps state single-sourced: the webview posts
a `closeTab` message, the host mutates `results[]` and `activeTab`, then
fires the existing `onUpdate` → webview re-renders. Trying to do `results.splice`
in the webview and post the trimmed array back would double-source state.

**Active-tab activation rule.** When `closeTab(i)` removes the active tab:
- If `results.length > 0` after removal: `activeTab = min(i, results.length - 1)`.
  This gives "right if exists, else left" because index `i` after `splice` is
  exactly the next-right position (or the last position if right was empty).
- If `results.length === 0`: `activeTab = -1`. Webview empty-state branch.

**Empty state.** Rendered inside the existing panel body slot. When
`results.length === 0`, the renderer (`renderPanel()` or equivalent) returns
the empty-state DOM instead of the grid/error-card. The tabs strip collapses
to zero height (no `.UnicDB-tab` children), but the strip container
(`.UnicDB-tabs`) keeps its CSS-reserved height for layout stability — the
`align-items` and `border-bottom` remain so a new run instantly drops a tab
in without layout shift.

**Context menu decision: webview-rendered, not VS Code native.** A native
VS Code context menu (`vscode.window.showQuickPick` or `Menu` API) would
require a host round-trip per right-click (~30-50ms latency, plus visual
discontinuity as focus shifts to the editor). A webview-rendered `<ul>`
appearing below the cursor on `contextmenu` event is instant and matches the
existing webview look. Decision: webview renders the menu inline; clicking a
menu item posts a message to host which calls the corresponding
`resultsPanel.closeXxx(...)` method.

**× button visibility: CSS-only, not JS-driven.** Using `:hover` CSS to
show the × button avoids per-mouse-move JS and is keyboard-accessible via
`:focus-within`. The button has `aria-label="Close tab"` for screen readers.

**No persistence — explicit design.** Per user P0 decision 5, closed tabs are
gone. There is no `workspaceState` restore on panel reopen; the panel always
starts empty (or with whatever the next `runStatements` call produces).
This is enforced by simply not adding any `workspaceState.get('UnicDB.tabs')`
read path — there's nothing to remove, the absence is the design.

**Rejected alternatives.**
- *Native VS Code context menu.* — 30-50ms latency per right-click, focus
  shifts to editor, breaks the "tabs strip is its own world" feel.
- *Drag-to-reorder.* — Out of scope P1 backlog; not in user P0 list.
- *Middle-click close.* — Covered by × and right-click; defer.
- *Persist closed tabs.* — User explicitly opted out for v1.51.4.
- *Track per-tab scroll position / filter.* — Out of scope; tabs restore to
  default (top, no filter) on next render, which is fine because there's no
  persistence anyway.
- *Two producers (webview splice + host close).* — Would double-source state.
  One producer (host) is correct.

## §4 Test Plan

**TASK-UX3-001 — webview close affordances + empty state**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `rebuildTabs()` renders one `<button class="UnicDB-tab-close">` per tab | count = tabs.length | 2 results |
| 2 | unit | `UnicDB-tab-close` has `aria-label="Close tab"` and is `type="button"` | match | 1 tab |
| 3 | unit | Clicking × fires `postMessage({type: "closeTab", index: i})` and stops propagation | message posted, no click-bubble | 3 results, click index 1 |
| 4 | edge | `renderPanel()` with `state.results.length === 0` renders an empty-state element with text containing "No runs yet" | match | empty results |
| 5 | edge | Right-click on tab shows a `<ul class="UnicDB-tab-menu">` with 3 items (`Close Tab`, `Close All Tabs`, `Close Other Tabs`) | match | 3 tabs, right-click index 1 |
| 6 | regression | `tabTitle` and `tabBadge` from UX2 unchanged (run UX2 tests still green) | match | 1 result with sql + status error |
| 7 | regression | Healthy SELECT grid still renders when results.length > 0 (no empty-state in this branch) | grid path | 1 SELECT result |

**TASK-UX3-002 — host state methods on ResultsPanel**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `closeTab(0)` on `[a,b,c]` with activeTab=1 → results = `[b,c]`, activeTab = 0 | match | 3 results, active = index 1 |
| 2 | unit | `closeTab(activeTab)` on `[a,b,c]` with activeTab=1 → results = `[a,c]`, activeTab = 1 (right-of-removed) | match | 3 results, active = index 1 |
| 3 | edge | `closeTab(last index)` on `[a,b,c]` with activeTab=2 → results = `[a,b]`, activeTab = 1 (left fallback) | match | 3 results, active = last |
| 4 | edge | `closeAllTabs()` → results = `[]`, activeTab = -1, fires onUpdate | match | 3 results |
| 5 | edge | `closeOthersTabs(1)` on `[a,b,c]` → results = `[b]`, activeTab = 0 | match | 3 results |
| 6 | edge | `closeTab(-1)` and `closeTab(99)` (out of range) → no-op, no onUpdate | no-op | empty / 3 results |
| 7 | regression | `closeTab` does not mutate the input array reference (returns new array; preserves immutability invariant) | new ref | 3 results |

**TASK-UX3-003 — message wiring + integration**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | integration | Webview sends `{type: "closeTab", index: 1}` → host calls `resultsPanel.closeTab(1)` → onUpdate fires → new state posted to webview with results.length - 1 | end-to-end match | 3 results, mock webview |
| 2 | integration | Webview sends `{type: "closeAllTabs"}` → resultsPanel.closeAllTabs → state.posted with results = [] + activeTab = -1 | match | 3 results |
| 3 | integration | Webview sends `{type: "closeOthersTabs", index: 0}` → resultsPanel.closeOthersTabs(0) → state.posted with only index 0 | match | 3 results |
| 4 | regression | Unknown message type is ignored (no crash, no spurious close) | ignored | mock panel |

**Test files:**
- `webview/__tests__/mainCloseTab.test.ts` (new — TASK-UX3-001; 7 cases)
- `src/ui/__tests__/resultsPanelClose.test.ts` (new — TASK-UX3-002; 7 cases)
- `src/extension.test.ts` (extend — TASK-UX3-003; 4 cases)

Total: 18 cases across 3 files.

## §5 Verification

```bash
# Type check + compile (project's static gates)
npm run typecheck
npm run compile

# Per-task unit suites
npm test webview/__tests__/mainCloseTab.test.ts
npm test src/ui/__tests__/resultsPanelClose.test.ts
npm test src/extension.test.ts

# Full suite (must keep 3555|2 baseline or better)
npm test

# Verify release readiness
npm run verify:fast
```

## §6 Acceptance

- [ ] Every test in §4 passes (18 cases across 3 files).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] Full suite green (current 3555|2 baseline preserved or better).
- [ ] UX2 tests still green (regression — `tabTitle` / `tabBadge` / error-card path
      unchanged).
- [ ] Manual smoke (or screenshot): hover any tab → × button visible → click
      → tab removed; right-click → 3-item menu → all 3 actions work; close all
      tabs → empty state visible.
- [ ] Active tab close auto-activates nearest tab.
- [ ] Empty state shows the friendly placeholder when results.length === 0.
- [ ] No persistence — closing and reopening the panel starts empty.
- [ ] CHANGELOG updated for v1.51.4 with: × button on hover, right-click Close
      menu, active-tab close + auto-activate, empty state.
- [ ] **Release: v1.51.4 published to GitHub** at R5.

## §7 Task Split

| Task | Wave | Title | Files |
|------|------|-------|-------|
| TASK-UX3-001 | 1 | Webview × button + context menu + empty state | `webview/main.ts`, `webview/__tests__/mainCloseTab.test.ts` (new) |
| TASK-UX3-002 | 2 | Host state methods `closeTab` / `closeAllTabs` / `closeOthersTabs` | `src/ui/resultsPanel.ts`, `src/ui/__tests__/resultsPanelClose.test.ts` (new) |
| TASK-UX3-003 | 3 | Message wiring + integration test | `src/extension.ts`, `src/extension.test.ts` |