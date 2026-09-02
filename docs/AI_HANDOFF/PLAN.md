# PLAN — ARP-08: Console draft recovery

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-08 (lines 361-393; P2; dep ARP-03 — shipped v1.39.0; preserve ARP-02 ownsRun/deactivate sentinel, AIC-004 ghost-text seams, ARP-06 AI policy untouched).
Base: `main @ 8dca6d2` (v1.43.0). Executor: `unic-code`. Reviewer: `unic-smart`. No lint script — static gate is `npm run typecheck`; bundle gate `npm run compile`.

**Citation corrections (roadmap line anchors are stale — verified against HEAD):**
- Roadmap cites `src/ui/consolePanel.ts:137-145` for "constructor seeds empty Query 1". Actual: constructor seeds the single `Query 1` empty tab at **`consolePanel.ts:143-144`** and calls `hydrateHistory()` at **`145`**; `hydrateHistory()` itself is at **`310-318`**. Roadmap cites `src/extension.ts:1274-1278,1325-1330` for singleton close — those lines are NOT the console wiring. Actual: `consolePanel` module singleton at **`extension.ts:99`**, `commandOpenConsole` at **`1584-1633`** (`new ConsolePanel` at **`1591-1630`**, `onDispose` → `consolePanel = null` at **`1627-1629`**), registration `vsdb.openConsole` → `commandOpenConsole(mgr, runner, panel, context.globalState)` at **`753-754`**, deactivate disposes + nulls at **`1067-1068`**, `deactivating` sentinel at **`94`**.
- `updateBuffer` wire contract confirmed: `ConsoleToHostMessage` member at **`consolePanelMessages.ts:37`**, guard at **`92-95`**, host handles it via `setBuffer` **silently with NO postState** at **`consolePanel.ts:401-403`** (setBuffer at **`231-234`**). This silence is load-bearing: it is why a webview-side flush can never create a render loop.
- Webview confirmed to NEVER post `updateBuffer` (zero hits): the `input` handler at **`webview/consolePanelMain.ts:157-160`** only mutates the local `activeTab().buffer`; the `state` handler at **`327-341`** does `tabs = msg.tabs` — so host buffers go stale and a host `state` push (switch/close/create) clobbers local edits made since the last flush. This is the latent divergence bug the flush fixes.
- Tests-map (`.cache/index/tests-map.json`): `consolePanelMessages.ts` → `[consolePanelMessages.test.ts, consolePanel.test.ts]`; `consolePanel.ts` → `[consolePanel.test.ts, consolePanelBundle.test.ts, consolePanelMessages.test.ts, tests/consolePanelWebview.test.ts]`; `webview/consolePanelMain.ts` → `[consolePanel.test.ts]`; `extension.ts` → `[extension.test.ts, extensionAutocomplete.test.ts, extensionConfigExport.test.ts, mcpExtensionRegistry.test.ts]`.

## §1 Intent

**Problem.** Console history is Memento-backed and capped (200), but a NEW panel intentionally starts empty (`consolePanel.ts:143-144`) and singleton close creates fresh state — the extension drops its `consolePanel` reference on user close (`extension.ts:1627-1629`) and `deactivate` (`1067-1068`), so the next `vsdb.openConsole` constructs a brand-new panel with a single empty `Query 1` tab. Any multi-tab scratch drafts the user had open are lost. Separately, the webview never pushes buffer edits to the host (`consolePanelMain.ts:157-160`), so host buffers are stale the moment a tab is switched or the panel closes — nothing durable to restore even if we tried.

**Success.** (1) A versioned, bounded, workspace-scoped snapshot of `{tabs:[{id,name,buffer}], activeTabId}` persists via a debounced flush + exactly-once flush-on-dispose. (2) Closing/reopening the panel or reloading VS Code restores the bounded drafts into the SAME tab ids and buffers, with the same active tab, and NEVER runs SQL. (3) Corrupt or over-cap persisted state fails closed into one fresh empty tab. (4) Clear is explicit and durable — after `Clear drafts`, reopening shows empty and the old draft cannot be resurrected. (5) The webview now flushes edits to the host, which fixes the existing divergence where a tab switch clobbered unsent edits (regression-pinned). (6) Privacy: the persisted payload is exactly tab id/name/buffer — never results, passwords, transaction state, connection data, or history.

