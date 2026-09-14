# TASK-AICHAT-001 — Webview-layer fact-base: verify draft anchors, inventory chat webview files, gap list

- Status: `pending_review`
- Owner: `handoff`
- Reviewer: `code-reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Local fact-base content), §6 AC2

## Goal

Produce the webview-side fact-base for the AI-chat spec rewrite. Read the current chat webview
sources (`webview/aiChatPanelComposer.ts`, `webview/aiChatPanelHeader.ts`,
`webview/aiChatPanelThread.ts`, `webview/aiChatPanelMain.ts` + any sibling chat file a Glob
sweep finds), verify EVERY file:line anchor the baseline draft cites for this layer, inventory
current behaviors (keyboard handling, slash menu, mention menu, chips, streaming render path,
export), and list concrete gaps/contradictions with file:line evidence. This note is raw
research input for TASK-AICHAT-004 — do NOT write spec prose, only facts.

## Target Files

- `docs/AI_HANDOFF/notes/aichat-factbase-webview.md` — (new) the only file this task writes.

## Test Cases (REQUIRED — document-acceptance checks; runtime suites are N/A: SPEC-ONLY docs cycle)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Draft anchor verdict coverage | The note contains one verdict line per cited webview anchor — `aiChatPanelComposer.ts:496–504`, `aiChatPanelComposer.ts:441–457`, `aiChatPanelMain.ts:792–895`, `aiChatPanelMain.ts:907–931`, `aiChatPanelMain.ts:629–640` — each marked `confirms` or `corrects (actual: …)` plus a short verbatim quote from the range (verify by `Read(file, offset=<line>)`) | Baseline draft `docs/AI_CHAT_REDESIGN.md` §Source anchors; webview files at current tree content (composer 579 lines, main 2264) |
| 2 | edge (staleness) | Off-by-N mismatch never copied silently | Any cited range whose actual content does not match the draft's description gets `corrects (actual: <true range + what is actually there>)`; zero verdict lines without `confirms`/`corrects` | Same as case 1 |
| 3 | edge (inventory completeness) | Glob sweep finds every chat webview file | Note inventories ALL of the 4 known files AND any sibling chat file found via Glob `webview/*.ts` chat-name patterns, each with a one-line role summary and line count | `webview/` currently: aiChatPanelComposer.ts, aiChatPanelHeader.ts, aiChatPanelThread.ts, aiChatPanelMain.ts |
| 4 | happy | Gap list is concrete and anchored | ≥5 distinct current-behavior facts/gaps, each with `file:line` evidence, including at minimum: Shift+Enter not excluded in menu Enter branches, keyup-only mention detection + query-only (uncorrelated) requests, toolbar slash writing `textarea.value` directly, `innerText`-based export announcing success without host confirmation, and where/how streaming chunks are rendered (entry point + message types consumed) | Same sources |

## Test Files

- Document-acceptance checks run against `docs/AI_HANDOFF/notes/aichat-factbase-webview.md`
  itself (see §Test Cases / §Verification Commands). No executable test files — SPEC-ONLY
  docs cycle; runtime suites (`npm test`) are out of scope and would test nothing this task
  changes.

## Verification Commands

```bash
test "$(wc -l < webview/aiChatPanelMain.ts)" -ge 931 && test "$(wc -l < webview/aiChatPanelComposer.ts)" -ge 504 && echo ANCHOR-BOUNDS-OK
for r in "aiChatPanelComposer\.ts:496[–-]504" "aiChatPanelComposer\.ts:441[–-]457" "aiChatPanelMain\.ts:792[–-]895" "aiChatPanelMain\.ts:907[–-]931" "aiChatPanelMain\.ts:629[–-]640"; do grep -qE "$r" docs/AI_HANDOFF/notes/aichat-factbase-webview.md || { echo "MISSING VERDICT: $r"; exit 1; }; done
test "$(grep -cE 'webview/[A-Za-z]+\.ts:[0-9]+' docs/AI_HANDOFF/notes/aichat-factbase-webview.md)" -ge 20
for f in aiChatPanelComposer aiChatPanelHeader aiChatPanelThread aiChatPanelMain; do grep -q "webview/$f.ts" docs/AI_HANDOFF/notes/aichat-factbase-webview.md || { echo "MISSING INVENTORY: $f"; exit 1; }; done
! grep -nEi "TBD|TODO|should be nice" docs/AI_HANDOFF/notes/aichat-factbase-webview.md
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck
```

(No lint script exists in this repo — `typecheck` is the static gate; included as the
out-of-scope-edit guard even though docs-only changes cannot fail it.)

## Acceptance Criteria

- [ ] All 5 draft-cited webview anchors have `confirms`/`corrects` verdicts with quotes.
- [ ] 4+ webview chat files inventoried with role summaries (Glob sweep recorded, including
      negative results).
- [ ] ≥5 gaps with file:line, including the 5 mandated leads (case 4).
- [ ] Streaming render path documented: which postMessage types carry stream chunks and
      which functions render them.
- [ ] Note is facts-only (no spec prose), English, and reads as direct input for TASK-004.
- [ ] All §Verification Commands pass; no writes outside `docs/`.

## Dependencies

- (none)

## Interfaces

- Consumes: `docs/AI_CHAT_REDESIGN.md` §Composer contract + §Source anchors (read-only
  baseline); `webview/aiChatPanel*.ts` sources (read-only).
- Produces: `docs/AI_HANDOFF/notes/aichat-factbase-webview.md` — sections: (1) per-anchor
  verdicts, (2) file inventory, (3) behavior inventory (keyboard / slash / mention / chips /
  streaming render / export), (4) gap list, (5) open questions for TASK-AICHAT-004.
  Consumed by TASK-AICHAT-004 (§Composer sections) and read-only by TASK-AICHAT-006.

---

## Discussion

### 2026-09-14 · planner · bao-opus
- Anchor bounds verified at plan time: `webview/aiChatPanelMain.ts` = 2264 lines (all cited
  ranges in-bounds), `webview/aiChatPanelComposer.ts` = 579. `Read(file, offset=<line>)` the
  exact cited ranges first — use the index outline if ranges drift.
- The draft says menu Enter branches do not exclude Shift (always-newline contract violation)
  and mention requests carry no correlation id. Verify both statements against the real code;
  if the draft is wrong, `corrects` is the right verdict — the spec must describe reality.
- Do NOT propose fixes here; record what IS. Proposals belong to TASK-AICHAT-004.
- The 2264-line `aiChatPanelMain.ts` is the bulk — use targeted greps for
  keydown/keyup/composition/slash/@/stream/export symbols and read only the hit regions.
- **Task-budget validator dismissal:** the required CLI path
  `.claude/ukit/index/task-budget-validator.mjs` is absent in this consumer-repo install
  (planner confirmed by directory lookup). Manual audit found all required task fields,
  independent deliverable, concrete 1 happy + 2 distinct edge checks, and a bounded docs-only
  research scope; `ready` is appropriate.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  Pre-write run of the anchor-verdict loop (note file absent), verbatim:
  === V1 anchor bounds ===
  ANCHOR-BOUNDS-OK
  === V2 verdict anchors ===
  MISSING VERDICT: aiChatPanelComposer\.ts:496[–-]504
  (exit 1 — loop aborts on the first unresolved anchor range; expected, file did not exist yet)
Verification Output: |
  Post-write, all §Verification Commands (worktree /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-aichat-001):

  === V1: anchor bounds ===
  ANCHOR-BOUNDS-OK
  === V2: 5 verdict anchors ===
  ALL-5-VERDICTS-OK
  === V3: >=20 file:line anchors ===
  anchor-count=43
  COUNT-OK
  === V4: inventory 4 files ===
  INVENTORY-OK
  === V5: no placeholder prose ===
  NO-PLACEHOLDER-OK
  === V6: docs-only ===
  DOCS-ONLY-OK

  $ npm run typecheck
  > UnicDB@1.53.46 typecheck
  > tsc --noEmit
  TYPECHECK_EXIT=0

  Acceptance Criteria:
  - [x] All 5 draft-cited webview anchors have confirms/corrects verdicts with quotes — all five
        verdicts are `confirms`; zero `corrects` (note §1).
  - [x] 4 webview chat files inventoried with role summaries + Glob sweep recorded incl. negative
        results (§2).
  - [x] 8 gaps with file:line (G1..G8), covering all 5 mandated leads (Shift+Enter in menu Enter
        branches G1; keyup-only query-only mention detection G2; toolbar slash writing textarea.value
        G3; innerText export announcing success without host confirmation G4; streaming render path
        entry + message types §3e).
  - [x] Streaming render path documented: `delta` (webview/aiChatPanelMain.ts:72-77, case 1964)
        → `appendDelta` (1272-1320); terminal `assistant` case 1976-1991 → `appendAssistant`.
  - [x] Facts-only, English, structured as input for TASK-004; no writes outside docs/ (V6).
  - [x] All §Verification Commands pass; typecheck exit 0.

  Milestone commit in worktree: `6b0bb95 milestone: webview fact-base note written + all 7 verification commands green` (211 lines added, note file only). No push; no commit outside the worktree.

Status: PASS
Note: |
  All 5 draft anchors resolved to `confirms` — no anchor drift, so no `corrects` verdict exists;
  this is a clean result, not a skipped check. Additional gaps G5 (aiChatPanelThread.ts is imported
  by no production module; runtime uses the inline copies in aiChatPanelMain.ts), G6 (no
  IME/composition guard), G7 (Ctrl/Cmd+Enter suppression is dropdown-state-dependent) and G8
  (mention Enter/Tab silently closes on a token-less row) were recorded as further anchored facts.
  Per the launch note, the mention-row attribute-read line is paraphrased in the note ("reads that
  attribute back at lines 819-822") rather than pasted verbatim, to avoid re-triggering the
  Secret Guard false positive. Runtime suites out of scope per task §Test Files (SPEC-ONLY docs
  cycle); only `npm run typecheck` was run as the static gate. The note file added in this report
  lives on the worktree branch; the orchestrator's copy-back step diffs the worktree against base.
