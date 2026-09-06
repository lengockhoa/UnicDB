# TASK-GC-006 — AI Settings webview: Engine dropdown (bug fix) + Lite model section

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1/§3

## Goal

Two user-visible fixes in one webview: (a) the **global Engine dropdown** is currently
missing — `readSettings()` never posts `settings.engine`, so the host validator rejects every
save with "Engine must be builtin or omp" (the exact bug the user reported); (b) add the
**"Lite model" section** below Autocomplete: Model ID, Vision toggle, and its own Engine
dropdown defaulting to `omp`, posting `models.lite` per the GC-001 shape.

## Target Files

- `webview/aiSettingsFormMain.ts` —
  - `type Role` += `"lite"`; local `AiModelConfig` mirror gains `engine?: string`.
  - Render: global `<select id="engine">` (options `builtin`, `omp`) in the top section;
    `modelBlock`-style Lite section below Autocomplete with `modelLite`, `visionLite`,
    `<select id="engineLite">` (options `omp` selected by default, `builtin`).
  - `readSettings()` returns `engine: select("engine").value` and
    `lite: { modelId: input("modelLite").value.trim(), vision: input("visionLite").checked,
    engine: select("engineLite").value }`.
  - `applyInit()` sets both selects from `msg.settings.engine ?? "builtin"` /
    `msg.settings.models.lite?.engine ?? "omp"`, model id via `models.lite?.modelId ?? ""`
    (mirror the existing optional autocomplete guard).
  - Validator mirror (`validateSettings`) gains: engine must be `builtin`|`omp`, lite engine
    must be `builtin`|`omp`, empty lite modelId allowed (lockstep with host `aiSettingsErrors`
    — do not invent new strings).
  - Wire the new inputs into the live `refreshOkButton` listeners.
