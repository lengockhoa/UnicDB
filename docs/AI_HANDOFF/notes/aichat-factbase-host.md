# AI Chat host/engine fact-base (TASK-AICHAT-002)

Read-only research note. Every claim below is either anchored to `file:line` in this
worktree's current source or explicitly marked `absent in current source` /
`Unverified-internal`. No runtime source was modified. Baseline input:
`docs/AI_CHAT_REDESIGN.md` §Source anchors (read-only).

Method: full-tree Glob sweep first (§1), then targeted deep reads of the host UI layer
and the three external engine adapters (§2–§6). Line numbers are from this worktree at
the commit recorded in the milestone commits.

---

## 1. Glob sweep — search inventory

Commands run (from the worktree root, covering both `src/` and `webview/`):

```bash
find src webview -type f \( -iname '*chat*' \) | sort
find src webview -type f \( -iname '*session*' \) | sort
find src webview -type f \( -iname '*stream*' \) | sort
find src webview -type f \( -iname '*perm*' \) | sort
find src webview -type f \( -iname '*approv*' -o -iname '*confirm*' \) | sort
find src webview -type f \( -iname '*timeline*' -o -iname '*activity*' -o -iname '*trace*' \) | sort
find src webview -type f \( -iname '*attach*' \) | sort
find src webview -type f \( -iname '*engine*' -o -iname '*adapter*' -o -iname '*provider*' \) | sort
find src -iname '*builtin*'
```

Results, with role and read depth. `deep` = read in full or in the cited region this cycle.

### 1a. Match term `*chat*`

| File | Role | Depth |
|---|---|---|
| `src/ui/aiChatPanel.ts` (4575 lines) | Host controller: message dispatch, send/stop/clear/resume/mention/plan, engine tumble, permission bridge | deep |
| `src/ui/aiChatPanelMessages.ts` (486 lines) | Host↔webview wire contract (both directions) | deep |
| `src/ui/aiChatPanelCommands.ts` (84 lines) | Closed slash-command registry + argument parser | deep |
| `src/ui/aiChatAttachments.ts` (236 lines) | Pure attachment validation / magic-byte table | deep |
| `src/ai/omp/ompChatEngine.ts` (524 lines) | omp (ACP) chat engine adapter | deep |
| `src/ai/claudeCode/claudeCodeChatEngine.ts` (313 lines) | Claude Code chat engine adapter | deep |
| `src/ai/codex/codexChatEngine.ts` (388 lines) | Codex chat engine adapter | deep |
| `webview/aiChatPanelMain.ts` | Webview controller: host-message switch, send/stop/clear/export, composer callbacks | deep |
| `webview/aiChatPanelComposer.ts` | Composer DOM, slash/mention insertion, model chip, bypass toggle | targeted |
| `webview/aiChatPanelHeader.ts` | Engine banner + session-state chip labels | targeted |
| `webview/aiChatPanelThread.ts` | Thread/bubble rendering helpers | not relevant to this task |
| `src/ui/__tests__/aiChat*.test.ts` (34 files) | Existing behavioral suites | inventory only |

### 1b. Match term `*session*`

| File | Role | Depth |
|---|---|---|
| `src/ui/aiChatPanel.ts` | Session list/load/pick host handlers; `session_state` posts; ACP session cache | deep |
| `webview/aiChatPanelMain.ts` | Resume picker render, session-state chip delegation | targeted |
| `src/ui/adminSessionsPanel.ts` | Postgres admin DB-session panel — unrelated to AI chat | not relevant |
| `src/ui/__tests__/aiChatPanelSessionState*.test.ts`, `aiChatPanelResume.test.ts` | Existing suites | inventory only |

### 1c. Match term `*stream*`

| File | Role | Depth |
|---|---|---|
| `src/ai/__tests__/agentStream.test.ts` | Test-only. There is **no** `stream.ts` production file; streaming lives in `src/ai/provider.ts` (`streamComplete`, :675) and `src/ai/agent.ts` (`streamComplete` deps, :55) | inventory only |

### 1d. Match term `*perm*`

| File | Role | Depth |
|---|---|---|
| `src/ui/permissionDetail.ts` | Permission-card detail renderer used by the webview | targeted |

No `*permission*gate*.ts` file exists; the DB-tool gate is the exported class
`DbToolPermissionGate` inside `src/ui/aiChatPanel.ts:809`.