## §2 Scope

**In**
- ARP-08.1 (wave 1) — pure persisted model in `src/ui/consolePanelMessages.ts` (+ `consolePanelMessages.test.ts`): `ConsoleDraftSnapshot` codec (encode/parse, versioned, fail-closed), draft constants, new `clearDrafts` webview→host message + guard case. No other task can land before this one — 08.2/08.3/08.4 import its codec and message type.
- ARP-08.2 (wave 2) — host restore in `src/ui/consolePanel.ts` (+ `consolePanel.test.ts`): `ConsolePanelOptions.draftMemento`; `hydrateDrafts()` in the constructor (mirror `hydrateHistory`); debounced persist on `updateBuffer`; `flushDrafts()` exactly once in the dispose path; `clearDrafts` handler; deterministic cap enforcement at persist; corrupt→empty-tab fallback; restore never invokes `onRun`. Preserves ARP-02 deactivation sentinel and AIC-004 ghost-text seams byte-untouched.
- ARP-08.3 (wave 2) — webview UX in `webview/consolePanelMain.ts` (+ `consolePanelBundle.test.ts` + `consoleTabs.test.ts` neighbor pin): debounced `updateBuffer` post on editor input; flush pending on `visibilitychange→hidden` and `beforeunload`; flush-before-`switchTab`/`closeTab` (the divergence fix); "Clear drafts" toolbar button; restore-pre-input re-render. Bundle compilation verified (`consolePanelBundle.test.ts` stays green).
- ARP-08.4 (wave 3) — extension wiring in `src/extension.ts` (+ `extension.test.ts`): `commandOpenConsole` passes a new `draftMemento` = `context.workspaceState`; verify-only pins that singleton behavior and `globalState` history guarantees are retained. Roadmap sanctions `extension.ts` "only if scope/options change" — workspace-scoping IS the sanctioned change.

**Out**
- Results / result grids, passwords/secrets, transaction state, connection metadata, and query history in the draft payload (history stays in `globalState` under `CONSOLE_HISTORY_KEY` — unchanged).
- Cross-machine sync, unlimited persistence, file writes, automatic replay of restored drafts.
- Changes to `src/ui/schemaCache.ts`, `src/ui/resultsPanel.ts`, `src/ui/aiChatPanel.ts`, adapter/driver files, `package.json`.

**File disjointness.** Wave 2 runs TASK-ARP08-002 (owns `consolePanel.ts` + `consolePanel.test.ts`) and TASK-ARP08-003 (owns `webview/consolePanelMain.ts` + `consolePanelBundle.test.ts` + `consoleTabs.test.ts`) in parallel with NO shared file. TASK-ARP08-003 reads the `clearDrafts` message type from `consolePanelMessages.ts` but must NOT modify it (001 owns it).

## §3 Approach

**Snapshot shape (pure, in `consolePanelMessages.ts` — no vscode import, so the webview bundle shares it).**
```ts
export interface ConsoleDraftSnapshot {
  version: 1;
  tabs: Array<{ id: string; name: string; buffer: string }>;
  activeTabId: string;
}
export function encodeConsoleDraftSnapshot(s: ConsoleDraftSnapshot): string; // JSON.stringify
export function parseConsoleDraftSnapshot(raw: string): ConsoleDraftSnapshot | null; // fail-closed
export const CONSOLE_DRAFTS_KEY = "vsdb.consoleDrafts";
export const CONSOLE_DRAFT_SNAPSHOT_VERSION = 1;
export const CONSOLE_DRAFTS_MAX_TABS = 20;
export const CONSOLE_DRAFTS_MAX_BUFFER_CHARS = 64_000;
```
`parseConsoleDraftSnapshot` returns `null` (fail-closed) when: the carrier is not a string, JSON parse throws, the parsed value is not an object, `version !== 1`, `tabs` is not an array, any tab has a non-string `id`/`name`/`buffer`, `activeTabId` is not a string or does not equal some tab id, `tabs.length > CONSOLE_DRAFTS_MAX_TABS`, or any `buffer.length > CONSOLE_DRAFTS_MAX_BUFFER_CHARS`. Unknown extra fields are **tolerated-and-stripped**: `parse` returns a NEW object containing only the known fields and `encode` emits only known fields — a future-added field never nukes an old snapshot and never leaks through the codec. Over-cap snapshots are REJECTED at parse (treated as corrupt → one empty tab at the host); the host clamps at persist (below) so our own writer can never emit an over-cap snapshot.

