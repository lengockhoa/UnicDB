# PLAN — CHATUX-2026-09-21: Claude Code–first UX redesign of AIChat V2

## §1 Intent

Implement the advisor spec's W1–W4 (P0 core) on the V2 chat surface
(`webview/aiChat/*`): stabilize the layout grid, replace the scroll logic
with a hysteresis state machine that actually follows streaming, rebuild the
message visual system (compact user card, collapsed tool/thinking rows,
code-block header + Copy, always-visible actions), and shrink the composer
to ≤104px. W5 (a11y/perf audit) is queued for a follow-up cycle.

Success: streaming follows to bottom while pinned regardless of focus;
scrolled-up readers keep position + Jump-to-latest pill; every code block
has a header with language + working Copy; every message shows its action
row at rest; composer rests at standard chat proportions. Spec:
`docs/AI_HANDOFF/SPEC.md`.

## §2 Scope

**In scope** — `webview/aiChat/scroll.ts`, `controller.ts` (scroll-driver
lines only), `markdown.ts`, `transcript.ts`, `composer.ts`, `styles.css`,
and tests under `webview/aiChat/__tests__/`.

**Out of scope** — engine/protocol/permission code, V1 appenders
(`aiChatPanelMain.ts`, `markdownSafe.ts`, `webview/styles.css`), W5
a11y/perf audit (queued), new dependencies, version bump/publish. The 18
stale `TASK-AIX0{3,5,6}-*` files are prior-cycle leftovers — INDEX `queued`,
not folded.

**File-collision constraint:** `styles.css` is touched by TASK-001, -003,
-004 → serialized (T3 depends on T1, T4 on T3). TASK-002 (scroll.ts +
controller.ts scroll lines) shares no file with T1 and runs parallel.

## §3 Approach

- **W1 layout (T1):** CSS-only stabilization — keep the existing
  `40px auto minmax(0,1fr) auto auto 20px` grid (already correct), drop the
  fixed `width: 880px` on assistant items, normalize Markdown spacing, pin
  the single-scroll-owner contract with a CSS-scan test. No DOM changes.
- **W2 scroll (T2):** replace `preFrameDistance`/`lastNear` + the
  `isInputFocused` early-return with an explicit
  `following-tail | reading-history` machine (enter ≤72px, exit ≥96px),
  rAF-coalesced scroll writes (setTimeout fallback for jsdom), and a
  guarded `ResizeObserver` re-pin. Pill copy → "↓ Jump to latest — N new".
  `controller.ts` touched only at the scroll-driver lines (295, 329) —
  `SCROLL_BOTTOM_THRESHOLD_PX` → `SCROLL_FOLLOW_EXIT_PX`.
- **W3 message visuals (T3):** `markdown.ts` code block gains a
  `-codeblock` wrapper + header (lang + Copy, 1500ms label feedback);
  `transcript.ts` tool rows default collapsed and reasoning items become
  collapsed disclosure rows; CSS: compact user card (70%, 6x10), 28–32px
  disclosure rows, `-action` opacity gate removed.
- **W4 composer (T4):** constants 64/160 → 36/88; CSS top/input/bottom/
  send metrics per SPEC §8.4 → ≤104px collapsed. Keyboard contract
  (Enter send / Shift+Enter newline / IME ignore) already correct in
  `keyboard.ts` — pinned by a regression test, not reimplemented.

Alternatives rejected: rewriting scroll.ts wholesale (only the state model
is wrong); toast feedback for code copy (spammy); merging T3+T4 (blurs
review of two distinct complaints); splitting styles.css edits across
same-wave tasks (concurrent same-file edits are unsafe).

## §4 Test Plan

