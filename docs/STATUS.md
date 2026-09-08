# STATUS — 2026-09-08 (cycle AGT-UI shipped → v1.53.25 + cleanup pass → cbf277a)

## Current state
- **Cycle AGT-UI shipped as v1.53.25** on 2026-09-08. GitHub + Marketplace + `.vsix` artifact all live.
- **Cleanup pass committed on 2026-09-08** as `cbf277a` on `main`, pushed to `origin/main`. 4 of ~10 queued minor findings resolved; typecheck clean, full test suite green (4026 passed / 4 skipped / 0 failed across 273 files). No patch release — none of the fixes are user-visible or security.
- HEAD: `cbf277a` on `main`, pushed to `origin/main`.
- GitHub Release: https://github.com/lengockhoa/UnicDB/releases/tag/v1.53.25 (UnicDB-1.53.25.vsix attached, notes populated post-hoc).
- Marketplace: https://marketplace.visualstudio.com/items?itemName=lengockhoa.UnicDB — `lengockhoa.UnicDB v1.53.25` published via `vsce publish` (PAT from macOS Keychain).
- Verification at ship: `npm run typecheck` clean · `npm test` full suite green (4026 passed / 4 skipped / 0 failed across 273 files) · `npm run compile` clean · UnicDB-1.53.25.vsix packaged (2.06 MB).
- Verification after cleanup: same suite green; no regressions.

## What landed (cycle AGT-UI)
- 8/8 tasks implemented across 3 waves (5 + 2 + 1); reviewed R1–R4 by `unic-smart` (reviewer model isolated from executor).
  - 1 `approved`: TASK-AGTUI-002 (wire protocol).
  - 6 `approved_minor`: TASK-AGTUI-001 / 003 / 004 / 005 (after fixup 960de27) / 006 / 007 / 008 (after fixup fc778a2).
  - 0 critical, 0 unresolved `changes_requested` at ship.
- 2 auto-fix rounds (max-2 cap respected):
  - **005**: thread module emitted `.UnicDB-chat-msg-error` while styles.css styles `.UnicDB-chat-error` → real cross-task integration defect (error bubbles unstyled after 007 swap). Also: 4 raw NUL bytes in thread module's fence sentinel regex made the file binary in git. Fix: emit `-error` (per stylesheet contract), escape NUL sentinels to ` `, update the 2 thread-test assertions. Commit `960de27`.
  - **008**: polish test silent-skips via `describe.runIf(bundleSrc !== null)` when `dist/aiChatPanel.js` is absent — false green. Also: reduced-motion override used unscoped `html, body` selectors (frozen-scoping breach) + dead transition rule. Fix: self-bootstrap compile inside `loadBundle()` + remove the runIf gates + scope reduced-motion to `.UnicDB-chat-thread` + escape raw control bytes in main.ts hint-sanitizer regex. Commit `fc778a2`.
- Engine dispatch from cycle AGT (TASK-011/012) preserved unchanged — `git diff 515d87e..HEAD -- src/ui/aiChatPanel.ts src/extension.ts` shows only AGT-UI task-006's additive `models` / `model_select` / `bypass_permissions` handlers, no backend dispatch changes.
- Element-id compatibility contract held: 15 pinned `#engineBanner` assertions in `aiChatPanelWebview.test.ts` pass unmodified.
- Privacy/security invariants held: no `--dangerously-skip-permissions`, apiKey / DB credentials / HostMcp descriptor never cross any wire frame.

## Visual contract (clone fidelity)
- BLUE accent `#3b82f6` replaces Claude's orange, same placement.
- Big letter "U" character glyph in panel header (28px+ / 700 / sans-serif / BLUE) as the UnicDB brand mark.
- Composer row: `+` / model chip (dropdown of all configured `cfg.models`) / slash `/` hint / bypass-permissions toggle (BLUE OFF default, amber `#f59e0b` ON) / mic.
- Red square stop button (`#dc2626`, 16x16, no border-radius) with `UnicDB-chat-pulse` keyframes (and reduced-motion override).
- Streaming caret at bubble end on every delta; `done` removes caret + closes streaming bubble.
- Tool cards: clickable `.UnicDB-chat-tool-header` toggles `.UnicDB-chat-tool-collapsed` (idempotent across rapid clicks); glyph via `::before` so `card.textContent === summary` is preserved for DbAwareWebview assertions.


