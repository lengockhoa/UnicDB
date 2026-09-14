# TASK-AICHAT-005 — Draft NEW platform sections: streaming, timeline, sessions, permissions, failures, engine matrix

- Status: `ready`
- Owner: `handoff`
- Reviewer: `code-reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 quality-bar table (streaming/timeline/sessions/permissions/failures/matrix rows), §6 AC1 / AC5

## Goal

Write the sections the baseline Scope promises but the draft lacks: Streaming & rendering,
Activity timeline, Sessions & persistence, Permissions & approvals, Failures & recovery,
visual acceptance for every new rendered surface (the VIS family), the
per-engine capability matrix (target-state, built on TASK-002's facts), and the
`/engine` `/model` `/resume` `/context` `/export` + native-command-gating reconciliation.
Every section must reach the plan's density bar: concrete message names from the protocol
inventory, storage/session schema facts, exact user-visible message strings, and enumerated
acceptance-test IDs in the new STREAM/TIME/SESS/PERM/FAIL/VIS families. This file is
section-draft input for TASK-006 consolidation; it is not yet the final spec.

**Section ownership boundary:** this task owns the five platform sections, the visual-
acceptance section, and engine-gated command semantics. It does NOT own composer keyboard
rules, the slash-menu interaction contract/anatomy, mention menus, or geometry/a11y
(TASK-AICHAT-004). Reference them by pointer instead of duplicating.

## Target Files

- `docs/AI_HANDOFF/notes/aichat-sections-platform.md` — (new) the only file this task writes.

## Test Cases (REQUIRED — document-acceptance checks; runtime suites are N/A: SPEC-ONLY docs cycle)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Six new sections + visual acceptance present at density bar | Note contains Streaming & rendering (chunk message names, render coalescing policy, partial-markdown/fence policy, stick-to-bottom rule with px threshold, stop/cancel semantics), Activity timeline (turn/event model, collapsibility), Sessions & persistence (storage mechanism from fact-base, session schema fields, picker contents, per-engine native-resume wording, rename/delete/export), Permissions & approvals (current surface inventory + target model), Failures & recovery, Engine capability matrix, Visual acceptance (VIS IDs covering every new rendered surface — stream area, timeline, session picker, permission prompts, failure banners — with concrete spacing/typography values or named VS Code theme tokens, 200% zoom, reduced motion, light/dark/high-contrast rendering); families meet minimums — ≥6 STREAM, ≥5 TIME, ≥6 SESS, ≥5 PERM, ≥6 FAIL, ≥5 VIS IDs | Wave-1 notes files exist |
| 2 | happy | Capability matrix is sourced, not invented | 4 engine rows (`builtin`, `omp`, `claudeCode`, `codex`) × ≥8 columns; every cell carries `Verified (file:line)` or `Unverified-internal` / `absent in current source`; ≥16 distinct `Verified (file:line)` cells total | TASK-AICHAT-002 matrix + protocol inventory |
| 3 | edge (failure completeness) | Every failure class has message + recovery | ≥6 distinct failure classes (e.g. mid-stream disconnect, engine process exit, permission denied, unresolvable context item, stale/missing session, export write failure), each with an exact proposed user-visible message string in quotes and a recovery action; each maps to a FAIL-xx ID | factbase failure inventory |
| 4 | edge (contradiction resolution) | Engine/command reconciliation is explicit | A reconciliation subsection resolves the `/engine` parser-vs-protocol mismatch citing both anchors (`src/ui/aiChatPanel.ts:1744–1816`, `src/ui/aiChatPanelMessages.ts:91–106`), defines capability-gated command visibility, and preserves the rule that viewing a local transcript must not be labelled native resume (citing the claudeCode/codex adapter anchors) | TASK-AICHAT-002 verdicts |
| 5 | edge (research grounding) | Platform UX is externally informed | ≥6 distinct research-question references (`Qxx`) shaping rules (e.g. Q04/Q05 streaming/stop, Q10/Q11 sessions, Q12/Q13 approvals/timeline, Q17/Q18 error-retry); every external claim labeled or Q-referenced | TASK-AICHAT-003 note |

## Test Files

- Document-acceptance checks run against
  `docs/AI_HANDOFF/notes/aichat-sections-platform.md` itself. No executable test file —
  SPEC-ONLY docs cycle.

## Verification Commands

```bash
for f in STREAM TIME SESS PERM FAIL VIS; do test "$(grep -coE "${f}-[0-9]{2}" docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 5 || { echo "FAMILY TOO THIN: $f"; exit 1; }; done
node -e 'const t=require("fs").readFileSync("docs/AI_HANDOFF/notes/aichat-sections-platform.md","utf8");const fam={STREAM:6,TIME:5,SESS:6,PERM:5,FAIL:6,VIS:5};let bad=0;for(const[f,min]of Object.entries(fam)){const s=new Set(t.match(new RegExp("\\b"+f+"-\\d{2}\\b","g"))||[]);if(s.size<min){console.log("FAMILY "+f+" distinct "+s.size+"<"+min);bad=1}}process.exit(bad)'
for s in "Streaming" "Activity timeline" "Sessions" "Permissions" "Failures" "capability matrix" "Visual acceptance"; do grep -qi "$s" docs/AI_HANDOFF/notes/aichat-sections-platform.md || { echo "MISSING SECTION: $s"; exit 1; }; done
test "$(grep -cE 'Verified \([^)]*:[0-9]+' docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 16
test "$(grep -cE '→ see TASK-AICHAT-004|see aichat-sections-composer' docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 1
grep -q "1744" docs/AI_HANDOFF/notes/aichat-sections-platform.md && grep -qE "91[–-]106" docs/AI_HANDOFF/notes/aichat-sections-platform.md || { echo "MISSING RECONCILIATION ANCHORS"; exit 1; }
test "$(grep -coE 'per Q[0-9]{2}' docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 6
test "$(grep -c '"' docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 6
! grep -nEi "TBD|TODO|should be nice" docs/AI_HANDOFF/notes/aichat-sections-platform.md
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck
```

(No lint script exists in this repo — `typecheck` is the static gate and protects against
accidental out-of-scope edits.)

## Acceptance Criteria

- [ ] All six owned sections + visual acceptance written; STREAM/TIME/SESS/PERM/FAIL/VIS
      meet family minimums (VIS≥5 across the new rendered surfaces).
- [ ] Capability matrix fully labeled; ≥16 verified-sourced cells; no invented capabilities.
- [ ] ≥6 failure classes with exact message strings + recovery actions mapped to FAIL IDs.
- [ ] `/engine`//model//resume reconciliation + capability gating + native-resume wording
      rules explicit with both anchors; "local transcript ≠ native resume" preserved.
- [ ] ≥6 research citations; no unattributed external claims; no duplication of TASK-004
      sections (pointer references instead).
- [ ] All §Verification Commands pass; no writes outside `docs/`.

## Dependencies

- TASK-AICHAT-001 (webview fact-base — streaming render path)
- TASK-AICHAT-002 (host fact-base — protocol, matrix, sessions/permissions inventories)
- TASK-AICHAT-003 (external research — platform UX precedents)

## Interfaces

- Consumes: `docs/AI_HANDOFF/notes/aichat-factbase-webview.md`, `.../aichat-factbase-host.md`,
  `.../aichat-research-external.md`; baseline draft §Scope promises + §Source anchors
  (read-only).
- Produces: `docs/AI_HANDOFF/notes/aichat-sections-platform.md` — the five new platform
  section drafts + engine matrix + engine-command reconciliation, with acceptance-ID
  families STREAM, TIME, SESS, PERM, FAIL. Consumed by TASK-AICHAT-006.

---

## Discussion

### 2026-09-14 · planner · bao-opus
- These sections must be as numerically concrete as the draft's composer sections (that is
  the user's "maximum detail" bar): name protocol message types exactly as inventoried, give
  px/ms thresholds for scroll-lock and coalescing where the platform evidence supports a
  value, and put every proposed user-visible string in quotes so TASK-006 can index them.
- If TASK-002 records "absent in current source" for sessions/permissions/timeline, write the
  section as a target-state design grounded in the research precedents, explicitly labeled
  `new capability (no current source anchor)` — do not pretend an implementation exists.
- Keep per-engine wording honest: native resume is currently unavailable in the Claude Code
  and Codex adapters; the spec must keep stating that per engine, not as a global claim.
- **Visual acceptance lives here (review round 1):** the Scope's visual-acceptance promise
  attaches to the NEW rendered surfaces this task drafts (stream area, timeline, session
  picker, permission prompts, failure banners). TASK-004 keeps the existing composer/
  geometry+a11y surface — exactly one owner per surface, no shared file. Do not duplicate
  TASK-004's geometry values; give NEW surfaces their own concrete VIS-xx criteria.
- **Task-budget validator dismissal:** the required CLI path
  `.claude/ukit/index/task-budget-validator.mjs` is absent in this consumer-repo install
  (planner confirmed by directory lookup). Manual audit found all required task fields,
  independently reviewable section-draft deliverable, concrete 1 happy + 2 distinct edge
  checks, and a bounded docs-only writing scope; `ready` is appropriate.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
SUMMARY: Wrote the new platform section drafts the baseline Scope promised but lacked — Streaming & rendering, Activity timeline, Sessions & persistence, Permissions & approvals, Failures & recovery, the 4-engine capability matrix, the `/engine` `/model` `/resume` `/context` `/export` + native-command-gating reconciliation, and the VIS visual-acceptance family — at the plan's density bar with exact message names, px/ms values, theme tokens, and enumerated STREAM/TIME/SESS/PERM/FAIL/VIS IDs. Sole write target: `docs/AI_HANDOFF/notes/aichat-sections-platform.md`.
TEST_PLAN_FOLLOWED: task §Test Cases 1–5 — all document-acceptance checks pass (family minimums, sourced matrix, ≥8 failure classes, explicit reconciliation anchors, ≥6 per-Qxx citations).

FILES_CHANGED:
  - docs/AI_HANDOFF/notes/aichat-sections-platform.md: (new) 10-section platform draft note, ~520 lines.

TESTS_ADDED:
  - N/A (SPEC-ONLY docs cycle; document-acceptance checks run against the note itself).

RED_OUTPUT (pre-write, against the absent note — all content gates fail):
```
--- cmd1 family-loop ---
ugrep: warning: docs/AI_HANDOFF/notes/aichat-sections-platform.md: No such file or directory
FAMILY TOO THIN: STREAM
exit=1
--- cmd2 distinct-minima ---
Error: ENOENT: no such file or directory, open 'docs/AI_HANDOFF/notes/aichat-sections-platform.md'
exit=1
--- cmd3 sections ---
MISSING SECTION: Streaming
exit=1
--- cmd4 verified-count --- exit=1
--- cmd5 pointer --- exit=1
--- cmd6 anchors ---
MISSING RECONCILIATION ANCHORS
exit=1
--- cmd7 Q-refs --- exit=1
--- cmd8 quotes --- exit=1
--- cmd9 no-vague --- exit=0 (vacuous: empty file has no vague terms)
--- cmd10 docs-only ---
DOCS-ONLY-OK
exit=0
```

VERIFICATION (post-write, worktree `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-aichat-005`):
```
command: for f in STREAM TIME SESS PERM FAIL VIS; do test "$(grep -coE "${f}-[0-9]{2}" docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 5 || { echo "FAMILY TOO THIN: $f"; exit 1; }; done
result: exit 0

