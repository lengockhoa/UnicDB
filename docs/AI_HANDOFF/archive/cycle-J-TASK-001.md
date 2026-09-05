# TASK-001 — AI config storage: pure settings + SecretStorage store (src/ai/settings.ts + src/ai/config.ts)
- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §2,§3,§7

## Goal
Pure settings types/validation + vscode-backed store: baseUrl/method/timeout/maxSteps/2 model
roles in globalState JSON, apiKey in SecretStorage. `loadConfig()` reads both stores fresh
every call (no cache) — the structural guarantee for "reconfigurable, never stale".

## Target Files
- `src/ai/settings.ts` (new) — pure types + validators. NO vscode import (webview-importable).
- `src/ai/config.ts` (new) — `AiConfigStore` (vscode SecretStorage + globalState).
- `src/ai/__tests__/settings.test.ts` (new) · `src/ai/__tests__/config.test.ts` (new)

## Spec — contract (normative, frozen)
```ts
// src/ai/settings.ts
export type AiCompletionMethod = "responses" | "chat/completions";
export type AiModelRole = "work" | "smart";
export interface AiModelConfig { modelId: string; vision: boolean }
export interface AiSettings {
  baseUrl: string;             // e.g. "https://api.openai.com/v1"
  method: AiCompletionMethod;
  timeoutMs: number;           // 1000..600000
  maxSteps: number;            // 1..100 — agent step budget (consumed by TASK-003)
  models: Record<AiModelRole, AiModelConfig>;
}
export interface AiConfig extends AiSettings { apiKey: string }
export function defaultAiSettings(): AiSettings
// → { baseUrl: "https://api.openai.com/v1", method: "chat/completions", timeoutMs: 60000,
//     maxSteps: 12,
//     models: { work: { modelId: "", vision: true }, smart: { modelId: "", vision: false } } }
export function aiSettingsErrors(s: AiSettings): string[]
export function normalizeBaseUrl(url: string): string
export function redactAiConfig(cfg: AiConfig): AiSettings  // strip apiKey only
```
`aiSettingsErrors` messages (exact strings, order-insensitive unless stated):
- `"Base URL is required"` — baseUrl empty/whitespace.
- `"Base URL must start with http:// or https://"` — no http(s) scheme.
- `"Method must be responses or chat/completions"`.
- `"Timeout must be between 1000 and 600000 ms"`.
- `"Max steps must be between 1 and 100"`.
- `"Model is required for role: work"` / `"Model is required for role: smart"` — empty modelId.
- `"models must define both work and smart roles"`.
- `"apiKey must not be stored in settings"` — guard: reject a settings-shaped object that
  carries an `apiKey` field (defense-in-depth; the store saves only the 5 settings fields).
