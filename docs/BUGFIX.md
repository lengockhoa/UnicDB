# Bugfix SOP (Index-First)

## Objective
Giảm thời gian fix bug bằng cách ưu tiên bằng chứng + index codebase trước khi đọc sâu docs/source.

## Required Commands
- `node .claude/ukit/index/build-index.mjs`
- `node .claude/ukit/index/query-index.mjs "<error|symbol|path>"`
- `node .claude/ukit/index/triage.mjs "<error signature>"`

## Decision Tree
1. Có repro command rõ ràng -> chạy triage index.
2. Lane fast: mở tối đa 1-3 suspect files, patch nhỏ, verify test mục tiêu.
3. Fail 2 vòng 15 phút liên tiếp -> chuyển lane deep.
4. Lane deep: instrumentation + root-cause tracing trước khi sửa.

## Hard Rules
- Không sửa khi chưa có evidence (failing test / stack trace / logs).
- Không refactor lớn trong bug ticket.
- Verify tối thiểu: test fail ban đầu + test liên quan.
