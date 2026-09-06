# RELEASE — UnicDB version-bump + publish recipe

Single source of truth for cutting a release. The full pipeline is encoded in
`scripts/bump-version.mjs` so the human operator only has to remember **one
command**. Future function edits that ship user-visible behavior should follow
the same recipe.

## TL;DR

```bash
npm run bump          # auto-bump patch + sync lock + CHANGELOG entry + test + package .vsix
git add -A && git commit -m "release: <new version>"
npx vsce publish patch
```

To target a specific version:

```bash
npm run bump:minor
npm run bump:major
npm run bump -- 1.52.0
```

## What `npm run bump` actually does (in order)

1. Bumps `package.json` `version` field (`patch` is the default).
2. Runs `npm install --package-lock-only` so `package-lock.json` stays in sync.
   *Why it matters:* `src/__tests__/releaseHygiene.test.ts` asserts that the
   lock file root version equals the manifest version. Skipping step 2 fails
   the test gate.
3. Prepends a `[<version>] — <YYYY-MM-DD>` block to `CHANGELOG.md` with three
   placeholder lines (Summary / Files / Verification) that you fill in before
   committing.
4. Runs `npm run typecheck` and `npm test`. Both must pass.
5. Runs `npm run compile` then `npx vsce package` to produce
   `UnicDB-<version>.vsix` at the repo root.

Pass `--skip-test` or `--skip-package` for fast iteration when you already
ran those stages.

## Publish to VS Code Marketplace

The Personal Access Token is stored in the macOS Keychain the first time you
run `npx vsce login lengockhoa`. Future `npx vsce publish …` invocations
re-use it; you do **not** re-enter the PAT.

```bash
# after `npm run bump` finishes:
git add -A
git commit -m "release: <new version>"
npx vsce publish patch    # bumps to <next> when package.json already at <new>
```

If the publish complains "Git working directory not clean", the commit above
is what fixes it. If you see `ENOTFOUND marketplace.visualstudio.com`,
check your network / VPN.

## Push to GitHub Releases (does NOT publish to Marketplace)

```bash
git tag v<version>
git push origin v<version>
# then attach UnicDB-<version>.vsix via the GitHub web UI
```

GitHub releases and the VS Code Marketplace are **separate channels**. A
GitHub release only distributes the `.vsix` as a downloadable artifact; it
does not appear in VS Code's Extensions panel.

## Edit-flow for function changes (same recipe, with a twist)

When you change source code that is *not* a version bump — say you fix a bug,
add a feature, refactor a function — do all of these before merging:

1. **Read the source first.** No anchor-only edits on stale context.
2. **Edit** with a unique surrounding-anchor `old_string` (not a line number).
3. **Update tests if mocks need new APIs.** When the source adds a new
   `vscode.workspace.*` / `vscode.window.*` call, every `vi.mock("vscode")`
   block in the touched test file must expose that export. Pattern:
   ```ts
   workspace: { onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
   ```
4. **Run `npm run verify:fast`** (typecheck + compile). Cheap to re-run on
   every iteration.
5. **Run `npm test`** for the affected files: `npx vitest run path/to/file`.
6. **Run `npm run verify:release`** once before commit (full typecheck + test
   + compile).
7. **Add a CHANGELOG entry** under an `[Unreleased]` section so the next
   `npm run bump` picks it up cleanly.
8. **Update `docs/STATUS.md`** with a one-line change note if it's user-facing.

## Why this script exists

Before the script, every release required:

- `Edit` on `package.json` to bump version
- `npm install --package-lock-only` (easy to forget; releaseHygiene then fails)
- `Edit` on `CHANGELOG.md` (easy to skip; loses release notes)
- `npm run typecheck && npm test && npm run compile` (each could fail
  silently if a developer skips one)
- `npx vsce package` (different command than `vsce package` if `vsce` isn't
  installed globally)

The 1.51.5 → 1.51.6 cycle (TASK-AI-001-fix) hit every one of those traps at
least once. `scripts/bump-version.mjs` makes the sequence atomic and
idempotent.
