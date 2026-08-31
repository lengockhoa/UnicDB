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
