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
- [ ] Rejected alternatives, each with the reason: (a) `accept-new` + UnicDB-managed `known_hosts` TOFU pinning store — cross-user migration surprise, requires form/persistence wiring (wave-4 scope), roadmap excludes secret-persistence adjacency; (b) per-connection fingerprint pinning — same scope reasons, documented as the **upgrade path**; (c) any `accept`/`none` relaxation — **prohibited by charter**.
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

- (executor, 2026-09-02) Filename conflict resolved in favor of the task file: Target Files / Verification Commands name `0001-ssh-host-key-identity-policy.md`, but the orchestrator prompt said `0001-tunnel-host-key-policy.md`. Per RULES the task file is authoritative — used `0001-ssh-host-key-identity-policy.md` (the orchestrator's `git status docs/decisions/` evidence requirement still holds: the untracked dir shows both created files).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: N/A — docs task (Test Plan row 1 is N/A per RULES: zero testable behavior; there is no executable test for documentation, so no RED phase applies)

Content checklist (all verified by grep in-turn):

- [x] 1. Supported platforms — §2: darwin/freebsd/openbsd → `lsof`, win32 → `netstat -ano -p tcp`, linux → `ss -ltnp`; OpenSSH-version caveat recorded (Windows bundled `System32\OpenSSH`, distro-patched defaults, user `~/.ssh/config`).
- [x] 2. Current trust behavior — §3: `buildTunnelArgs` emits no host-key options (cited `src/core/sshTunnel.ts:116-132`); `BatchMode=yes` fails unknown/changed keys at connect (no interactive TOFU); implicit `~/.ssh/known_hosts` + compiled-in default policy; readiness proof = listener line + `listeningPids` PID identity (fail-closed) — labeled **local provenance only, NOT remote-identity proof** (§1).
- [x] 3. Chosen policy — §4: pin `-o StrictHostKeyChecking=yes` in `buildTunnelArgs`; `-o` overrides `~/.ssh/config` (users who deliberately relaxed to `no`/`ask` now fail — intended fail-closed change, documented precisely incl. the "not stricter for the common case" nuance); NO `UserKnownHostsFile` (users keep their trust store); §8 requires release-notes mention.
- [x] 4. Rejected alternatives — §5: (a) `accept-new` + UnicDB-managed TOFU store (cross-user migration surprise + form/persistence wiring out of charter); (b) per-connection fingerprint pinning (documented upgrade path); (c) any `accept`/`none` relaxation (prohibited by charter).
- [x] 5. Downgrade/no-go criteria — §6: fires ONLY from manual OpenSSH validation on macOS/Linux/Windows, never from automated pure-argv (001) / fake-ssh-shim (002) tests; break ⇒ revert to implicit-behavior documentation with no new flags; ARP-04.1 shrinks to validation-only hardening and the argv-never-relaxes guarantee still ships.
- [x] 6. TLS scope note — §7: no remote-DB TLS identity claims without source evidence; charter out-of-scope for ARP-04.

Verification Output:

```
$ test -f docs/decisions/0001-ssh-host-key-identity-policy.md        → exit 0
$ grep -qi "StrictHostKeyChecking" docs/decisions/0001-ssh-host-key-identity-policy.md → exit 0
$ grep -qi "known_hosts" docs/decisions/0001-ssh-host-key-identity-policy.md          → exit 0
$ grep -qi "downgrade" docs/decisions/0001-ssh-host-key-identity-policy.md            → exit 0

$ git status --short docs/decisions/
?? docs/decisions/
$ git status --short src/ | wc -l
0
```

Also created: `docs/decisions/README.md` (ADR index: 0001 — SSH host-key identity policy — Accepted, gating ARP-04). No `src/` file created or modified; nothing staged/committed.

Status: PASS
Note: filename conflict (task file vs orchestrator prompt) resolved per task file — see Discussion.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: test -f + 3 greps (content checklist re-read in full)
  result: all exit 0; ADR file read in full — content checklist items 1-6 all present and source-anchored
TEST_PLAN_COVERAGE: all-followed (N/A — docs task; deliverable is ADR content)
FINDINGS:
  critical: none
  important: none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: ADR meets every checklist bullet: supported platforms + Windows bundled-OpenSSH caveat, current implicit trust behavior (BatchMode side-effect), chosen policy with the config-override nuance stated precisely, rejected alternatives (accept-new TOFU, fingerprint pinning as upgrade path, prohibited relaxation), manual-only downgrade trigger, TLS no-claim. Commit order verified: wave-0 commit f5c847c contains only docs/decisions/ — no src/ change landed before the decision.
