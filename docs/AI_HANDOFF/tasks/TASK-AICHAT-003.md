# TASK-AICHAT-003 — Extensive external research: VS Code, Copilot Chat, Cline, Continue, WAI-ARIA

- Status: `pending_review`
- Owner: `handoff`
- Reviewer: `code-reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (External research lane), §6 AC3

## Goal

Fulfil the user's explicit internet-research mandate: research the official VS Code Chat/docs
surfaces, GitHub Copilot Chat, Cline, Continue, and WAI-ARIA APG deeply enough to give the
final AI chat redesign spec concrete, citable comparative input across every promised section.
Write a research note, not final spec prose. Each answer must preserve evidence honesty:
`Verified-with-URL` only after actually fetching the primary source; `Reported-unverified` for
credible but not directly verified reporting; `Could-not-verify` plus searches/URLs tried when
blocked. If the network is blocked again (as during the baseline draft's authoring session),
the task ends with an explicit `BLOCKED(network)` ledger — every attempted question answered
with a label, every blocked one `Could-not-verify` with the exact queries/URLs tried — which
is an acceptable terminal state per PLAN §6; it must never be rescued by fabricated URLs or
labels. `Verified-with-URL ≥ 15` remains the goal when the network works. The baseline's unnamed "three requested Marketplace extensions" are openly replaced
by GitHub Copilot Chat, Cline, Continue + official VS Code surfaces — record that resolution.

## Target Files

- `docs/AI_HANDOFF/notes/aichat-research-external.md` — (new) the only file this task writes.

## Test Cases (REQUIRED — document-acceptance checks; runtime suites are N/A: SPEC-ONLY docs cycle)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Exhaustive Q01–Q22 coverage | Exactly 22 research-question headings `### Q01` through `### Q22` exist; every answer states subject, query/URL, evidence label, concrete observation, and relevance to named final-spec section(s) | Public web via WebSearch/WebFetch; baseline Scope |
| 2 | happy | Primary-source research depth | ≥15 Qs are `Verified-with-URL` and contain an actual `https://` URL plus a specific observed behavior/wording/API fact — not a generic product assertion; if the network is blocked and `BLOCKED(network)` is declared, this row's acceptable form is: all 22 Qs answered with a label and every blocked Q recording the exact queries/URLs tried (zero fabricated URLs) | Accessible docs/repositories/release docs |
| 3 | happy | Comparative coverage across named subjects | At least one verified or honestly-unverified answer names each: VS Code official surface, GitHub Copilot Chat, Cline, Continue, WAI-ARIA APG; research covers composer, commands, context, streaming, sessions/history, approvals, activity/timeline, accessibility | Named substitute subjects from plan §1 |
| 4 | edge (network block) | Research outage is honestly captured | If WebFetch/Search blocks or fails, each affected Q gives `Could-not-verify` plus exact URL/query tried and error/outcome; the task still answers every Q from reachable sources without inventing URLs or details; when the block prevents reaching the ≥15 target, the note declares `BLOCKED(network)` and that terminal state is acceptable (PLAN §6) — the executor reports it, never works around it with fabricated entries | Network/safety availability uncertain; baseline reports historical failures |
| 5 | edge (attribution) | No unlabelled external behavior | Every external claim line is adjacent to an evidence label and URL/query; no bare assertion such as "Cline does X" without provenance | Finished note |
| 6 | edge (substitution) | Dangling unnamed-extension promise is resolved | Note has a `## Subject substitution` section: quote/restate that the original three Marketplace extensions are unnamed in the repo, name the substitutes, and state they are comparisons rather than claims about the original unnamed extensions | Baseline Evidence status |

## Test Files

- Document-acceptance checks run against
  `docs/AI_HANDOFF/notes/aichat-research-external.md` itself. No executable test file —
  SPEC-ONLY research cycle; a runtime test cannot validate web research.

## Verification Commands

```bash
for n in $(seq -w 1 22); do grep -q "^### Q$n" docs/AI_HANDOFF/notes/aichat-research-external.md || { echo "MISSING Q$n"; exit 1; }; done
test "$(grep -c 'Verified-with-URL' docs/AI_HANDOFF/notes/aichat-research-external.md)" -ge 15 || grep -q 'BLOCKED(network)' docs/AI_HANDOFF/notes/aichat-research-external.md
test "$(grep -cE 'https://[^ )]+' docs/AI_HANDOFF/notes/aichat-research-external.md)" -ge 15
for s in "VS Code" "GitHub Copilot Chat" Cline Continue "WAI-ARIA"; do grep -q "$s" docs/AI_HANDOFF/notes/aichat-research-external.md || { echo "MISSING SUBJECT: $s"; exit 1; }; done
grep -q '^## Subject substitution' docs/AI_HANDOFF/notes/aichat-research-external.md || { echo "MISSING SUBSTITUTION"; exit 1; }
! grep -nEi "TBD|TODO|should be nice" docs/AI_HANDOFF/notes/aichat-research-external.md
test -z "$(git status --porcelain -- src webview package.json)" && echo DOCS-ONLY-OK
npm run typecheck
```

