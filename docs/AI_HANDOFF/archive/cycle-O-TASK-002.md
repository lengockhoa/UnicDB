# TASK-002 — AcpProcess session/new envelope fix + list/load on spawned client

- Status: `approved`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.B

## Goal

Fix the `session/new` envelope of `AcpProcess.start()` to `{ cwd, mcpServers: [] }` (fixes the latent `-32603` bug per evidence fact 1) and prove that the client exposed by the handle already has `sessionList()` / `sessionLoad()` running through the real process (fake child) — no new seam.

## Target Files

- `src/ai/omp/acpProcess.ts` — the `session/new` params line: add `mcpServers: []`. Do NOT change anything else (spawn, handshake, version, dispose, watchdog stay the same).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit (happy-regression) | `session/new` frame sends the correct `{cwd, mcpServers: []}` | the 2nd frame the child receives parses to `params` deep-equal `{cwd:"/w",mcpServers:[]}` | existing FakeChildProcess; drive handshake; read stdin buffer |
| 2 | unit (edge-flag) | `supportCwdFlag:false` still spawns cwd correctly + envelope still has `mcpServers: []` | spawn options `cwd === "/w"`; NO `--cwd` arg; `session/new` params still has the full `{cwd, mcpServers: []}` | opts `supportCwdFlag:false` |
| 3 | unit (edge-sessionLoad) | `sessionLoad` through the process handle: result settles + replay buffer is returned (window still open) | `handle.acp.sessionLoad("s1","/w")` resolves with `replay.notifications` containing the 2 notifications in order, `replay.closed === false` (window only closes on the next request — see TASK-001 §Interfaces); the frame sent has `params:{sessionId:"s1",cwd:"/w",mcpServers:[]}` | after handshake, fake child responds `{result:{configOptions:[],modes:{}}}` + feeds 2 `session/update` notifications (both carrying `params.sessionId:"s1"`) |
| 4 | unit (edge-list) | `sessionList` through the process handle: server error propagates intact | `handle.acp.sessionList()` rejects, message contains the error content, `code` keeps `-32603` if the server returned that code | fake child responds `{error:{code:-32603,message:"boom"}}` |
| 5 | unit (regression-lifecycle) | the entire existing lifecycle is unchanged | every existing test in `acpProcess.test.ts` passes untouched (initialize → session/new → sessionId/version/dispose/notifications/server-request wiring); fake child only changes where the envelope is asserted | existing suite |

Fixture note: case 1 is a **regression RED** — the current code (line ~165) sends `{cwd}` without `mcpServers`; the test MUST fail before the fix. Case 3 needs several `await Promise.resolve()` calls between frames, like the existing `driveHandshake` pattern (stdin/stdout in the same tick).

## Test Files

