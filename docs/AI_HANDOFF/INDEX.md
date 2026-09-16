# Handoff INDEX

## Cycle CHATFIX — V2 chat layout, scroll, activity timeline and message actions

Bugfix/polish cycle on the completed CHATV2 base: shell grid placement, scroll driving, tool
timeline + live indicator, and message action wiring. Plan: `docs/AI_HANDOFF/PLAN.md`.
(Previous cycle CHATV2 — 17 tasks TASK-CHATV2-001..017 — is complete; its rows were dropped from
this live queue and the cycle is summarized in `RUN.md` + `REVIEW-CHATV2-R1.md`.)

| Task | Title | Status | Dependencies | Wave |
|---|---|---|---|---:|
| TASK-CHATFIX-001 | Explicit shell grid placement (composer size/pinning/crush + scroll region) | ready | none | 1 |
| TASK-CHATFIX-002 | Drive the scroll controller (auto-scroll to newest + unread pill) | ready | 001 | 2 |
| TASK-CHATFIX-003 | Tool activity timeline (Claude Code-style) + live-turn indicator | pending_review | 001 | 2 |
| TASK-CHATFIX-004 | Wire the dead message action icons (copy/edit/retry/3-dot) | pending_review | 002 | 3 |

Execution: lowest ready ID first; tasks in a wave may run in parallel only when they do not edit
the same file (wave 2 = 002+003, disjoint file sets). Each task is TDD RED→GREEN, focused tests +
`npm run typecheck` + `npm run compile`. Every wave boundary runs full `npm test`. Reviewer must
use a different model from executor. No version bump, package or publish.
