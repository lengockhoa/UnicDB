# Release procedure — VSDB

This document is the canonical release runbook. Follow it verbatim from a
clean working tree on the release commit. The release is a local artifact
build only; **publishing to the VS Code Marketplace is out of scope** and
must be done in a separate step (see "Publishing" below).

## Pre-flight

1. Working tree clean, on the release commit. Confirm with:
   ```bash
   git status --porcelain   # expect empty
   git log -1 --oneline     # expect the release commit
   ```
2. Node.js and `npm` available. `vsce` is a project devDependency; it
   resolves from `node_modules/.bin/vsce` via `npm run package`.

## Build, test, package

Run the four commands below in order. Stop on the first failure and
investigate before continuing.

```bash
# 1. Static type-check — must exit 0.
npm run typecheck

# 2. Unit tests — must exit 0 (vitest run).
npm test

# 3. Compile — produces dist/extension.js + webview bundles. The
#    `vscode:prepublish` hook in package.json invokes this step
#    automatically before `vsce package`, so it is listed for clarity.
npm run compile

# 4. Package — produces the marketplace-ready .vsix in `dist/` via the
#    build script (npm ci → typecheck → full test → compile → package).
bash scripts/build.sh
```

The package name follows the pattern `dist/vsdb-<version>.vsix` (e.g.
`dist/vsdb-1.6.8.vsix`).

## Artifact assertions

Inspect the produced artifact. Every line below must hold.

```bash
# List contents.
unzip -l dist/vsdb-<version>.vsix

# Expected included paths (observed for v1.6.8; do not pin exact byte counts):
#   extension/dist/extension.js
#   extension/dist/webview.js
#   extension/dist/webview.css
#   extension/dist/aiChatPanel.js
#   extension/dist/connectionForm.js
#   extension/dist/schemaForm.js
#   extension/dist/newTableForm.js
#   extension/dist/aiSettingsForm.js
#   extension/media/vsdb.svg
#   extension/media/icon.png
#   extension/readme.md
#   extension/LICENSE.txt
#   extension/changelog.md
#   extension/package.json
#   extension/syntaxes/vsdb-sql-injection.tmLanguage.json
#   extension.vsixmanifest

# Forbidden patterns (must produce NO matches):
unzip -l dist/vsdb-<version>.vsix | grep -E '(^|/)src/'        # source
unzip -l dist/vsdb-<version>.vsix | grep -E '(^|/)node_modules/' # deps
unzip -l dist/vsdb-<version>.vsix | grep -E '(^|/)tests/'       # tests
unzip -l dist/vsdb-<version>.vsix | grep -E '(^|/)docs/'        # docs
unzip -l dist/vsdb-<version>.vsix | grep -E '(^|/)webview/'     # raw TS
unzip -l dist/vsdb-<version>.vsix | grep -E '\.map$'            # source maps

# Verify embedded package.json metadata.
unzip -p dist/vsdb-<version>.vsix extension/package.json | grep -E '"version"|"license"|"repository"'
```

If any forbidden path matches, add the missing rule to `.vscodeignore`,
delete the artifact (`rm dist/vsdb-<version>.vsix`), and re-run
`bash scripts/build.sh`.

## Local install (smoke)

Use the repo's installer in `--dry-run` mode to validate the file without
actually loading VS Code:

```bash
bash scripts/install-vsdb.sh --local dist/vsdb-<version>.vsix --dry-run
```

For a real install, drop `--dry-run` — the script will hand the file to

## Shipping to users (GitHub Release) — REQUIRED for user-visible changes

Users install ONLY via the one-liner on non-dev machines (no repo, no Node):

```bash
curl -fsSL https://raw.githubusercontent.com/lengockhoa/VSDB/main/scripts/install-vsdb.sh | bash
```

It downloads the `.vsix` from the **latest GitHub Release**. So the runbook above is not
enough: a merged fix reaches no user until a release exists. Every cycle that changes
user-visible behavior must finish with:

```bash
# 1. Bump package.json version + CHANGELOG.md entry, then sync the lockfile
#    (releaseHygiene.test.ts FAILS the build if root version drifts):
npm install --package-lock-only

# 2. Full pipeline: npm ci → typecheck → tests → compile → package dist/vsdb-<ver>.vsix
bash scripts/build.sh

# 3. Sanity-check the artifact before publishing (must print 0):
unzip -p dist/vsdb-<version>.vsix extension/dist/extension.js | grep -c "<regression-marker>"

# 4. Commit, tag, push, publish with the vsix attached:
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v<version>"
git tag v<version> && git push origin main v<version>
gh release create v<version> dist/vsdb-<version>.vsix --title "v<version>" --notes "<summary>"
```

Then tell the user to re-run the one-liner and reload the VS Code window
(`Cmd/Ctrl+Shift+P → Developer: Reload Window`). Merged-to-main without a release =
not shipped.

## Publishing — OUT OF SCOPE

Publishing to the VS Code Marketplace is a separate step that requires a
Personal Access Token and is intentionally not part of this release flow.
To publish later:

```bash
# Requires $VSCE_PAT (Marketplace PAT) and a verified publisher.
npm run vsce-publish    # NOT a real script — run `vsce publish` directly:
npx vsce publish
```

This document does not script publishing because the Marketplace PAT must
not live in the repository.

## Versioning policy

- **patch** (1.5.x → 1.5.y): bugfixes, hardening, no new user-visible
  surface.
- **minor** (1.x.0 → 1.y.0): user-visible feature work (new UI, new
  permission/stream behavior, new engine mode). Cycles M–P are a minor
  bump.
- **major** (x.0.0 → y.0.0): breaking changes to public APIs or wire
  formats.

`vsce` warns when `CHANGELOG.md` is missing. Keep the `[Unreleased]`
section trimmed as releases are cut and add a dated entry per release.
