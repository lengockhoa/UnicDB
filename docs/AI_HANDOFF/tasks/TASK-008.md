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
