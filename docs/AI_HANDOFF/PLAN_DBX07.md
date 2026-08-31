# Cycle DBX-07 Plan — AIX-06 Trace r3 Review Fixes

Base: `main` @ `8bbb94f` (release v1.25.0). Cycle AIX-06 r2 already merged.
Planning only: this cycle documents the r3 review fixes that were drafted
in the working tree during the Wave 5 cycle-1 review pass.

## §1 Intent

AIX-06 r2 (commit 8bbb94f) shipped `Agent Trace & Replay` with three
review rounds of fixes already on main (r1: redaction false negatives,
global insertion order, delta/thought/onTrace emission, panel wiring,
teardown clear; r2: emit records-before-onTrace, KV_RE whitespace+no-
min, outer error catch). A subsequent review pass (r3) identified three
remaining items the r2 round did not cover, and this cycle ships the
r3 fixes as DBX-07 (Wave 5 cycle 1/3).

User planning answers (verbatim from the Wave 5 review pass):

> scope = 'Agent Trace & Replay r3 review fixes (Recommended)'

**Success definition:** the AIX-06 trace module surfaces a real
monotonic `seq` for every emitted event regardless of recorder
presence, the KV scrubber covers the bare `Authorization: <value>`
form that r2 left visible, and the builtin agent path stops double-
recording on the "AI is not configured" error path. Existing AIX-06
contracts (redaction, bounded storage, global insertion order,
panel wiring, cancel/restart/robustness) remain green.

Scope complexity: LOW
Detected systems: [AI trace module, OMP chat engine, builtin agent path]
Decomposition: 1 module — single task TASK-DBX07-001 owns all four
files and the related tests; no other Wave 5 task shares these files.

### Source-evidence inventory

| Area | Finding | Evidence |
|---|---|---|
| Trace redaction | KV_RE missed the bare `Authorization: <value>` form when value was ≥ 24 chars (LONG_RUN_RE caught it) but a short form like `Authorization: ab` leaked through. | `src/ai/trace.ts:44` (r2 regex lacked `authorization` in the KV alternative) |
| OMP emit | The r2 `emit(trace, turnId, ...)` had no path to build a TraceEvent when the recorder was absent — `onTrace` consumers relying on monotonic seq saw a gap. | `src/ai/omp/ompChatEngine.ts:208-244` (r2 single emit block) |
| Agent path | `runAgent` recorded `error` for "AI is not configured" before throwing, and the outer catch recorded it again — duplicate emit. | `src/ai/agent.ts:246-254` |
| Tests | Existing 22 trace tests, 23 agent tests, 21 ompChatEngine tests cover r2 behaviour. Authorization test (line 27-35) asserts the r3 KV_RE fix. | `src/ai/__tests__/trace.test.ts:27-35` |

## §2 Scope

### In scope — DBX-07 active

