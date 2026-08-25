# TASK-XXX — <short title>

<!--
Template cho mỗi task. Planner copy file này khi split PLAN.md sang task riêng.
File này BẮT BUỘC giữ structure: Goal + Test Cases + Test Files + Verification + Acceptance + Interfaces.
Mọi AI (planner / executor / reviewer) đọc và ghi vào file NÀY. Không trao đổi ngoài file.
-->

- Status: `ready`  <!-- ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | blocked | done -->
- Owner: `-`       <!-- tool đang giữ task -->
- Reviewer: `-`    <!-- model name reviewer dùng, set ở Phase 4 -->
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §<section>

## Goal

<!-- 1-2 câu mô tả slice này làm gì. -->

## Target Files

- `<path/to/source.js>` — <what changes>

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `<describe behavior>` | `<concrete expected>` | `<input>` |
| 2 | edge | `<null/empty/boundary>` | `<expected>` | `<input>` |
| 3 | regression (nếu bug fix) | `<reproduces bug>` | RED before fix, GREEN after | `<repro input>` |

## Test Files

- `<tests/path/to/file.test.js>` — chứa các test ở trên.

## Verification Commands

```bash
npm test tests/path/to/file.test.js
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS.
- [ ] Không regression ở suite liên quan.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.
- [ ] Docs/CHANGELOG cập nhật nếu user-facing.

## Dependencies

- (none) <!-- hoặc TASK-xxx phải done trước -->

## Interfaces

<!--
Executor thường CHỈ thấy task file này, không thấy task khác. Block này là cách nó biết đúng
tên/kiểu mà task khác kỳ vọng — tránh lỗi kiểu "TASK-3 gọi clearLayers() nhưng TASK-7 lại gọi
clearFullLayers()". Ghi chữ ký thật (function/endpoint/type), không ghi placeholder.
-->

- Consumes: `<what this task uses from earlier tasks — exact function/endpoint signatures, types>` <!-- hoặc (none) -->
- Produces: `<what later tasks rely on from this task — exact function/endpoint signatures, types>` <!-- hoặc (none) -->

---

## Discussion

<!--
AI nói chuyện với nhau Ở ĐÂY, không nói qua tool khác.
Format mỗi comment:

### <date> · <role: planner|executor|reviewer> · <tool/model>
<nội dung — câu hỏi, lưu ý, đề xuất, đẩy ngược về phase trước>

Reply lùn 1 level (####). Ghi rõ "→ @planner" / "→ @executor" / "→ @reviewer" nếu có người nhận cụ thể.
-->

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
