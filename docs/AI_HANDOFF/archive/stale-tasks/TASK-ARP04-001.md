# TASK-ARP04-001 — Identity input: pinned strict host-key checking in the argv builder

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1–§4 (ARP-04.1)

## Goal

Make the host-identity policy explicit and fail-closed at the pure argv builder: `buildTunnelArgs` gains the pinned pair `-o StrictHostKeyChecking=yes` (beside the existing `ExitOnForwardFailure=yes` / `BatchMode=yes`), while a test proves the generated argv can **never** carry a host-key-relaxing token (`StrictHostKeyChecking=no|ask|accept-new|off`) nor a `UserKnownHostsFile` option. No new config field, no form change.

## Target Files

- `src/core/sshTunnel.ts` — `buildTunnelArgs` gains `args.push("-o", "StrictHostKeyChecking=yes")` next to the `ExitOnForwardFailure=yes`/`BatchMode=yes` pushes (after `-o BatchMode=yes`, before `-L`). Nothing else changes — `validate()` and every existing `TunnelError` path stay intact.
- `src/core/__tests__/sshTunnel.test.ts` — add the new cases below; the existing `arrayContaining`-style assertions are unaffected (verified: no exact-argv equality assertion exists anywhere).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | minimal config pins strict checking | `buildTunnelArgs({ host: "bastion", port: 5433 })` → argv contains the pair `["-o", "StrictHostKeyChecking=yes"]` as its own two tokens | minimal config |
| 2 | edge: cannot relax | argv never contains a relaxing host-key token | for `{host}` minimal, `{host,user,identityFile}`, and `{host,identityFile}` configs → argv contains NO token matching `/StrictHostKeyChecking=(no\|ask\|accept-new\|off)/i` and NO `UserKnownHostsFile` option (any value). Assert with `expect(args.join(" ")).not.toMatch(...)` — RED on today's code? No: today's argv has no relaxing token either, so this case is GREEN immediately. It is a **guard pin**, not RED-first — it locks the invariant so a future "fix" cannot relax the policy |
| 3 | edge: layout preserved | non-relaxing arg layout unchanged | with `user` + `identityFile` + `port` + `targetPort` → `-i <id>`, `-l <user>`, `-p <port>`, `-L 127.0.0.1:<local>:127.0.0.1:<target>` all still present, in that semantic layout (assert `arrayContaining` on each pair) |
| 4 | edge: BatchMode coexistence | no-interactive-TOFU guarantee survives | argv still contains `-o BatchMode=yes` alongside `-o StrictHostKeyChecking=yes` — an unknown host key cannot fall through to an interactive prompt (both `arrayContaining` and `indexOf(BatchMode) < indexOf(StrictHostKeyChecking)`-order-friendly: both must be present) |
| 5 | edge: option pair shape | flag is a separate token pair, never glued | no token equals `-oStrictHostKeyChecking=yes` and no bare `-oStrictHostKeyChecking` token (each `-o` is followed by exactly one value token) |
| 6 | regression | existing validation unchanged | `{host:""}` → `TunnelError` code `emptyHost`; `{host:"h", identityFile:"relative/key"}` → `badIdentityFile`; `{host:"h", port:70000}` → `badPort` — all still throw with the same codes (RED first on the OLD code only for the case-1 strict-flag presence; cases 2–6 are guards/regressions) |

RED-first proof: case 1 fails on today's `buildTunnelArgs` (no `StrictHostKeyChecking` token) → implement the two-token push → GREEN. Case 2 is a guard pin that is already GREEN and must stay GREEN.

## Test Files

- `src/core/__tests__/sshTunnel.test.ts` — add cases above under the existing `describe("buildTunnelArgs")`.

## Verification Commands

```bash
# sshTunnel.ts → tests-map [sshTunnel.test.ts, sshTunnelManager.test.ts]; pin the OWNED unit file
# only — sshTunnelManager.test.ts belongs to TASK-ARP04-002, which runs in a later wave.
npx vitest run src/core/__tests__/sshTunnel.test.ts
npm run typecheck
npm run compile
npm test   # full suite mandated for at least one task in the cycle — this is it (pure argv builder)
```

No `lint` script exists in this repo (roadmap §portfolio constraint) — `typecheck` + `compile` are the static gates.

## Acceptance Criteria

