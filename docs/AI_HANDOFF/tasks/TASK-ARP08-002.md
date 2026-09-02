# TASK-ARP08-002 — Host draft restore: hydrate, debounced flush, dispose flush, durable clear

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §3, §4, §5, §7

## Goal

Make `ConsolePanel` persist and restore workspace-scoped console drafts: hydrate from `options.draftMemento` in the constructor (fail-closed to one empty tab), debounce-persist on `updateBuffer`, flush exactly once on dispose, and implement a durable `clearDrafts` handler — all without ever invoking `onRun` and without touching the ARP-02 deactivation sentinel or AIC-004 ghost-text seams.

## Target Files

- `src/ui/consolePanel.ts` — add `draftMemento?: vscode.Memento` to `ConsolePanelOptions`; import the codec/constants from `./consolePanelMessages`; `hydrateDrafts()` in the constructor; debounced `updateBuffer` handling; `persistDrafts()` (clamp + encode + `draftMemento.update`); `flushDrafts()` (idempotent) called from both `dispose()` and the `onDidDispose` handler; `case "clearDrafts"` in `handleMessage`. No other source file is modified.
- `src/ui/__tests__/consolePanel.test.ts` (existing file) — new describe blocks for drafts using `vi.useFakeTimers()`; reuse the file's `vi.mock("vscode")` harness and add a local `FakeMemento` (copy the class from `src/ui/__tests__/consoleTabs.test.ts:21-29` — do NOT import across test files).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 1 | happy | construct with `draftMemento`; post `updateBuffer` for the seeded tab with `"SELECT 1"`; `vi.advanceTimersByTime(500)` | `memento.get(CONSOLE_DRAFTS_KEY)` is a string; `parseConsoleDraftSnapshot(it)` non-null with the typed buffer |
| 2 | happy | construct a SECOND `ConsolePanel` over the SAME memento (reopen) | tabs (ids + names + buffers) and `getActiveTabId()` restore identically to what was persisted |
| 3 | edge (corrupt) | seed `CONSOLE_DRAFTS_KEY` with garbage (`"###not-json###"`) | exactly one tab, name `"Query 1"`, empty buffer; constructor does not throw |
| 4 | edge (one/two-tab restore) | persist a 1-tab and separately a 2-tab snapshot (active = tab 2) then reopen | restored tab count, ids, names, buffers and active id match in both cases |
| 5 | edge (never-runs) | persist, reopen with an `onRun` spy, drive restore | `onRun` spy called **zero** times |
| 6 | edge (concurrent flush-once) | dirty the panel, then `dispose()`, then call `dispose()` again (or dispose + re-`show` + `onDidDispose`) | `memento.update(CONSOLE_DRAFTS_KEY, …)` called exactly ONCE for the single dirty flush |
| 7 | edge (privacy) | multi-tab session (create 2 tabs, type different buffers, switch, flush) → `parse` the persisted payload | exact key set `["activeTabId","tabs","version"]`; each tab key set exactly `["buffer","id","name"]`; no results/history/password/connection fields present anywhere |
| 8 | edge (durable clear) | post `{ type: "clearDrafts" }` → advance timers → reopen a new panel on the same memento | `memento.get(CONSOLE_DRAFTS_KEY)` is `undefined`; reopened panel has exactly one empty `Query 1` tab; the pre-clear buffer is gone |
| 9 | edge (boundary clamp at persist) | 21 tabs + a 70_000-char buffer in host state → flush | persisted snapshot has exactly 20 tabs; the big buffer is sliced to `CONSOLE_DRAFTS_MAX_BUFFER_CHARS`; `activeTabId` points at a surviving tab |
| 10 | regression | post `updateBuffer` with an unknown `tabId` | silent no-op: no throw, no memento write (setBuffer already no-ops on unknown id) |
| 11 | edge (fallback) | construct with NO `draftMemento` | hydrate no-ops (fresh empty tab), persist no-ops, no throw — in-memory-only fallback |
| 12 | edge (debounce reset) | three rapid `updateBuffer`s (A→B→C) then dispose without advancing the timer | exactly ONE persist, carrying buffer C (latest-wins; timer reset each update) |
| 13 | edge (restore preserves order) | persisted tabs out of creation order in the snapshot | host restores them verbatim in snapshot order (no re-sorting) |

## Test Files

