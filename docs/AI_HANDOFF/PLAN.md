# PLAN — ARP-05: Cross-driver timeout, pool, and resilience contract

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-05 (P1; deps ARP-02 v1.38.0 + ARP-03 v1.39.0 both released; ARP-04 v1.40.0 shipped).
Base: `main @ 65b9c4f` (v1.40.0). Executor: `unic-code`. Reviewer: `unic-smart`.
Full-suite baseline: **3025 passed | 2 skipped** (measured fresh on 65b9c4f, `npm test`).

## §1 Intent

**Problem.** The three adapters each pick a bespoke resilience posture with no shared, documented support
contract:

- PostgreSQL — `PG_POOL_MAX = 4` to isolate metadata from pinned cursor/transaction work (`src/adapters/postgres.ts:107,305-314`); pool `connectionTimeoutMillis: 10_000`; `close()` races cursor ROLLBACK + `pool.end()` against 2s/3s guards (`postgres.ts:323-369`); `cancelActiveQuery` via a **dedicated** one-off `Client` with 5s `connectionTimeoutMillis` so it never queues behind a held pool slot (`postgres.ts:513-546`).
- MySQL — `connectionLimit: 1`, `waitForConnections: true`, **`queueLimit: 0` (infinite queue)**, `connectTimeout: 10_000` (`mysql.ts:149-158`). A slow/hung checkout can enqueue every later request forever.
- MSSQL — `connectTimeout: 10_000`, `requestTimeout: 0` (unlimited request time for streaming — deliberate, so paused streams survive load-more), `cancelTimeout: 5_000` (`mssql.ts:547-555`); single in-flight request enforced by an `enqueue` chain (`mssql.ts:574-587`).

These may each be correct, but they are **not a common support contract**: no per-driver matrix explains the
deliberate differences, no measurement proves the failure behavior is finite, and there is no recorded
decision about mutation/transaction/cursor replay.

**Success.** (1) A decision record (`docs/decisions/`) with a measured per-driver matrix for
connect/query/stream/cancel/pool/broken-socket and an explicit SLO + no-automatic-replay decision; (2)
measured finite failure behavior — every path the matrix lists terminates, no unbounded queue can wedge
forever, cancellation is best-effort and never replayed; (3) host message normalized only where the
measurement proves a gap; (4) a regression net pinning today's already-correct behaviors so the contract
stays true.

**Method.** Documentation + test-heavy cycle. Existing behaviors are presumed correct; production changes
land **only where a measurement proves a gap** (e.g. an unbounded queue wedging, a missing cancel timeout).
Default output is tests that pin behavior + an ADR that records it. **ARP-05 composes with ARP-02/ARP-03/ARP-04 — it must not weaken their guarantees** (cancel-ownership seam discipline, retained-row budget,
strict host-key pin).

## §2 Scope

**In**
- ARP-05.0 — measured contract ADR (wave 0, mandatory gate): a decision record in `docs/decisions/` that
  documents the per-driver connect/query/stream/cancel/pool/broken-socket matrix, cites each config line,
  records the measured finite-failure behavior (including the infinite `queueLimit: 0` gap), and records
  the SLO/no-mutation-retry/no-transaction-replay/no-cursor-replay decision.
- ARP-05.1 — PostgreSQL (wave 1): pin PG pool isolation, failed-connect/close release, cancel recovery with
  the dedicated-client seam; change production code only where measurement proves a gap.
- ARP-05.2 — MySQL (wave 1): pin streaming/cancel with a held `connectionLimit: 1` pool; **bound the
  source-proven wait gap** — `queueLimit: 0` (infinite wait-for-connection queue) is the one production
  change this cycle is expected to need; keep cancellation terminal (no replay).
- ARP-05.3 — MSSQL (wave 1): pin paused-stream-not-timed-out and cancellation/late-request-does-not-wedge
  (single in-flight `enqueue` + 5s cancel timeout); change production code only where measurement proves a gap.
- ARP-05.4 — host message (wave 2, **conditional**): normalize the connect-failure host message
  (actionable, non-secret) in `src/core/connectionManager.ts` ONLY if the wave-1 ADR measurement shows the
  current error UX is the gap (e.g. raw `queueLimit` wait surfaces as a generic pool timeout with no
  "connection in use" hint). Otherwise closes **not-needed** with evidence (mirrors TASK-ARP04-004).

**Out** (explicit, from roadmap + ARP-05 compose rules)
- Automatic mutation retry, reconnect during transaction/cursor, blanket pool resizing, dependency-heavy
  circuit breakers.
- Changing `connectionLimit`, `PG_POOL_MAX`, `requestTimeout`/`connectTimeout`/`cancelTimeout` values,
  or the cursor-routing predicates, without a measurement proving a gap. Today's deliberate values are
  pinned by tests, not changed.
