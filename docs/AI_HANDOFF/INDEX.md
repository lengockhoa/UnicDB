# Handoff INDEX

## Cycle STOPERR — stop multi-query run at first error + mark failing statement

Bugfix/UX cycle: a multi-statement run must halt visibly at the first failing statement
(editor decoration + Problems diagnostic + "stopped at statement N of M" toast), and
selection-run ("bôi đen và chạy") must surface errors instead of silently no-oping or
running a different statement set. Plan: `docs/AI_HANDOFF/PLAN.md`.
(Previous cycle CHATFIX — 4 tasks — is complete; summarized in `RUN.md`.)

| Task | Title | Status | Dependencies | Wave |
|---|---|---|---|---:|
| TASK-STOPERR-001 | splitStatements `baseOffset` (doc-space offsets) + stop-on-error regression pin | ready | none | 1 |
| TASK-STOPERR-002 | `statementErrorMarks.ts` — decoration + DiagnosticCollection marker | ready | none | 1 |
| TASK-STOPERR-003 | Wire marking + "stopped at statement N" toast + fix silent selection-run paths | ready | 001, 002 | 2 |

Execution: lowest ready ID first; wave 1 tasks (001+002) may run in parallel — disjoint
file sets (core parser/runner vs new UI module). Task 003 touches `extension.ts` +
`consolePanel.ts` + `extension.test.ts` and must wait for both wave-1 interfaces. Each task
is TDD RED→GREEN, focused tests + `npm run typecheck` + `npm run compile`; full `npm test`
at each wave boundary. Reviewer must use a different model from executor. No version bump,
package or publish.