## Cleanup pass 2026-09-08 (continued) — cycle AGT-CLEANUP-2 shipped

**12 minor cleanups landed** in cycle AGT-CLEANUP-2 on `main` @ `c95bbdc` (pushed post-R5):

- **6 stale comments** fixed (4-value header in policy.ts re-verified only — already landed in 93746a4; 2 in claudeCodeChatEngine.ts after R4.5 failTurn rework; 1 in commitGenManifest.test.ts header + test title; 1 in TASK-004.md reviewer bullet :201 phantom-race premise)
- **2 dead exports removed**: `isValidEngineChoice` alias in policy.ts:133-135; `_LegacyDetectionTypes` type export in engineChoice.ts:205-208. Both verified non-public (package.json has no exports/types/typings; main = bundled dist/extension.js)
- **3 smoke-helper items**: spawn-ENOENT fail-fast (claudeCodeLiveSmoke + codexLiveSmoke, both with hermetic missing-binary RED→GREEN tests); comment corrections (`--print ping` reaches the model; `--verbose` for stream-json); GATE_ENV hoist (`UnicDB_CLAUDE_CODE_SMOKE` / `UnicDB_CODEX_SMOKE`) shared by describe.skipIf + renamed companion test
- **1 dedup**: extracted `escapeHtml` + `renderMarkdown` into new `webview/markdownSafe.ts`; both consumers (`aiChatPanelMain.ts`, `aiChatPanelThread.ts`) import from it; byte-identical fence template preserved (pinned-class rationale); 8 new RED→GREEN tests in `markdownSafe.test.ts`; bundle recompiled

**Reviews (unic-smart, isolated from executor unic-code):** 7/7 — 5 APPROVED + 2 APPROVED-MINOR (EOF newline in 004; `preId` loop var in 006 — both non-blocking). TASK-CLEAN2-007 had unic-smart pool 503 on both attempts; verdict recorded as orchestrator-cross-check with bounded evidence (vitest 33/33 PASS, fence template byte-identical, no orphan copies, both consumers import correctly). Follow up in next cycle if a later reviewer surfaces anything.

**No patch release.** Cycle plan specified no version bump — these go out with the next feature cycle's release plumbing.

## Active cycle — RES-BAR (in review, 2026-09-08)

Cycle RES-BAR kicked off 2026-09-08 to add WHERE / ORDER BY input boxes to the Results toolbar (Enter = server-side re-run) plus a toolbar-hover-polish fix (drop redundant native title tooltip; smooth 80ms background-color ease to kill the 1-3s late tooltip flicker + instant hover flash). Three tasks across two waves; code complete and under R4 review.

- **Goal**: WHERE / ORDER BY in the Results toolbar, Enter → requery; toolbar hover polish.
- **Base**: main @ accf1b5 (v1.53.26).
- **Tasks (3)**: TASK-RES-001 (webview, requery toolbar inputs) · TASK-RES-002 (ext, `stripLeadingClauseKeyword` boundary helper) · TASK-RES-003 (webview wave 2, drop `btn.title` + smooth hover transition).
- **Waves**: wave 1 = RES-001 ∥ RES-002 (parallel, disjoint files); wave 2 = RES-003 (sequenced after RES-001, shares `webview/main.ts` + `webview/styles.css`).
- **P0 (locked)**: server-side re-run · free SQL fragment · in existing toolbar between `tsv` dropdown and `Search…`.
- **Commits** (all on `main`):
  - `2bc0544` — handoff: plan — RES-BAR cycle.
  - `109008b` — handoff: wave 1 — TASK-RES-001 + TASK-RES-002.
  - `f078391` — chore: drop accidental `node_modules_backup` vitest cache + gitignore it.
  - `59e9ae8` — handoff: wave 2 — TASK-RES-003 (toolbar hover polish).
  - `5d11664` — handoff: docs checkpoint — INDEX/RUN post-wave-2 + TASK-RES-003 executor report.