**New wire message.** Webview→host `{ type: "clearDrafts" }` (guard: `case "clearDrafts": return true;`). No new host→webview message — clear reuses the existing `state` push (the host resets to one empty tab and calls `postState()`; the webview `state` handler already re-renders the textarea from the restored buffer). Explicit `draftsCleared` was considered and rejected as redundant: the state round-trip already gives the webview everything it needs, and one fewer message means one fewer surface to guard.

**Host (`consolePanel.ts`).** New option `draftMemento?: vscode.Memento`. Constructor: after the current seed, call `hydrateDrafts()` (mirror `hydrateHistory` at `310-318`): read `CONSOLE_DRAFTS_KEY`, `parse`; on `null`/undefined → KEEP the freshly-seeded empty tab; on valid → replace `this.tabs` with the snapshot tabs (ids preserved) and set `activeTabId` (fall back to `tabs[0].id` if absent). Never throws; never calls `onRun`. `updateBuffer` now: `setBuffer` (unchanged, silent) + arm a single per-panel debounce timer (~500ms, trailing-edge, latest-wins — every `updateBuffer` resets it). On expiry → `persistDrafts()`: clamp (slice each buffer to 64k; keep first 20 tabs in creation order; remap `activeTabId` to `tabs[0].id` if the active tab was truncated), `encode`, `draftMemento.update(CONSOLE_DRAFTS_KEY, encoded)` (no-op when `draftMemento` omitted — in-memory-only fallback mirroring history). `flushDrafts()` in the dispose path exactly once: both `dispose()` (`190-204`) and the `onDidDispose` handler (`177-187`) call it; a `draftDirty` flag makes it idempotent — it clears the timer and persists only when dirty. `deactivate` → `consolePanel.dispose()` (`extension.ts:1067`) therefore covers VS Code reload/window close; the user closing the tab covers `onDidDispose`. `clearDrafts` handler: `draftMemento.update(CONSOLE_DRAFTS_KEY, undefined)` (removes the key — the durable-empty representation), cancel any pending timer, reset tabs to one fresh empty `Query 1` tab + set `activeTabId`, mark not-dirty, `postState()`. A later dispose writes nothing (nothing dirty) unless the user typed after clear — and after clear the old text is gone from host state, so it cannot be resurrected.

**The latent divergence bug this cycle fixes (regression-pinned).** Today the webview never posts `updateBuffer`, so after typing in tab A the host's A-buffer is stale; switching to B makes the host push `state` and the webview `tabs = msg.tabs` clobbers A's edits. Fix: (a) the webview flushes a debounced `updateBuffer` on input, (b) the webview flushes its pending buffer BEFORE posting `switchTab`/`closeTab`, and (c) the host keeps `updateBuffer` handling silent (`setBuffer`, NO `postState`) — so the flush can never render-loop. Regression pin: type in A → switch to B → back to A → edits preserved on both host and webview.

**Webview (`consolePanelMain.ts`).** Per-tab trailing-edge debounced `updateBuffer` post (~500ms, latest-wins, one timer). `flushPending()` posts the current tab's buffer if dirty, and is called on: debounce expiry, `visibilitychange`→hidden (via `document.visibilityState`), `beforeunload`, and before `switchTab`/`closeTab`. New toolbar button `Clear drafts` (no confirm dialog — the explicit click IS the confirmation): clears the local active tab buffer + textarea, cancels any pending debounce, resets the dirty flag, posts `{ type: "clearDrafts" }`. `render()` already sets `e.value = a?.buffer ?? ""` (`87`) — restore-pre-input therefore falls out of the existing render path once the host hydrates; the bundle test pins it by pushing a `state` message with a non-empty buffer.

