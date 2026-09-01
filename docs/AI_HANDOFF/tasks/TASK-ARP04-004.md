# TASK-ARP04-004 — Form wiring gate (verify-only — expected to close not-needed)

- Status: `ready`
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
