# TASK-AICHAT-006 — Consolidate the final spec: rewrite docs/AI_CHAT_REDESIGN.md

- Status: `ready`
- Owner: `handoff`
- Reviewer: `code-reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Consolidation), §6 (all ACs land here)

## Goal

Assemble the research-complete, implementation-ready final spec by rewriting
`docs/AI_CHAT_REDESIGN.md` (the ONLY task authorized to write it). Merge the baseline draft's
retained sections with TASK-004's interaction sections and TASK-005's platform sections;
rewrite the Status header and the Evidence section around the named-subject substitution;
produce one deduplicated acceptance-test index; re-verify every `file:line` anchor with the
automated anchor checker; and append an implementation-sequencing appendix so the next cycle
can plan waves directly from this document. Nothing from the baseline may be silently lost:
retained verbatim, upgraded in place, or superseded with explicit rationale.

## Target Files

- `docs/AI_CHAT_REDESIGN.md` — (existing, untracked baseline; fully rewritten by this task).

## Test Cases (REQUIRED — document-acceptance checks; runtime suites are N/A: SPEC-ONLY docs cycle)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Full section set present | Final spec contains: updated Status header (research-complete + date); Scope; Evidence status (substitution stated); Composer interaction contract (keyboard/slash/mention/geometry+a11y); Streaming & rendering; Activity timeline; Sessions & persistence; Permissions & approvals; Failures & recovery; Engine capability matrix; Visual acceptance; acceptance-test index; Source anchors; implementation-sequencing appendix | TASK-004 + TASK-005 section drafts approved/available |
| 2 | happy | Anchor integrity | Anchor checker (§Verification Commands) parses every `file.ts:A–B` anchor in the final spec; all files exist; all ranges in-bounds; exits 0 | Final spec written |
| 3 | edge (dangling-promise regression) | Old unresolved promise is gone | `grep "three requested Marketplace extensions"` finds nothing; Evidence section names GitHub Copilot Chat, Cline, Continue + official VS Code surfaces as the substituted subjects and states the substitution openly | Baseline Evidence section contained the dangling promise |
| 4 | edge (baseline preservation, boundary) | Nothing silently lost | KBD-01..07, SLASH-01..06, MENTION-01..10 each present; all geometry/timing values present (420px, 8px, 280px, 40vh, 44px, 12px, 16px, 13px/20px, 11px/16px, 2px focus, 500 ms, 150 ms, 200 ms); every acceptance ID unique (checker exit 0) | Baseline draft + both section drafts |
| 5 | edge (consistency) | Terminology and families reconciled | One accepted name per concept (command menu, mention menu, chip, engine, session); family coverage KBD≥8, SLASH≥8, MENTION≥10, A11Y≥6, STREAM≥6, TIME≥5, SESS≥6, PERM≥5, FAIL≥6; no section contradicts another (engine-command rules live in ONE place, others reference it) | Both section drafts merged |
| 6 | edge (attribution) | Evidence discipline holds end-to-end | Every external claim labeled `Verified-with-URL` / `Reported-unverified` / `Could-not-verify` or Q-referenced; zero `TBD|TODO|should be nice`; implementation appendix sequences future work into independent chunks without authorizing this cycle to implement them; if TASK-003 ended `BLOCKED(network)`, the Evidence section states the block openly and every affected claim carries `Could-not-verify` — an acceptable terminal state; consolidation still completes | Final spec |

## Test Files

- Document-acceptance checks run against `docs/AI_CHAT_REDESIGN.md` itself. No executable
  test file — SPEC-ONLY docs cycle; the anchor checker below is the executable gate.

## Verification Commands

```bash
node -e 'const fs=require("fs");const doc=fs.readFileSync("docs/AI_CHAT_REDESIGN.md","utf8");const re=/([\w\/.-]+\.(?:ts|js)):(\d+)(?:[–-](\d+))?/g;let m,f=0;while((m=re.exec(doc))){const[F,a,b]=[m[1],+m[2],m[3]?+m[3]:+m[2]];if(!fs.existsSync(F)){console.log("MISSING FILE",F);f++;continue}const n=fs.readFileSync(F,"utf8").split("\n").length;if(b>n){console.log("RANGE OOB",F,b,">",n);f++}}console.log(f?f+" ANCHOR FAILURES":"ALL ANCHORS OK");process.exit(f?1:0)'
! grep -q "three requested Marketplace extensions" docs/AI_CHAT_REDESIGN.md
for i in 01 02 03 04 05 06 07; do grep -q "KBD-$i" docs/AI_CHAT_REDESIGN.md || { echo "MISSING KBD-$i"; exit 1; }; done
for i in 01 02 03 04 05 06; do grep -q "SLASH-$i" docs/AI_CHAT_REDESIGN.md || { echo "MISSING SLASH-$i"; exit 1; }; done
for i in 01 02 03 04 05 06 07 08 09 10; do grep -q "MENTION-$i" docs/AI_CHAT_REDESIGN.md || { echo "MISSING MENTION-$i"; exit 1; }; done
for f in KBD SLASH MENTION A11Y STREAM TIME SESS PERM FAIL; do test "$(grep -coE "${f}-[0-9]{2}" docs/AI_CHAT_REDESIGN.md)" -ge 5 || { echo "FAMILY TOO THIN: $f"; exit 1; }; done
node -e 'const t=require("fs").readFileSync("docs/AI_CHAT_REDESIGN.md","utf8");const fam={KBD:8,SLASH:8,MENTION:10,A11Y:6,STREAM:6,TIME:5,SESS:6,PERM:5,FAIL:6,VIS:5};let bad=0;for(const[f,min]of Object.entries(fam)){const s=new Set(t.match(new RegExp("\\b"+f+"-\\d{2}\\b","g"))||[]);if(s.size<min){console.log("FAMILY "+f+" distinct "+s.size+"<"+min);bad=1}}process.exit(bad)'
node -e 'const t=require("fs").readFileSync("docs/AI_CHAT_REDESIGN.md","utf8");const ids=t.match(/\b(?:KBD|SLASH|MENTION|A11Y|STREAM|TIME|SESS|PERM|FAIL|VIS)-\d{2}\b/g)||[];const dup=ids.filter((v,i,a)=>a.indexOf(v)!==i);if(dup.length){console.log("DUP IDS",[...new Set(dup)].join(","));process.exit(1)}console.log("UNIQUE",ids.length,"IDS")'
for v in "420px" "280px" "40vh" "44px" "500 ms" "150 ms" "200 ms"; do grep -q "$v" docs/AI_CHAT_REDESIGN.md || { echo "MISSING VALUE: $v"; exit 1; }; done
for s in "Streaming" "Activity timeline" "Sessions" "Permissions" "Failures" "Visual acceptance" "Evidence status" "[Ii]mplementation sequencing"; do grep -qE "$s" docs/AI_CHAT_REDESIGN.md || { echo "MISSING SECTION: $s"; exit 1; }; done
! grep -nEi "TBD|TODO|should be nice" docs/AI_CHAT_REDESIGN.md
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck
```

(No lint script exists in this repo — `typecheck` is the static gate and protects against
accidental out-of-scope edits.)

## Acceptance Criteria

- [ ] Final spec contains the full §Test-Cases-1 section set, English, far denser than the
      70-line baseline (target ≥3× baseline length with no filler).
- [ ] Anchor checker exits 0; ID-uniqueness checker exits 0.
- [ ] Status header updated; Evidence section rewritten around the named substitution; the
      old dangling phrase absent.
- [ ] Baseline IDs, geometry/timing values, and every retained contract preserved or
      superseded with explicit rationale.
- [ ] Implementation-sequencing appendix present (independent future-work chunks, no
      implementation in this cycle).
- [ ] All §Verification Commands pass; no writes outside `docs/` (only
      `docs/AI_CHAT_REDESIGN.md` + at most a Discussion-note edit in this task file).

## Dependencies

- TASK-AICHAT-004 (composer/slash/mention/a11y section drafts)
- TASK-AICHAT-005 (platform section drafts + engine matrix)

## Interfaces

- Consumes: `docs/AI_HANDOFF/notes/aichat-sections-composer.md`,
  `.../aichat-sections-platform.md`, `.../aichat-factbase-webview.md`,
  `.../aichat-factbase-host.md`, `.../aichat-research-external.md`; the baseline
  `docs/AI_CHAT_REDESIGN.md`; read-only source access for the anchor check.
- Produces: the final `docs/AI_CHAT_REDESIGN.md` — the cycle's single deliverable. No other
  task consumes it inside this cycle; the next (implementation) cycle plans from it.

---

## Discussion

### 2026-09-14 · planner · bao-opus
- This is the only task that may write `docs/AI_CHAT_REDESIGN.md` — single-owner by design
  (PLAN §2). Do not edit the two section-draft notes here; if a merge conflict between 004
  and 005 content is found, resolve it IN the final spec and record the resolution under
  `## Discussion` of this task file.
- The anchor checker accepts both en-dash (–) and hyphen (-) range separators because the
  baseline uses en-dashes. If section drafts introduce `file.ts:A-B` with spaces, normalize
  to the checker's grammar instead of weakening the checker.
- Consolidation is where the "far denser than the draft" bar is finally judged: if merged
  length lands under ~3× the baseline with the required sections, sections are still too
  thin — go back to the drafts rather than padding.
- **BLOCKED(network) handling (review round 1):** if TASK-AICHAT-003's Executor Report ends
  `STATUS: BLOCKED(network)`, do not stall or fabricate: the final Evidence section records
  the block openly, every affected external claim carries `Could-not-verify`, and all other
  gates (anchors, IDs, substitution, density) still apply. Consolidation completes; the
  block is reported, never papered over.
- **Task-budget validator dismissal:** the required CLI path
  `.claude/ukit/index/task-budget-validator.mjs` is absent in this consumer-repo install
  (planner confirmed by directory lookup). Manual audit found all required task fields,
  independently reviewable final-document deliverable, concrete 1 happy + 2 distinct edge
  checks, and the only necessary final-file ownership chain; `ready` is appropriate.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