- Weakening ARP-02 cancel-ownership / ARP-03 retained-row cap / ARP-04 host-key pin. All cancel paths stay
  best-effort, never replayed, never pool/adapter-close-as-cancel.

**Same-wave file disjointness (absolute)**
- Wave 0: ARP-05.0 owns `docs/decisions/` only.
- Wave 1: ARP-05.1 owns `src/adapters/postgres.ts`; ARP-05.2 owns `src/adapters/mysql.ts`; ARP-05.3 owns
  `src/adapters/mssql.ts`. Disjoint. Each task owns its own pinned test file (see §7). The integration
  suites are DB-gated and excluded from focused runs — they are exercised by the cycle `npm run test:integration` net.
- Wave 2: ARP-05.4 owns `src/core/connectionManager.ts` (+ `connectionManager.test.ts`) **only if a host-message gap is found**; otherwise closes as not-needed.

## §3 Approach

Each driver task starts with a **measurement RED probe** (a vitest suite that asserts the finite-failure
contract on a fake/mocked driver surface), runs it against today's code to record whether it passes, and
then ships the test as a pin — plus a production change only if the probe proves a gap.

**ARP-05.0 — ADR (`docs/decisions/0002-cross-driver-resilience-contract.md`, new).** Record:
- Per-driver matrix, each cell citing the exact config line + current value:
  - **Connect**: PG `connectionTimeoutMillis: 10_000` (`postgres.ts:313`); MySQL `connectTimeout: 10_000`
    (`mysql.ts:158`); MSSQL `connectTimeout: 10_000` + LoggedIn poll deadline 10s (`mssql.ts:547,152`).
  - **Query**: PG `max: PG_POOL_MAX = 4` (`postgres.ts:311`); MySQL `connectionLimit: 1` + atomic
    multi-statement batch on one held connection (`mysql.ts:155,242-304`); MSSQL `requestTimeout: 0` +
    one-request `enqueue` chain (`mssql.ts:554,574-587`).
  - **Stream**: PG cursor `BEGIN`/`DECLARE`/`FETCH`/`CLOSE`, pool slot held (`postgres.ts:1086-1180`);
    MySQL `connectionLimit: 1` held + `timeout: 0` stream (`mysql.ts:653-675`); MSSQL `requestTimeout: 0`
    so a paused stream survives load-more (`mssql.ts:548-554`).
  - **Cancel**: PG dedicated one-off `Client` + `pg_cancel_backend`, never through the pool
    (`postgres.ts:513-546`); MySQL `stream.destroy()`/`connection.destroy()` best-effort
    (`mysql.ts:343-368`); MSSQL `request.cancel()` best-effort + `cancelTimeout: 5_000` (`mssql.ts:205-211,555`).
  - **Pool**: PG 4 slots on demand (`postgres.ts:305-314`); MySQL 1 slot + `waitForConnections: true` +
    **`queueLimit: 0` infinite queue** (`mysql.ts:156-157`); MSSQL no pool — one tedious `Connection`
    serialized by `enqueue` (`mssql.ts:514-559`).
  - **Broken socket**: PG `close()` races cursor ROLLBACK/release(true) + `pool.end()` vs 2s/3s guards
    (`postgres.ts:323-369`); MySQL `close()` = `pool.end()` (`mysql.ts:198-204`); MSSQL `close()` cancels
    active requests then `connection.close()` (`mssql.ts:198-223`).
- Measured finite-failure behavior per driver (probe evidence recorded in the ADR) — the matrix must state
  that every listed path terminates. **The one known gap to probe and record: MySQL `queueLimit: 0` with a
  held connection is an unbounded wait** — a slow statement pins the single slot and every later
  connect/query enqueues with no upper bound (the wait is bounded only when the pool acquires/releases).
- The SLO/no-replay decision: e.g. connect/query failure ≤ 10s surface, cancel ≤ 5s best-effort,
  **no automatic replay of mutations, transactions, or cursors** — a retry contract belongs to the caller
  (read-only re-issue is allowed; mutation replay is not).
- Recorded probes (each RED/GREEN line pasted): slow connect, occupied pool, cancelled stream, broken
  socket, per driver, matching the roadmap's "Reproduce slow connect, occupied pool, cancelled stream,
  broken socket per driver" wave-0 acceptance.

**ARP-05.1 — PostgreSQL (`postgres.ts`).** Mock the `pg` `Pool`/`Client` (existing pattern in
`postgres.test.ts`, `adapterQueryShape.test.ts`). RED-probe then pin: metadata work does not queue behind a
pinned cursor/transaction slot; failed `connect()` releases cleanly; `close()` with open cursors resolves
< 5s and does not hang `pool.end()`; `cancelActiveQuery` uses a dedicated client even when all pool slots
are held; a post-cancel/no-op cancel is idempotent. Production change only if a probe proves a gap (e.g. a
queue that wedges beyond the documented 10s).