### 1e. Match term `*approv*` / `*confirm*`

| File | Role | Depth |
|---|---|---|
| `src/ui/confirmDangerous.ts` | Modal confirmation used by the builtin change-plan approve path | targeted |

There is no `*approval*` file. "Approve/Reject" is expressed as the wire messages
`plan_approve` / `plan_reject` (`src/ui/aiChatPanelMessages.ts:253,258`) and the
`change_plan` card (`:241`).

### 1f. Match term `*timeline*` / `*activity*` / `*trace*`

| File | Role | Depth |
|---|---|---|
| `src/ai/trace.ts` | In-memory, redacting trace recorder (`TraceKind` at :11). Not a UI surface | deep |
| `src/ai/__tests__/trace.test.ts` | Test suite | inventory only |

No `*timeline*` and no `*activity*` file matched under `src/` or `webview/`.
The only "activity" hits in the tree are the VS Code activity-bar in
`src/scaffold.test.ts:113` and `src/extension.ts:409` — unrelated to chat.
`grep -rniE "timeline|activity" src webview` (non-test files) returns nothing chat-related.

### 1g. Match term `*attach*`

| File | Role | Depth |
|---|---|---|
| `src/ui/aiChatAttachments.ts` | Canonical pure helpers + caps | deep |
| `webview/attachLimits.ts` | Webview-side size/count mirrors | targeted |

### 1h. Match term `*engine*` / `*provider*` (chat-relevant subset)

| File | Role | Depth |
|---|---|---|
| `src/ai/engineChoice.ts` (204 lines) | Pure engine-resolution policy; the real `builtin` selection anchor is `AI_ENGINE_VALUES` at :83–88 and the `builtin` early-return at :150–152. The task hints at `:9–21`; `:9–21` is the doc-comment that names all four engines | deep |
| `src/ai/settings.ts` | `AiEngine = "builtin" \| "omp" \| "claude-code" \| "codex"` at :24; `AiModelRole` at :13 | targeted |
| `src/ai/provider.ts` | Builtin (OpenAI-compatible) client; `complete` / `streamComplete` at :675 | targeted |
| `src/ai/omp/hostMcp.ts` | In-process MCP server + permission gate used by all three external engines | targeted |
| `src/extension.ts` | Wires the chosen engine into the panel (`buildOmpChatEngine` :2338, `buildClaudeCodeChatEngine` :2428, `buildCodexChatEngine` :2486) | targeted |
| `src/ai/omp/acp.ts` | ACP transport: `sessionList` :213, `sessionLoad` :252 | targeted |

`find src -iname '*builtin*'` returns **no file**. There is no `builtinChatEngine.ts`;
builtin is the in-panel fallback route `AiChatPanel.runBuiltinTurn`
(`src/ui/aiChatPanel.ts:2289`) driving `runAgent` + `provider.streamComplete`.

---

## 2. Draft anchor verdicts

Baseline §Source anchors quotes each range; verdicts below.

### 2a. `src/ui/aiChatPanelCommands.ts:1–83` — corrects (actual: registry `:2–9`, parser `:36–84`)

The file is **84** lines, so the cited end at 83 stops one line short. The registry is
`export const AI_CHAT_COMMANDS = ["clear","resume","engine","context","export","model"] as const;`
(`:2–9`), and the parser:

```ts
export function parseAiChatCommand(input: string): ParsedAiChatCommand | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
```

The draft's claim ("existing command registry and argument parser are in
`aiChatPanelCommands.ts:1–83`") is substantively correct; only the end line is off by one.

### 2b. `src/ui/aiChatPanel.ts:1744–1816` — confirms (actual: `handleCommand` spans `:1744–1817`)

`private async handleCommand(command: "engine" | "model", args: string[])` starts at `:1744`
and its closing brace is at `:1817` (one line past the cited end). The draft's core claim —
host `/engine` accepts only builtin/omp:

```ts
if (args.length !== 1 || (target !== "builtin" && target !== "omp")) {
  this.post({ type: "error", message: "Usage: /engine builtin|omp" });
```

is exact (`:1779–1781`).

### 2c. `src/ui/aiChatPanelMessages.ts:91–106` — corrects (actual: interface `:92–107`, four-engine union `:102`)

