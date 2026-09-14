# AI-chat platform section drafts (TASK-AICHAT-005)

Status: section-draft input for TASK-AICHAT-006 consolidation. Not the final spec, not an
implementation, and not a claim that the target-state behavior exists today.

Inputs (read-only): `docs/AI_HANDOFF/notes/aichat-factbase-webview.md` (TASK-001),
`docs/AI_HANDOFF/notes/aichat-factbase-host.md` (TASK-002),
`docs/AI_HANDOFF/notes/aichat-research-external.md` (TASK-003), and the baseline draft
`docs/AI_CHAT_REDESIGN.md` §Scope / §Source anchors.

**Section ownership boundary.** This note owns: Streaming & rendering, Activity timeline,
Sessions & persistence, Permissions & approvals, Failures & recovery, the four-engine
capability matrix, the engine-gated command semantics for `/engine` `/model` `/resume`
`/context` `/export` and provider-native command gating, and the Visual acceptance (VIS)
family for the NEW rendered surfaces. It does NOT own the composer keyboard controller, the
slash-menu interaction contract/anatomy, the mention menu, or autocomplete geometry/accessibility
— those live in `docs/AI_HANDOFF/notes/aichat-sections-composer.md`; this note points to it as
`→ see TASK-AICHAT-004 / aichat-sections-composer.md` and never restates its rules.

**Evidence taxonomy used in every cell below.**
- `Verified (file:line)` — the current behavior was read at that anchor this cycle (anchors
  inherited from TASK-AICHAT-001/002, which opened each range).
- `Unverified-internal` — the internal behavior is plausible but no anchor was read; must be
  confirmed before implementation.
- `absent in current source` — the capability does not exist in the current tree.
- `new capability (no current source anchor)` — a target-state design this note proposes;
  grounded in a research precedent, not in current source.
- `per Qxx` — the rule is shaped by that enumerated research question in TASK-003;
  `Verified-with-URL` / `Could-not-verify` labels below are inherited from that note.

---

## 1. Streaming & rendering

### 1a. Carrier inventory (message names are exact, from the protocol inventory)

One streaming primitive exists today: the host→webview `delta` frame
(`src/ui/aiChatPanelMessages.ts:77`; webview case `webview/aiChatPanelMain.ts:1964–1966`).
Every engine funnels into it through the same events shape.

| Carrier (`type`) | Direction | Line | Role in the stream | Anchor status |
|---|---|---|---|---|
| `delta` | host → webview | `src/ui/aiChatPanelMessages.ts:77` | Incremental assistant text; only carrier that feeds the streaming bubble | Verified (src/ui/aiChatPanelMessages.ts:77) |
| `assistant` | host → webview | `:59` | Terminal final reply; replaces the streaming bubble with `appendAssistant(text, markdown)` | Verified (webview/aiChatPanelMain.ts:1976) |
| `done` | host → webview | `:73` | Turn boundary; de-streams the open bubble and clears busy | Verified (webview/aiChatPanelMain.ts:1999) |
| `error` | host → webview | `:67` | Non-fatal error bubble; also de-streams | Verified (webview/aiChatPanelMain.ts:1992) |
| `step` | host → webview | `:44` | Discrete progress label — **not** a text chunk | Verified (webview/aiChatPanelMain.ts:1955) |
| `tool_result` | host → webview | `:51` | Tool-outcome card (`ok`/`failed`/`denied`) | Verified (webview/aiChatPanelMain.ts:1958) |
| `thought` | host → webview | `:87` | ACP `agent_thought_chunk` reasoning text | Verified (webview/aiChatPanelMain.ts:2015) |
| `session_state` | host → webview | `:114` | `connecting`/`running`/`done`/`error` + `turnId` | Verified (src/ui/aiChatPanelMessages.ts:114) |

**Delta route per engine (target-state normalization, all four already converge today):**

- builtin: `runAgent` → `provider.streamComplete`; panel `onText` posts `delta`
  — Verified (src/ui/aiChatPanel.ts:2358), route at `src/ai/agent.ts:243`.
- omp: ACP `session/update` → `agent_message_chunk` → `onDelta`
  — Verified (src/ai/omp/ompChatEngine.ts:273).
- claudeCode: subprocess stdout → the omp-shaped callbacks
  — Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:48), forwarded through
  `runImageCapableEngineTurn` — Verified (src/ui/aiChatPanel.ts:2754).
- codex: subprocess stdout carried over stdin
  — Verified (src/ai/codex/codexChatEngine.ts:64).
- All three external routes are redacted at the wire boundary (`String(redact(delta))`)
  — Verified (src/ui/aiChatPanel.ts:2601), Verified (src/ui/aiChatPanel.ts:2782). The target
  contract keeps this: **no raw engine byte reaches the webview unredacted**, and `thought`
  is redacted the same way.

### 1b. Render coalescing policy (target-state; UnicDB-original)

Current behavior appends one `delta` per chunk as a raw text node and re-parses markdown on
fence close — Verified (webview/aiChatPanelMain.ts:1272–1320). At provider chunk rates this
re-parses far more often than the display needs. Target rule:

- A single animation-frame scheduler coalesces incoming `delta` frames: fragments are
  buffered and flushed **at most once per 16 ms** (one 60 Hz frame), and a markdown re-parse
  is capped at **at most once per 50 ms**. Rationale: typed incremental output is the
  upstream norm (Q04: `stream.markdown` is incremental), but re-parsing the whole tail per
  token is not required by any precedent and is the dominant cost.
- Coalescing must never reorder or drop text: the concatenation of all flushed fragments
  equals the concatenation of all received `delta` frames, byte-for-byte, per turn.
- The raw accumulated text stays on the bubble's dataset (`bubble.dataset` raw-stream key)
  so `assistant` can reconcile the final text against what streamed — Verified
  (webview/aiChatPanelMain.ts:1309–1311).
- When `assistant` arrives, the coalescer flushes any buffered fragment before the bubble is
  replaced — the final rendered text must include every received chunk, not a truncated tail.
- **Announcement discipline:** the polite live region announces turn-state changes and the
  final response, never each coalesced flush (per Q21: `aria-live="polite"` presents at the
  next graceful opportunity; per Q04: announce typed progress, not every token). Announcement
  cadence is owned by TASK-AICHAT-004's a11y family; this note only fixes that streaming must
  not drive per-token announcements.

### 1c. Partial-markdown and fence policy (target-state)

Current rule: append text as a text node; re-render markdown once a complete ` ```…``` `
fence is present — Verified (webview/aiChatPanelMain.ts:1312–1317). Target rule (concrete):