(No lint script exists in this repo — `typecheck` is the static gate and protects against
accidental out-of-scope edits.)

## Acceptance Criteria

- [ ] Q01–Q22 all answered in the required record format.
- [ ] ≥15 `Verified-with-URL` answers with direct, real source pages the executor actually
      fetched — OR a documented `BLOCKED(network)` ledger (all 22 Qs labeled; blocked Qs
      `Could-not-verify` with queries/URLs tried; zero fabricated URLs) as the acceptable
      terminal state; `STATUS: BLOCKED(network)` surfaced in the Executor Report.
- [ ] All five named subjects receive coverage; explicit comparative observations trace to
      composer, commands/context, streaming, sessions, approvals/timeline, or accessibility.
- [ ] Web/tool failures are recorded per question rather than globally hand-waved.
- [ ] Subject-substitution section openly resolves the baseline's dangling promise.
- [ ] All §Verification Commands pass; no writes outside `docs/`.

## Dependencies

- (none)

## Interfaces

- Consumes: `docs/AI_CHAT_REDESIGN.md` baseline Scope/Evidence section (read-only); web
  research via WebSearch and WebFetch.
- Produces: `docs/AI_HANDOFF/notes/aichat-research-external.md` — subject substitution +
  Q01–Q22 research ledger, each row with evidence label / URL or query / observed detail /
  applicability. Consumed by TASK-AICHAT-004, TASK-AICHAT-005, and TASK-AICHAT-006.

---

## Discussion

### 2026-09-14 · planner · bao-opus
- **EXECUTOR_AGENT: general-purpose** — this task must run with WebSearch/WebFetch. The
  local-source fact-base executors do not have web tools. This task directly fulfils the
  user's first explicit mandate, so do not downgrade to memory-only research.
- Use primary docs/repositories first: VS Code official docs/API and Microsoft/GitHub docs;
  Cline and Continue official docs/repos; W3C WAI-ARIA APG. Product marketing pages alone
  are not evidence for interaction specifics.
- Research question checklist (all 22 must be addressed):
  1. VS Code Chat UI surface/participant conventions; 2. VS Code Chat participant slash
  commands; 3. VS Code Chat context variables/attachments; 4. VS Code Chat streaming and
  markdown/progress API; 5. VS Code Chat session/history/resume concepts; 6. VS Code webview
  accessibility and workbench theme-color guidance; 7. Copilot composer multiline/send and
  keyboard behavior; 8. Copilot slash commands/command discovery; 9. Copilot @-mentions,
  context attachment and duplicate disambiguation; 10. Copilot streaming/stop/edit acceptance
  presentation; 11. Copilot chat history/session/export/privacy affordances; 12. Cline
  Plan/Act and approve/reject permission UX; 13. Cline activity/timeline/checkpoint/task
  presentation; 14. Cline context attachment/terminal/file/database-relevant boundaries;
  15. Continue slash commands/context providers/@-mentions; 16. Continue model selection/
  roles and provider capabilities; 17. Continue streaming/cancel/error/retry UI; 18. Continue
  sessions/history/data handling; 19. WAI-ARIA APG editable combobox required roles/
  properties; 20. WAI-ARIA listbox keyboard behavior/selection and live announcements;
  21. APG guidance relevant to async results/disabled loading rows/focus retention; 22.
  Cross-product comparative synthesis: what is consistent, what must remain engine-gated,
  and which behaviors are only proposed for UnicDB.
- A `Could-not-verify` answer is correct when sources cannot be reached. Never convert a
  remembered feature into `Verified-with-URL`.
- **BLOCKED(network) terminal state (review round 1):** `Verified-with-URL ≥ 15` is the goal,
  not a fabrication trap. If connectivity blocks the target, end the task with the
  `BLOCKED(network)` marker in the note and `STATUS: BLOCKED(network)` in the Executor
  Report; TASK-AICHAT-006 and PLAN §6 treat that as acceptable. A hard gate with no honest
  exit is what produces invented URLs — forbidden by PLAN §7.
- **Task-budget validator dismissal:** the required CLI path
  `.claude/ukit/index/task-budget-validator.mjs` is absent in this consumer-repo install
  (planner confirmed by directory lookup). Manual audit found all required task fields,
  independent deliverable, concrete 1 happy + 2 distinct edge checks, and a bounded docs-only
  research scope; `ready` is appropriate.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

- **EXECUTOR_TOOL:** Claude Code (Agent tool, general-purpose / internet-research lane)
- **EXECUTOR_MODEL:** `claude-sonnet-5` — inferred from `.ukit/storage/config.json`
  (`defaultModel: claude-sonnet-5`; no separate default-subagent override configured, so the
  general-purpose lane inherits the parent session model). The harness does not expose the
  subagent's own model ID to the executor; this is the best available evidence, not a guess at a
  different model.