The `AiChatPanelEngine` interface begins at `:92` (doc comment at `:91`) and ends at `:107`.
The four-engine claim is exact:

```ts
name: "omp" | "claude-code" | "codex" | "builtin";
```

at `:102`.

### 2d. `src/ai/claudeCode/claudeCodeChatEngine.ts:272–279` — corrects (actual: `:273–281`)

The `resume` method is at `:273–281`; the cited range starts one line early and ends two
lines early. The cited behavior is exact:

```ts
async resume(sessionId, events): Promise<void> {
  void sessionId;
  events.onError?.(RESUME_UNSUPPORTED_MESSAGE);
},
```

with `RESUME_UNSUPPORTED_MESSAGE = "Claude Code session resume is unavailable"` at `:105`.

### 2e. `src/ai/codex/codexChatEngine.ts:357–364` — corrects (actual: `:358–365`)

`async resume(_sessionId, events)` is at `:358`; the closing `},` is `:365`. Cited end is
one line short. Behavior exact:

```ts
async resume(_sessionId, events): Promise<void> {
  events.onError?.("Codex session resume is unavailable");
},
```

All five cited anchor files exist and the substantive claims hold; four ranges are off by
1–2 lines and one by 1 line. Anchor bounds all hold:
`aiChatPanel.ts` 4575 ≥ 1816, `aiChatPanelMessages.ts` 486 ≥ 106,
`claudeCodeChatEngine.ts` 313 ≥ 279, `codexChatEngine.ts` 388 ≥ 364.

---

## 3. Protocol inventory (host ↔ webview)

Contract file: `src/ui/aiChatPanelMessages.ts`. Closed unions at `:262–284`
(`AiChatPanelHostMessage`) and `:451–472` (`AiChatPanelWebviewMessage`). The webview switch
(`webview/aiChatPanelMain.ts:1951–2060`) and the host switch
(`src/ui/aiChatPanel.ts:1654–1742`) both have **no `default` branch** — an unrecognised
message on either side is silently ignored.

### 3a. Host → webview (send / stream / session / command / context / error)

| Message (`type`) | Line | Purpose |
|---|---|---|
| `init` | :25 | Panel ready; `hasHistory`, `visionCapable`. Also doubles as Clear reset |
| `step` | :44 | Tool/thinking label for the turn |
| `tool_result` | :51 | Visible tool-outcome card (`ok`/`failed`/`denied`), shape-only summary |
| `assistant` | :59 | Final assistant reply (terminal for a turn) |
| `delta` | :77 | Incremental streaming text |
| `thought` | :87 | ACP `agent_thought_chunk` reasoning chunk |
| `error` | :67 | Non-fatal error bubble (apiKey-free) |
| `done` | :73 | Turn boundary |
| `session_state` | :114 | `connecting`/`running`/`done`/`error` + `turnId` |
| `engine` | :93 | Engine banner; four-literal `name` at :102 |
| `engine_state` | :132 | Six-literal omp lifecycle (`stopped`…`fallback-builtin`) |
| `permission_request` | :143 | ACP permission card: `requestId`, `tool`, `options` |
| `change_plan` | :241 | Reviewed plan card (Approve/Reject) |
| `resume_sessions` | :361 | Resume picker list (≤20, cwd-filtered) |
| `history` | :373 | Replayed transcript on resume, capped by `HISTORY_RENDER_CAP` (:328) |
| `mention_objects` | :308 | ≤30 DB objects + ≤20 files for the `@` menu |
| `mention_miss` | :322 | Unresolved mention token |
| `attach_error` | :172 | Per-attachment rejection (`oversize`/`count_cap`/`unsupported_type`/`mime_mismatch`/`vision_unsupported`) |
| `grounding_state` | :186 | Workspace-grounding chips summary |
| `usage` | :206 | Per-turn tokens + policy notice (shape-safe) |
| `models` | :231 | Active role + configured roles |
| `schemaChanged` | :292 | Active-schema chip fan-out |

### 3b. Webview → host

