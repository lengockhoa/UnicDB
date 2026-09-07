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

### 2026-09-07 · executor · unic-code (claude-sonnet)
Typecheck side-effect discovered: widening `AiEngine` breaks an out-of-scope
narrowing at `src/ai/commitGenCommand.ts:125`
(`const engine: "omp" | "builtin" = lite.engine ?? "omp";`).
That file is not in TASK-001 §Target Files, so per the executor contract I
did NOT modify it. A follow-up cycle (or a planner amendment widening that
local union) is required before `npm run typecheck` can pass repo-wide.
In-scope work is GREEN: 36/36 tests in the owned test files pass.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report

EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

### RED output (verbatim, before any production change)
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-001

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > T1#1 — valid AiSettings with engine 'claude-code' → no errors
AssertionError: expected [ …(3) ] to deeply equal []
- Array []
+ Array [
+   "Model is required for role: work",
+   "Model is required for role: smart",
+   "Engine must be builtin or omp",
+ ]

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > T1#1 — valid AiSettings with engine 'codex' → no errors
AssertionError: expected [ …(3) ] to deeply equal []
+ Array [
+   "Model is required for role: work",
+   "Model is required for role: smart",
+   "Engine must be builtin or omp",
+ ]

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > T1#2 — stored engine 'vscode-copilot' is rejected with exact normative message
AssertionError: expected [ …(3) ] to include 'Engine must be builtin, omp, claude-c…'

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > T1#4 — redactAiConfig preserves engine verbatim for builtin / omp / claude-code / codex
AssertionError: expected 'builtin' to be 'claude-code' // Object.is equality

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > T1#5 — per-model engine override accepts all 4 values
AssertionError: expected [ 'Engine must be builtin or omp' ] to deeply equal []
+ Array [
+   "Engine must be builtin or omp",
+ ]

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > T1#5 — per-model engine override 'omp2' is rejected with the normative message
AssertionError: expected [ 'Engine must be builtin or omp' ] to include 'Engine must be builtin, omp, claude-c…'

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #4 — lite engine 'groq' is rejected with exact error message
AssertionError: expected [ …(1) ] to include 'Engine must be builtin, omp, claude-c…'
  → existing assertion that was updated to expect the new message

 ❯ src/ai/__tests__/settings.test.ts > ai/settings — defaults + validation + helpers > GC #5 — global engine 'x' is rejected (still validated)
AssertionError: expected [ …(1) ] to include 'Engine must be builtin, omp, claude-c…'
  → existing assertion that was updated to expect the new message

 ❯ src/ai/__tests__/config.test.ts > ai/config — AiConfigStore (SecretStorage + globalState) > T1#1 — save → load round-trip preserves engine 'claude-code'
Error: Model is required for role: work
  → initial test missing valid work/smart modelIds (test fixture bug, fixed before GREEN)

 ❯ src/ai/__tests__/config.test.ts > ai/config — AiConfigStore (SecretStorage + globalState) > T1#1 — save → load round-trip preserves engine 'codex'
Error: Model is required for role: work
  → same fixture bug, fixed before GREEN

Test Files  2 failed (2)
Tests  10 failed | 26 passed (36)
```

### GREEN output (after implementation)
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-001

 ✓ src/ai/__tests__/settings.test.ts  (22 tests) 4ms
 ✓ src/ai/__tests__/config.test.ts  (14 tests) 3ms

 Test Files  2 passed (2)
      Tests  36 passed (36)
   Start at  17:44:09
   Duration  249ms (transform 57ms, transformId 59ms, tests 7ms, environment 0ms, prepare 111ms)
```

### VERIFICATION output (`npm run typecheck`)
```
> UnicDB@1.53.23 typecheck
> tsc --noEmit

src/ai/commitGenCommand.ts(125,9): error TS2322: Type 'AiEngine' is not assignable to type '"builtin" | "omp"'.
  Type '"claude-code"' is not assignable to type '"builtin" | "omp"'.
```

The typecheck failure is in `src/ai/commitGenCommand.ts`, which is OUT OF
TASK-001 §Target Files. Per the executor contract this file was not modified.
See the executor `### 2026-09-07 · executor` Discussion note above for
the follow-up required.

STATUS: PARTIAL
NOTE: in-scope tests are GREEN (36/36); `npm run typecheck` fails on an out-of-scope narrowing at `src/ai/commitGenCommand.ts:125` that the widening broke. Recommend the planner widen that local union (e.g. change the literal to `AiEngine` and gate the omp/builtin branches with a runtime check that surfaces a user-visible error for `claude-code`/`codex` until TASK-007/008 wire those engines).

### 2026-09-07 · orchestrator — typecheck fix applied (PARTIAL → PASS)

Resolution applied by the orchestrator (not by the TASK-001 executor) since
`src/ai/commitGenCommand.ts` is outside TASK-001's owned paths. Surgical,
additive, and limited to the downstream consumer that TASK-001 broke:

- `src/ai/commitGenCommand.ts:12` — added `AiEngine` to the existing `import type` line.
- `src/ai/commitGenCommand.ts:124-129` — replaced the local
  `const engine: "omp" | "builtin" = lite.engine ?? "omp";` with
  `const engine: AiEngine = lite.engine ?? "omp";` and added a comment
  noting that cycle AGT only wires "omp" and "builtin" into commit-gen
  today; "claude-code"/"codex" at the lite role fall through to the
  existing `else` (builtin) branch until TASK-005/006 + engine policy in
  TASK-007 add a real path. No behavior change for the current "omp"
  and "builtin" code paths.

Verification (after fix):

```
$ npm run typecheck
> UnicDB@1.53.23 typecheck
> tsc --noEmit
(exit 0 — no output)

$ npm test -- src/ai/__tests__/settings.test.ts src/ai/__tests__/config.test.ts
(src/ai/__tests__/settings.test.ts 22 pass / src/ai/__tests__/config.test.ts 14 pass)
```

STATUS: PASS (with downstream follow-up noted — TASK-007 / TASK-005/006
should still teach commit-gen to reject claude-code/codex explicitly at
runtime; current behavior is "fall through to builtin path silently",
which is acceptable for this cycle but is not the long-term contract).

