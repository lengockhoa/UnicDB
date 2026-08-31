# TASK-AIX06-002 — OmpChatEngine trace hook

Cycle: AIX-06 · Wave 5 · Priority: P1
Status: pending
Depends on: AIX06-001
Reviewer: unic-smart (cycle reviewer)

## Spec

Let an `OmpChatEngine` flow ordered trace events alongside the existing
event surface, without regressing AIX-05's cancel/restart/robustness:

1. `src/ai/omp/ompChatEngine.ts`:
   - Import `TraceRecorder, TraceKind` from `../trace`.
   - Add `onTrace?(event: TraceEvent): void` to `OmpChatEvents`
     (default-deny; existing fakes without `onTrace` keep compiling).
   - `OmpChatEngineOptions` grows an optional `trace?: TraceRecorder`.
   - `createOmpChatEngine` records events at every emission point:
     - `prompt` once, with `{ text }` payload, before `engine.send`.
     - `delta` per chunk, payload `{ text }` (already plain text).
     - `thought` per chunk.
     - `tool_start` with `{ name, args }` — args run through `redact`.
     - `tool_end` with `{ name, result, isError }` — result is plain
       text shape; not redacted (sanitized at the tool boundary).
     - `error` with `{ message }` (BEFORE onError fires; onError is
       for the panel's high-level state machine and stays independent).
     - `done` once on clean settle.
   - Per-turn seq + ts assigned by the recorder itself; the engine
     only calls `recorder.record(turnId, kind, payload)`.
   - The trace layer is optional; missing `trace` is a no-op.

2. Tests (append to `src/ai/omp/__tests__/ompChatEngine.test.ts`):
   - A clean turn emits `prompt, delta?, done` in order.
   - A tool round-trip emits `prompt, tool_start, tool_end, done`.
   - Crash mid-turn emits `prompt, error` (no `done`).
   - Cancellation via the new `cancel()` still emits `done` only if
     the cancel completes a turn that already streamed (the AIX-05
     contract is preserved — cancel does NOT add a trace event by
     itself; the engine's normal settled path posts `done`).
   - Redaction: a `tool_start` with `args: { apiKey: "sk-live-..." }`
     stores payload `apiKey = "<redacted>"`.

## Acceptance

- [ ] Trace events flow on every turn (clean / crash / cancel).
- [ ] `tool_start` args are redacted before storage.
- [ ] AIX-05 contracts (cancel, restart, dispatchNotification
      robustness) remain green.
- [ ] `npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts` green
      (existing 18 + new cases).

## Executor

**RED**: `npx vitest run src/ai/omp/__tests__/ompChatEngine.test.ts` →
3 failed (no trace flow).

**GREEN**: same command → 21 passed (21). Typecheck 0.

Notes:
- `OmpChatEvents` gains optional `onTrace`; `OmpChatEngineOptions`
  gains optional `trace`. `send()` allocates `turn-N` ids; `resume()`
  allocates `resume-<sessionId>`. `dispatchNotification` grows an
  optional `trace,turnId` tail — tool_start args are redacted inside
  `record()`. `done`/`error` recorded at settle paths.

**Status: done**

## Reviewer

(verdict appended by reviewer)