**Extension (`extension.ts`, wave 3).** `commandOpenConsole` gains a `draftMemento: vscode.Memento` parameter; registration passes `context.workspaceState` (workspace-scoped per roadmap). `context.globalState` stays the history memento — history unchanged. Singleton `if (!consolePanel)` guard and `onDispose → consolePanel = null` untouched. If the executor finds the wiring already correct (it is not — `commandOpenConsole` currently passes only `globalState`), it may close as not-needed after recording evidence, per the ARP-04-004/ARP-05-004 precedent.

**Rejected alternatives.** (1) Persisting full console state including results — rejected: results are out of scope and a privacy/byte risk. (2) Webview `localStorage` — rejected: webview storage is not durable across a VS Code reload and is not workspace-scoped. (3) `postState()` on every `updateBuffer` — rejected: render loop; the existing silent `setBuffer` is exactly the seam we keep. (4) `globalState` for drafts — rejected: roadmap says workspace-scoped; `globalState` would leak drafts across unrelated projects. (5) Auto-replay of restored drafts — rejected: roadmap "Out". (6) A dedicated `draftsCleared` host→webview message — rejected as redundant (reuse `state`, see above).

## §4 Test Plan

Every row below lands in exactly one task's `§Test Cases`. Edge cases are of genuinely different kinds (malformed / boundary / concurrent / privacy / durability), not near-duplicates.

