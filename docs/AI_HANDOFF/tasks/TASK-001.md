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
export const KEY_AI_SETTINGS = "vsdb.ai.settings";
export const KEY_AI_API_KEY = "vsdb.ai.apiKey";
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
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | defaults exact | `defaultAiSettings()` deep-equals the literal in §Spec |
| 2 | unit | valid → no errors | `aiSettingsErrors(defaultAiSettings() with both modelIds filled) === []` |
| 3 | edge (validation) | invalid settings exact messages | blank baseUrl + `method:"x" as AiCompletionMethod` + timeout 10 + maxSteps 0 + one empty modelId → exactly the 5 matching messages, length 5 |
| 4 | edge (boundary) | bounds inclusive | timeout 1000 & 600000, maxSteps 1 & 100, baseUrl `"http://localhost:8080/v1"` → `[]`; timeout 999/600001, maxSteps 0/101 → messages |
| 5 | edge (security) | apiKey never in settings | `{...valid, apiKey:"sk-x"} as unknown as AiSettings` → includes `"apiKey must not be stored in settings"` |
| 6 | unit | normalizeBaseUrl | `" https://x/v1/ "`→`"https://x/v1"`, `"https://x/v1///"`→`"https://x/v1"`, `"https://x"` unchanged, `""`→`""` |
| 7 | unit | redactAiConfig | returns the 5 settings fields; result has NO `apiKey` key (`Object.keys` excludes it) |
| 8 | unit | save→load round-trip | fake stores; `save(valid, "sk-1")` → `loadConfig()` deep-equals `{...valid, apiKey:"sk-1"}`; secret stored under exactly `"vsdb.ai.apiKey"`, settings under `"vsdb.ai.settings"` |
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
  - From `src/ai/config.ts`: `KEY_AI_SETTINGS = "vsdb.ai.settings"`, `KEY_AI_API_KEY = "vsdb.ai.apiKey"`, `class AiConfigStore { constructor(ctx: vscode.ExtensionContext); loadSettings(): Promise<AiSettings | null>; loadApiKey(): Promise<string | undefined>; loadConfig(): Promise<AiConfig | null>; save(settings: AiSettings, apiKey: string): Promise<void>; clear(): Promise<void> }`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
Split pure `settings.ts` vs vscode `config.ts` keeps validations unit-testable AND lets the wave-3 form import `aiSettingsErrors` into the webview bundle (no vscode). Note for @executor: tests #10/#12 need a fake `vscode.ExtensionContext` (`{ secrets, globalState }`) — copy the FakeSecretStorage/FakeMemento pattern from `src/core/__tests__/connectionManager.test.ts` (vi.mock('vscode') not needed; pass the fake ctx object directly).

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
