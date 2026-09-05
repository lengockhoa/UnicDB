# TASK-011 — Zero-config omp engine, honest engine banner, settings error label, keyword-cache wiring

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.7 (B3, B8, B13) + §3.9 (D1 caller) — §7 Global Constraints applies by reference

## Goal

Deliver locked decision #2: **omp is the default AI engine and opening chat requires no
configuration.**

- **B3** — `commandOpenAiChat` (`src/extension.ts:387-394`) returns early unless
  `aiStore.loadConfig()` is non-null (baseUrl + method + non-empty modelId for *both* roles + a
  stored apiKey) and pushes the user to AI settings. The omp engine needs none of that. Replace
  the gate: `detectOmp()` ok ⇒ open on omp with zero config; otherwise fall back to the builtin
  provider, and only then require a config.
- **B8** — the banner is decided by `this.options.acp === undefined` (`aiChatPanel.ts:394-402`),
  which `extension.ts:400` **always** supplies, so it always claims "Engine: oh-my-pi (omp) —
  streaming" even when omp is absent or too old. `detectOmp()` (`detect.ts:67`, floor 17.0.0) is
  never called in production and `OMP_INSTALL_HINT` / the `engine.hint` field
  (`aiChatPanelMessages.ts:62`) are dead code. And when ACP fails over to builtin
  (`aiChatPanel.ts:552`) no new `engine` message is posted, so the banner never self-corrects.
  Wire detection for real, surface the hint, re-post on failover, render the hint in the webview.
- **B13** — `aiSettingsForm.ts:130-143` reports save errors as `testResult`, so a failed **save**
  renders as "test failed".
- **D1 caller** — hoist one `KeywordTableCache` (TASK-008) across the per-statement
  `qualifyKeywordTables` loop at `extension.ts:479-484` instead of paying per statement.

## Target Files

- `src/extension.ts`
- `src/ai/engineChoice.ts` (new — pure, testable engine resolution)
- `src/ui/aiChatPanel.ts`
- `src/ui/aiChatPanelMessages.ts` (**`AiChatPanelEngine` today has only `type` / `name` / `hint`
  — there is NO `version` field**; this task adds `version?: string` and widens `name` if the
  banner needs it. Owned by no other task in any wave.)
- `webview/aiChatPanelMain.ts`
- `src/ui/aiSettingsForm.ts`
- `src/ai/__tests__/engineChoice.test.ts` (new)
- `src/ui/__tests__/aiChatPanelMessages.test.ts`
- `src/ui/__tests__/aiChatPanel.test.ts`
- `src/ui/__tests__/aiSettingsForm.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | omp present, no config | `resolveEngine({detection:{available:true,ok:true,path:"/usr/bin/omp",version:"18.0.1"}, config:null})` → `{engine:"omp", requiresConfig:false}`; panel opens |
| Happy | banner text | panel posts `engine {name:"omp", version:"18.0.1"}` once on show |
| Edge (missing binary) | omp absent, no config | `{engine:"builtin", requiresConfig:true, hint:OMP_INSTALL_HINT}`; AI settings opened; hint rendered in the webview |
| Edge (version floor) | omp 16.0.0 | `ok:false`, `reason:"version-too-old"` ⇒ builtin engine, banner says builtin, `OMP_UPDATE_HINT` surfaced |
| Edge (failover) | ACP start fails after the panel is showing | a **second** `engine` message posted with `name:"builtin"`; banner updates |
| Edge (both available) | omp ok **and** a full config present | omp wins (locked decision #2), config untouched |
| Edge (error labelling) | settings save throws | webview receives a `saveResult`-style error, **not** `testResult` |
| Edge (cache scope) | run a 20-statement script | `listTables` called at most once for the whole run |
| R (B3) | no stored API key, omp present | today: early return + "Configure AI settings first." |
| R (B8) | omp absent | today the banner still claims omp |
| R (B13) | save failure | today rendered as "test failed" |
| R (D1 caller) | 20-statement script | today up to 20 catalog scans |

## Test Files

- `src/ai/__tests__/engineChoice.test.ts` (new — pure `resolveEngine` matrix: detection × config)
- `src/ui/__tests__/aiChatPanel.test.ts` (extend — banner posted on show, re-posted on failover, hint field populated)
- `src/ui/__tests__/aiChatPanelMessages.test.ts` (extend — `version` field round-trips on the
  `engine` message)
- `src/ui/__tests__/aiSettingsForm.test.ts` (extend — save-vs-test error channel)

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test -- src/ai/__tests__/engineChoice.test.ts
npm test -- src/ui/__tests__/aiChatPanel.test.ts
npm test -- src/ui/__tests__/aiChatPanelMessages.test.ts
npm test -- src/ui/__tests__/aiChatPanelWebview.test.ts
npm test -- src/ui/__tests__/aiSettingsForm.test.ts
npm test -- src/ui/__tests__/aiSettingsFormBundle.test.ts
npm test -- src/ai/omp/__tests__/detect.test.ts
npm test -- src/core/__tests__/keywordQualify.test.ts
```