| # | Task | Type | Test name | Expected |
|---|------|------|-----------|----------|
| 1 | 001 | happy | encode→parse round-trip of a valid 2-tab snapshot | parsed object deep-equals the input; `version === 1`; keys are exactly `{version, tabs, activeTabId}` |
| 2 | 001 | edge (malformed) | `parse("not-json")` / `parse("42")` / `parse(undefined)` / `parse(null)` | `null` |
| 3 | 001 | edge (version) | `parse(JSON.stringify({version: 2, ...}))` and missing `version` | `null` |
| 4 | 001 | edge (shape) | tab with non-string `id`/`name`/`buffer`; `tabs` not an array; `activeTabId` not a string | `null` |
| 5 | 001 | edge (boundary over-cap) | 21 tabs; or one tab with a 64_001-char buffer | `null` (fail-closed, cap constants exported and asserted = 20 / 64_000) |
| 6 | 001 | edge (active-tab integrity) | valid tabs but `activeTabId` matches no tab id | `null` |
| 7 | 001 | edge (forward-compat) | valid snapshot with an unknown extra field | parsed to a clean object WITHOUT the extra field (tolerated-and-stripped); re-encode omits it |
| 8 | 001 | happy (wire) | `isConsoleToHostMessage({ type: "clearDrafts" })` | `true` |
| 9 | 001 | edge (wire) | `{ type: "clearDrafts", junk: 42 }` still `true` (type-only); unknown `{ type: "clearDraft" }` is `false` | `true` / `false` |
| 10 | 002 | happy | type in a tab → advance 500ms fake timer | `draftMemento.get(CONSOLE_DRAFTS_KEY)` holds a string that `parse` accepts with the typed buffer |
| 11 | 002 | happy | new `ConsolePanel` over the same `draftMemento` (reopen) | tabs ids/buffers and `activeTabId` restored identically |
| 12 | 002 | edge (corrupt) | `draftMemento` holds garbage at `CONSOLE_DRAFTS_KEY` | exactly one fresh empty `Query 1` tab; constructor never throws |
| 13 | 002 | edge (one/two-tab) | reopen restores a 1-tab and a 2-tab snapshot | correct ids/names/buffers/active in both |
| 14 | 002 | edge (never-runs) | persist, reopen, drive restore | `onRun` spy called **zero** times (restore never executes SQL) |
| 15 | 002 | edge (concurrent flush-once) | `dispose()` then re-`dispose()` (or `onDidDispose` after `dispose`) | `draftMemento.update(CONSOLE_DRAFTS_KEY, …)` called exactly once for a single dirty flush |
| 16 | 002 | edge (privacy) | parse the persisted payload after a realistic multi-tab session | exact key set is `{version, tabs, activeTabId}`; each tab exactly `{id, name, buffer}`; NO results/history/password/connection fields |
| 17 | 002 | edge (durable clear) | clear → assert key removed → reopen | memento key `undefined`; one empty `Query 1` tab; old draft cannot be resurrected |
| 18 | 002 | edge (boundary clamp at persist) | 21 tabs and a 70k-char buffer live in host state | persisted snapshot has exactly 20 tabs and buffers sliced to 64k; `activeTabId` remapped into the survivors |
| 19 | 002 | regression | updateBuffer arrives for a non-existent tabId | silent no-op; no crash; no persist |
| 20 | 002 | edge (fallback) | `draftMemento` omitted | hydrate no-ops (in-memory-only), persist no-ops, no throw |
| 21 | 002 | edge (debounce reset) | three rapid `updateBuffer`s then one dispose | exactly ONE persist on dispose carrying the last buffer (latest-wins) |
| 22 | 003 | happy | dispatch `input` on the editor with `"SELECT 1"` → advance 500ms | `{ type: "updateBuffer", tabId, buffer: "SELECT 1" }` posted (debounced) |
| 23 | 003 | happy | click the new Clear button | `{ type: "clearDrafts" }` posted; textarea cleared; no confirm dialog surfaced |
| 24 | 003 | edge (restore pre-input) | push `state` with a non-empty tab buffer | textarea value === restored buffer on render |
| 25 | 003 | edge (latest-wins) | three rapid `input`s under one debounce window | exactly ONE `updateBuffer` with the FINAL buffer |
| 26 | 003 | edge (flush-on-unload) | type, then dispatch `beforeunload` | pending `updateBuffer` posted immediately (no 500ms wait) |
| 27 | 003 | edge (flush-on-hidden) | type, set `document.visibilityState = "hidden"` + dispatch `visibilitychange` | pending `updateBuffer` posted immediately (note jsdom fallback in Discussion) |
| 28 | 003 | regression (divergence) | type in A, click tab B within the debounce window | `updateBuffer`(A) is posted BEFORE `switchTab`(B) — host buffers never stale |
| 29 | 003 | edge (clear cannot resurrect) | type, click Clear, advance timers | no `updateBuffer` carries the pre-clear text; `clearDrafts` posted; textarea empty |
| 30 | 003 | edge (no postState loop) | host receives `updateBuffer` (pinned in `consoleTabs.test.ts`) | host does NOT `postMessage` a `state` in reply (silent `setBuffer`) |
| 31 | 004 | happy | activate → invoke `vsdb.openConsole` | `ConsolePanel` constructed with `draftMemento === context.workspaceState` (asserted via the spy on the created panel / constructor options) |
| 32 | 004 | happy | invoke `vsdb.openConsole` twice | exactly ONE `createWebviewPanel` call — singleton retained |
| 33 | 004 | edge (history scope) | run a statement → history persists via `globalState`, drafts via `workspaceState` | `ctx.globalState.update` receives `CONSOLE_HISTORY_KEY`; `ctx.workspaceState.get` receives `CONSOLE_DRAFTS_KEY`; the two keys never cross |
| 34 | 004 | edge (teardown) | deactivate after open | `consolePanel` disposed (module singleton nulled) — deactivate still tears down |

## §5 Verification

Focused per-task (exact commands are also in each task file):

```bash
# 001 (pure codec + guards)
npx vitest run src/ui/__tests__/consolePanelMessages.test.ts
npm run typecheck

# 002 (host restore; the memento harness is in consolePanel.test.ts)
npx vitest run src/ui/__tests__/consolePanel.test.ts
npm run typecheck

# 003 (webview bundle — REQUIRES dist/consolePanel.js, so compile FIRST)
npm run compile
npx vitest run src/ui/__tests__/consolePanelBundle.test.ts src/ui/__tests__/consoleTabs.test.ts
npm run typecheck

# 004 (extension wiring)
npx vitest run src/extension.test.ts
npm run typecheck
```

**Worktree note (fresh `git worktree` executors):** bundle tests read `dist/consolePanel.js`, which does not exist in a fresh worktree — run `npm run compile` BEFORE `npx vitest run src/ui/__tests__/consolePanelBundle.test.ts`, and symlink `node_modules` into the worktree (or `npm ci`) or the vitest run fails on imports. 002's debounce/flush tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime(500)` and must NOT use the file's `until()` helper (which awaits a real `setTimeout`); the existing `afterEach(() => vi.useRealTimers())` already covers teardown.

