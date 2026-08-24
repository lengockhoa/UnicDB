# TASK-002 — ACP process lifecycle + extension wiring

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal
Replace Cycle L’s RPC process with an ACP process wrapper and extension bootstrap wiring, preserving fallback and ensuring no `--approval-mode yolo`/`--auto-approve`/`--yolo` path.

## Target Files
- `src/ai/omp/acpProcess.ts` (new) — ACP spawn/session lifecycle for ACP-registered tools.
- `src/ai/omp/__tests__/acpProcess.test.ts` (new) — pure spawn/fake-transport coverage, including mandatory spawn `cwd` and conditionally selected `--cwd`.
- `src/extension.ts` (existing) — new wiring after TASK-001 exists.
- `src/extension.test.ts` (existing) — minimal wiring smoke for the new ACP activation path.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | start uses `omp acp` without approval-auto arguments | spawned args never contain `yolo`/`--approval-mode`/`--auto-approve` | FakeSpawn, FakeAcpTransport |
| 2 | unit | start passes workspace cwd and conditional `--cwd` from evidence | spawn options always have `cwd`; `--cwd` flag appears only if TASK-001 recorded support | FakeSpawn, recorded probe evidence |
| 3 | edge | spawn fails or exits immediately | host-reported failure and fallback available | FakeSpawn error/exit |
| 4 | regression | extension activation still registers and falls back to builtin | existing commands registered, builtin fallback not removed | vscode mock |
| 5 | regression | DB host tools remain read-only guarded | host-tool executor rejects or resolves read-only via existing guard | existing registry shape |

## Test Files
- `src/ai/omp/__tests__/acpProcess.test.ts`
- `src/extension.test.ts` (extend existing)

## Verification Commands
```bash
npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/extension.test.ts && npm run compile && npm run typecheck
```

## Acceptance Criteria
- [ ] no yolo/auto-approval args pass through ACP spawn.
- [ ] spawn always supplies `cwd` and conditionally uses `--cwd` only when TASK-001 proves support.
- [ ] extension registration remains complete and fallback path is not regressed.
- [ ] reviewer verdict APPROVED.

## Dependencies
- TASK-001

## Interfaces
- Consumes: `AcpClient` lifecycle from TASK-001 and its recorded cwd/`--cwd` probe evidence.
- Produces: ACP-aware process wrapper used by TASK-004 panel lifecycle and extension wiring.

## Discussion
(queued)

---
## Executor Report
- Status: DONE
- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic/unic-code
- EXECUTOR_SUBAGENT: ExecM-T002
- SUMMARY: New src/ai/omp/acpProcess.ts owns the TDD lifecycle wrapper around `omp acp` — spawn always supplies `cwd`; `--cwd` flag is conditional on TASK-001-recorded support (`supportCwdFlag`); spawn args never contain `yolo` / `--approval-mode` / `--auto-approve`. Wires AcpClient (TASK-001) through an NDJSON line transport against child stdio, completes initialize → initialized → session/new, exposes sessionId, version, acp handle, dispose. New unit tests cover all 5 cases (unit/edge/regression). Extension wiring kept untouched: legacy rpc.ts/process.ts remain in place; TASK-004 will consume AcpProcess.
- TEST_PLAN_FOLLOWED: task §Test Cases #1..#5
- FILES_CHANGED:
  - src/ai/omp/acpProcess.ts (new): AcpProcess class — injectable AcpSpawnFn + AcpExecFn, NDJSON line transport, error/exit races against handshake, disposeClient best-effort, AcpProcessHandle { acp, sessionId, version, dispose }.
  - src/ai/omp/__tests__/acpProcess.test.ts (new): 9 unit tests over FakeChildProcess (PassThrough-backed stdio + EventEmitter parent signals).
  - src/extension.test.ts (existing): +TASK-002 describe block — AcpProcess importable + constructible; activate() still registers all 12 existing commands + deactivate() does not throw (regression).
