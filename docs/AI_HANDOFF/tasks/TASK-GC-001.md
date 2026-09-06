# TASK-GC-001 — AI settings data model: `lite` role + per-model engine + legacy migration

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3

## Goal

Add the **Lite Model** as a fourth model role (`"lite"`) to `AiSettings`, with a per-model
`engine?: AiEngine` override (lite defaults to `"omp"`, global default stays `"builtin"`),
and migrate legacy stored configs without loss. This is the data model every later GC task
consumes.

## Target Files

- `src/ai/settings.ts` — `AiModelRole` += `"lite"`; `AiModelConfig` += `engine?: AiEngine`;
  `defaultAiSettings()` gains `lite: { modelId: "", vision: false, engine: "omp" }`
  (work/smart/autocomplete stay engine-less); `aiSettingsErrors` treats empty `lite` as
  valid (feature disabled, same precedent as `autocomplete`) and rejects a per-model
  `engine` that is not `"builtin" | "omp"` with the existing message "Engine must be
  builtin or omp"; `redactAiConfig` carries `lite` + per-model engine (preserving
  `undefined` for roles without one).
- `src/ai/config.ts` — `loadSettings()` migration: stored configs missing `models.lite`
  get `{ modelId: "", vision: false, engine: "omp" }` injected BEFORE validation (mirror
  the existing `autocomplete` migration); a stored `lite` missing `engine` also gets
  `"omp"`. `save()`'s `toPersist` literal includes `lite` + per-model `engine` fields.
- Fixture adaptation (exact inventory from `grep -rln 'models: {' src/ --include='*.test.ts'`
  — every file whose `AiSettings` literal fails typecheck once `Record<AiModelRole,…>`
  gains `lite`; adapt, do NOT redesign):
  `src/__tests__/extensionAutocomplete.test.ts`, `src/ai/__tests__/agent.test.ts`,
  `src/ai/__tests__/agentStream.test.ts`, `src/ai/__tests__/config.test.ts`,
  `src/ai/__tests__/settings.test.ts`, `src/ai/__tests__/sqlAutocomplete.test.ts`,
  `src/ai/tools/__tests__/registry.test.ts`, `src/extension.test.ts`,
  `src/ui/__tests__/aiChatE2e.test.ts`, `src/ui/__tests__/aiChatPanelDbAware.test.ts`,
  `src/ui/__tests__/aiSettingsForm.test.ts`, `src/ui/__tests__/aiSettingsFormBundle.test.ts`,
  `src/ui/__tests__/aiSqlCompletionProvider.test.ts`, `src/ui/__tests__/sampleDataAi.test.ts`

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | defaultAiSettings exact literal (4 roles) | deep-equals literal with `lite: { modelId: "", vision: false, engine: "omp" }`; work/smart/autocomplete have NO `engine` key | `defaultAiSettings()` |
| 2 | happy | valid 4-role settings → no errors | `aiSettingsErrors` returns `[]` when lite has a modelId | `defaultAiSettings()` + filled lite |
| 3 | edge (empty) | empty lite modelId is valid (disabled) | `aiSettingsErrors` returns `[]` — no "Model is required for role: lite" | lite `{modelId:"",vision:false,engine:"omp"}` |
| 4 | edge (malformed) | lite engine "groq" rejected | errors contains exactly "Engine must be builtin or omp" | lite `{...,engine:"groq"}` |
| 5 | edge (boundary) | global engine still validated | errors contains "Engine must be builtin or omp" for `engine: "x"` at top level | settings.engine = "x" |
| 6 | regression | legacy 3-role config loads | `loadSettings()` returns settings where `models.lite` = default-with-omp AND work/smart/autocomplete values unchanged | stored object without `lite` key |
| 7 | regression | legacy 2-role config (pre-AIC) still valid | load returns valid with injected `autocomplete` AND `lite`; no field lost | stored object without both roles |
| 8 | happy | redact round-trip | `redactAiConfig` output preserves `lite.modelId/vision/engine` and omits apiKey | AiConfig with filled lite |
| 9 | happy | save persists lite + engine | after `save`, `loadSettings()` returns identical lite (incl. engine "omp") and global engine unchanged | valid settings + apiKey |

## Test Files

- `src/ai/__tests__/settings.test.ts` — tests #1–#5, #8 (extend existing describe blocks).
- `src/ai/__tests__/config.test.ts` — tests #6, #7, #9 (extend; fixtures live here).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts
```

(`npm run typecheck` also proves the 14-file fixture adaptation compiles. No lint script
exists in this project — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] `AiModelRole` includes `"lite"`; `AiModelConfig.engine?: AiEngine` exists and is optional.
- [ ] All Test Cases #1–#9 green; `npm run typecheck` clean (fixtures adapted, no `any` casts).
- [ ] Global `defaultAiSettings().engine` is still `"builtin"`; lite default engine `"omp"`.
- [ ] No behavior change for existing work/smart/autocomplete configs (regression cases pass).
- [ ] apiKey never appears in `AiSettings`-shaped objects (existing defense-in-depth intact).

## Dependencies

- (none)

## Interfaces

- Consumes: existing `AiEngine = "builtin" | "omp"`, `aiSettingsErrors`, `defaultAiSettings`,
  `redactAiConfig`, `AiConfigStore` (all in `src/ai/settings.ts` / `src/ai/config.ts`).
- Produces (GC-006 / GC-007 consume): `AiSettings.models.lite: AiModelConfig` where
  `AiModelConfig = { modelId: string; vision: boolean; engine?: AiEngine }`;
  default lite = `{ modelId: "", vision: false, engine: "omp" }`; guarantee: a settings
  object loaded through `AiConfigStore.loadSettings()` always has `models.lite` present
  (webview/GC-007 may still code defensively with `?.` / `?? "omp"`).

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: keep the validator error-string EXACT ("Engine must be builtin or omp") — the
webview mirror (GC-006) and existing tests lock these strings. Do not touch
`src/ai/engineChoice.ts` or any `src/ai/omp/*` file; commit-gen consumes them as-is in GC-007.

(no comments yet)