## Acceptance Criteria

- [ ] All 12 cases pass; each regression case confirmed failing on `main` first (output in report).
- [ ] Opening AI chat with **no** AI configuration and `omp` on PATH shows the chat panel — no
      "Configure AI settings first." interstitial. Verified manually and asserted through
      `resolveEngine`.
- [ ] Engine resolution lives in the pure, exported `resolveEngine(...)` — `commandOpenAiChat`
      contains no engine policy of its own, so the policy is unit-testable without `vscode`.
- [ ] `detectOmp()` is called on a real code path (grep shows a non-test caller) and its result
      drives both the engine choice and the banner.
- [ ] `engine.hint` is populated and **rendered** by `webview/aiChatPanelMain.ts` (dead field is
      now live); `OMP_INSTALL_HINT` appears when omp is missing, `OMP_UPDATE_HINT` when too old.
- [ ] `AiChatPanelEngine` gains `version?: string` (it does not exist on `main`) and the banner
      renders it; absent `version` must not print `undefined`.
- [ ] The banner self-corrects: the ACP→builtin failover at `aiChatPanel.ts:552` posts a fresh
      `engine` message.
- [ ] `detectOmp` runs at most once per panel show (cached) — a `which`/`where` per turn is a
      regression.
- [ ] Settings save errors use a save channel, not `testResult`.
- [ ] One `createKeywordTableCache()` per `runQueryFromEditor` run, passed into every
      `qualifyKeywordTables` call in that run.
- [ ] `npm run typecheck` clean; `npm run compile` succeeds.

## Dependencies

- TASK-006 (`detectOmp` must be platform-correct and non-throwing before it becomes load-bearing)
- TASK-007 (owns `aiChatPanel.ts` in wave 1; the turn must settle before the banner is meaningful)
- TASK-008 (`createKeywordTableCache` / the `opts.cache` parameter must exist)

## Interfaces

- Consumes:

```ts
// TASK-006 — src/ai/omp/detect.ts
export const MIN_OMP_VERSION = "17.0.0";
export const OMP_INSTALL_HINT = "curl -fsSL https://omp.sh/install | sh";
export const OMP_UPDATE_HINT = "omp update";
export interface OmpDetection { available: boolean; ok: boolean; path?: string; version?: string; reason?: string; }
export async function detectOmp(execFn?: ExecFn): Promise<OmpDetection>;

// TASK-008 — src/core/keywordQualify.ts
export function createKeywordTableCache(ttlMs?: number, now?: () => number): KeywordTableCache;
export async function qualifyKeywordTables(
  sql: string,
  listTables: (schema: string) => Promise<string[]>,
  opts?: { cache?: KeywordTableCache },
): Promise<QualifyResult>;

// TASK-007 — src/ui/aiChatPanel.ts
export type EngineKind = "builtin" | "omp";
```

