# PLAN — Cycle 2026-08-23-H

## §1 Intent

Cycle G đóng, v1.5.0 released. "tiếp" → chạy phần không cần input user: dọn carry-over minors từ reviews G (rev606 + rev604). User trước đó đã mô tả đủ bối cảnh; không câu hỏi mở.

## §2 Scope (3 task, 1 wave)

Carry-over hardening — KHÔNG feature mới:

1. **TASK-701** — `EXPLAIN [ANALYZE] DELETE/TRUNCATE/DROP/UPDATE...` hiện classify `other/none` → guard modal bị skip, dù ANALYZE thực thi lệnh thật. Fix: skip-past-EXPLAIN prelude trong `analyzeStatement`.
2. **TASK-702** — `capDetail` slice theo UTF-16 code unit → có thể cắt giữa surrogate pair/variation selector (detail modal hiện ký tự hỏng). Fix: slice theo code point.
3. **TASK-703** — release hygiene: package-lock.json root version stale (1.3.0 vs package.json 1.5.0); thêm test pin version nhất quán (package.json ↔ package-lock root ↔ README nhắc version mới nhất).

## §3 Approach

- **701**: trong `analyzeStatement` (src/core/dangerousStatement.ts), sau mask literals, detect statement bắt đầu bằng `explain` (word depth-0 đầu tiên, case-insensitive) → optional `analyze`/`analyse`/`verbose`/`analyze verbose`/costs... → skip tới keyword statement thật. Cẩn thận: `EXPLAIN (ANALYZE, COSTS) DELETE FROM t;` — parenthesized option list nằm trong parens (đã được depth>0 skip sẵn), nên chỉ cần skip `explain` + optional modifiers words ở depth 0, rồi để STATEMENT_STARTERS logic chạy tiếp. But existing logic: first depth-0 keyword quyết định kind — `explain` không có trong DML_KINDS → `other` và `break` ngay. Fix = không break khi gặp `explain` (+ theo sau `analyze|analyse|verbose`), tiếp tục scan tới keyword thật. CTE `WITH` sau EXPLAIN cũng phải hoạt động (`EXPLAIN ANALYZE WITH c AS (...) DELETE FROM t`) → treat như prelude tương tự `with`: đặt kind theo STATEMENT_STARTERS đầu tiên gặp sau prelude. Đơn giản nhất: khi gặp `explain` ở depth 0 (và chưa từng gặp keyword nào khác), set flag `sawExplain = true` + continue; nếu sau đó gặp `analyze|analyse|verbose|costs|buffers|timing|summary|format` ở depth 0 → continue luôn (options trong parens đã bị skip bởi depth check; những từ này đứng ngoài parens ở dạng `EXPLAIN ANALYZE DELETE`). Khi STATEMENT_STARTERS gặp → kind quyết định. hasWhere đã regex trên full masked text — không đổi.
- **702**: `capDetail` — thay `joined.slice(0, cap)` bằng slice-at-codepoint-boundary: nếu `charCodeAt(cap)` là high surrogate (0xD800-0xDBFF) → cắt tại cap-1. (Variation selector U+FE0F là BMP code unit riêng — không thể đứt bởi regex surrogate check; mối lo chính là surrogate pair emoji. Đủ cho fix.)
- **703**: `npm install --package-lock-only` để sync lock root version → 1.5.0. Test mới `src/__tests__/releaseHygiene.test.ts`: đọc package.json + package-lock.json + README.md, assert: lock root version === package.json version; README chứa string version hiện tại (badge/hướng dẫn "vsdb-<version>.vsix" pattern — README dùng placeholder `<version>` nên assert khác: README có nhắc đúng version mới nhất trong phần cập nhật nếu có; nếu chỉ placeholder → assert placeholder tồn tại + ghi chú). Cẩn thận không làm test fail khi version bump — test phải đọc version từ package.json động, không hardcode.

## §4 Test Plan (TDD)

- **701** (src/core/__tests__/dangerousStatement.test.ts — append):
  - `EXPLAIN DELETE FROM t` → kind=delete, tier red (no WHERE)
  - `EXPLAIN ANALYZE DELETE FROM t` → red
  - `EXPLAIN (ANALYZE, COSTS) UPDATE t SET a=1` (no WHERE) → red
  - `EXPLAIN ANALYZE SELECT * FROM t` → none (select không danger)
  - `EXPLAIN ANALYZE WITH c AS (SELECT 1) DELETE FROM t WHERE x=1` → kind=delete, hasWhere=true → amber
  - `EXPLAIN ANALYZE UPDATE t SET a=1 WHERE id=2` → none (update có where)
  - Regression: `EXPLAIN SELECT 1` vẫn other/none; DELETE thường không EXPLAIN vẫn red.
- **702** (mỗi task cần test file riêng vì capDetail là private trong extension.ts — KHÔNG export production chỉ vì test. Đặt logic vào src/core/text.ts (new): `export function truncateAtBoundary(s: string, cap: number): string`; extension.ts import + dùng. Test src/core/__tests__/text.test.ts: ASCII không đổi; chuỗi có emoji tại biên cap → không cắt giữa surrogate pair (kết quả kết thúc bằng ký tự hợp lệ, Array.from(s).length ≤ mong đợi); chuỗi ngắn hơn cap nguyên vẹn.
- **703** (src/__tests__/releaseHygiene.test.ts — new): lock root === pkg version; README mention pattern tồn tại (placeholder `vsdb-<version>.vsix` hoặc version string động).
- RED trước, GREEN sau — mỗi executor phải paste output RED thật.

## §5 Verification Commands

- Targeted: `npm run compile && npx vitest run src/core/__tests__/dangerousStatement.test.ts src/core/__tests__/text.test.ts src/__tests__/releaseHygiene.test.ts`
- Typecheck: `npm run typecheck`
- Wave boundary: `npm run compile && npx vitest run` (full 38+ files)

## §6 Acceptance Criteria

- [ ] EXPLAIN ANALYZE DELETE (no WHERE) giờ trigger red modal; SELECT/INSERT sau EXPLAIN vẫn none
- [ ] capDetail không sinh ký tự hỏng khi text chứa emoji tại biên
- [ ] package-lock root version = 1.5.0; test hygiene xanh
- [ ] Full suite xanh (≥443 tests); typecheck 0
- [ ] Mọi task có RED/GREEN output thật trong Executor Report
- [ ] Reviewer (khác model executor) re-run verification + verdict

## Planner Self-Audit

- Files đụng nhau? 701 (core/dangerousStatement + test), 702 (core/text.ts mới + extension.ts 1 dòng import/1 dòng dùng + test), 703 (package-lock + test mới). Rải nhau — 1 wave an toàn. extension.ts chỉ 702 đụng.
- Test discriminating? 701: current code fail RED thật (explain → other). 702: current capDetail cắt surrogate → RED. 703: lock 1.3.0 ≠ 1.5.0 → RED.
- Risk thấp: không đụng webview/AG Grid; 701 là pure function; 702 extract helper không đổi behavior ASCII.