**ARP-05.2 — MySQL (`mysql.ts`).** Mock `mysql2/promise` (`createPool`, `PoolConnection`, stream).
RED-probe then pin: held streaming/batch connection with `connectionLimit: 1` preserves streaming and the
terminal error path; cancel is terminal (destroy never replays a mutation/cursor); the connect-failure path
closes the pool and nulls it (`mysql.ts:184-196`). **Expected production change:** bound the unbounded
wait — add an `acquireTimeout` so a held single connection cannot wedge later requests forever; keep
`waitForConnections: true`. **The bound must be injectable for the DB-free suite:** the pool factory reads
it from a module-scoped constant (e.g. `POOL_ACQUIRE_TIMEOUT_MS`, default `10_000` aligning with
`connectTimeout`) that the test overrides (e.g. to 50ms), so the pinned test asserts termination within the
injected bound deterministically — never a real 10s wait. The test may combine the injected bound with
`vi.useFakeTimers`/`vi.advanceTimersByTime` to drive the mocked pool's held second `getConnection()` to
reject within the bound; the real `10_000` value stays the production default and is recorded in the ADR.
If the probe shows the current behavior already finite (it is not), no change.

**ARP-05.3 — MSSQL (`mssql.ts`).** Fake tedious `Connection`/`Request` (existing pattern in
`mssql.parameterized.test.ts`). RED-probe then pin: a paused stream is not killed by `requestTimeout: 0`
(nothing arms a timer); `request.cancel()` on a live request settles within `cancelTimeout: 5_000`;
a late completion/cancel cannot wedge the `enqueue` chain (a settled request releases the next queued
operation). Production change only if a probe proves a gap.

