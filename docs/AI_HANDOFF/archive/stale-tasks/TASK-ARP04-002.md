# TASK-ARP04-002 — Lifecycle/race: per-key isolation + fail-closed PID proof + spawned-argv strict pin

- Status: `pending_review`
- Owner: claude-code / unic-code (feature-implementer)
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1–§4 (ARP-04.2)

## Goal

Add the ARP-04 lifecycle/race test coverage to `SshTunnelManager` (reusing the existing `fake-ssh.mjs` shim harness) and prove two things the charter requires: the per-key lifecycle stays fail-closed under concurrency (same-key reuse, different-key isolation, unexpected late exit removes only its own handle, foreign-held port → reject + SIGKILL, idempotent stop), and the spawned argv inherits TASK-ARP04-001's pinned `-o StrictHostKeyChecking=yes` without any ability to relax it. No behavioral change is expected in the manager itself unless a test proves otherwise — the tests lock existing fail-closed behavior and the new strict-flag inheritance.

## Target Files

- `src/core/sshTunnelManager.ts` — change ONLY if a test reveals a real gap; expected: no production change (the manager spreads `buildTunnelArgs` by construction).
- `src/core/__tests__/sshTunnelManager.test.ts` — add the new cases below.
- `src/core/__tests__/fixtures/fake-ssh-foreign.mjs` — **new file** (new): binds the local port with a **detached** grandchild process whose PID ≠ the spawned child's PID, prints the OpenSSH forward line, stays alive until SIGTERM (see Design Note).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (regression pin) | same-key reuse returns the identical handle | two `start(cfg, "k1")` calls resolve to the SAME handle instance (`b === a`), `mgr.list().length === 1` — already implemented; pin stays green | `fake-ssh.mjs` shim |
| 2 | edge: isolation | different-key isolation under stop | `start(cfg,"a")` + `start(cfg,"b")` → `stop("a")` returns true, `list()[0].key === "b"`; after `stopAll()`, `start(cfg,"b")` returns a FRESH handle (`localPort` > 0, new `child`) | `fake-ssh.mjs` shim |
| 3 | edge: late exit | unexpected post-ready exit removes only its own handle | keys "a"+"b" live; externally SIGKILL child "a" → exactly one `TunnelExit { key:"a", intentional:false }`; `list()` no longer has "a"; handle "b" still live | `fake-ssh.mjs` shim |
| 4 | edge: PID mismatch fails closed | foreign-held port rejects and kills the child | `fake-ssh-foreign.mjs` shim: the detached binder holds the port, forward line printed → `start` REJECTS matching `/port <N> is held by another process/`; the spawned child receives SIGKILL; the detached binder is terminated by the test in `finally` (port released). RED on a hypothetically-weak manager; GREEN on today's `proveOwnership` (`sshTunnelManager.ts:258-282`) | `fake-ssh-foreign.mjs` shim |
| 5 | edge: stop idempotent | stop on missing / repeated stop is safe | `stop("missing")` → false; `stopAll()` then `stop("gone")` → false; `stop("k1")` after a successful `stop("k1")` → false; no throw on any path | `fake-ssh.mjs` shim |
| 6 | edge (spawn-path pin) | spawned argv inherits the pinned strict flag | a recording shim writes the spawned argv to a file then execs `fake-ssh.mjs` → `start` succeeds AND the logged argv contains `["-o","StrictHostKeyChecking=yes"]` and no relaxing token (`/StrictHostKeyChecking=(no\|ask\|accept-new\|off)/` absent, no `UserKnownHostsFile`). The manager cannot strip or relax the flag its builder emits | recording shim + `fake-ssh.mjs` |

