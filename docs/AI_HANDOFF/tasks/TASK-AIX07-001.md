# TASK-AIX07-001 — Central effective AI policy (pure)

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX07.md` §3

## Goal

Create the pure, default-deny source of truth for effective AI provider, sensitive context, tool admission, audit export, excluded paths, and user-visible governance notices. This task has no VS Code or runtime I/O integration.

## Target Files

- `src/ai/policy.ts` (new) — define the pure policy input/output types and `resolvePolicy(input): EffectivePolicy` plus the centralized excluded-path decision.
- `src/ai/__tests__/policy.test.ts` (new) — TDD matrix for trusted valid resolver routes, valid configured-builtin/resolved-OMP behavior, untrusted, invalid/migrated, and excluded-path policy outcomes.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `trusted valid builtin resolver route enables declared governed capabilities` | `resolvePolicy` returns effective provider `builtin`, enables its documented sensitive context/tool classes and audit export, with no denial notice. | `{ workspaceTrusted: true, configuredEngine: "builtin", resolvedEngine: { engine: "builtin", requiresConfig: false } }` |
| 2 | edge — resolver/default builtin | `valid configured builtin remains allowed when resolveEngine selects OMP` | `resolvePolicy` returns effective provider `omp`, enables its declared sensitive classes and audit export, and has no denial notice; it does not treat the valid user default as a conflict. | `{ workspaceTrusted: true, configuredEngine: "builtin", resolvedEngine: { engine: "omp", requiresConfig: false } }`, matching `resolveEngine()`'s detection-first branch. |
| 3 | edge — permission | `untrusted workspace defaults to no sensitive context or tools` | Schema/workspace/row context, database/workspace tool classes, and audit export are all denied even with a valid resolver choice. | Same valid route with `workspaceTrusted: false`. |
| 4 | edge — invalid/migration | `unknown configured value or invalid resolver fails closed with notice` | An unsupported raw setting and a missing/invalid resolver choice each deny sensitive capabilities and return a concrete notice. | Trusted workspace with `configuredEngine: "legacy"`; then a resolver input without a valid `engine`. |
| 5 | edge — path classification | `credential and generated configuration paths are excluded centrally` | `.env`, `.git/config`, and `.vscode/vsdb-ai-config.yml` are rejected; `src/feature.ts` is not rejected. | Relative workspace paths using `/` separators. |

Write the tests first and record the actual failing RED command output in the Executor Report before implementation; then make the same tests GREEN.

## Test Files

- `src/ai/__tests__/policy.test.ts` (new) — contains all policy matrix tests above.

## Verification Commands

```bash
npm test -- src/ai/__tests__/policy.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] `src/ai/policy.ts` is VS Code-, filesystem-, network-, and child-process-free.
- [ ] `resolvePolicy(input): EffectivePolicy` has named provider, context, tool, audit-export, notice, and excluded-path decisions that later host code can consume without duplicating policy.
- [ ] Workspace distrust, unknown/migrated configured values, and a missing/invalid resolver choice default-deny sensitive capabilities with a non-empty notice; the valid configured-`builtin`/resolved-OMP result from `resolveEngine()` remains permitted.
- [ ] The centralized path policy rejects secret/config paths without over-blocking a normal relative source path.
- [ ] Focused tests, `npm run typecheck`, and `npm run compile` pass.
- [ ] Executor report declares `EXECUTOR_MODEL: unic-code`; reviewer is `unic-smart`.

## Dependencies

- none

## Interfaces

- Consumes: existing configured engine vocabulary `"builtin" | "omp"` from `src/ai/settings.ts` (`export type AiEngine = "builtin" | "omp"`) and resolver output from `src/ai/engineChoice.ts` (`EngineChoice { engine: "omp" | "builtin"; requiresConfig: boolean; hint?: string; version?: string; path?: string }`).
- Produces: `resolvePolicy(input): EffectivePolicy` and its exported input/output/context/tool/path types for TASK-AIX07-003. Exact final member names are set by this task's RED tests; it validates configured preference vocabulary, derives effective provider from valid `EngineChoice.engine`, and distinguishes that result from workspace trust without requiring configured/resolved equality.

---

## Discussion

### 2026-08-31 · planner · unic-smart
The policy must govern admission at shared panel funnels, not add logic inside individual `createDbAwareTools`, `createAnalysisTools`, or `createChangePlanTools` implementations. Preserve generic chat even when sensitive capability admission is denied.

---
