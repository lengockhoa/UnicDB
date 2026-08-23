# TASK-703 — Release hygiene: lock version + test pin

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.3

## Goal

package-lock.json root version stale (1.3.0) so với package.json (1.5.0) — mỗi lần build/distribution lock không khớp. Sync + thêm test automation để lần sau không quên (carry-over từ Rev604).

## Target Files

- `package-lock.json` — sync root version (via `npm install --package-lock-only`).
- `src/__tests__/releaseHygiene.test.ts` — NEW.

## Interfaces

- `(none)` — chỉ metadata + test. Không đổi runtime.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | lock root khớp pkg | `lock.root.version === pkg.version` (đọc động) | file trên disk |
| 2 | unit | README giữ pattern install | README chứa `vsdb-<version>.vsix` | README.md |
| 3 | edge | version semantic | pkg.version match `/^\d+\.\d+\.\d+$/` | package.json |

## Test Files

- `src/__tests__/releaseHygiene.test.ts`

## Verification Commands

```bash
npm install --package-lock-only
npm run compile && npx vitest run src/__tests__/releaseHygiene.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Test 1 RED với lock 1.3.0, GREEN sau sync
- [ ] Test không hardcode version — bump sau này không phải sửa test 1/3
- [ ] Không đụng node_modules thật (chỉ lock metadata)

## Executor Report

(chưa có)

## Reviewer Verdict

(chưa có)
