# TASK-008 — Settings form: four-engine dropdown and mirrored validation

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1(P0.3), §2, §3(4)

## Goal

Extend the existing global and lite per-model engine selects in the AI Settings webview to expose `builtin`, `omp`, `claude-code`, and `codex`; keep its client-side validator exactly aligned with TASK-001's authoritative host validation.

## Target Files

- `webview/aiSettingsFormMain.ts` — local `Engine` union (:26), default settings (:87), submit type (:113), validator (:177-186), global select (:325), lite select (:296).
- `webview/__tests__/aiSettingsFormMain.test.ts` (new) — source/UI behavior tests; parent directory verified.
- `src/ui/__tests__/aiSettingsFormBundle.test.ts` — compiled webview bundle assertions.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | init renders global Claude Code setting | init `settings.engine:"claude-code"` selects exact value; save posts `engine:"claude-code"` | fake host init message |
| 2 | edge (alternative valid option) | init/save Codex from global and lite override | global `"codex"` and `models.lite.engine:"codex"` round-trip in posted settings | valid stored settings fixture |
| 3 | edge (invalid value) | webview blocks unknown engine | save/test does not post provider request; visible validation error is exact `"Engine must be builtin, omp, claude-code, or codex"` | select/message injected invalid engine |
| 4 | edge (legacy/default) | missing engine keeps builtin default and lite omp default | global select is `builtin`; lite select is `omp`; existing users do not see blank selection | partial legacy init fixture |

## Test Files

- `webview/__tests__/aiSettingsFormMain.test.ts` (new) — tests 1–4.
- `src/ui/__tests__/aiSettingsFormBundle.test.ts` — end-to-end compiled bundle assertions for tests 1–2.

## Verification Commands

```bash
npx vitest run webview/__tests__/aiSettingsFormMain.test.ts src/ui/__tests__/aiSettingsFormBundle.test.ts
npm run typecheck
npm run compile
```

No lint script exists in this project — lint is N/A; typecheck is the static gate. `compile` is required because the bundle test consumes `dist/aiSettingsForm.js`.

## Acceptance Criteria

- [ ] Both `<select id="engine">` and `<select id="engineLite">` contain exactly the four engine options in user-confirmed order: omp, claude-code, codex, builtin (values stable; display labels may be friendly).
- [ ] The webview-local `Engine` union and both validator branches accept exactly the same four values / exact error string as TASK-001.
- [ ] Default compatibility survives: global builtin, lite omp.
- [ ] `npm run compile` emits the settings bundle and all listed tests pass.

## Dependencies

- TASK-001 — consumes the canonical four values + normative validation error string.

## Interfaces

- Consumes: `AiEngine` value set and exact error string from `src/ai/settings.ts` (TASK-001), mirrored locally because `webview/` runs in its own esbuild bundle and cannot import vscode-bound host code.
- Produces: Webview `settings` post message retains existing shape `AiSettingsFormWebviewMessage["settings"]` with `engine: "builtin" | "omp" | "claude-code" | "codex"`; `src/ui/aiSettingsForm.ts:131-148` receives it unchanged.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Grounded current paths: source is `webview/aiSettingsFormMain.ts` (esbuild entry in `esbuild.js:64`), compiled-contract test is `src/ui/__tests__/aiSettingsFormBundle.test.ts`. `webview/__tests__/` exists and contains no aiSettings test today, so the new source-level test file there is confirmed `(new)`; the `.cache/index/tests-map.json` entry for this source currently points only at the host-side tests, which is why the bundle test is listed explicitly.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 ✓ webview/__tests__/aiSettingsFormMain.test.ts > TASK-008 four-engine webview > #1 init renders global Claude Code setting + save posts engine:claude-code
   AssertionError: expected '' to be 'claude-code' // Object.is equality
   ❯ webview/__tests__/aiSettingsFormMain.test.ts:175:40
 FAIL  webview/__tests__/aiSettingsFormMain.test.ts > TASK-008 four-engine webview > #2 init/save Codex from global and lite override round-trips
   AssertionError: expected '' to be 'codex' // Object.is equality
   ❯ webview/__tests__/aiSettingsFormMain.test.ts:207:40
 FAIL  webview/__tests__/aiSettingsFormMain.test.ts > TASK-008 four-engine webview > #3 unknown engine: blocks save + visible error is exact 4-engine string
   AssertionError: expected 'Engine must be builtin or omp' to contain 'Engine must be builtin, omp, claude-c…'
   ❯ webview/__tests__/aiSettingsFormMain.test.ts:261:40
 FAIL  webview/__tests__/aiSettingsFormMain.test.ts > TASK-008 select option shape > global + lite selects carry the four engines in the user-confirmed order
   AssertionError: expected [ 'builtin', 'omp' ] to deeply equal [ 'omp', 'claude-code', 'codex', …(1) ]
   ❯ webview/__tests__/aiSettingsFormMain.test.ts:320:26
 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
```

Verification Output:
```
$ npx vitest run webview/__tests__/aiSettingsFormMain.test.ts src/ui/__tests__/aiSettingsFormBundle.test.ts
 ✓ webview/__tests__/aiSettingsFormMain.test.ts  (5 tests) 39ms
 ✓ src/ui/__tests__/aiSettingsFormBundle.test.ts  (11 tests) 61ms
 Test Files  2 passed (2)
      Tests  16 passed (16)
   Duration  492ms

$ npm run typecheck
> tsc --noEmit
(no output, exit 0)

$ npm run compile
  dist/aiSettingsForm.js      12.8kb
  dist/aiSettingsForm.js.map  24.7kb
esbuild: build complete

$ ls -la dist/aiSettingsForm.js
-rw-r--r--@ 1 lenk  staff  13109 Sep  7 18:23 dist/aiSettingsForm.js
```

Status: PASS
Note: Updated `src/ui/__tests__/aiSettingsFormBundle.test.ts` test #6 to expect the new 4-value error string ("Engine must be builtin, omp, claude-code, or codex") so the bundle test stays green with the TASK-008 source change. Default values preserved: global=`builtin`, lite=`omp`. Engine union and both validator branches accept exactly the four canonical values; error string is byte-for-byte identical to `src/ai/settings.ts`.

### 2026-09-07 · orchestrator — dist re-compile after copy-back

The executor's worktree verification was fresh, but after copy-back to main
the dist/ bundle was stale (still emitted the old 2-engine validator
`"Engine must be builtin or omp"`), so `aiSettingsFormBundle.test.ts`
failed against the main bundle. Re-ran `npm run compile` to refresh
`dist/aiSettingsForm.js`; all 38 wave-2-batch-2 tests now pass
(engineChoice 11 + policy 11 + new webview aiSettingsFormMain 5 +
bundle 11).

Process follow-up for wave 3+: any task that touches webview source
should add `npm run compile` to its §Verification Commands, AND the
orchestrator's wave-boundary gate must run `npm run compile` after
copy-back before declaring the wave green. Captured here for the
reviewer's awareness; no executor-side bug.