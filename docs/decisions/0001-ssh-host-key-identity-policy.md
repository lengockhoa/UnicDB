# ADR 0001 — SSH Host-Key Identity Policy for the UnicDB Tunnel

- Status: **Accepted** (gating ARP-04 — this ADR must land before any source change in the cycle; TASK-ARP04-001, -002, -003 implement it, -004 verifies no new user-facing surface)
- Date: 2026-09-02
- Deciders: UnicDB maintainers (recorded in `docs/AI_HANDOFF/PLAN.md` §3, cycle ARP-04 commissioning brief)
- Scope: `src/core/sshTunnel.ts` (`buildTunnelArgs`, `TunnelConfig`), `src/core/sshTunnelManager.ts` (`listeningPids`, readiness proof)

## 1. Context and threat model

UnicDB reaches remote PostgreSQL through a local SSH port-forward spawned by
`SshTunnelManager`. Two identity questions exist and must not be conflated:

1. **Remote identity — "who is the bastion I am about to feed credentials to?"**
   Governed by OpenSSH host-key checking (`StrictHostKeyChecking`, the
   `known_hosts` trust store, fingerprint pinning). A man-in-the-middle that
   answers the tunnel connect before the real bastion does can otherwise
   capture the DB handshake, credentials, and data.
2. **Local provenance — "which local process owns the forwarded port?"**
   Governed by the manager's existing readiness proof: the `Local forwarding
   listening on 127.0.0.1 port N` debug line (which requires the `-v` flag)
   followed by a PID-identity match via `listeningPids` (`src/core/sshTunnelManager.ts:69-125`),
   fail-closed when ownership cannot be determined. This is **local provenance
   only** — it proves the listen socket belongs to the SSH child we spawned. It
   is **not** a proof of the remote host's identity and must never be cited as
   one.

This ADR decides policy (1). Policy (2) already exists, is fail-closed, and
must not be perturbed (see §3).

## 2. Supported platforms and OpenSSH constraints

`listeningPids` (`src/core/sshTunnelManager.ts:69-125`) maps platforms to
socket-table tools:

| Platform | Tool | Invocation | Parsing |
|---|---|---|---|
| darwin / freebsd / openbsd | `lsof` | `lsof -t -iTCP:<port> -sTCP:LISTEN -n -P` | one PID per line |
| win32 | `netstat` | `netstat -ano -p tcp` | `LISTENING` rows, local addr ends with `:<port>`, PID in col 5 (`-ano` works without admin) |
| linux | `ss` | `ss -ltnp 'sport = :<port>'` | `pid=(\d+)` matches from `users:(("ssh",pid=N,...))` |

Tool unavailable, spawn error, or 2 s timeout ⇒ empty PID set ⇒ fail closed.

The ssh binary itself is **whatever OpenSSH the platform provides** — UnicDB
does not bundle one:

- **macOS**: system OpenSSH (`/usr/bin/ssh`), Apple-maintained; default
  `StrictHostKeyChecking=ask` (compiled-in OpenSSH default).
- **Linux**: distro OpenSSH (Debian/Ubuntu, Fedora, Arch...); defaults are
  normally `ask`, but distros patch default config (`/etc/ssh/ssh_config`,
  includes under `/etc/ssh/ssh_config.d/`) and a user's `~/.ssh/config` can
  set anything, including `StrictHostKeyChecking=no`.
- **Windows**: the OS-optional *bundled* OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`)
  or the user-installed Win32-OpenSSH from GitHub releases. Version coverage
  and config-default behavior vary between builds and Windows installs; this
  variance is exactly why the policy below is **pinned at argv level** instead
  of trusting platform defaults.

Because the compiled-in default policy is `ask` and is silently overridable by
user/system config per platform, today's posture is *emergent* — see §3.

## 3. Current trust behavior (today, before ARP-04 source changes)

Verified against source (cite: `src/core/sshTunnel.ts:116-132`):