Wave/cycle regression net (release gate — NOT the per-task default): `npm run verify:release` (`npm test && npm run typecheck && npm run compile`) plus `npx vitest run src/__tests__/releaseHygiene.test.ts src/__tests__/releaseVerify.test.ts`. Baseline: 3120 passed | 2 skipped.

## §6 Acceptance

- [ ] Close/reopen/reload restores bounded drafts (same tab ids, buffers, active tab) and NEVER runs SQL (§4 #11-#14 → TASK-ARP08-002).
- [ ] Corrupt/over-cap persisted state fails closed to one empty `Query 1` tab without throwing (§4 #12, #5 → 001/002).
- [ ] Clear is durable: after `Clear drafts`, the key is removed and reopening shows empty; the old draft cannot be resurrected (§4 #17, #29 → 002/003).
- [ ] Debounced flush + exactly-once flush-on-dispose persist the latest buffer; host `updateBuffer` handling stays silent (no render loop) and the switch-away/back divergence is fixed and regression-pinned (§4 #10,#15,#21,#28,#30 → 002/003).
- [ ] Privacy review passes: persisted payload key set is exactly `{version, tabs, activeTabId}` with tabs `{id, name, buffer}` — no results/passwords/secrets/connection data/history (§4 #16 → 002; roadmap acceptance box).
- [ ] Workspace-scoped wiring: `draftMemento = context.workspaceState`; history remains `globalState`; singleton + deactivate guarantees retained (§4 #31-#34 → 004).
- [ ] Bundle compilation verified: `consolePanelBundle.test.ts` green after `npm run compile`; focused console tests, typecheck, compile, and full suite all pass (§5).
- [ ] ARP-02 deactivation sentinel and AIC-004 ghost-text seams preserved byte-untouched in `consolePanel.ts`; no changes to `schemaCache`/`resultsPanel`/`aiChatPanel`/adapters.
- [ ] Manual (release-time, post-cycle): write multi-tab drafts → close/reload/reopen/clear → verify no execution and capped history.

## §7 Global Constraints

- Node v22 / `npm`; VS Code `^1.75.0` and TypeScript 5.4 compatibility; no new dependencies (package.json untouched).
- No lint script — every task MUST run `npm run typecheck`; bundle-touching tasks MUST also run `npm run compile`.
- Draft payload NEVER contains results, passwords, transaction state, connection data, or history — pinned by the exact-key-set assertion (§4 #16).
- Snapshot is versioned (`version: 1`), fail-closed on parse, deterministically capped (20 tabs / 64k buffer per tab — exported constants, asserted in tests).
- Drafts are workspace-scoped (`context.workspaceState`); history stays `globalState` under `CONSOLE_HISTORY_KEY` (unchanged).
- Restore NEVER invokes `onRun`; no automatic replay, no file writes, no cross-machine sync.
- ARP-02 deactivation sentinel and AIC-004 ghost-text seams in `consolePanel.ts` must remain byte-identical in behavior (additive lines only).
- Wave disjointness is mandatory: no task modifies a file another same-wave task owns (§2).

## Planner Report
PLAN_REVIEW: Approved by unic-smart (round 1, minors applied)
PLANNER_MODEL: unic-smart

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit: (1) Corrected the roadmap's stale extension.ts citations to the real singleton/wiring (`extension.ts:99,753-754,1584-1633,1067-1068`) and consolePanel constructor/hydrate lines (`143-145,310-318`). (2) Pinned parse rejects over-cap and persist clamps (both deterministic), so the codec never emits a snapshot its own parse would reject. (3) Chose tolerated-and-stripped for unknown extra fields and recorded the reasoning. (4) Chose "reuse `state`" over a new `draftsCleared` message and recorded the rejection. (5) Added the flush-before-`switchTab`/`closeTab` webview behavior + host "updateBuffer silent" pin as the concrete divergence fix, so the §4 regression rows test a real behavior (not an empty implementation). (6) Made 004 a real wiring task (evidence: `commandOpenConsole` currently passes only `globalState`; nothing passes `draftMemento`), with the not-needed escape documented for the executor. (7) Confirmed the debounce test harness constraint (fake timers, never the `until()` helper) so the executor's first test run cannot deadlock.
Known gaps: (1) The 500ms debounce window means an abrupt webview kill can lose the last ~500ms of keystrokes that never reached the host — inherent to postMessage (the webview cannot post after death); `visibilitychange→hidden`/`beforeunload`/dispose flush narrows it. Acceptable per design. (2) `document.visibilityState` is read-only in jsdom; the §4 #27 visibilitychange test may need `Object.defineProperty` or a jsdom config override — if it cannot be driven, the executor falls back to the beforeunload flush test (#26) and records the limitation in the task Discussion (the flush function is shared, so beforeunload coverage exercises the same code). (3) Manual acceptance (multi-tab close/reload/reopen/clear) is release-time and cannot be automated here.

## Plan Review Log

### Round 1 — Approved by unic-smart (P2.5 independent review)
Status: Approved. Two non-blocking citation minors (consolePanelBundle.test.ts loadBundle helper 29-48 → 22-40; consoleTabs.test.ts FakeMemento span) — applied directly to TASK-ARP08-002/-003 without re-review per loop policy.


### Round 1 — 2026-09-02 · unic-smart
Status: Approved

COMPLETENESS:
  - none — §1-§7 all present; §4 has 34 rows covering every task with happy + ≥2 distinct edge kinds (malformed/version/shape/boundary/active-tab/forward-compat/privacy/durability/concurrent) + regression pins; every task file carries its own Test Cases / Test Files / Verification Commands / Acceptance / Dependencies / Interfaces.
CONSISTENCY:
  - none — task Target Files match §2 scope exactly (001 owns `consolePanelMessages.ts`+test, 002 owns `consolePanel.ts`+test, 003 owns webview+bundle+`consoleTabs.test.ts`, 004 owns `extension.ts`+test in wave 3); waves match Dependencies (001→002/003→004); wave 2 files are disjoint; INDEX.md graph/waves/ownership and ACTIVE.md `planning_done` match. The roadmap's wave-1 pairing of 08.1+08.2 is correctly re-sequenced (08.2 imports 08.1's codec — cannot share a wave) and documented.
CLARITY:
  - TASK-ARP08-003: `loadBundle` helper cited at `consolePanelBundle.test.ts:29-48`, actual definition is lines 22-40 (~7-line drift). Cosmetic — executor will find the helper by name.
  - TASK-ARP08-002: `FakeMemento` described as "the 8-line class from `consoleTabs.test.ts:21-30`", actual class spans lines 21-29 (9 lines). Cosmetic.
SCOPE:
  - none — Out set matches roadmap (results/passwords/transaction state/cross-machine sync/unlimited persistence/file writes/automatic replay); rejected alternatives documented; no gold-plating.
YAGNI:
  - none — `draftsCleared` message correctly rejected (state round-trip suffices); localStorage/globalState/postState-on-every-updateBuffer correctly rejected.

NOTES: All load-bearing citations verified against HEAD @ 8dca6d2: `consolePanel.ts:143-145,177-187,190-204,231-234,310-318,401-403`; `extension.ts:99,753-754,1067-1068,1584-1633`; `webview/consolePanelMain.ts:65-95,106-110,157-160,327-341`; harness anchors `consolePanel.test.ts:96-117`, `consoleTabs.test.ts:21-30,110-126`, `extension.test.ts:272-300,2081-2120`, `consolePanelBundle.test.ts:22-40`; bundle tests read `dist/consolePanel.js` (compile-first worktree note is required and present); `isConsoleToHostMessage` has no default case so an early-arriving `clearDrafts` in wave 2 silently no-ops (benign intra-wave ordering). 003's Clear-drafts resets only the active tab's dirty flag, leaving background dirty-set entries inert — harmless because host `setBuffer` no-ops on dropped tab ids and `flushPending` guards tab existence; optionally clear the whole dirty set for hygiene. Verification commands are runnable as written (`npm run compile` precedes the 003 vitest run; fake-timer constraint and jsdom `visibilityState` fallback documented). No plan-blocking issues found.
