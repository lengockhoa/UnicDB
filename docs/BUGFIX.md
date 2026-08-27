# Bugfix SOP (Index-First)

## Objective
Reduce bug-fix time by prioritizing evidence + codebase index before deep docs/source reading.

## Required Commands
- `node .claude/ukit/index/build-index.mjs`
- `node .claude/ukit/index/query-index.mjs "<error|symbol|path>"`
- `node .claude/ukit/index/triage.mjs "<error signature>"`

## Decision Tree
1. Have a clear repro command -> run triage index.
2. Fast lane: open at most 1-3 suspect files, small patch, verify the target test.
3. Fail 2 consecutive 15-minute rounds -> switch to deep lane.
4. Deep lane: instrumentation + root-cause tracing before fixing.

## Hard Rules
- Do NOT fix without evidence (failing test / stack trace / logs).
- Do NOT do large refactors in a bug ticket.
- Minimum verification: initial failing test + related tests.
