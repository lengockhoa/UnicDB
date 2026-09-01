# PLAN_AIX03 — PORT-AIX-03 Read-only Database Analysis Copilot Hardening

Cycle: AIX-03 · Base: main @ 7bc7b75 (v1.33.0 shipped) · Executor: unic-code · Reviewer: unic-smart

## §1 Intent

PORT-AIX-03 is the next dependency-satisfied portfolio row (RLX-03 shipped; the prior
AIX-03 wave shipped `analysisTools.ts` / visible cards in v1.22.0). This cycle is a
**hardening** pass over the shipped read-only analysis surface, not a new feature. The
user directive (§5 record below) is continuous autonomous execution through the remaining
portfolio; AIX-03 was chosen because its declared dependency (RLX-03 failure/cancel
propagation) is now satisfied at HEAD.

Success means the shipped read-only copilot can no longer be driven past its guard rails
along four axes: **parser bypass**, **rows/secrets leakage**, **connection loss**, and
**attribution**. Each axis is closed with a pinned literal + a regression test that fails
against today's code (TDD RED first).

**Record (§1):** user directive = continuous autonomous execution through the remaining
portfolio. AIX-03 chosen as next dependency-satisfied row: RLX-03
(`ConnectionRecoveryStatus`, generation guards, dispose flag) is shipped; AIX-03 consumes
`onDidChangeRecoveryStatus` + the adapter re-resolution guarantee (`getAdapter()` returns a
new instance after reconnect).

## §2 Scope

**In scope (this cycle):**

1. **Parser hardening** — the residual bypass is the PostgreSQL row-locking clause without
   the `update` keyword: `FOR SHARE` / `FOR KEY SHARE` slip through both
   `parseReadonly` (dbAwareTools) and `isReadOnlySql` (sqlTool). Add a `FOR <lockmode>`
   clause scan to both guards; pin a `non_select` reject (parser) and a new
   `"Read-only violation: FOR UPDATE/SHARE"` reason (sqlTool).
2. **Row-cap / sentinel redaction** — `src/ai/tools/sqlTool.ts` (`executeReadOnly`,
   `ROW_LIMIT`) and `src/ai/tools/dbAwareTools.ts` (`renderTable`, `firstResult`) already
   truncate, but the boundary is untested for the cursor-batch and `maxRows` edges. Pin the
   exact cap literal + `truncated:true` flag and a sentinel row that never reaches the
   output.
3. **Connection-loss bounded propagation** — the panel subscribes to no recovery-status
   signal, so an in-flight turn keeps generating against a connection that is mid-recovery
   or dead. Add a recovery-status seam that cancels in-flight turns on
   `recovering`/`failed`; pin the already-fixed OMP `session/new` exit invariant.
4. **Attribution** — the builtin `runAgent` trace records `tool_start`/`tool_end` with
   `name`/`argsJson`/`isError` but no stable identity. Add `toolCallId` to both trace
   events so the AIX-07 redacted all-turn audit export carries request-level attribution
   (schema stays version 1 — additive event field only). Pin the field presence in
   `src/ai/agent.ts`.

**Out of scope (explicitly not this cycle):**
- PORT-AIX-05 (OMP engine resilience) — queued, depends on this row.
- Any new tool, permission UI, or policy rule — AIX-07's `resolvePolicy` is the single
  source of truth and is unchanged.
- `webview/aiChatPanelMain.ts` rendering changes — cards already render shape-only.

**Same-wave file-overlap constraint:** no two tasks in one wave may edit the same file.
The four axes decompose into three files-disjoint tasks (see §7).

## §3 Approach

**Parser axis.** Source-grounded audit of the portfolio brief's enumerated cases against
HEAD finds that almost all are ALREADY closed: stacked statements (`multi_statement`),
trailing semicolons (single trailing accepted, extra content rejected), EXPLAIN ANALYZE
(`guardSql` + `isReadOnlySql`), `COPY`/`MERGE`/`INSERT`/`CALL`/`EXEC` (`FORBIDDEN_RE`),
writable CTEs (`WCTE` + `containsForbidden`), dollar-quoted DO blocks and function bodies
(first-keyword `non_select` + `create` keyword). The ONE residual bypass is the PostgreSQL
row-locking clause that carries NO `update` keyword: `FOR SHARE` and `FOR KEY SHARE`
(`FOR UPDATE` / `FOR NO KEY UPDATE` are already caught by the `update` alternative).
Both `parseReadonly` (dbAwareTools) and `isReadOnlySql` (sqlTool) accept
`SELECT … FOR SHARE` today, letting a read-only copilot take share row locks.
Resolution: add a `FOR <lockmode>` clause scan to both guards
(`/\bfor\s+(no\s+key\s+update|no\s+key\s+share|key\s+share|update|share)\b/i`),
rejecting with `non_select` (parser) and a new pinned `"Read-only violation: FOR UPDATE/SHARE"`
reason (sqlTool). No widening of `FORBIDDEN_RE` — the other verbs are already
first-keyword-rejected and adding them is over-rejection scope creep.

