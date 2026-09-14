# Handoff INDEX

## Cycle AICHAT — research-complete rewrite of docs/AI_CHAT_REDESIGN.md

Base: main @ b7f49fc (2026-09-14). SPEC-ONLY cycle (P0, user-confirmed): the single deliverable
is `docs/AI_CHAT_REDESIGN.md` rewritten into a research-complete, implementation-ready spec.
NO runtime source changes; every task writes only under `docs/`. User mandates: (1) extensive
internet research folded into the spec; (2) "as much detail as possible" — far denser than the
70-line baseline draft. The draft's dangling promise (three unnamed Marketplace extensions,
research blocked) is resolved by documented substitution: GitHub Copilot Chat, Cline, Continue
+ official VS Code docs / WAI-ARIA APG.

Prior cycle CLIPGRID archived at `INDEX_CLIP.md` / `PLAN_CLIPGRID.md` (4/4 done, v1.53.45).

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-AICHAT-001 | Webview fact-base — verify draft anchors, inventory chat webview files, gap list | pending_review | none | docs/AI_HANDOFF/notes/aichat-factbase-webview.md (new) | unic-smart |
| TASK-AICHAT-002 | Host/engine fact-base — protocol, sessions, permissions, streaming, 4-engine capability matrix | ready | none | docs/AI_HANDOFF/notes/aichat-factbase-host.md (new) | unic-smart |
| TASK-AICHAT-003 | External research — VS Code, Copilot Chat, Cline, Continue, WAI-ARIA (Q01–Q22, evidence-labeled) | ready | none | docs/AI_HANDOFF/notes/aichat-research-external.md (new) | unic-smart |
| TASK-AICHAT-004 | Draft upgraded composer/slash/mention/geometry-a11y sections (KBD/SLASH/MENTION/A11Y) | ready | TASK-AICHAT-001, TASK-AICHAT-002, TASK-AICHAT-003 | docs/AI_HANDOFF/notes/aichat-sections-composer.md (new) | unic-smart |
| TASK-AICHAT-005 | Draft NEW platform sections — streaming, timeline, sessions, permissions, failures, engine matrix (STREAM/TIME/SESS/PERM/FAIL) | ready | TASK-AICHAT-001, TASK-AICHAT-002, TASK-AICHAT-003 | docs/AI_HANDOFF/notes/aichat-sections-platform.md (new) | unic-smart |
| TASK-AICHAT-006 | Consolidate final spec — rewrite docs/AI_CHAT_REDESIGN.md, verify anchors, sequencing appendix | ready | TASK-AICHAT-004, TASK-AICHAT-005 | docs/AI_CHAT_REDESIGN.md | unic-smart |

Waves: wave 1 = AICHAT-001 ∥ 002 ∥ 003 (run 2-at-a-time, handoff.maxParallelAgents=2) |
wave 2 = AICHAT-004 ∥ 005 | wave 3 = AICHAT-006. No two same-wave tasks share a Target File.

Notes:
- TASK-AICHAT-003's executor MUST have web tools (launch general-purpose; per its Discussion).
- Acceptance gates are executable and were dry-run green against the baseline at plan time:
  anchor checker (file exists + range in-bounds) and acceptance-ID uniqueness checker
  (PLAN §5); baseline currently anchors 23 unique IDs, all ranges in-bounds.
- task-budget-validator.mjs is not installed in this repo — the planner performed a manual
  field-completeness audit instead (documented in PLAN.md Self-Audit); do not try to run it.
