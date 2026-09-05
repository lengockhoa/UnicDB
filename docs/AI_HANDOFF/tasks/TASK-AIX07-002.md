# TASK-AIX07-002 — Redacted all-turn audit export primitive

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX07.md` §3

## Goal

Add a pure snapshot/export primitive over AIX-06's bounded in-memory trace. It must produce a serializable all-turn envelope and run redaction again immediately before serialization; it does not write files or decide authorization.

## Target Files

- `src/ai/trace.ts` — add an all-turn snapshot API while preserving existing `dump(turnId: string): TraceDump` and `clear(): void` behavior.
- `src/ai/auditExport.ts` (new) — build/serialize a versioned audit envelope from trace dumps and apply existing `redact()` as final defense.
- `src/ai/__tests__/trace.test.ts` — extend existing recorder tests for the all-turn snapshot ordering/copy contract.
- `src/ai/__tests__/auditExport.test.ts` (new) — TDD coverage for export envelope, credential signatures, and empty/truncated traces.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `dumpAll and audit envelope preserve two ordered redacted turns` | Serialized envelope has its fixed schema/version marker and two turn IDs in recorder insertion order; source recorder stays populated. | Recorder with events for `turn-a` then `turn-b`. |
| 2 | edge — secret signature | `serialized audit export cannot contain credential or authorization sentinels` | Output excludes sentinel API key, nested password/token, and `Authorization: Bearer` value, and includes `<redacted>`. | Trace payloads containing distinct short and long secret-shaped values. |
| 3 | edge — empty/boundary | `empty snapshot and truncated dump serialize valid envelopes` | Empty recorder emits `turns: []`; a capped turn retains `truncated: true` in the export. | Fresh recorder; recorder configured with a small per-turn cap. |
| 4 | edge — mutation | `all-turn snapshot cannot mutate recorder internals` | Mutating/altering returned arrays cannot add an event to subsequent recorder output. | One recorded event followed by a consumer-side mutation attempt. |

Write the tests first and record the actual failing RED command output in the Executor Report before implementation; then make the same tests GREEN.

## Test Files

- `src/ai/__tests__/trace.test.ts` — modifies recorder coverage for `dumpAll()`.
- `src/ai/__tests__/auditExport.test.ts` (new) — contains envelope and byte-scan tests.

## Verification Commands

```bash
npm test -- src/ai/__tests__/trace.test.ts src/ai/__tests__/auditExport.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] Existing `TraceRecorder.dump(turnId: string): TraceDump` remains compatible; the new all-turn snapshot returns ordered, copy-safe `TraceDump` data.
- [ ] The pure audit exporter neither imports `vscode` nor performs filesystem, network, shell, or child-process I/O.
- [ ] A final `redact()` pass occurs before output serialization, so byte-scan tests prove no supplied secret/credential/authorization sentinel escapes.
- [ ] Empty and capped/truncated recordings export valid JSON without throwing.
- [ ] Focused tests, `npm run typecheck`, and `npm run compile` pass.
- [ ] Executor report declares `EXECUTOR_MODEL: unic-code`; reviewer is `unic-smart`.

## Dependencies

- none

## Interfaces

- Consumes: `TraceRecorder.dump(turnId: string): TraceDump`, `TraceDump { turnId: string; events: TraceEvent[]; truncated: boolean }`, and `redact(value: unknown): unknown` from `src/ai/trace.ts`.
- Produces: `TraceRecorder.dumpAll(): readonly TraceDump[]` and a pure audit envelope/serialization API for TASK-AIX07-003. The envelope must contain a stable schema/version marker and ordered `TraceDump` values; it must not contain an API key or credential field.

---

## Discussion