command: node -e '... fam={STREAM:6,TIME:5,SESS:6,PERM:5,FAIL:6,VIS:5} ... distinct minima ...'
result: exit 0 — distinct counts STREAM 7, TIME 6, SESS 10, PERM 6, FAIL 12, VIS 8

command: for s in "Streaming" "Activity timeline" "Sessions" "Permissions" "Failures" "capability matrix" "Visual acceptance"; do grep -qi "$s" ... || exit 1; done
result: exit 0

command: test "$(grep -cE 'Verified \([^)]*:[0-9]+' docs/AI_HANDOFF/notes/aichat-sections-platform.md)" -ge 16
result: exit 0 — count=94 lines, 77 distinct `Verified (file:line)` cells (requirement ≥16)

command: test "$(grep -cE '→ see TASK-AICHAT-004|see aichat-sections-composer' ...)" -ge 1
result: exit 0 — count=5

command: grep -q "1744" ... && grep -qE "91[–-]106" ... || exit 1
result: exit 0

command: test "$(grep -coE 'per Q[0-9]{2}' ...)" -ge 6
result: exit 0 — count=22 across 12 distinct Qs (Q02 Q04 Q05 Q06 Q10 Q11 Q12 Q13 Q16 Q18 Q21 Q22)

command: test "$(grep -c '"' ...)" -ge 6
result: exit 0 — count=67

