# Cycle ARP-04 Plan — Tunnel and Endpoint Identity Hardening

Base: `main` @ `6d8f765` (release v1.39.0). Source roadmap (authoritative): `docs/plans/2026-09-01-vsdb-additive-roadmap.md` → `## ARP-04` (lines 194-233). Mandatory gate: **architecture/security decision before source changes** — satisfied by the Wave-0 ADR task, which all source tasks depend on.

## §1 Intent

**Problem.** The tunnel manager proves the *local* listener belongs to the spawned SSH child (`listeningPids` PID proof), but it makes **no policy statement about SSH host-key identity**. Today `buildTunnelArgs` renders no `StrictHostKeyChecking`, no `UserKnownHostsFile`, no fingerprint pinning — the connection trusts whatever the platform's OpenSSH defaults are (implicitly `~/.ssh/known_hosts` plus the binary's compiled-in default policy). `BatchMode=yes` already fails unknown host keys (no interactive TOFU prompt), but the *policy* is implicit and platform-dependent: a platform/binary whose default is `ask` degrades to a BatchMode failure, and a misconfigured default of `no`/`off` would silently accept unknown hosts with no source-level guard. This cycle decides and records a host-identity policy, then makes it explicit and fail-closed at the argv builder.

**Success definition.** An ADR in `docs/decisions/` records the threat model, the supported platforms' current OpenSSH trust behavior, the chosen identity policy, rejected alternatives, and explicit downgrade/no-go criteria — and the decision lands **before** any source change. The generated tunnel argv then makes the policy explicit: `-o StrictHostKeyChecking=yes` is pinned in `buildTunnelArgs` while no flag that relaxes or bypasses host-key checking (`no`/`ask`/`accept-new`/`off`, `UserKnownHostsFile`, fingerprint pinning) can appear. The manager's per-key lifecycle guarantees stay intact (same-key reuse, different-key isolation, late-exit own-handle removal, PID-mismatch fail-closed, idempotent stop), and connectionManager edit/delete/probe stop only the intended key while loopback routing keeps the persisted host/port untouched. The form requires **no new user-facing config** (no host-key input), so the form task closes as not-needed with evidence.

**User's recorded decisions (from the commissioning brief, treated as authoritative):** policy = **explicit fail-closed strict checking with the user's default OpenSSH trust store** — add `-o StrictHostKeyChecking=yes` (pinned), do NOT add `UserKnownHostsFile` (users keep `~/.ssh/known_hosts` + system defaults). Rejected alternatives to document in the ADR: (a) `accept-new` + VSDB-managed known_hosts (TOFU pinning store) — rejected this cycle (cross-user migration surprise, requires form/persistence wiring, roadmap excludes secret persistence adjacency); (b) per-connection fingerprint pinning — rejected for the same scope reasons, documented as the **upgrade path**; (c) any `accept`/`none` relaxation — **prohibited by charter**.

**In scope.** Threat model/ADR (`docs/decisions/`, new dir); decide known_hosts vs explicit fingerprint policy; if approved, strict validation before spawn; per-key lifecycle tests; argv-level guarantee that generated argv cannot relax host-key checks.

**Out of scope.** SSH client implementation; secret/private-key persistence; disabling host checking; cross-connection tunnel reuse; claims of remote-DB TLS identity (no source evidence exists for it). All per roadmap "Out".

## §2 Scope

| Task | Owned files | Wave | Depends on |
|---|---|---|---|
| TASK-ARP04-000 — ADR: SSH host-key identity policy | `docs/decisions/` (new dir) + `docs/decisions/0001-ssh-host-key-identity-policy.md` (new) | 0 | none |
| TASK-ARP04-001 — identity input (pinned strict checking) | `src/core/sshTunnel.ts` (+ `src/core/__tests__/sshTunnel.test.ts`) | 1 | TASK-ARP04-000 |
| TASK-ARP04-002 — lifecycle/race + fail-closed PID proof | `src/core/sshTunnelManager.ts` (+ `src/core/__tests__/sshTunnelManager.test.ts` + new fixture `src/core/__tests__/fixtures/fake-ssh-foreign.mjs`) | 2 | TASK-ARP04-000, TASK-ARP04-001 |
| TASK-ARP04-003 — manager integration | `src/core/connectionManager.ts` (+ `src/core/__tests__/connectionManager.test.ts`) | 3 | TASK-ARP04-001, TASK-ARP04-002 |
| TASK-ARP04-004 — form wiring gate (verify-only) | none — inspection-only (likely closed not-needed) | 4 | TASK-ARP04-003 |

