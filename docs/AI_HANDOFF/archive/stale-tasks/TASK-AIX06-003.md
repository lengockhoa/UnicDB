# TASK-AIX06-003 — builtin path bridge

Cycle: AIX-06 · Wave 5 · Priority: P1
Status: pending
Depends on: AIX06-001
Reviewer: unic-smart (cycle reviewer)

## Spec

Wire the trace recorder into the builtin agent path so debug
inspection works without OMP:

1. `src/ai/agent.ts`:
   - `runAgent(input, deps, callbacks, options?)` grows an optional
     `trace?: TraceRecorder` field.
   - When present, `runAgent` records:
     - `prompt` once with `{ text: input }` at start.
     - `delta` per `callbacks.onText(text)` chunk with `{ text }`.
     - `tool_start` before each tool call with `{ name, args }` (args
       passed through `redact`).
     - `tool_end` after each tool call with `{ name, isError }` (the
       result text is the tool's shape summary, no row bytes).
     - `error` with `{ message }` on throw, before rethrow.
     - `done` in `finally` after a clean settle.
   - When `trace` is omitted, behaviour is unchanged.

2. Tests (append to `src/ai/__tests__/agent.test.ts`):
   - A clean turn emits `prompt, delta?, tool_start?, tool_end?, done`.
   - A throwing tool emits `prompt, tool_start, tool_end (isError:true), error`.
   - `redact` scrubs `apiKey` from `tool_start` args.
   - When `trace` is omitted, no recorder methods are called and
     the test fakes the recorder to assert zero calls.

## Acceptance

- [ ] Trace flow on the builtin path matches the OMP path kinds.
- [ ] `tool_start` args redacted.
- [ ] `npx vitest run src/ai/__tests__/agent.test.ts` green.

## Executor

**RED**: `npx vitest run src/ai/__tests__/agent.test.ts` → 2 failed
(no trace param).

**GREEN**: same command → 23 passed (23). Typecheck 0.

Notes:
- `runAgent` signature: `(input, deps, callbacks?, signal?, trace?)` —
  5th positional param, back-compat.
- `prompt` records joined user text; `tool_start` carries
  `argumentsJson` redacted via `redact()`; `tool_end` carries
  `isError`; `done` recorded on the final-return and
  budget-exhausted paths.

**Status: done**

## Reviewer

(verdict appended by reviewer)
