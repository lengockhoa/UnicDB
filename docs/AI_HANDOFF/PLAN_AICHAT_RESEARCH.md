# PLAN — Cycle AICHAT: research-complete rewrite of docs/AI_CHAT_REDESIGN.md

Prior cycle CLIPGRID archived at `PLAN_CLIPGRID.md` / `INDEX_CLIP.md` (all 4 tasks done/approved,
released v1.53.45 @ df180d5 — see `RUN.md`).

## §1 Intent

**Problem.** `docs/AI_CHAT_REDESIGN.md` (untracked baseline draft) is a research spec for
redesigning the extension's AI chat panel. The user judged it insufficient ("đoạn mô tả này
chưa đủ") and asked for research that makes it as good as possible. The draft itself declares
its two holes: (a) its Scope section promises streaming, activity timeline, sessions,
permissions, failures, accessibility and visual acceptance — but only composer/slash/mention/
autocomplete-geometry exist in detail; (b) its Evidence section records that external research
was BLOCKED (web fetches failed) and that three requested-but-unnamed Marketplace extensions
were never inspected.

**P0 decision (resolved with the user — do not reopen).** SPEC-ONLY cycle. The single
deliverable is a research-complete, implementation-ready `docs/AI_CHAT_REDESIGN.md`.
NO runtime source changes are authorized; every task writes only under `docs/`. Implementation
of the redesign is a future cycle. Doc language: English.

**User mandates (hard requirements).**
1. After local-source research, dig the internet extensively and fold maximum researched
   detail into the spec.
2. "As much detail as possible" is a quality BAR: the finished spec must be far denser than
   the current draft (70 lines) — not a light edit. See §3 for the per-section density bar.