- `buildTunnelArgs` emits **no host-key options at all**: no
  `StrictHostKeyChecking`, no `UserKnownHostsFile`, no fingerprint pinning,
  no `GlobalKnownHostsFile`. A repo-wide grep finds zero such references in
  `src/` today.
- The argv is: `ssh [-i identity] [-l user] [-p port] <host> -v -N -T
  -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:<local>:127.0.0.1:<target>`.
- `-o BatchMode=yes` disables all interactive prompting. Consequence for an
  **unknown or changed host key**: ssh cannot fall through to the interactive
  TOFU (trust-on-first-use) prompt; the connection **fails closed** at connect.
  So today UnicDB already never silently accepts a first-contact key — but only
  as a *side effect* of BatchMode.
- Host-key trust resolution is therefore **implicit**: ssh consults the user's
  `~/.ssh/known_hosts` plus the system default store and the binary's
  compiled-in default policy (`ask`), as further modified by the user's
  `~/.ssh/config` and `/etc/ssh/ssh_config`.
- Risk: because the policy is emergent, a platform/binary/config whose
  effective default drifts to `no`/`off` would **silently accept unknown
  hosts** with no source-level guard in UnicDB. A default of `ask` merely
  degrades to a BatchMode connect failure. Nothing in the argv protects
  against that drift.
- Readiness proof recap: listener debug line + `listeningPids` PID-identity
  match, fail-closed on mismatch or indeterminable owner. **Local provenance
  only** — it says nothing about the remote bastion's identity (§1).

## 4. Chosen policy — explicit fail-closed strict checking with the user's default trust store

**Decision.** `buildTunnelArgs` pins `-o StrictHostKeyChecking=yes` (as its own
`"-o", "StrictHostKeyChecking=yes"` argv pair, beside the existing
`ExitOnForwardFailure=yes` / `BatchMode=yes` pairs), and deliberately does
**NOT** add `UserKnownHostsFile` or any other trust-store override.

Effects:

- **Fail-closed by construction, not by emergence.** `yes` requires the host
  key to already be in `known_hosts`; an unknown or changed key aborts the
  connection regardless of platform defaults, compiled-in policy, or
  `/etc/ssh/ssh_config` drift. The BatchMode side effect becomes an explicit
  policy statement.
- **Trust store stays the user's.** With no `UserKnownHostsFile` option, ssh
  keeps using the user's `~/.ssh/known_hosts` + system defaults. There is no
  UnicDB-owned key file, no first-connect regression for anyone who has already
  trusted their bastion, and no secret-persistence adjacency to wire.
- **Stricter-ness, stated precisely.** For the common case this is **not
  stricter**: a user who already trusts the bastion has the key in
  `~/.ssh/known_hosts`, which is exactly what `yes` requires; a user who never
  trusted the bastion already fails at connect under `BatchMode=yes`. The one
  population that experiences a change is below.
- **Config-override nuance (intended fail-closed change).** An OpenSSH `-o`
  command-line option **overrides `~/.ssh/config`**. A user who deliberately
  set `StrictHostKeyChecking=no`/`ask` for the bastion in their config will
  now fail. This is **intended**: UnicDB will not tunnel DB traffic through a
  host the user has configured to check loosely, even when the user asked ssh
  to. Documented here as deliberate; it must appear in release notes for the
  release carrying ARP-04.
- **Orthogonality (must-not-break).** `StrictHostKeyChecking` governs *remote*
  identity (§1.1); the `listeningPids` PID proof governs *local* provenance
  (§1.2). Both stay fail-closed and both must pass before DB traffic flows.
  The readiness sequence (`Local forwarding listening` line → `listeningPids`
  → identity match) is untouched by this decision.
