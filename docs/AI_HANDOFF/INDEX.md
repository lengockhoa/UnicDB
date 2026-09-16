# Handoff INDEX

## Cycle CHATV2 — complete professional AI Chat UI replacement

Spec/task cycle only: these files direct a future coder; this planning cycle must not modify runtime source. Parent contract: `docs/AI_CHAT_PROFESSIONAL_SPEC.md`; execution plan: `docs/AI_HANDOFF/PLAN.md`.

| Task | Title | Status | Dependencies | Wave |
|---|---|---|---|---:|
| TASK-CHATV2-001 | Baseline, capability audit and cutover map | done | none | 0 |
| TASK-CHATV2-002 | Engine capability model and providers | done | 001 | 1 |
| TASK-CHATV2-003 | Versioned V2 host/webview protocol | done | 002 | 1 |
| TASK-CHATV2-004 | Pure reducer and serializable UI state | done | 003 | 2 |
| TASK-CHATV2-005 | V2 app shell, icon factory and scoped visual tokens | done | 003 | 2 |
| TASK-CHATV2-006 | Stable transcript and safe streaming renderer | done | 004,005 | 3 |
| TASK-CHATV2-007 | Activity timeline and truthful turn status | done | 004,005,006 | 3 |
| TASK-CHATV2-008 | Two-row composer and every control surface | done | 004,005 | 3 |
| TASK-CHATV2-009 | Single keyboard/composer controller | done | 008 | 4 |
| TASK-CHATV2-010 | Universal and capability-gated slash commands | done | 003,009 | 4 |
| TASK-CHATV2-011 | Structured mentions, search races and context chips | done | 003,004,009 | 4 |
| TASK-CHATV2-012 | Engine/model menus and acknowledged switching | done | 002,003,008,009 | 5 |
| TASK-CHATV2-013 | Attachments, attach-context menu and schema controls | done | 002,008,011 | 5 |
| TASK-CHATV2-014 | Permission policy, requests and change-plan safety | done | 002,003,007,008 | 5 |
| TASK-CHATV2-015 | Sessions, structured persistence, export and diagnostics | done | 003,004,006 | 6 |
| TASK-CHATV2-016 | Error recovery, scroll, accessibility and responsive behavior | done | 006–015 | 6 |
| TASK-CHATV2-017 | V1 cutover, legacy deletion and complete quality gate | done | 001–016 | 7 |

Execution: lowest ready ID first; tasks in a wave may run in parallel only when they do not edit the same file. Each task is TDD RED→GREEN, focused tests + typecheck + compile. Every wave boundary runs full `npm test`. Reviewer must use a different model from executor. No version bump, package or publish.