- [ ] `buildTunnelArgs` emits the pinned pair `-o StrictHostKeyChecking=yes` on every config shape.
- [ ] No generated argv (any config shape) contains `StrictHostKeyChecking=no|ask|accept-new|off` or `UserKnownHostsFile` — a future relaxation cannot pass review.
- [ ] `-o BatchMode=yes` still present; `-i`/`-l`/`-p`/`-L` rendering unchanged; all existing `TunnelError` rejects unchanged.
- [ ] `src/core/sshTunnel.ts` is the ONLY source file changed; `TunnelConfig` gains no field; no form/config change.
- [ ] All new + existing `sshTunnel.test.ts` cases pass; `npm run typecheck`, `npm run compile`, and full `npm test` green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP04-000 — the ADR's "chosen identity policy" + "downgrade/no-go criteria" bind this task. Wave 1.
- Downgrade/no-go trigger note: the criteria fire ONLY from **manual OpenSSH validation on macOS/Linux/Windows** (real-world, per roadmap acceptance) — NOT from this task's tests (pure argv, no real OpenSSH). Do not wait for an automated RED that cannot occur.

## Interfaces

- Consumes: the ADR's policy decision (`docs/decisions/0001-ssh-host-key-identity-policy.md`); the existing `TunnelConfig` type and `buildTunnelArgs(cfg: TunnelConfig): string[]` signature (`src/core/sshTunnel.ts:116-132`) — unchanged.
- Produces: `buildTunnelArgs` now emits `-o StrictHostKeyChecking=yes`. Downstream consumers that spread it — `SshTunnelManager.spawnAndProve` (`src/core/sshTunnelManager.ts:209-213`) — inherit the flag by construction (TASK-ARP04-002 pins this in the spawned argv). Signature unchanged, so TASK-ARP04-003's consumption (`resolveAdapter`, `connectionManager.ts:692-700`) is unaffected.

---

## Discussion

### 2026-09-02 · executor · claude-code/unic-code
Implemented per spec. Note: the dispatch prompt's parenthetical ("identity/validation hardening … malformed/missing required identity input rejects; reject any config value that could inject `-o` options") is ALREADY satisfied by the existing `validate()` charset checks (`SAFE_HOST_RE` for host/user, absolute-path rule for identityFile) — host/user cannot contain whitespace/`;`/`$`/`-o` sequences, so no argv element can smuggle an option. Per Target Files ("Nothing else changes — `validate()` and every existing `TunnelError` path stay intact"), no further validation code was added; the new regression test (case 6) pins those paths. RED produced 3 failures, not 1: cases 1, 3, 4 all assert pin PRESENCE (case 4's "both must be present", case 3's arrayContaining includes the pair), so all three legitimately fail pre-implementation; case 2 (relaxation guard) stayed GREEN exactly as the spec predicted.

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/core/__tests__/sshTunnel.test.ts  (pre-implementation)
   ❯ src/core/__tests__/sshTunnel.test.ts  (16 tests | 3 failed) 8ms
   FAIL ... > buildTunnelArgs > pins strict host-key checking on minimal config
   FAIL ... > buildTunnelArgs > keeps the existing -i/-l/-p/-L layout beside the pin
   FAIL ... > buildTunnelArgs > keeps BatchMode=yes alongside the strict pin
   Test Files  1 failed (1)
        Tests  3 failed | 13 passed (16)
  Diff excerpt (case 1): arrayReceived has no "StrictHostKeyChecking=yes" token;
  expected ["-o","StrictHostKeyChecking=yes"] present exactly once.
Verification Output: |
  npx vitest run src/core/__tests__/sshTunnel.test.ts
   ✓ src/core/__tests__/sshTunnel.test.ts  (16 tests) 3ms
   Test Files  1 passed (1) | Tests  16 passed (16)

  npm run typecheck  → tsc --noEmit, exit 0
  npm run compile    → esbuild: build complete, exit 0
  npm test           → Test Files 216 passed | 1 skipped (217)
                       Tests 3013 passed | 2 skipped (3015), exit 0
Status: PASS
Note: none. Only src/core/sshTunnel.ts (+6 lines: pinned "-o","StrictHostKeyChecking=yes" after BatchMode, with ADR 0001 comment) and the test file changed; TunnelConfig untouched; no INDEX/manager files touched; no git add/commit/push. Downgrade criteria (ADR §6) untouched — manual-validation-only trigger, not testable here.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/sshTunnel.test.ts; npm run typecheck; npm run compile; npm test
  result: 16/16 PASS; tsc exit 0; esbuild complete; npm test 3025 passed / 2 skipped (216 files, 1 skipped file)
TEST_PLAN_COVERAGE: all-followed (6/6 cases; 5 edge cases >= min 2)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/core/sshTunnel.ts:133 — the pinned pair is emitted after BatchMode and before -L; confirmed it is the ONLY host-key -o option and case 1 asserts it appears exactly once, so no duplicate/override path exists.
NEXT_STATUS_FOR_INDEX: approved
NOTES: RED evidence real (3 failing tests with assertion diff, not a bare claim). Injection surface closed by construction: host/user SAFE_HOST_RE, identityFile absolute-path-only, port integer — no user value can start with '-' or smuggle an -o option. No UserKnownHostsFile/relaxing token in any config shape (case 2 guard pin). Scope: only sshTunnel.ts + its test file changed.
