# RELEASE — UnicDB version-bump + publish recipe

Single source of truth for cutting a release. The full pipeline is encoded in
`scripts/bump-version.mjs` so the human operator only has to remember **one
command**. Future function edits that ship user-visible behavior should follow
the same recipe.

## Policy — every code change ships as a version bump

Every user-visible code change (feature, fix, refactor with user impact, AI
cycle close-out) lands as a new version. After the verification gate passes,
the next required step is the `npm run bump` recipe below — never push a raw
unversioned commit to a release branch. This policy is also pinned in
`CLAUDE.md` §"Versioning Policy" so future sessions follow it by default.

| Change type | Action |
|---|---|
| User-visible feature / fix / refactor | `npm run bump -- --changelog-summary "..."` (atomic: ships to GitHub + Marketplace) |
| Internal-only edit (typo, comment, docs) | Optional bump; bump if the day also tags/releases |
| Big new feature area | `npm run bump:minor -- --changelog-summary "..."` |
| Breaking change to existing extension API | `npm run bump:major -- --changelog-summary "..."` |

## TL;DR

```bash
npm run bump -- --changelog-summary "what this ships" --changelog-files "file1, file2"
# one command does it all: bump → lock-sync → CHANGELOG → test → compile → .vsix
#   → commit → tag → push → GitHub release (+.vsix) → VS Code Marketplace publish
```

To target a specific version:

```bash
npm run bump:minor
npm run bump:major
npm run bump -- 1.52.0
```

The script now ships to BOTH GitHub Releases AND VS Code Marketplace in one
atomic step. The two channels stay in lockstep at the same version — no
manual `git tag` / `gh release create` / `vsce publish` needed afterwards.

## What `npm run bump` actually does (in order, ATOMIC)

1. Bump `package.json` `version` (default `patch`).
2. Sync `package-lock.json` via `npm install --package-lock-only`
   (the step `releaseHygiene.test.ts` pins).
3. Prepend a `[<version>] — <YYYY-MM-DD>` block to `CHANGELOG.md` with
   placeholder Summary/Files lines. Fill them inline via
   `--changelog-summary "..."` / `--changelog-files "..."`, or edit the file
   before running. The publish step refuses to proceed if the Summary
   placeholder is still unfilled.
4. `npm run typecheck` + `npm test`.
5. `npm run compile` + `npx vsce package` → `UnicDB-<version>.vsix` at root.
6. **Atomic publish** (only if `--skip-publish` is NOT passed):
   - `git add -A && git commit -m "release: <version>"`
   - `git tag -a v<version>` + `git push origin HEAD v<version>`
   - `gh release create v<version> UnicDB-<version>.vsix --notes "<CHANGELOG entry>"`
   - `npx vsce publish` (publishes current `package.json` version; PAT is in
     macOS Keychain from the first `vsce login lengockhoa`)

If any step fails, the script aborts with a clear message. Steps that
already succeeded are NOT rolled back — re-run `npm run bump` after
fixing the failure, or pick up manually from the failed step.

## All flags

| Flag | Effect |
|---|---|
| `patch` (default) / `minor` / `major` / `X.Y.Z` | Bump target |
| `--skip-test` | Skip typecheck + test (steps 4) |
| `--skip-package` | Skip compile + .vsix (step 5) |
| `--skip-publish` | Skip commit/tag/push/GitHub/Marketplace (step 6) |
| `--changelog-summary "..."` | Fill Summary placeholder inline |
| `--changelog-files "file1, file2"` | Fill Files placeholder inline |

## Fast lane (hotfix — minimal commands, minimal time)

When you need to ship RIGHT NOW and want to skip the verification gates
because you already ran them manually:

| State | Fastest command | Skips |
|---|---|---|
| Already bumped + .vsix built, just need to ship | `npx vsce publish` | nothing |
| Code edited, want full gate (recommended) | `npm run bump` | nothing (full typecheck + test + package) |
| Code edited, tests already passed | `npm run bump -- --skip-test` | typecheck + test |
| Code edited, .vsix already built | `npm run bump -- --skip-test --skip-package` | typecheck + test + compile + .vsix |
| Pure version-bump only, no code change | `npm run bump -- --skip-test --skip-package && npx vsce publish` | everything except the writes |

Default is to run the full gate. Skip flags exist for emergencies — they
keep the gate logic but defer the verification cost to the operator.

## Install locally without waiting for Marketplace

Marketplace propagation can take minutes (sometimes longer). To test the
just-built version RIGHT NOW on the same machine, install the local `.vsix`
directly — VS Code replaces the installed extension immediately:

```bash
# From the repo root, after `npm run bump` produced UnicDB-<version>.vsix:
code --install-extension UnicDB-<version>.vsix
# Or with the full path if you're not in the repo root:
code --install-extension /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/UnicDB-<version>.vsix
```

Or via the VS Code UI:
1. Extensions panel (`Cmd+Shift+X`)
2. Click the `⋯` menu at the top of the panel
3. **Install from VSIX...** → pick `UnicDB-<version>.vsix`
4. **Reload** when prompted

This works even if you already ran `vsce publish` — the local install
shadows the Marketplace version until you uninstall it. To switch back to
the Marketplace-tracked version, uninstall first, then reinstall from
Extensions panel.

## Test on ANOTHER machine (no shared volume)

`code --install-extension /Volumes/...` only works on the machine that
owns the path. To ship to a different machine:

### Option A — push a GitHub Release + use the one-liner installer

This is the canonical user-facing path documented in `docs/MEMORY.md`
(Ship Constraint).

```bash
# On the build machine, after `npm run bump` produced UnicDB-<version>.vsix:
git tag v<version>
git push origin v<version>

# Then on github.com/lengockhoa/UnicDB/releases → edit the new tag →
# attach UnicDB-<version>.vsix as a release asset → Publish.

# On the OTHER machine (Mac/Linux, no dev tools needed):
curl -fsSL https://raw.githubusercontent.com/lengockhoa/UnicDB/main/scripts/install-UnicDB.sh | bash
```

### Option B — copy the `.vsix` ad-hoc (scp, AirDrop, USB, cloud drive)

```bash
# From the build machine, to a machine you can SSH into:
scp UnicDB-<version>.vsix user@other-machine:~/Downloads/

# On the OTHER machine:
code --install-extension ~/Downloads/UnicDB-<version>.vsix
```

macOS AirDrop works too — send the `.vsix` file, then on the other Mac:

```bash
code --install-extension ~/Downloads/UnicDB-<version>.vsix
```

### Option C — host the `.vsix` and install by URL

Newer VS Code accepts an HTTPS URL directly:

```bash
code --install-extension https://example.com/path/to/UnicDB-<version>.vsix
```

Useful when neither SSH nor a shared filesystem is available — host the
file on any static server (GitHub release asset, S3, GCS bucket,
`python -m http.server` on the build machine, etc.).

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

`npm run bump` does this automatically — see §"What `npm run bump` actually
does (in order, ATOMIC)" above. This section is for when you need to
re-publish manually (e.g., publish failed mid-script).

The Personal Access Token is stored in the macOS Keychain the first time you
run `npx vsce login lengockhoa`. Future `npx vsce publish …` invocations
re-use it; you do **not** re-enter the PAT.

```bash
# Manual re-publish of the current package.json version (no level = no bump):
npx vsce publish

# Or bump + publish in one step (only if package.json is at the OLD version):
npx vsce publish patch
```

If `vsce publish` complains "Git working directory not clean", commit the
working tree first. If you see `ENOTFOUND marketplace.visualstudio.com`,
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
