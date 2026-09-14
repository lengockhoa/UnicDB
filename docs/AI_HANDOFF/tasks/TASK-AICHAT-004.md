# TASK-AICHAT-004 — Draft upgraded composer, slash, mention, autocomplete-geometry/a11y spec sections

- Status: `ready`
- Owner: `handoff`
- Reviewer: `code-reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 quality-bar table (composer/slash/mention/geometry rows), §6 AC1

## Goal

Write the upgraded draft sections for the interaction half of the AI-chat spec: composer
keyboard precedence (controller state machine), slash menu contract, mention menu contract
(detection, correlation, chips), and autocomplete geometry + accessibility. Merge the verified
webview fact-base (TASK-001), host command context (TASK-002), and researched external
patterns (TASK-003) into the baseline draft's existing contracts — preserving every existing
acceptance ID and geometry value verbatim unless explicitly superseded with rationale. This
file is section-draft input for TASK-006 consolidation; it is not yet the final spec.

**Section ownership boundary:** this task owns keyboard precedence, the slash-menu interaction
contract (incl. `/help` `/new` proposals, argument grammar, menu anatomy, SLASH/KBD/MENTION/
A11Y families), mention menu, geometry/a11y. It does NOT own `/engine` `/model` `/resume`
`/context` `/export` backend semantics, native-command gating, or any of streaming/timeline/
sessions/permissions/failures — those are TASK-AICHAT-005's sections. Where a slash command's
backend belongs to 005, write a one-line pointer `→ see TASK-AICHAT-005 section` instead of
duplicating.

## Target Files

- `docs/AI_HANDOFF/notes/aichat-sections-composer.md` — (new) the only file this task writes.

## Test Cases (REQUIRED — document-acceptance checks; runtime suites are N/A: SPEC-ONLY docs cycle)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Four upgraded sections present at density bar | Note contains: composer keyboard precedence (controller state machine with states+transitions listed, rule per modifier key incl. IME, running-turn policy, draft-preservation guarantees), slash menu, mention menu, autocomplete geometry+a11y; families meet plan minimums — ≥8 KBD IDs, ≥8 SLASH IDs, ≥10 MENTION IDs, ≥6 A11Y IDs | Wave-1 notes files exist (factbase-webview, factbase-host, research-external) |
| 2 | happy | External research folded in | ≥8 distinct research-question references (e.g. `Q07`, `Q09`, `Q19`, `Q20`) appear as `per Qxx` citations inside these sections, each shaping a concrete rule, not decoration | TASK-AICHAT-003 note present |
| 3 | edge (fact-grounding) | Every behavior change carries a current→target delta | ≥10 delta notes of the form `current: <file:line does X> → target: Y`, covering at minimum the Shift+Enter-in-menu bug, keyup-only mention detection, textarea.value-direct slash insertion, innerText export hand-off (pointer to 005), uncorrelated mention requests | factbase verdicts from TASK-001/002 |
| 4 | edge (baseline preservation, boundary) | Draft contracts and geometry values preserved | KBD-01..07, SLASH-01..06, MENTION-01..10 each present; every draft geometry/timing value present verbatim: 420px, 8px, 280px, 40vh, 44px, 12px, 8px gap, 16px, 13px/20px, 11px/16px, 2px focus, 2px offset, 500 ms, 150 ms debounce, 200 ms pending | Baseline draft §Composer contract |
| 5 | edge (attribution) | No vague or unattributed prose | Zero `TBD|TODO|should be nice`; every external claim labeled or Q-referenced; superseded draft rules carry explicit `supersedes:` rationale naming the old rule | Finished note |

## Test Files

- Document-acceptance checks run against
  `docs/AI_HANDOFF/notes/aichat-sections-composer.md` itself. No executable test file —
  SPEC-ONLY docs cycle; runtime suites cannot validate spec prose.

## Verification Commands

```bash
for f in KBD SLASH MENTION A11Y; do test "$(grep -coE "${f}-[0-9]{2}" docs/AI_HANDOFF/notes/aichat-sections-composer.md)" -ge 6 || { echo "FAMILY TOO THIN: $f"; exit 1; }; done
node -e 'const t=require("fs").readFileSync("docs/AI_HANDOFF/notes/aichat-sections-composer.md","utf8");const fam={KBD:8,SLASH:8,MENTION:10,A11Y:6};let bad=0;for(const[f,min]of Object.entries(fam)){const s=new Set(t.match(new RegExp("\\b"+f+"-\\d{2}\\b","g"))||[]);if(s.size<min){console.log("FAMILY "+f+" distinct "+s.size+"<"+min);bad=1}}process.exit(bad)'
grep -qiE "state machine|states" docs/AI_HANDOFF/notes/aichat-sections-composer.md || { echo "MISSING CONTROLLER STATE MACHINE"; exit 1; }
test "$(grep -c 'current:' docs/AI_HANDOFF/notes/aichat-sections-composer.md)" -ge 10
test "$(grep -coE 'per Q[0-9]{2}' docs/AI_HANDOFF/notes/aichat-sections-composer.md)" -ge 8
for v in "420px" "280px" "40vh" "44px" "12px" "16px" "13px" "11px" "500 ms" "150 ms" "200 ms"; do grep -q "$v" docs/AI_HANDOFF/notes/aichat-sections-composer.md || { echo "MISSING VALUE: $v"; exit 1; }; done
for i in 01 02 03 04 05 06 07; do grep -q "KBD-$i" docs/AI_HANDOFF/notes/aichat-sections-composer.md || { echo "MISSING KBD-$i"; exit 1; }; done
for i in 01 02 03 04 05 06 07 08 09 10; do grep -q "MENTION-$i" docs/AI_HANDOFF/notes/aichat-sections-composer.md || { echo "MISSING MENTION-$i"; exit 1; }; done
! grep -nEi "TBD|TODO|should be nice" docs/AI_HANDOFF/notes/aichat-sections-composer.md
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck
```

(No lint script exists in this repo — `typecheck` is the static gate and protects against
accidental out-of-scope edits.)

## Acceptance Criteria

- [ ] Four sections written; each meets its plan §3 density row (state machine, argument
      grammar, chip data model, APG checklist mapped to A11Y IDs).
- [ ] KBD/SLASH/MENTION baseline IDs preserved; ≥6 new A11Y IDs added; any superseded rule
      has explicit rationale.
- [ ] ≥10 grounded `current → target` deltas with file:line; ≥8 research citations.
- [ ] All draft geometry/timing values present verbatim.
- [ ] No content duplicated from TASK-005's owned sections; cross-references used instead.
- [ ] All §Verification Commands pass; no writes outside `docs/`.

## Dependencies

- TASK-AICHAT-001 (webview fact-base — anchor verdicts + gap list)
- TASK-AICHAT-002 (host fact-base — command registry/protocol context)
- TASK-AICHAT-003 (external research — Q references + evidence labels)

## Interfaces

- Consumes: `docs/AI_HANDOFF/notes/aichat-factbase-webview.md`, `.../aichat-factbase-host.md`,
  `.../aichat-research-external.md`; baseline draft §Composer interaction contract +
  §Required interaction acceptance tests (read-only).
- Produces: `docs/AI_HANDOFF/notes/aichat-sections-composer.md` — consolidated replacement
  section drafts (composer keyboard / slash / mention / geometry+a11y) with acceptance-ID
  families KBD, SLASH, MENTION, A11Y. Consumed by TASK-AICHAT-006.

---

## Discussion

### 2026-09-14 · planner · bao-opus
- Preserve, do not paraphrase, the baseline's existing contract sentences where they remain
  correct — they are already dense and reviewer-approved shape; the upgrade folds in fact-base
  corrections and researched patterns around them.
- The A11Y family is new: map each APG combobox/listbox requirement (from Q19–Q21 research)
  to an enumerated A11Y-xx acceptance ID instead of leaving accessibility as prose.
- If TASK-003 came back network-blocked, these sections still must be written: cite
  `Could-not-verify` Qs where relevant and mark affected rules as proposal-only (no external
  precedent claim). Detail bar does not shrink.
- **Task-budget validator dismissal:** the required CLI path
  `.claude/ukit/index/task-budget-validator.mjs` is absent in this consumer-repo install
  (planner confirmed by directory lookup). Manual audit found all required task fields,
  independently reviewable section-draft deliverable, concrete 1 happy + 2 distinct edge
  checks, and a bounded docs-only writing scope; `ready` is appropriate.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