| Task | Type | Test name | Expected |
|------|------|-----------|----------|
| T1 | happy | CSS scan: root grid keeps `minmax(0,1fr)` transcript track; `-transcript` is the only `overflow-y:auto` | both true |
| T1 | edge (contract) | `-item-text`/`-item-reasoning` rule body has no `width:`/`max-inline-size` declaration; zero `position: fixed` file-wide | both true — `-error-card` `width:880px` (:2650) / `max-width:880px` (:2836) and `-change-plan` `max-inline-size:880px` (:2512) are intentional, outside FR-001 scope |
| T1 | edge (layout) | `-item-text` keeps `max-width: 92%` after fixed-width removal | rule present |
| T2 | regression+happy | focused textarea + new `text_delta` while pinned | viewport follows to bottom (inverts old autoScroll #4) |
| T2 | edge (boundary) | distance inside 72–96 band across two notifies | state unchanged (no flap) |
| T2 | edge (interaction) | scrolled-up + focused + delta | no scroll; pill "↓ Jump to latest — 1 new" |
| T2 | edge (environment) | jsdom without ResizeObserver/rAF | controller constructs, setTimeout fallback works |
| T2 | edge (observer) | mocked ResizeObserver fires while `following-tail` vs `reading-history` | following → viewport re-pins to bottom; reading → `scrollTop` unchanged |
| T3 | happy | ```sql fence renders | `-codeblock` wrapper + header + "sql" + Copy + inner `pre.-code` |
| T3 | edge (empty) | fence with no language | header "text"; code class `-plain` |
| T3 | edge (error) | clipboard rejects | label "Failed" → restores "Copy" after 1500ms; no throw |
| T3 | edge (state) | tool item + reasoning item at creation | `data-collapsed="1"`, `aria-expanded="false"` |
| T3 | edge (CSS) | `-action` rule scan | no `opacity: 0`, no hover-reveal rule |
| T4 | happy | auto-grow clamp | scrollHeight 20→36px; 60→60px; 400→88px + `input-scroll` |
| T4 | edge (boundary) | CSS scan | top 36/88, input 76, bottom 36, send/primary 32 |
| T4 | edge (input) | IME Enter (`isComposing`/`keyCode 229`) | `decideComposerKey` → `ignore`; no submit |
| T4 | edge (state) | draft text survives `render()` round-trip | textarea value unchanged |

## §5 Verification

Per-task (targeted — `.cache/index/tests-map.json` has no `webview/`
entries; repo is npm/vitest, no `test:release-core` script exists):

```bash
npx vitest run webview/aiChat/__tests__/<task-test-file>
npm run typecheck
npm run compile
```

Wave-boundary regression net (RULES.md): `npm test` (full vitest suite).

## §6 Acceptance

- [ ] W1: single scroll owner + normal flow + normalized spacing → TASK-CHATUX-001
- [ ] W2: hysteresis scroll machine; pinned follow works with focused composer; pill "Jump to latest" → TASK-CHATUX-002
- [ ] W3: code-block header + Copy; collapsed tool/thinking rows; always-visible actions; compact user card → TASK-CHATUX-003
- [ ] W4: composer ≤104px collapsed; 36–88 clamp; IME/Enter contract pinned → TASK-CHATUX-004
- [ ] `npm run typecheck` clean; `npm run compile` bundles; `npm test` green at each wave boundary.
- [ ] No `isInputFocused`/`SCROLL_BOTTOM_THRESHOLD_PX` in scroll.ts; no `opacity: 0` on `-action`; no `width:`/`max-inline-size` declaration in the `-item-text`/`-item-reasoning` rule (`-error-card`/`-change-plan` keep their 880px caps); no hard-coded colors.

## §7 Global Constraints

- Pure-DOM TypeScript in `webview/aiChat/` — no `vscode`, no node builtins, no framework, no `innerHTML` (createElement/textContent only).
- All CSS scoped under `.UnicDB-ai-chat-v2`; colors via `var(--vscode-*)` / existing `--UnicDB-ai-chat-v2-*` tokens only — no hard-coded colors.
- No new npm dependencies; no version bump/package/publish this cycle.
- Frozen labels: `Copy`/`Copied`/`Failed` (code block); pill `↓ Jump to latest — N new`; existing `COPY_OK_LABEL`/`COPY_FAIL_LABEL` for message copy.
- Frozen metrics: follow enter 72px / exit 96px; composer clamp 36/88px; input cap 76px; send 32px; disclosure rows 28–32px; copy-label restore 1500ms; composer collapsed ≤104px.
- `renderState()` stays the single scroll-driver site — no `scroll.notify*` outside it (autoScroll.test.ts #5 invariant).
- jsdom has no layout/ResizeObserver/rAF guarantees — every new DOM API needs a `typeof !== "undefined"` guard or mock.
- Package manager: npm. Test runner: vitest (`npm test` = `vitest run`).

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Planner Self-Audit
Checklist: 14/14 pass
Fixed during audit: styles.css three-way collision resolved by serializing T1→T3→T4 (T2 shares no file and runs parallel to T1); composer.test.ts clamp test uses exported constants so it self-adjusts — task adds explicit-boundary rows instead of re-pinning literals; tests-map.json verified empty for webview paths → per-task verification names concrete vitest files + typecheck + compile; keyboard IME/Enter contract verified already implemented in keyboard.ts → converted from "implement" to "pin with regression test"; draft persistence verified reducer-owned → pin test only, no new plumbing.
Known gaps: visual appearance verified via CSS source scans, not rendered pixels — jsdom does no layout and no screenshot harness exists for the webview (shell.ts CHAT_V2_SCREENSHOT_FIXTURES documents this as the manual-verification path); W5 a11y/perf audit deliberately queued — recorded in INDEX.md; advisor spec §23 P0 list was summarized by the orchestrator, not read verbatim — W1–W4 mapping follows the §19 wave structure as relayed.

## Plan Review Log

### Round 1 — 2026-09-21 · unic-smart
Status: Issues Found

COMPLETENESS:
  - TASK-002 Target Files omit `webview/aiChat/__tests__/errorsScrollA11y.test.ts`, which imports `SCROLL_BOTTOM_THRESHOLD_PX`/`isNearBottom`/`unreadPillLabel` (lines 27-34) and pins the OLD contract in >=4 tests: 48px threshold (:281), old pill copy `"↓ N new response(s)"` (:307-309), and `"composer focus does not jump the viewport"` (:343) which directly contradicts FR-003's removal of focus suppression. `npm run typecheck` and the task's own regression criterion (`vitest run webview/aiChat/__tests__/`) will fail mid-task. Fix: add the file to T2 Target Files with explicit migration rows (new imports, 72/96 re-pin, new pill copy, invert/remove the focus-suppression test).
  - SPEC §11 lists "ResizeObserver re-pin (mocked)" but PLAN §4 / TASK-002 carry no positive re-pin test — only the jsdom no-RO fallback (row 4). The headline W2 behavior (re-pin on resize while `following-tail`) ships unverified. Fix: add a mocked-ResizeObserver re-pin row to T2.
CONSISTENCY:
  - PLAN §4 T1 row 2, §6 acceptance, and TASK-001 test 2 all require "zero `width: 880px` in styles.css", but FR-001 scope removes it only from `-item-text`/`-item-reasoning`; `-error-card` keeps `width: 880px` (styles.css:2650) plus `max-width: 880px` (:2836, substring-matches a plain scan). The scan stays RED unless the executor silently expands scope. Fix: either scope the scan to the item rules (`-item-text`/`-item-reasoning` contain no `width:` declaration) or add `-error-card` to the FR-001 removal scope + Target Files.
CLARITY:
  - SPEC §8.1 never states the fate of `isNearBottom`/`bottomDistance`/`scrollBehavior`/`onProximityChange` exports — executor must guess keep-vs-delete. One line in §8.1 resolves it.
  - SPEC §10 ends with a truncated fragment ("… heights, no fake buttons.") — dangling text; clean up.
SCOPE:
  - none — W1–W4 correctly bounded; W5 and the 18 stale AIX tasks explicitly queued, not folded.
YAGNI:
  - none — surgical edits only; T4 correctly pins existing keyboard/draft behavior instead of reimplementing.

NOTES: Verification commands all runnable (`vitest run`, `tsc --noEmit`, `esbuild` scripts exist; no lint script in repo). Same-wave T001∥T002 share no files — collision analysis correct. Every task has >=1 happy + >=2 edge cases. All findings are fix-forward edits to SPEC/PLAN/task files, not design changes.

### Round 1 — findings applied · 2026-09-21 · unic-smart

- COMPLETENESS-1 (errorsScrollA11y.test.ts): added to TASK-002 Target Files + Test Files with explicit migration rows (imports → `SCROLL_FOLLOW_*`, 48px→72px re-pin, pill copy → "↓ Jump to latest — N new", focus-suppression test inverted, `isNearBottom` test → `followState()` boundaries); vitest command now runs both files.
- COMPLETENESS-2 (ResizeObserver re-pin): added PLAN §4 T2 row + TASK-002 test case 5 — mocked RO re-pins while `following-tail`, no-op while `reading-history`, `destroy()` disconnects.
- CONSISTENCY-1 (880px scan): scoped to the `-item-text`/`-item-reasoning` rule body (no `width:`/`max-inline-size`) in PLAN §4/§6, TASK-001 test 2 + acceptance, SPEC §11/§12 — `-error-card` (:2650/:2836) and `-change-plan` (:2512) caps verified intentional, kept per FR-001.
- CLARITY-1 (export fates): SPEC §8.1 now states keep/remove per export — `isNearBottom` removed; `bottomDistance`/`scrollBehavior`/`onProximityChange` et al. retained.
- CLARITY-2 (§10 fragment): verified false positive — line 361 `heights, no fake buttons.` is the complete final line of the §15 checklist (elided-read artifact); no edit needed.

### Round 2 — 2026-09-21 · unic-smart
Status: Approved

COMPLETENESS:
  - Round 1 gaps verified resolved: SPEC §8.1 names errorsScrollA11y.test.ts (:372-375) for the isNearBottom→followState() migration and the applied-findings log records the TASK-002 Target Files + migration-row edits; PLAN §4 T2 carries the mocked-ResizeObserver re-pin row (following → re-pin to bottom; reading → scrollTop unchanged). Minor residual: §11 scroll row still lists only `autoScroll.test.ts (modify)` — could also name errorsScrollA11y.test.ts, but §8.1 already specifies its migration; non-blocking.
CONSISTENCY:
  - 880px scan now scoped identically everywhere — PLAN §4 T1 row 2, PLAN §6, SPEC §11, SPEC §12 all read "no `width:`/`max-inline-size` in the `-item-text`/`-item-reasoning` rule" with `-error-card`/`max-width:880px`/`-change-plan` caps explicitly kept; no contradiction remains.
CLARITY:
  - Export fates explicit in §8.1 (isNearBottom REMOVED; bottomDistance/scrollBehavior/prefersReducedMotion/mountScrollPill/SCROLL_PILL_*/ScrollMetrics/ScrollControllerOptions unchanged; onProximityChange refires on followState() transitions). §10 fragment confirmed false positive — §15 final line intact.
SCOPE:
  - none — W1–W4 bounded; W5 + 18 stale AIX tasks queued, not folded.
YAGNI:
  - none — T4 pins existing keyboard/draft behavior instead of reimplementing; no speculative abstraction.

NOTES: All Round 1 substantive findings verified resolved in-document; every FR traces to §4 test rows and §11 files, and frozen metrics match across SPEC/PLAN. Plan is ready for wave execution.