**Wave structure (chain).** 002's spawn-path pin (edge-6) asserts the spawned argv carries `["-o","StrictHostKeyChecking=yes"]`, which only turns green after 001's `buildTunnelArgs` change lands. So 002 depends on 001 as well as 000, and the cycle runs as a chain: wave 0 = 000 (docs gate), wave 1 = 001 (argv builder), wave 2 = 002 (lifecycle + spawn-path pin), wave 3 = 003 (manager integration), wave 4 = 004 (verify-only gate). Each task owns its files outright — no two tasks share a file in any wave. The tests-map overlap (`sshTunnel.ts` → both `sshTunnel.test.ts` and `sshTunnelManager.test.ts`) is now moot for same-wave disjointness (001 and 002 run in separate waves), but each task still pins **its own** owned test file, and the mandated full `npm test` on 001 plus the wave/cycle-boundary full-suite net cover the cross-coverage.

Out of scope for this cycle (queued portfolio rows, not planned): ARP-05 (cross-driver resilience), ARP-06 (AI policy/usage), ARP-07 (DDL cache invalidation), ARP-08 (console draft recovery, depends on ARP-03), ARP-09 (diagnostics/profiles).

## §3 Approach

**Design in one paragraph.** 000 writes the ADR first (mandatory gate — no source change before it). 001 makes the policy explicit in the pure argv builder: `buildTunnelArgs` adds `args.push("-o", "StrictHostKeyChecking=yes")` beside the existing `ExitOnForwardFailure=yes`/`BatchMode=yes` pairs, and a test proves the argv can never carry a relaxing token. 002 adds lifecycle/race tests to the manager (reusing the existing `fake-ssh.mjs` shim harness, plus one new `fake-ssh-foreign.mjs` fixture that binds the local port with a *detached* process whose PID differs from the spawned child, so the existing `proveOwnership` fail-closed path can be exercised deterministically), and pins that the spawned argv still carries the strict flag. 003 tests connectionManager's intended-key stop semantics (edit/delete/add-probe) against the existing `makeFakeTunnels` harness and pins that `resolveAdapter` routes the adapter to `127.0.0.1:<localPort>` while the persisted `ConnectionConfig` host/port stay unchanged. 004 verifies the form surface exposes no host-key input and closes not-needed.

**Why `StrictHostKeyChecking=yes` and no `UserKnownHostsFile`.** Today the argv has no host-key option; `BatchMode=yes` makes an unknown host key fail at connect (no interactive prompt) and ssh implicitly consults the user's `~/.ssh/known_hosts` + the binary's default policy. Adding `-o StrictHostKeyChecking=yes` **pins** the policy so a platform/binary whose default drifts to `ask`/`no`/`off` cannot silently weaken it. Note the **config-override nuance**: an OpenSSH `-o` command-line option overrides `~/.ssh/config`, so a user who deliberately relaxed `StrictHostKeyChecking=no`/`ask` for the bastion in their config will now fail — this is an **intended, fail-closed behavior change** and the ADR records it explicitly. For the common case it is not stricter: users who already trust their bastion have the key in `~/.ssh/known_hosts` (exactly what `yes` requires), and anyone who has not trusted the bastion already fails under `BatchMode`. NOT adding `UserKnownHostsFile` preserves the user's existing trust store and system defaults, so there is **no first-connect regression** and no VSDB-owned key file to manage. This is the charter's "no disabling host checking" boundary honored in the strict direction.

**Interaction with the existing PID proof (must-not-break).** The host-key flag is orthogonal to the local listener identity proof: `StrictHostKeyChecking` governs *who the remote bastion is*; `proveOwnership` governs *which local process owns the forwarded port*. Both stay fail-closed and both must pass before DB traffic flows. 002's new tests must not perturb the existing readiness sequence (`Local forwarding listening` line → `listeningPids` → identity match).

