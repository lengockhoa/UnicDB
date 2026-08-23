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

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec704
SUMMARY: Boundary task — bump 1.5.0 → 1.5.1 (package.json + lock sync), added release notes .cache/release-notes-v1.5.1.md, built vsix 1576198 bytes. TASK-703's dynamic-version test covers case 1 (lock root == 1.5.1); full suite covers case 2.
TEST_PLAN_FOLLOWED: task §Test Cases (1 regression + 1 unit) — case 1 covered by TASK-703's releaseHygiene.test.ts reading dynamic version (asserts pkg.version === 1.5.1 and lockfile root === 1.5.1); case 2 covered by full 453/453 pass.
FILES_CHANGED:
  - package.json: version 1.5.0 → 1.5.1 (1 line).
  - package-lock.json: lockfileVersion root "1.5.0" → "1.5.1" via `npm install --package-lock-only` (2 fields).
  - .cache/release-notes-v1.5.1.md: NEW — 3 cycle-H fixes (701 EXPLAIN ANALYZE guard, 702 emoji codepoint, 703 lock sync) + dynamic-version test note + GUI + CLI install guide + troubleshooting. Gitignored.
  - README.md: untouched (grep `1.5.[01]` → 0 hardcoded-current hits, no version field).
TESTS_ADDED:
  - (none — TASK-703's releaseHygiene.test.ts added in sibling task already reads dynamic version; per boundary-task pattern, this task reuses it.)
VERIFICATION:
  command: npm install --package-lock-only && npm run compile && npx vitest run && npm run typecheck && bash scripts/build.sh && ls -la dist/vsdb-1.5.1.vsix
  result: 4 commands pass / 0 fail; vsix built 1576198 bytes
  output_excerpt: |
    npm install --package-lock-only → idempotent, lock root version 1.5.1, zero diff vs prior commit
    npm run compile → esbuild OK
    npx vitest run → 40 files / 453 tests PASS
    npm run typecheck → exit 0
    bash scripts/build.sh → dist/vsdb-1.5.1.vsix 1576198 bytes; inner extension/package.json version 1.5.1
RED_OUTPUT: N/A — boundary task (version bump + release pipeline); gate instead: full suite 453/453 + typecheck 0 + build vsix 1576198 bytes.
ISSUES:
  - Task §Acceptance criterion 4 (git push main + tag v1.5.1 + gh release create with asset + gh release view verify) intentionally NOT executed by executor — orchestrator owns post-review release steps. Local ahead 3 commits (7959bee, 9ac114e, 9e3f7b1); no tag v1.5.1 local/remote at report time.
HANDOFF_TO_REVIEWER: yes
NEXT: orchestrator executes push/tag/gh-release post-approval; then reviewer re-runs.

## Reviewer Verdict

(chưa có)

---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart (Rev704; matches handoff.reviewer.model)
EXECUTOR_MODEL: unic-code (Exec704, from structured report '/Users/lenk/.omp/agent/sessions/--Volumes-KHOA_EXTENAL-DOCKER_CREATE-VSDB--/2026-08-22T02-02-54-030Z_01a02734-e8ce-7000-bc8a-2cfdcff7722b/Exec704.md'; task-file Executor Report section still "(chưa có)" — recovered from agent artifact, not task file)
VERIFICATION_RERUN (all fresh, main tree @9e3f7b1):
  npm install --package-lock-only → idempotent, lock 1.5.1/1.5.1, zero diff
  npm run compile → esbuild OK
  npx vitest run → 40 files / 453 tests PASS
  npm run typecheck → exit 0
  bash scripts/build.sh → dist/vsdb-1.5.1.vsix 1576198 bytes; inner extension/package.json version = 1.5.1
TEST_PLAN_COVERAGE: all-followed — case 1 (lock root = 1.5.1) covered by TASK-703 dynamic test in the 453; case 2 (full suite ≥443) exceeded: 453/453.
FINDINGS:
  critical: none
  important: none
  minor:
    - docs/AI_HANDOFF/tasks/TASK-704.md:52 — Executor Report section still "(chưa có)": executor submitted via structured artifact ('/Users/lenk/.omp/agent/sessions/--Volumes-KHOA_EXTENAL-DOCKER_CREATE-VSDB--/2026-08-22T02-02-54-030Z_01a02734-e8ce-7000-bc8a-2cfdcff7722b/Exec704.md') instead of appending to the task file; EXECUTOR_MODEL/FILES/VERIFICATION recovered from artifact. Fix: paste that report into the section before closing the cycle.
    - docs/AI_HANDOFF/tasks/TASK-704.md:Acceptance — 4th criterion (git push main + tag v1.5.1 + gh release create + gh release view asset) intentionally NOT done: local ahead 3 commits (7959bee,9ac114e,9e3f7b1), no tag v1.5.1 local or remote, gh release view → "release not found". Orchestrator owns this step post-review; do not mark this criterion checked until executed.
SCOPE_CHECK: commit 9e3f7b1 = package.json 1 line + package-lock.json 2 lines (both version fields), nothing else; README untouched (grep "1.5.[01]" → 0 hardcoded-current hits); notes .cache/release-notes-v1.5.1.md exists, gitignored (.gitignore:7), covers all 3 cycle-H fixes (701 EXPLAIN ANALYZE guard, 702 emoji codepoint, 703 lock sync) + dynamic-version test + install guide (GUI + CLI) + troubleshooting.
RED_PLAUSIBILITY: N/A — assertion-only release task (no new tests; TASK-703 tests are the contract, pattern per TASK-304/403 precedents).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Substance fully verified independently; only process gap is the unwritten Executor Report section + pending git release steps owned by orchestrator.