**Rows/secrets axis.** `sqlTool.executeReadOnly` caps at `ROW_LIMIT=50`; the non-cursor
fallback caps against `last.rows.length`. `dbAwareTools.firstResult` drains the cursor up
to `QUERY_MAX_ROWS` then `renderTable` slices to `cap`. The untested boundaries are (a) a
cursor whose single `fetchBatch()` returns more than 50 rows (already handled, untested)
and (b) the `maxRows`-over-1000 clamp (already handled, untested at the exact 1000 edge).
Pin these. For deterministic sentinel truncation, do NOT use `maxRows:1000`: Postgres
`DEFAULT_BATCH_SIZE=500` (`src/adapters/postgres.ts:98`) means that fixture can terminate
without a truncation line. Instead fake one 500-row cursor batch, set
`maxRows: QUERY_DEFAULT_MAX_ROWS` (100), and place the sentinel at zero-based index 100;
`renderTable` must emit exactly `-- truncated: showing 100 of 500 rows` while omitting the
sentinel. The visible shape summary (`toolShapeSummary`) is already shape-only by
construction, so the meaningful leak boundary is the tool result string itself.

**Connection-loss axis.** The OMP engine's `session/new` cancellation lifecycle was
already fixed by AIX-05 (the `pendingCancel` drain clears `currentSessionId` before the
notify), so that invariant is only PINNED here, not changed. The genuine RLX-03-consumer
gap is that the panel subscribes to no recovery-status signal at all:
`ConnectionManager` exposes `onDidChangeRecoveryStatus: vscode.Event<ConnectionRecoveryStatus>`
with states `recovering`/`recovered`/`failed`, but only `statusBar.ts` consumes it. On
`recovering` or `failed`, an in-flight builtin or OMP copilot turn keeps generating against
a connection that is mid-recovery (or dead). Resolution is pinned: add
`onDidChangeRecoveryStatus?: vscode.Event<ConnectionRecoveryStatus>` to
`AiChatPanelOptions`; the panel subscribes exactly once with
`this.options.onDidChangeRecoveryStatus((status) => { try { ... } catch { ... } })`, owns
and disposes that subscription during teardown, and a later panel construction subscribes
anew. The unmodified four-field status object (`connectionId`, `state`, `attempt`,
`maxAttempts`) triggers the existing `handleStop()` plus existing visible
`session_state:"error"` only on `recovering`/`failed`; `recovered` is a no-op. Listener
throws are swallowed at this boundary, and no new webview message/copy is added. The host
passes the event reference (not a callback and not a manager) as
`onDidChangeRecoveryStatus: mgr.onDidChangeRecoveryStatus` at the verified
`commandOpenAiChat` constructor object, `src/extension.ts:1132–1163` (grep:
`rg -n -C 8 "new AiChatPanel|commandOpenAiChat|onDidChangeRecoveryStatus" src/extension.ts`);
`mgr` is the activation-scoped instance at line 207 and is threaded through the
`vsdb.aiChat` registration at lines 628–632 into the command helper, not re-imported. The
adapter factory already re-resolves per call (`getAdapter()` returns a
new instance after reconnect) and the schema-context cache self-invalidates by adapter
reference identity, so the seam only shortens unsafe turns.

**Attribution axis.** `src/ai/agent.ts` records `tool_start` `{ name, argsJson }` and
`tool_end` `{ name, isError }`. `call.id` (the provider `toolCallId`) is available in the
loop. Real provider ids cannot be recorded raw: `trace.ts` runs `redact()` on every payload
and `LONG_RUN_RE = /[A-Za-z0-9_+/=-]{24,}/g` replaces opaque runs of 24+ characters, so an
OpenAI-shaped `call_abcdefghijklmnopqrstuvwxyz` (31 characters) would otherwise be
redacted. Add `toolCallId: \`tcid:${call.id}\`` to both payloads and a field-specific
allowlist in `redact()` for a `toolCallId` value bearing that exact `tcid:` marker. The
exemption bypasses only `LONG_RUN_RE` for this correlation field; key-level, bearer/basic,
key-value, and all unmarked long-run redaction remain unchanged. This gives AIX-07 export
stable start/end attribution without a schema bump (`AUDIT_EXPORT_VERSION` stays 1).

