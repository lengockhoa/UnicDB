# Worklog

Track session-level execution details.

## Budget Rules

Keep this file compact to save AI context tokens:

- **Max 30 entries.** When over, archive the oldest entries to `docs/WORKLOG_ARCHIVE.md`.
- **Max ~600 lines.** If over, archive oldest entries until under budget.
- Each entry should be 10-20 lines max (summary, not transcript).
- On archive: move full entry block to `docs/WORKLOG_ARCHIVE.md` (create if missing).
- Keep a compaction marker as the last line: `<!-- Entries before YYYY-MM archived to docs/WORKLOG_ARCHIVE.md. Keep this file < 600 lines. -->`
- If the user says "compact worklog" or "clean worklog", perform the archive pass and report what moved.

For each significant action, append:
- Date/time
- Action taken
- Files changed
- Verification run
- Outcome

---

## 2026-08-23 — Cycle 2026-08-23-H: hardening + release v1.5.1

- Action: carry-over minors từ reviews cycle G → 4 task handoff (701 EXPLAIN guard, 702 codepoint cap, 703 lock hygiene, 704 release).
- Files: `src/core/dangerousStatement.ts` (skip-past-`explain` prelude, `sawExplain` flag), `src/core/text.ts` (new `truncateAtBoundary`), `src/extension.ts` (capDetail dùng helper — 2 dòng), `package-lock.json` (root 1.3.0→1.5.1), `src/__tests__/releaseHygiene.test.ts` (new), package.json 1.5.1.
- Waves: W1 = 701∥702∥703 (disjoint files, executors unic-code trong worktrees) → 9ac114e; W2 = 704 → 9e3f7b1; reviews 0bf6bc8; close 0438762.
- Review: 4/4 approved (701/702/704 approved_minor). 702 cần 1 vòng auto-fix — blocker chỉ là thiếu RED_OUTPUT paste; Fix702 temp-revert helper → capture real lone-surrogate failure → restore byte-identical.
- Verification: full suite 40 files / 453 tests PASS; `tsc --noEmit` 0; `scripts/build.sh` → dist/vsdb-1.5.1.vsix 1576198 bytes.
- Release: push main (356973d..0438762), tag v1.5.1, gh release + asset verified (`gh release view`).
- Lesson lặp lại: copy-back bằng `git diff --name-only` + `ls-files` bỏ sót file gitignored (`.cache/release-notes-v1.5.1.md` ở cycle G) → cycle H copy tay notes ngay đầu và báo path trong report — không mất lần nữa.