- Produces:

```ts
// src/ui/aiChatPanelMessages.ts:58-63 — TODAY, verbatim:
//   export interface AiChatPanelEngine {
//     type: "engine";
//     name: "omp" | "builtin";
//     hint?: string;          // already declared, never populated (dead)
//   }
// This task ADDS one field (there is no `version` today — do not assume it exists):
export interface AiChatPanelEngine {
  type: "engine";
  name: "omp" | "builtin";
  hint?: string;
  /** NEW (B8): detected omp version for the banner, e.g. "18.0.1". Absent for builtin. */
  version?: string;
}

// src/ai/engineChoice.ts (new) — NO vscode import, pure
export interface EngineChoice {
  engine: "omp" | "builtin";
  requiresConfig: boolean;   // true ⇒ caller must have a valid AI config or route to settings
  hint?: string;             // OMP_INSTALL_HINT | OMP_UPDATE_HINT
  version?: string;
}
export function resolveEngine(input: {
  detection: OmpDetection;
  config: unknown | null;    // result of AiConfigStore.loadConfig()
}): EngineChoice;
```

Consumed by TASK-012 (which needs to know the omp path is live before wiring MCP tools).

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

**Why the new `src/ai/engineChoice.ts`:** `commandOpenAiChat` is a non-exported function inside
`src/extension.ts`, which imports `vscode` at module scope, so the gate cannot be unit-tested
where it currently lives. Extracting the *policy* (a pure function over detection + config) is the
smallest change that makes B3 verifiable rather than "we looked at it". The `vscode`-dependent
parts (showing the panel, opening settings) stay in `extension.ts` and are covered manually.

**Ordering note for the reviewer:** this task edits `src/ui/aiChatPanel.ts`, which TASK-007 owns
in wave 1. That is intentional and legal — different waves. Rebase on TASK-007's landed version;
do not re-fix its defects here, and do not revert its turn-lifecycle changes.

**Locked decision #2 is not negotiable:** when both omp and a full OpenAI config are available,
omp wins. If that feels wrong during implementation, record the objection here rather than
changing the behavior.

### 2026-08-25 · executor · claude-sonnet-5

**Scope decision — two sibling files not in the Target Files list:** `src/ui/aiSettingsFormMessages.ts`
and `webview/aiSettingsFormMain.ts`. B13 requires the webview to render the new `saveResult` error
channel distinctly from `testResult`; without touching the message-type file and its webview
consumer, the fix in `aiSettingsForm.ts` would post a `saveResult` message that the webview drops
silently (no `case "saveResult"` in its switch), which is not "fixed" in any user-visible sense.
This mirrors why `aiChatPanelMessages.ts` + `webview/aiChatPanelMain.ts` are explicitly named for
B8 — same shape of problem, so the same two-file pattern applies for B13's sibling pair. No other
out-of-scope files were touched (confirmed `resultsPanel.ts` / `schemaTree.ts` untouched via `git
status`).

---

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: claude-sonnet-5
- EXECUTOR_SUBAGENT: -
- STATUS: DONE

### SUMMARY