**Trade-offs / rejected alternatives.**
- *Rejected*: a full SQL tokenizer for `parseReadonly`. The module header already commits
  to "stricter than a real parser" — over-rejection is the designed defense. Adding
  keyword guards keeps that contract and stays testable.
- *Rejected*: bumping `AUDIT_EXPORT_VERSION` for the additive `toolCallId`. Consumers
  (audit export tests) assert only `version === 1`; additive event fields are
  backward-compatible, so bumping would be noise.
- *Rejected*: forcing `run_sql` and `run_readonly_query` into one module to unify the
  cap. They already share `ROW_LIMIT` semantics but live in disjoint files by design
  (registry vs raw-tool); a shared constant would add an import seam for zero behavior.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | `parseReadonly("SELECT 1")` | `{ ok: true, kind: "select" }` |
| happy | `parseReadonly` accepts a valid `WITH … SELECT` | `{ ok: true, kind: "with" }` |
| happy | `executeReadOnly` cursor cap at 50 | `rows.length === 50`, `truncated === true`, `rowCount` = full |
| happy | `run_readonly_query` `maxRows` default 100 | 100 data rows, `truncated` present |
| happy | recovery `recovering` status subscription | panel posts existing `session_state:"error"` without rejection, error bubble, or message corruption |
| happy | audit `tool_start`/`tool_end` carry `toolCallId` | both events `payload.toolCallId === "tcid:c1"` |
| edge (parser/stacking) | `SELECT 1; DROP TABLE t` | `{ ok: false, reason: "multi_statement" }` (already closed — pin) |
| edge (parser/row-lock) | `SELECT * FROM t FOR SHARE` | `{ ok: false, reason: "non_select" }` (RED) |
| edge (parser/row-lock) | `isReadOnlySql("SELECT * FROM t FOR KEY SHARE")` | `{ ok: false, reason: "Read-only violation: FOR UPDATE/SHARE" }` (RED) |
| edge (cap boundary) | `run_readonly_query` `maxRows: 99999` | clamped to exactly 1000 rows |
| edge (sentinel/cursor batch) | 500-row Postgres `DEFAULT_BATCH_SIZE` fixture, sentinel at index 100, `maxRows: QUERY_DEFAULT_MAX_ROWS` | output omits sentinel and contains exactly `-- truncated: showing 100 of 500 rows` |
| edge (connection) | recovery `failed` event during OMP turn | `OmpChatEngine.cancel()` once; existing `session_state:"error"`, no extra error bubble |
| edge (connection/no-op) | recovery `recovered` event | NO cancellation and no visible-state/message mutation |
| edge (redaction) | 31-character provider id `call_abcdefghijklmnopqrstuvwxyz` as `tcid:…` | audit export retains exact marked id; unmarked counterpart is `<redacted>` |
| regression | `isReadOnlySql("EXPLAIN ANALYZE DELETE …")` | still rejected (unchanged) |

≥2 edge cases of genuinely different kinds are satisfied: parser-stacking (structural),
row-lock (keyword/lexical), cap-boundary (numeric), sentinel (privacy), connection
(recovery cancel + no-op).

## §5 Verification Commands

The repo uses `npm` (per project snapshot). Test selection resolves via
`.cache/index/tests-map.json` for `src/` targets; every narrowed selection below maps to a
real test file. The full-suite regression net runs once at the cycle boundary.

```bash
# Parser + cap task
npx vitest run src/ai/tools/__tests__/readonlySqlParser.test.ts src/ai/tools/__tests__/sqlTool.test.ts src/ai/tools/__tests__/dbAwareTools.test.ts

# Connection-loss task
npx vitest run src/ui/__tests__/aiChatPanelDbAware.test.ts src/extension.test.ts src/ai/omp/__tests__/ompChatEngine.test.ts

# Attribution task
npx vitest run src/ai/__tests__/agent.test.ts src/ai/__tests__/auditExport.test.ts src/ai/__tests__/trace.test.ts

# Typecheck + compile (mandatory; project has no separate lint script — `typecheck` is the lint-equivalent)
npm run typecheck
npm run compile
npm test   # cycle-boundary full regression net
```

There is no standalone `lint` script; `npm run typecheck` (`tsc --noEmit`) is the
type-safety gate and is included in every task's Verification Commands.