**Dangling-promise resolution (encoded, from the draft's own Evidence section).** The unnamed
"three requested Marketplace extensions" are substituted by named, comparable subjects:
GitHub Copilot Chat, Cline, Continue, plus official VS Code Chat/API/docs surfaces. The
Evidence section of the final spec must state this substitution openly. Grep for the old
phrase must return nothing.

**Success definition.** All of the following are true at cycle end:
- Every section promised by the draft's Scope exists with concrete, implementable detail
  (numbers, tokens, message names, state machines, exact strings, enumerated acceptance IDs).
- Every file:line anchor in the spec is re-verified against the current tree by an automated
  check that exits non-zero on a stale anchor.
- Every external claim carries one of the three evidence labels; zero unattributed claims;
  zero fabricated URLs.
- The draft's existing contracts (KBD-01..07, SLASH-01..06, MENTION-01..10, geometry values)
  are preserved or explicitly superseded with rationale — nothing silently lost.

## §2 Scope

**In scope:** local-source fact-bases (webview layer; host + engine adapters); external
research (official VS Code docs, GitHub Copilot Chat, Cline, Continue, WAI-ARIA APG);
section drafts (composer/slash/mention/a11y; streaming/timeline/sessions/permissions/failures/
engine-matrix/visual-acceptance); final consolidation of `docs/AI_CHAT_REDESIGN.md`.

**Out of scope:** ANY change under `src/`, `webview/`, `package.json`, or any other non-docs
path; git commits by tasks; implementing the redesign; inspecting the original unnamed
Marketplace extensions (substituted per §1); new npm dependencies.

**Per-wave file ownership (hard constraint: no two same-wave tasks share a Target File).**

| Wave | Task | Owns (writes) | Reads only |
|------|------|---------------|-----------|
| 1 | TASK-AICHAT-001 | `docs/AI_HANDOFF/notes/aichat-factbase-webview.md` (new) | `webview/aiChatPanel*.ts`, baseline draft |
| 1 | TASK-AICHAT-002 | `docs/AI_HANDOFF/notes/aichat-factbase-host.md` (new) | `src/ui/aiChatPanel*.ts`, `src/ui/aiChatAttachments.ts`, `src/ai/**`, baseline draft |
| 1 | TASK-AICHAT-003 | `docs/AI_HANDOFF/notes/aichat-research-external.md` (new) | baseline draft; internet via WebSearch/WebFetch |
| 2 | TASK-AICHAT-004 | `docs/AI_HANDOFF/notes/aichat-sections-composer.md` (new) | all three wave-1 notes, baseline draft |
| 2 | TASK-AICHAT-005 | `docs/AI_HANDOFF/notes/aichat-sections-platform.md` (new) | all three wave-1 notes, baseline draft |
| 3 | TASK-AICHAT-006 | `docs/AI_CHAT_REDESIGN.md` (the real target) | all five notes, baseline draft, sources for anchor check |

Wave 1 is 3 tasks executed 2-at-a-time (`handoff.maxParallelAgents = 2`). Wave 2 runs both
draft tasks in parallel. Wave 3 is a single consolidation task. Width is maximal given the
single-target file at the end.

## §3 Approach

**Pipeline: 3 research lanes → 2 section-draft lanes → 1 consolidation.** Research is split
webview-vs-host because the draft's own bugs live on both sides of the postMessage boundary
(webview key listeners vs host command registry vs engine adapters). Section drafting is split
interaction-vs-platform so both wave-2 tasks read all fact-bases but write disjoint sections.
Consolidation is ONE task because `docs/AI_CHAT_REDESIGN.md` is a single owned file and
terminology/ID-numbering reconciliation must happen in one head.

**Local fact-base content (TASK-001, TASK-002).** Verify EVERY file:line anchor the draft
cites, by opening the exact range with `Read(file, offset=<line>)` and recording verdict
`confirms` / `corrects (actual: …)` with a short quote. Inventory — not re-derive — current
behavior. Known leads to chase (from the draft): the Shift+Enter-not-excluded menu Enter bug
(`webview/aiChatPanelMain.ts:792–895`), keyup-only mention detection
(`webview/aiChatPanelMain.ts:907–931`), slash toolbar writing `textarea.value` directly
(`webview/aiChatPanelComposer.ts:441–457`), `innerText` export announcing success unconfirmed
(`webview/aiChatPanelMain.ts:629–640`), host `/engine` accepting only builtin/omp
(`src/ui/aiChatPanel.ts:1744–1816`) vs the panel protocol advertising four engines
(`src/ui/aiChatPanelMessages.ts:91–106`), native resume explicitly unavailable in the Claude
Code (`claudeCodeChatEngine.ts:272–279`) and Codex (`codexChatEngine.ts:357–364`) adapters.
TASK-002 must Glob the full chat surface first (chat/session/stream/permission/attach/
timeline filenames under `src/` and `webview/`) and produce a per-engine capability matrix —
4 rows: `builtin`, `omp`, `claudeCode`, `codex` (builtin confirmed real at
`src/ai/engineChoice.ts:9–21`) × columns: streaming, resume, native commands, model/role
picker, sessions/persistence, permissions/approvals, activity/timeline events, failure modes.

**External research lane (TASK-003).** 22 enumerated questions (Q01–Q22, listed in the task
file) covering every spec section: VS Code Chat docs and Chat/API extension points; Copilot
Chat slash commands, context variables, sessions, streaming presentation, edit-acceptance UX;
Cline Plan/Act approval flows, timeline/checkpoints; Continue context providers, slash
commands, model roles, session storage; WAI-ARIA APG combobox + listbox keyboard tables and
editable-combobox modes; VS Code webview accessibility + workbench color tokens. Every answer
carries a label — `Verified-with-URL` (actually fetched), `Reported-unverified`
(secondary/uncertain source), `Could-not-verify` (with the queries tried). Blocked questions
are recorded honestly, never guessed. This lane's executor needs web tools: launch as a
general-purpose agent (noted in the task's Discussion).

**Section drafts (TASK-004, TASK-005).** Each rewrites its assigned draft sections and adds
new ones, merging fact-base + research. Every statement that differs from current behavior
carries a `current: <file:line does X> → target: Y` delta note. External influences cite the
research question ID (e.g. "per Q13"). No "nice to have" phrasing anywhere.

**Consolidation (TASK-006).** Assembles the final spec: Status header updated; Evidence
section rewritten around the substitution; all sections merged in the draft's existing
section order (Composer contract first, then the new platform sections); a single
acceptance-test index (families below); Source anchors section re-verified by the automated
anchor checker; plus an implementation-sequencing appendix (wave-able chunking of the future
implementation cycle) so the spec is genuinely implementation-ready.

**Quality bar — per-section density (the "maximum detail" mandate, made checkable):**

| Spec section | Required density (minimum bar) |
|---|---|
| Composer keyboard | controller state machine (states + transitions listed); rule per modifier key incl. IME; running-turn policy; draft-preservation guarantees; KBD family extended to ≥8 IDs |
| Slash menu | full current command inventory (from fact-base, with file:line); argument grammar per command; menu row anatomy; per-command picker spec (/clear /resume /engine /model /context /export /help /new); SLASH extended to ≥8 IDs |
| Mention menu | token-boundary detection rules stated concretely; debounce/requestId/correlation values kept (150 ms / 200 ms); chip data model fields enumerated; disambiguation rules per kind; MENTION kept ≥10 IDs |
| Autocomplete geometry + a11y | keep every existing px/ms value (420/8/280/40vh/44/12/8/16/13-20/11-16/2-2/500); APG combobox checklist mapped to new A11Y family ≥6 IDs |
| Streaming & rendering | message-type names from protocol inventory; render coalescing policy; partial-markdown/fence policy; stick-to-bottom scroll rule with px threshold; stop/cancel semantics; STREAM family ≥6 IDs |
| Activity timeline | turn/event model per engine; collapsibility + content rules; TIME family ≥5 IDs |
| Sessions & persistence | storage location/mechanism from fact-base; session schema fields; picker contents; per-engine native-resume wording; rename/delete/export; SESS family ≥6 IDs |
| Permissions & approvals | current permission surface inventory; target approval model (Cline-informed, VS Code-adapted); PERM family ≥5 IDs |
| Failures & recovery | ≥6 distinct failure classes, each with exact user-visible message string + recovery action; FAIL family ≥6 IDs |
| Visual acceptance (owned by TASK-005 — the new-UI-surface owner) | VIS family ≥5 IDs; every NEW rendered surface (stream area, activity timeline, session picker, permission prompts, failure banners) gets concrete layout/spacing/typography values or named VS Code theme tokens, plus 200% zoom, reduced-motion, and light/dark/high-contrast rendering acceptance |
| Engine capability matrix | 4 engine rows × ≥8 capability columns; every cell `Verified (file:line)` or `Unverified-internal` |
| Acceptance-test index | families KBD, SLASH, MENTION, A11Y, STREAM, TIME, SESS, PERM, FAIL, VIS (EXP folded into SLASH/SESS as in the draft) — every ID unique, no gaps |

**Trade-offs / alternatives rejected.**
- *One mega-task writing the whole spec* — rejected: no parallelism (waves 1+2 collapse into a
  chain), no reviewer gate per research lane, and a single agent cannot carry web research +
  8.8k LOC of source reading + writing in one context.
- *Editing the final spec directly in waves 1–2* — rejected: violates the single-owner rule
  for `docs/AI_CHAT_REDESIGN.md` and would serialize everything behind wave 1.
- *Letting fact-base executors also do web research* — rejected: their agent profile has no
  web tools; TASK-003 is explicitly launched as general-purpose with WebSearch/WebFetch.
- *Inspecting the original unnamed Marketplace extensions* — rejected: their identity is
  recorded nowhere in the repo; substitution is the user-sanctioned resolution (§1).
- *Splitting consolidation across two tasks* — rejected: same-file ownership conflict;
  numbering/terminology reconciliation needs one head.
- *Renumbering the draft's existing acceptance IDs freely* — rejected: they are the draft's
  most stable artifact; consolidation preserves them verbatim and appends.

**Stated unknowns (executor resolves, one read each).** Exact session-persistence mechanism
and permission surface are unknown to the planner (no task may guess them; TASK-002's Glob
sweep finds them or records "absent in current source" — which is itself a spec input).
Whether `builtin` is a real engine implementation or a fallback label is resolved by reading
`src/ai/engineChoice.ts` + the engine adapter inventory.

## §4 Test Plan

Docs-only cycle: runtime test suites are N/A (no source changes authorized). Document-
acceptance checks below replace them; each is automated in the owning task's Verification
Commands and fails loudly (non-zero exit).

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | Anchor-integrity check (TASK-006) | node checker parses every `file.ts:A–B` anchor in the final spec; every file exists and B ≤ file line count; exits 0 |
| happy | Section completeness (TASK-006) | final spec contains all sections: Scope, Evidence status, Composer contract (keyboard/slash/mention/geometry+a11y), Streaming, Activity timeline, Sessions, Permissions, Failures, Engine matrix, Visual acceptance, acceptance-test index, Source anchors, implementation sequencing |
| happy | Baseline ID preservation (TASK-006) | KBD-01..07, SLASH-01..06, MENTION-01..10 each still present in the final spec (grep per ID) |
| happy | Research coverage (TASK-003) | notes file has Q01–Q22 headings; ≥15 questions labeled `Verified-with-URL` when the network is reachable — otherwise a documented `BLOCKED(network)` ledger (every attempted Q labeled, blocked Qs `Could-not-verify` with queries/URLs tried) is an acceptable terminal state; substitution section present |
| happy | Fact-base grounding (TASK-001/002) | each note contains verdicts for 100% of the draft's anchors in its layer (6 webview-side, 5 host/engine-side) plus ≥5 new file:line facts; engine matrix has 4 rows × ≥8 columns |
| happy | Draft-section density (TASK-004/005) | each required section reaches its §3 density bar (family ID counts, numeric values present — grep-checked) |
| edge (staleness) | Off-by-N anchor correction (TASK-001/002) | where a cited range no longer matches the described behavior, the note records `corrects (actual: …)` with the true range — zero silent copies |
| edge (regression, dangling promise) | Unresolved-promise ban (TASK-006) | `grep -q "three requested Marketplace extensions" docs/AI_CHAT_REDESIGN.md` exits 1; Evidence section names the substitution subjects |
| edge (attribution) | Unattributed-claim ban (TASK-004/005/006) | every external claim carries `Verified-with-URL` / `Reported-unverified` / `Could-not-verify` or a research-question reference; zero occurrences of "TBD", "TODO", "should be nice" |
| edge (scope guard) | Docs-only write guard (all tasks) | `git status --porcelain -- src webview package.json` is empty after every task (verified clean pre-cycle: only `.gitignore`, `docs/AI_HANDOFF/RUN.md` modified + 2 untracked docs files) |
| edge (boundary) | State-file budget (planner) | `docs/AI_HANDOFF/INDEX.md` and `ACTIVE.md` ≤80 lines each |

## §5 Verification

`package.json` defines `compile, watch, test, test:integration, typecheck, package,
publish:*, verify:fast, verify:release, profile:*` — **no lint script exists**. Every task
runs `npm run typecheck` (the repo static gate) plus the applicable exact commands in its own
`## Verification Commands` block. `npm test` is deliberately not run: this SPEC-ONLY cycle
modifies no runtime behavior, and the task gate requires targeted document checks rather than
the full suite by default. The following shared and final-consolidation commands were dry-run
against the current baseline where their target artifact already exists (all passed).

```bash
# All six tasks: proves this SPEC-ONLY cycle did not edit forbidden runtime paths.
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck

# TASK-AICHAT-001: cited webview anchor ranges remain readable.
test "$(wc -l < webview/aiChatPanelMain.ts)" -ge 931 && test "$(wc -l < webview/aiChatPanelComposer.ts)" -ge 504 && echo ANCHOR-BOUNDS-OK

# TASK-AICHAT-002: cited host/adapter anchor ranges remain readable.
test "$(wc -l < src/ui/aiChatPanel.ts)" -ge 1816 && test "$(wc -l < src/ui/aiChatPanelMessages.ts)" -ge 106 && test "$(wc -l < src/ai/claudeCode/claudeCodeChatEngine.ts)" -ge 279 && test "$(wc -l < src/ai/codex/codexChatEngine.ts)" -ge 364 && echo ANCHOR-BOUNDS-OK

# TASK-AICHAT-003: exactly Q01..Q22, all labeled; research target met OR documented network-block
# (mirrors §4/§6 and TASK-AICHAT-003's own gate: blocked Qs must be Could-not-verify with
# queries/URLs tried — enforced by TASK-AICHAT-003's Test Cases 2/4; never fabricated).
test "$(grep -cE '^### Q[0-9]{2}' docs/AI_HANDOFF/notes/aichat-research-external.md)" -eq 22
test "$(grep -cE 'Verified-with-URL|Reported-unverified|Could-not-verify' docs/AI_HANDOFF/notes/aichat-research-external.md)" -ge 22
test "$(grep -c 'Verified-with-URL' docs/AI_HANDOFF/notes/aichat-research-external.md)" -ge 15 || grep -q 'BLOCKED(network)' docs/AI_HANDOFF/notes/aichat-research-external.md

# TASK-AICHAT-006: every source anchor in the final document exists and is in-bounds.
node -e 'const fs=require("fs");const doc=fs.readFileSync("docs/AI_CHAT_REDESIGN.md","utf8");const re=/([\w\/.-]+\.(?:ts|js)):(\d+)(?:[–-](\d+))?/g;let m,f=0;while((m=re.exec(doc))){const[F,a,b]=[m[1],+m[2],m[3]?+m[3]:+m[2]];if(!fs.existsSync(F)){console.log("MISSING FILE",F);f++;continue}const n=fs.readFileSync(F,"utf8").split("\n").length;if(b>n){console.log("RANGE OOB",F,b,">",n);f++}}console.log(f?f+" ANCHOR FAILURES":"ALL ANCHORS OK");process.exit(f?1:0)'
! grep -q "three requested Marketplace extensions" docs/AI_CHAT_REDESIGN.md
node -e 'const t=require("fs").readFileSync("docs/AI_CHAT_REDESIGN.md","utf8");const ids=t.match(/\b(?:KBD|SLASH|MENTION|A11Y|STREAM|TIME|SESS|PERM|FAIL|VIS)-\d{2}\b/g)||[];const dup=ids.filter((v,i,a)=>a.indexOf(v)!==i);if(dup.length){console.log("DUP IDS",[...new Set(dup)].join(","));process.exit(1)}console.log("UNIQUE",ids.length,"IDS")'
! grep -nEi "TBD|TODO|should be nice" docs/AI_CHAT_REDESIGN.md
```

The complete task-specific document-density and fact-coverage commands are deliberately
repeated in each task file because their target notes do not exist until the owning task runs;
they contain no placeholders and fail non-zero on a missing requirement.

## §6 Acceptance

- [ ] `docs/AI_CHAT_REDESIGN.md` contains every §3 section at its density bar — family ID
      minimums met (KBD≥8, SLASH≥8, MENTION≥10, A11Y≥6, STREAM≥6, TIME≥5, SESS≥6, PERM≥5,
      FAIL≥6, VIS≥5) — TASK-004, TASK-005, TASK-006
- [ ] Anchor checker exits 0 on the final spec; every fact-base anchor verdict recorded —
      TASK-001, TASK-002, TASK-006
- [ ] Evidence section states the named-subject substitution; "three requested Marketplace
      extensions" absent; every external claim labeled; research notes Q01–Q22 with ≥15
      Verified-with-URL — or, if the network is blocked, a documented `BLOCKED(network)`
      ledger as an acceptable terminal state (never fabricated URLs) — TASK-003, TASK-006
- [ ] Baseline contracts preserved: KBD-01..07, SLASH-01..06, MENTION-01..10 and all
      geometry values present in the final spec — TASK-006
- [ ] Engine capability matrix: 4 engines × ≥8 columns, every cell sourced or marked
      Unverified-internal — TASK-002, TASK-005
- [ ] Docs-only invariant: `git status --porcelain -- src webview package.json` empty at
      every task completion — all tasks
- [ ] Every task `ready` (validator `VERDICT: ok`), reviewed (unic-smart reviewer ≠
      executor model), and closed per the state machine — all tasks

## §7 Global Constraints

- SPEC-ONLY: writes allowed under `docs/` only; never touch `src/`, `webview/`,
  `package.json`; never run `git commit` (checkpoint commit is a later phase's job, not a
  task's).
- Doc language: English.
- Evidence labels mandatory on every external claim: `Verified-with-URL` /
  `Reported-unverified` / `Could-not-verify` (with queries tried). Fabricated URLs or
  guessed extension behavior forbidden.
- No runtime behavior stated as existing without a verified `file:line` anchor; proposed
  behavior is marked as target, not current.
- Preserve the baseline draft's honesty discipline; dangling unverified promises forbidden.
- `handoff.reviewer.model = unic-smart`; reviewer model must differ from executor model.
- `handoff.maxParallelAgents = 2`; wave batches ≤2 concurrent agents.
- State files `INDEX.md`, `ACTIVE.md`, `RUN.md` stay ≤80 lines.
- npm is the package manager; no new dependencies (docs cycle adds none anyway).
- Baseline acceptance IDs (KBD-01..07, SLASH-01..06, MENTION-01..10) are preserved
  verbatim; new IDs append, never overwrite.

## Planner Report
PLANNER_MODEL: bao-opus

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) added `builtin` confirmation anchor `src/ai/engineChoice.ts:9–21`
after verifying it exists, replacing a speculative engine list; (2) replaced a naive
`git diff` dirty-tree guard with the pre-verified `git status --porcelain -- src webview
package.json` form (working tree already carries `.gitignore`/`RUN.md` modifications, so a
whole-tree guard would always fail); (3) folded EXP acceptance IDs into SLASH/SESS families
instead of inventing an orphan EXP family the sections don't own; (4) the task-budget
validator (`task-budget-validator.mjs`) is NOT installed in this repo (checked
`.claude/ukit/index/` and `src/core/` — the latter is this extension's own code) — documented
dismissal: manual field-completeness audit performed on all six task files instead (every
required field present; noted in INDEX.md so executors do not hunt for it); (5) dry-ran the
executable gates live against the baseline — anchor checker prints ALL ANCHORS OK, ID
checker prints UNIQUE 23 IDS, bounds + docs-only guard pass, BSD grep handles the en-dash
patterns; (6) replaced three grep alternations that BSD grep mis-handles (`\|` in BRE) and
one never-failing `^|` pattern with `-E` forms that can actually fail.
Known gaps: session-persistence mechanism and current permission surface are unknown until
TASK-002's Glob sweep runs — the plan treats "absent in current source" as a valid, valuable
finding rather than forcing an inventory. External research may be network-blocked again
(it was, in the draft's authoring session); TASK-003's Could-not-verify path plus ≥15
Verified-with-URL target keeps the cycle honest without blocking on connectivity.

## Plan Review Log

### Round 1 — 2026-09-14
REVIEWER_MODEL: bao-opus (opus-class; matches `handoff.reviewer.model = unic-smart` tier per §7; no executor exists at plan stage, so the reviewer-≠-executor rule is not yet applicable — reviewer shares the planner's model class, noted for transparency)
VERDICT: Issues Found
FINDINGS:
  1. IMPORTANT (Completeness/Consistency — §1, §2, §3, §4, §6): "visual acceptance" is one of the draft's declared Scope promises (§1 lists it explicitly) but it is silently unowned: no §2 task covers it (TASK-004 owns a11y, TASK-005 owns streaming/timeline/sessions/permissions/failures/engine-matrix), the §3 density table has no row for it, the §4 section-completeness check does not require it, and §6 has no acceptance item — so the cycle's own automated gates would pass a final spec that drops it, exactly the failure mode §1's success definition ("every section promised by the draft's Scope exists") forbids. Fix: add a "Visual acceptance" row to the §3 density table (visual/motion/screenshot-level acceptance criteria per section); assign ownership in §2 (rendering/timeline visuals → TASK-005, composer/geometry visuals → TASK-004); add it to the §4 completeness section list and a §6 checklist line; if a VISUAL acceptance family is introduced, extend the §5 ID-uniqueness regex to include `VISUAL`.
  2. IMPORTANT (Consistency — §4/§5 TASK-003 gate vs §1/§7 and the planner's own "Known gaps"): `Verified-with-URL ≥ 15` is a hard non-zero-exit gate, yet the plan itself records that the draft's authoring session had web fetches fully BLOCKED. If that recurs, TASK-003 cannot pass honestly — an unpassable bar for an unattended executor is a standing invitation to fabricate URLs/labels, directly contradicting §7 ("Fabricated URLs or guessed extension behavior forbidden") and the honesty discipline the cycle exists to preserve. Fix: define the blocked-network path now — gate becomes "(Verified-with-URL ≥ 15) OR (all 22 questions answered with a label and every blocked one recorded as Could-not-verify with queries tried, task ends STATUS: BLOCKED(network) surfaced to the orchestrator)"; never a silent pass, never a fabricated label.
  3. MINOR (Consistency — §5 anchor checker vs §1 success bullet): the checker regex `/([\w\/.-]+\.(?:ts|js)):(\d+)[–-](\d+)/g` only matches ranged anchors; a single-line anchor like `file.ts:42` in the final spec silently skips validation, weakening the §1 guarantee "every file:line anchor is re-verified by an automated check". Fix: make the range optional and treat end = start: `/([\w\/.-]+\.(?:ts|js)):(\d+)(?:[–-](\d+))?/g` with `b = m[3] ? +m[3] : a`.
NOTES: Otherwise internally consistent — file ownership has no same-wave shared write, the dependency graph (3 fact-bases → 2 disjoint section drafts → 1 consolidation) is executable without guessing, §5's script references are real (`typecheck` exists, `lint` correctly declared absent, verified against package.json), density bars are concrete and checkable, and scope/YAGNI are clean (SPEC-ONLY held throughout; no speculative process weight).

### Round 1b — 2026-09-14 — findings applied
PLANNER_MODEL: bao-opus
1. Visual acceptance (IMPORTANT) — single owner chosen: TASK-AICHAT-005 (owns the new rendered surfaces; TASK-004 keeps the existing composer/geometry-a11y surface, no shared file). Applied: §2 in-scope line adds visual-acceptance; §3 density table gains a "Visual acceptance" row (VIS family ≥5 IDs; concrete spacing/typography/theme tokens + 200% zoom + reduced motion + light/dark/high-contrast for stream area, timeline, session picker, permission prompts, failure banners); §4 section-completeness list adds Visual acceptance; §6 AC1 adds VIS≥5; TASK-AICHAT-005 goal/ownership/test-case-1/verification-commands/ACs updated (family loop + distinct-minima checker + section grep include VIS); TASK-AICHAT-006 section list, section grep, ID-uniqueness regex, and distinct-minima checker extended with VIS; TASK-005 Discussion records the ownership rationale.
2. BLOCKED(network) path (IMPORTANT) — TASK-AICHAT-003 now defines the honest exit: gate is `(Verified-with-URL ≥ 15) OR (BLOCKED(network) marker present AND all 22 Qs labeled AND every blocked Q is Could-not-verify with exact queries/URLs tried)`; verification command changed accordingly; Test Cases 2 and 4 reworded; AC + Discussion state `STATUS: BLOCKED(network)` is surfaced in the Executor Report and never rescued by fabricated entries. PLAN §4 research-coverage row and §6 AC3 treat a documented block as an acceptable terminal state; TASK-AICHAT-006 test case 6 + Discussion instruct consolidation to record the block openly and still complete. ≥15 remains the goal when the network works.
3. Anchor checker regex (MINOR) — widened in both PLAN §5 and TASK-AICHAT-006 to `/([\w\/.-]+\.(?:ts|js)):(\d+)(?:[–-](\d+))?/g` with `b = m[3] ? +m[3] : a`, so single-line `file.ts:N` anchors are validated too. Re-dry-run: baseline still prints ALL ANCHORS OK; synthetic check confirms in-bounds single+range anchors yield 0 failures and a single-line OOB anchor (`aiChatPanelHeader.ts:99999`) is detected as a failure.

### Round 2b — 2026-09-14 — findings applied without re-review (loop cap reached)
PLANNER_MODEL: bao-opus
1. VIS in §3 acceptance-test-index row + §5 ID-uniqueness regex (IMPORTANT, round-1 partial) — §3 index row now lists families KBD, SLASH, MENTION, A11Y, STREAM, TIME, SESS, PERM, FAIL, VIS; the §5 ID-uniqueness checker regex extended to `(?:KBD|SLASH|MENTION|A11Y|STREAM|TIME|SESS|PERM|FAIL|VIS)` (already matched TASK-AICHAT-006's own checkers, which got VIS in round 1b), so duplicate VIS-xx IDs now fail the plan-level gate. Dry-run: baseline UNIQUE 23 IDS; synthetic `VIS-01 VIS-01` detected as DUP and exits 1.
2. §5 TASK-003 gate mirrored with §4/§6 (IMPORTANT, round-1 partial) — §5 research block now reads: exactly 22 `### Qxx` headings; ≥22 combined evidence labels; then `(Verified-with-URL ≥ 15) OR (BLOCKED(network) marker present)` — with the queries/URLs-tried requirement for blocked Qs owned by TASK-AICHAT-003's Test Cases 2/4 and referenced in a §5 comment. Dry-run on fixtures: ≥15 Verified passes; 14 Verified + `BLOCKED(network)` + 22 labels passes; 14 Verified without the marker fails non-zero.


### Round 2 — 2026-09-14
REVIEWER_MODEL: bao-opus (opus-class; `handoff.reviewer.model = unic-smart` tier per §7 — same transparency note as Round 1; no executor exists at plan stage)
VERDICT: Issues Found
FINDINGS:
  1. IMPORTANT (Consistency — §3 line 134 + §5 line 205 vs §3 line 132 / §4 line 170 / §6 line 216; Round 1 fix 1 only PARTIALLY applied): the new VIS family was added to §2 in-scope, the §3 Visual-acceptance density row (VIS≥5, owned by TASK-005), the §4 completeness list and §6 AC1 — but (a) the §3 "Acceptance-test index" row still enumerates the families as "KBD, SLASH, MENTION, A11Y, STREAM, TIME, SESS, PERM, FAIL" with no VIS, so the plan's own index definition omits a family it mandates two rows above; and (b) the §5 ID-uniqueness one-liner alternation `(?:KBD|SLASH|MENTION|A11Y|STREAM|TIME|SESS|PERM|FAIL)-\d{2}` does not match `VIS-NN`, so duplicate VIS IDs pass the plan-level uniqueness gate silently — Round 1's fix 1 explicitly required extending this §5 regex, and only the TASK-006 copy was extended (Round 1b). Fix: add `VIS` to the family list in the §3 acceptance-test-index row AND to the alternation in the §5 node command; re-dry-run on baseline (still UNIQUE 23 IDS, since VIS IDs only exist after TASK-005/006 run).
  2. IMPORTANT (Consistency — §5 lines 198–200 vs §4 research-coverage row + §6 AC3; Round 1 fix 2 only PARTIALLY applied in the plan): §4 and §6 now define the honest exit as "(Verified-with-URL ≥ 15) OR documented BLOCKED(network) ledger (every blocked Q labeled Could-not-verify with queries/URLs tried)", but §5's TASK-AICHAT-003 block still runs the bare `test "$(grep -c 'Verified-with-URL' …)" -ge 15` hard gate under the comment "research threshold met" — it exits non-zero in exactly the state §4/§6 declare acceptable, so the plan states two different gates for the same named check and re-creates the fabrication pressure Round 1 flagged for any executor verifying against §5. Fix: update the §5 TASK-003 command to the OR-form (count ≥15, else require the BLOCKED(network) marker plus a Could-not-verify-with-queries ledger entry), or annotate the block as the reachable-network half with the task file carrying the authoritative conditional — one gate, stated identically in §4/§5/§6.
NOTES: Fresh COMPLETENESS / CLARITY / SCOPE / YAGNI pass is clean: §3 density rows and the §4 completeness list now correspond 1:1 (incl. Visual acceptance), the §4/§6 BLOCKED(network) wording matches Round 1's OR-semantics, ownership stays single-writer per wave, all edits stayed SPEC-ONLY, and Round 1 fix 3 landed verbatim (§5 line 203: optional range `(?:[–-](\d+))?` with `b = m[3] ? +m[3] : +m[2]` — single-line anchors validated). Both findings are mechanical plan-text edits in the same §3/§5 spots the Round-1 fixes touched; no re-planning needed — apply and the plan is ready.
