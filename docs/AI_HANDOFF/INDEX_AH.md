# INDEX_AH

- Cycle AH — results-panel accumulation. Release: v1.13.0.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AH-001 | Runner append mode + global indices + multi-statement cursor discipline | done | none | - |
| TASK-AH-002 | ResultsPanel append-aware render + editor run path threads {append:true} | done | TASK-AH-001 | - |
| TASK-AH-003 | Webview accumulating tabs, "Run N · Statement M" labels, per-tab cache preservation | done | TASK-AH-002 | - |

Graph: TASK-AH-001 → TASK-AH-002 → TASK-AH-003.

- Wave 1 (1): TASK-AH-001
- Wave 2 (1): TASK-AH-002
- Wave 3 (1): TASK-AH-003

No same-wave file overlap (sequential chain). File locks respected: styles.css = cycle AG;
src/ai/** + src/adapters/** + src/core/ddl/** + src/core/sqlFormat.ts = cycle AF (wave 1 in-flight).
extension.ts is shared with pending AF-004 (disjoint regions; AH-002 edits only the runStatements body).

Scope lock: results panel only; no SQL Console internals (AF-004), no tab eviction, no OFFSET-stateless
paging of closed cursors, no change to src/ui/messages.ts wire contract.
