# TASK-CHATUX-003 — W3 message visual system: code-block header+Copy, collapsed tool/thinking rows, visible actions, compact user card

- Status: `ready`
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