- Text outside any fence is rendered as inline markdown incrementally.
- An **unclosed** fence is rendered as a `<pre><code>` block whose language class is taken
  from the info string if one is already present, and is **re-labeled on close**; the fence
  delimiter itself is never shown as literal backticks.
- A fence is considered closed only when an even number of ` ``` ` delimiters has been seen
  since the bubble was created. An odd count means "open" and the block is provisional.
- Incomplete inline spans (an unclosed `**`, `` ` ``, or `[`) are rendered as **literal
  text** until their closing token arrives; the tail characters are never swallowed and never
  render as a broken emphasis node.
- On `assistant` (terminal), the full text is rendered once through the canonical
  `appendAssistant(text, markdown)` path with SQL highlighting and copy buttons — Verified
  (webview/aiChatPanelMain.ts:1223–1248). If the terminal render throws, the bubble keeps the
  last good streamed render and a failure banner is raised (see FAIL-07).

### 1d. Stick-to-bottom scroll rule (target-state; concrete px threshold, UnicDB-original)

No scroll-lock constant exists in current source (`absent in current source`). Target rule:

- While content streams, the thread auto-follows the bottom **only if** the viewport is
  already near the bottom: `scrollHeight - scrollTop - clientHeight <= 24px` (the
  **stick-to-bottom threshold**, 24 px). Above that distance the thread must **not** yank the
  viewport.
- When auto-follow is suppressed by user scroll, a persistent affordance appears with the
  exact string "Jump to latest", anchored bottom-center of the stream area (visual spec in
  VIS-03). Clicking it restores the 24 px rule and resumes following.
- Auto-follow is cancelled on any explicit user scroll gesture (wheel, drag of the
  scrollbar, touch) and re-armed only by reaching the bottom again or pressing the affordance.
- `done`/`assistant`/`error` settlement does not force a scroll unless auto-follow was still
  armed at settlement time.

### 1e. Stop / cancel semantics (target-state)

Current: the composer's Stop button is explicit; a builtin Stop aborts the turn's
`AbortController` and posts `done` in `finally`, keeping partial text with no error bubble —
Verified (src/ui/aiChatPanel.ts:2480). `/clear` and Escape must never implicitly cancel
generation (Q10: stopping is an explicit button, never inferred; Q21: `assertive` announcements
are not warranted for a stop). Target rule:

