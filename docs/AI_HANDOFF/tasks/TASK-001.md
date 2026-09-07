# TASK-001 — Engine vocabulary: AiEngine union widens to 4 values (settings + persistence)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1/§3(4), §7

## Goal

Widen the chat-engine vocabulary from `"builtin" | "omp"` to `"builtin" | "omp" | "claude-code" | "codex"` in the pure settings module and keep persistence + redaction consistent, so later tasks can type engine ids against one union.

## Target Files

- `src/ai/settings.ts` — extend `AiEngine` (:20); update `aiSettingsErrors` messages (:132-134 per-model, :141-143 global); fix `redactAiConfig` engine mapping (:159); update the `AiEngine` doc comment.
- `src/ai/config.ts` — no structural migration needed (unknown engine already fails closed via `loadSettings` → null); verify + comment only if a change is required.
- `src/ai/__tests__/settings.test.ts` — extend engine-value coverage.
- `src/ai/__tests__/config.test.ts` — extend persistence round-trip coverage.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | saves and reloads engine "claude-code" (and "codex") | `save()` persists; `loadSettings()` returns the same engine; `aiSettingsErrors` = `[]` | valid AiSettings with `engine: "claude-code"` |
| 2 | edge (invalid value) | rejects stored engine "vscode-copilot" | `aiSettingsErrors` returns exactly `"Engine must be builtin, omp, claude-code, or codex"`; `loadSettings()` → null | settings object with unknown engine |
| 3 | edge (empty/legacy) | pre-AE config without engine key still migrates to "builtin" | `loadSettings()` returns settings with `engine: "builtin"` | stored object lacking `engine` |
| 4 | regression | redactAiConfig no longer coerces non-builtin engines | `redactAiConfig({...engine:"omp"...}).engine === "omp"` and same for `"claude-code"` — RED on today's `cfg.engine === "omp" ? "omp" : "builtin"` (settings.ts:159) for the claude-code case | AiConfig with each engine value |
| 5 | edge (per-model override) | per-model engine override accepts all 4 values, rejects others | `models.lite.engine: "codex"` valid; `"omp2"` → per-model error message | lite role override variants |

## Test Files

- `src/ai/__tests__/settings.test.ts` — tests 1, 2, 4, 5.
- `src/ai/__tests__/config.test.ts` — tests 1, 3.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts
npm run typecheck
```

No lint script exists in this project (package.json verified) — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] `AiEngine` = `"builtin" | "omp" | "claude-code" | "codex"`; error message updated in BOTH the global and per-model checks.
- [ ] `redactAiConfig` returns the stored engine verbatim for all 4 values (test 4 green).
- [ ] Existing defaults unchanged (`defaultAiSettings().engine === "builtin"`, `models.lite.engine === "omp"`).
- [ ] All listed tests pass; full existing assertions in both test files still pass.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: `export type AiEngine = "builtin" | "omp" | "claude-code" | "codex"` from `src/ai/settings.ts` — TASK-007/008/009/010/011/012 type against this union. Error message string `"Engine must be builtin, omp, claude-code, or codex"` is normative (TASK-008 mirrors it in the webview validator).

---

## Discussion

### 2026-09-07 · planner · unic-smart
Note for @executor: `config.ts` `save()` whitelists fields by construction, so no save-path change is expected — if you find otherwise, record it here before deviating.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
