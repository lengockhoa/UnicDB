# PLAN_AIX06 — Agent Trace & Replay

Cycle: AIX-06 (wave 5) · Base: main @ 23309e5 (v1.25.0) · Release target: v1.26.0
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

## Roadmap row

> **AIX-06 Agent Trace & Replay** — Inspect an ordered, redactable record
> of prompts, retrieved context, tool requests/results, approvals, and
> failures; consider read-only replay only if the detailed cycle validates
> a concrete debugging/support user story.
> Depends AIX-03, AIX-05. No replay of writes or credentials.

## Current state (evidence)

- `src/ai/agent.ts` runs the builtin path: per-step tool calls return
  `ToolOutcome {result, isError}` via the `AgentCallbacks` interface
  (`onStep`, `onText`, `onError`, `onToolResult`).
- `src/ai/omp/ompChatEngine.ts` exposes `OmpChatEvents` (onDelta /
  onThought / onToolStart / onToolEnd / onError / onDone). No trace
  recorder hooks.
- AIX-05 hardened `OmpChatEngine` for cancel + restart + protocol
  robustness; a trace layer on top must NOT regress those.
- The AI chat panel already serialises wire kinds (`AiChatPanelStep`,
  `AiChatPanelToolResult`, `AiChatPanelError`, `AiChatPanelSessionState`)
  — a trace is the host-side mirror of that wire stream, NOT a new
  user-facing surface.
- Privacy invariant (cycle AA): no apiKey, no DB credential, no secret
  in any wire frame. A trace must respect the same invariant.

## Goal

Add a small, redaction-safe trace recorder the host can attach to both
the builtin and the OMP/MCP paths so debugging/support can inspect a
turn after the fact:

1. **Ordered trace record** — `{turnId, seq, kind, ts, payload}` where
   `kind ∈ {"prompt","delta","thought","tool_start","tool_end","error","done"}`.
   `seq` is monotonic per turn; `turnId` ties entries across paths.
2. **Redaction by default** — before any payload is stored, a `redact()`
   pass scrubs apiKey / secret / token / password / Bearer / Authorization
   / Basic headers, and any value shaped like a long alphanumeric/hex
   base64 run (≥ 24 chars). Tests pin: apiKey literal → `"<redacted>"`,
   prompt containing "sk-live-aaaaaaa" → scrubbed, header `Authorization:
   Bearer abc…` → redacted.
3. **Bounded size** — circular buffer (default 1000 entries per turn,
   50 turns retained) — never grows unbounded. Oldest entries are
   dropped on overflow with a single `truncated` flag on the dump.
4. **Engine-agnostic** — a single `TraceRecorder` instance accepts
   events from both the builtin `AgentCallbacks` and `OmpChatEvents`.
   The OMP engine grows a new optional `onTrace(trace)` event on its
   interface (default-deny: omitted fakes keep compiling).

## Non-goals

- No write-replay. No credential re-export. No remote upload.
- No new public API surface in the extension; the recorder is a
  host-internal seam.
- No persistent retention (workspace FS, secret storage) — trace is
  in-memory only. AIX-07's retention/audit-export policy decides where
  it lives long-term.

## Tasks (TDD, each RED→GREEN)

### TASK-AIX06-001 — `TraceRecorder` pure module
`src/ai/trace.ts` (PURE, no vscode):
- `TraceEvent = {turnId, seq, kind, ts, payload}` with `kind` enum.
- `class TraceRecorder`:
  - `record(turnId, kind, payload)` — redaction happens here.
  - `events(turnId?)` — return a frozen copy of events for a turn
    (or all turns).
  - `clear()` — drop everything.
  - `dump(turnId)` — return a JSON-serialisable envelope with a
    `truncated` flag if any turn was clipped to its per-turn cap.
- Bounded storage: `MAX_TURNS=50`, `MAX_ENTRIES_PER_TURN=1000`. New
  turn past the cap evicts the oldest turn entirely.
- `redact(value)` exported as a helper for unit tests; never stores
  a value that contains a secret-shape string after redaction.

### TASK-AIX06-002 — OmpChatEngine trace hook
`src/ai/omp/ompChatEngine.ts` + tests:
- Add optional `onTrace?(event: TraceEvent): void` to `OmpChatEvents`.
- Engine posts events at each emission point: prompt (before send),
  delta (per chunk — but only the redacted text, not raw args),
  thought, tool_start, tool_end, error, done.
- `OmpChatEngine` accepts an optional `trace?: TraceRecorder`; when
  present, every event ALSO flows through `recorder.record(...)`.
- `acp.notify` is a separate (fire-and-forget) channel; the trace
  hook is independent of the hostMcp error path.

### TASK-AIX06-003 — builtin path bridge
`src/ai/agent.ts` + tests:
- `runAgent` accepts an optional `trace?: TraceRecorder`.
- Wires `AgentCallbacks` (onText/onStep/onToolResult) to also call
  `recorder.record(...)` with the right kind mapping.
- A single `prompt` event is recorded at start; a `done` event at
  resolve; an `error` event on throw.

### TASK-AIX06-004 — AiChatPanel wiring + scaffold + docs
`src/ui/aiChatPanel.ts`:
- The panel instantiates a `TraceRecorder` (one per panel) and
  threads it into both the builtin (`runBuiltinTurn` → `runAgent`)
  and the OMP (`runOmpEngineTurn` → `engine.send`) paths.
- A `dump(turnId)` helper is exposed on the panel for future
  debugging hooks (no UI surface in this cycle).
- `src/__tests__/aix06Scaffold.test.ts`: scaffold hygiene (no
  shell:true / execSync, no apiKey literals in trace payloads,
  redaction unit tests, the trace recorder is exported, the OmpChatEvents
  onTrace hook exists). CHANGELOG 1.26.0 + README bullet.

## Verification per task

`npx vitest run <target test>`; cycle: `npm test`, `npm run typecheck`,
`npm run compile`.

## Risk / review focus

- Redaction correctness: scrubbed payloads must be safe to serialise
  to disk / network. False negatives (a secret that survives redaction)
  are the only high-severity failure mode.
- Bounded storage: overflow must not leak memory, must not crash the
  turn. The dump envelope's `truncated` flag is the only truth signal.
- Engine-agnostic: a `TraceRecorder` wired into the OMP path must not
  regress cancel/restart (AIX-05) or any wire shape.