**ARP-05.4 — host message (`connectionManager.ts`, conditional).** Gate mirrors TASK-ARP04-004: if the
wave-1 ADR measurement shows the connect-failure UX is already actionable (e.g. `testConnection` at
`connectionManager.ts:395-402` already rethrows a driver message with a host/port), close as **not-needed**
with `git diff 65b9c4f -- src/core/connectionManager.ts` evidence. Only if the measurement shows a gap
(e.g. MySQL's infinite-queue wait surfaces as a bare generic timeout with no actionable hint) does this
task add a normalization that strips secrets but keeps the actionable diagnostic detail.

**Wave-1 ADR-update protocol (explicit, cross-task).** The ADR
(`docs/decisions/0002-cross-driver-resilience-contract.md`) is a **docs file, not a code file**. ARP-05.0
(wave 0) writes the matrix, the known gaps, the SLO/no-replay decision, and the rejected alternatives.
During wave 1, each driver task appends its measured RED/GREEN probe results to the SAME ADR as a disjoint,
named section: TASK-ARP05-001 appends `## Probe: PostgreSQL`, TASK-ARP05-002 appends `## Probe: MySQL`,
TASK-ARP05-003 appends `## Probe: MSSQL`. Because the three wave-1 executors run in parallel and each
appends only its own section, the sections are disjoint by construction and copy-back merge is trivial
(append-only, no interleaving with wave-0 content). This does NOT violate the §7 same-wave file-disjointness
rule, which governs `src/` code files and exists to prevent code merge conflicts — a docs append of disjoint
sections cannot conflict. The completed ADR measurement (matrix at wave 0 + probe evidence appended in
wave 1) is what ARP-05.4's gate reads before deciding not-needed vs. change.

**Rejected alternatives.** Per-driver "fix" of values without measurement (all values are deliberate — see
`postgres.ts:291-304`, `mysql.ts:159-167`, `mssql.ts:548-554` comments); a shared base-adapter
abstracting the three (would break lazy-per-dialect + DBX-08 capability matrix); blanket `connectionLimit`
raising for MySQL (held single connection is the stream/transaction isolation — raising would let metadata
interleave into a user's open transaction, exactly what `postgres.ts:291-304` fixed for PG);
a dependency-heavy circuit-breaker (roadmap Out); automatic mutation/transaction/cursor replay (roadmap Out).

## §4 Test Plan

### ARP-05.0 — ADR (docs-gate; verify-only)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | N/A | Docs task — no code | N/A per RULES: zero testable behavior. Verification is the content checklist + grep checks below; no executable test for documentation. |

### ARP-05.1 — PostgreSQL (`src/adapters/__tests__/postgres.test.ts`; reuse the pg-mock queue pattern + `adapterQueryShape.test.ts` cursor fixtures)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy (pin) | metadata `pool.query` does not queue behind a pinned cursor/transaction client | with a `pool.connect()` holding all `PG_POOL_MAX` slots, a metadata call reaches its own slot (no `connectionTimeoutMillis` fail) — pins `PG_POOL_MAX = 4` isolation (`postgres.ts:291-314`) |
| 2 | edge: resource | `connect()` probe fails → no pool leak | `pool.connect()`/`query("SELECT 1")` throws → `pool.end()` called, `this.pool` null; adapter reusable (second `connect()` builds a fresh pool) |
| 3 | edge: resource | `close()` with an open cursor resolves < 5s | cursor ROLLBACK + `release(true)` fired; `pool.end()` raced vs 3s guard resolves; no hang (pins `postgres.ts:323-369`) |
| 4 | edge: cancel | `cancelActiveQuery` uses a dedicated client, never the pool | with all pool slots held, cancel issues `pg_cancel_backend` via a one-off `Client` (`connectionTimeoutMillis: 5_000`); pool untouched |
| 5 | edge: late/cancel | idle/no-PID cancel is a no-op | empty `activeNonCursorPids` → no dedicated client opened, resolves silently (pins `postgres.ts:520`) |

### ARP-05.2 — MySQL (`src/adapters/__tests__/adapterQueryShape.test.ts`; add a `mysql2/promise` mock lane + a new focused unit suite for the queue bound)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy (pin) | single-SELECT routes to streaming; multi-statement batch atomic | `singleSelect` → `openStreamingQuery` returns `{ results: [], batched }`; batch holds one connection, `beginTransaction`/`commit`/`release` exactly once (pins `mysql.ts:231-304`) |
| 2 | edge: resource | held single connection + late request terminates (queue bound) | `connectionLimit: 1` slot held (stream/tx); a second connect/query must fail/throw within a **bounded, injectable** acquire wait — the pool factory reads `acquireTimeout` from a module-scoped constant (`POOL_ACQUIRE_TIMEOUT_MS`, default `10_000`) the test overrides to a short bound (e.g. 50ms) and drives with `vi.useFakeTimers`/`vi.advanceTimersByTime`, so no real 10s wait — **RED on today's code: `queueLimit: 0` + no `acquireTimeout` = unbounded** |
| 3 | edge: cancel | cancel is terminal — no replay | `cancelActiveQuery` destroys the held connection/stream; a later repeat cancel is a silent no-op; mutation/transaction/cursor never re-issued (pins `mysql.ts:343-368,796-828`) |
| 4 | edge: late error | stream ends without `fields`/`error` does not hang | `openStreamingQuery` settles on `end`, releases the pool connection (pins `mysql.ts:682-705`) |
| 5 | edge: connect-fail | `connect()` failure closes the pool and nulls it | `getConnectionWithUtcSession` throws → `pool.end().catch(()=>undefined)`, `this.pool = null` (pins `mysql.ts:184-196`) |

### ARP-05.3 — MSSQL (`src/adapters/__tests__/mssql.parameterized.test.ts`; reuse the fake-Connection/`newRequest` pattern)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy (pin) | streaming SELECT not timed out while rows still flow | `requestTimeout: 0` → no timer armed; a long paused stream survives load-more (pins `mssql.ts:548-554`) |
| 2 | edge: resource | live request cancels within `cancelTimeout` | `request.cancel()` settles the awaiting `runRequest`/stream path within 5s; `activeRequests` drained (pins `mssql.ts:555,205-211`) |
| 3 | edge: late error | late completion cannot wedge the `enqueue` chain | a settled/failed request resolves `next` in `enqueue` so the following queued operation proceeds; no deadlock, no unhandled rejection (pins `mssql.ts:574-587`) |
| 4 | edge: connect | `connect()` failure cleans up the connection | fail/error path → `clearConnection` + `connection.close()` best-effort; `connecting` reset in `.finally` (pins `mssql.ts:121-196`) |
| 5 | edge: late/cancel | cancel after settle is a no-op | `request.cancel()` on an already-completed request swallows; state stays settled (pins `mssql.ts:608-624`) |

### ARP-05.4 — host message (`src/core/__tests__/connectionManager.test.ts`; conditional — see §2 gate)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | decision | host-message gate | if wave-1 measurement shows the connect-failure UX already actionable → close as not-needed with `git diff 65b9c4f -- src/core/connectionManager.ts` evidence (mirrors TASK-ARP04-004) |
| 2 | edge: content (only if gap) | connect failure surfaces an actionable message | the surfaced message keeps host/port/driver + the actionable hint (e.g. "connection in use / pool exhausted"); the hint text is present, not a bare generic timeout |
| 3 | edge: secret-redaction (only if gap) | no secret/credential leak in the surfaced message | a driver error that embeds the password (e.g. a `mysql.ts` pool error containing the DSN/password) is stripped of the credential before surfacing; the message contains no `password`/DSN fragment |
| 4 | regression (only if gap) | `testConnection` rethrow preserved | `connectionManager.ts:395-402` still throws the candidate error after closing it; no swallowed error |

## §5 Verification Commands

Run inside a clean worktree on `main @ 65b9c4f`. No real DB required — all suites are mocked (`pg`
Pool/Client, `mysql2/promise` pool, fake tedious Connection). **No lint script exists** — the static gate is
`npm run typecheck` (script verified in `package.json`); `npm run compile` is the build gate. Default `npm test`
excludes `*.integration.test.ts` (`vitest.config.ts`) — the integration suites are DB-gated and run only via
`npm run test:integration` (the cycle net, NOT per-task).

- **ARP-05.0** (wave 0):
  ```bash
  test -f docs/decisions/0002-cross-driver-resilience-contract.md
  grep -qi "queueLimit" docs/decisions/0002-cross-driver-resilience-contract.md
  grep -qi "no.*replay\|replay" docs/decisions/0002-cross-driver-resilience-contract.md
  git status --short src/ | wc -l        # must be 0 — docs task, no src/ change
  ```
  (Wave-0 scope is the matrix + known gaps + SLO/no-replay decision. The measured RED/GREEN probe sections
  are appended during wave 1 by TASK-ARP05-001/002/003 per the §3 wave-1 ADR-update protocol, each under
  its own `## Probe: <driver>` heading — the greps below on each driver task verify its own section.)
- **ARP-05.1** (wave 1):
  ```bash
  grep -qi "## Probe: PostgreSQL" docs/decisions/0002-cross-driver-resilience-contract.md
  npx vitest run src/adapters/__tests__/postgres.test.ts
  npm run typecheck
  npm run compile
  ```
  (Selection per RULES: `postgres.ts` → tests-map `[postgres.test.ts, postgres.integration.test.ts,
  postgres.sortQuery.test.ts, postgresCatalog.test.ts]`. The pinned new-test target is `postgres.test.ts`;
  the integration file is DB-gated and excluded; sibling suites run in the wave/cycle `npm test` net.)
- **ARP-05.2** (wave 1):
  ```bash
  grep -qi "## Probe: MySQL" docs/decisions/0002-cross-driver-resilience-contract.md
  grep -qi "acquireTimeout" docs/decisions/0002-cross-driver-resilience-contract.md   # chosen bound recorded
  npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
  npx vitest run src/adapters/__tests__/mysqlQueueBound.test.ts   # new focused unit suite (new)
  npm run typecheck
  npm run compile
  ```
  (The queue-bound test MUST assert termination within the injected bound — override `POOL_ACQUIRE_TIMEOUT_MS`
  to a short value (e.g. 50ms) and/or use `vi.useFakeTimers`; never wait a real 10s in the DB-free suite.)
  (Selection per RULES: `mysql.ts` → tests-map `[mysql.integration.test.ts, mysql.sortQuery.test.ts]`.
  Neither is a DB-free unit file — `mysql.integration.test.ts` is DB-gated; the queue-bound + streaming
  tests go into a **new** DB-free unit suite `mysqlQueueBound.test.ts` (new) plus the existing
  `adapterQueryShape.test.ts` (which already mocks the mysql2 `query()` shape). The mandatory non-empty
  floor is satisfied by the two DB-free files.)
- **ARP-05.3** (wave 1):
  ```bash
  grep -qi "## Probe: MSSQL" docs/decisions/0002-cross-driver-resilience-contract.md
  npx vitest run src/adapters/__tests__/mssql.parameterized.test.ts
  npm run typecheck
  npm run compile
  ```
  (Selection per RULES: `mssql.ts` → tests-map `[mssql.integration.test.ts, mssql.parameterized.test.ts,
  mssql.sortQuery.test.ts]`. `mssql.parameterized.test.ts` is the DB-free pinned target; the integration
  file is DB-gated; sibling suites run in the cycle net.)
- **ARP-05.4** (wave 2, after 001+002+003):
  ```bash
  grep -qi "## Probe: PostgreSQL" docs/decisions/0002-cross-driver-resilience-contract.md   # wave-1 evidence present
  grep -qi "## Probe: MySQL" docs/decisions/0002-cross-driver-resilience-contract.md
  grep -qi "## Probe: MSSQL" docs/decisions/0002-cross-driver-resilience-contract.md
  git diff 65b9c4f -- src/core/connectionManager.ts     # gate evidence (empty if closed not-needed)
  npx vitest run src/core/__tests__/connectionManager.test.ts   # only if a change was produced
  npm run typecheck
  npm run compile
  ```
- **Wave-2 net (after all tasks)**:
  ```bash
  npm test
  npm run test:integration          # controlled — real fixtures only, per roadmap acceptance
  ```
  Expected: `npm test` ≥ **3025 passed | 2 skipped** (baseline at 65b9c4f). Integration: only where
  fixtures exist; skip cleanly where they do not.

## §6 Acceptance Criteria

Every criterion traces to a task.

- [ ] **ARP-05.0** — `docs/decisions/0002-cross-driver-resilience-contract.md` exists with a per-driver
  connect/query/stream/cancel/pool/broken-socket matrix, each cell source-cited, plus the known gaps and the
  SLO/no-automatic-replay decision; `grep` checks exit 0; no `src/` file changed. **Wave-0 scope is the
  matrix + known gaps; the measured finite-failure probe evidence is appended by the wave-1 tasks
  (TASK-ARP05-001/002/003), each under its own `## Probe: <driver>` section per the §3 wave-1 ADR-update
  protocol — the measurement is completed in wave 1, before ARP-05.4's gate reads it.**
- [ ] **ARP-05.0** — the matrix explains the intentional adapter differences (PG slot isolation,
  MySQL single-slot stream/transaction isolation, MSSQL `requestTimeout: 0` paused-stream survival) and
  records the MySQL `queueLimit: 0` unbounded-wait gap.
- [ ] **ARP-05.1** — PG pool isolation, failed-connect/close release, and cancel recovery pinned by tests;
  RED probe evidence pasted **and appended to the ADR under `## Probe: PostgreSQL`**; `npm run typecheck` +
  `npm run compile` exit 0.
- [ ] **ARP-05.2** — streaming preserved with a held single connection; the terminal error/cancel path never
  replays a mutation/transaction/cursor; **a late request with a held connection now terminates within a
  bounded, injectable acquire wait** (RED on 65b9c4f: unbounded `queueLimit: 0`; the test asserts termination
  within an injected short bound via `vi.useFakeTimers`, never a real 10s wait); RED probe evidence appended
  to the ADR under `## Probe: MySQL`, with the chosen `acquireTimeout` bound recorded there; `npm run
  typecheck` + `npm run compile` exit 0.
- [ ] **ARP-05.3** — paused stream not timed out; cancellation and late requests cannot wedge the `enqueue`
  chain; RED probe evidence appended to the ADR under `## Probe: MSSQL`; `npm run typecheck` + `npm run
  compile` exit 0.
- [ ] **ARP-05.4** — gate recorded: closed-as-not-needed (both `connectionManager.ts` diffs empty) OR a
  host-message normalization shipped with RED-first proof that strips secrets while keeping the actionable
  diagnostic.
- [ ] **Compose** — ARP-02 cancel-ownership (dedicated-client PG seam, destroy-terminal MySQL seam,
  cancel-in-`close()` MSSQL seam), ARP-03 retained-row cap, and ARP-04 host-key pin remain green (regression
  pins in the driver suites); drivers stay lazily-imported per dialect; no mutation/transaction/cursor
  automatic replay anywhere.
- [ ] **Cycle** — `npm test` full suite ≥ **3025 passed | 2 skipped** (no regression); controlled
  `npm run test:integration` run where fixtures exist.
- [ ] **Reviewer** verdict APPROVED or APPROVED-WITH-MINOR on PLAN and on each task.

## §7 Global Constraints

- Base: `main @ 65b9c4f` (v1.40.0). All work in a fresh worktree; no git commit in P2/P3.
- Same-wave file disjointness absolute: 000 writes the ADR `docs/decisions/0002-cross-driver-resilience-contract.md` at wave 0; 001 owns `src/adapters/postgres.ts`(+`postgres.test.ts`); 002 owns `src/adapters/mysql.ts`(+`mysqlQueueBound.test.ts`(new)+`adapterQueryShape.test.ts`); 003 owns `src/adapters/mssql.ts`(+`mssql.parameterized.test.ts`); 004 owns `src/core/connectionManager.ts`(+`connectionManager.test.ts`) in wave 2 only. **The wave-1 tasks (001/002/003) each append their disjoint `## Probe: <driver>` section to the ADR file 000 wrote — a docs-file, append-only, section-disjoint exception to the disjointness rule per the §3 wave-1 ADR-update protocol; no `src/` code file is shared within a wave.**
- TDD mandatory: RED probe output pasted before implementation in every task report (docs task 000 records probes instead).
- Do NOT weaken ARP-02/ARP-03/ARP-04 guarantees; do NOT change today's deliberate timeout/pool/`requestTimeout` values without a measurement proving a gap; no automatic mutation/transaction/cursor replay; cancel stays best-effort and never pool/adapter-close-as-cancel.
- Drivers remain lazily-imported per dialect; no new shared base-adapter abstraction; no dependency-heavy circuit breakers; no blanket pool resizing.
- No lint script exists — the static gate is `npm run typecheck` (MUST be in every task's Verification Commands); `npm run compile` is the build gate. Integration tests run only via `npm run test:integration`, never the default `npm test` net.
- Verification must be DB-free in a clean worktree; `npm run test:integration` only where fixtures exist.

---

## Planner Report

PLANNER_MODEL: claude-opus-5

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit:
- Test selection grounded in the real `.cache/index/tests-map.json`: `postgres.ts` → 4 tests (integration excluded — DB-gated, `vitest.config.ts` excludes `*.integration.test.ts`); `mysql.ts` → 2 tests, **neither a DB-free unit file** → added a NEW focused DB-free unit suite `src/adapters/__tests__/mysqlQueueBound.test.ts` (new) to carry the queue-bound/streaming pins, alongside the existing `adapterQueryShape.test.ts`; `mssql.ts` → 3 tests (`mssql.parameterized.test.ts` is the DB-free pinned target). Every task's focused selection is non-empty; full suite runs at wave/cycle boundary.
- All path/line anchors re-verified against current source: PG `PG_POOL_MAX = 4` at `postgres.ts:107`, pool `postgres.ts:305-314`, `close()` `:323-369`, dedicated-client cancel `:513-546`; MySQL pool `mysql.ts:149-158` (`queueLimit: 0` at `:157`), connect-fail cleanup `:184-196`, batch `:242-304`, cancel `:343-368`, streaming `:648-705`; MSSQL `connect()` `mssql.ts:113-196`, `close()` `:198-223`, `enqueue` `:574-587`, `runRequest` `:589-657`, `createConnection` options `:514-559` (`requestTimeout: 0` `:554`, `cancelTimeout: 5_000` `:555`). Package scripts verified: `typecheck` = `tsc --noEmit`; NO lint script exists (recorded, not silently omitted).
- The one known production change (ARP-05.2 `acquireTimeout` bound) is scoped to a measurement-proven gap (infinite `queueLimit: 0`); every other value is pinned as regression, matching the cycle's docs+test-first charter.
- Index normalization done as part of this planning: leftover TASK-AIX07-001/002 `approved` rows set to `done` (cosmetic; no reviewer verdict history lost).
Known gaps:
- ARP-05.2's exact bound (recommend `acquireTimeout: 10_000` aligned with `connectTimeout`) is a recommendation; the executor may record the ADR-measured value and adjust to match `connectTimeout` — the RED probe contract (a late request must terminate within a bounded wait) is the invariant, and the chosen number must be recorded in the ADR.
- ARP-05.1/ARP-05.3 production changes are conditional: no gap is currently known in PG/MSSQL, so these tasks may be pin-only. The planner did NOT change PG/MSSQL values (all deliberate per their comments).
- ARP-05.4 is gated on the wave-1 ADR measurement exactly like TASK-ARP04-004; whether it ships a change is decided by the recorded probe evidence, not by a predetermined outcome.

## Plan Review Log

### Round 1 — 2026-09-02 · unic-smart
Verdict: Issues Found

COMPLETENESS:
  - none
CONSISTENCY:
  1. (§3 vs §4/§5/§7) — ADR measurement protocol is undefined. §3 (lines 99-101) requires ARP-05.0 to record "measured finite-failure behavior per driver (probe evidence recorded in the ADR)" and "each RED/GREEN line pasted", but §4 (line 144) declares ARP-05.0 has "zero testable behavior / no executable test", and §5 (lines 192-198) gives it only `test -f`/`grep`/`git status` checks — no probe commands exist for the wave-0 task to produce measurements. Result: the wave-0 ADR gate cannot satisfy its own §6 acceptance ("measured finite-failure behavior"), and the wave-1 tasks (001/002/003) would have to append evidence to the ADR file that §7 (line 275) assigns exclusively to 000. Fix: state explicitly that 001/002/003 append their RED/GREEN probe lines to the ADR during wave 1 (completing the measurement before ARP-05.4's gate), and reword §6 ARP-05.0 to "matrix + known gaps at wave-0; measured evidence appended by wave-1 tasks".
CLARITY:
  2. (§4 ARP-05.2, test 2) — the queue-bound test asserts a late request terminates "within the bounded acquire wait (recommend `acquireTimeout: 10_000`)"; a real 10s wait in a DB-free unit suite is slow/flaky, and no injection mechanism is specified. Fix: make the bound injectable (constructor/config override or `vi.useFakeTimers`) so the pinned test asserts termination within the bound deterministically without a real 10s wait.
  3. (§4 ARP-05.4) — the gap-found path ships only one edge case (test 2; test 3 is a regression pin), below the >=2-edge-case floor used by the other tasks. Fix: add a second edge case for the normalization path (e.g. a secret-bearing driver error is stripped of the password; or a non-host/port error keeps its actionable hint), or state the conditional waiver explicitly when the task ships a change.
SCOPE:
  - none — same-wave file disjointness absolute, no cycles, 004 correctly gated after wave 1.
YAGNI:
  - none — no circuit breakers, no blanket pool resizing, no replay; the only production change (MySQL `acquireTimeout`) is measurement-proven.

NOTES: Dependency graph implementable; every task has a testable test plan (000 has a valid docs-gate N-A with reason); verification commands concrete and runnable; out-of-scope list respected; 004's not-needed close path is properly gated with evidence commands.

#### Revision (Round 1) — 2026-09-02 · unic-smart
PLANNER_REVISION: The round-1 review returned 3 findings; PLAN.md and TASK-ARP05-000/001/002/003/004 were revised to close them. The Round 1 entry above is preserved as-is.

PLANNER_REVISION (Finding 1 — wave-1 ADR-update protocol):
- Added §3 "Wave-1 ADR-update protocol" defining that wave-1 tasks (001/002/003) append measured RED/GREEN
  probe results to the ADR 000 owns, each as a disjoint `## Probe: <driver>` section (docs file, append-only,
  copy-back merge trivial; explicitly not a same-wave code-file conflict).
- §5 now greps each driver task's own `## Probe:` section (and ARP-05.4 pre-gates on all three), and ARP-05.0's
  block notes that wave-0 scope is matrix + known gaps with probe sections appended in wave 1.
- §6 reworded ARP-05.0 to "matrix + known gaps at wave-0; measured evidence appended by wave-1 tasks" and
  added an ADR-append criterion to each of ARP-05.1/05.2/05.3.
- §7 clarified the ADR file-ownership line: wave-1 appends are the sole docs-file exception to the
  same-wave disjointness rule.
- TASK-ARP05-000/001/002/003: Target Files now list the ADR append, Verification Commands add the
  `grep -qi "## Probe: <driver>"` check, Acceptance Criteria include the append, and Interfaces/Produces
  note the append direction.

PLANNER_REVISION (Finding 2 — ARP-05.2 test 2 real-10s wait):
- §3 ARP-05.2, §4 test 2, §5 ARP-05.2 note, §6, and TASK-ARP05-002 now specify an **injectable bound**: the
  pool factory reads `acquireTimeout` from a module-scoped constant (`POOL_ACQUIRE_TIMEOUT_MS`, default
  10_000) that the test overrides to a short value and drives with `vi.useFakeTimers`/`vi.advanceTimersByTime`,
  so the suite asserts termination deterministically with no real 10s wait; the real value stays the
  production default and is recorded in the ADR.

PLANNER_REVISION (Finding 3 — ARP-05.4 gap-found path below edge-case floor):
- §4 ARP-05.4 table and TASK-ARP05-004 split the single combined edge case into two edge cases of different
  kinds — case 2 `edge: content` (actionable message present: host/port/driver + hint) and case 3
  `edge: secret-redaction` (no credential/DSN leak in the surfaced message) — keeping the `testConnection`
  rethrow as the regression pin. The gap-found path now ships ≥2 edge cases + 1 regression.

### Round 2 — 2026-09-02 · unic-smart
Verdict: Approved

Round-1 findings verified resolved:
- Finding 1 (ADR-update protocol): RESOLVED. §3 lines 136-146 defines the wave-1 ADR-update protocol (each driver task appends a disjoint `## Probe: <driver>` section to the ADR 000 owns); §5 greps each driver's own probe section (lines 222, 232-233, 248) and ARP-05.4 pre-gates on all three (258-260); §6 rewords ARP-05.0 to "matrix + known gaps at wave-0; measured evidence appended by wave-1 tasks" (278-283) and adds the append criterion to ARP-05.1/05.2/05.3 (288, 293-294, 297); §7 records the docs-append exception (313). No remaining wave-0 measurement obligation.
- Finding 2 (real-10s wait): RESOLVED. §3 (114-121), §4 test 2 (178), §5 note (239-240), §6 (291-295) all specify `POOL_ACQUIRE_TIMEOUT_MS` default 10_000, overridden to a short bound and driven by `vi.useFakeTimers`/`vi.advanceTimersByTime`; never a real 10s wait; chosen value recorded in the ADR. RED provenance on today's unbounded `queueLimit: 0` is explicit.
- Finding 3 (ARP-05.4 edge floor): RESOLVED. §4 (195-200) splits into two distinct edge kinds — `edge: content` (actionable message) and `edge: secret-redaction` (no credential/DSN leak) — plus the `testConnection` rethrow regression pin (test 4). Gap-found path ships ≥2 edges + 1 regression.

Fresh whole-plan pass:
COMPLETENESS: none — all sections complete, no TODO/TBD; verification commands concrete and runnable; `typecheck`+`compile` gates present and lint absence explicitly documented.
CONSISTENCY: none — baseline (3025/2) consistent across §0/§5/§6; disjointness rule, ADR-append exception, and ARP-05.4 gate sequencing all agree; the sole production change (acquireTimeout) is consistently scoped as measurement-proven across §2/§3/§6/§7.
CLARITY: minor — §4 ARP-05.2 does not assign tests 3-5 to a specific file between `adapterQueryShape.test.ts` and the new `mysqlQueueBound.test.ts`; non-blocking since §5 runs both DB-free files and the DB-free floor holds regardless of placement.
SCOPE: none — waves disjoint per src file, ARP-05.4 correctly gated after wave-1 evidence, out-of-scope list respected.
YAGNI: none — no circuit breakers, no blanket resizing, no replay; injectable bound + fake timers are justified determinism, not over-engineering.

NOTES: All three round-1 findings closed cleanly with no new blockers; plan is implementable as written.