- **EXECUTOR_SUBAGENT:** general-purpose (WebSearch/WebFetch-capable lane per Discussion 2026-09-14)
- **Deliverable:** `docs/AI_HANDOFF/notes/aichat-research-external.md` (new, only file written)
- **Worktree:** `.worktrees/task-aichat-003` on branch `handoff/task-aichat-003`
- **Commit:** `40df791 milestone: external research ledger Q01-Q22 with verified primary sources`

### RED_OUTPUT (pre-state, pasted)

`docs/AI_HANDOFF/notes/aichat-research-external.md` did not exist before this turn:

```
=== RED CHECK: note file present? ===
ls: docs/AI_HANDOFF/notes/aichat-research-external.md: No such file or directory
=== RED: run verification cmd 1 ===
MISSING Q01
```

RED confirmed: verification command 1 exits non-zero with `MISSING Q01` before the write.

### Verification Output (pasted full)

```
=== CMD1: Q01-Q22 headings ===
PASS: all 22 headings
=== CMD2: Verified-with-URL >=15 OR BLOCKED(network) ===
Verified-with-URL lines: 25
PASS (exit 0)
=== CMD3: https URLs >=15 ===
https URL lines: 53
PASS (exit 0)
=== CMD4: subjects ===
PASS: all subjects
=== CMD5: substitution ===
PASS
=== CMD6: no TBD/TODO ===
PASS (exit 0)
=== CMD7: docs-only ===
DOCS-ONLY-OK
=== CMD8: typecheck ===

> UnicDB@1.53.46 typecheck
> tsc --noEmit

typecheck-exit=0
```

All 8 §Verification Commands pass.

### Research depth (honest counts)

- **Distinct URLs referenced:** 27 (24 fetched successfully; 3 attempted and recorded as HTTP 404).
- **Q-blocks carrying `Verified-with-URL`:** 23 of 22+1 rows (Q01–Q21 verified at least in part;
  Q22 is a synthesis row built only from fetched pages). Target was ≥15.
- **`Could-not-verify` sub-parts (recorded, not hand-waved):** Q06 webview focus guidance,
  Q07 send/newline keybinding, Q08 Cline `@`-mention path, Q10 (none), Q17 Continue in-IDE
  streaming cancel — each lists the URL/query tried.

### Network status (important, non-BLOCKED)

- **`WebFetch`: WORKING.** Every `Verified-with-URL` row was actually fetched this session.
- **`WebSearch`: NOT returning results.** Both attempted queries returned an empty result block
  (the same failure signature the baseline recorded). Queries tried:
  `"VS Code Chat participant API slash commands documentation code.visualstudio.com"` and
  `"WAI-ARIA APG combobox pattern editable aria-activedescendant requirements"`.
- Because `WebFetch` worked, research continued by fetching known primary doc URLs directly and by
  reading each vendor's `sitemap.xml` (`code.visualstudio.com/sitemap.xml`,
  `docs.cline.bot/sitemap.xml`) to discover correct paths instead of guessing — several initially
  guessed URLs returned 404 and were corrected this way.
- This is **not** a `BLOCKED(network)` terminal state: the ≥15 Verified-with-URL target was met
  with real fetched sources, so no `BLOCKED(network)` marker was written to the ledger.

### Subject substitution

Resolved in the note's `## Subject substitution` section: the baseline's unnamed "three requested
Marketplace extensions" are openly replaced by GitHub Copilot Chat, Cline, Continue + official
VS Code surfaces, plus WAI-ARIA APG. The section states these are comparisons for design reasoning
only and are not claims about, nor reconstructions of, the original unnamed extensions.

### Status: PASS

- [x] Q01–Q22 all answered in the required record format.
- [x] ≥15 `Verified-with-URL` answers (23 Q-blocks; 27 distinct URLs, 24 fetched OK) with direct
      real source pages the executor actually fetched. Not a BLOCKED(network) cycle.
- [x] All five named subjects covered; comparative observations trace to composer, commands/context,
      streaming, sessions, approvals/timeline, accessibility.
- [x] Web/tool failures recorded per question (Q06, Q07, Q08, Q17) rather than globally hand-waved.
- [x] Subject-substitution section present and resolves the baseline's dangling promise.
- [x] All §Verification Commands pass; no writes outside `docs/`.

### Note

`WebSearch` is non-functional in this lane (empty result blocks) while `WebFetch` works; the note
records this explicitly so downstream tasks (TASK-AICHAT-004/005/006) do not mistake the absent
search results for a network outage. Highest-value comparators for the final spec: VS Code's
**Stop and Send / Steer / Queue** run-turn model (Q10), Cline's **Checkpoint / Compare / Restore**
timeline (Q13) and per-tool-call approval matrix (Q12), Continue's **role-vs-model** split (Q16),
and the APG's focus-retention plus `aria-disabled`-for-discoverability guidance (Q21).
