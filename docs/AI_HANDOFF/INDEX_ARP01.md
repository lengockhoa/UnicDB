# INDEX_ARP01

Cycle: ARP-01 Read-only enforcement completeness (transaction execution boundary)
Base: `main @ a948b3f` (v1.36.0)
Plan: `PLAN_ARP01.md`
Executor: `unic-code` · Reviewer: `unic-smart` (MUST differ)

| Wave | Task | Summary | Status | Depends on | Reviewer |
|---|---|---|---|---|---|
| 1 | TASK-ARP01-001 | Classifier matrix: formalize read-only classification by dialect (+ MySQL backtick false-positive fix) | ready | none | unic-smart |
| 1 | TASK-ARP01-002 | Transaction guard: wrap `beginTransaction`/`DbTransaction.runQuery` in `guardAdapter` | ready | none | unic-smart |
| 2 | TASK-ARP01-003 | Interface regression: prove no optional-API bypass (decision gate — may close as not-needed) | ready | TASK-ARP01-001, TASK-ARP01-002 | unic-smart |

Graph: TASK-ARP01-001 → TASK-ARP01-003; TASK-ARP01-002 → TASK-ARP01-003.
Waves: wave 1 = 2 parallel tasks (001 owns `readOnlyIntent.ts`+test [+`dangerousStatement.ts` mask seam], 002 owns `connectionManager.ts`+test — disjoint); wave 2 = 1 verification task (003 owns `types.ts`/`adapterQueryShape.test.ts` only-if-needed).
