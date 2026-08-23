# TASK-704 — Release 1.5.1 boundary (version + notes + git release)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.4

## Goal

Chốt chu kỳ H: bump 1.5.0 → 1.5.1, release notes, build vsix, tag, **push + GitHub release** (yêu cầu user tường minh: "xong là phải release lên git nhé").

## Target Files

- `package.json` — version 1.5.1 (TASK-703 test đọc động, không phải sửa).
- `package-lock.json` — sync (npm install --package-lock-only).
- `README.md` — chỉ nếu có phần ghi version cứng (nếu không, không đụng).
- `.cache/release-notes-v1.5.1.md` — NEW (gitignored; copy vào `.cache/` ngay khi tạo — lesson từ 604).

## Interfaces

- `(none)` — metadata + release pipeline.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | lock root khớp pkg sau bump | `lock.root.version === "1.5.1"` | TASK-703 test tự phủ (đọc động) |
| 2 | unit | full suite xanh tại boundary | 38+ files, ≥443 tests pass | main |

## Test Files

- `src/__tests__/releaseHygiene.test.ts` (từ TASK-703, không sửa)

## Verification Commands

```bash
npm install --package-lock-only
npm run compile && npx vitest run
npm run typecheck
bash scripts/build.sh && ls dist/vsdb-1.5.1.vsix
```

## Acceptance Criteria

- [ ] Version 1.5.1 mọi nơi (package.json, lock)
- [ ] Full suite + typecheck xanh
- [ ] vsix build
- [ ] **git push main + tag v1.5.1 + gh release create với asset vsdb-1.5.1.vsix + notes — verify asset bằng `gh release view`**

## Executor Report

(chưa có)

## Reviewer Verdict

(chưa có)
