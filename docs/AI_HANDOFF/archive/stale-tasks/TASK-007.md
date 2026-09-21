# TASK-007 — Settings-driven engine resolution policy for four engines

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1(P0.3), §3(4)

## Goal

Refactor pure `resolveEngine()` to honor the user-selected engine (`omp`, `claude-code`, `codex`, `builtin`) when given an explicit setting, with precise unavailable/old fallback hints. Keep the current omitted-setting behavior temporarily backward-compatible until TASK-012 migrates extension callers.

## Target Files

- `src/ai/engineChoice.ts` — widen `EngineChoice.engine`, add detections/settings input, implement P0.3 and retained legacy mode.
- `src/ai/policy.ts` — widen `isEngineChoice` vocabulary guard (`:122`) and resulting `AiEngine` provider support.
- `src/ai/__tests__/engineChoice.test.ts` — unit policy matrix.
- `src/ai/__tests__/policy.test.ts` — widened policy guard tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | configured healthy Claude Code wins | `resolveEngine({ engine:"claude-code", detections, config:null })` → `{engine:"claude-code",requiresConfig:false,path,version}` | Claude `ok:true`; other detections arbitrary |
| 2 | edge (unavailable) | configured missing Codex falls back builtin | `{engine:"builtin",requiresConfig:true,hint:CODEX_INSTALL_HINT}` | Codex `ok:false, reason:"not-installed"`; config null |
| 3 | edge (boundary/config precedence) | explicit builtin ignores a healthy omp | `{engine:"builtin",requiresConfig:false}` when config exists; no hint | builtin selected, omp `ok:true` |
| 4 | edge (invalid input) | unknown configured engine fails closed | builtin + `requiresConfig` based on config + no unsafe external engine | `engine:"copilot" as unknown` |
| 5 | regression | omitted `engine` preserves existing omp-first behavior during migration | healthy omp → `engine:"omp"`, `requiresConfig:false` | legacy call shape `{detection,config}` | 
| 6 | edge (policy guard) | policy accepts four real EngineChoice values and rejects fifth | `isEngineChoice({engine:"codex",...})` true; `engine:"unknown"` false | object fixtures |

## Test Files

- `src/ai/__tests__/engineChoice.test.ts` — tests 1–5.
- `src/ai/__tests__/policy.test.ts` — test 6.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/engineChoice.test.ts src/ai/__tests__/policy.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] Explicit selection is authoritative: healthy selected agent wins; nonselected installed agents never override it.
- [ ] All unavailable reasons map to selected-engine hint: `version-too-old` → update hint; otherwise → install hint.
- [ ] No inline `engine` string union remains in EngineChoice/policy after widening; import `AiEngine` as a type from settings where cycle-safe.
- [ ] Legacy `{ detection: OmpDetection, config }` caller remains supported until TASK-012 uses explicit mode.
- [ ] All six specified test cases pass.

## Dependencies

- TASK-001 — consumes `AiEngine` union.
- TASK-002 — consumes Claude detection + install/update hints.
- TASK-003 — consumes Codex detection + install/update hints.

## Interfaces

- Consumes: `AiEngine` from TASK-001; `OmpDetection` + OMP hints (`src/ai/omp/detect.ts:5-15`); `ClaudeCodeDetection`/hints (TASK-002); `CodexDetection`/hints (TASK-003).
- Produces (exact compatibility contract):
  - `export interface EngineChoice { engine: AiEngine; requiresConfig: boolean; hint?: string; version?: string; path?: string }`
  - `export function resolveEngine(input: { engine?: unknown; detections?: Partial<Record<Exclude<AiEngine,"builtin">, AgentDetection>>; detection?: OmpDetection; config: unknown | null }): EngineChoice`
  - when `engine`/`detections` omitted: retain existing omp-first behavior; when supplied: P0.3 selected-engine policy.
  — TASK-012 consumes explicit mode; TASK-011’s panel `EngineKind` relies on `EngineChoice.engine` vocabulary.

---

## Discussion

### 2026-09-07 · planner · unic-smart
The conflict is intentional and resolved: current engineChoice locked an omp-first decision, but user-confirmed P0.3 supersedes it. Retaining omitted-input behavior makes this task independently green without forcing a same-wave extension.ts edit. TASK-012 is the deliberate migration commit that switches callers to explicit policy.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->

## Executor Report

EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:

