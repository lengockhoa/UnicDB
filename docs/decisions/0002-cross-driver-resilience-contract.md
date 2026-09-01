# ADR 0002 — Cross-driver timeout, pool, and resilience contract

- Status: **Accepted** (gating ARP-05 — this ADR must land before any source change in the cycle; TASK-ARP05-001/002/003 implement within it and append their measured probe evidence here, TASK-ARP05-004 reads the host-message conclusion)
- Date: 2026-09-02
- Deciders: VSDB maintainers (recorded in `docs/AI_HANDOFF/PLAN.md` §1–§3, cycle ARP-05 commissioning brief; source roadmap `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-05)
- Scope: `src/adapters/postgres.ts`, `src/adapters/mysql.ts`, `src/adapters/mssql.ts` (documentation of existing behavior; this ADR changes no source)

## 1. Context and problem

VSDB's three database adapters have **intentionally divergent** timeout, pool,
streaming, and cancellation policies. They were each tuned in earlier cycles
(TASK-002 atomic batches, TASK-005 UTC + stream settle, CRITICAL #1–#4 cursor
fixes, TASK-RLX02-001/002 cancel seams), but the values were never written
down as one support contract. The roadmap flags exactly this
(`docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-05: "These may be
correct, but they are not a common support contract.").

Consequences of the missing contract:

- A change to any single adapter value risks silently breaking a guarantee
  another path depends on (e.g. a pool-size change vs. metadata/transaction
  isolation, a request-timeout change vs. paused streaming).
- There is no agreed bound on how long a failing path may take to surface an
  error, so downstream tasks cannot tell a regression from a baseline.
- There is no recorded decision on retry/replay semantics, so "make the
  failure go away" fixes could smuggle in automatic mutation replay.

This ADR is the **wave-0 mandatory gate** for ARP-05: it records the current
contract with exact source citations, states the SLO / no-replay decision, and
names the one known gap. Every downstream driver task
(TASK-ARP05-001 PostgreSQL, -002 MySQL, -003 MSSQL) must not violate §5; the
host-message task (TASK-ARP05-004) reads §6 before deciding not-needed vs.
change.

## 2. Per-driver contract matrix (current source, cited)

Summary matrix — each cell is elaborated with exact citations in §2.1–§2.6.

| Path | PostgreSQL (`postgres.ts`) | MySQL (`mysql.ts`) | MSSQL (`mssql.ts`) |
|---|---|---|---|
| Connect timeout | `connectionTimeoutMillis: 10_000` (`:313`) | `connectTimeout: 10_000` (`:158`) | `connectTimeout: 10_000` (`:547`) + LoggedIn poll deadline 10 s (`:152`) |
| Query | `max: PG_POOL_MAX = 4` pool, statements looped on one checked-out client (`:107`, `:311`) | `connectionLimit: 1` + atomic multi-statement batch on one held connection (`:155`, `:242-304`) | `requestTimeout: 0` + one-request `enqueue` chain (`:554`, `:574-587`) |
| Stream | Cursor `BEGIN`/`DECLARE`/`FETCH`/`CLOSE` holding a pool slot (`:1086-1180`) | Single connection held + `timeout: 0` stream (`:653-675`) | `requestTimeout: 0` so a paused stream survives load-more (`:548-554`) |
| Cancel | Dedicated one-off `Client` + `pg_cancel_backend`, never through the pool (`:513-546`) | `stream.destroy()`/`connection.destroy()` best-effort (`:343-368`) | `request.cancel()` best-effort + `cancelTimeout: 5_000` (`:205-211`, `:555`) |
| Pool | 4 slots, opened lazily on demand (`:305-314`) | 1 slot + `waitForConnections: true` + **`queueLimit: 0` infinite queue** (`:156-157`) | No pool — one tedious `Connection`, work serialized by `enqueue` (`:514-559`) |
| Broken socket / close | `close()` races cursor ROLLBACK + `release(true)` vs 2 s guard, then `pool.end()` vs 3 s guard (`:323-369`) | `close()` = `pool.end()` (`:198-204`) | `close()` cancels active requests, then `connection.close()` (`:198-223`) |

### 2.1 Connect

- **PostgreSQL.** `PostgresAdapter.connect()` builds one `pg.Pool` with
  `connectionTimeoutMillis: 10_000` and `max: PG_POOL_MAX = 4`
  (`src/adapters/postgres.ts:305-314`; `PG_POOL_MAX` declared at `:107`),
  then proves the connection with a `SELECT 1` probe before resolving
  (`:315-320`). A connect that cannot get a slot or reach the server fails
  within the 10 s pg-pool budget ("timeout exceeded when trying to connect" —
  the failure mode named in the isolation comment at `:291-304`).
- **MySQL.** `MySqlAdapter.connect()` builds a `mysql2` promise pool with
  `connectTimeout: 10_000` (`src/adapters/mysql.ts:158`), then pings one
  checked-out connection; on ping failure the pool is ended, `this.pool` is
  nulled, and the error rethrows (`:184-196`) — a failed connect leaves no
  half-open pool behind.
- **MSSQL.** `MsSqlAdapter.connect()` creates a tedious `Connection` with
  `connectTimeout: 10_000` (`src/adapters/mssql.ts:547`). Because tedious
  emits `connect` after login but before the session accepts requests, the
  adapter polls for the `LoggedIn` state with a hard deadline of
  `Date.now() + 10_000` (`:152`), failing with "did not reach LoggedIn state
  within 10s" if the handshake stalls (`:171-177`). A failed connect removes
  listeners, clears the connection, closes it, and rejects (`:124-136`) —
  the `connecting` promise is cleared in `finally` (`:191-193`) so a later
  `connect()` retries cleanly.

### 2.2 Query

- **PostgreSQL.** `runQuery` splits the script (`:392`) and runs the whole
  multi-statement batch on ONE checked-out pool client (the Finding #6
  pattern referenced from the isolation comment at
  `src/adapters/postgres.ts:299-301`); pool size is `max: PG_POOL_MAX = 4`
  (`:107`, `:311`).
- **MySQL.** Non-streaming scripts run as an **atomic multi-statement batch
  on one held connection** wrapped in an explicit transaction:
  `getConnectionWithUtcSession()` checks out the single slot (`:253`),
  `beginTransaction` → statements → `commit`, any failure `rollback()`s and
  rethrows, `release()` happens exactly once in `finally` (`src/adapters/mysql.ts:242-304`,
  TASK-002 comment at `:242-252`). `multipleStatements: false` (`:167`) means
  VSDB splits scripts itself; the atomicity is VSDB-orchestrated, not
  server-side.
- **MSSQL.** Every execution funnels through `execute` →
  `this.enqueue(() => this.runRequest(...))` (`src/adapters/mssql.ts:567-572`).
  `enqueue` is a promise-chain mutex: each operation awaits the previous one
  before running (`:574-587`), enforcing tedious's one-request-per-connection
  limit. `requestTimeout: 0` (`:554`) means a query on the live connection
  has **no driver-level wall-clock bound** — boundedness comes from the
  cancel seams (§2.4), not from a timer. Requests register in
  `activeRequests` for the duration (`:599`, `:654-656`).

### 2.3 Stream

- **PostgreSQL.** Streaming SELECTs use a server-side cursor:
  `openCursorForStatement` checks out a pool client and holds it across
  `BEGIN` → `DECLARE ... CURSOR` → `FETCH 0` (column discovery) → repeated
  `FETCH n` batches → `CLOSE` + `COMMIT`/`ROLLBACK` + release
  (`src/adapters/postgres.ts:1086-1180`). The held slot is why the pool needs
  more than one slot (§3). A short result closes the cursor immediately when
  `FETCH` returns fewer rows than requested (`:1159-1167`) so the slot frees
  before later statements queue into `connectionTimeoutMillis`.
- **MySQL.** Streaming holds the single pool connection for the stream's
  whole life (`openStreamingQuery`, `src/adapters/mysql.ts:653`) and arms the
  core query with `timeout: 0` (`:663-667`) — mysql2's query-level timer
  would otherwise kill long-running load-more streams while data is still
  flowing. The raw stream is taken via `coreQuery.stream()` (`:675`); the
  `firstFields` promise settles on every terminal path — `fields`, `error`,
  or `end` (`:690-705`, TASK-005 M3) — so a stream that ends without rows
  cannot hang the setup path while pinning the pool.
- **MSSQL.** `requestTimeout: 0` (`src/adapters/mssql.ts:548-554`, comment +
  value) is deliberate: tedious arms the timer at `execSql` and does **not**
  pause/resume it with `request.pause()`, so any finite timeout would kill a
  paused load-more stream mid-flow. Cancellation is the bounded path instead
  (§2.4).

### 2.4 Cancel

- **PostgreSQL.** `cancelActiveQuery` (`src/adapters/postgres.ts:513-546`)
  opens a **dedicated one-off `Client`** (`:521-529`,
  `connectionTimeoutMillis: 5_000` at `:528`) and issues
  `SELECT pg_cancel_backend($1)` per active PID (`:532-538`) — never through
  the pool, because pool slots may be pinned by cursors/transactions and a
  pooled cancel would queue for 10 s and time out (the CRITICAL #2 rationale,
  `:1185-1188` and `cancelBackendViaDedicatedClient` at `:1225-1257`). The
  BatchedQuery cursor has its own cancel path (`:1181+`); the seam never
  closes the pool or adapter. Best-effort: per-PID and connect failures are
  swallowed (`:535-537`, `:539-540`).
- **MySQL.** `cancelActiveQuery` (`src/adapters/mysql.ts:357-368`) fires the
  live ownership-window closures: `connection.destroy()` for the held
  non-streaming transaction connection (registered `:261-273`) and
  `stream.destroy()` + `promiseConnection.destroy()` for the pre-handoff
  stream (contract documented `:338-356`). Destroy-or-release is exclusive so
  a cancelled connection is never released twice (`:260-272`, `:295-302`).
  Best-effort: closure throws are swallowed (`:362-366`). Post-handoff
  cancellation goes exclusively through `BatchedQuery.cancel()`; the seam
  never touches a live cursor.
- **MSSQL.** `cancelActiveQuery` (`src/adapters/mssql.ts:225-255`) calls
  `request.cancel()` on the requests live in `activeRequests` (snapshot
  first, `:247`); it never closes the adapter or connection and never touches
  `operationQueue` (`:235-237`). The connection is configured with
  `cancelTimeout: 5_000` (`:555`) — tedious's own bound on the cancel
  round-trip. The same primitive is used by `close()` (`:205-211`).

### 2.5 Pool

- **PostgreSQL.** One shared `pg.Pool`, `max: 4` (`PG_POOL_MAX`,
  `src/adapters/postgres.ts:107`, applied `:305-314`). pg-pool opens slots
  **on demand** (`:303-304`: "pg-pool only opens slots on demand"), so idle
  VSDB connections cost nothing; each extra slot is one additional TCP+auth
  handshake (~ms).
- **MySQL.** One shared pool with `connectionLimit: 1`,
  `waitForConnections: true`, `queueLimit: 0` (`src/adapters/mysql.ts:155-157`).
  A single slot is deliberate (§3): it is what makes a streaming/transaction
  hold mutually exclusive with other work, and it makes destroy-based cancel
  well-defined (the class docstring at `:88-92`). `queueLimit: 0` means the
  waiting queue is **unbounded** — see §4, the recorded gap.
- **MSSQL.** **No pool at all**: `createConnection` builds one tedious
  `Connection` (`src/adapters/mssql.ts:514-559`) held on the adapter
  (`this.connection`); concurrency is serialized by the `enqueue` promise
  chain (§2.2). There is no second connection and no connect-on-demand
  replacement — `connect()` is idempotent via `connected`/`connecting`
  guards (`:114-115`).

### 2.6 Broken socket / close

- **PostgreSQL.** `close()` (`src/adapters/postgres.ts:323-369`) first
  cleans up every open cursor: ROLLBACK + `release(true)` per record, raced
  against a **2 s** guard so close cannot hang on a wedged cursor
  (`:328-348`, CRITICAL #3). Then `pool.end()` is raced against a **3 s**
  timeout guard (`:350-363`), errors swallowed — the adapter is logically
  closed either way. Mid-operation socket death is surfaced by the driver as
  a query/cursor error; the fetch-error path rolls back and
  `releaseClient(true)`s (`:1169-1178`).
- **MySQL.** `close()` is deliberately minimal: null the field, `pool.end()`
  (`src/adapters/mysql.ts:198-204`). mysql2's pool end closes the single
  physical connection; there is no per-request bookkeeping to unwind because
  at most one request can be in flight.
- **MSSQL.** `close()` (`src/adapters/mssql.ts:198-223`) cancels every
  request in `activeRequests` best-effort (`:205-211`) — tedious permits one
  request at a time, so a stale request would otherwise outlive the close —
  clears the set (`:212`), drops the connection reference (`:214-215`), and
  calls `connection.close()` best-effort (`:216-222`; tedious closes
  asynchronously).

**Wave-0 scope note.** §2 documents the *static* contract from source. The
**measured** finite-failure behavior of each path — slow connect, occupied
pool, cancelled stream, broken socket per driver (roadmap wave-0 acceptance,
`docs/plans/2026-09-01-vsdb-additive-roadmap.md:263`) — is produced by the
wave-1 probes and appended to §7 by TASK-ARP05-001/002/003. This ADR does not
pre-fill those measurements.

## 3. Intentional differences (deliberate, not drift)

The three adapters are **not** meant to converge on one configuration. Each
divergence below is a deliberate, comment-documented decision:

1. **PostgreSQL slot isolation (`max: 4`).** The pool was deliberately raised
   from `max: 1` to `PG_POOL_MAX = 4` to fix the
   `pg-metadata-vs-transaction-window` bug
   (`src/adapters/postgres.ts:291-304`): with one slot, background metadata
   traffic (schemaTree row counts, keyword completion, AI run_sql) queued
   behind a pinned transaction/cursor client and failed after
   `connectionTimeoutMillis`. Now `runQuery` holds one client for a whole
   multi-statement run and `beginTransaction` pins its own, so **metadata
   queries land on their own session and can never interleave into a user's
   open transaction or mid-script statement stream** (`:299-304`). Slots open
   lazily, so the cost is paid only when concurrency actually exists.
2. **MySQL single-slot stream/transaction isolation (`connectionLimit: 1`).**
   The opposite trade, deliberately: one slot guarantees that a streaming
   SELECT or an open transaction is mutually exclusive with all other work
   (`src/adapters/mysql.ts:88-92`), and it is what makes `destroy()`-based
   cancellation unambiguous — the thing being destroyed is exactly the
   statement being cancelled. The single-SELECT streaming arm returns before
   the transaction batch and must never itself be wrapped in a transaction, or
   it would pin the `connectionLimit: 1` pool (`:250-252`).
3. **MSSQL `requestTimeout: 0` paused-stream survival.** Tedious arms the
   request timer at `execSql` and does not pause it with `request.pause()`
   (`src/adapters/mssql.ts:548-553`), so any finite `requestTimeout` kills a
   load-more stream mid-flow. `requestTimeout: 0` is therefore required for
   the grid's paused-stream model; boundedness is delegated to cancellation
   (§2.4) instead of a timer.

Any proposal that changes one of these values must cite this section, state
which behavior it preserves, and show measurement — see the rejected
alternatives in §6.

## 4. Known gap — MySQL unbounded queue wait (`queueLimit: 0`)

**Recorded explicitly as the one known gap in the current contract.**
`MySqlAdapter` runs a single-slot pool (`connectionLimit: 1`,
`src/adapters/mysql.ts:155`) with `waitForConnections: true` and
`queueLimit: 0` (`:156-157`) — `queueLimit: 0` is mysql2's "unlimited queue".
Combined with the single slot, this means:

> A slow statement (or a held stream/transaction) pins the only connection;
> every later `getConnectionWithUtcSession()` call — connect probe, metadata
> query, background runQuery — **enqueues with no upper bound** and waits as
> long as the holder takes. Nothing in the adapter bounds that wait today.

This is the gap **TASK-ARP05-002 is expected to close** with a bounded
acquire. The planner's recommendation is `acquireTimeout: 10_000`, aligned
with the driver's `connectTimeout: 10_000` (`:158`) so both failure surfaces
agree on one 10-second budget; the exact bound is a recommendation, not a
decision — **the measured value chosen by TASK-ARP05-002 must be recorded in
§7 once its probe measures the bounded acquire** (PLAN.md §3: the RED probe
contract — a late request must terminate within a bounded wait — is the
invariant; the number must be recorded here). Until that append lands, this
unbounded wait is the documented baseline.

PostgreSQL and MSSQL have no equivalent known gap on the record: PG's
`pool.connect()` waits are bounded by `connectionTimeoutMillis: 10_000`
(`postgres.ts:313`) and MSSQL serializes through `enqueue` with no queue to
grow unboundedly (one waiter per in-flight call, `mssql.ts:574-587`).

## 5. Decision — SLO and no-automatic-replay

**Decision (binding on TASK-ARP05-001, -002, -003; they must not violate
either half):**

**SLO-1 — bounded failure surfaces.**

- **Connect:** a connect attempt against an unreachable/slow server must
  surface success or an error within ≤ 10 s (PG `connectionTimeoutMillis:
  10_000`, `postgres.ts:313`; MySQL `connectTimeout: 10_000`, `mysql.ts:158`;
  MSSQL `connectTimeout: 10_000` + LoggedIn poll deadline 10 s,
  `mssql.ts:547,152`).
- **Queued acquire:** after TASK-ARP05-002 lands, a MySQL acquire against an
  occupied slot must surface within the measured bound recorded in §7
  (recommended ≤ 10 s). PG/MSSQL already meet the 10 s / serialized-with-no-
  queue baselines of §2.5.
- **Cancel:** `cancelActiveQuery` is **best-effort ≤ 5 s**: PG's dedicated
  cancel client connects with `connectionTimeoutMillis: 5_000`
  (`postgres.ts:528`, also `:1243`); MSSQL sets `cancelTimeout: 5_000`
  (`mssql.ts:555`); MySQL destroy is immediate best-effort with no round-trip
  (`mysql.ts:267-271`). A cancel that fails is swallowed — it must never
  surface as a new error on top of the in-flight statement.
- Deliberate exceptions, documented not accidental: MSSQL queries on the live
  connection and MySQL streams have **no driver-level timer** (§2.3) — their
  boundedness contract is the cancel seam above, and the wave-1 probes must
  demonstrate the cancel seam terminates them.

**SLO-2 — no automatic replay.** **No automatic replay of mutations,
transactions, or cursors.** Specifically:

- Read-only SELECT re-issue after a *bounded, proven-idempotent* failure is a
  **caller decision** — an adapter or shared layer must never silently re-run
  one.
- **Prohibited outright**: automatic retry of mutating statements (INSERT/
  UPDATE/DELETE/DDL), automatic retry of a failed *transaction* (partial
  commits are not rollback-safe from the outside), and automatic re-issue of
  a *cursor* stream (server-side cursor state cannot be transparently
  resumed).
- No reconnect-during-transaction/cursor, no blanket pool resizing, no
  dependency-heavy circuit breakers (roadmap §ARP-05 "Out").

This decision is the invariant the driver tasks implement against: the probes
in §7 measure *failure surfaces*, they do not license retry machinery.

## 6. Rejected alternatives

- **Per-driver value changes without measurement.** Rejected: every value in
  §2 is a deliberate, comment-documented decision from earlier cycles
  (§3). ARP-05's charter is *document + measure + close the one proven gap*;
  retuning values first would invalidate the very baseline the probes are
  supposed to measure and risk regressing the §3 guarantees.
- **A shared base-adapter abstraction** (one `BaseAdapter` owning
  pool/timeout config for all three drivers). Rejected: it breaks the
  lazy-per-dialect factory model (`src/adapters/factory.ts:14-26` —
  `createAdapter` instantiates exactly one concrete adapter per driver) and
  the DBX-08 declared capability matrix, where each adapter freezes its own
  capabilities (`postgres.ts:282-287` all-true; `mysql.ts:137-142` and the
  MSSQL equivalent all-false) as the source of truth for admission. The
  adapters are intentionally divergent (§3); a shared base would force
  least-common-denominator config and erase exactly the differences this ADR
  documents.
- **Blanket `connectionLimit` raising for MySQL.** Rejected: additional slots
  would let background metadata queries land *inside* a user's open
  transaction window or race a held stream — the exact bug the PG pool raise
  fixed by moving *off* a single shared session
  (`postgres.ts:291-304`), and the reason MySQL's single slot is deliberate
  (`mysql.ts:88-92,250-252`). The sanctioned fix for MySQL's queue wait is a
  **bounded acquire** (§4), not more connections.
- **Dependency-heavy circuit breakers.** Rejected: roadmap §ARP-05 "Out"
  (`docs/plans/2026-09-01-vsdb-additive-roadmap.md:248`). A new stateful
  dependency to bound failures that §5 already bounds with driver-native
  timers adds supply-chain and state-machine risk for no SLO gain.
- **Automatic mutation/transaction/cursor replay.** Rejected: roadmap §ARP-05
  "Out" (`:248`; acceptance `:271` "no mutation/transaction/cursor automatic
  replay"). Silent replay of a mutation can double-apply it; replaying a
  transaction can double-apply committed prefixes; a cursor cannot be
  transparently resumed. §5 SLO-2 codifies this as binding.

## 7. Measured probe evidence (appended by wave-1 tasks)

*(Wave-0 placeholder — stable merge point. Do not edit prior sections when
appending.)*

Wave-1 tasks append their RED/GREEN probe measurements here, each under its
own disjoint named section (a level-2 heading spelled `Probe` + `:` + driver
name — exactly as required by `docs/AI_HANDOFF/PLAN.md` §3), appended BELOW
this line:

*(none yet — measured evidence is produced by TASK-ARP05-001 (PostgreSQL:
slow connect, occupied pool, cancelled stream, broken socket; pool/close/
cancel recovery), TASK-ARP05-002 (MySQL: held single connection and terminal
error path preserve streaming; measured unbounded-wait evidence for §4 and
the chosen `acquireTimeout` bound recorded here), and TASK-ARP05-003 (MSSQL:
paused stream not timed out; cancellation and late request cannot wedge the
`enqueue` chain) during wave 1.)*

Until those appends land, no measured evidence exists; the §2/§4/§5
statements above are the source-derived contract the probes measure against.

## Probe: MSSQL

*(appended by TASK-ARP05-003, worktree `task-arp05-003`, base `0dd021e`; pins
live in `src/adapters/__tests__/mssql.parameterized.test.ts`, describe blocks
`MsSqlAdapter ARP-05.3 — …`; DB-free fake tedious surface per the existing
`makeDeferredAdapter` pattern.)*

**Measured result: contract already holds on base `65b9c4f` — pin-only, no
production change** (`git diff 65b9c4f -- src/adapters/mssql.ts` is empty).
The five probe cases below went GREEN on the first run against today's code,
as the task expected (`requestTimeout: 0` at `mssql.ts:554`,
`cancelTimeout: 5_000` at `:555`, `enqueue` `finally`-release at
`:574-587`, `settled` guard at `:608-624`, connect `fail()` cleanup at
`:124-136` + `connecting` reset at `:191-193`). To prove the pin is not
vacuous, a sensitivity mutation probe flipped `requestTimeout: 0` →
`5_000` and the pin caught it (RED), then the pristine source was restored
and the suite went GREEN again.

| # | Path probed (ADR §2 row) | Measured behavior on base | SLO |
|---|---|---|---|
| 1 | Stream — paused SELECT not timed out (`requestTimeout: 0`) | `createConnection()` options read at the real tedious constructor: `requestTimeout 0`, `cancelTimeout 5000`, `connectTimeout 10000`; 600-row stream parks a 500-row batch, `request.pause()` fires, a 50 ms mid-flow stall passes with **zero** `Request.setTimeout` calls, stream then drains 100 rows → EOF | deliberate no-timer exception (§5 SLO-1); cancel is the bounded path |
| 2 | Cancel — live request cancels within `cancelTimeout` | `request.cancel()` drives the error path; awaiting `runRequest` rejects "Canceled." in < 5 s; `activeRequests` drained to 0 | ≤ 5 s best-effort cancel (§5 SLO-1) — met |
| 3 | Query — late failure cannot wedge the `enqueue` chain | 2 queued `execute()` ops; first request rejects; `enqueue`'s `finally` still releases the chain → second request issued and resolves; `operationQueue` back to idle resolved | serialized, no queue growth (§2.5); no automatic replay (§5 SLO-2) |
| 4 | Connect — failure cleans up | `error` event → `clearConnection` (reference null, `connected` false) + best-effort `connection.close()` (1 call) + `connecting` reset in `.finally` → later `connect()` retries cleanly | ≤ 10 s surface (§5 SLO-1; driver `connectTimeout` 10 s) — met |
| 5 | Cancel — cancel/late error after settle is a no-op | settled request: late `error` event and `request.cancel()` swallowed by the `settled` guard; promise stays resolved (`rowCount 7`), `finish` never re-invoked, adapter seam on empty set resolves silently | state final; no duplicate settle |

Verbatim probe output (RED sensitivity mutation `requestTimeout: 0` →
`5_000`, then restored GREEN):

```text
# RED (sensitivity mutation — requestTimeout: 5_000):
 ❯ src/adapters/__tests__/mssql.parameterized.test.ts  (17 tests | 1 failed) 378ms
   ❯ src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter ARP-05.3 — paused-stream survival (requestTimeout: 0) > #1 pin: streaming SELECT is not timed out — requestTimeout 0, no request timer armed, long paused load-more survives
 FAIL  src/adapters/__tests__/mssql.parameterized.test.ts > MsSqlAdapter ARP-05.3 — paused-stream survival (requestTimeout: 0) > #1 pin: streaming SELECT is not timed out — requestTimeout 0, no request timer armed, long paused load-more survives
 ❯ src/adapters/__tests__/mssql.parameterized.test.ts:521:39
 Test Files  1 failed (1)
      Tests  1 failed | 16 passed (17)

# GREEN (base source restored — pin-only, git diff 65b9c4f -- src/adapters/mssql.ts empty):
 ✓ src/adapters/__tests__/mssql.parameterized.test.ts  (17 tests) 493ms
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

`npm run typecheck` and `npm run compile` exit 0 on the pin-only tree. No
gap found; `src/adapters/mssql.ts` untouched by this task.

## 8. Consequences and bindings

- **TASK-ARP05-001 (PostgreSQL):** implements/tests within §2's PG column;
  must preserve `max: 4` slot isolation (§3.1) and the dedicated-client
  cancel path (§2.4); appends its probe evidence to §7 under its
  driver-named section. Expected pin-only unless its probe proves a gap
  (PLAN.md §3: no PG gap currently known).
- **TASK-ARP05-002 (MySQL):** closes the §4 gap with a bounded acquire;
  must preserve `connectionLimit: 1` isolation (§3.2) and streaming; records
  the measured bound in §7 under its driver-named section.
- **TASK-ARP05-003 (MSSQL):** pins §2.3/§2.4 (paused-stream survival, cancel
  + late-request non-wedging); must preserve `requestTimeout: 0` and the
  `enqueue` chain; appends its probe evidence to §7 under its driver-named
  section.
- **TASK-ARP05-004 (host message):** reads §7's measured evidence before
  deciding closed-as-not-needed vs. a `connectionManager.ts` change; the
  gate decision is evidence-based, not predetermined (PLAN.md §3).
- **All tasks:** §5's no-replay rule and the §3 intentional differences are
  constraints, not suggestions — a probe or implementation that requires
  relaxing either needs a new ADR.
- Release notes for the shipping release should mention the MySQL bounded
  acquire (user-visible behavior change: an occupied-slot wait can now fail
  fast after the recorded bound instead of waiting indefinitely).
## Probe: PostgreSQL

*(Appended by TASK-ARP05-001 — measured RED/GREEN probe results for the PG
column of §2. Pins stayed GREEN on base commit `0dd021e`; one production gap
was proven by the RED probe and closed minimally in `src/adapters/postgres.ts`
`connect()`.)*

- **Pool isolation (§2.5, pin — GREEN on base).** With all `PG_POOL_MAX = 4`
  slots held by a `pool.connect()` client, a metadata `pool.query` still ran
  on its own slot and resolved (no `connectionTimeoutMillis` fail). `Pool`
  constructed with `max: 4`. Probe line:
  `✓ metadata does not queue behind a pinned cursor/transaction client (PG_POOL_MAX=4, pin)`
- **Failed connect → release (§2.1 — RED on base, gap proven, fixed).** RED
  probe on base: after the `SELECT 1` probe rejected, the half-open `Pool`
  was never ended (`expect(sharedPool.end.mock.calls.length).toBe(...)` →
  `AssertionError: expected 19 to be 20`) — `this.pool` stayed set, so a
  retry would have reused a dead pool. GREEN after the fix: `pool.end()`
  called exactly once, `this.pool` nulled, the next `connect()` builds a
  fresh `Pool` (constructor call count +2 across both connects). Probe lines:
  `✕ connect() probe fails → no pool leak: end() once, pool nulled, next connect() builds a fresh pool` (RED)
  `✓ connect() probe fails → no pool leak: end() once, pool nulled, next connect() builds a fresh pool` (GREEN)
- **Close with open cursor < 5s (§2.6, pin — GREEN on base).** With a
  registered open cursor and a hanging `pool.end()`, every open cursor got
  `ROLLBACK` + `release(true)` and `close()` resolved via the guard:
  measured elapsed ≥ 3s (the 3s pool.end guard fired, not an instant
  resolve) and < 5s. Probe line:
  `✓ close() with an open cursor resolves < 5s: ROLLBACK + release(true), pool.end() raced vs the 3s guard (pin)`
- **Cancel via dedicated client, pool untouched (§2.4, pin — GREEN on
  base).** With all pool slots held and one tracked PID, `cancelActiveQuery()`
  opened exactly ONE one-off `Client` with `connectionTimeoutMillis: 5_000`,
  issued `SELECT pg_cancel_backend($1)` with `[pid]`, `end()`ed it, and made
  zero pool calls (`connect`/`query`/`end` counts unchanged) — ARP-02
  semantics preserved. Probe line:
  `✓ cancelActiveQuery uses a dedicated client, never the pool (all slots held) (pin)`
- **Idle/no-PID cancel no-op (§2.4, pin — GREEN on base).** Empty
  `activeNonCursorPids` → zero `new Client(...)` constructions,
  `cancelActiveQuery()` resolved silently. Probe line:
  `✓ idle/no-PID cancel is a no-op: no dedicated client opened, resolves silently (pin)`

Suite result after the fix: `Tests  23 passed (23)` —
`npx vitest run src/adapters/__tests__/postgres.test.ts`.

## 8. Consequences and bindings

- **TASK-ARP05-001 (PostgreSQL):** implements/tests within §2's PG column;
  must preserve `max: 4` slot isolation (§3.1) and the dedicated-client
  cancel path (§2.4); appends its probe evidence to §7 under its
  driver-named section. Expected pin-only unless its probe proves a gap
  (PLAN.md §3: no PG gap currently known).
- **TASK-ARP05-002 (MySQL):** closes the §4 gap with a bounded acquire;
  must preserve `connectionLimit: 1` isolation (§3.2) and streaming; records
  the measured bound in §7 under its driver-named section.
- **TASK-ARP05-003 (MSSQL):** pins §2.3/§2.4 (paused-stream survival, cancel
  + late-request non-wedging); must preserve `requestTimeout: 0` and the
  `enqueue` chain; appends its probe evidence to §7 under its driver-named
  section.
- **TASK-ARP05-004 (host message):** reads §7's measured evidence before
  deciding closed-as-not-needed vs. a `connectionManager.ts` change; the
  gate decision is evidence-based, not predetermined (PLAN.md §3).
- **All tasks:** §5's no-replay rule and the §3 intentional differences are
  constraints, not suggestions — a probe or implementation that requires
  relaxing either needs a new ADR.
- Release notes for the shipping release should mention the MySQL bounded
  acquire (user-visible behavior change: an occupied-slot wait can now fail
  fast after the recorded bound instead of waiting indefinitely).
## Probe: MySQL

*(appended by TASK-ARP05-002, wave 1 — measured RED/GREEN evidence for §4,
the chosen acquire bound, and the mysql2 option-support measurement.)*

**Chosen bound (recorded per §4/§5): `acquireTimeout` = `10_000` ms**
(module-scoped `POOL_ACQUIRE_TIMEOUT_MS` in `src/adapters/mysql.ts`, default
`10_000`, aligned with the driver's `connectTimeout: 10_000` so both failure
surfaces share one 10-second budget, per §5 SLO-1). Overridable for the
DB-free suite via `setPoolAcquireTimeoutMsForTests` (test stubs 50 ms; the
suite never waits a real 10 s).

**Measured RED (base `65b9c4f` — `queueLimit: 0` + no acquire bound; the late
request waits forever and the probe dies at the test timeout):**

```
FAIL  src/adapters/__tests__/mysqlQueueBound.test.ts > MySqlAdapter — bounded acquire wait (TASK-ARP05-002 case 2) > case 2b: a late request against a held single slot rejects within the injected bound
Error: Test timed out in 2000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".

FAIL  src/adapters/__tests__/mysqlQueueBound.test.ts > MySqlAdapter — bounded acquire wait (TASK-ARP05-002 case 2) > case 2a: pool factory options include acquireTimeout = the injected POOL_ACQUIRE_TIMEOUT_MS
AssertionError: expected undefined to be 50 // Object.is equality

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
```

(The 3 passing tests on the pre-state are the streaming/cancel/terminal pins —
existing behavior, pinned unchanged.)

**Measured GREEN (bounded acquire landed; same suite, 50 ms injected bound):**

```
 ✓ src/adapters/__tests__/mysqlQueueBound.test.ts  (5 tests) 88ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  309ms
```

Case 2b asserts BOTH surfaces: the pool factory options now carry
`acquireTimeout = POOL_ACQUIRE_TIMEOUT_MS`, and a second checkout against the
held `connectionLimit: 1` slot rejects with
`MySqlAdapter: acquire timed out after 50ms (pool slot held by another
query/stream/transaction)` well under the 1.5 s ceiling — termination within
the bound, deterministically, with no real 10 s wait.

**Driver-support measurement (why the bound is also enforced in the
adapter):** mysql2 3.23.4 (pinned `^3.10.0`) does **not** implement the
`acquireTimeout` pool option — passing it is ignored with a console warning
and the underlying queue still waits forever:

```
$ node -e "require('mysql2/promise').createPool({...,acquireTimeout:50})"
Ignoring invalid configuration option passed to Connection: acquireTimeout.
This is currently a warning, but in future versions of MySQL2, an error will
be thrown if you pass an invalid configuration option to a Connection
```

(the warning fires once per `createPool`, not per physical connection —
measured: `warnings during createPool: 1`). `mysql2/lib/pool_config.js`
recognizes only `waitForConnections/connectionLimit/maxIdle/idleTimeout/
queueLimit/resetOnRelease`; `mysql2/lib/base/pool.js getConnection()` enqueues
with no timeout when the limit is reached. Therefore the adapter enforces the
bound itself with a `Promise.race` at its single checkout choke point
(`getConnectionWithUtcSession`, `src/adapters/mysql.ts`), and a late checkout
that loses the race but is handed a connection afterwards releases it
immediately so the slot is not leaked. The option stays on the factory as the
declared contract; future mysql2 versions that honour it will converge with
the wrapper. §4's gap is closed with this bounded acquire; `connectionLimit:
1`, `waitForConnections: true`, `timeout: 0` streaming, atomic batches, and
the terminal (no-replay) cancel semantics are preserved and pinned unchanged
(§3.2, §5 SLO-1/SLO-2 respected).

## 8. Consequences and bindings

- **TASK-ARP05-001 (PostgreSQL):** implements/tests within §2's PG column;
  must preserve `max: 4` slot isolation (§3.1) and the dedicated-client
  cancel path (§2.4); appends its probe evidence to §7 under its
  driver-named section. Expected pin-only unless its probe proves a gap
  (PLAN.md §3: no PG gap currently known).
- **TASK-ARP05-002 (MySQL):** closes the §4 gap with a bounded acquire;
  must preserve `connectionLimit: 1` isolation (§3.2) and streaming; records
  the measured bound in §7 under its driver-named section.
- **TASK-ARP05-003 (MSSQL):** pins §2.3/§2.4 (paused-stream survival, cancel
  + late-request non-wedging); must preserve `requestTimeout: 0` and the
  `enqueue` chain; appends its probe evidence to §7 under its driver-named
  section.
- **TASK-ARP05-004 (host message):** reads §7's measured evidence before
  deciding closed-as-not-needed vs. a `connectionManager.ts` change; the
  gate decision is evidence-based, not predetermined (PLAN.md §3).
- **All tasks:** §5's no-replay rule and the §3 intentional differences are
  constraints, not suggestions — a probe or implementation that requires
  relaxing either needs a new ADR.
- Release notes for the shipping release should mention the MySQL bounded
  acquire (user-visible behavior change: an occupied-slot wait can now fail
  fast after the recorded bound instead of waiting indefinitely).
