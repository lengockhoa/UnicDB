# TASK-CHATUX-003 — W3 message visual system: code-block header+Copy, collapsed tool/thinking rows, visible actions, compact user card

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (W3)
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-005, FR-006, §8.2, §8.4, §8.5

## Goal

Rebuild the message visual system: every fenced code block gets a header bar (language label + Copy button with 1500ms `Copied`/`Failed` feedback), tool and reasoning items become collapsed-by-default 28–32px disclosure rows, the message action row is visible at rest (remove the `opacity: 0` hover gate — the reported "no copy button"), and the user prompt card shrinks to 70%/6x10 padding.

## Target Files

- `webview/aiChat/markdown.ts` — `createCodeBlock` (~155-169) returns a `-codeblock` wrapper div with `-codeblock-header` (lang span + `-codeblock-copy` button) around the existing `pre.UnicDB-ai-chat-v2-code`; copy handler per SPEC FR-005 (frozen labels `Copy`/`Copied`/`Failed`, 1500ms restore, clipboard-missing safe).
- `webview/aiChat/transcript.ts` — tool items created with `data-collapsed="1"` + `aria-expanded="false"` (~347-358); reasoning items gain a `-reasoning-toggle` disclosure button, default collapsed (same pattern as tool toggle).
- `webview/aiChat/styles.css` — new `-codeblock`/`-codeblock-header`/`-codeblock-lang`/`-codeblock-copy`/`-reasoning-toggle` rules; inner `-code` override (`margin:0; border:0; padding:10px 12px; line-height:1.5`); `-item-user` → `max-width:70%; padding:6px 10px`; `-tool-head` `min-height:28px`; remove `opacity: 0` from `-action` (~847) and delete the hover/focus reveal rule (~851-855).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `sql fence renders codeblock wrapper with header, lang label and Copy` | `renderMarkdownInto` output contains `.UnicDB-ai-chat-v2-codeblock` > `-codeblock-header` > `-codeblock-lang` ("sql") + `-codeblock-copy` button; inner `pre.UnicDB-ai-chat-v2-code` preserved | `createCodeBlock({lang:"sql",code:"select 1"})` |
| 2 | edge (empty) | `fence without language renders "text" label and -plain code class` | header label `text`; `code.UnicDB-ai-chat-v2-code-plain`; no `data-lang` on wrapper | `createCodeBlock({lang:"",code:"ls"})` |
| 3 | edge (error) | `clipboard rejection shows Failed then restores Copy` | click → `writeText` rejects → button text `Failed`; after 1500ms (fake timers) → `Copy`; no throw | stub `navigator.clipboard.writeText` rejecting |
| 4 | edge (state) | `tool and reasoning items start collapsed` | tool root `data-collapsed="1"`, toggle `aria-expanded="false"`; reasoning item has `-reasoning-toggle` + `data-collapsed="1"` | seeded tool + reasoning transcript items |
| 5 | edge (CSS contract) | `action row is visible at rest` | styles.css `-action` rule has no `opacity: 0`; no `:hover … -action`/`focus-within` reveal rule remains | readFileSync styles.css |

## Test Files

- `webview/aiChat/__tests__/codeBlock.test.ts` — NEW: rows 1–3.
- `webview/aiChat/__tests__/transcript.test.ts` — extend: row 4.
- `webview/aiChat/__tests__/messageActions.test.ts` — extend: row 5 + keep existing copy-path tests green.

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/codeBlock.test.ts webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/messageActions.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (rows 1–5 RED before the change where applicable).
- [ ] `grep -n "opacity: 0" webview/aiChat/styles.css` → no hit inside the `-action` rule; no hover-reveal rule remains.
- [ ] No `innerHTML` introduced (source scan — createElement/textContent only).
- [ ] No regression in related suites (`npx vitest run webview/aiChat/__tests__/`).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CHATUX-001 must complete first (both edit `webview/aiChat/styles.css`).

## Interfaces

- Consumes: TASK-CHATUX-001's stabilized layout contract (normal document flow — the `-codeblock` wrapper relies on it).
- Produces: `createCodeBlock` returns the `-codeblock` wrapper (was: bare `pre`); frozen classes `-codeblock`, `-codeblock-header`, `-codeblock-lang`, `-codeblock-copy`, `-reasoning-toggle`; tool/reasoning items default `data-collapsed="1"`.

---

## Discussion

### 2026-09-21 · planner · unic-smart
The "no copy button" report is a CSS defect, not missing wiring: `buildActions` (transcript.ts:281-285) already appends a copy button per assistant message — `opacity: 0` (styles.css:847) hides it until hover. Fix = always-visible muted actions. Code-block copy mirrors the proven V1 `UnicDB-md-copy` pattern (markdownSafe.ts:75) but in pure-DOM style with label feedback instead of a toast.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
## Executor Report

- EXECUTOR_TOOL: omp (Oh My Pi)
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: ExecT003
- Status: PASS

### RED_OUTPUT (before implementation)

