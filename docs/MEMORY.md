# Project Memory

## Protocol

- **This is the most critical doc in the project.** Future AI sessions read this first to understand the system.
- **Source code is ground truth.** If this file contradicts source → source wins, update this file immediately.
- **After every non-trivial task**, ask: "What did I learn about this system?" → write it here if durable.
- Keep entries concise and actionable — future sessions must be able to act on this in seconds.
- Do NOT record temporary session notes here. Only durable knowledge.

## AI Filling Guide

<!-- When to write each section: -->
<!-- Architecture Decisions → any time a "why" is settled (tech choice, pattern, approach) -->
<!-- Active Constraints → any non-obvious rule AI must follow (security, layer boundaries, invariants) -->
<!-- Known Bugs → any bug investigated: root cause + pattern to watch, even if not yet fixed -->
<!-- Open Risks → deferred decisions, fragile areas, unresolved questions -->
<!-- Session Handoff → always update "Last worked on" before ending a session -->

## Architecture Decisions

<!-- WHY choices were made. Prevents future sessions from re-debating settled questions. -->
<!-- Format: [YYYY-MM-DD] Decision: X. Reason: Y. Do NOT change because: Z. -->

## Active Constraints

<!-- Rules AI must respect during implementation. Non-obvious limits not visible in the code. -->
- **Ship constraint — user installs ONLY via the one-liner**:
  `curl -fsSL https://raw.githubusercontent.com/lengockhoa/UnicDB/main/scripts/install-UnicDB.sh | bash`
  User machines are non-dev machines (no repo, no Node, no build). The script pulls the `.vsix`
  from the **latest GitHub Release**. Therefore: a fix is NOT shipped until a GitHub release
  exists (version bump + tag + `UnicDB-<version>.vsix` asset). "Merged to main" ≠ shipped.
  After installing, the user must reload the VS Code window.

- **Versioning policy — every code change ships as a new version** (2026-09-06):
  No user-visible code change lands unversioned. After the verification gate (`npm run
  typecheck` + `npm test`) passes, the next required step is the atomic bump recipe:
  ```bash
  npm run bump -- --changelog-summary "what this ships" --changelog-files "file1, file2"
  # ONE command does it all: bump → lock-sync → CHANGELOG → test → compile → .vsix
  #   → commit → tag → push → GitHub release (+.vsix) → VS Code Marketplace publish
  ```
  Default level is **patch**. Use `npm run bump:minor` for new features, `npm run bump:major`
  for breaking changes — never silently. Trivial internal-only edits (typo, comment) skip
  the bump unless the day also tags/releases. Full recipe + flags: `docs/RELEASE.md`.
  Atomic script: `scripts/bump-version.mjs`. Refuses to publish if the CHANGELOG Summary
  placeholder is still unfilled (must pass `--changelog-summary` or edit the file first).
  Refuses to bump only if `package.json` / `package-lock.json` / `CHANGELOG.md` are
  already dirty (would clobber). Skip flags for emergencies: `--skip-test`,
  `--skip-package`, `--skip-publish`. PAT for `vsce publish` is in macOS Keychain from
  the first `vsce login lengockhoa`; `gh release create` requires `gh` CLI auth.
  **GitHub Releases and VS Code Marketplace are kept in lockstep by this script** — every
  bump ships to both channels at the same version, no manual `git tag` / `gh release
  create` / `vsce publish` separated run.

## Known Bugs & Root Causes

- [2026-08-25] Bug: user still saw `Error: column "ctid" does not exist` after cycle S was
  merged. Root cause: cycle S ended without a version bump/GitHub release, and the user's
  one-line installer pulls from latest Release — still v1.6.2 (pre-fix build).
  Fix applied: released v1.6.3 (bump + lockfile sync + tag + VSIX asset + install).
  Watch for: every handoff/pipeline cycle that changes user-visible behavior MUST end with a
  release (or an explicit queued next-cycle release task); releaseHygiene.test.ts now fails
  the build when package-lock version drifts — run `npm install --package-lock-only` after bumping.

## Open Risks

<!-- Unresolved questions, known fragile areas, or deferred decisions. -->
<!-- Clear this entry once the risk is resolved. -->
- [2026-08-27] RESOLVED `pg-metadata-vs-transaction-window`: was ~11 metadata call sites on a
  `Pool({ max: 1 })` queueing behind a pinned manual-commit/cursor client and failing after
  connectionTimeoutMillis. Fixed by raising Postgres pool to `max: 4` (`PG_POOL_MAX`,
  postgres.ts connect()) — runQuery still holds ONE client per multi-statement script and
  beginTransaction() pins its own, so metadata lands on independent sessions. Regression test:
  adapterQueryShape.test.ts "metadata runs on its own slot…". Not yet released to the user's
  installer (needs a GitHub release per Ship Constraint).

## Session Handoff
- Last worked on: 2026-08-27 — fixed open risk `pg-metadata-vs-transaction-window` (pool
  max 1→4 + regression test); risk entry cleared. ⚠️ Watch: a parallel process (omp hooks?)
  is translating docs/ Vietnamese→English concurrently in this workspace.
- Next step: release a GitHub version bump for the pool fix when convenient (Ship Constraint).

## Completed Milestones

<!-- Significant shipped work. For historical context. One line per milestone. -->
<!-- Format: [YYYY-MM-DD] Milestone: X. Verified by: Y. -->
- [2026-08-27] v1.7.0 SQL Console — cycle Z full pipeline, suite 1693/0. Verified by: 3 bao-opus reviews + aggregate vitest + vsix artifact assertions.
- [2026-08-27] v1.6.8 results/query hardening — cycle Y, keyset paging + manual-commit UI + atomic MySQL batches. Verified by: 8 bao-opus reviews, suite 1658/0.
- [2026-08-25] v1.6.3 lazy-ctid fix — first cycle to close the "merged ≠ shipped" gap via releaseHygiene gate. Verified by: one-liner install.

## Completed Milestones

<!-- Significant shipped work. For historical context. One line per milestone. -->
<!-- Format: [YYYY-MM-DD] Milestone: X. Verified by: Y. -->
