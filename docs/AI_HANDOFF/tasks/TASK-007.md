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
