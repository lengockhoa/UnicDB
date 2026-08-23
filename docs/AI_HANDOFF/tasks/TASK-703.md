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

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec703
SUMMARY: Synced package-lock.json root version 1.3.0 → 1.5.0 (npm install --package-lock-only, no node_modules touched); added src/__tests__/releaseHygiene.test.ts with 3 dynamic tests (lock root vs pkg version, README vsdb-<version>.vsix pattern, semver shape).
TEST_PLAN_FOLLOWED: task §"Test Cases" (3 cases implemented as-is)
FILES_CHANGED:
  - package-lock.json: root version 1.3.0 → 1.5.0 (top-level + packages[""]).
  - src/__tests__/releaseHygiene.test.ts: NEW. 3 tests reading files on disk — no hardcoded version.
  - docs/AI_HANDOFF/tasks/TASK-703.md: appended this Executor Report.
TESTS_ADDED:
  - src/__tests__/releaseHygiene.test.ts: "lock root version khớp package.json version (đọc động)" / "README giữ pattern install vsdb-<version>.vsix" / "package.json version match semver X.Y.Z (3 thành phần số)"
RED_OUTPUT (lock=1.3.0, pkg=1.5.0):
  × lock root version khớp package.json version (đọc động)
    → package-lock.json root version phải khớp package.json: expected '1.3.0' to be '1.5.0' // Object.is equality
  ✓ README giữ pattern install vsdb-<version>.vsix
  ✓ package.json version match semver X.Y.Z (3 thành phần số)
VERIFICATION:
  - npm install --package-lock-only: lock root = 1.5.0 (idempotent, no real install).
  - npm run compile: extension.js + webview.js bundled, no errors.
  - npx vitest run src/__tests__/releaseHygiene.test.ts: 3/3 PASS.
  - npm run typecheck: clean (tsc --noEmit, exit 0).
  - npx vitest run (full unit suite): 39 files / 442 tests PASS.
ISSUES: none
HANDOFF_TO_REVIEWER: yes — fresh RED+GREEN in this turn, types clean, full suite green.
NEXT: ready for review.

## Reviewer Verdict

(chưa có)