- Stop ends the in-flight turn only; it does not clear the transcript, does not delete
  completed tool results, and does not undo side effects already applied — text preserved in
  the open bubble (per Q10, which documents that stopping "doesn't undo file edits, terminal
  commands, or other actions that already completed").
- After Stop, the thread shows the exact string "Stopped." appended to the settled bubble,
  and the turn's `session_state` returns to `done`.
- Stop is idempotent: a second Stop on a settled turn is a no-op (no duplicate bubble, no
  duplicate `done`).
- **Queueing and steering are out of scope** and must never be inferred from typing — they
  are separate, explicitly-triggered future capabilities (Q10: upstream exposes them as
  distinct dropdown actions "Add to Queue" / "Steer with Message" / "Stop and Send").
- Stop remains reachable by keyboard while the textarea holds a draft; the draft is preserved
  verbatim across Stop.

### Streaming acceptance tests (STREAM family)

- **STREAM-01** — received `delta` frames render in order with no dropped or duplicated
  fragment; concatenated rendered text equals the concatenation of frames.
- **STREAM-02** — coalescing flushes at most once per 16 ms and re-parses markdown at most
  once per 50 ms under a burst of ≥100 synthetic deltas; the final text is complete.
- **STREAM-03** — an unclosed fence renders as a provisional code block (no literal
  backticks) and is re-labeled with the correct language once the closing fence arrives.
- **STREAM-04** — auto-follow engages only within the 24 px stick-to-bottom threshold; a
  user scroll above it suppresses following and shows "Jump to latest".
- **STREAM-05** — `assistant`, `done`, and `error` each de-stream the open bubble exactly
  once; a settled bubble is never re-entered into streaming state.
- **STREAM-06** — Stop during an in-flight turn appends "Stopped.", keeps partial text, posts
  one `done`, and is idempotent on a second press.
- **STREAM-07** — an external-engine `delta` and `thought` are redacted before reaching the
  webview; a raw secret-shaped token in a chunk does not appear in the DOM.

---

## 2. Activity timeline

### 2a. Current state — `absent in current source`

No `timeline` or `activity` file or identifier exists in any chat file (TASK-002 §5d sweep:
`grep -rniE "timeline|activity" src webview` returns nothing chat-related). The closest
artifacts are (a) inline `step` rows — a plain `label` string with no timestamp, id, or
status — Verified (src/ui/aiChatPanelMessages.ts:44), Verified
(webview/aiChatPanelMain.ts:1086), and (b) the redacting in-memory `TraceRecorder`
(`src/ai/trace.ts:11`), which is attached to turns but never rendered in the panel —
Verified (src/ui/aiChatPanel.ts:1299). A timeline is therefore a **new capability (no current
source anchor)**, not a rename of `step`.

### 2b. Turn / event model (target-state)

The timeline is a per-turn ordered event list derived from carriers the protocol already
emits, plus timestamps the host must add. Each event carries:

| Field | Type | Source / rule |
|---|---|---|
| `id` | string | Stable per event; used for collapse state and copy |
| `turnId` | string | Matches `session_state.turnId` — Verified (src/ui/aiChatPanelMessages.ts:114) |
| `kind` | `thought` \| `step` \| `tool` \| `delta-group` \| `error` | Mapped from `thought`/`step`/`tool_result`/`delta`/`error` |
| `at` | ISO-8601 | Wall-clock at receipt; current carriers carry **no** timestamp (gap) |
| `status` | `running` \| `ok` \| `failed` \| `denied` | `tool_result` already carries `ok`/`failed`/`denied` — Verified (src/ui/aiChatPanelMessages.ts:51) |
| `label` | string | The existing `step`/tool string |

Per-engine content rules (honest about what each backend supplies):

- **omp** supplies real reasoning (`thought`) and tool outcomes (`tool_result`) — the richest
  event stream — Verified (src/ai/omp/ompChatEngine.ts:273), Verified
  (src/ai/omp/ompChatEngine.ts:307).
- **builtin** supplies `step` labels and tool results only; there is no reasoning channel —
  `absent in current source` for thoughts on builtin.
- **claudeCode / codex** forward the same omp-shaped callback shape, so event kinds match omp
  but the underlying richness is `Unverified-internal` until each adapter's event mapping is
  confirmed.
- A turn with zero events renders no timeline block at all (no empty chrome).

### 2c. Collapsibility and content rules (target-state)

- The timeline block is collapsed by default after the turn settles, showing a one-line
  summary with the exact string pattern `"N steps"` (e.g. "3 steps"); it is expanded while
  the turn runs.
- Manual collapse/expand is sticky per turn for the session; expanding one turn does not
  expand others.
- A `tool_result` with `status: "failed"` or `status: "denied"` never collapses its row's
  status badge — a failure inside a collapsed group is still surfaced as a count (e.g.
  "3 steps · 1 failed").
- The timeline is a read-only history: it never exposes interactive controls inside
  `role="option"`-style listboxes (Q20 constrains option rows to flat text; the timeline uses
  ordinary disclosure buttons, not listbox options).
- Clicking an event copies the event, not the whole transcript (Q11 documents per-item Copy /
  Copy All as separate affordances).
- Reasoning (`thought`) text is visually subordinate to tool outcomes and is labelled in
  words, never shown as an unlabeled wall of model text.

### Timeline acceptance tests (TIME family)

- **TIME-01** — a settled multi-event turn renders a collapsed summary matching `"N steps"`;
  the count equals the number of rendered events.
- **TIME-02** — expanding one turn's timeline leaves every other turn's collapse state
  unchanged.
- **TIME-03** — a failed or denied tool inside a collapsed timeline still surfaces a
  non-zero failed count.
- **TIME-04** — an event's `turnId` matches the turn's `session_state.turnId` and events
  render in receipt order.
- **TIME-05** — a turn with zero events renders no timeline block.
- **TIME-06** — the timeline never contains a focusable element inside a listbox option row;
  all controls are ordinary buttons reachable in the normal tab order.

---

## 3. Sessions & persistence

### 3a. Current storage mechanism (facts)

- **The extension persists nothing to disk.** Conversation state is per-panel in-memory
  `this.history: ChatMessage[]` — `absent in current source` for any extension-owned session
  store (TASK-002 §5a; the only durable policy surface is `UnicDB.ai.showPolicy`,
  `package.json:282`).
- **Session persistence belongs to the omp child process.** Listing is ACP `session/list` —
  Verified (src/ai/omp/acp.ts:213); loading is `session/load` — Verified (src/ai/omp/acp.ts:252).
- The host filters the list by `cwd`, excludes the current session, sorts by `updatedAt`
  descending, and caps at `RESUME_PICKER_CAP = 20` — Verified (src/ui/aiChatPanel.ts:4046),
  constant declared at Verified (src/ui/aiChatPanel.ts:1173).
- **Resume is omp-only.** Both list and pick post `"Resume requires the omp engine."` for any
  other engine — Verified (src/ui/aiChatPanel.ts:4020), Verified (src/ui/aiChatPanel.ts:4072).
- `builtin` has no session id at all — Verified (src/ui/aiChatPanel.ts:4020).
- The webview replays a resumed transcript from the `history` frame, capped by
  `HISTORY_RENDER_CAP` — Verified (src/ui/aiChatPanelMessages.ts:328),
  Verified (src/ui/aiChatPanelMessages.ts:373).

### 3b. Session schema (target-state; `new capability (no current source anchor)`)

The extension owns a thin session index; engine-owned transcripts stay with the engine. The
index record fields:

| Field | Type | Rule |
|---|---|---|
| `sessionId` | string | Engine-native id when one exists; otherwise a locally generated id. Present for omp — Verified (src/ui/aiChatPanel.ts:4046). |
| `engine` | `builtin` \| `omp` \| `claudeCode` \| `codex` | Matches the four-literal union — Verified (src/ui/aiChatPanelMessages.ts:102). |
| `title` | string | First user message truncated to 80 chars, or the rename value. |
| `cwd` | string | Workspace folder; the picker filter key — Verified (src/ui/aiChatPanel.ts:4046). |
| `createdAt` / `updatedAt` | ISO-8601 | `updatedAt` drives picker sort order — Verified (src/ui/aiChatPanel.ts:4046). |
| `resumable` | boolean | True only where native resume is supported (omp). |
| `turnCount` | integer | For the picker's secondary line. |
| `hasTranscript` | boolean | True when a local structured transcript exists. |

- **Privacy boundary:** the index never stores raw secret content. `grounding_state.excludedCount`
  is today a bare number with no detail — Verified (src/ui/aiChatPanelMessages.ts:190); the
  target keeps exclusions as a count plus a policy label, never a dump of excluded content
  (per Q18: `level: "noCode"` strips prompts and code from captured data — a single
  privacy flag is the upstream precedent).
- The index is written **only after a confirmed host write**; a failed write raises FAIL-06
  and leaves the prior index intact.

### 3c. Session picker contents (target-state)

- Rows are capped at 20 — the existing `RESUME_PICKER_CAP` — Verified
  (src/ui/aiChatPanel.ts:1173).
- Each row shows title, a secondary line of engine + relative `updatedAt`, and a
  resumability state. Two sessions with the same title must show distinct secondary lines
  (engine + timestamp), mirroring the draft's duplicate-disambiguation rule.
- Non-resumable engines show their rows with the state disabled **and explain it**: the row
  carries the engine's own unsupported string (see 3d) rather than a generic failure — the
  `aria-disabled` (not HTML `disabled`) convention per Q21 keeps the row focusable so screen
  readers can discover it.
- The picker uses ordinary dialog/list semantics owned by the composer surface; its
  interaction contract and focus policy are TASK-AICHAT-004's — `→ see TASK-AICHAT-004 /
  aichat-sections-composer.md`.
- Filtering/grouping: by time bucket "Today" / "Last Week" / "Older" (target-state, per Q05
  where upstream groups sessions by time).

### 3d. Per-engine native-resume wording (must stay per-engine, never global)

The spec must state these separately, quoting the current engine strings exactly:

| Engine | Native resume | Wording rule | Anchor status |
|---|---|---|---|
| `omp` | supported | Picker enabled; errors use `"Resume requires the omp engine."` only when the engine is not omp | Verified (src/ui/aiChatPanel.ts:4020) |
| `claudeCode` | **unavailable** | Row disabled with the adapter's own string `"Claude Code session resume is unavailable"` | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:105), Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:280) |
| `codex` | **unavailable** | Row disabled with `"Codex session resume is unavailable"` | Verified (src/ai/codex/codexChatEngine.ts:364) |
| `builtin` | **no session id** | No native session concept; picker shows locally-saved transcripts only and the string `"This engine has no native sessions."` | Verified (src/ui/aiChatPanel.ts:4020) |

**Hard rule (must be preserved into the final spec): viewing a locally saved transcript must
never be labelled "native resume".** A local transcript is a client-side replay of stored
turns; it is labelled `"Saved transcript"` and can be opened even when the engine reports
resume unsupported. Only the omp path may use the words "resume"/"resumed session".

### 3e. Rename / delete / export (target-state; `new capability (no current source anchor)`)

- **Rename** — `new capability`. Inline edit on the picker row; empty or whitespace-only input
  is rejected and the prior title restored. Rename persists to the session index only.
- **Delete** — `new capability`. Deleting a local index record removes the transcript too and
  requires confirmation with the exact string "Delete this saved transcript? This cannot be
  undone." Deleting an **engine-owned** omp session is **not** offered by this UI
  (`absent in current source` for any engine delete API); the row shows
  "Managed by the omp engine" instead of a Delete control.
- **Export** — replaces the current path. Current export serializes rendered
  `thread.innerText` into a Blob and immediately appends the success notice
  `"Transcript exported as <name>"` with **no host round-trip** — Verified
  (webview/aiChatPanelMain.ts:631), Verified (webview/aiChatPanelMain.ts:640) (gap G4). Target:
  `/export` opens a destination/format flow, the host performs the write, and the UI reports
  success **only after host acknowledgement** — the exact strings and failure mapping are in
  §7e and FAIL-06.
- Export format is **structured JSON**, not rendered `innerText` (per Q11: upstream
  "Chat: Export Chat..." saves prompts and responses as JSON). The JSON record shape is the
  session schema in 3b plus an ordered `turns[]` array.

### Sessions acceptance tests (SESS family)

- **SESS-01** — the picker lists at most 20 sessions, filtered by the current `cwd` and
  sorted by `updatedAt` descending, with the current session excluded.
- **SESS-02** — on `claudeCode`, `codex`, and `builtin`, native resume is disabled and the
  engine-specific string from 3d is shown; no global "resume unavailable" claim is rendered.
- **SESS-03** — opening a locally saved transcript is labelled "Saved transcript" and never
  uses the word "resume".
- **SESS-04** — rename rejects empty/whitespace input and persists a non-empty value; delete
  requires the confirmation string and removes the local transcript.
- **SESS-05** — export writes structured JSON and shows the success string only after the
  host acknowledgement; an unacknowledged write shows FAIL-06 instead.
- **SESS-06** — a session with a non-resumable engine is rendered with `aria-disabled`
  (focusable), not HTML `disabled`, so it remains discoverable.
- **SESS-07** — a failed session-index write leaves the previous index intact (no partial
  overwrite).

---

## 4. Permissions & approvals

### 4a. Current permission surface inventory (facts)

| Surface | What it gates | Anchor status |
|---|---|---|
| `DbToolPermissionGate` (exported class) | Database tool calls in the builtin path; wraps via `DbToolPermissionGate.wrap` | Verified (src/ui/aiChatPanel.ts:809) |
| `permission_request` frame | ACP permission card: `requestId`, `tool`, `options` | Verified (src/ui/aiChatPanelMessages.ts:143) |
| HostMcp gate | In-process MCP permission gate used by all three external engines | Verified (src/ui/aiChatPanel.ts:2918), construct at Verified (src/extension.ts:2433) |
| `permission_response` routing | One wire kind, **two id-namespaces**: DB-tool gate → HostMcp → raw ACP bridge | Verified (src/ui/aiChatPanel.ts:1668–1679) |
| Timeout | Default deny after 60 s — `DEFAULT_PERMISSION_TIMEOUT_MS` | Verified (src/ui/aiChatPanel.ts:123), Verified (src/ui/aiChatPanel.ts:3629) |
| Bypass | Session-scoped, default OFF, never persisted; when ON the webview receives no card | Verified (src/ui/aiChatPanel.ts:1727), Verified (src/ui/aiChatPanel.ts:3599), Verified (src/ui/aiChatPanel.ts:2933) |
| Plan approval | Separate consent path: `plan_approve` / `plan_reject` on the `change_plan` card, re-validated against the live schema via `confirmDangerousStatements` | Verified (src/ui/aiChatPanelMessages.ts:241), Verified (src/ui/aiChatPanelMessages.ts:253), Verified (src/ui/aiChatPanelMessages.ts:258), Verified (src/ui/aiChatPanel.ts:4357) |
| Durable policy surface | `UnicDB.ai.showPolicy` is the only durable policy view | Verified (package.json:282) |

**Codex caveat (must be stated honestly):** the HostMcp gate is constructed and bridged for
the codex lane, but the codex CLI route passes no `--mcp-config` in `codex exec` mode, so the
gate is **not reachable by the documented CLI route** — Verified (src/extension.ts:2491),
Verified (src/extension.ts:2479). The codex permissions cell therefore stays
`Unverified-internal` in §6.

### 4b. Target approval model (Cline-informed, VS Code-adapted)

Current behavior is one session-scoped bypass toggle plus a per-request card. The target
adopts Cline's **escalating, per-tool-class** shape (Q12: auto-approve is "evaluated per tool
call" across labeled toggles, with "all files"/"all commands" requiring their base toggle) and
adapts it to VS Code policy keys (Q22: auto-approve modes are harness-specific and must stay
engine-gated).

- **Approval classes** (each independently configurable): `read-project-files`,
  `edit-project-files`, `run-safe-commands`, `run-all-commands`, `db-read`, `db-write`,
  `mcp-tools`. The two escalation pairs (`edit all files` over `edit project files`;
  `run all commands` over `run safe commands`) require their base class ON — enabling the
  broad class alone does nothing (per Q12).
- **Per-request default is deny.** An omitted `optionId`, a duplicate response, or the 60 s
  timeout resolves to `cancelled` with exactly one result per request — preserving the
  current invariant — Verified (src/ui/aiChatPanel.ts:3649–3677).
- **Bypass stays session-scoped and default-OFF** unless a durable policy is explicitly
  opted into; the target adds a durable policy view (not a silent default change). A durable
  bypass must be visibly indicated in the header for the whole session.
- **Plan approval is a distinct consent path from tool approval** and keeps its re-validation
  plus `confirmDangerousStatements` before execution — Verified (src/ui/aiChatPanel.ts:4357).
- **Capability gating:** engines that never surface a permission card (or whose gate is not
  reachable, e.g. codex `codex exec`) must show the class as `Unavailable for this engine`,
  never a toggle that silently does nothing.
- **Prompt content:** each card names the concrete target (file path, SQL statement, command
  line) and the class it falls under; the card never obscures *what* is being approved (a
  plan approval is not a substitute for a per-tool card, and vice versa).

### Permissions acceptance tests (PERM family)

- **PERM-01** — an unanswered request settles to deny at 60 s with a `cancelled` outcome and
  exactly one result per `requestId`.
- **PERM-02** — enabling `run all commands` without `run safe commands` produces no change
  in what is auto-approved (base-toggle dependency).
- **PERM-03** — bypass is OFF by default, does not persist across reloads unless durably
  opted in, and when ON the webview receives no card.
- **PERM-04** — an engine whose gate is unreachable shows its approval classes as
  "Unavailable for this engine" rather than as inert toggles.
- **PERM-05** — plan approve re-validates against the live schema and runs the dangerous-
  statement confirmation before any statement executes; reject discards without executing.
- **PERM-06** — `permission_response` with an id in either namespace (DB-tool or HostMcp)
  resolves against the correct pending request, never cross-resolving namespaces.

---

## 5. Failures & recovery

Every class below has an exact proposed user-visible string in quotes, a recovery action, and
a FAIL-xx ID. Current strings are quoted verbatim from anchors; proposed strings are marked
`proposed`.

| ID | Failure class | Trigger | User-visible message (exact) | Recovery action | Anchor status |
|---|---|---|---|---|---|
| FAIL-01 | Mid-stream disconnect | The `delta`/`assistant` stream stops without `done` or `error` (transport drops) | `"Connection lost during the response. The partial reply is kept."` (proposed) | Keep the partial bubble; offer "Retry" that re-runs the last user turn; never auto-retry silently | `new capability`; current gap: no disconnect detection — Verified (src/ui/aiChatPanel.ts:2480) shows Stop alone produces no error path |
| FAIL-02 | Engine process exit | External engine child exits mid-turn (codex one-shot per turn, claudeCode disposed) | `"codex process start failed: <msg>"` (current, codex) / `"claude code chat engine is disposed"` (current, claudeCode) | Mark the turn failed; "Restart engine" re-spawns; the transcript is preserved | Verified (src/ai/codex/codexChatEngine.ts:320), Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:169) |
| FAIL-03 | Permission denied / timed out | User denies, or no response within 60 s | `"Permission denied."` for an explicit deny; `"Permission request timed out and was denied."` for the 60 s path (both proposed) | The blocked tool action is skipped; the turn continues where possible; the timeline records the denied tool with `status: "denied"` | Verified (src/ui/aiChatPanel.ts:3629) for timeout semantics; strings proposed |
| FAIL-04 | Unresolvable context item | A mention/file reference cannot be resolved at send time | `"This context item could not be resolved: <name>. Remove it or send without it."` (proposed) | Block the send until the chip is removed, replaced, or the user chooses explicitly to send without it; never silently omit | Baseline draft §Mention chip rule; `new capability` for the string |
| FAIL-05 | Stale / missing session | Resume requested for a session id the engine no longer holds | `"That session is no longer available on this engine."` (proposed); unsupported engines keep `"Claude Code session resume is unavailable"` / `"Codex session resume is unavailable"` / `"Resume requires the omp engine."` | Re-open the picker and refresh the list; if a local transcript exists, offer "Open saved transcript" (which is **not** native resume) | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:280), Verified (src/ai/codex/codexChatEngine.ts:364), Verified (src/ui/aiChatPanel.ts:4020) |
| FAIL-06 | Export write failure | Host write of the structured transcript fails or is unacknowledged | `"Export failed. Nothing was written."` (proposed) — replaces the current optimistic `"Transcript exported as <name>"` | Keep the transcript unchanged; offer "Retry export" and "Save a copy…"; never show success before host acknowledgement | Current optimistic path Verified (webview/aiChatPanelMain.ts:640) (gap G4) |
| FAIL-07 | Render failure | Terminal `assistant` render throws (markdown/SQL highlight) | `"Could not render the final response. Showing the streamed text."` (proposed) | Keep the last good streamed render visible; log internally; do not blank the bubble | `new capability`; streaming render path Verified (webview/aiChatPanelMain.ts:1223–1248) |
| FAIL-08 | Engine not configured / fallback | The requested engine seam is not wired | `"<engine> is not configured; falling back to builtin for this turn."` (current) | Run the builtin turn; mark the fallback in the timeline so the user knows which engine answered | Verified (src/ui/aiChatPanel.ts:2880) |
| FAIL-09 | AI not configured | No base URL / API key | Current enriched error bubble naming the Open AI Settings path | Offer "Open AI Settings"; do not retry automatically | Verified (src/ai/agent.ts:307), Verified (src/ui/aiChatPanel.ts:2497) |
| FAIL-10 | Provider stream fails before any chunk | Zero chunks then a provider error | `"stream fallback"` step label (current) followed by a non-streaming retry | Non-streaming retry is transparent; only surface an error if the retry also fails | Verified (src/ai/agent.ts:274), Verified (src/ui/aiChatPanel.ts:2369) |

**Cross-cutting recovery rules:** (1) no failure class may erase the transcript — recovery
always preserves already-rendered content; (2) no automatic infinite retry — every retry is
either one bounded transparent retry (FAIL-10) or explicitly user-triggered; (3) every class
maps to a timeline event so the failure is visible in history, not only in a transient banner
(links to TIME-03).

### Failure acceptance tests (FAIL family)

- **FAIL-01** — a stream that ends without `done`/`error` shows the disconnect string, keeps
  the partial reply, and offers a working Retry.
- **FAIL-02** — an engine exit shows the engine's exact current string and preserves the
  transcript; "Restart engine" re-spawns successfully.
- **FAIL-03** — deny and 60 s timeout both resolve to exactly one denied result and produce
  their distinct strings (denied vs timed-out).
- **FAIL-04** — a send with an unresolvable chip is blocked with the resolution string until
  the user removes/replaces it or explicitly sends without it.
- **FAIL-05** — a stale session id shows the missing-session string and re-opening the picker
  refreshes the list; a local transcript is offered as "saved transcript", never "resume".
- **FAIL-06** — a simulated host write failure shows "Export failed. Nothing was written."
  and never shows the success string.
- **FAIL-07** — a terminal render exception keeps the streamed text visible and shows the
  render-failure string.
- **FAIL-08/09/10** — fallback, unconfigured-provider, and pre-chunk stream failures each
  show their mapped strings and never erase the transcript.

---

## 6. Engine capability matrix

Four engine rows × eight capability columns. Every cell is `Verified (file:line)`,
`Unverified-internal`, or `absent in current source` — no invented capability. Columns:
streaming, resume, native commands, model/role picker, sessions/persistence,
permissions/approvals, activity/timeline events, failure modes.

### 6a. `builtin` (in-panel fallback; no adapter file)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `onText` posts `delta`; route through `runAgent` → `provider.streamComplete` | Verified (src/ui/aiChatPanel.ts:2358) |
| resume | No session concept; list/pick hard-error for non-omp | absent in current source — Verified (src/ui/aiChatPanel.ts:4020) |
| native commands | Closed six-command registry only (`clear`/`resume`/`engine`/`context`/`export`/`model`) | absent in current source — Verified (src/ui/aiChatPanelCommands.ts:2) |
| model/role picker | `buildModelsFrame`; header chip path | Verified (src/ui/aiChatPanel.ts:1899) |
| sessions/persistence | In-memory `this.history` only; nothing written to disk | absent in current source — Verified (src/ui/aiChatPanel.ts:2469) |
| permissions/approvals | `DbToolPermissionGate.wrap`; plan approve via `confirmDangerousStatements` | Verified (src/ui/aiChatPanel.ts:809) |
| activity/timeline events | No timeline UI; trace ring is in-memory only | absent in current source — Verified (src/ai/trace.ts:11) |
| failure modes | Abort branch swallows the error; config error enriched | Verified (src/ui/aiChatPanel.ts:2480) |

### 6b. `omp` (ACP child process)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `agent_message_chunk` → `onDelta` | Verified (src/ai/omp/ompChatEngine.ts:273) |
| resume | `sessionList`; load path; omp-only | Verified (src/ui/aiChatPanel.ts:4018) |
| native commands | `available_commands_update` explicitly ignored | absent in current source — Verified (src/ai/omp/ompChatEngine.ts:332) |
| model/role picker | Panel-wide `activeRole`; no engine-native model switch | Verified (src/ui/aiChatPanel.ts:1930) |
| sessions/persistence | ACP `session/list`; storage owned by the omp child | Verified (src/ai/omp/acp.ts:213) |
| permissions/approvals | `permission_request` frame; HostMcp gate | Verified (src/ui/aiChatPanel.ts:3636) |
| activity/timeline events | Trace recorder is not rendered | absent in current source — Verified (src/ai/trace.ts:11) |
| failure modes | `session/new failed:` / `session/new cancelled:` | Verified (src/ai/omp/ompChatEngine.ts:390) |

### 6c. `claudeCode` (subprocess adapter)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `ClaudeCodeChatEvents` mirrors omp; panel route | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:48) |
| resume | `RESUME_UNSUPPORTED_MESSAGE`; refuses to spawn | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:280) |
| native commands | No parser or command surface | absent in current source |
| model/role picker | Panel applies `activeRole` generically; no model/CLI mapping | Unverified-internal — `send` carries no model param (src/ai/claudeCode/claudeCodeChatEngine.ts:63–67) |
| sessions/persistence | One process, no session store | absent in current source |
| permissions/approvals | `createHostMcp({gatePost…})` + `--mcp-config` written | Verified (src/extension.ts:2433) |
| activity/timeline events | None rendered | absent in current source |
| failure modes | `disposed`; hostMcp start failed | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:169) |

### 6d. `codex` (subprocess adapter)

| Capability | Current cell | Evidence |
|---|---|---|
| streaming | `CodexChatEvents` carried over stdin | Verified (src/ai/codex/codexChatEngine.ts:64) |
| resume | `"Codex session resume is unavailable"` | Verified (src/ai/codex/codexChatEngine.ts:364) |
| native commands | No parser or command surface | absent in current source |
| model/role picker | Same gap as claudeCode; `send` accepts no model arg | Unverified-internal — (src/ai/codex/codexChatEngine.ts:114–118) |
| sessions/persistence | No session store | absent in current source |
| permissions/approvals | HostMcp constructed and bridged, but no `--mcp-config` on the documented `codex exec` route | Unverified-internal — Verified (src/extension.ts:2491), Verified (src/extension.ts:2479) |
| activity/timeline events | None rendered | absent in current source |
| failure modes | Process start failed; resume unavailable | Verified (src/ai/codex/codexChatEngine.ts:320) |

**Matrix self-check:** 4 rows × 8 columns = 32 cells; ≥16 cells carry a distinct
`Verified (file:line)` anchor (builtin 4, omp 6, claudeCode 4, codex 3 = 17 minimum, plus the
section-level anchors cited elsewhere in this note). Every non-verified cell is explicitly
`Unverified-internal` or `absent in current source`.

**Target-state overlay (what the redesign changes per engine):** resume becomes a per-engine
capability the UI must render honestly (SESS-02/03, FAIL-05); native commands become a
capability-gated group (§7f); timeline events are derived from carriers all four engines
already emit, so the timeline itself is not engine-gated — only its richness is (§2b).

---

## 7. Engine-gated command reconciliation (`/engine` `/model` `/resume` `/context` `/export` + native commands)

**Boundary:** the menu anatomy, argument grammar presentation, and keyboard interaction for
these commands are TASK-AICHAT-004's — `→ see TASK-AICHAT-004 / aichat-sections-composer.md`.
This section owns only their **backend semantics, capability gating, and wording rules**.

### 7a. `/engine` — parser-vs-protocol mismatch (explicit resolution)

Two anchors disagree and the redesign must resolve both, not paper over one:

1. `src/ui/aiChatPanel.ts:1744–1816` (`handleCommand("engine" | "model", args)`) accepts
   exactly two literals (`builtin`, `omp`) and otherwise posts
   `"Usage: /engine builtin|omp"` — Verified (src/ui/aiChatPanel.ts:1744), Verified
   (src/ui/aiChatPanel.ts:1779).
2. `src/ui/aiChatPanelMessages.ts:91–106` advertises four engines in the `engine` frame's
   `name` union (`omp` / `claude-code` / `codex` / `builtin`) — Verified
   (src/ui/aiChatPanelMessages.ts:91), Verified (src/ui/aiChatPanelMessages.ts:102).

**Resolution rule (target-state):** `/engine` becomes **capability-gated command visibility**,
not a fixed two-literal parser:

- The set of engines named by `/engine` is exactly the set the host reports as *available and
  switchable in this session*. Engines wired through VS Code commands
  (`UnicDB.ai.useWithClaudeCode` / `UnicDB.ai.useWithCodex`, `package.json:264` and
  `package.json:270`) are switched through those commands; `/engine` must not accept a literal
  it cannot actually switch to, and must not silently reject one it can.
- Invalid/unknown arguments keep the draft and show a corrective example; they do **not**
  create an assistant reply bubble (baseline §Slash contract; the interaction part is
  TASK-AICHAT-004's).
- A switch never reruns the last prompt automatically (baseline rule, preserved).
- The host must acknowledge a switch before the UI claims it took effect ("do not claim a
  switch before acknowledgement").
- The new failure string is `"Engine <name> is not available in this workspace."` (proposed)
  for a known-but-unavailable engine, replacing the misleading
  `"Usage: /engine builtin|omp"` when the literal is in fact a real engine.

### 7b. `/model` — role picker, host-authoritative

Current `/model` text path accepts only `work` or `smart` — Verified
(src/ui/aiChatPanel.ts:1757) — while `AiModelRole` has four members and the `model_select`
wire message accepts the full set — Verified (src/ui/aiChatPanelMessages.ts:435). Target
rule (grounded in Q16: upstream separates *role* from *model*):

- `/model` opens the host-authoritative **role** picker; the accepted set is the host's
  configured roles, not a hardcoded pair.
- Arbitrary model ids are never accepted; a raw model id typed after `/model` is treated as
  an invalid argument (draft preserved, corrective example shown).
- The switch is only reflected after the host `models` frame acknowledges it — no optimistic
  label change.

### 7c. `/resume` — native resume vs local transcript (wording preserved)

- `/resume` opens the session picker; unsupported native resume is disabled **and explained
  per backend** with the exact strings in §3d — Verified
  (src/ai/claudeCode/claudeCodeChatEngine.ts:105), Verified (src/ai/codex/codexChatEngine.ts:364),
  Verified (src/ui/aiChatPanel.ts:4020).
- **"Local transcript ≠ native resume" is preserved verbatim as a spec rule:** opening a
  locally saved transcript replays stored turns, is labelled `"Saved transcript"`, and may be
  offered even where native resume is unavailable; only omp may use resume wording. This
  directly follows the baseline §Source anchors rule ("Viewing a locally saved transcript
  must not be labelled native resume") and Q05's participant-scoped, opt-in history model.

### 7d. `/context` — inspector, not a count

Current `/context` is webview-local and prints only history-present plus queued-attachment
count — Verified (webview/aiChatPanelMain.ts:658). On the wire, the real context surfaces are
`grounding_state`/`grounding_toggle`, `mention_objects`/`mention_miss`/`mention_list`,
`models`, and `schemaChanged` — Verified (src/ui/aiChatPanelMessages.ts:188),
Verified (src/ui/aiChatPanelMessages.ts:308), Verified (src/ui/aiChatPanelMessages.ts:467),
Verified (src/ui/aiChatPanelMessages.ts:292). Target rule:

- `/context` opens an inspector listing the **actual** selected items with their chip
  identities, plus explicit exclusions and privacy boundaries — never merely a count
  (`grounding_state.excludedCount` alone is insufficient — Verified
  (src/ui/aiChatPanelMessages.ts:190)).
- The inspector must not trigger a model call (it is read-only over already-known state).
- No new wire frame is required for the items already on the wire; exclusions currently carry
  no detail, so a detail field is a `new capability (no current source anchor)` (links Q18's
  privacy-flag precedent).

### 7e. `/export` — confirmed host write

Current path is webview-local, lossy, and optimistic: it serializes rendered `innerText` and
immediately appends `"Transcript exported as <name>"` with no host round-trip — Verified
(webview/aiChatPanelMain.ts:631), Verified (webview/aiChatPanelMain.ts:640), and there is **no**
export message in either protocol union (`absent in current source`; TASK-002 §3c). Target
rule:

- `/export` opens a destination/format flow; the host performs the write; the success string
  is shown **only after the host acknowledgement**, otherwise FAIL-06 fires.
- The payload is the structured JSON session record (3b), not rendered `innerText`
  (per Q11's JSON export precedent).
- The operation is idempotent-safe: a re-export overwrites only with confirmation if the
  destination exists.

### 7f. Provider-native command gating

`available_commands_update` from ACP is explicitly ignored today — Verified
(src/ai/omp/ompChatEngine.ts:332). Target rule (grounded in Q02/Q08: commands are
registered, first-class metadata; Q22: provider-native capabilities must stay engine-gated):

- Local commands and provider-native commands are **separately labelled groups** in one menu;
  native commands are shown only when the active engine actually advertises them.
- Unknown/provider-native commands are never mapped to shell execution and never silently
  reach a backend (baseline rule preserved). The `!`-terminal escape documented for VS Code is
  **engine-gated, not universal** (Q07: "only available in Agent Host sessions").
- Never promise an identical command set across engines; a command absent for the active
  engine is simply not listed, and a typed-but-unsupported native command shows the corrective
  invalid-argument treatment (draft preserved).

### Engine-gated acceptance tests (mapped into SESS/FAIL families)

- **SESS-08** — `/engine` lists exactly the engines available and switchable in this session;
  a known-but-unavailable literal shows `"Engine <name> is not available in this workspace."`
  and preserves the draft.
- **SESS-09** — `/model` accepts only host-configured roles and reflects the switch only after
  the `models` acknowledgement; an arbitrary model id preserves the draft.
- **SESS-10** — `/context` lists actual items, exclusions, and privacy boundaries, and
  performs no model call.
- **FAIL-11** — `/export` shows success only after host acknowledgement; an unacknowledged
  write shows FAIL-06.
- **FAIL-12** — a typed provider-native command that the active engine does not advertise is
  never executed via a shell and never creates an assistant bubble (draft preserved).

---

## 8. Visual acceptance (VIS family — NEW rendered surfaces)

Geometry/a11y for the composer and the shared slash/mention popover belongs to
TASK-AICHAT-004 and is **not** repeated here — `→ see TASK-AICHAT-004 /
aichat-sections-composer.md`. This section covers only the **new** rendered surfaces owned by
this note: stream area, activity timeline, session picker, permission prompts, failure
banners. All values are target-state `new capability (no current source anchor)` unless an
anchor is given.

**Shared rendering facts (Verified):** webviews receive body classes `vscode-light`,
`vscode-dark`, `vscode-high-contrast`, `vscode-reduce-motion`, and
`vscode-using-screen-reader`; theme colors are exposed as CSS variables with `.`→`-` (per Q06,
Verified-with-URL). Theme tokens named below are real VS Code IDs from the theme-color
reference (Q06).

- **VIS-01 — Stream area: layout & typography.** Assistant bubbles use
  `var(--vscode-editorWidget-background)` with a 1 px `var(--vscode-editorWidget-border)`
  border and 8 px radius; body text `13px/20px` in `var(--vscode-foreground)`; the reasoning
  (`thought`) sub-block is `12px/18px` in `var(--vscode-descriptionForeground)`; streaming
  caret is a 2 px `var(--vscode-focusBorder)` bar. Markdown reflow during streaming must not
  change line-height (no vertical jitter between flushes).
- **VIS-02 — Stream area: stick-to-bottom & affordance.** The "Jump to latest" pill is
  bottom-center with a 12 px bottom offset, height 28 px, `var(--vscode-button-background)` /
  `var(--vscode-button-foreground)`; it appears only when the 24 px threshold (STREAM-04) is
  exceeded and reaches ≥4.5:1 contrast in all three theme classes.
- **VIS-03 — Activity timeline: node and connector.** Rows use
  `var(--vscode-editorWidget-background)`, 12 px horizontal padding, 8 px vertical gap;
  the connector line uses `var(--vscode-chat-checkpointSeparator)` at 1 px (Q13's dotted-line
  timeline precedent); status badges are 16 px icons with text labels at `11px/16px` in
  `var(--vscode-descriptionForeground)`; a `failed` badge uses `var(--vscode-errorForeground)`.
- **VIS-04 — Session picker: rows and secondary line.** Width min(420px, panel width),
  viewport gutter 8 px, row min-height 44 px, primary title `13px/20px`, secondary
  engine+timestamp `11px/16px` in `var(--vscode-descriptionForeground)`; the active row uses
  `var(--vscode-list-activeSelectionBackground)` / `var(--vscode-list-activeSelectionForeground)`;
  a disabled (non-resumable) row keeps full opacity for its text but shows a
  `Unavailable` label — never a greyed-out-only signal (color is not the sole carrier).
- **VIS-05 — Permission prompt: card anatomy.** Card uses
  `var(--vscode-editorWidget-background)` with `var(--vscode-editorWidget-border)`, 12 px
  padding, 8 px gap; the concrete action target (path/SQL/command) is `13px/20px` in
  `var(--vscode-foreground)` and is never truncated to an ellipsis-only; Approve uses
  `var(--vscode-button-background)`, Deny uses a secondary button style; the 60 s countdown is
  text, not a color-only bar. A bypass-ON session shows a persistent header badge with the
  text `"Permissions bypassed"`.
- **VIS-06 — Failure banner: placement and non-destructiveness.** Banners render inline at the
  failed turn, use `var(--vscode-inputValidation-errorBackground)` /
  `var(--vscode-inputValidation-errorBorder)` with `var(--vscode-errorForeground)` text at
  `12px/18px`, 8 px padding, and never cover the streamed text they describe; the banner
  contains at most one primary recovery action plus the failure string.
- **VIS-07 — 200% zoom.** At 200% browser zoom in a 480 px-wide panel, every new surface
  (stream area, timeline, session picker, permission prompt, failure banner) remains readable
  with no horizontal scrollbar, no clipped recovery button, and no overlap between the
  "Jump to latest" pill and the failure banner.
- **VIS-08 — Reduced motion & forced themes.** Under `vscode-reduce-motion`, every transition
  on the new surfaces is disabled (stream caret blink, timeline disclosure animation, banner
  fade) and content appears instantly; in `vscode-light`, `vscode-dark`, and
  `vscode-high-contrast`, all named tokens resolve to the theme's values (no hardcoded
  fallback overriding a present token), focus outlines use `var(--vscode-focusBorder)` at
  2 px with 2 px offset, and contrast is ≥4.5:1 for body text and ≥3:1 for borders/icons.

**Legacy real-token note:** `editorWidget.background`, `editorWidget.border`, `foreground`,
`descriptionForeground`, `list.activeSelectionBackground`, `list.activeSelectionForeground`,
`focusBorder` are Verified-with-URL theme IDs (Q06); the chat-specific
`chat.slashCommandBackground`, `chat.slashCommandForeground`, `chat.requestBubbleBackground`,
`chat.checkpointSeparator` are also Verified-with-URL and are the preferred upgrades where
they apply (Q06).

---

## 9. Research grounding index (`per Qxx`)

| Rule in this note | Research basis |
|---|---|
| 1b coalescing / announce-not-per-token | Streaming is incremental and typed, but announcements are polite and not per token — per Q04 |
| 1e stop/cancel, no queueing inferred | Stop is an explicit action; queue/steer are separate labeled actions — per Q10 |
| 2c timeline node/connector | Checkpoint dotted-line timeline with separate Compare/Restore — per Q13 |
| 3b/3e privacy + structured export | Single privacy flag strips prompts/code; JSON export precedent — per Q18 |
| 3c/3e session picker, time grouping, export format | Upstream session units, time buckets, "Export Chat..." as JSON — per Q05 |
| 4b per-tool approval classes | Auto-approve is evaluated per tool call with base-toggle escalation — per Q12 |
| 4b/7f engine-gated policy and native commands | Auto-approve and provider-native escapes are harness-specific, never universal — per Q22 |
| 7b role vs model | Config keeps role separate from model — per Q16 |
| 7e/3e structured JSON export | Structured export replaces innerText serialization — per Q11 |
| 8 VIS-01..VIS-08 tokens/motion/themes | Theme IDs, `vscode-reduce-motion`, `vscode-light/dark/high-contrast` — per Q06 |
| 3g/4 non-resumable rows discoverable | Prefer `aria-disabled` over HTML `disabled` so screen readers can find them — per Q21 |
| 7f local vs native command groups | Commands are registered first-class metadata with bounded sets — per Q02/Q08 |

Evidence labels for the external claims above are inherited verbatim from TASK-AICHAT-003:
every row is `Verified-with-URL`; Q17's in-IDE cancel/retry sub-part is `Could-not-verify`,
which is exactly why §1e's stop/retry contract is stated as an UnicDB target rule rather than
attributed to an upstream precedent.

---

## 10. Cross-task boundary and hand-off

- Composer keyboard precedence, slash-menu interaction contract/anatomy, mention menu,
  autocomplete geometry/a11y, KBD/SLASH/MENTION/A11Y families — owned by TASK-AICHAT-004:
  `→ see TASK-AICHAT-004 / aichat-sections-composer.md`. No rule from those sections is
  restated here.
- This note's acceptance families are STREAM, TIME, SESS, PERM, FAIL, VIS, with the
  engine-gating checks folded into SESS/FAIL (SESS-08/09/10, FAIL-11/12) rather than a new
  orphan family, matching the plan's index.
- TASK-AICHAT-006 merges this note with the composer note into `docs/AI_CHAT_REDESIGN.md`;
  no ID here collides with the KBD/SLASH/MENTION/A11Y families.

---

## Verification log (this note)

Document-acceptance commands from this task's §Verification Commands are run in worktree
`/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-aichat-005`; the full pre-write
(RED) and post-write (green) transcripts are reproduced in the task file's `## Executor
Report`.
