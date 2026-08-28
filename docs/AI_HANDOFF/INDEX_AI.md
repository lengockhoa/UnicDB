# INDEX_AI

Cycle AI — **RESULTS PANEL OPENS BELOW THE EDITOR**: configurable below/beside initial placement; existing panel reveal preserves user-dragged position. Release target = next free patch (1.11.2 unless taken). Plan: PLAN_AI.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-AI-001 | Configurable below/beside initial placement + preserve existing panel group | ready | none | - |

Graph: TASK-AI-001 (single task, wave 1).

- Wave 1 (1): TASK-AI-001

Concurrency note: TASK-AI-001 and TASK-AH-002 both modify src/ui/resultsPanel.ts (disjoint regions:
AI owns options/default/show placement lines; AH owns render/handleMessage append logic). Dispatch
sequentially — AI-001 after AH-002 merges, or vice versa with a re-read before editing. Do not run
in parallel.

File locks respected: webview/styles.css = cycle AG; src/ai/** + src/adapters/** + src/core/ddl/**
+ src/core/sqlFormat.ts = cycle AF; src/core/queryRunner.ts + webview/main.ts = cycle AH.
extension.ts: AI touches ONLY the ResultsPanel construction site (~:146) — disjoint from AH-002's
runStatements body and AF-004's planned hunks.

Scope lock: results panel placement only; no console panel placement, no live re-placement on
setting change, no webview-internal layout changes.