## §6 Acceptance Criteria

- [ ] `parseReadonly` and `isReadOnlySql` reject `FOR SHARE` / `FOR KEY SHARE` (and still reject `FOR UPDATE` / `FOR NO KEY UPDATE`) (TASK-AIX03-101).
- [ ] `sqlTool` + `dbAwareTools` row caps are pinned at 50 / 100 / 1000 with `truncated:true` and a sentinel never reaches the output (TASK-AIX03-101).
- [ ] OMP `session/new` exit invariant pinned (session id cleared on success and failure; exactly one error card per crash) (TASK-AIX03-102).
- [ ] Panel owns the `onDidChangeRecoveryStatus` event seam, releases/re-subscribes it over panel lifetime, and host wiring passes the existing `mgr` event at `src/extension.ts:1132–1163`; `recovering`/`failed` fail-close turns while `recovered` is a no-op (TASK-AIX03-102).
- [ ] Builtin trace `tool_start`/`tool_end` carry marked `tcid:${call.id}` correlation ids; the marker-only allowlist preserves real ids past the 24-character long-token rule while all unmarked/secret data still redacts (TASK-AIX03-103).
- [ ] `npm run typecheck` → 0 errors; `npm run compile` clean; `npm test` full-suite green.

## §7 Global Constraints

- Executor = unic-code; reviewer = unic-smart (must differ). No git commit, no RUN.md.
- Version floor: Node v22.22.1, npm; no new dependencies, no new config toggles.
- Every pinned literal in a task must be the exact source string (copy, not paraphrase).
- Row bytes never cross the tool-result boundary into a visible shape summary; `redact()`
  is the final pass before any wire/serialization.
- RLX-03 recovery is the sole connection-recovery source of truth — do not re-derive
  reconnect logic in AIX-03.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: corrected three false-positive claims discovered by reading source —
(1) the OMP `session/new` cancel path was already fixed by AIX-05 (`currentSessionId = null`
is present in the `pendingCancel` drain), so TASK-AIX03-102 pins that invariant instead of
claiming it as a new fix; (2) `FOR UPDATE`/`FOR NO KEY UPDATE` are already rejected via the
`update` keyword, so the genuine parser gap is `FOR SHARE`/`FOR KEY SHARE` only; (3) the
brief's other parser cases (stacked statements, EXPLAIN ANALYZE, COPY/MERGE/DO/CALL/EXEC,
writable CTEs) are already closed at HEAD. Plan and tasks were narrowed to the real gaps.
Known gaps: none.

## Plan Review Log

### Round 1 — 2026-09-01 · unic-smart
Status: Issues Found

COMPLETENESS:
  - TASK-AIX03-102 host wiring gap: plan §3 pins the seam as a panel constructor option and says "host wires mgr.onDidChangeRecoveryStatus at src/extension.ts:630", but no task lists src/extension.ts in Target Files (102 = aiChatPanel.ts + ompChatEngine.ts only). Wiring is unassigned, so the seam is dead in production. See CONSISTENCY.
  - TASK-AIX03-102 has 0 happy-path tests (4 edge + 2 regression); Gate asks ≥1 happy + ≥2 edge.

CONSISTENCY:
  - Seam choice unpinned: §3 says "add an optional recovery-status seam to AiChatPanelOptions", but the Planner Self-Audit admits "extension.ts command construction vs a panel constructor option is left to the executor". The option name `onRecoveryStatus?: (s) => void` is also direction-ambiguous (host-provided callback vs panel-side trigger). Pin one design and assign extension.ts to a task.
  - §3 claim "FOR UPDATE / FOR NO KEY UPDATE are already caught by the update alternative" is true only for parseReadonly (via FORBIDDEN_RE), NOT for sqlTool.isReadOnlySql — which has no update/for scan today and accepts "SELECT ... FOR UPDATE". The pinned regex does close it, so the resolution is correct; only the prose is imprecise.

CLARITY:
  - TASK-AIX03-102 says "re-read src/extension.ts:1085-1165" but commandOpenAiChat is at line 630 (per plan §3 and grep). The cited range is misleading.

SCOPE:
  - Attribution vs redaction conflict (blocks TASK-AIX03-103 as written): trace.ts redact() runs scrubString over every string, and LONG_RUN_RE (/[A-Za-z0-9_+/=-]{24,}/) replaces ≥24-char opaque runs with "<redacted>". Real provider toolCallId values (OpenAI call_…, Anthropic toolu_…) exceed 24 chars and WILL be scrubbed, defeating attribution. Plan §3 asserts "toolCallId is an opaque provider token (safe)" — unverified; test case 4 only uses "c1" (2 chars). Pin either a redact() passthrough for toolCallId or a realistic ≥24-char assertion.