| Message (`type`) | Line | Purpose |
|---|---|---|
| `ready` | :383 | Webview mounted |
| `send` | :388 | User message + optional `attachments: MinimalAttachment[]` |
| `stop` | :403 | Abort the in-flight turn |
| `clear` | :408 | Reset host history |
| `permission_response` | :416 | `{requestId, optionId?}` — omitted optionId means deny |
| `command` | :423 | Slash command needing host state; **command union is only `"engine" \| "model"`** (:425) |
| `model_select` | :435 | Header chip role pick; full `AiModelRole` |
| `bypass_permissions` | :446 | Session-scoped bypass toggle |
| `resume_list` | :331 | Open resume picker |
| `resume_pick` | :337 | Chosen `sessionId` |
| `resume_cancel` | :343 | Picker dismissed |
| `regenerate` | :354 | Re-run last user turn |
| `mention_list` | :478 | `@` query for candidates |
| `plan_approve` | :253 | Run the reviewed plan |
| `plan_reject` | :258 | Discard the plan |
| `grounding_toggle` | :467 (inline) | Enable/disable workspace grounding |
| `pickActiveSchema` | :472 (inline) | Schema chip click |

### 3c. Export — `absent in current source` as a host→webview message

There is **no** export message in either union. `/export` is executed entirely inside the
webview by `exportTranscript` (`webview/aiChatPanelMain.ts:629–641`), which serialises
`thread.innerText` into a Blob and clicks a download link, then appends a local notice
`:640`. The host is never told a write succeeded or failed. Search terms checked:
`grep -nE "type: \"export|export_" src/ui/aiChatPanelMessages.ts` → no match.

### 3d. Context — `/context` is webview-local; no host round trip

`/context` (`webview/aiChatPanelMain.ts:658–662`) prints a client-side summary
(`state.hasHistory`, `state.pendingAtts.length`). The actual context surfaces on the wire are
`grounding_state` / `grounding_toggle`, `mention_objects` / `mention_miss` / `mention_list`,
`models`, and `schemaChanged`. There is no message that enumerates exclusions or privacy
boundaries; `grounding_state.excludedCount` (`src/ui/aiChatPanelMessages.ts:190`) is a number
with no accompanying detail.

---

## 4. Four-engine capability matrix

Four engine rows × eight named columns. Every cell is `Verified (file:line)` or
`Unverified-internal` / `absent in current source` — no invented capability.

### 4a. `builtin` (in-panel fallback; no adapter file)

| Column | Cell |
|---|---|
| streaming | Verified (src/ui/aiChatPanel.ts:2358) — `onText` posts `delta`; route `src/ai/agent.ts:243` → `provider.streamComplete` |
| resume | absent in current source — `handleResumeList` hard-errors unless engine is omp: `src/ui/aiChatPanel.ts:4020–4026` |
| native commands | absent in current source — closed six-command set: `src/ui/aiChatPanelCommands.ts:2` |
| model/role picker | Verified (src/ui/aiChatPanel.ts:1899) — `buildModelsFrame`; chip path `:1930` |
| session/persistence | absent in current source — in-memory `this.history` only; nothing written to disk |
| permissions/approvals | Verified (src/ui/aiChatPanel.ts:809) — `DbToolPermissionGate.wrap`; plan approve `:4299` |
| timeline events | absent in current source — no timeline UI; `src/ai/trace.ts:1` is an in-memory ring, not a surface |
| failure modes | Verified (src/ui/aiChatPanel.ts:2480) — abort branch swallows error; config error enriched at `:2497` |

### 4b. `omp` (ACP child process)

| Column | Cell |
|---|---|
| streaming | Verified (src/ai/omp/ompChatEngine.ts:273) — `agent_message_chunk` → `onDelta` |
| resume | Verified (src/ui/aiChatPanel.ts:4018) — `sessionList`; load at `:4071` |
| native commands | absent in current source — `available_commands_update` is explicitly ignored: `src/ai/omp/ompChatEngine.ts:332` |
| model/role picker | Verified (src/ui/aiChatPanel.ts:1930) — panel-wide `activeRole`; no engine-native model switch |
| session/persistence | Verified (src/ai/omp/acp.ts:213) — `session/list`; storage owned by the omp child, not the extension |
| permissions/approvals | Verified (src/ui/aiChatPanel.ts:3636) — `permission_request` frame; HostMcp gate `:2918` |
| timeline events | absent in current source — trace recorder `src/ai/trace.ts:1` is not rendered |
| failure modes | Verified (src/ai/omp/ompChatEngine.ts:390) — `session/new failed:` / `session/new cancelled:` |

