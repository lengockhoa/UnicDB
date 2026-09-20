# Handoff INDEX

## Cycle COMMITGUARD — commit-message guard + retry cho Generate Commit Message

Feature/bugfix cycle: Generate Commit Message (SCM sparkle) phải chặn chuỗi rác
(hash/reasoning leak — bug với "chatgpt luna"), retry đúng 1 lần với corrective prompt,
rồi mới toast lỗi; message bắt buộc tiếng Việt (type prefix English), subject ≤ 12 từ,
tổng ≤ 100 từ. Plan: `docs/AI_HANDOFF/PLAN.md`. Spec: `docs/AI_HANDOFF/SPEC.md`.
(Previous cycles STOPERR — 3/3 done và CHATFIX — complete; xem `RUN.md`/`HISTORY.md`.)

| Task | Title | Status | Dependencies | Wave |
|---|---|---|---|---:|
| TASK-CG2-001 | Pure guard module `commitMessageGuard.ts` (8 reason codes, frozen thresholds) | ready | none | 1 |
| TASK-CG2-002 | SYSTEM_PROMPT tiếng Việt + `buildRetryCommitPrompt` trong `commitMessage.ts` | ready | none | 1 |
| TASK-CG2-003 | Wire guard + retry-1-lần vào `runGenerateCommitMessage` (3 branch) + docs | ready | 001, 002 | 2 |

Execution: wave 1 — CG2-001 + CG2-002 chạy song song (disjoint file sets: guard module
mới vs commitMessage.ts). Wave 2 — CG2-003 import cả hai interface, sở hữu
`commitGenCommand.ts` + test + user guide. Mỗi task TDD RED→GREEN: focused tests +
`npm run typecheck` + `npm run compile`; full `npm test` ở wave boundary. Reviewer model
PHẢI khác executor model. Task-budget validator: `VERDICT: ok` cho cả 3. No version bump,
package or publish (publish constraint ghi đè standing rule — orchestrator flag riêng).
