# Cycle AA Plan — AI Chat Panel UX overhaul (modern AI-chat standards)

Base: `main` @ `84db240` (v1.7.0, clean tree). Executor: code-tier model. Reviewer: reasoning model different from executor.
Cycle Z plan/tasks archived at `docs/AI_HANDOFF/archive/cycle-Z-*`.

## §1 Intent

The AI Chat panel is VSDB's core differentiator, but its UX is a decade behind ChatGPT/Claude/Cursor-class
chat UIs: the thread is capped at `max-height: 60vh` so the composer floats mid-panel ("input in the middle"
bug), agent reasoning is silently discarded, code blocks have no copy affordance, Ctrl/Cmd+Enter sends instead
of the industry-standard Enter/Shift+Enter, scrolling has no discipline, and there is no Regenerate next to
Stop.

Success looks like: a full-height thread with a pinned bottom composer; collapsible "Thinking" blocks fed by
live `agent_thought_chunk`s; per-code-block and per-message copy buttons; Enter=send / Shift+Enter=newline;
auto-scroll only when near bottom with a jump-to-latest affordance; a queued placeholder on the user bubble
and a streaming caret; Regenerate last response; a usable, hover-highlighted Resume picker with Esc-to-dismiss;
@-mentions resolving database objects (DDL) and workspace files (content, size-capped); and a permanent
regression lock proving the chat NEVER sends database row data to the AI — schema DDL only.

### User-locked invariant (verbatim, HARD)

> The chat feature must NEVER automatically pull database row/data content and push it to the AI.
> Auto-context is schema structure (DDL) only. Data sent to the AI must be only what the user explicitly
> pushes (typed prompt, attachments).

This is true today (both engines funnel auto-context through `buildMessages` ->
`listSchemas/listTables/listViews/listColumns` -> `buildDatabaseStructure` DDL; no row sampling).
TASK-004 locks it with regression tests; every future chat change is gated on them.

## §2 Scope

**In-scope (this cycle):**
1. Host message contract: new `thought` (host->webview) and `regenerate` (webview->host) messages; host posts
   live thought chunks (currently deliberately dropped); host implements Regenerate.
2. Webview rendering: collapsible thinking block (default collapsed, honest label), per-code-block copy +
   copy-message, streaming caret, queued placeholder + honest error labels, auto-scroll discipline +
   jump-to-latest, Regenerate affordance, Enter=send / Shift+Enter=newline.
3. Layout: full-height flex thread, composer pinned to the bottom of the panel, kill the 60vh cap.
4. Privacy regression lock on `buildMessages` (the single auto-context funnel for BOTH engines).
5. Resume picker repair: card/row styles (card mirrors the permission-card pattern), row padding +
   cursor:pointer + hover background, Esc dismisses (posts resume_cancel). Root cause verified: zero CSS rules
   exist for `.vsdb-chat-resume-*` classes today.
6. @-mention references (TASK-005): `@` opens a candidate dropdown (DB objects + workspace files,
   Cursor/Copilot-style), insertion of an `@token`, host resolves per turn — object tokens to DDL (via
   listTables/listViews/listRoutines/listColumns + buildDatabaseStructure), file tokens to file content
   (findFiles candidates, size-capped with truncation notice). Unresolved tokens surface an inline notice,
   never silent. User-initiated, so allowed under the privacy invariant.