```
❯ webview/aiChat/__tests__/codeBlock.test.ts  (7 tests | 6 failed)
  → #1 expected the -codeblock wrapper: expected null not to be null
  → #2 expected 'UnicDB-ai-chat-v2-code' to be 'UnicDB-ai-chat-v2-codeblock'
  → #3/success/missing/rapid: expected a codeblock Copy button: expected null not to be null
❯ webview/aiChat/__tests__/transcript.test.ts  (28 tests | 4 failed)
  → tool items start collapsed: expected null to be '1'
  → reasoning items start collapsed: expected null to be '1'
  → user bubble 70%: expected '…max-width: 78%…' to contain 'max-width: 70%'
  → action visible at rest: expected '…opacity: 0…' not to contain 'opacity: 0'
❯ webview/aiChat/__tests__/messageActions.test.ts  (9 tests | 1 failed)
  → #9 CSS contract: expected '…opacity: 0…' not to contain 'opacity: 0'
Test Files  3 failed (3) · Tests  11 failed | 33 passed (44)
```

### Implementation

- `webview/aiChat/markdown.ts` — `createCodeBlock` now returns the
  `-codeblock` wrapper div (`data-lang` moved from `pre` to wrapper, absent
  for empty lang) containing `-codeblock-header` (`-codeblock-lang` label,
  `text` fallback) + `-codeblock-copy` button around the unchanged
  `pre.-code`/`code.-code-<lang|plain>` node. Copy handler: frozen
  `Copy`/`Copied`/`Failed` labels, 1500 ms restore, missing/rejecting
  clipboard → `Failed` without throwing, rapid clicks reset the timer.
  createElement/textContent only.
- `webview/aiChat/transcript.ts` — new shared `disclosureToggle` helper
  (mounts `data-collapsed="1"` + `aria-expanded="false"`, click flips both).
  Tool items use it (was inline toggle starting `aria-expanded="true"`,
  expanded); reasoning items gain a `-reasoning-toggle` button (chevron +
  "Reasoning" label) mounted before `-reasoning-body`, default collapsed.
- `webview/aiChat/styles.css` — new `-codeblock`/`-codeblock-header`/
  `-codeblock-lang`/`-codeblock-copy` rules + inner `-code` override
  (`margin:0; border:0; border-radius:0; padding:10px 12px; line-height:1.5`);
  `-reasoning-toggle` row + `[data-collapsed="1"]` body-hide + chevron rotate;
  `-item-user` → `max-width:70%; padding:6px 10px`; `-tool-head`
  `min-height:28px`; `-action` `opacity: 0` + `transition` removed and the
  `:hover`/`:focus-within` reveal rule deleted.

### Verification Output

```
$ npx vitest run webview/aiChat/__tests__/codeBlock.test.ts \
    webview/aiChat/__tests__/transcript.test.ts \
    webview/aiChat/__tests__/messageActions.test.ts
✓ codeBlock.test.ts (7 tests) · ✓ transcript.test.ts (28 tests) · ✓ messageActions.test.ts (9 tests)
Test Files 3 passed (3) · Tests 44 passed (44)

$ npm run typecheck
> tsc --noEmit   → exit 0

$ npm run compile
> node esbuild.js → ⚡ Done in 43ms · dist/webview.js 2.3mb   → exit 0

$ npx vitest run webview/aiChat/__tests__/   (regression sweep)
Test Files 24 passed (24) · Tests 439 passed (439)

$ grep -n "opacity: 0;" webview/aiChat/styles.css   → no hits (exit 1)
$ grep -rn "innerHTML *=" webview/aiChat/markdown.ts webview/aiChat/transcript.ts → no hits (exit 1)
```

### Note

- Two pre-existing CSS-pin tests in `transcript.test.ts` pinned the OLD
  contract (78%/8x12 user bubble; hover-reveal actions) — updated in place to
  the new FR-006 contract, per spec.
- `data-lang` moved from `pre` to the `-codeblock` wrapper per FR-005 markup;
  no other code read `pre[data-lang]`.
- Reasoning toggle carries a "Reasoning" text label (consistent with the
  activity timeline's `Reasoning` section naming); spec froze only the class
  name and collapsed default.
- Milestone commits on `handoff/task-chatux-003`: `0647b4a` (RED),
  `8d29a10` (GREEN). Working tree clean.

---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run webview/aiChat/__tests__/codeBlock.test.ts webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/messageActions.test.ts
  result: 44 pass / 0 fail (3 files)
  command: npm run typecheck
  result: exit 0
  command: npm run compile
  result: exit 0 (esbuild done)
  command: npx vitest run webview/aiChat/__tests__/ (shared-file regression sweep)
  result: 442 pass / 0 fail (24 files)
TEST_PLAN_COVERAGE: all-followed — rows 1-5 implemented; ≥2 edge cases (rows 2,3,4,5); RED_OUTPUT contains real failing-test output; extra tests (missing clipboard, rapid-click timer reset, innerHTML source scan) are legitimate contract coverage, not padding.
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - file: webview/aiChat/styles.css — this task's diff range also carries composer/send-button hunks (36-88px top, 32x32 send) belonging to TASK-CHATUX-004; expected since both tasks share styles.css, noted for traceability only.
NEXT_STATUS_FOR_INDEX: approved
NOTES: disclosureToggle dedupes the previously inline tool-toggle logic and reuses it for reasoning — clean cutover, no duplicate semantics. data-lang moved pre→wrapper; grep confirms no other consumer. aria-labels ("Copy code", "Toggle reasoning", "Toggle tool output") keep icon-only buttons accessible.
