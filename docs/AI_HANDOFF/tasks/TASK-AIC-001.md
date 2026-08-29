# TASK-AIC-001 — Add configurable autocomplete model role

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §3, §4, §6, §7

## Goal

Add the independently configurable, free-form `autocomplete` AI model role to persisted settings and the existing AI Settings form. Safely migrate existing two-role settings while preserving the one existing SecretStorage API key and shared OpenAI-compatible endpoint configuration.

## Target Files

- `src/ai/settings.ts` — extend `AiModelRole`, defaults, validation, and `redactAiConfig` for an optional-by-empty autocomplete role.
- `src/ai/config.ts` — normalize legacy persisted two-role `models` before validation and persist the autocomplete role without storing API keys in settings.
- `src/ui/aiSettingsForm.ts` — construct Test request using the existing `work` role only; accept/post settings containing autocomplete without exposing the key.
- `webview/aiSettingsFormMain.ts` — render/read/validate a free-form autocomplete model input with no allowlist and no vision control.
- `src/ai/__tests__/settings.test.ts` — extend pure default/validation/redaction tests.
- `src/ai/__tests__/config.test.ts` — extend persistence and legacy migration tests.
- `src/ui/__tests__/aiSettingsForm.test.ts` — extend host settings-form message and API-key-redaction tests.
- `src/ui/__tests__/aiSettingsFormBundle.test.ts` — extend compiled settings webview DOM/message tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | free-form autocomplete model round-trip | Saving `models.autocomplete.modelId = "vendor/free-fast-sql"` reloads that exact string; `KEY_AI_API_KEY` remains SecretStorage-only and absent from globalState/messages. | Valid work/smart roles and fake secret store. |
| 2 | edge — migration | legacy two-role saved object loads | A stored settings object with work/smart but no autocomplete loads with `autocomplete: { modelId: "", vision: false }`; existing work/smart values and engine remain unchanged. | Pre-AIC globalState fixture. |
| 3 | edge — validation | blank autocomplete disables without invalidating chat | `aiSettingsErrors` returns no autocomplete-role error for empty autocomplete model ID but still returns `Model is required for role: work` when work is blank. | Default settings variants. |
| 4 | edge — input normalization | whitespace/Unicode free-form model ID is normalized safely | Form save for `  local/sql-coder:free@2026-08  ` stores the exact trimmed ID; whitespace-only becomes disabled; there is no select/allowlist coercion. | jsdom form bundle init with stored API key. |
| 5 | regression | existing settings test probe still uses work model | Clicking Test creates `ProviderRequest.modelId === settings.models.work.modelId`, not autocomplete; existing saved key remains write-only. | Existing host form fake provider/store. |

## Test Files

- `src/ai/__tests__/settings.test.ts` — settings model-role defaults, validation, and redaction.
- `src/ai/__tests__/config.test.ts` — SecretStorage/globalState persistence and legacy migration.
- `src/ui/__tests__/aiSettingsForm.test.ts` — host form protocol and test probe regression.
- `src/ui/__tests__/aiSettingsFormBundle.test.ts` — compiled webview field and save payload.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts src/ui/__tests__/aiSettingsForm.test.ts src/ui/__tests__/aiSettingsFormBundle.test.ts
npm run typecheck
```

No lint script is defined in `package.json`.

## Acceptance Criteria

- [ ] `AiModelRole` includes `"autocomplete"`; the default role is `{ modelId: "", vision: false }`.
- [ ] Work and smart remain required; an empty autocomplete ID means disabled/unconfigured rather than invalid.
- [ ] Legacy two-role settings are normalized on every `loadConfig()` before validation and persist forward with the new role; invalid work/smart values remain invalid.
- [ ] The AI Settings webview exposes a plain free-form autocomplete model ID field, preserves valid user text without an allowlist, and treats empty-after-trim as disabled.
- [ ] API key handling remains exactly SecretStorage/write-only; no key is added to settings or host-to-webview protocol.
- [ ] All named test cases and verification commands pass with fresh output.
- [ ] Reviewer verdict is `approved` or `approved_minor`.

## Dependencies

- none

## Interfaces

- Consumes: `type AiModelRole = "work" | "smart"`; `interface AiSettings { models: Record<AiModelRole, AiModelConfig>; }`; `AiConfigStore.loadConfig(): Promise<AiConfig | null>`; `AiConfigStore.save(settings: AiSettings, apiKey: string): Promise<void>`.
- Produces: `type AiModelRole = "work" | "smart" | "autocomplete"`; `AiSettings.models.autocomplete: AiModelConfig` with empty model ID permitted; `AiConfigStore.loadConfig(): Promise<AiConfig | null>` normalizes missing autocomplete on every load before preserving ordinary validation; existing `AiSettingsFormOptions.complete(cfg, "work", req)` stays work-only.

---

## Discussion

### 2026-08-29 · planner · unic-smart
The cycle intentionally reuses `baseUrl`, `method`, `timeoutMs`, and `KEY_AI_API_KEY = "vsdb.ai.apiKey"`. Do not add autocomplete-specific endpoint/key fields or an API key to webview messages.

---

## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: (committed before this report consolidation; tests added in same commit)
  ✓ src/ai/__tests__/settings.test.ts (10 tests) — incl. happy free-form autocomplete, legacy 2-role migration, blank autocomplete disabled, whitespace trim, regression.
  ✓ src/ai/__tests__/config.test.ts (8 tests) — incl. legacy migration in loadConfig persists autocomplete role.
  ✓ src/ui/__tests__/aiSettingsForm.test.ts (12 tests) — Test button still targets work, no key in messages.
  ✓ src/ui/__tests__/aiSettingsFormBundle.test.ts (5 tests) — free-form input + trim/disabled handling.
Verification Output:
  $ npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts src/ui/__tests__/aiSettingsForm.test.ts src/ui/__tests__/aiSettingsFormBundle.test.ts
  Test Files  4 passed (4)
       Tests  35 passed (35)
  Duration  664ms
Status: PASS
Note: Executor report consolidated in 1-shot pass; original commit d74669a lacked the block. Implementation verified against task spec by re-reading diff.
