# TASK-304 — Version 1.3.1 + README

Cycle 2026-08-22-B · P1 · Size S · Deps: TASK-301, TASK-302, TASK-303

## Goal

Bump version 1.3.1 (feature = số giữa? — row counts + filter là 2 tính năng user-facing mới → theo quy tắc "số giữa cho update lớn" nhưng đây là increment nhỏ của explorer, không đổi architecture. **Chọn 1.3.1**: cycle nhỏ, feature-m bé — nếu user muốn 1.4.0 thì đổi tại release). README thêm feature bullets.

## Action

1. `package.json` version → `1.3.1`.
2. `README.md`: mục Features thêm:
   - Per-table row count badges trong Schema Explorer (estimated từ planner statistics, không scan bảng lớn)
   - Tree filter — lọc schemas/tables/views/routines/columns theo tên từ view title bar
3. KHÔNG build vsix trong task (orchestrator build ở release gate).

## Interfaces

- (none)

## Test Cases

| Loại | Test | Expected |
|------|------|----------|
| happy | package.json version == '1.3.1' | pass |
| happy | README chứa 2 bullet mới | pass |

## Test Files

- (none — assert qua Verification Commands)

## Verification Commands

```bash
node -e "const p=require('./package.json'); if(p.version!=='1.3.1') process.exit(1); console.log('version OK')"
grep -c "row count\|Tree filter" README.md
npm run typecheck
```

## Acceptance Criteria

- [ ] Version 1.3.1
- [ ] README 2 bullets
- [ ] Typecheck pass

## Executor Report

(executor điền)

## Reviewer Verdict

(reviewer điền)

## Executor Report

- EXECUTOR_TOOL: claude-code (omp session)
- EXECUTOR_MODEL: unic/unic-smart (orchestrator trực tiếp — task S, không spawn)
- EXECUTOR_SUBAGENT: none
- RED_OUTPUT: N/A — task chỉ assert version + README content (không behavior test; Verification Commands là contract).
- VERIFICATION (fresh):
  - `node -e "require('./package.json')"` → version 1.3.1 ✓
  - `grep -c "Row count badge\|Tree filter" README.md` → 2 ✓
  - `npm run typecheck` → 0 errors ✓
  - Full suite (wave boundary): 19 files / 221 tests passed ✓
- DEVIATION: thêm 1 edit ngoài task file list — `src/scaffold.test.ts` (view/title order contract): Exec303 chèn 2 menu entry TRƯỚC refresh/add, phá contract cũ "refresh đứng trước add để toolbar không đổi chỗ" (scaffold.test.ts:131). Fix: sort lại package.json view/title theo [refresh, add, filter, clear] + cập nhật assertion thêm 2 entries mới. Đây là regression lòi ra ở wave boundary full-suite run — thuộc scope TASK-303 manifest, orchestrator fix để giữ contract.
