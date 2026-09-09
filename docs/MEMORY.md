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
- [2026-09-09] Decision: Reuse `UnicDB.openConsoleForObject` for Schema Explorer connection/schema/category/table/view shortcuts. Reason: preserves the singleton Console, existing table/view SELECT seeding, active-schema pinning, and shared execution path without another command surface.

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
  `--skip-package`, `--skip-publish`. **Marketplace PAT lives at
  `.secrets/.pat`** (gitignored — file content is the raw Azure DevOps PAT
  string, no newline). macOS Keychain entry `vscode-vsce` also exists from
  the original `vsce login lengockhoa` BUT `security find-generic-password`
  hangs in non-interactive shells (GUI unlock prompt), so the on-disk cache
  is the only AI-runnable path. Flow: `VSCE_PAT="$(cat .secrets/.pat)" vsce
  publish --packagePath ./UnicDB-<ver>.vsix`. `gh release create` requires
  `gh` CLI auth.
  **GitHub Releases and VS Code Marketplace are kept in lockstep by this script** — every
  bump ships to both channels at the same version, no manual `git tag` / `gh release
  create` / `vsce publish` separated run.
- **AI engine source of truth:** `src/extension.ts` reads persisted `AiSettings.engine` from `AiConfigStore` before consulting the legacy `UnicDB.ai.engine` configuration fallback. Selecting `omp` in AI Settings therefore controls AI Chat; unavailable OMP explicitly falls back to builtin.

## Known Bugs & Root Causes

- [2026-08-25] Bug: user still saw `Error: column "ctid" does not exist` after cycle S was
  merged. Root cause: cycle S ended without a version bump/GitHub release, and the user's
  one-line installer pulls from latest Release — still v1.6.2 (pre-fix build).
  Fix applied: released v1.6.3 (bump + lockfile sync + tag + VSIX asset + install).
  Watch for: every handoff/pipeline cycle that changes user-visible behavior MUST end with a
  release (or an explicit queued next-cycle release task); releaseHygiene.test.ts now fails
  the build when package-lock version drifts — run `npm install --package-lock-only` after bumping.

- [2026-09-08] **CRITICAL SECURITY: PAT leak in `UnicDB-1.53.32.vsix`.** The `.secrets/`
  directory (Marketplace publish PAT cache) was packaged into v1.53.32 because `vsce
  package` reads `.vscodeignore` (NOT `.gitignore`). The Azure DevOps PAT inside
  `.secrets/.pat` was therefore embedded in the public .vsix on both GitHub Releases
  and VS Code Marketplace. **User rotated the PAT** in Azure DevOps (mandatory
  before any further `vsce publish`). Fix: added `.secrets/**` to `.vscodeignore`
  + new regression guard `vsixSecretsExclusion.test.ts` that runs a real
  `vsce package` round-trip on a tmp stage with a planted `.secrets/.pat` and
  asserts the produced archive contains no `.secrets/` entry. v1.53.33 ships the
  fix; v1.53.32 is superseded. Watch for: any future local credential cache
  (API keys, OAuth refresh tokens, SSH keys, `.env`) MUST be added to
  `.vscodeignore` at the SAME commit that creates the cache, not later.

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
- Last worked on: 2026-09-09 — added Schema Explorer SQL Console shortcuts for connection, schema, category, table, and view nodes. Released as v1.53.41 on GitHub Releases and the VS Code Marketplace; release closeout documentation was pushed through `a005e53`.
- Verification: focused console/menu tests 8/8, console/guide bundle tests 40/40, `npm run typecheck`, and `npm run compile` passed. Full `npm test` still has unrelated AI settings jsdom failures; release artifact `UnicDB-1.53.41.vsix` was packaged.
- Next step: none unless a new user-visible change is requested. For a new user-visible change, run the normal verification gate and atomic `npm run bump` release workflow.

## Completed Milestones

<!-- Significant shipped work. For historical context. One line per milestone. -->
<!-- Format: [YYYY-MM-DD] Milestone: X. Verified by: Y. -->
- [2026-08-27] v1.7.0 SQL Console — cycle Z full pipeline, suite 1693/0. Verified by: 3 bao-opus reviews + aggregate vitest + vsix artifact assertions.
- [2026-08-27] v1.6.8 results/query hardening — cycle Y, keyset paging + manual-commit UI + atomic MySQL batches. Verified by: 8 bao-opus reviews, suite 1658/0.
- [2026-08-25] v1.6.3 lazy-ctid fix — first cycle to close the "merged ≠ shipped" gap via releaseHygiene gate. Verified by: one-liner install.

## Completed Milestones

<!-- Significant shipped work. For historical context. One line per milestone. -->
<!-- Format: [YYYY-MM-DD] Milestone: X. Verified by: Y. -->
