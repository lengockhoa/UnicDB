Cycle: COMMITGUARD   Date: 2026-09-20   Base: main
Goal: Lớp kiểm tra + thử lại cho Generate Commit Message chặn chuỗi rác (hash/reasoning leak), buộc message tiếng Việt ngắn gọn ≤100 từ.
Mode: Planning complete; executors pick `ready` tasks from INDEX.md in dependency order.
Spec: docs/AI_HANDOFF/SPEC.md
Plan: docs/AI_HANDOFF/PLAN.md
Queue: 3 ready tasks — docs/AI_HANDOFF/tasks/TASK-CG2-001.md → TASK-CG2-003.md
Status: planning_done — ready for executor
Next: wave 1 — TASK-CG2-001 + TASK-CG2-002 in parallel; then wave 2 — TASK-CG2-003 (deps: 001, 002).
Hard constraints: TypeScript/esbuild/vitest; module pure không import `vscode`; KHÔNG đổi `provider.ts` parser fallbacks, `sanitizeCommitMessage` semantics hay `CommitGenDeps`; frozen strings/thresholds theo SPEC §7/§8; no version bump/package/publish; reviewer model ≠ executor model.