**Out-of-scope (queued for later cycles):**
- Image attachments + clipboard paste (queue spec `AI-CHAT-INPUT-UX-spec.md` reqs 3-5 remain queued).
- Slash commands (`AI-CHAT-SLASH-COMMANDS-spec.md`).
- Thought chunks in resume replay (`deriveHistoryFromReplay` keeps filtering them; needs AcpReplayBuffer
  absorption work — separate cycle so this cycle's file surface stays disjoint).
- Markdown upgrade beyond the existing minimal renderer (headings/fences/inline/bold stays).

**CONSTRAINT honored:** no two same-wave tasks modify the same file (task Target Files are disjoint; wave
plan in INDEX.md).

## §3 Approach

Research convergence (setproduct.com "AI chat UI patterns" teardown; uxpatterns.dev chat-interaction
patterns; prompt-kit component set; ChatGPT/Claude/Cursor observed behavior) yields the 7 feature pillars
implemented here: pinned composer, collapsible reasoning, copy affordances, Enter/Shift+Enter, scroll
discipline + jump-to-latest, honest message states (queued/caret/stopped-keeps-partial/error), and
Regenerate paired with Stop.

Rejected alternatives:
- *Float the composer over the thread* — rejected; research and all three reference UIs dock it. Docked is
  also strictly simpler (flex column, no overlay/scroll-padding math).
- *Host-side buffered "Thinking" summary posted once* — rejected; chunks already stream over the ACP wire
  (`session/update` -> `agent_thought_chunk { chunk }`), so the host forwards incrementally and lets the
  webview own collapse/label state. Buffering would add host state for zero UX gain.
- *Regenerate as a distinct host command reusing handleSend* — chosen, with history pop-before-rerun: pop the
  trailing `[user, assistant]` pair, then run the normal send path so history never duplicates. Rejected:
  a separate turn-runner path (duplicates the abort/permission/token dance).
- *Replay thoughts through resume* — deferred (above); keeps `aiChatPanelResume.test.ts` / webview history
  filter untouched.
- *Regenerate-after-Stop* — defined semantics: Regenerate re-sends the STOPPED user message when the stopped
  exchange is the last UI exchange (partial assistant text stays visible and is replaced by the new turn's
  output); when history's trailing pair is intact (normal case) the pop-and-rerun path applies; when busy,
  ignored. This removes the "silently re-runs an older prompt" trap (history push sits inside the
  `!token?.aborted` branch at aiChatPanel.ts:619-626, so pop-before-rerun alone is wrong after Stop).

Supersession note (flips a standing invariant — scope is explicit):
- TASK-001 RETIRES the live-turn thought-drop pins: `aiChatPanelAcp.test.ts` case #1 ("ignores
  agent_thought_chunk"), the drop-site comment block at `src/ui/aiChatPanel.ts:1024-1027`, and adds the new
  `thought` contract tests in its own new test file. TASK-002 retires the webview-side "no branch renders
  thoughts" pin (cycle-O bundle pin) ONLY for the live `thought` message kind — replay filtering
  (`deriveHistoryFromReplay`, `aiChatPanelResume.test.ts` #3/#5, webview history branch) stays INTACT this
  cycle. Every changed pin gets a named replacement test in the same task's test file.

Key grounded facts driving the design:
- Live thought drop site: `src/ui/aiChatPanel.ts:1022-1027` (`agent_thought_chunk` deliberately ignored);
  chunk envelope is `{ sessionUpdate: "agent_thought_chunk", chunk: string }` (fixture:
  `aiChatPanelAcp.test.ts` `feedAgentThoughtChunk`).
- History push sites (for Regenerate pop): `aiChatPanel.ts:625` and `:839-840` — pairs are always appended
  as `[userMsg, assistantMsg]`.
- "Input in the middle" bug: `webview/styles.css:902-909` `.vsdb-chat-thread { max-height: 60vh }`; panel
  shell `<div id="vsdb-root" class="vsdb-chat">` inside `<body class="vsdb-form-body">` (`aiChatPanel.ts:1485-1486`).
- Send keybind: `webview/aiChatPanelMain.ts:232-237` (Ctrl/Cmd+Enter) — replaced by Enter/Shift+Enter.
- Resume picker DOM: `webview/aiChatPanelMain.ts:530-591` (renderResumePicker / disposeResumePicker); picker CSS classes `.vsdb-chat-resume-*` currently have ZERO rules in `webview/styles.css`.
- Adapter surface for mentions: `src/adapters/types.ts:105-119` — listTables/listViews/listRoutines/listColumns exist; `buildDatabaseStructure` renders DDL from these.
- Host history push inside `!token?.aborted` (Regenerate-after-Stop trap): `aiChatPanel.ts:619-626`.
- Message union: `src/ui/aiChatPanelMessages.ts` (`AiChatPanelHostMessage` / `AiChatPanelWebviewMessage`),
  mirrored in `webview/aiChatPanelMain.ts:78-88`; unknown kinds are already ignored by both sides, so the
  contract extension is additive and safe mid-wave.
- Privacy funnel: `buildMessages` (`src/ui/aiChatPanel.ts:186-325`) is the ONLY context builder; both
  `runBuiltinTurn` and `runAcpTurn` (line ~746) call it. Locking it locks both engines.

## §4 Test Plan

| Type | Test | Expected | Task |
|------|------|----------|------|
| happy | host forwards live thought chunk | `agent_thought_chunk {chunk:"t"}` during turn -> one `post({type:"thought", text:"t"})` per chunk | T1 |
| happy | regenerate reruns last user msg | completed turn + regenerate -> last user text re-sent; history ends with exactly one `[user, assistant]` pair for it | | T1
| happy | webview thinking block | thought msgs render one collapsible block, default collapsed, text appended across chunks | | T2
| happy | Enter/Shift+Enter | Enter sends + clears; Shift+Enter inserts `\n`; plain Enter never inserts a newline | | T2
| happy | code-block copy | fenced block renders copy button; click copies raw code (no fences) | | T2
| happy | pinned layout | thread flexes to fill panel, composer at bottom edge (layout test asserts flex declarations) | | T3
| happy | privacy: DDL-only context | `buildMessages` with spy adapter returns system prompt containing CREATE TABLE DDL; row-bearing methods never invoked | | T4
| edge (malformed input) | thought with empty/missing `chunk` field | no `thought` message posted, no throw | | T1
| edge (late frame) | thought arriving after turn settled | dropped silently (same gate as deltas) | | T1
| edge (concurrency) | regenerate while busy | ignored; input stays disabled | | T1
| edge (empty) | regenerate with empty history | ignored, no post, no crash | | T1
| edge (environment) | copy without clipboard permission | button degrades silently (no unhandled rejection), label reverts | | T2
| edge (boundary) | auto-scroll threshold | scrolls only when within 40px of bottom; stays put when scrolled up; jump-to-latest appears only when detached + new content | | T2
| edge (state) | queued placeholder + error | user bubble shows queued state until first delta/error/done; error resolves it to honest error label, not endless spinner | | T2
| edge (mutation) | history passthrough | `buildMessages` returns supplied history entries by value, unmodified | | T4
| edge (error path) | introspection failure | factory/`listSchemas` throw -> context empty, minimal system prompt, no crash | | T4
| edge (boundary) | DDL budget | `contextBudgetChars` small -> cut at block boundary, first block kept, omission footer added | | T4
| happy | resume picker Esc dismiss | Esc keydown while picker open -> one `resume_cancel` posted + picker removed from DOM | T2 |
| happy | resume picker hover/pointer | picker rows get `cursor:pointer`, padding, hover background (CSS contract) | T3 |
| happy | mentions dropdown lifecycle | `@` opens candidates (DB objects + files, kind badges); typing filters; ArrowUp/Down moves active; Enter/Tab inserts `@token`; Esc closes; Enter-while-open SELECTS, never sends | T5 |
| happy | mention DDL resolution | send with `@schema.table` -> host appends per-turn DDL block for that object; adapter introspection methods called, runQuery never | T5 |
| happy | mention file resolution | send with `@file` -> host reads file content into that turn's context; findFiles-backed candidates listed | T5 |
| edge (state) | mention token unresolved | `@nonexistent` -> inline notice bubble ("not found"), send proceeds WITHOUT the block, never silent | T5 |
| edge (boundary) | file content size cap | `@bigfile` (>100KB) -> truncated content + truncation notice line | T5 |
| edge (concurrency) | regenerate after Stop | stopped exchange is last UI exchange -> Regenerate re-sends the stopped user msg; partial bubble replaced; history gains exactly one [user, assistant] pair; busy -> ignored | T1 |
| edge (invariant) | mentions never auto-fire | no candidates/requests without user typing `@`; no auto-context change to buildMessages baseline | T5 |
| regression (bug) | 60vh cap removed | CSS contract test: `.vsdb-chat-thread` has no `max-height: 60vh` and is `flex: 1` inside full-height `.vsdb-chat` column — RED against current CSS | | T3
| regression (invariant) | privacy sentinel | `runQuery` seeded with sentinel rows -> sentinel appears nowhere in `buildMessages` output; spy call count 0 | | T4

## §5 Verification Commands

Per task in `tasks/TASK-00N.md`; house pattern (established cycle Z):

```bash
npx vitest run src/ui/__tests__/<task-test>.test.ts
npm run typecheck
```

- `package.json` scripts: `compile` (esbuild), `test` (vitest run), `typecheck` (tsc --noEmit), `test:integration`, `package`.
- **No `lint` script exists** — `npm run typecheck` is the mandatory static gate for every task (stated explicitly per RULES; not silently omitted).
- Webview tests bundle the real `webview/aiChatPanelMain.ts` via esbuild inside the test (dist-independent) — no separate `npm run compile` step required for TASK-002.
- Full `npm test` at wave boundary is the regression net for the narrowed per-task selections (RULES.md).

## §6 Acceptance Criteria

- [ ] Composer pinned to panel bottom, thread fills remaining height, no 60vh cap (TASK-003; verified by CSS contract test).
- [ ] Enter sends / Shift+Enter newlines in the chat composer (TASK-002).
- [ ] Agent reasoning shows as a collapsible, default-collapsed block during live turns (TASK-001 + TASK-002).
- [ ] Code blocks and full messages have working copy affordances (TASK-002).
- [ ] Auto-scroll only near bottom + jump-to-latest affordance (TASK-002 + TASK-003 styles).
- [ ] Queued placeholder, streaming caret, honest error labels; stopped turns keep partial text (TASK-002).
- [ ] Regenerate re-runs the last user message without duplicating history, guarded when busy/empty (TASK-001 + TASK-002).
- [ ] Privacy lock: sentinel/spy tests prove `buildMessages` auto-context is DDL-only for both engines (TASK-004).
- [ ] Resume picker styled (card+rows+hover+pointer) and Esc-dismissible (TASK-002 + TASK-003).
- [ ] `@` mentions resolve DB objects (DDL) and files (content, capped) into per-turn context; unresolved → inline notice; Enter-while-open selects, never sends (TASK-005).
- [ ] Mention resolution is user-initiated only — auto-context path untouched (TASK-005 + TASK-004 lock holds).
- [ ] `npm run typecheck` passes and affected suites green for every task; full `npm test` green at wave boundary.

## §7 Global Constraints (inherited by every TASK-xxx.md by reference)

- No new npm dependencies; webview stays CSP-safe (no inline `on*=` handlers — addEventListener only).
- `engines.vscode` stays `^1.75.0`; no new VS Code API surface.
- NO apiKey material ever enters any new message shape (both directions).
- Privacy invariant §1 (HARD): auto-context = DDL only; no row/data sampling anywhere in the chat path. @-mention resolution (object DDL / file content) is USER-INITIATED and allowed; it never alters the auto-context baseline.
- Enter must never insert a newline in the chat composer; Shift+Enter must never send.
- Thought text must never enter `session.buffer`, `this.history`, or resume replay.
- Unknown message kinds stay silently ignored on both sides (additive contract evolution).
- Keep the existing minimal markdown renderer; no sanitizer changes needed since user/agent text stays escaped-first.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
1. §6 criteria each trace to tasks: composer/layout→TASK-003; Enter/keybind→TASK-002; Thinking→TASK-001+002; copy→TASK-002; scroll→TASK-002+003; states→TASK-002; Regenerate→TASK-001+002; privacy lock→TASK-004; typecheck gate→all tasks' Verification Commands.
2. Every task traces to §1/§2: 001 (contract+host), 002 (webview UX), 003 (layout), 004 (lock). No orphan tasks.
3. Together they deliver §1's success definition: all 7 researched pillars covered; privacy lock included.
4. Unhappy path planned: malformed/late thought chunks (T1 #3/#4), busy/empty regenerate (T1 #6/#7), clipboard rejection (T2 #5), scrolled-up + error states (T2 #7/#8), introspection failure + budget cut (T4 #3/#4), CSS RED-first regression (T3 #1).
5. Target Files verified against live tree (aiChatPanel.ts 1491 lines, aiChatPanelMessages.ts 186 lines, aiChatPanelMain.ts 678 lines, styles.css 1195 lines all read); new test files marked (new).
6. Verification commands are real scripts: npm test/typecheck exist in package.json scripts (read); npx vitest run is the established house invocation; no lint script exists — stated explicitly.
7. No same-wave file overlap: wave 1 = T1(.ts host) / T3(styles.css) / T4(privacy test only); wave 2 = T2(webview main).
8. No task depends on symbols no earlier task creates: T2 consumes exactly T1 §Interfaces; T3 consumes exactly T2 §Interfaces (DOM ids/classes).
9. Test quality: each task ≥1 happy + ≥2 edges of different kinds (malformed/late-frame/concurrency/empty/boundary/environment/error-path/state/mutation — enumerated in each table).
10. Every Expected is concrete (exact post shape, exact CSS declaration, exact sentinel string, exact call count).
11. Regression tests: T3 #1 RED against current 60vh CSS; T2 #9/#10 pin legacy keybind removal + replay filtering; T4 #1/#2 are the standing invariant lock. T1 #2 RED (thought currently dropped — verified at aiChatPanel.ts:1022-1027).
12. Tests cannot pass against an empty implementation: each asserts real behavior (posted messages, DOM state, clipboard calls, CSS declarations, DDL content).

Fixed during audit: none — file overlap check passed on first split (T1/T3/T4 parallel by design).
Known gaps: (a) Thinking blocks in resume replay remain filtered (queued — needs AcpReplayBuffer work; out-of-scope in §2, so live-turn thinking is the only rendered thought source this cycle). (b) TASK-003 visual layout cannot be screenshot-verified in CI — CSS contract test + manual smoke note in its Acceptance Criteria. (c) Image attach/paste + slash commands remain in queue (intentional scope cut recorded in §2).


## Plan Review Log

### Round 1 - 2026-08-27 - unic/unic-smart
REVIEWER_MODEL: unic/unic-smart (matches config handoff.reviewer.model = "unic-smart"; equals planner-reported PLANNER_MODEL - spec mode has no executor-isolation gate; disclosed for transparency)
Status: Issues Found

COMPLETENESS:
  - pass: SS1-SS7 + Planner Report + Self-Audit all present. SS4 = 7 happy / 10 edge / 2 regression rows; >=2 edges per task of distinct kinds. Privacy regression lock present and wired (SS4 "privacy: DDL-only context" + "privacy sentinel" rows; SS6 AC; SS7 HARD constraint).
CONSISTENCY:
  - IMPORTANT (I1): Standing "agent_thought_chunk must never render" invariant supersession is unstated. SS4 row "host forwards live thought chunk" flips behavior pinned by existing suites (aiChatPanelAcp.test.ts #1 "ignores agent_thought_chunk"; cycle-O webview pin "no branch renders thought") and by the live drop-site comment (src/ui/aiChatPanel.ts:1025-1027, citing prior TASK-004 SS3 "must never render or surface"). SS7 preserves only buffer/history/replay containment; Self-Audit item 11 pins keybind/replay updates but omits the host thought-drop pins. Risk: TASK-001 verification turns pre-existing tests RED and an executor may "fix" the wrong side. Fix: in SS3 or SS7, explicitly list which existing tests/comments TASK-001 must update or retire, and which pin must survive (replay filter per SS2 out-of-scope).
  - pass: Wave/disjointness holds (SS2 CONSTRAINT; Self-Audit 7-8): wave1 = T1(host .ts)/T3(styles.css)/T4(test-only), wave2 = T2(webview main); T2 consumes only T1 SSInterfaces; T3 consumes only T2 DOM ids/classes.
CLARITY:
  - IMPORTANT (I2): Regenerate-after-Stop undefined, wrong by construction today. SS3 pops the trailing [user, assistant] history pair, but history is pushed only on non-aborted completion (src/ui/aiChatPanel.ts:619-626 - push sits inside the !token?.aborted branch). After Stop, the trailing pair in history is the PREVIOUS turn while SS6 keeps the stopped exchange visible ("stopped turns keep partial text") -> Regenerate silently re-runs an older prompt. No SS4 edge covers stop->regenerate. Fix: pick semantics (re-send the stopped user message when it is the last UI exchange, else ignore) and add the edge test to SS4.
SCOPE:
  - pass: matches cycle goal exactly (pinned composer, thinking block, copy, Enter/Shift+Enter, scroll discipline, message states, regenerate, DDL-only lock); each out-of-scope item carries a reason (SS2).
YAGNI:
  - pass: rejected alternatives documented (SS3); no new deps, no new VS Code API surface (SS7).
MINOR:
  - M1: SS4 rows carry no owning-task column; mapping lives only in SS6/self-audit - add a Task column so per-task happy+>=2-edge counts are mechanically checkable.
  - M2: anchor drift: ACP-side buildMessages call is at src/ui/aiChatPanel.ts:733 (plan says "~746"); drop comment spans :1024-1027 (plan says "1022-1027"). Tilde-tolerant, but refresh to cut executor search time.

### Round 2 — revision (applied by orchestrator after planner-agent infra failure, 2026-08-27)
PLANNER side: I1 supersession list added (§3); I2 Regenerate-after-Stop semantics + edge row defined (§3+§4); M1 Task column added (§4); M2 anchors refreshed + new grounded facts (§3). Steering additions folded in: resume-picker repair (§1/§2/§4/§6, TASK-002/003) + TASK-005 @-mentions incl. files (§1/§2/§4/§6, wave 3).
FINDINGS APPLIED WITHOUT RE-REVIEW (loop cap reached — review round count = 2):
- I1: §3 supersession note lists exact tests/comments to retire per task; replay filtering stays intact.
- I2: Regenerate-after-Stop semantics defined (stopped-last-exchange → re-send stopped msg; busy → ignore) + §4 edge row added: "regenerate after Stop re-sends the stopped user msg, replaces partial bubble, history gains exactly one pair".
- M1: §4 rows now carry owning-task column.
- M2: anchors refreshed (:733 buildMessages ACP call, :1024-1027 drop comment) + resume-picker DOM facts added.
- Steering: TASK-005 + picker repair folded into §1/§2/§4/§6 with test rows.

NOTES: Two importants are localized plan amendments (a supersession note + one defined edge + test), not redesign. Ground-truth spot-checks all confirmed: 60vh cap (webview/styles.css:907), keybind (webview/aiChatPanelMain.ts:233-237), pair-appending history pushes, single buildMessages funnel for both engines (aiChatPanel.ts:574,733), no lint script in package.json.
