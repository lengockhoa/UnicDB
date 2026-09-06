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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: -

RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-001

 ❯ src/ai/__tests__/settings.test.ts  (16 tests | 3 failed) 8ms
   ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #1 — defaultAiSettings has 4 roles; lite defaults to omp engine; work/smart/autocomplete have NO engine key
     → expected [ 'autocomplete', 'smart', 'work' ] to deeply equal [ 'autocomplete', 'lite', …(2) ]
   ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #4 — lite engine 'groq' is rejected with exact error message
     → expected [] to include 'Engine must be builtin or omp'
   ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #8 — redactAiConfig preserves lite.modelId/vision/engine and omits apiKey
     → expected undefined to deeply equal { modelId: 'vendor/lite-fast', …(2) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #1 — defaultAiSettings has 4 roles; lite defaults to omp engine; work/smart/autocomplete have NO engine key
AssertionError: expected [ 'autocomplete', 'smart', 'work' ] to deeply equal [ 'autocomplete', 'lite', …(2) ]

- Expected
+ Received

  Array [
    "autocomplete",
-   "lite",
    "smart",
    "work",
  ]

 ❯ src/ai/__tests__/settings.test.ts:31:42
     29|   it("GC #1 — defaultAiSettings has 4 roles; lite defaults to omp engi…
     30|     const d = defaultAiSettings();
     31|     expect(Object.keys(d.models).sort()).toEqual(
       |                                          ^
     32|       ["autocomplete", "lite", "smart", "work"].sort(),
     33|     );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #4 — lite engine 'groq' is rejected with exact error message
AssertionError: expected [] to include 'Engine must be builtin or omp'
 ❯ src/ai/__tests__/settings.test.ts:237:18
    235|     };
    236|     const errs = aiSettingsErrors(s);
    237|     expect(errs).toContain("Engine must be builtin or omp");
       |                  ^
    238|   });
    239| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #8 — redactAiConfig preserves lite.modelId/vision/engine and omits apiKey
AssertionError: expected undefined to deeply equal { modelId: 'vendor/lite-fast', …(2) }

- Expected: 
Object {
  "engine": "omp",
  "modelId": "vendor/lite-fast",
  "vision": false,
}

+ Received: 
undefined

 ❯ src/ai/__tests__/settings.test.ts:262:29
    260|     const red = redactAiConfig(cfg);
    261|     expect((red as unknown as Record<string, unknown>).apiKey).toBeUnd…
    262|     expect(red.models.lite).toEqual({
       |                             ^
    263|       modelId: "vendor/lite-fast",
    264|       vision: false,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯

 Test Files  1 failed (1)
      Tests  3 failed | 13 passed (16)
```

(GC #2, #3, #5 passed accidentally because the pre-implementation validator
never iterated over `lite` and never validated per-model `engine` — these
tests are still green after implementation and assert the spec requirement
that empty lite stays valid and a bad per-model engine is caught.)

Verification Output:
```
# npm run typecheck
> UnicDB@1.51.7 typecheck
> tsc --noEmit
(no output)

# npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts
 ✓ src/ai/__tests__/settings.test.ts  (16 tests) 3ms
 ✓ src/ai/__tests__/config.test.ts  (11 tests) 4ms

 Test Files  2 passed (2)
      Tests  27 passed (27)

# npm test (full suite)
 Test Files  244 passed | 1 skipped (245)
      Tests  3628 passed | 2 skipped (3630)
```

Status: PASS
Note: 14 fixture test files adapted (added `lite: { modelId: "", vision: false, engine: "omp" }` to every `models: {...}` literal). Worktree's `node_modules` and `dist/` were empty/missing — symlinked from main so the bundle tests run. No production-code changes outside `src/ai/settings.ts` + `src/ai/config.ts` and the 14 fixture files. Validator error string kept exact ("Engine must be builtin or omp").
