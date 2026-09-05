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
  package` → `unzip -l UnicDB-*.vsix` checklist (same assertions as Test Cases below) →
  install locally via `scripts/install-UnicDB.sh --local <vsix> --dry-run` → publish later
  (`vsce publish` documented but marked out-of-scope)
- `.vscodeignore` — expected NO edits (already excludes src/, webview/, tests/, docs/,
  node_modules/, `**/*.map`, agent dirs); if a required entry is missing in the produced
  listing, add it and record in Discussion why

## Test Cases (REQUIRED — TDD; artifact assertions, no vitest file — see Test Files)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | artifact (happy) | package builds | `npm run package` exit 0; `UnicDB-1.6.0.vsix` exists in repo root | clean `npm run compile` via vscode:prepublish |
| 2 | edge (exclusion) | no source/test/dev bloat | `unzip -l` output contains NO lines matching `src/`, `node_modules/`, `tests/`, `docs/`, `webview/`, `.map` | artifact from #1 |
| 3 | edge (inclusion) | runtime assets present | listing contains `dist/extension.js`, `dist/webview.js`, `dist/webview.css`, `dist/aiChatPanel.js`, `media/icon.png`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`, `extension.vsixmanifest` | artifact from #1 |
| 4 | regression | metadata intact | embedded `package.json` shows `"version":"1.6.0"`, license MIT, repository URL unchanged; `npm run typecheck` exit 0 after edits | post-edit tree |

Verification evidence: paste `unzip -l` filtered output + grep of embedded package.json
(`unzip -p UnicDB-1.6.0.vsix extension/package.json | head`) into Executor Report.

## Test Files

- N/A — no vitest file. This task's runtime surface is a build artifact; its tests are the
  shell assertions above (exit codes + `unzip -l`/`unzip -p` greps), documented here and in
  `docs/RELEASE.md` so the release step is repeatable. Per PLAN §4 this is the explicitly
  sanctioned exception for slice 3.

## Verification Commands

```bash
npm run typecheck && npm run package && unzip -l UnicDB-1.6.0.vsix
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
  `scripts/install-UnicDB.sh --dry-run` (referenced by RELEASE.md only).
- Produces: `UnicDB-1.6.0.vsix` artifact + `docs/RELEASE.md` procedure (documentation only;
  no code symbols).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Version choice 1.6.0 (minor): cycles M–P added user-visible AI chat features (ACP engine,
permissions, streaming UI) — more than a patch. If reviewer prefers 1.5.2, the only change
is package.json + CHANGELOG heading + this task's expected artifact name; everything else
holds. → @reviewer


## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Bumped version 1.5.1→1.6.0; created CHANGELOG.md (Keep-a-Changelog, 1.6.0/1.5.1/1.5.0); created docs/RELEASE.md (typecheck→test→compile→package→artifact assertions→local-install dry-run); added missing vitest.integration-all.config.ts to .vscodeignore; packaged UnicDB-1.6.0.vsix (1.55 MB, 15 files, no forbidden paths); metadata audit (repository, license MIT, engines) unchanged.
TEST_PLAN_FOLLOWED: task §4 (artifact assertions 1-4)
FILES_CHANGED:
  - package.json: "version": "1.5.1" → "1.6.0" (single-line; no other keys changed).
  - CHANGELOG.md: (new) Keep-a-Changelog format with [1.6.0] / [1.5.1] / [1.5.0] sections; 1.6.0 entry summarizes cycles M–P (ACP engine + permissions, permission detail sanitizer + collapsible rendering, builtin streaming + live tool steps).
  - docs/RELEASE.md: (new) exact runbook: typecheck → test → compile → package → unzip -l assertions → install-UnicDB.sh --local <vsix> --dry-run; vsce publish documented as out-of-scope.
  - .vscodeignore: added `vitest.integration-all.config.ts` (was leaking into the artifact on first package run; first build emitted `extension/vitest.integration-all.config.ts`). Repository URL, license, engines, icon, keywords audited — all already correct, no other changes.
TESTS_ADDED: N/A — task explicitly sanctions shell-based artifact assertions instead of vitest.
VERIFICATION:
  command: npm run typecheck && npm run package && unzip -l UnicDB-1.6.0.vsix
  result: typecheck exit 0; vsce package exit 0; artifact 1,620,697 bytes
  artifact_listing (filtered, post-ignore-fix):
      2898  extension.vsixmanifest
     10537  extension/package.json
     15807  extension/readme.md
      1067  extension/LICENSE.txt
      2523  extension/changelog.md
      1005  extension/media/UnicDB.svg
       956  extension/media/icon.png
    2300107  extension/dist/webview.js
     18696  extension/dist/webview.css
     16815  extension/dist/newTableForm.js
    4931977  extension/dist/extension.js
      7534  extension/dist/connectionForm.js
     10192  extension/dist/aiSettingsForm.js
     14468  extension/dist/aiChatPanel.js
  exclusion_check (must produce 0 matches):
      unzip -l UnicDB-1.6.0.vsix | grep -E '(^|/)src/|(^|/)node_modules/|(^|/)tests/|(^|/)docs/|(^|/)webview/|\.map$|vitest\.integration-all'
      → no matches (clean)
  embedded_package_json: {"version":"1.6.0","license":"MIT","repository":{"type":"git","url":"https://github.com/lengockhoa/UnicDB"},"engines":{"vscode":"^1.75.0"}}
  local_install_dry_run: bash scripts/install-UnicDB.sh --local UnicDB-1.6.0.vsix --dry-run → exit 0, "Using code CLI: /Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
ISSUES: First package run shipped `extension/vitest.integration-all.config.ts` because the existing `.vscodeignore` listed `vitest.config.ts` and `vitest.integration.config.ts` but missed the `-all` variant. Fixed in `.vscodeignore`; rebuilt artifact excludes it. No publish attempted (vsce publish is out of scope per task).
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

### 2026-08-24 · executor · unic/unic-code
Single substantive audit finding: `.vscodeignore` was missing `vitest.integration-all.config.ts`. The two sibling vitest configs were already ignored but the third slipped through because it was added later (cycle M? not in git history under that filename; appears to be a local-only helper). Fixed and noted here so the reviewer can confirm the ignore entry is intentional and aligned with the task's "add missing rule" clause. Everything else (repository URL, license, engines, icon, keywords) audited as already correct per task scope ("only fix what's wrong").
---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: rm -f UnicDB-1.6.0.vsix && npm run package && unzip -l UnicDB-1.6.0.vsix (forbidden/required greps, embedded package.json, install-UnicDB.sh --local --dry-run)
  result: PASS — 15 files 1.55 MB; 0 forbidden matches (src//tests//docs//webview//.map/vitest); 10/10 required paths; embedded "version":"1.6.0"/MIT/repo URL; dry-run exit 0; vsix gitignored via *.vsix (artifact correctly out of git)
TEST_PLAN_COVERAGE: all-followed (assertions 1-4 independently re-verified; .vscodeignore vitest.integration-all.config.ts addition justified and sanctioned by task clause)
FINDINGS:
  critical: none
  important:
    - CHANGELOG.md:6-38 — [1.6.0] entry documents only cycles M–P, but tag v1.5.1 sits at cycle H (commits 9e3f7b1/0bf6bc8); cycles I (PG table designer), J (AI core config/provider/agent), K (AI DB-assist chat), L (omp RPC bridge) all landed inside v1.5.1..HEAD and are absent. 1.5.1→1.6.0 upgraders receive the AI chat foundation for the first time while the shipped changelog (embedded in the .vsix as extension/changelog.md) presents it as pre-existing. Fix: add cycle I–L bullets under [1.6.0] Added, re-run `npm run package`, paste fresh artifact evidence.
  minor:
    - docs/RELEASE.md — "npm run vsce-publish  # NOT a real script" line invites a doomed command; drop it and keep only `npx vsce publish`.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Artifact build itself is reproducible and clean — no executor defect in packaging. The M–P scope came from the task text; planner intent (per review brief) was I–P, so treat this as a spec-accuracy correction, not an executor error.

## Executor Report — fix round 1 (orchestrator)

- CHANGELOG 1.6.0 entry now covers cycles I–P (I–L bullets from archive/HISTORY.md facts; v1.5.1 tag sits at cycle H).
- Rebuilt: `npm run package` exit 0 → UnicDB-1.6.0.vsix (15 files, 1.55 MB); 0 forbidden paths (src/, node_modules); embedded extension/changelog.md contains Cycle I–O entries; embedded package.json version 1.6.0.

## Reviewer Verdict — re-review (fix round 1)

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: rm -f UnicDB-1.6.0.vsix && npm run typecheck && npm run package && unzip -l UnicDB-1.6.0.vsix (+ embedded changelog/package.json greps, forbidden-path grep)
  result: PASS — typecheck exit 0; vsce package exit 0; 15 files / 1.55 MB; 0 forbidden paths; embedded changelog.md carries Cycle I–O bullets; embedded package.json "version":"1.6.0", "license":"MIT"
TEST_PLAN_COVERAGE: all-followed (assertions 1–4; prior finding CHANGELOG.md:6-38 resolved — I–L bullets present and factually consistent with archive/HISTORY.md)
FINDINGS:
  critical: none
  important: none
  minor:
    - docs/RELEASE.md:98 — "npm run vsce-publish  # NOT a real script" line remains (carried over from round 1; advisory only, publish is out of scope).
NEXT_STATUS_FOR_INDEX: approved
NOTES: Original defect fully corrected. I–L entries match HISTORY.md facts (I: +556 unit / 6 PG integration; J: dual-method provider, +60; K: 26-vector run_sql guard, +72; L: bridge + fallback, +117). Cycles M and O have their own bullets; N's substance (streaming, de-stream reset, live tool steps) is covered in the "Added"/"Hardened" sections and the intro — no factual gap.