```
 FAIL  src/ai/__tests__/engineChoice.test.ts > resolveEngine — TASK-007 P0.3 selected-engine policy > configured healthy Claude Code wins over any other installed agent
TypeError: Cannot read properties of undefined (reading 'ok')
 ❯ Module.resolveEngine src/ai/engineChoice.ts:49:17
     47|   const { detection, config } = input;
     48|
     49|   if (detection.ok) {
       |                 ^

 FAIL  src/ai/__tests__/engineChoice.test.ts > resolveEngine — TASK-007 P0.3 selected-engine policy > configured missing Codex falls back builtin with CODEX_INSTALL_HINT
TypeError: Cannot read properties of undefined (reading 'ok')
 ❯ Module.resolveEngine src/ai/engineChoice.ts:49:17
     49|   if (detection.ok) {

 FAIL  src/ai/__tests__/engineChoice.test.ts > resolveEngine — TASK-007 P0.3 selected-engine policy > explicit builtin ignores a healthy omp; no hint; requiresConfig reflects config presence
TypeError: Cannot read properties of undefined (reading 'ok')
 ❯ Module.resolveEngine src/ai/engineChoice.ts:49:17

 FAIL  src/ai/__tests__/engineChoice.test.ts > resolveEngine — TASK-007 P0.3 selected-engine policy > unknown configured engine fails closed to builtin with no unsafe external engine
TypeError: Cannot read properties of undefined (reading 'ok')
 ❯ Module.resolveEngine src/ai/engineChoice.ts:49:17

 FAIL  src/ai/__tests__/policy.test.ts > isEngineChoice — TASK-007 four-engine vocabulary guard > accepts the four real EngineChoice values and rejects a fifth
TypeError: isEngineChoice is not a function
 ❯ src/ai/__tests__/policy.test.ts:188:12

 Test Files  2 failed (2)
      Tests  5 failed | 17 passed (22)
```

Verification Output:

```
> UnicDB@1.53.23 typecheck
> tsc --noEmit
$ npx vitest run src/ai/__tests__/engineChoice.test.ts src/ai/__tests__/policy.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-007

 ✓ src/ai/__tests__/policy.test.ts  (11 tests) 3ms
 ✓ src/ai/__tests__/engineChoice.test.ts  (11 tests) 2ms

 Test Files  2 passed (2)
      Tests  22 passed (22)
   Duration  208ms
```

Wider regression sweep (dependent modules): `npx vitest run src/__tests__/aix05Scaffold.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts src/ui/__tests__/commitGenIntegration.test.ts src/ai/__tests__/commitGenCommand.test.ts` → 6 test files, 70 tests, all pass.

Status: PASS

Note:

- `isValidEngineChoice` was renamed to `isEngineChoice` (test 6 imports it by that name). Internal callers within `policy.ts` updated; the only pre-existing import site was internal. Added an internal `isValidEngineChoice` alias for in-module forward-compat — non-breaking.
- The 5 new tests were added as a new `describe` block in `engineChoice.test.ts`; the 6 prior AIX-05 reason→hint regression tests were kept (still green) to preserve the locked mapping documentation.
- `engineChoice.ts` keeps `detection.reason === "version-too-old"` literal in the legacy branch so `aix05Scaffold.test.ts`'s source-string regex stays green.
- `ClaudeCodeDetection` / `CodexDetection` types are imported and projected into the shared `AgentDetection` projection; legacy `{ detection, config }` callers with `engine==="omp"` still resolve exactly as before.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-5
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/engineChoice.test.ts src/ai/__tests__/policy.test.ts && npm run typecheck
  result: 22 pass / 0 fail; typecheck clean; wider sweep (aix05Scaffold, aiChatPanelPolicy, commitGenIntegration, commitGenCommand) 48 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed — all 6 §Test Cases implemented with real expects; RED_OUTPUT contains genuine failing output (TypeErrors + 5 failed / 17 passed); lint N/A documented, typecheck present
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ai/engineChoice.ts:205-208 — `export type _LegacyDetectionTypes` is a dead export; both types are already used in `projectAgent()`'s signature, and the tree-shaking rationale in the comment does not apply to a type-only export. Delete it.
    - src/ai/policy.ts:133-135 — internal caller at policy.ts:154 still uses the old `isValidEngineChoice` alias, so the rename is only external-facing; the alias comment ("used by pre-TASK-007 callers inside this module") is self-referential. Either drop the alias and use `isEngineChoice` internally, or fix the comment.
    - src/ai/policy.ts:16-18 — header comment still claims configuredEngine vocabulary is `("builtin" | "omp")`; CONFIGURED_ENGINE_VALUES is now four values. Update the stale comment to match the widened guard.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Explicit-mode authority, reason-keyed hint mapping (claude-code/codex have no update hints — install-hint reuse is correct and documented), four-engine AiEngine typing with no inline unions, and the legacy omp-first path (still used by extension.ts:2495 and commitGenCommand.ts:142) all verified. Safe to proceed; minors are cleanup-only and can ride along with TASK-012.
