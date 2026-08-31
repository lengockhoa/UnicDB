# TASK-AIX06-004 — AiChatPanel wiring + scaffold + docs

Cycle: AIX-06 · Wave 5 · Priority: P1
Status: pending
Depends on: AIX06-002 + AIX06-003
Reviewer: unic-smart (cycle reviewer)

## Spec

Wire `TraceRecorder` into the chat panel and close the cycle docs:

1. `src/ui/aiChatPanel.ts`:
   - `AiChatPanel` constructs a `TraceRecorder` once (private field).
   - `runBuiltinTurn` and `runOmpEngineTurn` thread it into `runAgent`
     / `engine.send` respectively.
   - A `dumpTrace(turnId)` helper is exposed (no UI surface in this
     cycle — reserved for AIX-07 audit export / future debug).
   - A `clearTrace()` helper resets the recorder (wired to Clear +
     Panel dispose).

2. `src/__tests__/aix06Scaffold.test.ts`:
   - `src/ai/trace.ts` exports `TraceRecorder` + `redact`.
   - `OmpChatEvents` has an optional `onTrace`.
   - `OmpChatEngineOptions` accepts an optional `trace`.
   - `runAgent` accepts an optional `trace`.
   - No `shell:true` / `execSync` in any AIX-06 production file.
   - `trace.ts` byte-scan: no apiKey / secret / token literals.
   - Test files exist: `src/ai/__tests__/trace.test.ts`,
     `src/ai/omp/__tests__/ompChatEngine.test.ts` (already has trace
     block), `src/ai/__tests__/agent.test.ts` (already has trace block).

3. CHANGELOG 1.26.0 + README bullet after the 1.25.0 line.

## Acceptance

- [ ] Parity: builtin and OMP/MCP turns both populate the recorder.
- [ ] `dumpTrace` returns a JSON-serialisable envelope with a
      `truncated` flag when overflow occurred.
- [ ] `clearTrace` empties the recorder; `handleClear` calls it.
- [ ] Scaffold green.
- [ ] CHANGELOG link block intact.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