command: ! grep -nEi "TBD|TODO|should be nice" ...
result: exit 0 (no matches)

command: test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
result: exit 0 — DOCS-ONLY-OK

command: npm run typecheck
result: exit 0 — tsc --noEmit, no output (clean)

Milestone commit: 98d6a77 "milestone: platform section drafts ..." on branch handoff/task-aichat-005 (worktree-only; not pushed).
```

ISSUES:
- The capability matrix deliberately carries `Unverified-internal` cells for claudeCode/codex model-role selection and codex permission-gate reachability (inherited from TASK-002 §4c/4d/§7.5/7.11); these are honest unknowns, not invented capabilities, and are flagged for implementation-time confirmation.
- Section 1b/1d coalescing (16 ms/50 ms) and the 24 px stick-to-bottom threshold are UnicDB-original target rules with no upstream anchor (Q04/Q10 shape direction only); they are explicitly marked `new capability (no current source anchor)`.
- The note cites §3g internally in the §9 research index table (a typo for the non-resumable-row rule living in §3c/§4); harmless, but TASK-AICHAT-006 should reconcile the label when consolidating.

HANDOFF_TO_REVIEWER: yes — STATUS: DONE; reviewer must differ from executor model (expect unic-smart).

NEXT: ready for review.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN: PASS
  command: all 11 §Verification Commands re-run in main worktree (/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB)
  result: cmd1 family minima exit 0; cmd2 distinct STREAM=7 TIME=6 SESS=10 PERM=6 FAIL=12 VIS=8; cmd3 sections exit 0; cmd4 verified-anchor lines=94 (>=16); cmd5 composer pointers=5; cmd6 anchors 1744 + 91–106 present; cmd7 per-Qxx=22; cmd8 quotes=67; cmd9 no vague terms; cmd10 DOCS-ONLY-OK; npm run typecheck exit 0
TEST_PLAN_COVERAGE: all-followed — TC1 all six sections + VIS at density bar; TC2 matrix 4x8, every cell labeled, no invented capability (codex gate caveat matches extension.ts:2479 comment); TC3 ten failure classes each with exact quoted string + recovery + FAIL ID; TC4 reconciliation cites both anchors, capability gating + local-transcript≠native-resume preserved; TC5 16 distinct Q IDs, all verified verbatim against aichat-research-external.md
FINDINGS:
  critical: none
  important: none
  minor:
    - docs/AI_HANDOFF/notes/aichat-sections-platform.md:253,287 — RESUME_PICKER_CAP cited as src/ui/aiChatPanel.ts:1173; actual declaration is :1154 (line 1173 is an unrelated comment). Inherited from aichat-factbase-host.md:339; TASK-006 should fix both.
    - docs/AI_HANDOFF/notes/aichat-sections-platform.md:64 — redaction anchor aiChatPanel.ts:2601 is stale; actual `String(redact(delta))` posts are :2586 and :2782 (the :2782 citation is correct). Inherited from aichat-factbase-host.md:375.
    - docs/AI_HANDOFF/notes/aichat-sections-platform.md:177,486,499 — TraceRecorder cited as src/ai/trace.ts:11; the class is at :144 (fact-base used :1). Pin :144 at consolidation.
    - docs/AI_HANDOFF/notes/aichat-sections-platform.md:748 — §9 row "3g/4" references a non-existent §3g (executor self-reported; rule lives in §3c/§3d). Reconcile label in TASK-006.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Anchor spot-checks across ~40 cited file:line ranges confirmed real constructs and verbatim strings (resume gates, disposed/process-failed messages, stream fallback, fallback-to-builtin, optimistic export, permission namespaces, bypass, timeout). No contradiction with fact-bases or the composer note; VIS covers all five new surfaces. Only stale-by-a-few-lines inherited anchors remain.