- `src/ui/__tests__/aiSettingsFormBundle.test.ts` — extend the bundle scenarios:
  init renders the two selects with correct values; editing + OK posts
  `{type:"save", settings:{engine, models:{lite:{modelId, vision, engine}}}}`; empty Lite
  modelId still passes the webview gate; engine selects round-trip.
  (GC-001 already adapted this file's `models:` fixtures in wave 1 — build on top, do not
  revert.)
  **dist-missing policy (review round 1):** the legacy harness SKIPS when
  `dist/aiSettingsForm.js` is absent — that is fine for the old describes, but the NEW
  GC-006 regression describes must FAIL, not skip: start each new describe with
  `expect(existsSync(bundlePath), "aiSettingsForm.js must be built before this test runs — run: npm run compile").toBe(true)`.
  Otherwise the engine-post regression (#3) silently green-lights a stale bundle. Never
  paste a SKIP line as RED evidence in the Executor Report.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | Engine select renders from init | jsdom DOM has `#engine` with value "builtin"; setting init `engine:"omp"` shows "omp" | dispatch init via existing bundle harness |
| 2 | happy | save posts engine + lite | OK click → posted `settings.engine === "omp"` and `settings.models.lite` = `{modelId:"x", vision:false, engine:"omp"}` | init with filled lite |
| 3 | regression (bug) | engine round-trip makes save host-valid | save payload now includes `engine` — against pre-GC code this test is RED (`settings.engine === undefined` caused host "Engine must be builtin or omp") | init + click OK |
| 4 | edge (empty) | empty Lite modelId passes gate | OK not disabled with lite empty (feature-disabled precedent); save posts `lite.modelId === ""` | init with empty lite |
| 5 | edge (boundary) | lite engine select defaults omp with legacy init | init message WITHOUT `models.lite` → `#engineLite` value "omp", `#modelLite` empty, gate passes | legacy 3-role init fixture |
| 6 | edge (malformed) | invalid engine blocks OK | dispatching a (host-only) reject path is out of scope — instead assert webview mirror: manually setting select to a value is impossible via UI, so assert mirror function output lists "Engine must be builtin or omp" when engine field emptied programmatically | direct validateSettings mirror call |

## Test Files

- `src/ui/__tests__/aiSettingsFormBundle.test.ts` — tests #1–#6 (extend).

## Verification Commands

```bash
npm run compile   # REQUIRED: bundle test loads dist/aiSettingsForm.js
npm run typecheck
npx vitest run src/ui/__tests__/aiSettingsFormBundle.test.ts
```

(No lint script exists in this project — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] All tests #1–#6 green after `npm run compile`; `npm run typecheck` clean.
- [ ] apiKey invariant untouched: no new host→webview field carries the key; Lite/engine are
      settings fields only (host `aiSettingsForm.ts` needs NO change — verify).
- [ ] Validator mirror stays string-lockstep with host `aiSettingsErrors` (GC-001 strings).
- [ ] No changes to `src/ui/aiSettingsFormMessages.ts` — the existing `save`/`init` messages
      already carry the full `AiSettings` object; new fields ride inside it.

## Dependencies

- TASK-GC-001 (consumes the `lite` role + `engine?: AiEngine` shape and validator strings)

## Interfaces

- Consumes: `AiSettings` wire shape from GC-001 (`models.lite.engine`, top-level `engine`);
  existing webview↔host protocol (`AiSettingsFormInit` / `AiSettingsFormSave`).
- Produces: (none) — the posted payload is just a now-complete `AiSettings`, which the
  unchanged host already validates + persists via `AiConfigStore.save`.

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: this is the cycle's only live bug fix — write test #3 FIRST and paste the RED
output (save payload without `engine`) into the Executor Report before implementing. The
host file `src/ui/aiSettingsForm.ts` must NOT change (it already round-trips whatever
`AiSettings` carries); if you find it needs a change, stop and note it in this thread.

(no comments yet)

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -

### RED_OUTPUT (before implementation, 6 new tests failed as expected):

```
 FAIL  src/ui/__tests__/aiSettingsFormBundle.test.ts > webview/aiSettingsFormMain.ts bundle — TASK-GC-006 (engine + lite) > #1 Engine select renders from init
TypeError: Cannot read properties of null (reading 'value')
 ❯ src/ui/__tests__/aiSettingsFormBundle.test.ts:340:29
   340|     expect(selectEl("engine").value).toBe("builtin");

 FAIL  src/ui/__tests__/aiSettingsFormBundle.test.ts > ... > #2 save posts engine + lite
AssertionError: expected undefined to be 'omp' // Object.is equality
 ❯ .../aiSettingsFormBundle.test.ts:368:37
   368|     expect(payload.settings.engine).toBe("omp");

 FAIL  src/ui/__tests__/aiSettingsFormBundle.test.ts > ... > #3 regression: engine round-trip makes save host-valid
AssertionError: expected undefined not to be undefined
 ❯ .../aiSettingsFormBundle.test.ts:391:37
   391|     expect(payload.settings.engine).toBeDefined();

 FAIL  src/ui/__tests__/aiSettingsFormBundle.test.ts > ... > #4 empty Lite modelId passes gate
TypeError: Cannot read properties of undefined (reading 'modelId')
 ❯ .../aiSettingsFormBundle.test.ts:417:41
   417|     expect(payload.settings.models.lite.modelId).toBe("");

 FAIL  src/ui/__tests__/aiSettingsFormBundle.test.ts > ... > #5 lite engine select defaults omp with legacy init
TypeError: Cannot read properties of null (reading 'value')
 ❯ .../aiSettingsFormBundle.test.ts:440:33
   440|     expect(selectEl("engineLite").value).toBe("omp");

 FAIL  src/ui/__tests__/aiSettingsFormBundle.test.ts > ... > #6 invalid engine blocks OK
TypeError: Cannot read properties of null (reading 'options')
 ❯ .../aiSettingsFormBundle.test.ts:457:25
   457|     while (engineSelect.options.length > 0) {

 Test Files  1 failed (1)
      Tests  6 failed | 5 passed (11)
```

### Verification Output (after implementation):

```
$ npm run compile
esbuild: build complete

$ npm run typecheck
> UnicDB@1.51.7 typecheck
> tsc --noEmit
(exit 0, clean)

$ npx vitest run src/ui/__tests__/aiSettingsFormBundle.test.ts
 ✓ src/ui/__tests__/aiSettingsFormBundle.test.ts  (11 tests) 56ms
 Test Files  1 passed (1)
      Tests  11 passed (11)

$ npm test
 Test Files  247 passed | 1 skipped (248)
      Tests  3672 passed | 2 skipped (3674)
   Duration  17.95s
```

### Summary

`webview/aiSettingsFormMain.ts` now (a) renders the global `<select id="engine">` and round-trips `settings.engine` through `readSettings()` (fixing the "Engine must be builtin or omp" save rejection), and (b) renders a fourth Lite section with `modelLite` text input, `visionLite` checkbox, and `<select id="engineLite">` defaulting to `omp`. Validator mirror updated to lockstep with host `aiSettingsErrors`; `applyInit` reads `models.lite?.{modelId, vision, engine}` with sensible defaults. Host files (`src/ui/aiSettingsForm.ts`, `src/ui/aiSettingsFormMessages.ts`) untouched per the planner note — they already round-trip whatever `AiSettings` carries.

Status: PASS
Note: dist symlinked from main repo for build (rebuilds the main repo's `dist/aiSettingsForm.js`, which is in `.gitignore`). No commit/push done per spec.
