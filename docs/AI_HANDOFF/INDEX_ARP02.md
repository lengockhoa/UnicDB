# INDEX_ARP02

Cycle: ARP-02 Shutdown-safe query ownership and connection provenance
Base: main @ 367cb80 (v1.37.0)
Plan: `docs/AI_HANDOFF/PLAN_ARP02.md`
Executor: `unic-code` · Reviewer: `unic-smart` (MUST differ)
Full-suite baseline: 2963 passed | 2 skipped

| Wave | Task | Summary | Status | Depends on | Reviewer |
|---|---|---|---|---|---|
| 1 | TASK-ARP02-001 | Runner ownership: idempotent cancel + run-bounded close-origin cancellation (queryRunner.ts) | pending_review | none | unic-smart |
| 1 | TASK-ARP02-002 | Panel-close race: session-lifetime epoch, stale continuation inert after dispose (resultsPanel.ts) | pending_review | none | unic-smart |
| 1 | TASK-ARP02-003 | Connection provenance: late getAdapterFor candidate not installed after edit/delete/switch (connectionManager.ts) | pending_review | none | unic-smart |
| 2 | TASK-ARP02-004 | Host integration: post-RLX-02 deactivate/command ordering (extension.ts) — conditional: close as not-needed if Wave 1 leaves no host gap | approved_minor | TASK-ARP02-001, TASK-ARP02-002 | unic-smart |

Graph: TASK-ARP02-001 → TASK-ARP02-004; TASK-ARP02-002 → TASK-ARP02-004; TASK-ARP02-003 → TASK-ARP02-004.
Waves: wave 1 = 3 parallel tasks; wave 2 = 1 conditional integration task (gate = Wave-1 host-gap evidence, mirroring TASK-ARP01-003).
