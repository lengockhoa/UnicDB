# PLAN — Cycle AGT-CLEANUP-2: 12 queued minor cleanups from cycles AGT + AGT-UI

## §1 Intent

**Problem:** Reviewer verdict blocks in cycles AGT / AGT-UI (TASK-004/007/009/013/014, all
`approved_minor`) queued 12 cleanup findings that were explicitly deferred: stale comments
that contradict R4.5 behavior, dead export aliases, smoke-helper dead code, and one
duplicated helper pair across webview files. Left in place, the stale comments will cause a
future maintainer to delete live error-path code (the reviewers say so verbatim), and the
duplicated `renderMarkdown`/`escapeHtml` keeps two diverging copies of the webview's
security-critical escape-then-replace contract.

**Success looks like:** all 12 findings resolved on `main` with zero behavior change except
the two smoke-helper contracts that must newly fail fast on spawn error; full suite +
typecheck + compile green; no version bump / release (gộp vào cycle
lớn tiếp theo per user).

**Planner grounding corrections (verified against working tree @ 1be70f7 — where the caller's
triage and the source disagreed, the source won):**
- Item #1 (policy.ts:16-18 stale `("builtin" | "omp")` comment) — **already landed** in
  commit 93746a4 ("R4.5 round 3", TASK-012 ride-along, exactly as TASK-007's NOTES
  predicted). Line 14 now reads `AiEngine` = "builtin" | "omp" | "claude-code" | "codex".
  Remaining work: a grep re-verification pinned inside TASK-CLEAN2-001's acceptance.
- Item #2 (claudeCodeChatEngine send comment) — **partially landed** in 93746a4: the false
  "resolves (never throws) on crash" text is gone, but the current comment (lines 254-259)
  still calls the catch "a defensive last line" — the exact framing the reviewer rejected,
  since R4.5's `failTurn` (claudeCodeProcess.ts:827-855, `if (reject !== null) reject(err)`)
  makes the catch the **live error path** on every turn crash. TASK-CLEAN2-003 finishes it.
- Item #4 has a third stale spot the caller's triage missed: the case-4 test NAME at
  commitGenManifest.test.ts:134 says "pre-existing 54 ids" while the :11 comment says 56.
  All three (#4 comment, #4 test name, TASK-013's queued `PRE_EXISTING_COMMAND_IDS` →
  `LOCKED_COMMAND_IDS` rename) are one file-local cleanup in TASK-CLEAN2-006.
- Item #12 remains strictly limited to the caller-named `escapeHtml` and `renderMarkdown`
  pair. The separately duplicated file-local `unescapeHtml` helpers are deliberately left
  untouched because the caller fixed this cleanup cycle to exactly 12 items.

## §2 Scope

**In-scope (exactly the 12 items, plus the two bounded extensions above):**

| # | Item | File(s) | Task |
|---|------|---------|------|
| 1 | stale configuredEngine vocab comment | src/ai/policy.ts | ALREADY LANDED — re-verify in TASK-CLEAN2-001 |
| 2 | "defensive last line" send comment (finish reword) | src/ai/claudeCode/claudeCodeChatEngine.ts:254-259 | TASK-CLEAN2-003 |
| 3 | "fire onError twice" dedupe comment | src/ai/claudeCode/claudeCodeChatEngine.ts:210-212 | TASK-CLEAN2-003 |
| 4 | "pre-existing 56"/"54" comment + test name + `LOCKED_COMMAND_IDS` rename | src/ui/__tests__/commitGenManifest.test.ts:11,37,134 | TASK-CLEAN2-006 |
| 5 | mcpBridge unref "race with accept()" phantom-race doc bullet | docs/AI_HANDOFF/tasks/TASK-004.md:95 | TASK-CLEAN2-006 |
| 6 | "no prompt / --verbose unnecessary" smoke header+inline comments | src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts:3-7,32-37 | TASK-CLEAN2-004 |
| 7 | `_LegacyDetectionTypes` dead type export | src/ai/engineChoice.ts:206-208 | TASK-CLEAN2-002 |
| 8 | `isValidEngineChoice` dead alias (internal caller at :154) | src/ai/policy.ts:133-135,154 | TASK-CLEAN2-001 |
| 9 | `child.once("error", reject)` dead code (resolve settles first) | src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts:65-69 | TASK-CLEAN2-004 |
| 10 | same dead-code pattern, Codex smoke | src/ai/codex/__tests__/codexLiveSmoke.test.ts:57-66 | TASK-CLEAN2-005 |
| 11 | "gate disabled" tautological test → pin-the-gate-name semantics (both files) | both `*LiveSmoke.test.ts` | TASK-CLEAN2-004 + TASK-CLEAN2-005 (own file each) |
| 12 | dedup `renderMarkdown`/`escapeHtml` → `webview/markdownSafe.ts` (new) | webview/aiChatPanelMain.ts, webview/aiChatPanelThread.ts, webview/__tests__/aiChatPanelThread.test.ts | TASK-CLEAN2-007 |

