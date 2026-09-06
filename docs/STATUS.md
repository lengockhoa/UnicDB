# STATUS — 2026-09-06 (TASK-AI-001-fix)

## Done
- Fixed: `UnicDB.resultsPlacement` setting now hot-applies (auto-disposes live panel on change)
- 14 files changed: src/ui/resultsPanel.ts, package.json (1.51.6), CHANGELOG.md (1.51.6 entry), 12 test files
- Tests: 3615 passed / 2 skipped (floor preserved)
- `UnicDB-1.51.6.vsix` packaged (2.02 MB) at /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/UnicDB-1.51.6.vsix

## Pending (user side)
- Marketplace publish: NOT done — needs PAT via `vsce login lengockhoa` + `vsce publish patch`
- GitHub release: local `.vsix` ready but not pushed
- User asking whether GitHub release alone puts it on Marketplace — answer: NO, separate

## Next-action options for user
1. Paste PAT → mình publish lên Marketplace
2. Copy `.vsix` local → cài trực tiếp trên máy test (`code --install-extension`)
3. Push tag `v1.51.6` + attach `.vsix` lên GitHub releases (cho người khác download, KHÔNG lên Marketplace)

## Update 2026-09-06 10:04 (verification gate cleared)
- 16 files now modified: src/ui/resultsPanel.ts, package.json (1.51.6), package-lock.json (1.51.6 sync), CHANGELOG.md, 12 test files, docs/STATUS.md
- `npm run typecheck` ✅ silent
- `npm test` ✅ **3615 passed / 2 skipped** (releaseHygiene.test.ts lock-version check initially caught the package.json bump without lock sync; fixed via `npm install --package-lock-only`)
- `UnicDB-1.51.6.vsix` ✅ 2,123,354 bytes
- User ran `vsce login lengockhoa` ✅ (PAT saved to macOS Keychain); `vsce publish patch` then failed on dirty git tree ("Git working directory not clean").
- **To finish publish (clean tree required)**:
  ```bash
  cd /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB
  git add -A
  git commit -m "release: 1.51.6 — AI-001-fix hot-applies UnicDB.resultsPlacement"
  vsce publish patch   # bumps to 1.51.7 (since package.json is already 1.51.6)
  ```
  ⚠️ To ship as **exact 1.51.6**: revert package.json + package-lock.json to 1.51.5 first, commit, then `vsce publish patch`.

## Update 2026-09-06 10:11 (version-bump recipe saved for future cycles)
- **NEW ARTIFACT**: `scripts/bump-version.mjs` + `npm run bump` (also `bump:patch` / `bump:minor` / `bump:major` / `bump -- X.Y.Z`)
- **NEW DOC**: `docs/RELEASE.md` — single source of truth for cutting a release + edit-flow recipe for non-bump function changes
- Script does the full release prep atomically: bump `package.json` → sync `package-lock.json` (`npm install --package-lock-only` is what `releaseHygiene.test.ts` pins) → prepend `CHANGELOG.md` entry → `npm run typecheck` + `npm test` → `npm run compile` → `npx vsce package` → print exact `git commit` + `vsce publish patch` commands
- Dirty-tree guard fixed: refuses ONLY if `package.json` / `package-lock.json` / `CHANGELOG.md` are already dirty (would clobber); other dirty files pass through (operator's problem to commit separately)
- CHANGELOG-insertion regex bug fixed: now matches `^## \[N.N.N\]` heading, not the link-reference footer `[N.N.N]:`
- Future bumps: just run `npm run bump` (or `npm run bump:minor` etc.), then commit + publish
- **Current state**: 19 dirty files, all expected (TASK-AI-001-fix source/test/doc changes + bump script + RELEASE.md + 1.51.6 bump). `npm run typecheck` ✅ silent, `npm test` ✅ 3615 passed / 2 skipped, `UnicDB-1.51.6.vsix` ✅ packaged. Ready to commit + publish to Marketplace.

## Update 2026-09-06 10:14 (Marketplace publish DONE)
- ✅ **`lengockhoa.UnicDB v1.51.6` PUBLISHED** to VS Code Marketplace
- URL: https://marketplace.visualstudio.com/items?itemName=lengockhoa.UnicDB
- Hub: https://marketplace.visualstudio.com/manage/publishers/lengockhoa/extensions/UnicDB/hub
- Used `npx vsce publish` (no level) so it shipped at the exact version already in `package.json` (1.51.6), no further bump
- Marketplace may take a few minutes to propagate — users may need to refresh VS Code's Extensions panel or run "Extensions: Check for Updates"
- Next user task: install on test machine (`code --install-extension UnicDB-1.51.6.vsix`) or pull update from Marketplace directly