**Cross-platform note for the ADR.** `listeningPids` (`src/core/sshTunnelManager.ts:69-125`) selects the socket-table tool by platform: `lsof` on darwin/freebsd/openbsd, `netstat -ano -p tcp` on win32, `ss -ltnp` on linux. The ADR documents these as the supported platforms and records each platform's OpenSSH availability caveat (e.g. Windows bundled OpenSSH version).

**Rejected alternatives (documented in the ADR, mirrored here).** (a) `accept-new` + VSDB-managed `known_hosts` (TOFU pinning store) — rejected: first connect would silently write a host key the user never approved, cross-user migration surprises, and it needs form/persistence wiring that the roadmap excludes (secret-persistence adjacency). (b) Per-connection fingerprint pinning — rejected for the same scope reasons; recorded as the documented **upgrade path** if a stronger claim is ever required. (c) Any `accept`/`none` relaxation — prohibited by charter (never disable host checking).

**Downgrade/no-go criteria (recorded in the ADR, binding on 001).** The trigger fires **only from MANUAL OpenSSH validation on macOS/Linux/Windows** (real-world, per roadmap acceptance) — it CANNOT fire from the pinned automated commands, because 001's tests are pure argv and 002's use fake-ssh shims, neither of which runs real OpenSSH. So a fresh executor must not wait for an automated RED that cannot occur. If manual validation surfaces a real-world break (e.g. a supported platform's bundled OpenSSH chokes on `StrictHostKeyChecking=yes`), the documented fallback is to **revert to recording the current implicit behavior with no new flags**; in that case 001 shrinks to validation-only hardening — the "argv cannot relax host-key checks" test still ships because it needs no new flag (it asserts absence of relaxing tokens). A no-go is recorded in the ADR and the cycle's acceptance adjusts; the decision and its evidence are the deliverable, not the flag itself.

**No form input (04.4 closes not-needed).** Verified at commissioning: `src/ui/connectionFormMessages.ts:34-37` exposes `tunnelHost`, `tunnelPort`, `tunnelUser`, `tunnelIdentityFile` — **no** host-key/strict-checking/fingerprint field; `TunnelConfig` (`src/core/sshTunnel.ts`) gains no new field this cycle; `grep` across `src/` finds zero `StrictHostKeyChecking`/`UserKnownHostsFile`/`known_hosts` references today. The strict-checking policy is argv-level and implicit — no user-facing config is required. 004 therefore runs a verify-only gate: confirm the form + config surface is unchanged, run the existing form suite, and record the evidence. If the policy decision had required input, 004 would have become a real wiring task (strict webview validation + secret-free persistence) — it does not.

## §4 Test Plan

Test-first (RED) is mandatory per task. Cases below are per-task slices with concrete expectations.

### ARP-04.0 — ADR (`docs/decisions/`)

| Type | Test name | Expected |
|---|---|---|
| N/A | Docs task — no code | Test Plan is N/A per RULES: zero testable behavior. Deliverable is the ADR content; verification is the content checklist in §5 and the acceptance checklist in §6. |

### ARP-04.1 — identity input (`sshTunnel.ts`)

| Type | Test name | Expected |
|---|---|---|
| happy | minimal config pins strict checking | `buildTunnelArgs({ host: "bastion", port: 5433 })` → argv contains the pair `["-o", "StrictHostKeyChecking=yes"]` (present as its own pair; existing `arrayContaining` assertions unaffected — verified: `sshTunnel.test.ts` uses `arrayContaining`, no exact-argv equality) |
| edge: cannot relax | argv never contains a relaxing host-key token | across representative configs (minimal, user+identity, identity-only) the argv contains **no** token matching `/StrictHostKeyChecking=(no\|ask\|accept-new\|off)/i` and **no** `UserKnownHostsFile` option (any value) |
| edge: form preserved | non-relaxing arg layout unchanged | with `user` + `identityFile` + `port` + `targetPort` → `-i <id>`, `-l <user>`, `-p <port>`, `-L 127.0.0.1:<local>:127.0.0.1:<target>` all still present exactly as before the new flag |
| edge: BatchMode coexistence | no-interactive-TOFU guarantee survives | the argv still contains `-o BatchMode=yes` alongside `-o StrictHostKeyChecking=yes` (an unknown host key cannot fall through to an interactive prompt) |
| edge: option pair shape | flag is a separate token pair, never glued | no token equals `-oStrictHostKeyChecking=yes` (glued) and no `-oStrictHostKeyChecking` bare token |
| regression | existing validation unchanged | `emptyHost`, `badIdentityFile` (whitespace/relative), `badPort` rejects still throw `TunnelError` with the same codes |

### ARP-04.2 — lifecycle/race + fail-closed PID proof (`sshTunnelManager.ts`)

Uses the existing `fake-ssh.mjs` shim harness (`src/core/__tests__/sshTunnelManager.test.ts` precedent) + one new fixture.

| Type | Test name | Expected |
|---|---|---|
| happy (regression pin) | same-key reuse returns the identical handle | two `start(cfg, "k1")` calls resolve to the **same** handle instance; `mgr.list().length === 1` (pins the coalescing contract already implemented — remains green) |
| edge: isolation | different-key isolation under stop | `start` keys "a" and "b" → `stop("a")` leaves "b" live (`list()[0].key === "b"`), "b" restarts as a fresh handle after its own stop |
| edge: late exit | unexpected post-ready exit removes only its own handle | child for key "a" is SIGKILLed externally → `list()` no longer contains "a", the sibling "b" handle survives, exactly one `TunnelExit { key: "a", intentional: false }` fires |
| edge: PID mismatch fails closed | foreign-held port rejects and kills the child | `fake-ssh-foreign.mjs` binds the target port with a **detached** process whose PID ≠ the spawned child's PID and prints the forward line → `start` rejects with the `port <N> is held by another process (pids …)` literal and the child is SIGKILLed; the detached binder is terminated by the test in `finally` (port released) |
| edge: stop idempotent | stop on missing / repeated stop is safe | `stop("missing")` returns `false`; `stopAll()` then `stop("gone")` returns `false`; a second `stop("k1")` after a successful one returns `false`; no throw on any path |
| edge (spawn-path pin) | spawned argv inherits the pinned strict flag | a recording shim logs the spawned argv to a file then execs `fake-ssh.mjs` → `start` succeeds AND the logged argv contains `["-o", "StrictHostKeyChecking=yes"]` and no relaxing token (the manager cannot strip or relax the flag its builder emits) |

### ARP-04.3 — manager integration (`connectionManager.ts`)

Uses the existing `makeFakeTunnels()` harness (`connectionManager.test.ts:527-566`) which records `startCalls` (`{key, port}`) and `stopCalls` (`string[]`).

| Type | Test name | Expected |
|---|---|---|
| happy | loopback routing retains persisted host/port | tunneled cfg resolved via `getAdapter()`/probe → the adapter `factory` receives `{...cfg, host: "127.0.0.1", port: <handle.localPort>}` while `state.connections` still holds the original `cfg.host`/`cfg.port` unchanged (persisted metadata never rewritten to the loopback form) |
| edge: intended key (edit) | edit stops only its own probe + old tunnel | `editConnection("c1")` on a tunneled id → `stopCalls` contains `probe-c1` then `c1`, and does **not** contain `c2`; a live tunnel for `c2` is untouched |
| edge: intended key (delete) | delete stops only the deleted id | `deleteConnection("c1")` → `stopCalls` contains `c1`, not `c2` |
| edge: intended key (add-probe failure) | failed add cleans its own probe only | `addConnection(c1)` whose `testConnection()` rejects → `stopCalls` contains `c1`, not `c2` (probe cleanup path `connectionManager.ts:181`) |
| edge: probe key isolation | probe uses `probe-<id>` so it never reuses a live `<id>` tunnel | probe calls `tunnels.start(…, "probe-c1")` and never `"c1"`; a same-id re-probe while a live `c1` tunnel exists does not reuse/stop it |
| regression | recovery gate unchanged | an **intentional** tunnel exit for the active key does **not** enter recovery (existing `handleTunnelExit` gate — `exit.intentional` short-circuit stays green) |

### ARP-04.4 — form wiring gate (verify-only)

| Type | Test name | Expected |
|---|---|---|
| N/A | Verify-only gate — no code | Test Plan is N/A per RULES: the deliverable is recorded evidence. Verification is the inspection + form-suite run in §5 and the acceptance checklist in §6. Expected outcome: gate closes **not-needed** with evidence; if the inspection ever found a host-key input surface, the gate would have been a real wiring task. |

## §5 Verification Commands

Repository scripts (verified in `package.json`): `test` (`vitest run`), `test:integration` (DB-gated — NOT used here), `typecheck` (`tsc --noEmit`), `compile` (`node esbuild.js`), `package` (release gate — not used). **No `lint` script exists** (roadmap §portfolio constraint: "No lint script exists"); typecheck + compile are the static gates. There is no `yarn` and no `test:release-core` script in this npm repo — the RULES "test selection" floor is satisfied by the pinned focused vitest runs below plus the mandated full `npm test` on TASK-ARP04-001 and at the wave/cycle boundary.

Per-task (each task pins its OWN owned test file — see §2 for why):

```bash
# TASK-ARP04-000  (ADR — content checklist, no vitest)
test -f docs/decisions/0001-ssh-host-key-identity-policy.md
grep -qi "StrictHostKeyChecking" docs/decisions/0001-ssh-host-key-identity-policy.md
grep -qi "known_hosts" docs/decisions/0001-ssh-host-key-identity-policy.md
grep -qi "downgrade" docs/decisions/0001-ssh-host-key-identity-policy.md

# TASK-ARP04-001  (sshTunnel.ts → tests-map [sshTunnel.test.ts, sshTunnelManager.test.ts];
#                  pin the OWNED unit file only — sshTunnelManager.test.ts belongs to TASK-ARP04-002,
#                  which runs in a later wave)
#                  FULL SUITE mandated here — pure argv builder, lowest flake risk
npx vitest run src/core/__tests__/sshTunnel.test.ts
npm run typecheck
npm run compile
npm test

# TASK-ARP04-002  (sshTunnelManager.ts → tests-map [sshTunnelManager.test.ts, sshTunnel.test.ts];
#                  wave 2 — runs AFTER 001 lands, so the tests-map overlap with sshTunnel.test.ts
#                  is no longer a same-wave conflict; still pin the OWNED manager file only;
#                  full suite at the wave boundary)
npx vitest run src/core/__tests__/sshTunnelManager.test.ts
npm run typecheck
npm run compile

# TASK-ARP04-003  (connectionManager.ts → tests-map [connectionManager.test.ts])
npx vitest run src/core/__tests__/connectionManager.test.ts
npm run typecheck
npm run compile

# TASK-ARP04-004  (verify-only — inspection + existing form suite)
# NOTE: src/config/types.ts is READ-DENIED in this environment (confirmed — Read returns permission
# denied). If the executor also hits the denial, record that ConnectionConfig.tunnel carries the
# TunnelConfig shape (per connectionManager.ts:692-700) and grep src/core/sshTunnel.ts for host-key
# tokens instead — the assertion (no host-key input surface) is unaffected.
grep -nE "StrictHostKeyChecking|UserKnownHostsFile|known_hosts|hostKey|fingerprint" src/ui/connectionForm.ts src/ui/connectionFormMessages.ts src/config/types.ts
#   expected: no matches (empty output) — the form/config surface exposes no host-key input
grep -nE "StrictHostKeyChecking|UserKnownHostsFile|known_hosts|hostKey|fingerprint" src/core/sshTunnel.ts   # fallback target if types.ts is read-denied
npx vitest run src/ui/__tests__/connectionForm.test.ts
npm run typecheck
```

Wave/cycle-boundary net: a full `npm test` runs at each wave boundary and before close-out (per RULES regression net); TASK-ARP04-001 already runs it inline as the mandated per-task full suite.

## §6 Acceptance Criteria

- [ ] The ADR exists in `docs/decisions/0001-ssh-host-key-identity-policy.md` and records: supported platforms (darwin/freebsd/openbsd → `lsof`; win32 → `netstat`; linux → `ss`), current OpenSSH trust behavior (no host-key flags today, `BatchMode=yes` fails unknown hosts, implicit `~/.ssh/known_hosts`), the chosen policy (explicit `StrictHostKeyChecking=yes`, no `UserKnownHostsFile`), rejected alternatives, and the downgrade/no-go criteria. → TASK-ARP04-000.
- [ ] No source change landed before the ADR decision (wave order: 000 gates 001/002/003). → TASK-ARP04-000.
- [ ] `buildTunnelArgs` emits the pinned pair `-o StrictHostKeyChecking=yes`, never emits a relaxing token (`no`/`ask`/`accept-new`/`off`) nor `UserKnownHostsFile`, keeps `-o BatchMode=yes`, and preserves existing validation rejects. → TASK-ARP04-001.
- [ ] The manager keeps the lifecycle guarantees under test: same-key reuse (identical handle), different-key isolation, unexpected late exit removes only its own handle, a foreign-held port fails closed with the held-by-another-process rejection and child SIGKILL, `stop` is idempotent, and the spawned argv cannot drop or relax the strict flag. → TASK-ARP04-002.
- [ ] connectionManager edit/delete/add-probe stop only the intended key (`probe-<id>`/`<id>`, never a sibling id), and loopback routing delivers `127.0.0.1:<localPort>` to the adapter while the persisted `ConnectionConfig` host/port stay unchanged. → TASK-ARP04-003.
- [ ] The form/config surface exposes no host-key input and the existing form suite stays green; the 004 gate closes **not-needed** with recorded evidence. → TASK-ARP04-004.
- [ ] Focused owned-file tests + `npm run typecheck` + `npm run compile` green per task; full `npm test` green on TASK-ARP04-001 and at each wave/cycle boundary. → all tasks.
- [ ] Charter out-of-scope untouched: no SSH client implementation, no secret/private-key persistence, no disabling of host checking, no cross-connection tunnel reuse, no remote-DB TLS identity claim. → cycle-wide.

## §7 Global Constraints

- TypeScript 5.4 / VS Code `^1.75.0` compatibility; no new dependencies; npm only (no `yarn`).
- **Pinned policy, non-negotiable:** add `-o StrictHostKeyChecking=yes` ONLY; do NOT add `UserKnownHostsFile`, `accept-new`, `no`, `ask`, `off`, or per-connection fingerprint pinning in this cycle (fingerprint pinning is the documented future upgrade path, not implemented).
- Downgrade/no-go binding on 001: if `strict=yes` breaks a supported platform in verification, revert to documenting the current implicit behavior with no new flags, and 001 shrinks to validation-only hardening (the absence-of-relaxing-token test ships regardless).
- No user-facing config change: `TunnelConfig` (`src/core/sshTunnel.ts`) gains no new field; `connectionForm.ts`/`connectionFormMessages.ts` are not edited (004 is verify-only).
- Same-wave tasks must not share a file (see §2); the executor must not open files owned by a different task. Each task's verification pins its own owned test file.
- Do NOT touch `src/config/types.ts`, `extension.ts`, or the adapter layer in this cycle.
- `listeningPids` platform mapping (`lsof`/`netstat`/`ss`) is the supported-platform source of truth; the ADR documents it, the code is not changed.
- No `lint` script exists — do not invent one; static gates are `typecheck` + `compile`.
- Charter boundaries are cycle-wide constraints: no SSH client implementation, no secret persistence, no host-checking disablement, no cross-connection tunnel reuse, no remote-DB TLS identity claim.
- `docs/decisions/` is new; ADR file naming is `NNNN-title.md`, this cycle creates `0001-ssh-host-key-identity-policy.md`.

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit: (1) Confirmed via tests-map that `sshTunnel.ts` and `sshTunnelManager.ts` map to BOTH unit test files — pinned each wave-1 task to its OWN owned test file in §2/§5 to keep the executors file-disjoint (running a sibling's test file mid-wave is meaningless coverage). (2) Verified no exact-argv equality assertion exists anywhere (`sshTunnel.test.ts` uses `arrayContaining`), so the new flag cannot break existing tests. (3) Verified the form surface (`connectionFormMessages.ts:34-37`: `tunnelHost`/`tunnelPort`/`tunnelUser`/`tunnelIdentityFile`) exposes no host-key field and `grep` across `src/` finds zero host-key option references — grounding 04.4's verify-only close. (4) Made the downgrade/no-go path a first-class acceptance criterion so the ADR's decision is binding on 001, not advisory. (5) Traced every §6 criterion to its task. `src/config/types.ts` is read-denied in this environment — the tunnel config type is grounded instead via `src/core/sshTunnel.ts` (`TunnelConfig`) and the form message surface; the read-denial fallback for 004 is specified in §5's verification block. (6) Per plan review Round 1, 002 now depends on 001 as well as 000 (its spawn-path pin requires 001's builder change) — the cycle is now a chain (wave 1: 001, wave 2: 002, wave 3: 003, wave 4: 004); §2/§5, INDEX.md, and TASK-ARP04-002/003 updated to match.
Known gaps: The PID-mismatch test (002) needs a new `fake-ssh-foreign.mjs` fixture that binds the local port from a detached grandchild process — the only new test infrastructure in the cycle, and the only test that depends on the platform socket-table tool (`lsof` on darwin/bsd, `ss` on linux, `netstat` on win32). If a CI platform's socket tool behaves differently (e.g. `netstat` local-address format), the executor must adapt the parsing in the fixture or the assertion to the observed output — the fail-closed CONTRACT (reject + SIGKILL + child killed) is what matters, not the exact tool text. No test covers cross-connection tunnel reuse or remote-DB TLS identity — deliberately out of scope per charter. (The `src/config/types.ts` read-denial fallback for 004 is now specified in §5, not here.)

## Planner Report

PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 2 — all Round 1 findings verified resolved; advisory nits only)

## Plan Review Log

### Round 1 — 2026-09-02 · code-reviewer (unic-smart)
VERDICT: Issues Found

COMPLETENESS:
  - none (ARP-04.0 ADR task 000 carries the full gate: platforms via `listeningPids` mapping sshTunnelManager.ts:69-125, current OpenSSH trust behavior, chosen policy, rejected alternatives, downgrade/no-go — all before any source task; dependency graph 000→001/002→003→004 is real and enforced in INDEX.md)
CONSISTENCY:
  - §2/§7 policy is coherent and fail-closed: `-o StrictHostKeyChecking=yes` pinned, no `UserKnownHostsFile`, and 001 edge-2 pins the "generated argv cannot relax host-key checks" invariant as a test (`/StrictHostKeyChecking=(no|ask|accept-new|off)/i` + no `UserKnownHostsFile`), re-pinned at the spawn path in 002 edge-6. Rejected alternatives (accept-new+TOFU store, fingerprint pinning as upgrade path) documented in §3 and required in the ADR checklist.
  - Minor: §3/§4.1's "not stricter for any user who already trusts their bastion" is slightly too broad — `-o` command-line flags override `~/.ssh/config`, so a user who deliberately set `StrictHostKeyChecking=no` for the bastion in their config will now fail (intended fail-closed, but a behavior change). ADR checklist should explicitly record the config-override nuance.
CLARITY:
  - Downgrade/no-go criteria are concrete on the fallback side (revert to no-new-flags, 001 shrinks to validation-only hardening, absence-of-relaxing-token test ships regardless, no-go recorded in ADR), but the trigger ("if strict=yes breaks a supported platform in verification") cannot fire from the pinned automated commands (001 tests are pure argv; 002 uses fake-ssh shims, not real OpenSSH). It can only fire from real-world/manual OpenSSH validation per roadmap acceptance. Suggest one line stating the trigger is manual validation on macOS/Linux/Windows, so a fresh executor does not wait for an automated RED that cannot occur.
  - Minor: §5's 004 verification greps `src/config/types.ts`, which is read-denied in this environment (confirmed — Read returns permission denied). The fallback lives only in the Planner Self-Audit; move it into §5 so a fresh 004 executor sees it in the Verification Commands block.
SCOPE:
  - Wave/file disjointness is genuinely disjoint: 001 owns sshTunnel.ts+its test, 002 owns sshTunnelManager.ts+its test+new fake-ssh-foreign.mjs (confirmed tests-map overlap `sshTunnel.ts`→both test files, correctly pinned to owned files).
  - IMPORTANT: 002's edge-6 spawn-path pin asserts the spawned argv contains `["-o","StrictHostKeyChecking=yes"]`, which only turns green after 001's buildTunnelArgs change lands. But PLAN.md §2 and INDEX.md both record 002 depending on 000 only. If wave-1 runs 001 and 002 in parallel, 002's edge-6 stays RED and the executor cannot make it green without editing 001's file (forbidden by the same-wave disjointness rule) — a stuck-RED risk. Fix: record 002 depends on 001, or state wave-1 executes 001 before 002.
  - 003 composition with ARP-02/03 leftovers is conflict-free: the stopTunnel calls at connectionManager.ts:263 (edit), :302 (delete), :427 (discard path), probe cleanup :245 and `probe-<id>` key :231, and the recovery `intentional` gate :484 all exist and are covered by 003's intended-key/loopback/recovery-regression tests.
YAGNI:
  - none — in-scope matches charter exactly; the new `fake-ssh-foreign.mjs` fixture is justified infra to exercise the existing fail-closed PID path deterministically.

NOTES: Plan is sound on policy, gate ordering (000 before source), and scope. Only actionable item before execution: encode the 001→002 wave-1 ordering (or dependency) so the spawn-path strict-flag test in 002 is not stuck RED under parallel wave execution.

### P2.5 Revision — Round 1 findings applied
PLANNER_REVISION: Round 1 findings applied — (1) 002 now depends on 001+000; cycle is a chain (wave 1: 001, wave 2: 002, wave 3: 003, wave 4: 004), INDEX/graph/waves and TASK-ARP04-002/003 updated; (2) ADR checklist + §3 now record that `-o StrictHostKeyChecking=yes` overrides `~/.ssh/config` relaxations — an intended fail-closed behavior change, not uniformly "not stricter"; (3) downgrade trigger stated as MANUAL OpenSSH validation on macOS/Linux/Windows only, not automated fake-ssh verification; (4) `src/config/types.ts` read-denial fallback moved from Self-Audit into §5's 004 verification block.

### Round 2 — 2026-09-02 · code-reviewer (unic-smart)
VERDICT: Approved

COMPLETENESS:
  - none — all 5 tasks carry Goal/Target Files/Test Cases/Verification/Acceptance/Dependencies/Interfaces; package.json verified (`test`/`typecheck`/`compile` present, no `lint` — §5's claim accurate); ≥2 edge cases per task (001: 5, 002: 5, 003: 5).
CONSISTENCY:
  - none — dependency chain 000→001→002→003→004 is consistent across PLAN.md §2 (table + wave structure), INDEX.md (graph/waves/dependency cols), and TASK-ARP04-001/002/003/004 Dependencies sections; config-override nuance, manual-only downgrade trigger, and §5 read-denial fallback match across plan + ADR checklist + task files.
CLARITY:
  - none — downgrade trigger now explicitly MANUAL OpenSSH validation on macOS/Linux/Windows (never automated fake-ssh), stated in PLAN.md §3/§7 and TASK-ARP04-000/001; 004's read-denied types.ts fallback is inline in §5 and TASK-ARP04-004.md.
SCOPE:
  - none — chain waves file-disjoint; 002's spawn-path pin (edge-6) correctly depends on 001's builder change, resolving the Round 1 stuck-RED risk.
YAGNI:
  - none — fake-ssh-foreign.mjs fixture is the only new infra and is justified by the fail-closed PID-mismatch path.

NOTES: Advisory-only nits (non-blocking, no action required): (a) PLAN.md §2's "Depends on" for 003 lists 001+002 while TASK-ARP04-003.md lists 000+001+002 — 000 is transitively implied, no execution risk; (b) PLAN.md §6 ADR acceptance line omits the config-override nuance, but TASK-ARP04-000.md's content checklist (the binding place) requires it.