**Design note for case 4 (`fake-ssh-foreign.mjs`).** Parse `-L` like the existing fixture. Spawn a DETACHED binder: `spawn(process.execPath, ["-e", "<bind 127.0.0.1:port, stay alive, close+exit on SIGTERM>"], { detached: true, stdio: "ignore" })`. Print the binder's PID on a marker line (e.g. `UnicDB_BINDER_PID=<pid>` to stderr) and print the forward line `Local forwarding listening on 127.0.0.1 port <port>.`. Stay alive (like the existing fixture's `delay(60_000)`) so the manager does not see an early exit. The manager's `proveOwnership` retries until `listeningPids(port)` is non-empty, then compares against `child.pid` → mismatch → SIGKILL + reject. The TEST reads the binder PID from the marker line and `process.kill(pid, "SIGTERM")` in `finally` so the binder closes and the port is released (the manager already SIGKILLs the foreign fixture child itself). Platform note: `listeningPids` uses `lsof` on darwin/bsd, `ss` on linux, `netstat` on win32 (`sshTunnelManager.ts:69-125`) — the assertion targets the rejection CONTRACT, not the tool text; if a platform's output differs, adapt the assertion to the observed literal while keeping fail-closed (reject + child killed).

## Test Files

- `src/core/__tests__/sshTunnelManager.test.ts` — new cases 1–6 (1, 2, 3, 5 extend/guard the existing suite; 4 and 6 are new).
- `src/core/__tests__/fixtures/fake-ssh-foreign.mjs` — **new** fixture for case 4.
- (case 6 may use an inline recording shim in the test file, following the existing `makeCountingShim` pattern at `sshTunnelManager.test.ts:40-51`.)

## Verification Commands