YAGNI:
  - Sentinel test case 8 (TASK-AIX03-101) is under-specified: with maxRows:1000, firstResult drains to QUERY_MAX_ROWS=1000, so renderTable sees total==cap and emits NO "-- truncated" line unless a single fetchBatch overshoots past 1000 (push-then-break). Whether "truncated line present" holds depends on un-pinned fixture batch size (default Postgres batch=500 → no truncation, test fails). Pin batch size, or use maxRows < 1000 (e.g. 100) with sentinel between cap and 1000 so truncation is deterministic at renderTable.

NOTES: Three findings would each cause a broken test or a dead/defeated feature in production: (1) sentinel truncated-line assertion is batch-size-dependent, (2) toolCallId is redacted for real ids, (3) extension.ts recovery wiring is unassigned. Revise before execution; parser regex and cap literals (ROW_LIMIT=50, QUERY_MAX_ROWS=1000, QUERY_DEFAULT_MAX_ROWS=100) are otherwise correctly pinned against source.

### Round 1 Revision — 2026-09-01 · unic-smart
Status: Revised

- TASK-AIX03-101 pins the real Postgres `DEFAULT_BATCH_SIZE = 500` and makes the sentinel fixture deterministic: `maxRows: QUERY_DEFAULT_MAX_ROWS` (100), sentinel at index 100, exact `-- truncated: showing 100 of 500 rows` assertion.
- TASK-AIX03-102 now owns `src/extension.ts`, pins the verified constructor region `1132–1163` and the `mgr` event-reference wiring, names the seam `onDidChangeRecoveryStatus`, specifies subscription/disposal/error containment/re-subscription semantics, and adds a visible happy-path test.
- TASK-AIX03-103 records `tcid:${call.id}` and pins a marker-only, field-specific long-token-redaction exemption; tests use a 31-character realistic provider id and confirm the unmarked counterpart still redacts.
- Plan §§3–4 and acceptance mapping now reflect these implementation/test contracts. No INDEX, ACTIVE, RUN, or source files changed.


### Round 2 — 2026-09-01 · unic-smart
Status: Issues Found

### Round 2 — findings applied without re-review (cap reached)
- 101: case 4 table-driven — `isReadOnlySql` now covers both `FOR SHARE` and `FOR KEY SHARE` in `src/ai/tools/__tests__/sqlTool.test.ts`. No source change required (the pinned regex already covers both).
- 102: case 2b added — `recovered` no-op assertion in `src/ui/__tests__/aiChatPanelDbAware.test.ts` verifying the listener makes zero visible-state writes and posts no error bubble. Plan §4 no-op requirement now has a concrete test row.

COMPLETENESS:
  - `docs/AI_HANDOFF/tasks/TASK-AIX03-102.md:31-42` omits the plan §4 recovery/no-op case (`recovered` must make no cancellation or visible-state/message mutation). No existing target test covers `recovered`; the task's acceptance criterion at lines 74-77 requires it, so add a concrete edge case in `src/ui/__tests__/aiChatPanelDbAware.test.ts` and assert the no-op.
  - `docs/AI_HANDOFF/tasks/TASK-AIX03-101.md:25-32` tests `isReadOnlySql` only for `FOR SHARE`, while plan §4 line 148 requires the independently implemented sqlTool guard to reject `FOR KEY SHARE`; no existing sqlTool test covers that variant. Add the exact `FOR KEY SHARE` assertion to `src/ai/tools/__tests__/sqlTool.test.ts` (or make case 4 table-driven over both clauses).
CONSISTENCY:
  - The six Round 1 findings are otherwise addressed: TASK-102 now owns and pins `src/extension.ts` event-reference wiring with an unambiguous seam and happy path; TASK-101 pins the 500-row batch fixture; TASK-103 pins the marker-only long-run exemption and a 31-character real-id case.
CLARITY:
  - none
SCOPE:
  - none — the three Wave 1 tasks have disjoint source and test-file target sets.
YAGNI:
  - none

NOTES: The two omitted assertions are substantive Test Plan/acceptance gaps, not cosmetic: each protects a distinct branch or independently changed guard. `npm` scripts and pinned literals were verified against source; typecheck is included in every task and the plan correctly records that no standalone lint script exists.
