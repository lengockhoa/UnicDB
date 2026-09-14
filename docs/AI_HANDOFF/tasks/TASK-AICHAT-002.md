# TASK-AICHAT-002 — Host/engine fact-base: protocol, sessions, permissions, streaming, capability matrix

- Status: `ready`
- Owner: `handoff`
- Reviewer: `code-reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Local fact-base content), §6 AC2 / AC5

## Goal

Produce the host-side fact-base for the AI-chat spec rewrite. First Glob the full chat surface
under `src/` and `webview/` for chat/session/stream/permission/approval/timeline/attach names
so no existing feature is missed. Then read the host UI layer (`src/ui/aiChatPanel.ts`,
`aiChatPanelMessages.ts`, `aiChatPanelCommands.ts`, `aiChatAttachments.ts`) and engine
adapters (`src/ai/omp/**`, `src/ai/claudeCode/**`, `src/ai/codex/**`, builtin choice/path).
Verify EVERY host/adapter draft anchor; inventory protocol messages, sessions/persistence,
permissions/approvals, streaming route, timeline/activity existence, failures; and produce an
honest four-engine capability matrix. Record absent features as `absent in current source`,
never inferred capability.

## Target Files

- `docs/AI_HANDOFF/notes/aichat-factbase-host.md` — (new) the only file this task writes.

## Test Cases (REQUIRED — document-acceptance checks; runtime suites are N/A: SPEC-ONLY docs cycle)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Full chat-surface Glob inventory | Note records actual Glob/search commands + results for chat/session/stream/permission/approval/timeline/attach filenames under `src/` and `webview/`; each discovered relevant file gets a role and whether read deeply / not relevant | Existing tree: `src/ui/aiChatPanel.ts`, `aiChatPanelMessages.ts`, `aiChatPanelCommands.ts`, `aiChatAttachments.ts`; engine dirs omp/claudeCode/codex |
| 2 | happy | Draft host/adapter anchor verdict coverage | One `confirms`/`corrects (actual: …)` verdict plus short quote for: `src/ui/aiChatPanelCommands.ts:1–83`, `src/ui/aiChatPanel.ts:1744–1816`, `src/ui/aiChatPanelMessages.ts:91–106`, `src/ai/claudeCode/claudeCodeChatEngine.ts:272–279`, `src/ai/codex/codexChatEngine.ts:357–364` | Baseline draft §Source anchors; anchor files currently 84/4575/486/313/388 lines |
| 3 | happy | Four-engine capability matrix | Matrix has exactly 4 engine rows (`builtin`, `omp`, `claudeCode`, `codex`) × ≥8 named columns: streaming, resume, native commands, model/role picker, session/persistence, permissions/approvals, timeline events, failure modes; EVERY cell contains either `Verified (file:line)` or `Unverified-internal` / `absent in current source` | `builtin` real selection anchor: `src/ai/engineChoice.ts:9–21` |
| 4 | edge (missing feature) | Absent surface is explicit rather than fabricated | If no current activity timeline, approval UX, native sessions, or engine capability exists, note says `absent in current source` with the files/search terms checked; no row claims it exists without a file:line | Full Glob sweep result |
| 5 | edge (protocol mismatch) | Engine-label / command reconciliation fact found | Note identifies whether `/engine` host parsing accepts the same engines as the protocol advertises, with exact input/output names and anchors; discrepancy is described as fact, not a proposed fix | Draft asserts builtin/omp parser vs four-engine protocol mismatch |
| 6 | edge (failure path) | Failure and stream termination route is traceable | ≥4 distinct failures/terminal paths (provider unavailable, process failure, cancellation, malformed/unexpected host/webview message, or actual equivalents) recorded with triggering condition, current user-visible outcome, and `file:line` | Source inventory |

## Test Files

- Document-acceptance checks run against `docs/AI_HANDOFF/notes/aichat-factbase-host.md`
  itself. No executable test files — SPEC-ONLY docs cycle; `npm test` would test no changed
  runtime behavior.

## Verification Commands

```bash
test "$(wc -l < src/ui/aiChatPanel.ts)" -ge 1816 && test "$(wc -l < src/ui/aiChatPanelMessages.ts)" -ge 106 && test "$(wc -l < src/ai/claudeCode/claudeCodeChatEngine.ts)" -ge 279 && test "$(wc -l < src/ai/codex/codexChatEngine.ts)" -ge 364 && echo ANCHOR-BOUNDS-OK
for r in "aiChatPanelCommands\.ts:1[–-]83" "aiChatPanel\.ts:1744[–-]1816" "aiChatPanelMessages\.ts:91[–-]106" "claudeCodeChatEngine\.ts:272[–-]279" "codexChatEngine\.ts:357[–-]364"; do grep -qE "$r" docs/AI_HANDOFF/notes/aichat-factbase-host.md || { echo "MISSING VERDICT: $r"; exit 1; }; done
for e in builtin omp claudeCode codex; do grep -qw "$e" docs/AI_HANDOFF/notes/aichat-factbase-host.md || { echo "MISSING ENGINE ROW: $e"; exit 1; }; done
test "$(grep -cE 'Verified \([^)]*:[0-9]+' docs/AI_HANDOFF/notes/aichat-factbase-host.md)" -ge 32
grep -qiE "Glob sweep|search inventory" docs/AI_HANDOFF/notes/aichat-factbase-host.md || { echo "MISSING GLOB SWEEP"; exit 1; }
! grep -nEi "TBD|TODO|should be nice" docs/AI_HANDOFF/notes/aichat-factbase-host.md
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck
```

(No lint script exists in this repo — `typecheck` is the static gate and protects against
accidental out-of-scope edits.)

## Acceptance Criteria

- [ ] Full chat-surface Glob/search inventory recorded before conclusions.
- [ ] All 5 draft-cited host/engine anchors have verdicts and quotes.
- [ ] Protocol message inventory names each host→webview and webview→host message relevant to
      send, stream, stop, session, command, context, export, error — or records it absent.
- [ ] Four-engine matrix meets case 3 with no invented cell values.
- [ ] Current sessions/persistence, permission/approval surface, stream route, timeline
      existence, and ≥4 failure/termination paths are factually grounded.
- [ ] All §Verification Commands pass; no writes outside `docs/`.

## Dependencies

- (none)

## Interfaces

- Consumes: `docs/AI_CHAT_REDESIGN.md` baseline §Source anchors (read-only); read-only host
  UI, engine adapter, and engine-choice source tree.
- Produces: `docs/AI_HANDOFF/notes/aichat-factbase-host.md` — sections: (1) search inventory,
  (2) anchor verdicts, (3) protocol inventory, (4) four-engine matrix, (5) sessions /
  permissions / streaming / timeline inventories, (6) failures, (7) exact gaps/open questions.
  Consumed by TASK-AICHAT-005 (§platform sections), TASK-AICHAT-004 (engine-command context),
  and TASK-AICHAT-006 (read-only evidence).

---

## Discussion

### 2026-09-14 · planner · bao-opus
- Confirmed at plan time: adapter directories and files exist — `src/ai/omp/ompChatEngine.ts`,
  `src/ai/claudeCode/claudeCodeChatEngine.ts`, `src/ai/codex/codexChatEngine.ts`; `builtin`
  is named in `src/ai/engineChoice.ts:9–21`. Do not call a missing `builtinChatEngine.ts`
  plausible — find the real fallback route.
- Do not assume a timeline, approval flow, or persistence exists because a redesign needs it.
  Negative evidence is an implementation-relevant research result and must be searchable.
- Keep host protocol message names and TypeScript signatures exact (quote them); no
  plausible-looking schemas.
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
Status: PASS
Note: none

Deliverable: `docs/AI_HANDOFF/notes/aichat-factbase-host.md` (new, 469 lines) in worktree
`/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-aichat-002`, branch
`handoff/task-aichat-002`, milestone commit `b461c6b`. No other file changed.

### RED_OUTPUT (pre-state, before the note existed; same command block the task defines)

```
=== CMD1 anchor bounds ===
ANCHOR-BOUNDS-OK
exit=0
=== CMD2 verdicts ===
MISSING VERDICT: aiChatPanelCommands\.ts:1[–-]83
exit=1        # loop aborts on the first missing verdict
--- separate full sweep of all five ranges ---
MISSING VERDICT: aiChatPanelCommands\.ts:1[–-]83
MISSING VERDICT: aiChatPanel\.ts:1744[–-]1816
MISSING VERDICT: aiChatPanelMessages\.ts:91[–-]106
MISSING VERDICT: claudeCodeChatEngine\.ts:272[–-]279
MISSING VERDICT: codexChatEngine\.ts:357[–-]364
=== CMD4 count ===
ugrep: warning: docs/AI_HANDOFF/notes/aichat-factbase-host.md: No such file or directory
=== CMD5 ===
MISSING GLOB SWEEP
=== CMD7 docs-only ===
DOCS-ONLY-OK
```

RED confirmed: CMD2/CMD4/CMD5 failed for the expected reason (deliverable absent). CMD1 and
CMD7 passed pre-state by design (anchor line bounds and a clean docs-only tree are
preconditions, not behavior under test).

### Verification Output (fresh run after the note was written)

```
########## V1 ##########
ANCHOR-BOUNDS-OK
V1 exit=0
########## V2 ##########
V2 exit=0 (all 5 verdicts present)
########## V3 ##########
V3 exit=0 (all 4 engine rows present)
########## V4 ##########
V4 exit=0 count=33
########## V5 ##########
V5 exit=0 (glob sweep present)
########## V6 ##########
V6 exit=0 (no placeholder markers)
########## V7 ##########
DOCS-ONLY-OK
V7 exit=0
########## V8 typecheck ##########
> UnicDB@1.53.46 typecheck
> tsc --noEmit
TYPECHECK_EXIT=0
```

8 of 8 commands pass. `npm run typecheck` exits 0 (no lint script exists in this repo).
`git status --porcelain` is clean after the milestone commit; `git diff --name-only` against
the previous commit lists only `docs/AI_HANDOFF/notes/aichat-factbase-host.md`.

### Test-plan coverage (document-acceptance checks)

| # | Type | Result |
|---|---|---|
| 1 | happy — Glob inventory | §1 records all eight `find` commands and their results, with a role + read-depth per file |
| 2 | happy — anchor verdicts | §2 gives a confirms/corrects verdict with an exact quote for all 5 ranges (4 ranges corrected by 1–2 lines; substantive claims confirmed) |
| 3 | happy — 4-engine matrix | §4 has exactly `builtin`/`omp`/`claudeCode`/`codex` × 8 named columns; every cell is `Verified (file:line)` or `absent`/`Unverified-internal` |
| 4 | edge — absent surface | §5d and §1f record timeline/activity as `absent in current source` with the exact search terms; §3c does the same for export; no row claims unsupported capability |
| 5 | edge — engine/command reconciliation | §7 item 1 records the `/engine builtin\|omp` parser (`src/ui/aiChatPanel.ts:1779–1781`) vs the four-engine protocol (`src/ui/aiChatPanelMessages.ts:102`) as fact, no proposed fix |
| 6 | edge — failure path | §6 tabulates 14 distinct failure/terminal paths, each with trigger, user-visible outcome and `file:line` (≥4 required) |

### Issues / deviations

- Four of the five draft anchor ranges are off by 1–2 lines (`aiChatPanelCommands.ts:1–83`
  for an 84-line file; `handleCommand` is `:1744–1817`; `AiChatPanelEngine` is `:92–107`;
  claudeCode `resume` is `:273–281`; codex `resume` is `:358–365`). Recorded as
  `corrects (actual: …)` per test case 2 rather than silently matching the draft.
- The task's test-case 3 names `src/ai/engineChoice.ts:9–21` as the "real builtin selection
  anchor". `:9–21` is the module doc-comment that names all four engines; the executable
  selection is `AI_ENGINE_VALUES` at `:83–88` plus the `builtin` early-return at `:150–152`.
  Both are cited in §1h.
- `EXECUTOR_MODEL` is reported as the runtime identifier available to me (`bao-sonnet`). I
  cannot verify the underlying provider model ID from inside the session; if the reviewer
  needs a canonical ID, this field is the honest best-effort value, flagged as such.
- No writes outside `docs/`; no commit outside the worktree; nothing pushed.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: all 8 §Verification Commands re-run in the main working tree (incl. `npm run typecheck`)
  result: 8/8 PASS — ANCHOR-BOUNDS-OK; 5/5 verdicts; 4/4 engine rows; Verified-count=33 (≥32); glob sweep present; no TBD/TODO; DOCS-ONLY-OK; tsc --noEmit exit 0
TEST_PLAN_COVERAGE: all-followed — §1 glob inventory with per-file roles; §2 five anchor verdicts (4 corrected with exact quotes); §4 exactly 4 engines × 8 columns, every cell Verified/absent/Unverified-internal; §1f/§3c/§5d absent surfaces with search terms; §7.1 /engine parser-vs-protocol mismatch as fact; §6 fourteen failure paths with anchors
FINDINGS:
  critical: none
  important: none
  minor:
    - docs/AI_HANDOFF/notes/aichat-factbase-host.md:339 — cites `RESUME_PICKER_CAP` constant at `src/ui/aiChatPanel.ts:1173`; the constant is actually `:1154` (`:1173` is an interface doc comment). The cap-of-20 fact itself is verified (`:1154`, applied at `:4051`; `:4046` anchors the statement start).
    - docs/AI_HANDOFF/notes/aichat-factbase-host.md:375 — redact boundary cited as `aiChatPanel.ts:2601, :2782`; actual `String(redact(delta))` lines are `:2586` (omp route) and `:2782` (image-capable route). `:2601` is `this.postSessionState("running")`. The redaction claim itself is true.
    - docs/AI_HANDOFF/notes/aichat-factbase-host.md:152 — §2c correction places the `AiChatPanelEngine` doc comment at `:91` and interface at `:92`; actually doc comment `:92`, interface keyword `:93` (end `:107` and the `:102` four-engine union are exact).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: ~45 file:line anchors spot-checked (protocol tables, matrix cells, absent-claims, extension wiring, webview export). All substantive claims true; no fabrication; negative-evidence greps reproduce (no timeline/activity/approval files, no builtinChatEngine.ts/sessionStore, no `default:` branch in either wire switch). Only 3 line-number drifts, none changing a conclusion.