### 2026-08-31 · planner · unic-smart
This slice intentionally has no workspace-trust branch. TASK-AIX07-003 consults TASK-AIX07-001 policy before calling this primitive, so export authorization stays centralized instead of being recreated in the serializer.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (fresh run of `npx vitest run src/ai/__tests__/trace.test.ts src/ai/__tests__/auditExport.test.ts` before implementation):

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-aix07-002

 ❯ src/ai/__tests__/auditExport.test.ts  (0 test)
 ❯ src/ai/__tests__/trace.test.ts  (32 tests | 5 failed) 8ms
   ❯ TraceRecorder.dumpAll (TASK-AIX07-002) > returns turns in insertion order, copy-safe
     → r.dumpAll is not a function
   ❯ TraceRecorder.dumpAll (TASK-AIX07-002) > empty recorder snapshots to an empty array
     → r.dumpAll is not a function
   ❯ TraceRecorder.dumpAll (TASK-AIX07-002) > preserves per-turn truncated flag in the snapshot
     → r.dumpAll is not a function
   ❯ TraceRecorder.dumpAll (TASK-AIX07-002) > snapshot cannot mutate recorder internals
     → r.dumpAll is not a function
   ❯ TraceRecorder.dumpAll (TASK-AIX07-002) > clear() empties dumpAll() too
     → r.dumpAll is not a function

 FAIL  src/ai/__tests__/auditExport.test.ts [ src/ai/__tests__/auditExport.test.ts ]
Error: Failed to load url ../auditExport (resolved id: ../auditExport) in
.../src/ai/__tests__/auditExport.test.ts. Does the file exist?

 Test Files  2 failed (2)
      Tests  5 failed | 27 passed (32)
```

Note: no immediate-GREEN situation — all new tests failed for exactly the expected
missing-API reasons (`dumpAll is not a function`; `../auditExport` module absent).
One post-GREEN fix was to my own test expectation (per-turn `seq` restarts at 1, so
turn-a holds [1,2], not [1,3]); implementation was not touched for it.

Verification Output (fresh in this turn, inside the worktree):

```
$ npm test -- src/ai/__tests__/trace.test.ts src/ai/__tests__/auditExport.test.ts
 ✓ src/ai/__tests__/trace.test.ts  (32 tests) 5ms
 ✓ src/ai/__tests__/auditExport.test.ts  (4 tests) 4ms

 Test Files  2 passed (2)
      Tests  36 passed (36)

$ npm run typecheck
> tsc --noEmit
(exit 0, no output)

$ npm run compile
  dist/extension.js      5.2mb ⚠️
esbuild: build complete
(exit 0)
```

Full-suite regression note (outside required commands): `npm test` = 2731 passed /
9 failed, all 9 in `src/ui/__tests__/consolePanelBundle.test.ts` with
`dist/consolePanel.js missing — run npm run compile before this test`. Confirmed
pre-existing and environmental, not caused by this task: worktree and main tree are
both at commit 0bc205b; `esbuild.js`'s non-watch branch omits `consolePanelConfig`
(it only exists as ctx8 in the watch branch), so a fresh compile never emits
`dist/consolePanel.js`; the main tree passes only because it has a stale Aug 31
11:13 watch-mode artifact. No `src/ai` test fails.

Files changed:
- src/ai/trace.ts — added `dumpAll(): readonly TraceDump[]` (insertion order via
  `this.order`, per-turn `events.slice()` copies, outer array frozen); dump/clear
  and all AIX-06 behavior untouched.
- src/ai/auditExport.ts — new PURE module (imports only `redact`/`TraceDump` from
  `./trace`; no vscode/fs/net/child_process). Exports `AUDIT_EXPORT_SCHEMA`
  ("UnicDB.ai.audit-export"), `AUDIT_EXPORT_VERSION` (1), `buildAuditEnvelope()`
  (copies dumps; no credential field in the envelope frame), and
  `serializeAuditExport()` which applies `redact()` as the FINAL pass immediately
  before `JSON.stringify`.
- src/ai/__tests__/trace.test.ts — new `TraceRecorder.dumpAll` describe block:
  insertion order + per-turn seq, empty snapshot, truncated flag preservation,
  copy/mutation-safety (frozen outer array throws on push; inner-copy mutation
  never reaches recorder), clear() empties snapshot.
- src/ai/__tests__/auditExport.test.ts — new: ordered two-turn envelope + schema
  marker + recorder stays populated; byte-scan test with short (`apiKey=ab` via
  KV_RE no-min), long (>=24 char base64 run via LONG_RUN_RE), nested
  password/token keys, and `Authorization: Bearer <jwt>` sentinels all excluded
  with `<redacted>` present; empty `turns: []` + capped turn keeps
  `truncated: true`; envelope copy-safety.

Status: PASS
Note: none — all §Verification Commands pass; worktree left uncommitted as instructed.



## Reviewer Verdict

### Review · TASK-AIX07-002 · unic-smart
VERDICT: critical_block
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  npx vitest run src/ai/__tests__/auditExport.test.ts src/ai/__tests__/trace.test.ts — PASS (36 tests)
  npm run typecheck — PASS
  npm run compile — PASS
FINDINGS:
  critical:
    - src/ai/auditExport.ts:61 — `JSON.stringify` invokes a copied payload object's `toJSON()` after the final `redact()` pass; `toJSON()` can return `{ apiKey: "sk-live-..." }`, which is serialized raw. Sanitize JSON conversion results or reject/strip executable serialization hooks before stringification, and add a serialized-string sentinel test for this path.
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: blocked

---

## Executor Report (fix round 1)

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code

RED_OUTPUT (fresh run of `npx vitest run src/ai/__tests__/auditExport.test.ts src/ai/__tests__/trace.test.ts` BEFORE the fix — new regression test only, existing 36 unaffected):

```
 FAIL  src/ai/__tests__/auditExport.test.ts > audit export envelope (TASK-AIX07-002) > serialized export cannot leak secrets through a payload toJSON hook