### 4c. `claudeCode` (subprocess adapter)

| Column | Cell |
|---|---|
| streaming | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:48) — `ClaudeCodeChatEvents` mirrors omp; panel route `src/ui/aiChatPanel.ts:2774` |
| resume | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:280) — `RESUME_UNSUPPORTED_MESSAGE`, refuses to spawn |
| native commands | absent in current source — no parser or command surface |
| model/role picker | Unverified-internal — the panel applies `activeRole` generically, but the adapter's `send` carries no model/role parameter (`:63–67`) and no CLI mapping exists in `src/` |
| session/persistence | absent in current source — one process, no session store |
| permissions/approvals | Verified (src/extension.ts:2433) — `createHostMcp({gatePost…})` + `--mcp-config` written at `:2453` |
| timeline events | absent in current source |
| failure modes | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:169) — disposed; `:193` hostMcp start failed |

### 4d. `codex` (subprocess adapter)

| Column | Cell |
|---|---|
| streaming | Verified (src/ai/codex/codexChatEngine.ts:64) — `CodexChatEvents`; carried over stdin (`:114–118`) |
| resume | Verified (src/ai/codex/codexChatEngine.ts:364) — `"Codex session resume is unavailable"` |
| native commands | absent in current source |
| model/role picker | Unverified-internal — same gap as claudeCode; `send` accepts no model argument (`:114–118`) |
| session/persistence | absent in current source |
| permissions/approvals | Unverified-internal — HostMcp is constructed at `src/extension.ts:2491` and `gatePost` wired, but the codex CLI lane passes no `--mcp-config` (`src/extension.ts:2479–2484`), so the gate is not reachable by the documented `codex exec` route |
| timeline events | absent in current source |
| failure modes | Verified (src/ai/codex/codexChatEngine.ts:320) — process start failed; `:364` resume unavailable |

---

## 5. Sessions / permissions / streaming / timeline inventories

### 5a. Sessions and persistence

- **In-memory only, per panel.** Conversation state is `this.history: ChatMessage[]`
  (`src/ui/aiChatPanel.ts`); builtin appends on clean completion (`:2469–2473`), omp only on a
  clean settle. Nothing is written to disk by the extension.
- **Persistence belongs to the omp child.** Listing uses ACP `session/list`
  (Verified (src/ai/omp/acp.ts:213)), loading uses `session/load` (Verified (src/ai/omp/acp.ts:252)).
  The host filters by `cwd`, excludes the current session, sorts by `updatedAt` desc, caps at
  `RESUME_PICKER_CAP = 20` (Verified (src/ui/aiChatPanel.ts:4046), constant at `:1173`).
- **Resume is omp-only.** `handleResumeList` and `handleResumePick` both post
  `"Resume requires the omp engine."` for any other engine (`:4020`, `:4072`).
- **claudeCode and codex have no native resume.** Both adapters emit an explicit
  unsupported-error without spawning (`:280`, `:364`).
- **builtin has no session id at all.**

### 5b. Permissions and approvals

- **Two id-namespaces on one wire kind.** `permission_response` is routed to
  `dbToolGate.respond` (ids owned by the DB-tool gate), then `resolveHostPermission`
  (ids owned by HostMcp), then the raw-ACP bridge (`src/ui/aiChatPanel.ts:1668–1679`).
- **Default deny.** An unknown/omitted `optionId`, a duplicate, or a timeout resolves to a
  `cancelled` ACP outcome — exactly one result per request (`:3649–3677`).
- **Timeout = 60 s** (`DEFAULT_PERMISSION_TIMEOUT_MS`, `src/ui/aiChatPanel.ts:123`).
- **Bypass is session-scoped and default-OFF.** `bypass_permissions` only mutates
  `this.bypassPermissions` and is never persisted (`:1727–1733`); when ON the webview receives
  no card at all (`:3599–3620`, `:2933–2937`).
- **Plan approval is a separate consent path.** `plan_approve` re-validates against the live
  schema and runs `confirmDangerousStatements` (`:4357`) before executing.

### 5c. Streaming route

- **One `delta` frame is the only streaming primitive.** The webview appends text into a
  `.UnicDB-chat-streaming` bubble and re-renders markdown when a fence closes
  (`webview/aiChatPanelMain.ts:1272–1320`); `done`/`assistant`/`error` de-stream it
  (`:1328–1342`, `:1992–2014`).