- `src/ui/__tests__/consolePanel.test.ts` — new `describe("ConsolePanel — draft recovery (ARP-08)")` block. Debounce/flush tests MUST use `vi.useFakeTimers()` + `vi.advanceTimersByTime(500)` / `vi.runAllTimers()` and must NOT use the file's `until()` helper (it awaits a real `setTimeout` and deadlocks under fake timers). The file already has `afterEach(() => vi.useRealTimers())`. `show()` before dispatching `updateBuffer` so the message handler is wired (the `panelHarness()` helper at `consolePanel.test.ts:109-117`).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/consolePanel.test.ts
npm run typecheck
```

(No `npm run compile` here — the bundle gate belongs to TASK-ARP08-003.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED→GREEN).
- [ ] Restore never executes SQL: `onRun` is not invoked by construction, hydration, or clear.
- [ ] `updateBuffer` handling stays SILENT (no `postState` reply) — the flush cannot render-loop; this is the load-bearing seam from PLAN §3.
- [ ] `flushDrafts()` is idempotent and covers both the user-closed-tab path (`onDidDispose`) and the reload/deactivate path (`dispose()` from `extension.ts:1067`).
- [ ] `clearDrafts` removes the `CONSOLE_DRAFTS_KEY` (durable-empty) and cannot resurrect the old draft after a later dispose.
- [ ] Privacy: persisted payload key set is exactly `{version, tabs, activeTabId}` with tabs `{id, name, buffer}` — no results/history/passwords/connection data.
- [ ] ARP-02 deactivation sentinel and AIC-004 ghost-text seams byte-identical in behavior (additive lines only); `listTabs`/`getBuffer`/`setBuffer`/`createTab`/`closeTab` public surface unchanged.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP08-001 (imports `parseConsoleDraftSnapshot`, `encodeConsoleDraftSnapshot`, `CONSOLE_DRAFTS_KEY`, `CONSOLE_DRAFT_SNAPSHOT_VERSION`, `CONSOLE_DRAFTS_MAX_TABS`, `CONSOLE_DRAFTS_MAX_BUFFER_CHARS`, and the `clearDrafts` message type from `./consolePanelMessages`).

## Interfaces

- Consumes:
  - `parseConsoleDraftSnapshot(raw: string): ConsoleDraftSnapshot | null`
  - `encodeConsoleDraftSnapshot(snapshot: ConsoleDraftSnapshot): string`
  - `CONSOLE_DRAFTS_KEY` / `CONSOLE_DRAFT_SNAPSHOT_VERSION` / `CONSOLE_DRAFTS_MAX_TABS` / `CONSOLE_DRAFTS_MAX_BUFFER_CHARS`
  - `{ type: "clearDrafts" }` as a `ConsoleToHostMessage` member (guard accepts it)
  - existing `ConsolePanelOptions` (`extensionUri`, `onRun`, `onDispose?`, `memento?`, `onAutocomplete?`) — unchanged.
- Produces: `ConsolePanelOptions.draftMemento?: vscode.Memento` (consumed by TASK-ARP08-004). No exported public API change beyond the new optional option; `listTabs()` / `getActiveTabId()` / `getBuffer()` / `setBuffer()` / `createTab()` / `closeTab()` signatures unchanged.

---

## Discussion

- Suggested private shape (executor may refine, keep the semantics): `private draftTimer: ReturnType<typeof setTimeout> | null = null;` and `private draftDirty = false;`. `updateBuffer` → `this.setBuffer(tabId, buffer); this.scheduleDraftPersist();` where `scheduleDraftPersist()` sets `draftDirty = true`, clears any existing timer, and arms a fresh 500ms timer. `persistDrafts()` clears the timer, and if `draftDirty`, clamps + encodes + `draftMemento?.update(CONSOLE_DRAFTS_KEY, encoded)` then sets `draftDirty = false`. `flushDrafts()` calls `persistDrafts()` (so it is naturally idempotent — repeated calls with nothing dirty write nothing). `clearDrafts` → cancel timer, `draftMemento?.update(CONSOLE_DRAFTS_KEY, undefined)`, reset `this.tabs` to one fresh `{ id: newTabId(), name: "Query 1", buffer: "" }`, `activeTabId = tabs[0].id`, `draftDirty = false`, `postState()`.
- Clamp-at-persist contract: slice every buffer to `CONSOLE_DRAFTS_MAX_BUFFER_CHARS`; keep the first `CONSOLE_DRAFTS_MAX_TABS` tabs in creation order; if the clamped list no longer contains `activeTabId`, remap to `tabs[0].id`. This guarantees our writer never emits a snapshot `parse` would reject (PLAN §3).
- Hydration order: constructor seeds the empty tab FIRST (`consolePanel.ts:143-144`), then `hydrateDrafts()` REPLACES the seed when a valid snapshot exists. On corrupt/missing, keep the seed. Mirror `hydrateHistory`'s defensive style (`310-318`).
- `draftMemento.update(key, undefined)` removes the key in real VS Code and in `FakeMemento` (`data.set(key, undefined)` → `get` returns `undefined`). Pin that exact observable in test #8.
- Timer type: `ReturnType<typeof setTimeout>` keeps Node+DOM timer types compatible — do not use `number`.
