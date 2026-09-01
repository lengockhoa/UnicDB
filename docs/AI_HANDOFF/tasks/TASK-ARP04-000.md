# TASK-ARP04-000 — ADR: SSH host-key identity policy (mandatory gate)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1–§3

## Goal

Write the architecture/security decision that ARP-04's mandatory gate requires, **before any source change**: an ADR in the new `docs/decisions/` directory documenting the tunnel threat model, the supported platforms' current OpenSSH trust behavior, the chosen host-identity policy (explicit fail-closed strict checking via the user's default OpenSSH trust store), rejected alternatives, and the explicit downgrade/no-go criteria that bound TASK-ARP04-001.

## Target Files

- `docs/decisions/` — **new directory** (does not exist today — verified). This task bootstraps it.
- `docs/decisions/0001-ssh-host-key-identity-policy.md` — **new file** (new) — the ADR.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | N/A | Docs task — no code | N/A per RULES: zero testable behavior. Verification is the content checklist below and the acceptance checklist; there is no executable test for documentation. | — |

## Test Files

- (none) — no test file. Docs-only task; verification is §5's content checklist, not a vitest run.

## Verification Commands

```bash
test -f docs/decisions/0001-ssh-host-key-identity-policy.md
grep -qi "StrictHostKeyChecking" docs/decisions/0001-ssh-host-key-identity-policy.md
grep -qi "known_hosts" docs/decisions/0001-ssh-host-key-identity-policy.md
grep -qi "downgrade" docs/decisions/0001-ssh-host-key-identity-policy.md
```

Content checklist — the ADR MUST document each of these (check off in the Executor Report):

- [ ] Supported platforms: `listeningPids` in `src/core/sshTunnelManager.ts:69-125` maps darwin/freebsd/openbsd → `lsof`, win32 → `netstat -ano -p tcp`, linux → `ss -ltnp`. Record these + any OpenSSH-version caveat (e.g. Windows bundled OpenSSH).
- [ ] Current OpenSSH trust behavior (today, before this cycle): `buildTunnelArgs` emits NO `StrictHostKeyChecking`, NO `UserKnownHostsFile`, NO fingerprint pinning; `-o BatchMode=yes` makes an unknown host key fail at connect (no interactive TOFU prompt); ssh implicitly uses the user's `~/.ssh/known_hosts` + the binary's compiled-in default policy.
- [ ] Chosen identity policy: explicit fail-closed strict checking with the user's default OpenSSH trust store — `buildTunnelArgs` gains `-o StrictHostKeyChecking=yes` (pinned) and does NOT add `UserKnownHostsFile` (users keep `~/.ssh/known_hosts` + system defaults). **Config-override nuance (record explicitly):** an OpenSSH `-o` command-line option overrides `~/.ssh/config`, so a user who deliberately set `StrictHostKeyChecking=no`/`ask` for the bastion in their config will now fail — this is an **intended fail-closed behavior change**. It is NOT stricter for the common case (users who already trust their bastion have the key in `~/.ssh/known_hosts`, exactly what `yes` requires; anyone who hasn't trusted the bastion already fails under `BatchMode`) — the ADR states both precisely rather than a blanket "not stricter".
- [ ] Rejected alternatives, each with the reason: (a) `accept-new` + VSDB-managed `known_hosts` TOFU pinning store — cross-user migration surprise, requires form/persistence wiring (wave-4 scope), roadmap excludes secret-persistence adjacency; (b) per-connection fingerprint pinning — same scope reasons, documented as the **upgrade path**; (c) any `accept`/`none` relaxation — **prohibited by charter**.
- [ ] Downgrade/no-go criteria: the trigger fires ONLY from **MANUAL OpenSSH validation on macOS/Linux/Windows** (real-world, per roadmap acceptance) — NOT from the automated tests, which are pure-argv (001) / fake-ssh-shim (002) and never run real OpenSSH, so no automated RED can fire it. If manual validation surfaces a real-world break (Windows bundled OpenSSH incompatibility with `strict=yes`, or any supported platform break) → revert to documenting the current implicit behavior with **no new flags**; ARP-04.1 then shrinks to validation-only hardening (its "argv cannot relax host-key checks" test still ships). A no-go is recorded in the ADR.

## Acceptance Criteria

- [ ] `docs/decisions/` exists and `docs/decisions/0001-ssh-host-key-identity-policy.md` exists.
- [ ] Every content-checklist bullet above is present and source-anchored (the checklist is written into the file, not just the plan).
- [ ] The policy section names the exact flag change (`-o StrictHostKeyChecking=yes`, no `UserKnownHostsFile`) and names what is deliberately NOT done.
- [ ] The downgrade/no-go criteria explicitly bind TASK-ARP04-001's implementation scope.
- [ ] All four verification `grep` commands exit 0.
- [ ] No `src/` file was created or modified by this task.

## Dependencies

- (none) — this is the Wave-0 gate; every source task in the cycle depends on it.

## Interfaces

- Consumes: (none). Grounding only — read `src/core/sshTunnel.ts` (`buildTunnelArgs`, `TunnelConfig`) and `src/core/sshTunnelManager.ts` (`listeningPids` platform mapping) to cite current behavior accurately.
- Produces: `docs/decisions/0001-ssh-host-key-identity-policy.md` — the ADR that records the policy the downstream tasks must implement. TASK-ARP04-001 reads the "chosen identity policy" + "downgrade/no-go criteria" sections; TASK-ARP04-003 reads the same; TASK-ARP04-004 reads the "no form input required" conclusion.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