Implemented all four defects (B3, B8, B13, D1). `commandOpenAiChat` now resolves the engine via a
new pure `resolveEngine()` policy fed by a real `detectOmp()` call, so omp-present + zero-config
opens the chat panel directly (locked decision #2). The engine banner is wired to real detection
(`version`/`hint` fields) and re-posts on ACP→builtin failover. `aiSettingsForm.ts` reports save
failures (validation, empty-key-nothing-stored, and `store.save()` throwing) through a new
`saveResult` channel instead of `testResult`, rendered distinctly by the webview. `applyKeywordQualify`
now hoists one `createKeywordTableCache()` per run instead of creating a fresh cache-less lookup per
statement.

### TEST_PLAN_FOLLOWED

Task §Test Cases (12-row table) — all 12 covered. RED confirmed for every new/changed assertion via
either `git show HEAD:<path> > <path>` reverts (behavioral changes) or `tsc --noEmit` (pure
interface-shape additions that esbuild's non-typechecking transform can't fail on — confirmed this
empirically for the `AiChatPanelEngine.version` field; documented below).

### FILES_CHANGED

- `src/extension.ts`: B3 — `commandOpenAiChat` now calls `detectOmp()` + `resolveEngine()` before
  deciding on the config interstitial; only routes to AI Settings when `choice.requiresConfig`.
  Passes `choice.version`/`choice.hint` into `AiChatPanel`. D1 — `applyKeywordQualify` hoists one
  `createKeywordTableCache()` per `runStatements()` call, passed into every `qualifyKeywordTables`
  call in that run instead of one cache-less lookup per statement.
- `src/ai/engineChoice.ts` (new): pure `resolveEngine({detection, config})` policy — no `vscode`
  import. omp `ok:true` ⇒ `{engine:"omp", requiresConfig:false, version}`; else `{engine:"builtin",
  requiresConfig: config == null, hint: OMP_INSTALL_HINT|OMP_UPDATE_HINT}`.
- `src/ui/aiChatPanel.ts`: B8 — new `postEngine(name)` private helper centralizes the `engine`
  message (adds `version` for omp / `hint` for builtin from the new `AiChatPanelOptions.engineVersion`
  / `.engineHint` fields); `handleReady()` uses it; the ACP `ensureAcpSession()` failover catch block
  now calls `postEngine("builtin")` so the banner self-corrects.
- `src/ui/aiChatPanelMessages.ts`: `AiChatPanelEngine` gains `version?: string`.
- `webview/aiChatPanelMain.ts`: `EngineMsg` gains `version?: string`; banner label renders
  `"Engine: oh-my-pi (omp) v<version> — streaming"` when present, unchanged fallback otherwise.
- `src/ui/aiSettingsForm.ts`: B13 — `handleSave()` posts `{type:"saveResult", ok:false, error}` for
  validation failure and empty-key-nothing-stored, and wraps `store.save()` in try/catch posting the
  same channel on rejection (previously an unhandled rejection with no user feedback at all).
- `src/ui/aiSettingsFormMessages.ts` (sibling, see Discussion above): adds `AiSettingsFormSaveResult`
  and widens `AiSettingsFormHostMessage`.
- `webview/aiSettingsFormMain.ts` (sibling, see Discussion above): adds `SaveResultMsg` + a
  `case "saveResult"` branch that renders the error via the existing `setStatus(false, ...)`.

### TESTS_ADDED

- `src/ai/__tests__/engineChoice.test.ts` (new, 6 tests): Happy (omp ok, no config), edge missing
  binary (`OMP_INSTALL_HINT`), edge version floor (`OMP_UPDATE_HINT`), edge both-available
  (omp wins, config untouched), builtin+valid-config (`requiresConfig:false`), `config===undefined`
  treated like `null`.
- `src/ui/__tests__/aiChatPanel.test.ts` (extended, pre-existing from earlier in this session): `#5`
  banner posts `version` on show, `#5b` `hint` populated for builtin, `#5c` failover re-posts a
  second `engine{name:"builtin"}` message.
- `src/ui/__tests__/aiChatPanelMessages.test.ts` (extended, 3 tests, `describe("... B8: version
  field)")`): `version` field round-trips through the `AiChatPanelEngine` shape.
- `src/ui/__tests__/aiChatPanelWebview.test.ts` (+1, `#5d`): banner renders
  `"Engine: oh-my-pi (omp) v18.0.1 — streaming"` when `version` is present.
- `src/ui/__tests__/aiSettingsForm.test.ts` (+3, now 12 total): validation-failure and
  empty-key-nothing-stored rewritten to assert `saveResult` (not `testResult`) + a regression guard
  that `testResult` was never posted; new test for `store.save()` throwing → `saveResult{ok:false}`.
- `src/ui/__tests__/aiSettingsFormBundle.test.ts` (+1, `#12`): dispatches `saveResult{ok:false,
  error:"disk full"}` into the compiled webview bundle, asserts `#status` renders the error text
  with an `err` class.
- `src/extension.test.ts`: added a file-wide hoisted `detectOmp` mock (default `not-installed`,
  reset in a top-level `beforeEach`) so the ~50 pre-existing `UnicDB.aiChat`-invoking tests stay
  deterministic now that `commandOpenAiChat` shells out for real. Added
  `describe("TASK-011 (B3) — commandOpenAiChat resolves engine via detectOmp() + resolveEngine()")`
  (Happy: omp ok + no config → panel constructed with `engineVersion`, no interstitial;
  R(B3): omp not-installed + no config → interstitial unchanged) with an `afterEach(() =>
  deactivate())` to reset the module-level `aiChatPanel` singleton between the two tests (needed
  because the file statically imports `extension.ts` once — without the reset the second test's
  `if (aiChatPanel) { show(); return; }` guard short-circuits before ever calling `detectOmp()`).
  Added `#3 D1` test in the existing `describe("TASK-007 — runStatement rewrites reserved-keyword
  tables...")` block: a 2-statement `UnicDB.runQuery` selection-mode run asserts `listTables` is
  called exactly once, not once per statement.

### RED_OUTPUT (representative excerpts — full reverts done via `git show HEAD:<path> > <path>`,
restored via `cp` from `/tmp/task011-green-backup/` after capture)

