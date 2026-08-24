# ACTIVE

Cycle: P — permission detail + builtin tool-call UI + VSIX release pass
Date: 2026-08-24   Base: main (b8560b4)
Goal: Final backlog sweep — surface ACP tool args in permission dialog, stream builtin
tool-call steps live, produce clean marketplace-ready .vsix (no publish).
Tasks: 3 total
Status: planning_done — ready for executor

## Notes
- Final backlog sweep: 3 items, user-approved "làm hết tất cả".
- Wave 1: TASK-001 + TASK-003 (parallel, disjoint files). Wave 2: TASK-002 (owns
  src/ui/aiChatPanel.ts after TASK-001).
- No publishing; 819-test baseline must hold at wave boundaries (full `npm test`).
