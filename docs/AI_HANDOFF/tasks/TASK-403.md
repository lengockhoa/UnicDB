# TASK-403 — Version 1.3.2 + README + full-suite boundary

Cycle 2026-08-22-C · P1 · Size S · Deps: TASK-401, TASK-402 · Wave 2

## Goal

Bump 1.3.1 → **1.3.2** (bug fix theme + UX filter improvement), cập nhật README Results grid bullet, chạy full suite làm regression net cho cả cycle.

## Action

1. `package.json`: `"version": "1.3.2"`.
2. `README.md` — bullet "Results grid (AG Grid Community)" (line ~79) cập nhật thành (giữ nguyên các phần khác, bổ sung 2 ý):
   - theme theo VS Code (dark/light tự động)
   - filter per-column kiểu Excel (Text/Number Filters: Contains, Equals, Starts With… + AND/OR ≤2 điều kiện), kèm quick search
   VÍ DỤ (executor có thể diễn đạt lại, giữ đủ 2 ý trên + sort/copy/footer cũ):
   > - **Results grid (AG Grid Community)**: xem kết quả trong panel **VSDB Results** — theme tự theo VS Code (dark/light); sort; **filter per-column kiểu Excel** (Text/Number Filters: Contains / Equals / Starts With…, kết hợp AND/OR) + quick search; multi-row selection + copy (Ctrl+C); row count ở footer.
3. KHÔNG build vsix trong task (orchestrator build ở release gate).
4. Full suite `npx vitest run` — wave-2 boundary regression net (RULES.md §Test selection: chạy toàn bộ ở wave/cycle boundary).

## Target Files

- `package.json` — version (Task này OWN duy nhất)
- `README.md` — Results grid bullet (Task này OWN duy nhất)

## Interfaces

- Consumes: (none)
- Produces: (none)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | version đúng | `require('./package.json').version === '1.3.2'` | sau edit |
| 2 | happy | README bullet cập nhật | README chứa cả "Excel" (hoặc "kiểu Excel") và "theme" trong bullet Results grid | sau edit |
| 3 | edge (boundary — regression net toàn cycle) | Full suite | `npx vitest run` — tất cả files/tests pass (≥19 files, ≥225 tests: 222 cũ + ≥3 mới từ 401/402) | TASK-401, TASK-402 merged |

Test 1-2 là assert qua Verification Commands (contract kiểu TASK-304 — version/docs task không behavior test; RED_OUTPUT N/A justified).

## Test Files

- (none — assert qua Verification Commands; pattern TASK-304 cycle B)

## Verification Commands

```bash
node -e "const p=require('./package.json'); if(p.version!=='1.3.2') process.exit(1); console.log('version OK')"
grep -c "Excel" README.md
npm run compile
npx vitest run
npm run typecheck
```

(Không có lint script — N/A.)

## Acceptance Criteria

- [ ] Version 1.3.2
- [ ] README bullet Results grid đủ 2 ý mới (theme + Excel-style filter), KHÔNG xóa bullet feature cũ nào (bài học TASK-304 cycle B)
- [ ] Full suite pass fresh

## Dependencies

- TASK-401 (merge trước để full suite gồm webviewTheme.test.ts)
- TASK-402 (merge trước để full suite gồm webviewFilters.test.ts)

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
---

## Executor Report

- EXECUTOR_TOOL: claude-code (omp session)
- EXECUTOR_MODEL: unic/unic-smart (orchestrator trực tiếp — task S assertion-only theo spec; TDD RED_OUTPUT N/A justified trong §Test Cases)
- EXECUTOR_SUBAGENT: none
- RED_OUTPUT: N/A — version/docs task (pattern TASK-304 cycle B; assert qua Verification Commands)
- VERIFICATION (fresh):
  - `node -e ... version` → 1.3.2 ✓
  - `grep -c "Excel" README.md` → 1 ✓
  - `npm run compile` → build complete ✓
  - `npx vitest run` → 21 files / 231 tests passed ✓ (222 cũ + 3 theme + 6 filters)
  - `npm run typecheck` → exit 0 ✓
- Status: PASS
- Note: bullet Results grid cũ bị trùng trong quá trình sửa — đã remove bản cũ, giữ 1 bullet mới đầy đủ (theme + Excel filter + sort/copy/footer cũ). Đã kiểm cả block không mất bullet nào khác.