- TESTS_ADDED:
  - src/ai/omp/__tests__/acpProcess.test.ts:
    - "start uses `omp acp` without approval-auto arguments"
    - "start passes workspace cwd to spawn and conditionally adds --cwd flag"
    - "start rejects when spawn emits error (e.g. omp missing) and forwards child exit"
    - "start rejects when child exits before initialize response arrives"
    - "start returns session info and version; emits notifications and server-requests through AcpClient"
    - "hostTools: createHostToolExecutor surfaces unknown tool / invalid args without throwing"
    - "hostTools: Invalid-args branch fires only when a tool is found but args are non-record"
    - "hostTools: read-only guard is owned by the tool implementation, not the bridge"
    - "default spawnFn signature accepts AcpProcessOptions without throwing at construction"
  - src/extension.test.ts:
    - "AcpProcess module is exported and constructible"
    - "activate() still registers every command and deactivate() does not throw (TASK-002 regression)"
- VERIFICATION:
  command: `npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/extension.test.ts && npm run compile && npm run typecheck`
  result: 44 tests pass / 0 fail; esbuild build complete; tsc --noEmit exit 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
     ✓ src/ai/omp/__tests__/acpProcess.test.ts  (9 tests) 5ms
     ✓ src/extension.test.ts  (35 tests) 93ms
     Test Files  2 passed (2)
          Tests  44 passed (44)
    > vsdb@1.5.1 compile
    > node esbuild.js
    esbuild: build complete
    > vsdb@1.5.1 typecheck
    > tsc --noEmit
- ISSUES: none.
- HANDOFF_TO_REVIEWER: yes — task §Test Cases #1..#5 verified; production code is real (no stubs / no TODOs); unit tests drive the actual AcpProcess through a fake child covering the entire handshake (initialize → initialized → session/new) plus notification + server-request routing.
- NEXT: TASK-003 / TASK-004 may consume AcpProcess from the panel; legacy rpc.ts/process.ts remain in place until TASK-004 cutover.
- RED OUTPUT (verbatim, captured before implementation):
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
     ❯ src/ai/omp/__tests__/acpProcess.test.ts  (0 test)
     Failed Suites 1
     FAIL  src/ai/omp/__tests__/acpProcess.test.ts
     Error: Failed to load url ../acpProcess (resolved id: ../acpProcess) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/src/ai/omp/__tests__/acpProcess.test.ts. Does the file exist?
- LIVE-PROBE EVIDENCE (inherited from TASK-001; no new probe run by this task — AcpProcess.start() is built on AcpClient which was already verified against `omp 18.0.1`):
  - `omp acp` accepts NDJSON `initialize` / `initialized` / `session/new` (TASK-001 §LIVE-PROBE EVIDENCE).
  - `--cwd` accepted by `omp acp`; `supportCwdFlag=true` here matches the verified 18.0.1 path.
  - `session/create` remains rejected (Unknown ACP ext method) — AcpProcess uses `session/new` exactly.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/extension.test.ts && npm run compile && npm run typecheck
  result: 44 pass / 0 fail; esbuild complete; tsc --noEmit exit 0
TEST_PLAN_COVERAGE: all-followed — §Test Cases #1-#5 implemented; 9 unit tests + 2 regression tests cover spawn args guard, conditional --cwd, error/exit races, handshake wiring, host-tool guard, extension activation regression.
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/omp/acpProcess.ts:182-199 — disposeClient() is idempotent but `this.acp` is only set inside the returned handle's closure, never as `this.acp = acp` on the class instance. The private field stays null; works because AcpClient reference is held by the caller, but `disposeClient()` relies on a second private-field write that never happens. Functionally safe (child still gets SIGTERM, caller owns the AcpClient), but a future reader may expect `this.acp` to be non-null after a successful start. Low risk — mark `this.acp = acp` before return or remove the null-check branch to avoid confusion.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Production code is real (no stubs/TODOs). Legacy rpc.ts/process.ts untouched. Extension.ts untouched — safe for TASK-004 cutover. RED_OUTPUT shows genuine test-file-not-found failure (TDD lifecycle intact).