- `src/ai/omp/__tests__/acpProcess.test.ts` — append cases 1–4 (case 5 = the existing suite re-run).

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts
```

(No lint script in `package.json` — N/A.)

## Acceptance Criteria

- [ ] Case 1 RED before fix (paste output), GREEN after.
- [ ] The existing `acpProcess.test.ts` suite passes untouched — lifecycle/permission/watchdog unchanged.
- [ ] No file outside `acpProcess.ts` + the test is edited.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — consumes `AcpClient.sessionList()` / `sessionLoad()` (signature in TASK-001 §Interfaces) on the client returned by `AcpProcess.start()`.

## Interfaces

- Consumes: from TASK-001 — `sessionList(): Promise<AcpSessionListItem[]>`, `sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult>` on `handle.acp`, with `AcpSessionLoadResult { configOptions, modes, replay: AcpReplayBuffer }` (`replay.notifications`, `replay.closed` — window semantics in TASK-001 §Interfaces: closes on the next request, no drain-tick).
- Produces: (no new ones) — `AcpProcessHandle` keeps its shape `{ acp: AcpClient; sessionId: string; version: string; dispose(): void }`; now `acp` carries the 2 methods added in TASK-001. TASK-003 uses them directly.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Note for @executor: evidence fact 1 says `{cwd}` alone → `-32603` on omp 18.0.1. This is a latent bug from Cycle M itself (the old unit test did not catch it because the fake child responds regardless of params; the live smoke sent the right envelope manually). Change exactly the one params line — do not refactor alongside it.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecO-T002
SUMMARY: Added `mcpServers: []` to the `session/new` envelope sent by `AcpProcess.start()` (the latent -32603 bug). Verified `handle.acp.sessionList()` and `handle.acp.sessionLoad()` from TASK-001 surface through the spawned client. No other code changed; lifecycle/permission/watchdog untouched.
TEST_PLAN_FOLLOWED: TASK §4 verbatim — cases #1..#4 appended to `src/ai/omp/__tests__/acpProcess.test.ts`; case #5 covered by the existing suite passing unmodified.
FILES_CHANGED:
  - src/ai/omp/acpProcess.ts:165 — `acp.request("session/new", { cwd: this.opts.cwd })` → `acp.request("session/new", { cwd: this.opts.cwd, mcpServers: [] })`. One line, one property. No other edits.
  - src/ai/omp/__tests__/acpProcess.test.ts: appended 4 tests + a `readStdinFrames` helper. Reads the fake child's stdin PassThrough buffer to assert envelope params.
TESTS_ADDED:
  - src/ai/omp/__tests__/acpProcess.test.ts: session/new frame sends {cwd, mcpServers: []} (regression for latent -32603)
  - src/ai/omp/__tests__/acpProcess.test.ts: supportCwdFlag:false still spawns cwd + session/new envelope carries mcpServers: []
  - src/ai/omp/__tests__/acpProcess.test.ts: handle.acp.sessionLoad resolves with replay buffer (window open across multi-flush)
  - src/ai/omp/__tests__/acpProcess.test.ts: handle.acp.sessionList rejects with server error code + message intact
VERIFICATION:
  command: npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts
  result: 28 pass / 0 fail / exit 0
  output_excerpt: |
    > UnicDB@1.5.1 typecheck
    > tsc --noEmit
    ===
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB
     ✓ src/ai/omp/__tests__/acp.test.ts  (14 tests) 4ms
     ✓ src/ai/omp/__tests__/acpProcess.test.ts  (14 tests) 7ms
     Test Files  2 passed (2)
          Tests  28 passed (28)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

RED evidence (pre-fix, same command on `acpProcess.test.ts` only):
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB

 ❯ src/ai/omp/__tests__/acpProcess.test.ts  (14 tests | 2 failed) 11ms
   ❯ AcpProcess > session/new frame sends {cwd, mcpServers: []} (regression for latent -32603)
     → expected { cwd: '/w' } to deeply equal { cwd: '/w', mcpServers: [] }
   ❯ AcpProcess > supportCwdFlag:false still spawns cwd + session/new envelope carries mcpServers: []
     → expected { cwd: '/w' } to deeply equal { cwd: '/w', mcpServers: [] }

  Test Files  1 failed (1)
       Tests  2 failed | 12 passed (14)
```
Cases #3 and #4 (sessionLoad, sessionList) passed pre-fix because the AcpClient methods were already added by TASK-001 and `handle.acp` already exposes them; the regression contract pinned by case #1 is the only RED that depends on the AcpProcess edit.

## Reviewer Verdict

```
VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (ExecO-T002) — differs from reviewer ✓
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts
  result: 28 pass / 0 fail / exit 0 (typecheck clean)
TEST_PLAN_COVERAGE: all-followed — cases #1-#4 appended verbatim; case #5 = existing 10 tests unmodified (diff is pure insertion, 0 deletions)
FINDINGS:
  critical: none
  important: none
  minor:
    - acpProcess.test.ts:680 — case #5 has no test body; comment documents the implicit
      regression contract. Acceptable anchor per task file's "case 5 = existing suite re-run".
NEXT_STATUS_FOR_INDEX: approved
NOTES: Diff is minimal and exact: acpProcess.ts:165 single-property envelope fix, tests pure-insertion. Envelope pinned via stdin frame assert (WRITE side). sessionLoad params {sessionId, cwd, mcpServers:[]} and sessionList {} verified against acp.ts:166,213-216. Spawn args untouched (["acp"] + conditional --cwd only; no yolo/approval-mode/auto-approve). RED output verbatim with real assertion diffs. extension.ts not touched (TASK-003 scope). Lint script N/A (absent in package.json) — typecheck included instead.
```