```bash
# sshTunnelManager.ts → tests-map [sshTunnelManager.test.ts, sshTunnel.test.ts]; wave 2 — runs
# AFTER TASK-ARP04-001 lands (edge-6 spawn-path pin needs 001's builder change), so the tests-map
# overlap with sshTunnel.test.ts is no longer a same-wave conflict; still pin the OWNED manager file.
npx vitest run src/core/__tests__/sshTunnelManager.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in this repo — `typecheck` + `compile` are the static gates.

## Acceptance Criteria

- [ ] Same-key reuse returns the identical handle; different keys keep independent live handles; unexpected late exit removes only its own handle and emits exactly one `TunnelExit` with `intentional:false`.
- [ ] A foreign-held port fails closed: `start` rejects with the held-by-another-process error, the spawned child is SIGKILLed, and the detached binder is cleaned up by the test.
- [ ] `stop`/`stopAll` are idempotent and never throw on missing keys.
- [ ] The spawned argv (via a recording shim) contains `["-o","StrictHostKeyChecking=yes"]` and no relaxing token — the spawn path cannot drop or relax the flag.
- [ ] `src/core/sshTunnelManager.ts` is unchanged UNLESS a test proved a real gap (record the gap + fix in the Executor Report); all new + existing manager tests pass; typecheck + compile green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP04-000 (policy gate), TASK-ARP04-001 (the pinned `-o StrictHostKeyChecking=yes` pair in `buildTunnelArgs` — edge-6's spawn-path pin only turns green after 001's change lands). Wave 2.

## Interfaces

- Consumes: `buildTunnelArgs` from `src/core/sshTunnel.ts` (TASK-ARP04-001) — its new `-o StrictHostKeyChecking=yes` pair; the existing `SshTunnelManager` surface (`start(cfg: TunnelConfig, key: string): Promise<TunnelHandle>`, `stop(key): boolean`, `stopAll()`, `list(): TunnelHandle[]`, `onDidExit(listener): TunnelExitSubscription`, `dispose()`), `TunnelHandle`, `TunnelExit` — all unchanged.
- Produces: test evidence that `SshTunnelManager`'s fail-closed lifecycle holds AND that the spawned argv inherits the strict flag. TASK-ARP04-003 consumes the manager unchanged (`connectionManager.ts:692-700` `tunnels.start(...)`).

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  First TDD run (tests written first, `src/core/sshTunnelManager.ts` byte-identical to main):

  FAIL  src/core/__tests__/sshTunnelManager.test.ts > SshTunnelManager (fixture ssh) > spawned argv inherits the pinned strict host-key flag
  AssertionError: expected [ '-o', …(1) ] to deeply equal [ '-o', 'StrictHostKeyChecking=yes' ]
    Received: [ "-o", "SetEnv=UnicDB_TUNNEL=UnicDB-tunnel:k6" ]

    Test Files  1 failed (1)
    Tests  1 failed | 14 passed (15)

  The single failure was a TEST bug, not a production gap: the manager legitimately appends its
  own `-o SetEnv=UnicDB_TUNNEL=<marker>:<key>` pair after the builder output, so "last -o pair"
  was the wrong assertion. Fixed the test to assert the strict pair exists as ADJACENT elements
  anywhere in the argv (spec wording: "the logged argv contains [\"-o\",\"StrictHostKeyChecking=yes\"]").
  After the test fix: 15/15 green with ZERO production changes — the manager already satisfies
  every case (spec expectation "no production change" held; `proveOwnership` at
  sshTunnelManager.ts:258-282 fails closed exactly as required).
Test Plan Followed: task §Test Cases 1–6 (all 6 implemented) + §Test Files + §Verification Commands
Files Changed:
  - src/core/__tests__/sshTunnelManager.test.ts — added cases 1–6 (same-key reuse identity; different-key isolation + fresh handle after stopAll; late external SIGKILL removes only its own handle + exactly one TunnelExit{key:"a",intentional:false}; foreign-held-port fail-closed reject + SIGKILL proof; stop/stopAll idempotent-false paths; spawned-argv strict-pin via recording shim). Extended makeShim with fixture/recordArgvTo/env options; added waitForFile + isPidAlive helpers.
  - src/core/__tests__/fixtures/fake-ssh-foreign.mjs — NEW fixture per task Design Note: parses -L, spawns a DETACHED grandchild binder (net server on 127.0.0.1:port, PID-file handshake, SIGTERM close, 60s failsafe self-exit so a crashed test cannot leak the port), prints `UnicDB_BINDER_PID=<pid>` + the exact OpenSSH forward line to stderr, stays alive 60s. Control files under $UnicDB_TEST_FOREIGN_DIR: child-pid, binder-pid, caught-sigterm (proves the child was SIGKILLed, not SIGTERMed).
  - src/core/sshTunnelManager.ts — UNCHANGED (no gap found; see RED_OUTPUT).
Verification Output: |
  npx vitest run src/core/__tests__/sshTunnelManager.test.ts
    ✓ src/core/__tests__/sshTunnelManager.test.ts (15 tests) 3562ms
    Test Files  1 passed (1) — Tests 15 passed (15)
  npx vitest run src/core/__tests__/sshTunnelManager.test.ts src/core/__tests__/sshTunnel.test.ts
    Test Files  2 passed (2) — Tests 31 passed (31)
  npm run typecheck   → exit 0 (tsc --noEmit clean)
  npm run compile     → exit 0 (esbuild: build complete)
  npm test            → Test Files 216 passed | 1 skipped (217); Tests 3019 passed | 2 skipped (3021)
Notes:
  - Case 4 runs real `lsof` on darwin (platform gate per task note); assertion targets the
    contract (/port \d+ is held by another process/ + child SIGKILLed), not tool text.
  - The detached binder is terminated in the test's finally AND self-expires after 60s
    (defense in depth against a crashed test run).
  - postAll hook also stopAll()s every manager; no leaked fixture processes from this run
    (two pre-existing stale fake-ssh.mjs processes from Mon on the MAIN repo path predate
    this session and were left alone).
Status: PASS
Note: none

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/sshTunnelManager.test.ts; npm run typecheck; npm run compile
  result: 15/15 PASS (real lsof foreign-port case exercised); tsc exit 0; esbuild complete
TEST_PLAN_COVERAGE: all-followed (6/6 cases; 5 edge cases >= min 2; manager file unchanged as planned)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/core/__tests__/sshTunnelManager.test.ts — RED for case 6 was a test-defect (asserted "last -o pair" but the manager legitimately appends -o SetEnv=...); executor corrected it to an adjacent-pair assertion. Not a production gap and not faked — the failure output is a real AssertionError diff, and the GREEN assertion is end-to-end via the recording shim.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Case 4 genuinely proves PID fail-closed: detached grandchild binder with PID != child.pid, real listeningPids mismatch -> SIGKILL + reject(/port N is held by another process/); caught-sigterm control file absence proves the child was SIGKILLed, not SIGTERMed; binder released in finally + 60s failsafe. Spawn-path pin (case 6) proves the manager cannot drop/relax the strict flag. No secrets in fixtures (PID control files only).