**B3/D1 — `src/extension.ts` reverted to HEAD, `npx vitest run src/extension.test.ts`:**
```
❯ TASK-011 (B3) ... Happy — omp detected + ok, NO ai config saved → panel opens directly, no config interstitial
  AssertionError: expected "spy" to not be called at all, but actually been called 1 times
  Received: 1st spy call: [ "UnicDB: Configure AI settings first." ]

❯ TASK-007 ... #3 D1: multi-statement run reuses ONE cache — listTables called once (not once per statement)
  AssertionError: expected "spy" to be called 1 times, but got 2 times

Test Files  1 failed (1)
     Tests  2 failed | 54 passed (56)
```

**B8 (aiChatPanel.ts banner + failover) — captured earlier in this session by reverting
`src/ui/aiChatPanel.ts` to HEAD:** 3 failures in `aiChatPanel.test.ts` (`#5` missing `version` on
the posted engine message, `#5b` missing `hint`, `#5c` no second `engine` post on ACP failover) —
33/33 restored to GREEN after `cp` back.

**B8 (webview version rendering) — `webview/aiChatPanelMain.ts` reverted to HEAD, `npm test --
src/ui/__tests__/aiChatPanelWebview.test.ts`:**
```
❯ #5d B8 omp with version: banner text reads "Engine: oh-my-pi (omp) v18.0.1 — streaming"
  AssertionError: expected 'Engine: oh-my-pi (omp) — streaming' to be 'Engine: oh-my-pi (omp) v18.0.1 — stre…'
  - Engine: oh-my-pi (omp) v18.0.1 — streaming
  + Engine: oh-my-pi (omp) — streaming

Tests  1 failed | 26 passed (27)
```

**B8 (`AiChatPanelEngine.version` interface field) — `src/ui/aiChatPanelMessages.ts` reverted to
HEAD:** `vitest run` on the reverted state still showed 18/18 passing (esbuild's TS transform does
not typecheck — an extra property on an object literal is runtime-valid regardless of the declared
interface). RED evidence instead comes from `npx tsc --noEmit -p .`:
```
src/ui/aiChatPanel.ts(1263,11): error TS2339: Property 'version' does not exist on type 'AiChatPanelEngine'.
```

