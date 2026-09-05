# PLAN — Cycle O: ACP session history & resume

## §1 Intent (problem / diagnosis)

The AI Chat panel loses all conversation context when it is closed or when the omp process
exits: every panel open spawns a fresh `session/new` and history starts from zero. omp 18.0.1
already persists sessions and the ACP protocol exposes them — frozen probe evidence
(`docs/AI_HANDOFF/queue/ACP-SESSION-research.md`, live probes, the ONLY protocol source for
this cycle) proves:

- `session/list` (`params: {}`) → `{ sessions: [...] }` with `sessionId`, `cwd`, `title?`,
  `updatedAt`, `_meta: { messageCount, size }`. `title` may be missing or the junk literal
  `"<function>"` (upstream title bug) — UI must fall back.
- `session/load` `params: { sessionId, cwd, mcpServers: [] }` → result `{ configOptions,
  modes }` and replays the transcript as ordered `session/update` notifications (probe saw
  157: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk` (never render),
  `tool_call`, `tool_call_update`, `plan`, `available_commands_update`,
  `session_info_update`). Bad sessionId → `-32603 "ACP session not found: <id>"`.
- After `session/load`, `session/prompt` on the same sessionId works end-to-end
  (`stopReason: "end_turn"` in probe) — continuation uses loaded context.
- `session/new` REQUIRES `mcpServers` to be an array (`{cwd}` alone → `-32603`).

**Diagnosis (latent bug found during grounding):** `src/ai/omp/acpProcess.ts:165` currently
sends `session/new` with `params: { cwd }` only — no `mcpServers: []`. Against omp 18.0.1
that envelope errors per evidence fact 1. Existing unit tests never caught it because the
fake child answers `session/new` regardless of params; the live smoke test
(`acpLiveSmoke.test.ts:117`) sends the correct envelope by hand. Cycle O fixes this
(regression-pinned in TASK-002).

**Success:** user clicks "Resume session" in the AI Chat panel, sees their recent omp
sessions for this workspace (newest first, ≤20, junk titles fallen back), picks one, the
replayed transcript appears as read-only history (thought chunks never rendered, huge
sessions truncated with a notice), and the next prompt continues that exact session.

## §2 Scope

**In:** typed `sessionList()` / `sessionLoad()` on `AcpClient` with replay buffering;
`session/new` envelope fix in `AcpProcess`; host-side resume coordinator in `AiChatPanel`
(list → filter by cwd → sort updatedAt desc → cap 20 → load → derive history → re-base
active sessionId); webview picker + history rendering; focused tests per task.

**Out:** `session/fork` / `session/cancel` / `session/close` (in installed schema but NOT
probed — forbidden without evidence); any new npm runtime dep; changing builtin engine path,
read-only DB host-tool boundary, or Cycle M permission/stop/dispose default-deny semantics;
bundling omp; telemetry; multi-root cwd selection (first workspace folder, as today).

**Constraints (inherited by every task):** no new npm runtime deps; host code pure where
possible (no `vscode` import under `src/ai/**`); `apiKey` never crosses to the webview;
`agent_thought_chunk` never rendered; read-only DB boundary untouched; builtin engine path
untouched; every ACP envelope fact comes ONLY from `queue/ACP-SESSION-research.md` —
never invent fields; VS Code engine `^1.75.0`, TS/Node extension host only.

## §3 Approach

### 3.A AcpClient session methods (TASK-001)

`AcpClient` already owns the notification pump (`dispatchNotification` → single handler
slot). Replay buffering therefore belongs inside the client. **Window semantics (review
F1):** the replay window opens when `sessionLoad` writes its request frame and closes on
the **NEXT outgoing client request** (`request()`/`notify()` write their frame BEFORE
flushing the pending replay buffer back to the registered handler) — or, in the common
case, at the caller's next `session/prompt`. Result-settle is NOT the close: a
multi-flush replay (probe: 157 notifications / `_meta.size` 14.9 MB spans many stdout
flushes) keeps pushing `session/update` frames into the buffer after the load result
line; closing on result + a drain tick would leak late frames into the panel's live
handler and post stray live `delta` bubbles (`aiChatPanel.ts:512-518`). Two invariant
parts, one mechanical, one panel-side:

1. **Mechanical (TASK-001):** `sessionLoad()` returns its result immediately on settle
   with the buffer it has; the buffer object keeps absorbing `session/update` frames
   whose `params.sessionId` matches the load `sessionId` until the next outgoing
   request/prompt flushes it (buffer then closed + detached). Non-matching or
   post-flush notifications route to the registered handler as before.
2. **Panel-side belt (TASK-003):** between a successful load and the next
   `session/prompt`, the panel's notification handler DROPS `session/update` frames for
   the loading sessionId (guard flag cleared when the first outgoing prompt is written)
   — a leaked frame can never post a live `delta` bubble even if the client invariant
   regresses.

Frozen interface (TASK-001 Produces):

```ts
// src/ai/omp/acp.ts
export interface AcpSessionListItem {
  sessionId: string;      // non-string sessionId entries are dropped
  cwd: string;
  title: string | null;   // null when absent, non-string, or === "<function>"
  updatedAt: string;      // non-string → ""
  messageCount: number;   // from _meta, default 0
  size: number;           // from _meta, default 0
}
export interface AcpReplayNotification { method: string; params: unknown }
export interface AcpReplayBuffer {
  // ordered exactly as received; keeps GROWING until the window closes
  readonly notifications: readonly AcpReplayNotification[];
  readonly closed: boolean; // true once the next outgoing request()/notify() flushed it
}
export interface AcpSessionLoadResult {
  configOptions: unknown; // carried, unused this cycle
  modes: unknown;         // carried, unused this cycle
  replay: AcpReplayBuffer; // LIVE object — resolve settles with whatever has arrived
}
class AcpClient {
  sessionList(): Promise<AcpSessionListItem[]>;                 // request("session/list", {})
  sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult>;
  // sessionLoad writes { sessionId, cwd, mcpServers: [] } (evidence fact 3) and opens the
  // replay window; the promise settles on the load RESULT (buffer may still be growing),
  // rejects with the raw ACP error (code preserved) e.g. -32603 not-found,
  // rejects a second concurrent load with Error("session load already in progress").
  // Next outgoing request()/notify() flushes+closes the window: any write FIRST absorbs
  // the pending buffer (marking closed), THEN writes its own frame — after that,
  // matching session/update frames route to the registered handler again (live turn).
}
```

Pure/injectable: implemented over the existing `AcpTransport`; no spawn, no vscode.

### 3.B AcpProcess envelope fix + passthrough (TASK-002)

- `session/new` params become `{ cwd: this.opts.cwd, mcpServers: [] }` (evidence fact 1;
  fixes the latent `-32603`). Nothing else in the lifecycle changes.
- The handle's `acp` client therefore exposes `sessionList`/`sessionLoad` to whoever holds
  the handle — no new seam surface needed.

**Decision (recorded): `src/extension.ts` is intentionally unchanged.** `buildAcpDeps()`
already returns `start(ompPath, cwd)`; the panel reuses ONE process via `ensureAcpSession()`
and can call `handle.acp.sessionList()/sessionLoad()` directly on that live client. A
separate list/load spawn would create a second process and a different session store view —
wrong. `src/ai/omp/detect.ts` is also unchanged (binary detection untouched).

Resume before any chat: opening the picker lazily triggers `ensureAcpSession()` (fresh
spawn + `session/new`), then lists. Two consequences, both handled in §3.C step 1: the
fresh empty session is orphaned server-side if the user resumes another — harmless (never
prompted) — AND it appears in its own `session/list` result (behavior unpinned by probe,
review F3), so the picker filters out the current own sessionId (see step 1).

### 3.C Panel resume coordinator + protocol (TASK-003)

New webview↔host messages (frozen; TASK-003 Produces, TASK-004 consumes):

```ts
// src/ui/aiChatPanelMessages.ts — webview → host
{ type: "resume_list" }                        // picker opened
{ type: "resume_pick"; sessionId: string }     // row selected (host id echoed verbatim)
{ type: "resume_cancel" }                      // picker dismissed
// host → webview
{ type: "resume_sessions";
  sessions: Array<{ sessionId: string; label: string; detail: string }> } // ≤20, text-only
{ type: "history";
  items: Array<{ kind: "user" | "assistant" | "tool"; text: string }>;
  truncated: boolean; truncatedCount: number }  // replay-derived, capped
```

Errors reuse the existing `{ type: "error"; message }` inline notice — no new error channel.

Host flow (`AiChatPanel`):
1. `resume_list`: if engine is `builtin` → inline notice "Resume requires the omp engine",
   no spawn. If a turn is streaming → ignore (guard). Otherwise `ensureAcpSession()`, call
   `handle.acp.sessionList()`, filter `entry.cwd === cwd` (cwd = workspace root, same value
   the panel already computes at `aiChatPanel.ts:456`) AND `entry.sessionId !==
   `session.sessionId` (own fresh session — F3), sort `updatedAt` desc (F2: compare via
   `Date.parse` — probe shows ISO-8601 strings — falling back to raw string compare when
   parse yields `NaN`), cap 20,
   label = `title ?? "(untitled)"`, detail = `"<relative time> · <messageCount> msgs"`,
   post `resume_sessions`. Any failure → inline error notice, panel alive.
2. `resume_pick` (same busy/builtin guards): `handle.acp.sessionLoad(sessionId, cwd)` →
   on settle, derive history items from the `replay.notifications` snapshot in order →
   re-base `AcpSession.sessionId` to the loaded id → arm the panel-side drop-guard (any
   further `session/update` for that sessionId is dropped, never rendered live) → post
   `history` batch → re-base host `this.history` (user/assistant turns only) so
   Clear/fallback stay coherent. The guard clears inside `runAcpTurn` at the moment the
   next `session/prompt` is written — which is also the write that flushes+closes the
   client replay window (§3.A), so live deltas of the resumed turn stream normally.
   Replay frames arriving after the derivation snapshot are dropped (bounded tail loss,
   never a stray live bubble).
3. `AcpSession` gains `sessionId: string` (initialized from `handle.sessionId`; replaced on
   load); `runAcpTurn` prompts `session.sessionId` (evidence fact 4 — continuation works on
   the loaded id). Stop/dispose/cancel/permission paths byte-identical to Cycle M.

History derivation (pure, ordered single pass over `replay.notifications`):
- `user_message_chunk` `{update:{content:{type:"text",text}, messageId}}` → append `text` to
  the current user run (new run on role change or `messageId` change).
- `agent_message_chunk` `{update:{delta}}` → append `delta` to the current assistant run
  (same shape the panel already streams live — pinned by `aiChatPanelAcp.test.ts:282`).
- `tool_call` → one `{kind:"tool", text: label}` item. **Envelope unpinned by evidence** →
  defensive label extraction: first string among `title`/`name`/`toolCallId` fields of
  `update`, else literal `"tool"`; never throw on unknown shape.
- Skip entirely: `agent_thought_chunk` (never render — hard requirement),
  `tool_call_update`, `plan`, `available_commands_update`, `session_info_update`, and any
  non-`session/update` method.
- Render cap `HISTORY_RENDER_CAP = 50` items: keep the LAST 50, set `truncated: true` and
  `truncatedCount` = dropped count (huge sessions — probe saw `_meta.size` 14.9 MB — must
  not flood the webview; buffer itself is discarded after derivation).

### 3.D Webview picker + history rendering (TASK-004)

`webview/aiChatPanelMain.ts`: "Resume session" button in the actions row. Click → post
`resume_list` → render returned rows as a plain-text list (DOM text nodes only — same
security rule as permission cards; sessionId never re-invented, echoed verbatim on click).
`history` batch renders in order: user right-aligned plain text, assistant markdown via the
existing safe renderer, tool items as collapsed one-line labels; `truncated` → one notice
line "<n> earlier items not shown". Busy state (`done`/`setBusy`) disables the Resume
button while a turn streams; re-enables on `done`. Close/dismiss → `resume_cancel`.

## §4 Task breakdown, waves, risk table

| Task | Wave | Depends on | Title |
|---|---|---|---|
| TASK-001 | 1 | none | AcpClient `sessionList`/`sessionLoad` + replay buffering |
| TASK-002 | 2 | TASK-001 | AcpProcess `mcpServers: []` envelope fix + list/load over spawned client |
| TASK-003 | 3 | TASK-001, TASK-002 | Panel resume coordinator + webview message protocol |
| TASK-004 | 4 | TASK-003 | Webview resume picker + history rendering |

Chain is deliberate (scope mandates chained waves); no same-wave file overlap exists by
construction. Frozen cross-task interfaces live in each task file §Interfaces.

### Risk table

| # | Risk | Mitigation |
|---|---|---|
| R1 | Multi-flush replay (157 notifications / 14.9 MB spans many stdout flushes) — a result-settle + drain-tick window leaks late frames to the live handler → stray `delta` bubbles | Window closes on the NEXT outgoing client request (write flushes buffer first — §3.A), pinned by a two-flush RED test in TASK-001; panel-side drop-guard in TASK-003 as belt |
| R2 | `tool_call` replay envelope not pinned by probe | Defensive label extraction (title/name/toolCallId → "tool"); skip-on-unknown; never throw |
| R3 | Huge sessions (14.9 MB, 157+ notifications) OOM/flood webview | Host-side render cap (last 50) + `truncatedCount` notice; replay buffer discarded after derivation |
| R4 | Latent `session/new` without `mcpServers` → `-32603` | TASK-002 regression test pins outgoing frame `{cwd, mcpServers: []}` (RED today) |
| R5 | Load while a turn streams corrupts turn state | Host ignores `resume_list`/`resume_pick` while streaming; webview disables the button |
| R6 | Resume picker before first chat spawns a session that is then orphaned | Documented harmless (never prompted); picker also filters out the current own sessionId (F3); no server mutation beyond what `session/new` already does |
| R7 | Security regressions (apiKey, thought chunks, HTML injection) | No new payload carries secrets; `agent_thought_chunk` filtered at host; hostile-title text-only rendering test in TASK-004 |
| R8 | Breaking Cycle M stop/dispose default-deny | Those paths untouched; existing `aiChatPanelAcp.test.ts` suite re-run as regression in TASK-003 |

## §5 Verification (exact commands; scripts from package.json)

`package.json` defines: `compile`, `watch`, `test`, `test:integration`, `typecheck`,
`package`, `vscode:prepublish`. **There is NO lint script** — explicitly N/A for every task.

- TASK-001: `npm run typecheck && npx vitest run src/ai/omp/__tests__/acp.test.ts`
- TASK-002: `npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts`
- TASK-003: `npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelResume.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanel.test.ts`
- TASK-004: `npm run compile && npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelBundle.test.ts`
  (`compile` first — the bundle test loads `dist/aiChatPanel.js`.)

Test-selection follows `.cache/index/tests-map.json` for each `src/` target (all four target
files are covered there); TASK-003 adds `aiChatPanelResume.test.ts` (new) alongside mapped
neighbours. Wave-boundary full `yarn test`/`npm test` remains the regression net per
RULES.md (orchestrator runs it, not individual tasks).

## §6 File ownership (no same-wave overlap)

| Task | Source files | Test files |
|---|---|---|
| TASK-001 | `src/ai/omp/acp.ts` | `src/ai/omp/__tests__/acp.test.ts` |
| TASK-002 | `src/ai/omp/acpProcess.ts` | `src/ai/omp/__tests__/acpProcess.test.ts` |
| TASK-003 | `src/ui/aiChatPanel.ts`, `src/ui/aiChatPanelMessages.ts` | `src/ui/__tests__/aiChatPanelResume.test.ts` (new), `src/ui/__tests__/aiChatPanelMessages.test.ts` |
| TASK-004 | `webview/aiChatPanelMain.ts` | `src/ui/__tests__/aiChatPanelWebview.test.ts`, `src/ui/__tests__/aiChatPanelBundle.test.ts` |

Unchanged by design: `src/extension.ts`, `src/ai/omp/detect.ts`, `src/ai/omp/hostTools.ts`,
builtin engine (`src/ai/agent.ts`, `src/ai/provider.ts`), all Cycle M permission code paths.

## §7 Acceptance criteria

- [ ] `sessionList()` sends `session/list` `{}` and returns normalized entries (junk/missing
      title → null) — TASK-001.
- [ ] `sessionLoad()` sends `{sessionId, cwd, mcpServers: []}`, opens a replay window that
      closes on the next outgoing request (multi-flush replays never leak to the panel
      handler), rejects `-32603` with code preserved — TASK-001.
- [ ] `session/new` outgoing frame is exactly `{cwd, mcpServers: []}` (regression RED
      before fix) — TASK-002.
- [ ] Picker lists cwd-filtered, own-session-excluded, updatedAt-desc, ≤20 sessions with
      `"(untitled)"` fallback; load errors surface as inline notice and never crash the
      panel — TASK-003.
- [ ] Replay renders user/assistant text + collapsed tool labels in order, thought chunks
      never render, >50 items truncated with notice; next prompt continues the loaded
      sessionId — TASK-003.
- [ ] Webview picker renders text-only rows, echoes host sessionId verbatim, disables while
      busy; history batch renders with existing security rules — TASK-004.
- [ ] Cycle M stop/dispose/permission/default-deny behaviors unchanged (existing suites
      pass) — TASK-003/004.
- [ ] All Verification Commands pass fresh in executor and reviewer turns — all.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) discovered `acpProcess.ts:165` omits `mcpServers` on `session/new`
— promoted to TASK-002 regression with RED expectation; (2) collapsed list/load into the
existing single-client seam and recorded the explicit "extension.ts unchanged" decision
instead of inventing seam work; (3) added drain-tick to the buffer window because the
evidence doc's result-vs-replay order is ambiguous (R1); (4) added builtin-engine guard for
`resume_list` (picker must not spawn in builtin mode).
Known gaps: `tool_call` replay field names are not probe-pinned (R2) — mitigated by
defensive extraction, never throwing; `configOptions`/`modes` from `session/load` are
carried but unused this cycle (mode/model switching is future scope). Live end-to-end
resume is covered by unit + fake-transport integration tests only; the gated
`UnicDB_OMP_ACP_SMOKE=1` live probe remains opt-in and was not extended this cycle.

## Plan Review Log

### Round 1 — 2026-08-24 · unic/unic-smart
Status: Issues Found

COMPLETENESS:
  - none blocking — every ACP envelope claim traces to queue/ACP-SESSION-research.md facts 1–5 (list `{}`, load `{sessionId,cwd,mcpServers:[]}`, replay kinds incl. user_message_chunk shape, -32603 not-found, prompt end_turn); fork/cancel/close correctly absent; TDD tables all ≥1 happy + ≥2 distinct edges + 1 regression; package.json has no lint script (N/A correct).
CONSISTENCY:
  - F1 (IMP): §3.A/R1 replay-buffer window ("result settle + one macrotask drain tick") cannot capture a multi-flush replay — evidence fact 3 is 157 notifications / `_meta.size` 14.9 MB, which spans many stdout flushes; frames arriving after the tick leak to the live panel handler, and leaked `agent_message_chunk` posts stray live `delta` bubbles (src/ui/aiChatPanel.ts:509-517). Deterministic fix: close the window on the next outgoing client request (or drop `session/update` panel-side between load and next prompt), and pin a two-flush replay test in TASK-001.
  - Verified: frozen interfaces identical across TASK-001→004; latent-bug claim REAL (src/ai/omp/acpProcess.ts:165 sends `{cwd}` only, vs evidence fact 1; live smoke at acpLiveSmoke.test.ts:117 hand-sends the right envelope).
CLARITY:
  - F2 (MIN): `updatedAt` wire format is unpinned (fact 2 names the field, no format); §3.C step 1 sorts `updatedAt` desc as strings — works only for ISO-8601. State the assumption or sort via `Date.parse` fallback.
SCOPE:
  - F3 (MIN): the lazy picker spawn (§3.B, R6) leaves the fresh empty session in its own `session/list` (behavior unpinned) — TASK-003 should filter the current sessionId or pin a test tolerating an "(untitled) · 0 msgs" row. Otherwise scope clean: chained waves, no same-wave file overlap, extension.ts/detect.ts untouched by design, no new deps.
YAGNI:
  - none — `configOptions`/`modes` carried-unused is explicit, not speculative surface.

NOTES: Approve once F1's window-close semantics are re-specified; F2/F3 can ride along in TASK-003.

### Round 2 — 2026-08-24 · unic/unic-smart
Status: Revisions Applied (awaiting re-review)

- F1 (IMP) applied: §3.A window semantics re-specified — window opens on the load request
  write and closes on the NEXT outgoing client request (`request()`/`notify()` absorb the
  pending buffer before writing their own frame); `AcpSessionLoadResult.replay` is now a
  LIVE `AcpReplayBuffer` object (grows until closed). TASK-001 gains the two-flush RED
  test (n1 → result → n2 → tick → n3: n3 stays buffered, nothing reaches the handler);
  TASK-003 gains the panel-side drop-guard (session/update for a loading sessionId is
  dropped between load and the next prompt) as belt-and-braces. §3.C step 2, R1, §7
  updated in sync.
- F2 (MIN) applied: §3.C step 1 pins `updatedAt` as ISO-8601 (probe evidence) and sorts
  via `Date.parse` with raw string fallback on `NaN`; TASK-003 case 1 extended.
- F3 (MIN) applied: §3.B/R6 note the fresh session appears in its own list; §3.C step 1
  and TASK-003 case 1 filter `entry.sessionId !== session.sessionId`.
- Frozen interface touched: `AcpReplayNotification[]` → `AcpReplayBuffer` in
  `AcpSessionLoadResult` — propagated to PLAN §3.A/§3.C and TASK-001/002/003 Interfaces
  sections; TASK-004 consumes only `history` batches, unaffected.

Round-2 self-audit: 12/12 pass. Waves unchanged (4-task chain, deliberate); no new
same-wave file overlap (drop-guard lives in TASK-003-owned `aiChatPanel.ts`; buffer
semantics in TASK-001-owned `acp.ts`). Known gaps: unchanged from Round 1 (R2 tool_call
field names unpinned; carried-unused configOptions/modes; live probe opt-in only).

### Round 2 — re-review — 2026-08-24 · unic/unic-smart
Status: Approved

F1-F3 RESOLUTION (re-review scope):
  - F1 RESOLVED: §3.A/R1/§7/TASK-001/TASK-002/TASK-003 now all state the same deterministic
    window — opens on the load request write, closes on the NEXT outgoing request()/notify()
    (write absorbs pending buffer before its own frame); `replay` is a LIVE `AcpReplayBuffer`.
    Two-flush RED pinned (TASK-001 case 4: n3 stays buffered post-tick, handler never called),
    window-close pinned (case 5), panel drop-guard pinned (TASK-003 case 8). Remaining
    "drain-tick" mentions are only the rejected-semantics rationale — no normative remnant.
  - F2 RESOLVED: §3.C step 1 sorts via `Date.parse` with raw-string fallback on `NaN`;
    pinned in TASK-003 case 1.
  - F3 RESOLVED: §3.B/R6 document the orphaned fresh session; §3.C step 1 + TASK-003 case 1
    filter `entry.sessionId !== session.sessionId` (fixture includes the own-session entry).
COMPLETENESS:
  - none — no new envelope inventions (list `{}`, load `{sessionId,cwd,mcpServers:[]}`,
    session/new `{cwd,mcpServers:[]}` all match evidence facts 1-3); new webview messages are
    UI protocol, frozen in §3.C; 4-task chain/waves intact; TDD tables ≥1 happy + ≥2 edges +
    1 regression in all four tasks; no lint script — N/A correct.
CONSISTENCY:
  - none — `AcpReplayBuffer` propagated to PLAN §3.A/§3.C, TASK-001/002/003 Interfaces;
    TASK-004 consumes only `history` batches, unaffected.
CLARITY:
  - minor, non-blocking: TASK-001 case 3 Expected says "3 notifications" while its fixture
    column lists n1 → n2; executor should feed n1,n2,n3 (order-before-result is the contract).
SCOPE:
  - none — drop-guard lives in TASK-003-owned `aiChatPanel.ts`, buffer in TASK-001-owned
    `acp.ts`; no same-wave overlap.
YAGNI:
  - none.

NOTES: Plan is execution-ready; case-3 fixture wording is self-evident at implementation time.