- **What is deliberately NOT done:** no `UserKnownHostsFile`, no
  `GlobalKnownHostsFile`, no `accept-new`, no fingerprint pinning, no new
  `TunnelConfig` field, no form input (`src/ui/connectionFormMessages.ts`
  exposes only `tunnelHost`, `tunnelPort`, `tunnelUser`, `tunnelIdentityFile`
  — unchanged). The policy is argv-level and implicit; TASK-ARP04-004 closes
  verify-only / not-needed on that basis.

## 5. Rejected alternatives

- **(a) `accept-new` + UnicDB-managed `known_hosts` TOFU pinning store.**
  First connect would silently write a host key the user never approved
  (TOFU), which is a cross-user migration surprise for anyone sharing a
  machine/image, and the store needs form/persistence wiring (wave-4 scope)
  plus secret-persistence adjacency that the roadmap explicitly excludes.
- **(b) Per-connection fingerprint pinning** (`@cert-authority`/`@revoked`
  markers or hashed per-host entries keyed per connection). Rejected for the
  same scope reasons; recorded as the documented **upgrade path** if a
  stronger identity claim is ever required. Any future adoption goes through a
  new ADR.
- **(c) Any `accept` / `none` relaxation.** **Prohibited by charter** — UnicDB
  never disables or weakens host-key checking. The argv-level guarantee
  (TASK-ARP04-001) exists so no future change can smuggle one in.

## 6. Downgrade / no-go criteria (binding on TASK-ARP04-001)

- **Trigger source.** The no-go fires **only from manual OpenSSH validation on
  macOS/Linux/Windows** (real-world, per roadmap acceptance). It **cannot**
  fire from the automated tests: 001's tests are pure-argv assertions and
  002's use the `fake-ssh.mjs` shim (plus `fake-ssh-foreign.mjs`); neither
  runs real OpenSSH, so no automated RED can trigger the downgrade. A fresh
  executor must not wait for such a RED.
- **If manual validation surfaces a real-world break** — e.g. a supported
  platform's bundled OpenSSH (most plausibly the Windows bundled
  `System32\OpenSSH`) rejecting or misbehaving on `StrictHostKeyChecking=yes`,
  or any supported-platform break: revert to **documenting the current
  implicit behavior with no new flags** (i.e. drop the `-o` pin; §3 becomes
  the standing description again). The no-go and its evidence are then
  recorded in this ADR and the cycle's acceptance adjusts.
- **What survives a no-go.** ARP-04.1 shrinks to **validation-only
  hardening**: its "generated argv cannot relax host-key checks" test still
  ships, because asserting the **absence** of relaxing tokens
  (`StrictHostKeyChecking=no|ask|accept-new|off`, any `UserKnownHostsFile`)
  requires no new flag. Even without the pin, `buildTunnelArgs` must never
  emit a relaxing option.
- The decision and its evidence are the deliverable; the flag is the default
  implementation of that decision, not the decision itself.

## 7. Out of scope — TLS / remote-DB identity claims

This ADR makes **no claim** about PostgreSQL TLS identity (server
certificates, `sslmode`, certificate verification to the remote DB) and adds
no TLS option to the tunnel argv. Remote-DB TLS identity is charter
out-of-scope for ARP-04; any such claim requires source evidence in a future
ADR. The only identity statements made here are the SSH host-key policy (§4)
and the local PID provenance recap (§3).

## 8. Consequences

- TASK-ARP04-001 implements §4 in `buildTunnelArgs` and pins the no-relaxation
  argv guarantee (§6 survives-no-go clause).
- TASK-ARP04-002 asserts the spawned argv (via recording shim) carries the
  pin — only after 001 lands; chain order 000 → 001 → 002 → 003 → 004.
- TASK-ARP04-003 keeps manager integration (edit/delete/probe stop semantics,
  loopback routing) intact; no host-key logic lives in the manager.
- TASK-ARP04-004 confirms no form/config surface change and closes
  not-needed with evidence.
- Release notes for the shipping release must mention the §4 config-override
  behavior change.