- **builtin**: `runAgent` → `deps.streamComplete` with a per-turn `AbortController`
  (`src/ui/aiChatPanel.ts:2009`, `:2289`). If the provider emits 0 chunks and fails, one
  `onStreamFallback` fires (`src/ai/agent.ts:274`) and the panel posts a `step` labelled
  `"stream fallback"` (`:2369`).
- **omp**: ACP `session/update` → `agent_message_chunk` → `onDelta`
  (`src/ai/omp/ompChatEngine.ts:273`).
- **claudeCode / codex**: subprocess stdout → the same `OmpChatEvents`-shaped callbacks,
  forwarded through `runImageCapableEngineTurn` (`src/ui/aiChatPanel.ts:2754–2841`).
- **All three external routes are redacted** at the wire boundary
  (`String(redact(delta))`, `src/ui/aiChatPanel.ts:2601`, `:2782`).

### 5d. Timeline / activity — `absent in current source`

Searched `grep -rniE "timeline|activity" src webview` (non-test files) and the
`find -iname` sweep in §1f. Results:

- No `timeline` file, no `activity` file, no `timeline` identifier in any chat file.
- The closest existing artifacts are (a) the inline `step` rows
  (`src/ui/aiChatPanelMessages.ts:44`, rendered at `webview/aiChatPanelMain.ts:1086`) which are
  append-only text labels with no time, status or id, and (b) the redacting in-memory
  `TraceRecorder` (`src/ai/trace.ts:1`), which is attached to turns
  (`src/ui/aiChatPanel.ts:1299`) but exposed only through the
  `UnicDB.ai.exportTrace` / `UnicDB.ai.clearTrace` commands (`src/extension.ts:1319`, `:1324`)
  — never rendered in the panel.
- Conclusion: there is **no activity timeline feature**. `step` rows are the only
  activity-like UI, and they carry one string each.

---

## 6. Failures and termination paths

Fourteen distinct failure/terminal paths found; each with trigger, current user-visible
outcome, and anchor.

| # | Trigger | User-visible outcome today | Anchor |
|---|---|---|---|
| F1 | AI not configured (no baseUrl/key) | error bubble; message enriched with the Open AI Settings path | Verified (src/ai/agent.ts:307), enriched at src/ui/aiChatPanel.ts:2497 |
| F2 | Provider stream fails before any chunk | one `step` "stream fallback", then a non-streaming retry; no error if retry works | Verified (src/ai/agent.ts:274), posted at src/ui/aiChatPanel.ts:2369 |
| F3 | User Stop during builtin turn | no error bubble; open bubble keeps partial text; `done` posted in `finally` | Verified (src/ui/aiChatPanel.ts:2480) |
| F4 | omp `session/new` rejects | single error bubble `session/new failed: <msg>` | Verified (src/ai/omp/ompChatEngine.ts:392) |
| F5 | omp `session/prompt` crashes mid-turn | single error bubble; turn settles | Verified (src/ai/omp/ompChatEngine.ts:431) |
| F6 | Malformed/unknown ACP notification | silently dropped; next valid frame still streams | Verified (src/ai/omp/ompChatEngine.ts:265) |
| F7 | omp tool call throws | `tool_result` card with `status: "failed"` | Verified (src/ai/omp/ompChatEngine.ts:307) |
| F8 | Permission request unanswered for 60 s | card settles to deny; ACP result `cancelled` | Verified (src/ui/aiChatPanel.ts:3629) |
| F9 | claudeCode `send` after dispose | error bubble `claude code chat engine is disposed` | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:169) |
| F10 | claudeCode HostMcp start failure | error bubble `hostMcp start failed: <msg>` | Verified (src/ai/claudeCode/claudeCodeChatEngine.ts:193) |
| F11 | codex `send` after dispose | error bubble `disposed` | Verified (src/ai/codex/codexChatEngine.ts:284) |
| F12 | codex process start failure | error bubble `codex process start failed: <msg>` | Verified (src/ai/codex/codexChatEngine.ts:320) |
| F13 | Requested engine seam not wired | error `… is not configured; falling back to builtin for this turn.`, then the builtin turn runs | Verified (src/ui/aiChatPanel.ts:2880) |
| F14 | Unknown message from either side of the wire | silently ignored (no `default` branch on either switch) | Verified (src/ui/aiChatPanel.ts:1743), Verified (webview/aiChatPanelMain.ts:2060) |

