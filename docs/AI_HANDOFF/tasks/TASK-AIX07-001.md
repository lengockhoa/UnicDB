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

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-aix07-001

 ❯ src/ai/__tests__/policy.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/__tests__/policy.test.ts [ src/ai/__tests__/policy.test.ts ]
Error: Failed to load url ../policy (resolved id: ../policy) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-aix07-001/src/ai/__tests__/policy.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  no tests
   Start at  22:13:17
   Duration  205ms (transform 20ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 52ms)
```

Correct RED: the suite fails at module load because `src/ai/policy.ts` does not exist yet (`npx vitest run src/ai/__tests__/policy.test.ts`).

Verification Output:

1) `npm test -- src/ai/__tests__/policy.test.ts`

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-aix07-001

 ✓ src/ai/__tests__/policy.test.ts  (7 tests) 3ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  22:14:08
   Duration  194ms (transform 23ms, setup 0ms, collect 23ms, tests 3ms, environment 0ms, prepare 28ms)
```

2) `npm run typecheck`

```
> vsdb@1.27.0 typecheck
> tsc --noEmit
```
(exit 0, no diagnostics)

3) `npm run compile`

```
  dist/webview.js        2.2mb ⚠️
  dist/webview.css      34.2kb
  dist/webview.js.map    4.0mb
  dist/webview.css.map  65.2kb

⚡ Done in 137ms

  dist/extension.js      5.2mb ⚠️
  dist/extension.js.map  9.0mb

⚡ Done in 169ms
esbuild: build complete
```
(exit 0)

Status: PASS
Note: none — no git add/commit/push performed; files left as-is in worktree. Exported surface for TASK-AIX07-003: `resolvePolicy(input: PolicyInput): EffectivePolicy`, `isExcludedWorkspacePath(path): boolean`, `isValidEngineChoice`, `isKnownConfiguredEngine`, types `EffectivePolicy` (provider/context/tools/auditExportAllowed/notice), `PolicyContextDecision` (schema/workspace/rows), `PolicyToolDecision` (database/workspace), `PolicyInput` (workspaceTrusted/configuredEngine/resolvedEngine).

## Reviewer Verdict

### Review · TASK-AIX07-001 · unic-smart
VERDICT: changes_requested
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: npm test -- src/ai/__tests__/policy.test.ts — PASS (1 file, 7 tests); npm run typecheck — PASS; npm run compile — PASS
FINDINGS:
  critical: none
  important:
    - src/ai/policy.ts:82-99,150,159 — `resolvePolicy()` returns shared mutable `ALLOWED_*`/`DENIED_*` objects. A caller can mutate a denied result (for example, `policy.context.schema = true`), causing every subsequent untrusted/invalid policy resolution to admit that sensitive class; return fresh or frozen readonly decisions so default-deny cannot be globally altered.
    - src/ai/policy.ts:181-183 — the credential-path predicate rejects only the exact basename `.env`; conventional secret files such as `.env.local` and `.env.production` return `false` and can enter workspace context. Reject `.env` variants centrally and add assertions for them.
  minor: none
NEXT_STATUS_FOR_INDEX: changes_requested

---

## Executor Report (fix round 1)

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code

RED_OUTPUT:

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB

 ❯ src/ai/__tests__/policy.test.ts  (10 tests | 3 failed) 5ms
   ❯ isExcludedWorkspacePath — centralized path policy > conventional .env variants are excluded, not only the exact .env basename
     → expected false to be true // Object.is equality
   ❯ shared-decision mutation guard — review fix round 1 > mutating a denied result cannot alter later default-deny resolutions
     → expected false to be true // Object.is equality
   ❯ shared-decision mutation guard — review fix round 1 > mutating an allowed result cannot alter later allowed resolutions
     → expected false to be true // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 7 passed (10)
```

Correct RED: `.env.local` returned `false` from `isExcludedWorkspacePath` (finding 2 confirmed), and `Object.isFrozen(first.context)` was `false` for both denied and allowed resolutions (finding 1 confirmed — shared constants were mutable). `npx vitest run src/ai/__tests__/policy.test.ts` pre-fix.

Verification Output:

1) `npx vitest run src/ai/__tests__/policy.test.ts`

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB

 ✓ src/ai/__tests__/policy.test.ts  (10 tests) 2ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

2) `npm run typecheck`

```
> vsdb@1.28.0 typecheck
> tsc --noEmit
```

(exit 0, no diagnostics)

Status: PASS
Note:
- Finding 1: `ALLOWED_CONTEXT`/`DENIED_CONTEXT`/`ALLOWED_TOOLS`/`DENIED_TOOLS` are now `Object.freeze`d with minimal `Readonly<...>` annotations (decision objects are flat, so freeze is a deep freeze); module contract doc-comment updated; no type-signature changes to `EffectivePolicy` consumers.
- Finding 2: the central predicate now rejects `seg === ".env" || seg.startsWith(".env.")`, covering `.env.local`, `.env.production`, and nested variants; new test asserts all three are excluded.
- New tests written first (RED above): one `.env`-variant path test + two mutation-guard tests (mutate denied/allowed result, re-resolve, assert posture unchanged). Verified `src/ui/aiChatPanel.ts` and `src/extension.ts` only read policy decisions, so freezing cannot throw at runtime.
- No git add/commit/push performed.
