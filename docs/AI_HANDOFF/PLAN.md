# Handoff Plan

Status: `empty`

<!--
File này CHỈ dùng cho luồng Handoff Quality Gate.
Daily prompt / quick fix → KHÔNG cần đụng vào đây, UKit vẫn chạy flow cũ bình thường.

Chỉ kích hoạt khi user explicit đẩy việc qua handoff (ví dụ: "đưa vào handoff", "gom ý tưởng X").

QUALITY GATE: mỗi task split ra phải kèm Test Plan (xem mục bên dưới).
Không có Test Plan → task không được phép chuyển sang status `ready`.
-->

## 1. Intent / Goal

<!-- 1-2 câu mô tả thứ user muốn đạt. Không paste lại nguyên prompt. -->

## 2. Scope

- In scope:
- Out of scope:
- Risk surface (file/module rủi ro share):

## 3. Approach

<!-- Cách làm ngắn gọn. Reuse code có sẵn trước khi tạo mới. -->

## 4. Test Plan (REQUIRED — TDD-style)

Liệt kê test sẽ viết TRƯỚC khi code. Mỗi test phải có:

| # | Loại | Tên test | File | Expect | Pre-state |
|---|------|----------|------|--------|-----------|
| 1 | unit / integration / regression / e2e | `<tên test mô tả hành vi>` | `<path/to/file.test.js>` | `<output kỳ vọng cụ thể>` | `<input/fixture>` |

Bắt buộc tối thiểu:

- **Happy path**: hành vi chính chạy đúng.
- **Edge case**: ít nhất 1 (null/empty/boundary/concurrent…).
- **Regression** (nếu fix bug): test fail-trước-khi-fix, pass-sau-khi-fix.

Nếu task không thể test (config-only, doc-only, prototype throw-away): ghi `Test plan: N/A — lý do: <…>` và đính kèm phương án verify thủ công.

## 5. Verification Commands

Lệnh chính xác executor sẽ chạy:

```bash
# ví dụ:
# yarn test path/to/file.test.js
# yarn test --run
# node scripts/smoke.mjs
```

## 6. Acceptance Criteria

- [ ] Tất cả test ở Test Plan PASS (kèm output trong report).
- [ ] Không có regression ở suite liên quan.
- [ ] Reviewer (model riêng) báo `APPROVED` hoặc `APPROVED-WITH-MINOR`.
- [ ] Docs/CHANGELOG cập nhật nếu user-facing.

## 7. Task Split (Phase 2 — TDD-embedded, MANDATORY)

Khi human approve plan, AI tạo từng `tasks/TASK-xxx.md` theo cấu trúc ở `tasks/_TEMPLATE.md`.

**Mỗi TASK file BẮT BUỘC có:**
- `## Test Cases` — bảng test (loại, tên, expected, fixture) cho slice của task. Tối thiểu happy + 1 edge + regression nếu fix bug.
- `## Test Files` — đường dẫn cụ thể file test sẽ tạo/sửa.
- `## Verification Commands` — lệnh executor + reviewer đều chạy fresh.
- `## Acceptance Criteria`.

Task không kèm Test Cases + Test Files cụ thể → đánh `needs_breakdown`, không cho status `ready`.

Update `INDEX.md`: thêm row cho mỗi task mới với `Status: ready`, `Owner: -`.
