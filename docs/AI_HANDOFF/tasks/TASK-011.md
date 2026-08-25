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

---