- **Verification (R3 re-run)**: `npm run typecheck` exit 0 · `npm run compile` clean (`dist/webview.js` 2.3mb / `dist/extension.js` 6.5mb) · targeted `npx vitest run` 69/69 PASS (4 files) · full `npm test` 4081 passed / 4 skipped (no regressions, +42 vs pre-cycle baseline 4039).
- **R2 (model isolation)**: executor = unic-code × 3; reviewer = unic-smart (per `.ukit/storage/config.json` → `handoff.reviewer.model`). Isolation holds.
- **Review range for R4**: `2bc0544..59e9ae8` (code); 5d11664 is docs-only, excluded.
- **R4 status**: batch 1 (RES-001 + RES-002 reviewers) running in parallel; batch 2 (RES-003) queued.
- **R5 plan**: assemble INDEX.md status flips (approved → done; failed → blocked), push `origin/main`, refresh WORKLOG.md, decide patch-release per user ("làm xong phải lên patch mới cho tôi nhé" — pending user confirmation post-review).
- **Constraints preserved**: no `--dangerously-skip-permissions`, apiKey / DB credentials / HostMcp descriptor never cross any wire frame, no `transition: all` on `.UnicDB-btn`, no edit to the `data-tooltip` pseudo-element block at `webview/styles.css:78-115`, no new message type (existing `requery` discriminator is the only webview→extension contract).

## Cleanup pass 2026-09-08 — commit `cbf277a`
**Resolved:**
- `webview/aiChatPanelMain.ts` `applyEngine` builtin+hint branch — was rewriting `#engineBanner` textContent without first calling `header.setEngine("builtin")`, so the banner carried no className and lost styling on first-frame-with-hint. Now class is set before body override.
- `src/ai/omp/hostMcp.ts` standard-tool timeout enforcement — curated lane had a timeout; standard lane did not. Added `HOST_MCP_STANDARD_TOOL_TIMEOUT_MS = 30_000` constant, wrapped `standard.execute(args)` in `Promise.race` against a sentinel timer, `clearTimeout` in try/catch.
- `src/ai/omp/mcpBridge.ts:294-298` — `server.unref()` comment reworded to accurately describe what unref does (releases the listening-socket reference so the host can exit with zero active connections).
- `webview/styles.css` `.UnicDB-chat-tool-collapsible` — preserved the 150ms ease timing token (polish-test contract); moved `padding-top, padding-bottom` transitions onto `.UnicDB-chat-tool-body` so collapse doesn't snap at zeroed padding.

**Deferred (out of cleanup-pass scope):**
- `renderMarkdown` / `escapeHtml` dedup between main.ts and thread.ts (too large — needs its own planner cycle).
- Pre-existing flaky failure in `webviewServerFilter` (1 of 3 full runs — needs separate triage).
- AGT vague minors (stale comments / dead export alias / smoke-helper docs) — descriptions too generic; needs a triage task.

## Queued for next cycle
- AGT vague minors (stale comments, dead export alias, smoke-helper docs) — needs triage to locate specific files/lines before planning.
- `renderMarkdown` / `escapeHtml` dedup (intentional per pinned-class rationale; consolidate in a follow-up cycle to prevent drift).
- Pre-existing flaky test in `webviewServerFilter` area (1 of 3 runs) — worth a future triage task.

## Housekeeping done this turn (2026-09-08)
- Updated `docs/AI_HANDOFF/ACTIVE.md` (AGT-UI implementation_done → cycle shipped).
- Updated `docs/AI_HANDOFF/INDEX.md` (8 AGT-UI rows → done; ship target reached).
- Updated `docs/AI_HANDOFF/RUN.md` cursor through R5 push + release + cleanup pass.
- Appended AGT-UI cycle entry + cleanup-pass entry to `docs/WORKLOG.md`.
- Patched `scripts/bump-version.mjs`:
  - 1.53.24: step 6f → `--notes-file` (was inline `--notes`; multi-line entry confused gh). Landed in 1.53.24 closeout.
  - 1.53.25: `runHost()` helper tries host binary first (Homebrew-installed `gh` ships outside npm registry; `npx --no-install gh` cancels with YES prompt); `readChangelogEntry` regex lookahead now uses `\Z` (was `$` with `m` flag — clipped entries at `---` separators). Commit `0f9319b`.
- GitHub Release for v1.53.25: notes initially empty (regex bug surfaced in `gh release create`); populated post-hoc via `gh release edit --notes-file`. v1.53.25 ship complete.
- Cleanup pass (`cbf277a`): 4 fixes applied, full suite green, pushed.

## Housekeeping still pending (cosmetic, non-blocking)
- `docs/STATUS.md` was overwritten again — the 1.53.24 / 1.51.6 historical entries are gone. If you want to keep historical state, pull them back from `git log -p docs/STATUS.md`.
