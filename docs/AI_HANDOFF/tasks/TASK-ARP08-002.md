# TASK-ARP08-002 — Host draft restore: hydrate, debounced flush, dispose flush, durable clear

- Status: `pending_review`
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

---

## Executor Report

- Status executed: `ready` → `pending_review`
- Executor: Claude Code feature-implementer subagent

### RED (before implementation)

`npx vitest run src/ui/__tests__/consolePanel.test.ts` → **10 failed | 19 passed (29)**. Every ARP-08 draft test failed for the expected reason (no `draftMemento` handling existed — no hydrate, no persist, no clear):

```
FAIL ... > #1 happy: updateBuffer persists a debounced draft snapshot to the memento after 500ms
FAIL ... > #2 happy: a second panel over the SAME memento (reopen) restores tabs + active id
FAIL ... > #4 edge: 1-tab and 2-tab (active=tab2) snapshots both restore verbatim on reopen
FAIL ... > #6 edge/flush-once: dirty panel → dispose() → dispose() again writes the draft exactly once
FAIL ... > #6b edge/flush-once: panel-close path (onDidDispose) also flushes exactly once
FAIL ... > #7 edge/privacy: persisted payload carries exactly {version,tabs,activeTabId} and tabs {id,name,buffer}
FAIL ... > #8 edge/durable clear: clearDrafts removes the memento key; reopen shows one empty 'Query 1'
FAIL ... > #9 edge/clamp: 21 tabs + oversized buffer persist as 20 tabs with the buffer sliced
FAIL ... > #12 edge/latest-wins: three rapid updateBuffers then dispose WITHOUT advancing → one persist carrying C
FAIL ... > #13 edge/order: out-of-creation-order snapshot tabs restore verbatim in snapshot order
Test Files  1 failed (1)   Tests  10 failed | 19 passed (29)
```

(Excerpt of #13 failure — restore absent, seed tab returned instead:)

```
AssertionError: expected [ 'tab-mtji45hh-xmuof0' ] to deeply equal [ 'zzz', 'aaa' ]
```

### Implementation notes

- `ConsolePanelOptions.draftMemento?: vscode.Memento` added; when omitted, hydrate/persist no-op (in-memory fallback, test #11).
- `hydrateDrafts()` runs after the seed tab + `hydrateHistory()`; replaces state only when `parseConsoleDraftSnapshot` returns a valid snapshot; never throws (tests #3/#4/#13).
- `updateBuffer` routes through `tabById` guard → `setBuffer` + `scheduleDraftPersist()` (500ms trailing-edge, latest-wins, reset per update); stays SILENT (no `postState`) — render-loop seam preserved (PLAN §3). Unknown tabId arms nothing (test #10, regression per task table).
- `persistDrafts()` clears the timer, writes only when `draftDirty` (idempotent); `buildDraftSnapshot()` clamps to `CONSOLE_DRAFTS_MAX_TABS` / `CONSOLE_DRAFTS_MAX_BUFFER_CHARS` and remaps `activeTabId` into survivors (tests #9, #12).
- `flushDrafts()` (idempotent, delegates to `persistDrafts()`) called FIRST in both `dispose()` and the `onDidDispose` handler — exactly-once semantics pinned in tests #6/#6b; `draftTimer` is `ReturnType<typeof setTimeout>`.
- `handleClearDrafts()`: cancels timer, `draftMemento.update(CONSOLE_DRAFTS_KEY, undefined)` (durable-empty — later dispose cannot resurrect), resets to one fresh empty `Query 1`, posts `state` + `draftsCleared` ack (test #8).
- `hydrateHistory` / `pushHistory`, AIC-004 ghost-text seams, ARP-02 surfaces, and the public accessor signatures are untouched (additive lines only).
- Fix rounds during GREEN: test-side `m`→`memento` typo in #9; implementation-side added the `tabById` guard on `updateBuffer` after test #10 exposed that arming the timer on an unknown tabId would persist a stale snapshot.

### Verification (fresh, this turn)

`npx vitest run src/ui/__tests__/consolePanel.test.ts src/ui/__tests__/consolePanelMessages.test.ts src/ui/__tests__/consoleTabs.test.ts`:

```
 ✓ src/ui/__tests__/consoleTabs.test.ts  (8 tests) 19ms
 ✓ src/ui/__tests__/consolePanel.test.ts  (29 tests) 19ms

 Test Files  3 passed (3)
      Tests  63 passed (63)
```

`npm run typecheck` (tsc --noEmit): clean, no output.

Test-plan coverage vs §Test Cases: #1 ✓, #2 ✓, #3 ✓, #4 ✓ (1-tab + 2-tab), #5 ✓ (onRun spy zero calls), #6 ✓ (+#6b onDidDispose path), #7 ✓ (exact key sets, no results/history/connection keys), #8 ✓ (key removed → `undefined`, reopen empty, no resurrection after later dispose), #9 ✓ (20 tabs + 64k slice + active remap), #10 ✓ (silent no-op, no memento write), #11 ✓ (no-memento fallback), #12 ✓ (one persist carrying C), #13 ✓ (verbatim snapshot order). Debounce tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime(500)` and never `until()`.

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Claude:feature-implementer
SUMMARY: ConsolePanel now persists/restores workspace-scoped drafts: constructor hydration (fail-closed), debounced updateBuffer persist (silent, 500ms trailing), idempotent flush on both dispose paths, durable clearDrafts — all without ever invoking onRun.
TEST_PLAN_FOLLOWED: task §Test Cases (all 13 cases; #6b added to pin the onDidDispose flush path separately)
FILES_CHANGED:
  - src/ui/consolePanel.ts: draftMemento option, hydrateDrafts, scheduleDraftPersist/persistDrafts/flushDrafts, updateBuffer tabId guard + debounce, clearDrafts case
  - src/ui/__tests__/consolePanel.test.ts: local FakeMemento + describe "ConsolePanel — draft recovery (ARP-08)" (14 tests)
TESTS_ADDED:
  - src/ui/__tests__/consolePanel.test.ts: #1 debounced persist, #2 reopen restore, #3 corrupt fallback, #4 1/2-tab restore, #5 never-runs, #6/#6b flush-once both paths, #7 privacy pin, #8 durable clear, #9 clamp, #10 unknown-tabId no-op, #11 no-memento fallback, #12 latest-wins, #13 snapshot order
VERIFICATION:
  command: npx vitest run src/ui/__tests__/consolePanel.test.ts src/ui/__tests__/consolePanelMessages.test.ts src/ui/__tests__/consoleTabs.test.ts && npm run typecheck
  result: 63 pass / 0 fail; typecheck clean
  output_excerpt: |
    Test Files  3 passed (3)
         Tests  63 passed (63)
    > tsc --noEmit   (no errors)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — DONE with fresh PASS output; reviewer model must differ from unic-code
NEXT: ready for review; then TASK-ARP08-004 wires extension.ts draftMemento
