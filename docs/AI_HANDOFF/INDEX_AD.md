# INDEX_AD

Cycle AD — **DB-AWARE AI CHAT + OMP CONFIG BRIDGE**: five read-only database tools gated by explicit permission cards, plus an opt-in OMP config injection bridge. Release target v1.10.0.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-001 | Readonly SQL parser, five DB-aware tools, host permission gate | approved | none | unic-smart |
| TASK-002 | Webview permission-card coverage and wire-contract verification | approved_minor | TASK-001 | unic-smart |
| TASK-003 | OMP config exporter, commands, formatSystemPrompt extraction | approved_minor | none | unic-smart |

Graph: TASK-001 → TASK-002; TASK-003 independent.

- Wave 1 (2): TASK-001, TASK-003
- Wave 2 (1): TASK-002

Verification: full Vitest suite 128 files, 1937 passed / 2 skipped; `npm run typecheck` exit 0. Review R2/R3 found no blocking defects. Minor notes are non-functional documentation/test-strength suggestions.

Scope lock: config injection only; no OMP child-process session wiring, slash commands, or grid overhaul.