**B13 — `src/ui/aiSettingsForm.ts` reverted to HEAD, `npm test -- src/ui/__tests__/aiSettingsForm.test.ts`:**
3 failures: 2× `expected true to be false` (save-failure paths still posting through `testResult`),
1× `TypeError: Cannot read properties of undefined (reading 'ok')` plus an unhandled rejection
`"disk full"` for the `store.save()`-throws case. Restored to GREEN: 12/12 pass.

**B13 (webview `saveResult` rendering) — `webview/aiSettingsFormMain.ts` reverted to HEAD +
`npm run compile`, `npm test -- src/ui/__tests__/aiSettingsFormBundle.test.ts`:**
```
❯ #12 B13: host posts saveResult{ok:false} → status shows the save error, distinct from testResult
  AssertionError: expected '' to be 'disk full'

Tests  1 failed | 4 passed (5)
```

**B3 pure policy — `src/ai/engineChoice.ts` did not exist on HEAD:** importing it in
`engineChoice.test.ts` failed module resolution before any assertion ran (module-not-found RED).
After creation: 6/6 pass.

### VERIFICATION (all commands run fresh this turn, in order, after every RED revert was restored)

```
command: npm run typecheck
result: exit 0, clean (no output beyond the npm script banner)

command: npm run compile
result: exit 0 — dist/aiSettingsForm.js, dist/schemaForm.js, dist/connectionForm.js,
        dist/aiChatPanel.js, dist/newTableForm.js, dist/extension.js, dist/webview.js all emitted

command: npm test -- src/ai/__tests__/engineChoice.test.ts
result: 6 passed (6)

command: npm test -- src/ui/__tests__/aiChatPanel.test.ts
result: 33 passed (33)

command: npm test -- src/ui/__tests__/aiChatPanelMessages.test.ts
result: 18 passed (18)

command: npm test -- src/ui/__tests__/aiChatPanelWebview.test.ts
result: 27 passed (27)

command: npm test -- src/ui/__tests__/aiSettingsForm.test.ts
result: 12 passed (12)

command: npm test -- src/ui/__tests__/aiSettingsFormBundle.test.ts
result: 5 passed (5)

command: npm test -- src/ai/omp/__tests__/detect.test.ts
result: 14 passed (14)

command: npm test -- src/core/__tests__/keywordQualify.test.ts
result: 27 passed (27)
```

**Full-suite regression check (not one of the 9 listed commands, run as an additional safety net
given the module-singleton risk in `extension.test.ts`):**
```
command: npm run typecheck && npm test
result: typecheck clean; Test Files 85 passed | 1 skipped (86); Tests 1176 passed | 2 skipped (1178)
        — 0 failures, same 2 pre-existing skips as the wave-1 baseline (1158 pass/2 skip/84 files);
        delta is entirely new/extended TASK-011 tests.
```

### ISSUES

- `git status --porcelain` confirms `src/ui/resultsPanel.ts` and `src/ui/schemaTree.ts` were never
  touched (TASK-009/TASK-010 boundary respected).
- Live `omp` smoke test was not run per instruction; `detectOmp()` correctness itself is TASK-006's
  contract (consumed here, not re-verified).
- `src/ui/aiSettingsFormMessages.ts` / `webview/aiSettingsFormMain.ts` touched beyond the literal
  Target Files list — justified above under Discussion and re-verified via targeted RED/GREEN.

### HANDOFF_TO_REVIEWER: yes — reason: Handoff mode + STATUS DONE; `handoff.reviewer.enabled` per
`.ukit/storage/config.json` governs whether the next AI session picks this up from
`pending_review`; task status update belongs to `INDEX.md` per the orchestrator's own state
machine, not edited here.

### NEXT: ready for review. Reviewer should confirm the two sibling-file scope additions
(`aiSettingsFormMessages.ts`, `webview/aiSettingsFormMain.ts`) are acceptable, and that the
`extension.test.ts` file-wide `detectOmp` mock does not mask any other test's real-detection
assumptions.

---