---

## 7. Gaps, discrepancies and open questions (facts, not proposed fixes)

1. **`/engine` host parser vs protocol vocabulary.** The protocol advertises four engines
   (`src/ui/aiChatPanelMessages.ts:102`) and `AiEngine` has four values
   (`src/ai/settings.ts:24`), but the host `/engine` parser accepts exactly two literals —
   `builtin` and `omp` — and rejects `claude-code` / `codex` with the literal
   `Usage: /engine builtin|omp` (`src/ui/aiChatPanel.ts:1779–1781`). Engine switching to the
   two subprocess engines happens through the VS Code commands
   `UnicDB.ai.useWithClaudeCode` / `UnicDB.ai.useWithCodex` (`package.json:264`, `:270`),
   not through `/engine`. This is a real input/output vocabulary mismatch, recorded as fact.
2. **`/model` argument vocabulary vs `AiModelRole`.** The `/model` text path accepts only
   `work` or `smart` (`src/ui/aiChatPanel.ts:1757–1763`), while `AiModelRole` has four members
   (`src/ai/settings.ts:13`) and the `model_select` wire message accepts the full set
   (`src/ui/aiChatPanelMessages.ts:435`). Two entry points, two different accepted sets.
3. **`command` wire union is narrower than the slash registry.** `AiChatPanelCommand.command`
   is `"engine" | "model"` (`:425`), yet the registry also declares `clear`, `resume`,
   `context`, `export` (`src/ui/aiChatPanelCommands.ts:2–9`). Only `engine`/`model` cross the
   wire (`webview/aiChatPanelMain.ts:666–669`); the other four are handled webview-locally.
4. **No export acknowledgement.** `exportTranscript` announces success immediately after
   `link.click()` with no host confirmation (`webview/aiChatPanelMain.ts:640`).
5. **Codex MCP/permission lane is wired but not reachable by the documented CLI route.**
   `buildCodexChatEngine` creates and starts HostMcp (`src/extension.ts:2491`) and bridges it
   (`:2503`) but passes no `--mcp-config`, because "The Codex CLI does NOT consume
   `--mcp-config` in `codex exec` mode" (`src/extension.ts:2479–2484`).
6. **Codex process reuse vs the adapter's one-shot assumption.** `codexChatEngine` disposes
   the per-turn process in `finally` and comments that "codex children are one-shot per turn"
   (`src/ai/codex/codexChatEngine.ts:345–354`), while the production factory returns the same
   started handle for every turn (`src/extension.ts:2508–2513`).
7. **No timeline and no timeline data model.** Steps (`AiChatPanelStep`) carry a single
   `label` and no timestamp/id/status; the trace ring has all of those but no UI. A timeline
   would need a new wire frame, not a rename.
8. **`/context` shows no exclusions or privacy boundaries on the wire.**
   `grounding_state.excludedCount` is a bare number (`src/ui/aiChatPanelMessages.ts:190`) and
   the webview's local `/context` notice lists only history-present + queued attachment count.
9. **`/help` and `/new` do not exist** in the registry or in the webview switch (searched
   `AI_CHAT_COMMANDS` and `executeSlashCommand`, `webview/aiChatPanelMain.ts:643–671`).
10. **No persistent permission policy.** Bypass is session-scoped and not persisted
    (`src/ui/aiChatPanel.ts:1727–1733`); the only durable policy surface is
    `UnicDB.ai.showPolicy` (`package.json:282`).
11. **Unverified-internal cells to confirm by reading the CLI vendors**: whether claudeCode or
    codex accept a model/role selector (matrix 4c/4d), and whether the codex lane can ever
    reach the HostMcp gate in practice.

---

## Search-term appendix (negative evidence)

Terms searched with no chat-relevant match in `src/` + `webview/` (non-test): `timeline`,
`activity`, `approval` (as a file/identifier), `builtinChatEngine`, `sessionStore`,
`session_store`, `persistSession`, `saveSession`, `availableCommands`, `setMode`,
`nativeCommand`. Positive hits and their roles are in §1.
