# TASK-003 — VSIX release pass: clean package, metadata, release doc

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 Slice 3

## Goal

Make `npm run package` (`vsce package`) produce a marketplace-ready artifact: version bump
1.5.1 → 1.6.0, CHANGELOG.md added (vsce warns without it), artifact contents verified
(dist/ + assets in; src/, node_modules/, tests/, docs/, maps out), release steps documented.
NO publishing — no `vsce publish`.

## Target Files

- `package.json` — `"version": "1.6.0"` (nothing else; repository/license/icon/engine/
  keywords audited and already correct — see PLAN §3 Slice 3)
- `CHANGELOG.md` — (new) Keep a Changelog format; `[1.6.0]` entry summarizing AI chat
  cycles M–P (ACP engine + permissions + detail, builtin streaming + live tool steps,
  packaging pass); one line per prior version 1.5.1, 1.5.0 from git log
- `docs/RELEASE.md` — (new) exact steps: `npm test` → `npm run typecheck` → `npm run
  package` → `unzip -l vsdb-*.vsix` checklist (same assertions as Test Cases below) →
  install locally via `scripts/install-vsdb.sh --local <vsix> --dry-run` → publish later
  (`vsce publish` documented but marked out-of-scope)
- `.vscodeignore` — expected NO edits (already excludes src/, webview/, tests/, docs/,
  node_modules/, `**/*.map`, agent dirs); if a required entry is missing in the produced
  listing, add it and record in Discussion why

## Test Cases (REQUIRED — TDD; artifact assertions, no vitest file — see Test Files)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | artifact (happy) | package builds | `npm run package` exit 0; `vsdb-1.6.0.vsix` exists in repo root | clean `npm run compile` via vscode:prepublish |
| 2 | edge (exclusion) | no source/test/dev bloat | `unzip -l` output contains NO lines matching `src/`, `node_modules/`, `tests/`, `docs/`, `webview/`, `.map` | artifact from #1 |
| 3 | edge (inclusion) | runtime assets present | listing contains `dist/extension.js`, `dist/webview.js`, `dist/webview.css`, `dist/aiChatPanel.js`, `media/icon.png`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`, `extension.vsixmanifest` | artifact from #1 |
| 4 | regression | metadata intact | embedded `package.json` shows `"version":"1.6.0"`, license MIT, repository URL unchanged; `npm run typecheck` exit 0 after edits | post-edit tree |

Verification evidence: paste `unzip -l` filtered output + grep of embedded package.json
(`unzip -p vsdb-1.6.0.vsix extension/package.json | head`) into Executor Report.

## Test Files

- N/A — no vitest file. This task's runtime surface is a build artifact; its tests are the
  shell assertions above (exit codes + `unzip -l`/`unzip -p` greps), documented here and in
  `docs/RELEASE.md` so the release step is repeatable. Per PLAN §4 this is the explicitly
  sanctioned exception for slice 3.

## Verification Commands

```bash
npm run typecheck && npm run package && unzip -l vsdb-1.6.0.vsix
```

## Acceptance Criteria

- [ ] Assertions 1-4 hold (evidence pasted in Executor Report)
- [ ] CHANGELOG.md exists with 1.6.0 entry; version bumped; no other package.json keys changed
- [ ] docs/RELEASE.md documents package → verify → local-install flow
- [ ] No `vsce publish` executed; no new dependencies
- [ ] `.vscodeignore` unchanged OR change justified in Discussion

## Dependencies

- (none)

## Interfaces

- Consumes: `npm run package` / `vscode:prepublish` scripts (`package.json:362-363`),
  `scripts/install-vsdb.sh --dry-run` (referenced by RELEASE.md only).
- Produces: `vsdb-1.6.0.vsix` artifact + `docs/RELEASE.md` procedure (documentation only;
  no code symbols).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Version choice 1.6.0 (minor): cycles M–P added user-visible AI chat features (ACP engine,
permissions, streaming UI) — more than a patch. If reviewer prefers 1.5.2, the only change
is package.json + CHANGELOG heading + this task's expected artifact name; everything else
holds. → @reviewer

---