`normalizeBaseUrl`: trim; strip ALL trailing `/` (so `"https://x/v1/"` → `"https://x/v1"`);
returns trimmed input unchanged otherwise (does NOT validate scheme — that's aiSettingsErrors).
```ts
// src/ai/config.ts
import * as vscode from "vscode";
export const KEY_AI_SETTINGS = "UnicDB.ai.settings";
export const KEY_AI_API_KEY = "UnicDB.ai.apiKey";
export class AiConfigStore {
  constructor(ctx: vscode.ExtensionContext)
  loadSettings(): Promise<AiSettings | null>   // null when nothing stored / JSON invalid
  loadApiKey(): Promise<string | undefined>    // SecretStorage get; undefined when absent
  loadConfig(): Promise<AiConfig | null>       // null when EITHER store empty; merge fresh
  save(settings: AiSettings, apiKey: string): Promise<void>
  clear(): Promise<void>                       // delete secret + settings
}
```
`save` ordering (normative): 1) validate `aiSettingsErrors(settings)` → non-empty ⇒ throw
FIRST, persist nothing; 2) `secrets.store(KEY_AI_API_KEY, apiKey)` — if it rejects ⇒ throw,
persist NOTHING (metadata-last mirrors ConnectionManager's never-half-save intent); 3)
`globalState.update(KEY_AI_SETTINGS, JSON of the 5 settings fields only)` (apiKey excluded
by construction). Empty `apiKey` string ⇒ throw `"API key is required"` before touching stores.

## Test Cases (REQUIRED — TDD)
| # | Type | Test name | Expected |
|---|------|----------|----------|
| 1 | unit | defaults exact | `defaultAiSettings()` deep-equals the literal in §Spec |
| 2 | unit | valid → no errors | `aiSettingsErrors(defaultAiSettings() with both modelIds filled) === []` |
| 3 | edge (validation) | invalid settings exact messages | blank baseUrl + `method:"x" as AiCompletionMethod` + timeout 10 + maxSteps 0 + one empty modelId → exactly the 5 matching messages, length 5 |
| 4 | edge (boundary) | bounds inclusive | timeout 1000 & 600000, maxSteps 1 & 100, baseUrl `"http://localhost:8080/v1"` → `[]`; timeout 999/600001, maxSteps 0/101 → messages |
| 5 | edge (security) | apiKey never in settings | `{...valid, apiKey:"sk-x"} as unknown as AiSettings` → includes `"apiKey must not be stored in settings"` |
| 6 | unit | normalizeBaseUrl | `" https://x/v1/ "`→`"https://x/v1"`, `"https://x/v1///"`→`"https://x/v1"`, `"https://x"` unchanged, `""`→`""` |
| 7 | unit | redactAiConfig | returns the 5 settings fields; result has NO `apiKey` key (`Object.keys` excludes it) |
| 8 | unit | save→load round-trip | fake stores; `save(valid, "sk-1")` → `loadConfig()` deep-equals `{...valid, apiKey:"sk-1"}`; secret stored under exactly `"UnicDB.ai.apiKey"`, settings under `"UnicDB.ai.settings"` |
| 9 | edge (validation) | invalid save persists nothing | `save(invalid, "sk-1")` rejects; both fake stores EMPTY afterwards |
| 10 | edge (secret-failure) | SecretStorage.store rejects | fake `store` throws → save rejects; settings NOT in globalState (ordering: secret first, settings last) |
| 11 | edge (state/null) | unconfigured | empty stores → `loadConfig() === null`, `loadSettings() === null`, `loadApiKey() === undefined`; no throw |
| 12 | edge (state) | no stale cache | save(valid,"k1") → loadConfig (apiKey "k1") → secrets.store(key,"k2") → loadConfig apiKey "k2"; corrupt settings JSON (`"{oops"` via raw globalState) → loadSettings `null` |
| 13 | unit | clear | save then clear → both stores empty, loadConfig null |

## Test Files
- `src/ai/__tests__/settings.test.ts` (#1–#7) · `src/ai/__tests__/config.test.ts` (#8–#13)

## Verification Commands
```bash
npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts && npx tsc --noEmit
```
(New files → own test files are the selection. No lint script in this repo; typecheck is `npx tsc --noEmit`.)

## Acceptance Criteria
- [ ] All 13 §Test Cases PASS (RED→GREEN, real output pasted).
- [ ] `src/ai/settings.ts` has ZERO vscode import; `src/ai/config.ts` is the only vscode surface.
- [ ] apiKey appears in no globalState value, no error message, no console/log call.
- [ ] Exports match §Spec contract exactly. Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- (none)

## Interfaces
- Consumes: (none)
- Produces (frozen — TASK-002/003/004 import exactly these):
  - From `src/ai/settings.ts`: `AiCompletionMethod`, `AiModelRole`, `AiModelConfig`, `AiSettings`, `AiConfig`, `defaultAiSettings()`, `aiSettingsErrors(s: AiSettings): string[]`, `normalizeBaseUrl(url: string): string`, `redactAiConfig(cfg: AiConfig): AiSettings`.
  - From `src/ai/config.ts`: `KEY_AI_SETTINGS = "UnicDB.ai.settings"`, `KEY_AI_API_KEY = "UnicDB.ai.apiKey"`, `class AiConfigStore { constructor(ctx: vscode.ExtensionContext); loadSettings(): Promise<AiSettings | null>; loadApiKey(): Promise<string | undefined>; loadConfig(): Promise<AiConfig | null>; save(settings: AiSettings, apiKey: string): Promise<void>; clear(): Promise<void> }`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
Split pure `settings.ts` vs vscode `config.ts` keeps validations unit-testable AND lets the wave-3 form import `aiSettingsErrors` into the webview bundle (no vscode). Note for @executor: tests #10/#12 need a fake `vscode.ExtensionContext` (`{ secrets, globalState }`) — copy the FakeSecretStorage/FakeMemento pattern from `src/core/__tests__/connectionManager.test.ts` (vi.mock('vscode') not needed; pass the fake ctx object directly).

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T001-2 (feature-implementer)

SUMMARY: Implemented pure src/ai/settings.ts (types + validators + redact/normalization helpers, zero vscode import) and vscode-backed src/ai/config.ts (AiConfigStore over SecretStorage apiKey + globalState settings, secrets-first ordering, no cache). 14 tests across 2 files all pass; npx tsc --noEmit exit 0.

TEST_PLAN_FOLLOWED: task Test Cases (13 numbered + 1 supplementary empty-apiKey check = 14 total) — happy paths and ordering/security edges explicitly required by spec.

FILES_CHANGED:
  - src/ai/settings.ts (new): pure types (AiCompletionMethod, AiModelRole, AiModelConfig, AiSettings, AiConfig), defaultAiSettings() literal, aiSettingsErrors() with exact spec messages + defense-in-depth apiKey rejection, normalizeBaseUrl() trim+strip-trail-slasher, redactAiConfig() strips apiKey only.
  - src/ai/config.ts (new): KEY_AI_SETTINGS, KEY_AI_API_KEY, AiConfigStore with loadSettings() (null on missing/invalid), loadApiKey() (undefined on absent/error), loadConfig() (null when either side empty, fresh read every call), save() (validate then empty-key reject then secrets.store FIRST then globalState last with explicit 5-field copy that excludes apiKey by construction), clear() (idempotent).
  - src/ai/__tests__/settings.test.ts (new): tests #1–#7 — defaults literal, no-error-when-valid, exact 5-error invalid case, bounds inclusive/exclusive, defense-in-depth apiKey-in-settings reject, normalizeBaseUrl table, redactAiConfig strips-only-apiKey.
  - src/ai/__tests__/config.test.ts (new): tests #8–#13 — round-trip with apiKey-scrub assertions on globalState, invalid-save-persists-nothing, secret-store-reject-then-no-settings, unconfigured nulls, fresh-read after external secret mutation + corrupt-JSON null, clear empties both stores. Plus supplementary empty-apiKey rejection (Test #9b) for the spec's "Empty apiKey string ⇒ throw" rule.

TESTS_ADDED:
  - src/ai/__tests__/settings.test.ts: Test #1..#7 (7 cases)
  - src/ai/__tests__/config.test.ts: Test #8..#13 + Test #9b (7 cases)

VERIFICATION:
  command: npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts && npx tsc --noEmit
  result: 14 pass / 0 fail, tsc exit 0, shell exit 0
  output_excerpt: |
    ✓ src/ai/__tests__/settings.test.ts  (7 tests) 3ms
    ✓ src/ai/__tests__/config.test.ts    (7 tests) 3ms
    Test Files  2 passed (2)
         Tests  14 passed (14)
    exit=0

RED_OUTPUT (initial — both modules missing, both suites failed to load):
    RUN  v1.6.1 /.../.worktrees/task-001
     ❯ src/ai/__tests__/config.test.ts  (0 test)
     ❯ src/ai/__tests__/settings.test.ts  (0 test)
    Failed Suites 2 (config + settings)
     FAIL  src/ai/__tests__/config.test.ts
    Error: Failed to load url ../config (resolved id: ../config) ... Does the file exist?
     FAIL  src/ai/__tests__/settings.test.ts
    Error: Failed to load url ../settings (resolved id: ../settings) ... Does the file exist?
     Test Files  2 failed (2)
          Tests  no tests

ISSUES: Test file naming — assignment prompt used aiSettings.test.ts/aiConfig.test.ts; task file Spec uses settings.test.ts/config.test.ts. Followed the task-file spec (normative). Spec didn't define an updateSettings method — followed the 5 spec methods (loadSettings/loadApiKey/loadConfig/save/clear). Spec says "JSON of the 5 settings fields" for globalState — implemented as structured object (mirrors UnicDB.connections pattern in ConnectionManager); loadSettings accepts both object and JSON-string forms for robustness.

HANDOFF_TO_REVIEWER: yes — task ready, INDEX row set to pending_review.

NEXT: ready for review (Rev-T001).

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart (config: unic-smart — match)
EXECUTOR_MODEL: unic/unic-code (≠ reviewer — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts && npx tsc --noEmit
  result: 14 pass / 0 fail; tsc exit 0
TEST_PLAN_COVERAGE: all-followed (13 spec cases + #9b empty-apiKey supplement; RED_OUTPUT shows real failed-suite load errors)
FINDINGS:
  critical:
    - none
  important:
    - src/ai/settings.ts:96-98 — models-role entries that exist but are null/non-object (e.g. `models: { work: null, smart: {…} }`) produce ZERO validation errors: guard is `m && typeof m.modelId === "string" && m.modelId.trim() === ""`, so non-string/absent modelId silently passes. Reproduced: aiSettingsErrors → []; then AiConfigStore.save (src/ai/config.ts:101-111) throws `TypeError: Cannot read properties of null (reading 'modelId')` AFTER `secrets.store` succeeded — apiKey persisted, settings not (half-save, violates the normative "validate FIRST ⇒ persist nothing" invariant, and loadSettings re-validation lets the same malformed shape through from a corrupted globalState). Fix: in aiSettingsErrors, for each role require an object with a string modelId — entry missing/non-object/modelId non-string ⇒ push `Model is required for role: <role>`; add edge test `models:{work:null,smart:valid}` → non-empty errors AND save() persists nothing.
  minor:
    - src/ai/config.ts:117-119 — `static defaults()` is not in the frozen §Spec contract and has no callers (repo-wide grep: zero uses). Remove or get it specced.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Core contract (types, messages, ordering, cache-free load, apiKey hygiene, zero vscode in settings.ts) verified clean; only the malformed-model-entry validation gap blocks.

## Reviewer Verdict (re-review round 1)

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart (config: unic-smart — match)
EXECUTOR_MODEL: unic/unic-code (≠ reviewer — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts && npx tsc --noEmit
  result: 15 pass / 0 fail; tsc exit 0; shell exit 0
ROUND1_RESOLUTION:
  - important/null-role — FIXED: src/ai/settings.ts:97 guard is now `!m || typeof m !== "object" || typeof m.modelId !== "string" || m.modelId.trim() === ""` → null/non-object role and non-string modelId yield `Model is required for role: <role>`. Regression test #4b present (src/ai/__tests__/settings.test.ts:111-116, covers `work: null` + `modelId: 42`). Half-save unreachable for this input: AiConfigStore.save (src/ai/config.ts:81-88) runs aiSettingsErrors FIRST and throws before secrets.store.
  - minor/static-defaults — NOT addressed: config.ts:121 `static defaults()` still has zero repo callers. Stays minor, non-blocking.
TEST_PLAN_COVERAGE: all-followed (13 spec cases + #9b + new #4b regression = 15)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/config.ts:121 — `static defaults()` off-contract, zero callers; remove in a later cleanup pass.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Fix commit 9bca9f3 resolves the round-1 validation gap exactly as requested; only the pre-existing cosmetic defaults() remains.