- Add `authorization|auth` to the KV_RE alternative in
  `src/ai/trace.ts` so the scrubber catches both the
  `Authorization: Bearer …` form and the raw `Authorization=<value>`
  form (covering the AIX-06 r3 review's "short form leaks" finding).
- Update the Authorization test case in `src/ai/__tests__/trace.test.ts`
  to assert the new behaviour (no raw token, `<redacted>` present).
- Replace the r2 `emit(trace, turnId, ...)` block in
  `src/ai/omp/ompChatEngine.ts` with r3 helpers: a private
  `TurnState { turnId, seq }` interface shared between `send()`,
  `resume()`, and `dispatchNotification`; a `buildEv(state, kind,
  payload)` factory that redacts and assigns a fresh seq; a new
  `emit(trace, state, events, kind, payload)` that builds a recorder
  event when a recorder is attached (existing flow) OR a
  `buildEv` event when only `onTrace` is subscribed (new path).
- Migrate every `dispatchNotification` callsite to read `state` from
  the per-turn `TurnState` instead of the bare `turnId` string, and
  allocate the `state` once at `send()` / `resume()` entry.
- In `src/ai/agent.ts`, remove the duplicate `trace.record(turnId,
  "error", …)` on the "AI is not configured" path; the outer `catch`
  already records the error before rethrow. The throw itself is
  unchanged.

### Out of scope

- New commands/UI, telemetry, persistence beyond the existing in-memory
  recorder, automatic retry, cross-driver parity (MySQL/MSSQL), and
  any other Wave 5 cycle (AIX-06 cycle-review close, AIX-07, RLX-01).
- Recorder API changes (no new public methods, no signature change to
  `record` / `events` / `dump` / `clear`).
- Reordering the trace event sequence or changing the bounded-storage
  constants.

**Same-wave file exclusion:** Wave 5 contains three cycles. AIX-06
cycle-review close is the only Wave 5 cycle that touches
`docs/STATUS.md` / `docs/WORKLOG.md` for the r3 entry; AIX-07 owns
trust/privacy governance and does not touch these files. TASK-DBX07-001
exclusively owns the four source files above and `trace.test.ts`.

## §3 Approach

### DBX-07 active implementation strategy

1. **KV_RE alternative extends.** The r2 regex was
   `\b(api[_-]?key|secret|password|passphrase|token)\b`. The r3 regex
   adds `authorization|auth` to that alternative. Long-form headers
   (≥ 24-char values) were already caught by `LONG_RUN_RE`; the new
   alternative covers short forms and the canonical
   `Authorization: <word>` form. No minimum value length: r2's "no-min"
   rule already applies.
2. **TurnState-backed emit.** `send()` and `resume()` allocate a
   per-turn `TurnState = { turnId, seq: 0 }` when the recorder is
   attached (matching the r2 `turnId` rule) and pass the reference
   into `dispatchNotification`. `emit(trace, state, events, kind,
   payload)` early-returns when `state` is undefined (no recorder,
   no onTrace) and otherwise either records into the recorder (r2
   path) or builds a synthetic event via `buildEv` (r3 path). The
   `buildEv` factory mutates `state.seq` so successive emissions get
   a real monotonic seq even without a recorder.
3. **Single error record on the agent path.** Remove the in-band
   `trace.record(turnId, "error", { message })` from the "AI is not
   configured" early-return; the outer `try/catch` records the error
   once. No new try/catch, no new return shape, no new throw site.

### Trade-offs / rejected alternatives

- Reject making `state` mandatory when no recorder is attached: that
  forces `onTrace`-only consumers to allocate a no-op seq, and
  breaks the existing r2 callsite in `dispatchNotification` that
  must remain no-op when nothing is wired.
- Reject adding a `Buffer<TraceEvent>` for `buildEv` events: the
  r3 path is fire-and-forget, mirroring the r2 panel's
  one-event-per-frame flow. Retention stays inside the recorder.
- Reject relocating `TurnState` to a public export: it is an
  internal contract between `send`, `resume`, and the dispatcher.
  Public re-exports risk consumers depending on the seq counter.

### Portfolio plans — queued, non-active, NOT READY

(No portfolio plan shifts. The pre-existing queue under `PLAN.md` §3
remains unchanged: PORT-RLX-02, PORT-RLX-03, PORT-DBX-06, PORT-DBX-08,
PORT-AIX-03, PORT-AIX-05, PORT-AIX-06/07, PORT-DX-01.)

## §4 Test Plan

| Type | Test Name | Expected | Task |
|---|---|---|---|
| happy / unit | Authorization: <value> is scrubbed | KV_RE alternative catches the bare `Authorization: <value>` form; payload contains `<redacted>` and never the original token. | TASK-DBX07-001 |
| edge — short value | Authorization=ab is scrubbed | r2 "no-min" rule still applies; short values are not leaked. | TASK-DBX07-001 |
| regression | Existing trace tests remain green | All 22 trace tests pass. | TASK-DBX07-001 |
| happy / contract | OMP `onTrace` gets a real seq without a recorder | Subscribing only `onTrace` (no `trace` recorder) still receives events with monotonic `seq` starting at 1. | TASK-DBX07-001 |
| edge — `onTrace` with recorder | Both paths co-exist | Recorder is updated AND `onTrace` receives the recorder-assigned event (no double-seq). | TASK-DBX07-001 |
| regression | All 21 ompChatEngine tests pass | AIX-05/06 contracts remain green. | TASK-DBX07-001 |
| regression | All 23 agent tests pass | The duplicate-record removal does not change the recorded sequence. | TASK-DBX07-001 |
| typecheck | `npm run typecheck` clean | No new types, no signature drift, no unused imports. | Cycle boundary |

Fixtures: pure in-memory `TraceRecorder`, fake `AcpSession` /
`HostMcp`. No live database. No live OMP process.

## §5 Verification

Per task, run the exact focused command in its task file plus
static checking:

```bash
npx vitest run src/ai/__tests__/trace.test.ts \
               src/ai/omp/__tests__/ompChatEngine.test.ts \
               src/ai/__tests__/agent.test.ts
npm run typecheck
```

Both must be green. No release boundary bump — DBX-07 ships as
`fix(AIX-06 r3): …` on top of v1.25.0 / commit 8bbb94f, with the
release target deferred to the AIX-06 cycle-review close (a
separate Wave 5 task).

## §6 Risks

- A mis-migrated callsite would leave `state` undefined and silently
  drop events. Mitigation: `emit()` early-returns explicitly when
  `state` is undefined; `onTrace`-only consumers allocate their own
  state (handled by the `trace !== undefined ? … : undefined`
  branch in `send` / `resume`).
- The `buildEv` path bypasses the recorder's `__g` global seq stamp
  used for `events()` cross-turn ordering. The seq stored on the
  event is sufficient for per-turn monotonicity (the only
  observable contract `onTrace` consumers depend on); cross-turn
  ordering still routes through the recorder when present.