**Out of scope (deferred, do NOT touch):**
- Everything else in the AGT-UI TASK-004 disposition queue: `AgentChatEngine` extraction,
  `dispatchNotification` outer guard, `tool_call_update` isError ledger, `summarizeArgs`
  newline escaping, hostMcp port-0 url getter, mcpExtensionRegistry copy/hoist findings,
  TASK-004.md:161-172 INDEX-row bookkeeping.
- `src/ui/aiChatPanel.ts` engine routing (AGT-UI invariant), element-id contract, any
  version bump / GitHub Release / Marketplace publish.

**CONSTRAINT honored:** no two same-wave tasks modify the same file — all 7 tasks own
disjoint file sets (§3 wave table).

## §3 Approach

**Comment/doc fixes (#2, #3, #4, #5, #6, #11-rename):** edit only comment lines / test
names / a module-private const name. Verification is post-change read + grep-zero for the
stale phrase + existing suites green. No new test files — per user constraint, no tests for
tests' sake; the TDD tables below use regression + grep/consistency edges honestly labeled.

**Dead-code removals (#7, #8):** before deletion, record repository/public-consumer evidence.
The pre-change `isValidEngineChoice` search returns exactly policy.ts's alias comment (:133),
alias (:135), and caller (:154); `_LegacyDetectionTypes` returns only its definition at
engineChoice.ts:208. Neither name appears in README/public docs (the handoff record excluded),
and package.json has no `exports`, `types`, or `typings` field—only runtime
`main: "dist/extension.js"`. Therefore neither source module is a supported published
TypeScript entry point, so delete the private alias (fix policy.ts:154 to call
`isEngineChoice`) and the marker type export; `ClaudeCodeDetection`/`CodexDetection` imports
stay consumed by `projectAgent()`'s signature. If this evidence changes during execution,
retain the export with `@deprecated` JSDoc rather than silently break an external consumer.
No runtime surface changes; proven by existing suites + `npm run typecheck` + grep-zero.
TDD RED is not achievable for private-alias/type-export deletion (no observable runtime
delta) — recorded in the task Discussions instead of faking a RED output.

**Smoke-helper contracts (#9, #10):** in each smoke file, capture the spawn error into a
closure cell; `awaitFirstEvent` checks the cell at entry and inside its 25ms interval tick
and rejects immediately on spawn error (reviewer's option B, keeping the existing probe
shape). Add a NON-gated describe in the same file driving the helpers against a hermetic nonexistent binary
(`unicdb-smoke-missing-binary`) — default env never spawns a real binary, so the TASK-014
gate contract is preserved. Fail-fast test is genuine RED→GREEN (today ENOENT burns the
30s timeout); the separate timer edge uses `vi.useFakeTimers()` only to prove the existing
first-event polling path resolves without waiting for its 30s timeout.

**Dedup (#12):** create `webview/markdownSafe.ts` exporting only `escapeHtml` and
`renderMarkdown` (thread.ts's copy of `renderMarkdown` is the canonical body — both current
bodies verified functionally identical including the `data-raw="${escapeHtml(f.code)}"`
fence contract); `aiChatPanelThread.ts` imports `escapeHtml` and `renderMarkdown`, then
uses `export { renderMarkdown };` for compat; `aiChatPanelMain.ts` imports both and drops
its two local copies (usages at :1289, :1369
unchanged); `aiChatPanelThread.test.ts` imports from `../markdownSafe`; new
`webview/__tests__/markdownSafe.test.ts` pins the escape table and the markdown subset
through the public `renderMarkdown` contract. No esbuild config change (markdownSafe is a
bundled import, not an entry point — verified entryPoints list).

**Wave plan (all `Dependencies: none` — every task owns a disjoint file set):**

| Wave | Tasks | Files owned |
|------|-------|-------------|
| 1 (7 parallel) | 001 policy.ts · 002 engineChoice.ts · 003 claudeCodeChatEngine.ts · 004 claudeCodeLiveSmoke · 005 codexLiveSmoke · 006 TASK-004.md + commitGenManifest.test.ts · 007 markdownSafe + 2 webview consumers + thread test | disjoint |

Wave-boundary regression net: full `npm test` + `npm run typecheck` + `npm run compile`
after the wave.

**Alternatives rejected:** (a) shared smoke-probe module for #9/#10 — rejected, it would
couple 004 and 005 into a dependency chain for ~40 duplicated lines; per-file fixes keep
the wave flat. (b) Re-export-only dedup for #12 (thread re-exports everything, main keeps
copies) — rejected, leaves the duplication the finding exists to remove. (c) Fixing the
policy.ts comment again — rejected, already correct at HEAD (§1).

## §4 Test Plan

Comment-only tasks: regression rows + concrete grep/consistency edges (expected values
stated; a grep that returns 0 CAN fail against today's tree — e.g. `isValidEngineChoice`
currently returns 3). Code tasks: genuine RED→GREEN or contract-pinning tests as below.

| Type | Test Name | Expected |
|------|-----------|----------|
| regression (001) | policy.test.ts `isEngineChoice — TASK-007 four-engine vocabulary guard` | passes UNMODIFIED (4 valid true; "unknown"/null/{} false) |
| edge (001, consumer-check) | repository `isValidEngineChoice` search + package entry-point fields | pre-change source results are exactly policy.ts :133 comment, :135 alias, :154 caller; `exports`/`types`/`typings` absent and `main` = `dist/extension.js`, so safe internal deletion |
| edge (001, grep) | `grep -c "isValidEngineChoice" src/ai/policy.ts` | 0 (today: 3 — fails before fix) |
| edge (001, doc-consistency) | `grep -cE '"builtin" \| "omp"\)' src/ai/policy.ts` (stale two-value claim) | 0 (item #1 stays landed; the literal string appears only inside the four-value header, where the trailing `)` distinguishes it) |
| regression (002) | engineChoice.test.ts full file | passes UNMODIFIED (projectAgent surface intact) |
| edge (002, consumer-check) | repository `_LegacyDetectionTypes` search + README/docs + package entry-point fields | pre-change source result is only engineChoice.ts:208; README/public docs are 0; `exports`/`types`/`typings` absent and `main` = `dist/extension.js`, so not a supported public type API |
| edge (002, grep) | `grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts` | 0 (today: 1 — the export at :208; the comment at :206-207 uses the wording "Legacy detection types" without the identifier) |
| edge (002, typecheck) | `npm run typecheck` | exit 0 — Detection types still resolve via projectAgent signature |
| regression (003) | claudeCodeChatEngine.test.ts + claudeCodeProcess.test.ts | 15 pass / 0 fail, unmodified |
| edge (003, doc-consistency) | grep for "defensive last line" and "fire onError twice" in engine file | both 0 after fix; diff touches comment lines only |
| regression→RED→GREEN (004) | `spawn error surfaces fast (missing binary)` | awaitFirstEvent rejects with spawn error in <5s wall (today: rejects "timed out after 30000ms" only after 30s → RED) |
| edge (004, timer) | `awaitFirstEvent resolves while the 30s timeout is still pending` (fake timers) | resolves the pushed event at the first tick; pinning the pending-timer state the fix is allowed to leave or clear, not invent behavior beyond #9 | fixture events |
| edge (004, doc-consistency) | header + inline comment grep | "no prompt", "never hitting the model API", "--verbose is unnecessary" all 0; comment states `--print ping` reaches the model non-mutatingly |
| edge (004, gate rename) | renamed gate test pins `UnicDB_CLAUDE_CODE_SMOKE` literal via shared `GATE_ENV` const | `GATE_ENV === "UnicDB_CLAUDE_CODE_SMOKE"`; no "suite skipped when" overclaim |
| regression (004/005) | gated describe under default env | vitest reports it skipped (1 skipped per suite); zero real-binary spawns |
| happy (005) | existing codexLiveSmoke suite after companion-test clarity rename | default-env run passes its non-gated helpers and reports 1 gated skip under `UnicDB_CODEX_SMOKE`; no real binary spawns |
| edge (005, RED→GREEN) | `spawn error surfaces fast (missing binary)` | closure-held ENOENT makes `awaitFirstEvent` reject within ~30ms / <5s; today it burns 30s then rejects timeout |
| edge (005, timer) | fake-timer first-event polling | a fixture event pushed at the first 25ms tick returns exactly that event while the 30s timeout remains pending (out of scope to clear) |
| edge (005, gate semantics) | renamed companion gate test + default-env Vitest report | `GATE_ENV` is non-empty `"UnicDB_CODEX_SMOKE"`; run reports exactly 1 skipped when unset |
| edge (005, stdin preservation) | file-local argv/stdin contract checks | `exec --json - --cd <workspace>`, `child.stdin.write("ping\\n")`, and `.end()` remain present; test inputs unchanged |
| happy (007) | markdownSafe.test.ts `renders the pinned markdown subset` | `**b**`→`<strong>b</strong>`; `` `c` ``→`<code>c</code>`; `## x`→`<h2>x</h2>`; `### y`→`<h3>y</h3>`; fence→`<pre class="UnicDB-md-code" data-raw="…">…<button … class="UnicDB-md-copy">Copy</button></pre>` |
| edge (007, escaping/XSS) | `escapeHtml maps the five metacharacters` + hostile markdown | `& < > " '` → `&amp; &lt; &gt; &quot; &#39;`; `<img src=x onerror=…>`/`"><script>` render inert text, zero live nodes |
| edge (007, boundary) | `fenced data-raw encoding` | fence code containing `<>&"'` yields an escaped `data-raw` value and trims exactly one trailing fence newline, preserving the current rendered-output contract |
| regression (007) | aiChatPanelThread.test.ts (import updated) + aiChatPanel.test.ts | both pass with ZERO assertion changes; thread pinned cases (:186, :360-367) green |
| happy (006) | commitGenManifest.test.ts full suite | passes with locked command-id values/assertions unchanged |
| edge (006, stale text) | `grep -cE "pre-existing" src/ui/__tests__/commitGenManifest.test.ts` | 0, removing the stale 56/54 claims and remaining same-file stale claim |
| edge (006, identifier) | `grep -c "PRE_EXISTING_COMMAND_IDS" src/ui/__tests__/commitGenManifest.test.ts` | 0 after rename to `LOCKED_COMMAND_IDS` |
| edge (006, phantom-race docs) | `grep -c "unref() can race with accept()" docs/AI_HANDOFF/tasks/TASK-004.md` | 0; only the false queued-action bullet is disposed, adjacent findings remain |
| regression (all) | full `npm test` at wave boundary | 0 failed (baseline 3743+ tests / 2 smoke skips may grow by new non-gated passes) |

## §5 Verification

Project scripts (package.json, verified): `test` = vitest run · `typecheck` = tsc
--noEmit · `compile` = node esbuild.js · **no lint script exists — lint is N/A for every
task; stated here once instead of silently omitted** (verified per RULES §Phase-2).

Per-task narrowed commands (tests-map.json resolution noted in each task file; files
missing from the map use the neighbouring-test convention, floor never empty):

```bash
# 001 — record pre-change consumer/API evidence, then narrow suite + post-change checks
grep -rn "isValidEngineChoice" --include="*.ts" --include="*.tsx" src/ webview/ tests/
node -p "JSON.stringify({exports: require('./package.json').exports ?? '<absent>', main: require('./package.json').main ?? '<absent>', types: require('./package.json').types ?? '<absent>', typings: require('./package.json').typings ?? '<absent>'})"
npx vitest run src/ai/__tests__/policy.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts
test "$(grep -c "isValidEngineChoice" src/ai/policy.ts || true)" -eq 0
test "$(grep -cE '"builtin" \| "omp"\)' src/ai/policy.ts || true)" -eq 0
# 002 — record pre-change consumer/docs/API evidence, then narrow suite + post-change check
grep -rn "_LegacyDetectionTypes" --include="*.ts" --include="*.tsx" src/ webview/ tests/
grep -rn "_LegacyDetectionTypes" README.md docs/ --exclude-dir=AI_HANDOFF || true
node -p "JSON.stringify({exports: require('./package.json').exports ?? '<absent>', main: require('./package.json').main ?? '<absent>', types: require('./package.json').types ?? '<absent>', typings: require('./package.json').typings ?? '<absent>'})"
npx vitest run src/ai/__tests__/engineChoice.test.ts
test "$(grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts || true)" -eq 0
# 003 — narrowed
npx vitest run src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts
# 004/005 — the test files under fix are their own tests (hermetic non-gated additions)
npx vitest run src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts
UnicDB_CODEX_SMOKE= npx vitest run src/ai/codex/__tests__/codexLiveSmoke.test.ts  # expect: 1 skipped
grep -qF '"exec",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF '"--json",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF '"-",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF '"--cd",' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF 'child.stdin.write("ping\n")' src/ai/codex/__tests__/codexLiveSmoke.test.ts
grep -qF 'child.stdin.end()' src/ai/codex/__tests__/codexLiveSmoke.test.ts
# 006 — self-testing manifest suite + post-change stale-text / identifier / doc checks
npx vitest run src/ui/__tests__/commitGenManifest.test.ts
test "$(grep -cE "pre-existing" src/ui/__tests__/commitGenManifest.test.ts || true)" -eq 0
test "$(grep -c "PRE_EXISTING_COMMAND_IDS" src/ui/__tests__/commitGenManifest.test.ts || true)" -eq 0
test "$(grep -c "unref() can race with accept()" docs/AI_HANDOFF/tasks/TASK-004.md || true)" -eq 0
# 007 — new + updated webview suites + bundle
npx vitest run webview/__tests__/markdownSafe.test.ts webview/__tests__/aiChatPanelThread.test.ts src/ui/__tests__/aiChatPanel.test.ts
npm run compile
# every task, plus the wave boundary
npm run typecheck
npm test
```

## §6 Acceptance

- [ ] All 12 findings resolved (item #1 accepted as already-landed with grep
      re-verification in TASK-CLEAN2-001) — trace: #1→001, #8→001, #7→002, #2+#3→003,
      #6+#9+#11→004, #10+#11→005, #4+#5→006, #12→007.
- [ ] Before #7/#8 deletion, repository consumer searches and package public-entry-point
      fields match the documented internal-only evidence; otherwise retain a deprecated
      compatibility export instead — trace: TASK-CLEAN2-001/002.
- [ ] Every task's §Test Cases green, including the two genuine RED→GREEN smoke
      contracts (fail-fast spawn error), Codex's one-skip/nonempty-gate result, and retained
      Codex argv/stdin source contract — trace: TASK-CLEAN2-004/005.
- [ ] TASK-CLEAN2-006's suite passes with every `pre-existing` phrase,
      `PRE_EXISTING_COMMAND_IDS`, and `unref() can race with accept()` returning zero
      matches — trace: TASK-CLEAN2-006.
- [ ] `npm run typecheck` exit 0 after every task; `npm test` 0 failed at wave boundary;
      `npm run compile` green (mandatory for 007, run at boundary for all).
- [ ] Zero assertion changes in existing test files (006 renames an identifier + test
      name with values unchanged; 007 updates one import path).
- [ ] No behavior delta outside the two smoke-helper contracts: `git diff` for 001/002/003
      shows comment/identifier-only changes.
- [ ] Engine dispatch (`src/ui/aiChatPanel.ts`), element ids, and the no-credentials /
      no-dangerous-flags wire rules untouched.
- [ ] Every task reviewed by a model different from its executor; no version bump, no
      release, no push beyond the cycle's wave commits.

## §7 Global Constraints (inherited by every TASK-CLEAN2-xxx.md by reference)

- Cleanup-only: any change not in §2's table (plus its two named extensions) is deferred.
- `npm` only (never yarn). Scripts: `npm run typecheck`, `npm test`, `npm run compile`.
- No lint script exists in package.json — "lint: N/A" is the documented state.
- Engine dispatch in `src/ui/aiChatPanel.ts` must remain unchanged.
- Element-id compatibility contract holds — no pinned id renamed/removed.
- Never pass `--dangerously-skip-permissions`, `apiKey`, or DB credentials on any wire
  frame; smoke tests never invoke a real binary unless `UnicDB_CLAUDE_CODE_SMOKE=1` /
  `UnicDB_CODEX_SMOKE=1` is explicitly set.
- Comments rewritten in this cycle must cite verified anchors (file:line verified at
  HEAD 1be70f7) — no new plausible-looking citations.
- No bump-version, no GitHub Release, no Marketplace publish for this cycle.
- Line-level rule for comment fixes: `git diff` must show comment/whitespace/identifier
  lines only (except tasks 004/005/007 which have scoped code deltas).

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (a) discovered item #1 already landed (93746a4) — demoted to
grep re-verification inside TASK-CLEAN2-001 instead of a fake edit; (b) Round-2 review
required public-consumer evidence for #7/#8, so added exact pre-change source, README/public
docs, and package entry-point checks to TASK-CLEAN2-001/002; deletion is conditional on their
recorded internal-only results, otherwise the task preserves a deprecated compatibility name;
(c) Round-2 required self-contained Codex semantics, so TASK-CLEAN2-005 now enumerates its
happy path, ENOENT fail-fast, timer, one-skip gate, and argv/stdin edges with source checks;
(d) Round-2 required explicit #4/#5 verification, so TASK-CLEAN2-006 now pins its happy path
and distinct identifier/stale-text/phantom-race zero-match checks; (e) discovered item #2
partially landed — TASK-CLEAN2-003 rescoped to the remaining "defensive last line" framing;
(c) added the third stale spot of #4 (test name "pre-existing 54" at :134) + the
TASK-013-queued LOCKED_COMMAND_IDS rename to TASK-CLEAN2-006 — both inside the cited
sources for #4; (d) two earlier drafts had folded in extra TASK-014 sub-findings (30s
success-timer never cleared; Codex header wording) and the duplicated `unescapeHtml` —
REMOVED from scope during this audit because the user fixed the cycle to exactly 12 items;
they are recorded as Known gaps (3) and as out-of-scope notes in the 004/005/007 task
Discussions instead; (e) rewrote 004/005 test tables as genuine RED→GREEN using a hermetic
missing-binary spawn.

Known gaps: (1) TDD RED is not producible for pure comment fixes and private-alias/
type-export deletions (#2,#3,#4,#5,#6,#7,#8) — those tasks carry regression + concrete
grep-zero/doc-consistency edges whose expected values fail against today's tree instead;
#7/#8 additionally record a repository/public-surface check because local typecheck cannot
prove downstream compatibility;
documented in each task's Discussion. (2) tests-map.json has no entry for
claudeCodeChatEngine.ts — TASK-CLEAN2-003 uses its direct neighbour suites (15 tests,
verified present) rather than the map. (3) Two adjacent TASK-014 sub-findings were
deliberately left out to honor the fixed 12-item scope and should ride the next cleanup
cycle: the never-cleared 30s setTimeout in both awaitFirstEvent helpers, and the
duplicated file-local unescapeHtml helpers (both explicitly recorded in TASK-CLEAN2-004/005/
007 Discussion as out-of-scope, no silent half-fixes).

## Plan Review Log

### Round 2 — revised
- Addressed Finding 1 in TASK-CLEAN2-006: made its happy-path and three distinct edge checks
  explicit; added executable zero-match checks and acceptance criteria for every
  `pre-existing` phrase, `PRE_EXISTING_COMMAND_IDS`, and the exact TASK-004 phantom-race text.
- Addressed Finding 2 in TASK-CLEAN2-005: replaced the ambiguous mirror row with the complete
  Codex happy path plus ENOENT fail-fast, timer, one-skip/nonempty-gate, and preserved
  argv/stdin contract assertions; added matching source-contract verification commands.
- Addressed Finding 3 in TASK-CLEAN2-002: recorded the actual source-consumer result (only
  engineChoice.ts:208), zero README/public-doc mentions, and package entry-point fields
  (`exports`/`types`/`typings` absent; runtime `main` only). Deletion now falls back to a
  `@deprecated` compatibility export if execution discovers different consumer evidence.
- Addressed Finding 4 in TASK-CLEAN2-001: recorded the actual three-site policy-only consumer
  result and the same package entry-point evidence. The task retains a deprecated alias rather
  than deleting if that evidence no longer holds.
- PLAN §3–§6 now trace these checks, TASK-CLEAN2-005's self-contained smoke semantics, and
  TASK-CLEAN2-006's concrete documentation/identifier verification. All statuses remain
  `ready`; INDEX.md and ACTIVE.md require no state change.


## Plan Review Log

### Round 1 — Issues Found
- Verdict: Issues Found
- Findings:
  - §4: TASK-CLEAN2-006 has no happy-path or two edge-case rows and no explicit post-change read/grep checks for the `pre-existing 56`/`54` text, `PRE_EXISTING_COMMAND_IDS` rename, or TASK-004 phantom-race bullet. Its sole narrowed suite command in §5:160-161 cannot verify those documentation and identifier edits; add concrete zero-match/read checks and acceptance criteria.
  - §4:136 describes TASK-CLEAN2-005 only as a “mirror of 004’s three rows,” although TASK-CLEAN2-004 has additional timer, comment, gate-name, and default-gate rows at §4:131-135. This leaves the Codex task’s required happy path and two edges indeterminate; enumerate its exact test cases, including which smoke-gate semantics and stdin-preservation assertions run.
  - §3:73-78 plans removal of exported `_LegacyDetectionTypes` without a repository/public-package consumer check. Type-only exports are still a TypeScript compile-time API, so local typecheck cannot catch an external import failure; require evidence that it is non-public or unused by supported consumers, or retain/deprecate it.
  - §3:73-78 and §4:124 require only a file-local grep for `isValidEngineChoice`; they do not establish that `policy.ts:154` is its sole consumer. Add a repository-wide/public API consumer check before deleting the alias, so a cross-module or downstream caller is not broken.

NOTES: §§1-6 are present, item #1 is correctly treated as already landed with re-verification only, and the Wave 1 target sets and prescribed two-agent batches are disjoint. The configured P2.5 reviewer tier is `unic-smart`, matching the planner tier; this is the documented acceptable no-second-Opus compromise.

### Round 2 — 2026-09-08 · unic-smart
Status: Issues Found

Round 1 findings verification:
- Finding 1 (006 missing verification) — RESOLVED. Test Cases now has 5 rows: happy regression, identifier grep, stale-text grep, phantom-race docs grep, docs-scope regression. Verification Commands include all three greps with `-eq 0` assertions. Verified against tree: `pre-existing` = 3, `PRE_EXISTING_COMMAND_IDS` = 2, `unref() can race with accept()` = 1 — all genuine failing-before checks.
- Finding 2 (005 ambiguous mirror) — RESOLVED. Test Cases now self-contained with 5 rows: happy regression, ENOENT RED→GREEN, fake-timer, gate semantics (`UnicDB_CODEX_SMOKE`), stdin preservation. All 6 argv/stdin greps verified matching current file.
- Finding 3 (`_LegacyDetectionTypes` evidence) — RESOLVED with minor factual error. Repo-wide grep (only :208), README/docs (0), package.json (no exports/types/typings, main=dist/extension.js) all verified. Disposition (delete + `@deprecated` fallback) justified. But "today: 2" is wrong — actual count is 1 (comment at :206-207 lacks the identifier). Check still fails-before (1≠0), so non-blocking.
- Finding 4 (`isValidEngineChoice` evidence) — RESOLVED. Repo-wide grep returns exactly the 3 policy.ts sites (:133/:135/:154), package.json fields verified. Disposition justified.

New issues:
- important: TASK-CLEAN2-001 row 4 + Verification Commands `grep -cE '"builtin" \| "omp"' src/ai/policy.ts` → 0 can NEVER pass. The pattern matches the correct four-value header line 14 (`AiEngine` = "builtin" | "omp" | "claude-code" | "codex" —), returning 1 today and 1 after the fix. The stale two-value claim it targets no longer exists as a standalone phrase. Fix: use `grep -cE '"builtin" \| "omp"\)'` (verified returns 0 today) or `grep -cE '"builtin" \| "omp"[^|]'`. Same defect in PLAN.md §4:134 and §5:176.
- minor: TASK-CLEAN2-002 row 3 + Discussion + PLAN.md §4:137 claim "today: 2" for `_LegacyDetectionTypes`; actual count is 1. Correct the expected pre-state.
- minor: TASK-CLEAN2-006 Target Files says "replace reviewer bullet :95's false action" but the reviewer bullet is at TASK-004.md:201; :95 is the original finding body. The grep-zero check correctly matches BOTH locations (verified), so the check is sound — only the prose misidentifies the line.

COMPLETENESS: all 6 sections present; all 4 revised tasks have full Task Gate fields.
CONSISTENCY: revisions consistent with PLAN.md §3/§4/§5 except the two "today: 2" claims and the grep pattern defect above.
CLARITY: 005 self-contained (no "see 004" in test cases); 006's :95/:201 conflation is a prose nit.
SCOPE: no creep beyond the 12 items; `@deprecated` fallback is conditional disposition, not new behavior.
YAGNI: fake-timer and stdin-preservation edges justified by the cited items.
WAVE: all 7 tasks own disjoint file sets — verified no same-wave file sharing.

NOTES: Round 1 findings all addressed. One important defect (the `"builtin" | "omp"` grep can never pass) must be fixed before execution; two minor factual/prose errors should be corrected. Per loop cap, apply these directly without a third review round.

### Round 3 — findings applied without re-review (loop cap reached)
Per RULES, after round 2 returned Issues Found the planner applied every outstanding finding directly. No third review.

- **Important — fixed:** TASK-CLEAN2-001 row 4 + Verification Commands + PLAN.md §4:134 / §5:176 — replaced the perpetually-failing `grep -cE '"builtin" \| "omp"'` with `grep -cE '"builtin" \| "omp"\)'` (verified returns 0 today; matches only the trailing-`)` form that does NOT appear in the corrected four-value header at line 14).
- **Minor — fixed:** TASK-CLEAN2-002 row 3 + PLAN.md §4:137 — corrected "today: 2" → "today: 1 (only :208; the comment at :206-207 uses 'Legacy detection types' without the identifier; check still fails-before)".
- **Minor — fixed:** TASK-CLEAN2-006 Target Files + row 5 — corrected "reviewer bullet :95" → "reviewer bullet :201" (line :95 is the original finding body; :201 is the disposition line in the reviewer verdict block, which is what gets reworded).

Final verification (all three fixes pass against HEAD `1be70f7`):
- `grep -cE '"builtin" \| "omp"\)' src/ai/policy.ts` → 0 ✓
- `grep -c "_LegacyDetectionTypes" src/ai/engineChoice.ts` → 1 ✓
- `sed -n '201p' docs/AI_HANDOFF/tasks/TASK-004.md` → reviewer bullet line, ready for reword ✓

PLAN_REVIEW: Approved (loop-cap direct-apply) by round-2 reviewer (unic-smart)