AssertionError: expected '{"schema":"UnicDB.ai.audit-export","ver…' not to contain 'sk-live-sentinel-payload-key'
+ {"schema":"UnicDB.ai.audit-export","version":1,"exportedAt":"2026-08-31T19:03:22.614Z","turns":[{"turnId":"turn-a","events":[{"turnId":"turn-a","seq":1,"kind":"prompt","ts":1788203002614,"payload":{"apiKey":"sk-live-sentinel-payload-key"}}],"truncated":false}]}
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 36 passed (37)
```

Failure is exactly the reviewer's finding: the sentinel appears raw in the serialized string because `redactInner` copies the `toJSON` function property through untouched and `JSON.stringify` invokes it after the final redact pass.

Verification Output (fresh in this turn):

```
$ npx vitest run src/ai/__tests__/auditExport.test.ts src/ai/__tests__/trace.test.ts
 ✓ src/ai/__tests__/trace.test.ts  (32 tests) 4ms
 ✓ src/ai/__tests__/auditExport.test.ts  (5 tests) 4ms

 Test Files  2 passed (2)
      Tests  37 passed (37)

$ npm run typecheck
> tsc --noEmit
(exit 0, no output)

$ npm run compile
esbuild: build complete
(exit 0)
```

Status: PASS
Note:
- Added regression test first (`serialized export cannot leak secrets through a payload toJSON hook`): payload with `toJSON: () => ({ apiKey: "sk-live-sentinel-payload-key" })`; asserts sentinel absent, no `toJSON` in output, plain data preserved, and parsed envelope keeps schema/version/turn shape.
- Fix in `src/ai/auditExport.ts`: new hook-free `toPlainJson()` conversion runs inside `buildAuditEnvelope()` on every turn dump BEFORE redaction/stringification — drops every callable (so `toJSON` can never execute), handles cycles with `"[Circular]"`, maps non-finite numbers/bigints/other non-JSON types to JSON-safe markers, and never throws (same no-throw contract as `redact()`).
- Envelope shape, `AUDIT_EXPORT_SCHEMA`, `AUDIT_EXPORT_VERSION`, and the final redact-before-stringify pass are untouched; stringification stays deterministic (no execution hooks possible between redaction and the wire).
- Main tree (branch main), nothing staged/committed per instructions.
