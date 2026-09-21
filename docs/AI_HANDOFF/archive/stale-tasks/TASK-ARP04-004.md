# TASK-ARP04-004 — Form wiring gate (verify-only — expected to close not-needed)

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1–§4 (ARP-04.4)

## Goal

Verify that the ARP-04 identity policy requires **no form/config wiring**, record the evidence, and close as `not-needed` — mirroring the conditional-gate pattern of ARP-01.3/ARP-02.4. The commissioned policy decision (explicit `-o StrictHostKeyChecking=yes`, user's default trust store) is argv-level and implicit: it adds **no user-facing input**. This task's only deliverable is the recorded evidence that the form/config surface exposes no host-key surface and the existing form suite stays green. IF the inspection ever found a host-key input surface, this task would instead become a real wiring task (strict webview validation + secret-free persistence) — it will not, per the ADR.

## Target Files

- (none to modify) — inspection-only. If the gate finds a gap, THIS task's executor records the gap in the Executor Report + Discussion and files a follow-up; it does not silently wire the form.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | N/A | Verify-only gate — no code | N/A per RULES: the deliverable is recorded evidence, not behavior. Verification is the inspection + existing-suite run below and the acceptance checklist. If the inspection had surfaced a host-key input, this would be a real wiring task — it will not per the ADR decision. | — |

## Verification Commands

```bash
# 1. Confirm NO host-key input surface on the form / config types (expected: empty output).
grep -nE "StrictHostKeyChecking|UserKnownHostsFile|known_hosts|hostKey|fingerprint" \
  src/ui/connectionForm.ts src/ui/connectionFormMessages.ts src/config/types.ts

# 2. (fallback if src/config/types.ts is read-denied in the executor environment) —
#    confirm the tunnel config shape carries no host-key field:
grep -nE "StrictHostKeyChecking|UserKnownHostsFile|known_hosts|hostKey|fingerprint" src/core/sshTunnel.ts

# 3. Existing form suite stays green (form untouched).
npx vitest run src/ui/__tests__/connectionForm.test.ts
npm run typecheck
```

No `lint` script exists in this repo — `typecheck` is the static gate.

## Acceptance Criteria

- [ ] `grep` over `connectionForm.ts`, `connectionFormMessages.ts`, `config/types.ts` (or `sshTunnel.ts` fallback) finds NO host-key/strict-checking/fingerprint token — the form and config surface are unchanged by this cycle.
- [ ] `npx vitest run src/ui/__tests__/connectionForm.test.ts` passes (form suite untouched).
- [ ] The Executor Report records the evidence (the grep outputs + the form message-surface quote `connectionFormMessages.ts:34-37`: `tunnelHost`/`tunnelPort`/`tunnelUser`/`tunnelIdentityFile` — no host-key field) and the explicit close decision: **not-needed**, no form wiring performed.
- [ ] No `src/ui/` file or `src/config/types.ts` was modified.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP04-003 (integration evidence; the gate runs after the chain ships, confirming no form/config follow-up emerged). Wave 4.

## Interfaces

- Consumes: the ADR's "no form input required" conclusion (`docs/decisions/0001-ssh-host-key-identity-policy.md`); `TunnelConfig` (`src/core/sshTunnel.ts`) — unchanged, gains no field.
- Produces: (none — verify-only; no API). The recorded evidence + close decision that concludes the cycle.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code (orchestrator direct — verify-only task, no worktree/agent needed)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: N/A — verify-only gate task; no test cases authored (per task §Test Cases: "N/A per RULES").
Verification Output:

Command 1+2 combined (rg sweep, equivalent to the task's grep):
  rg -l "StrictHostKeyChecking" src
  → src/core/sshTunnel.ts, src/core/__tests__/sshTunnelManager.test.ts, src/core/__tests__/sshTunnel.test.ts  (core-only)
  rg -l "UserKnownHostsFile" src
  → src/core/sshTunnel.ts + the same two core test files  (core-only)
  rg -l "known_hosts" src
  → src/core/sshTunnel.ts  (core-only — appears only in a comment naming the default trust store)
  rg -l "hostKey" src
  → (no output — zero matches in all of src)
  fingerprint: 0 matches in src/ui/connectionForm.ts and src/ui/connectionFormMessages.ts; the only src matches are src/ai/sqlAutocomplete.ts, src/ai/tools/changePlanTool.ts, src/ui/aiSqlCompletionProvider.ts and their AI tests — an unrelated "AI SQL fingerprint" concept, not SSH host keys.
  Net: NO host-key/strict-checking/known_hosts/fingerprint token exists in src/ui/connectionForm.ts, src/ui/connectionFormMessages.ts, or src/config/types.ts. The form/config surface is unchanged by this cycle.

Command 3 (form suite + typecheck):
  npx vitest run src/ui/__tests__/connectionForm.test.ts
    Test Files  1 passed (1) / Tests 11 passed (11)
  npm run typecheck → exit 0 (run at wave-3 boundary, no source changed since)

Form message-surface evidence (src/ui/connectionFormMessages.ts:34-37):
  tunnelHost: string;
  tunnelPort: number | null;
  tunnelUser: string;
  tunnelIdentityFile: string;
  — the only tunnel fields the form knows. No host-key field, per the ADR's "no form input required" conclusion.

Status: PASS
Note: Gate closed **not-needed** — no form/config wiring exists or is required. No src/ui/ or src/config/ file was modified by this cycle (wave commits touched core only). No follow-up task needed.

---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: rg -l "StrictHostKeyChecking|UserKnownHostsFile|known_hosts|hostKey" src && rg -l "hostKey" src && grep -rn "fingerprint" src/ui/connectionForm.ts src/ui/connectionFormMessages.ts && npx vitest run src/ui/__tests__/connectionForm.test.ts && npm run typecheck
  result: host-key tokens only in src/core (sshTunnel.ts + 2 core test files); hostKey zero matches in all of src; fingerprint zero in both form files; form suite 11 pass / 0 fail; typecheck exit 0
TEST_PLAN_COVERAGE: N/A (verify-only gate — no code per task §Test Cases / PLAN §4.4; deliverable is recorded evidence)
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Closure as not-needed is justified and the evidence is honest — every claim re-verified against current source: connectionFormMessages.ts:34-37 exposes only tunnelHost/tunnelPort/tunnelUser/tunnelIdentityFile (no host-key field); no StrictHostKeyChecking/UserKnownHostsFile/known_hosts/hostKey token exists in src/ui/connectionForm.ts, src/ui/connectionFormMessages.ts, or src/config/types.ts (core-only occurrences are sshTunnel.ts + its tests, expected post-ARP-04-001); `git diff 11dbada..HEAD` shows zero src/ui/ or src/config/ changes. RED_OUTPUT N/A is legitimate for a verify-only task.
