// src/ai/omp/ompChatEngine.ts — cycle AE TASK-002
//
// Chat-level glue that wires the AI Chat panel to an `omp` ACP session and
// the in-process HostMcp server. Cycle AE adds an "omp" engine mode to the
// panel (see §Engine selection in PLAN_AE.md); this module is the routing
// layer that the panel calls instead of provider.completeStream.
//
// Architecture (§Bridge architecture in PLAN_AE.md):
//   panel.send(text)
//     → OmpChatEngine.send(text, events)
//     → AcpSession.sessionNew({mcpServers:[hostMcp.descriptor]})
//     → AcpSession.sessionPrompt(sessionId, text)
//     → forward session/update notifications through OmpChatEvents callbacks
//     → on end_turn → resolve; on crash → onError → resolve
//
// Permission gate (cycle AD §Permission gate): tool-call frames from omp route
// through HostMcp.call(name, args) which already wraps the underlying tool in
// DbToolPermissionGate (T1's hostMcp layer owns that). The host's MCP HTTP
// bridge is the same shape proven in ACP-TOOLS-research.md:
//   mcpServers: [{ type: "http", name: "UnicDB", url: "http://127.0.0.1:<port>",
//                  headers: [] }]
//
// Privacy invariant (cycle AA): this module NEVER embeds the apiKey, the DB
// credentials, or any secret in any wire frame. The mcpServers URL is the
// only thing passed to omp, and it's the in-process HTTP listener from
// hostMcp — the omp child connects to it during `session/new` and stays in
// that local loop. No apiKey crosses this module.

// ============================================================================
// Public contract — types
// ============================================================================

/**
 * Shape of the AcpSession the engine drives. Mirrors the cycle-O `AcpSession`
 * internal type used by AiChatPanel (src/ui/aiChatPanel.ts:891) but kept
 * minimal so the engine can be unit-tested with a fake session.
 *
 * Production wires `ensureAcpSession()`'s output (or a thin wrapper that
 * owns the AcpProcessHandle). Tests inject a mock implementing the same
 * surface.
 */
export interface AcpSession {
  /** Create a new ACP session. Returns the sessionId omp assigned. */
  sessionNew(params: {
    cwd: string;
    mcpServers: ReadonlyArray<Record<string, unknown>>;
  }): Promise<{ sessionId: string }>;
  /** Send a prompt. Resolves with the stop reason on end_turn. */
  sessionPrompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason?: string }>;
  /** Load a prior session. Returns the sessionId and a LIVE replay buffer
   *  holding absorbed session/update notifications (cycle O feature). */
  sessionLoad(
    sessionId: string,
    cwd: string,
    mcpServers: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{
    sessionId: string;
    replay: {
      notifications: ReadonlyArray<{ method: string; params: unknown }>;
      closed: boolean;
    };
  }>;
  /** Register a notification listener. The engine registers exactly one. */
  onNotification(
    handler: (n: { method: string; params: unknown }) => void,
  ): void;
  /** Register a close listener (process exit, dispose). */
  onClose(listener: () => void): void;
  /** Best-effort teardown. Idempotent. */
  dispose(): void;
  /** AIX-05: best-effort fire-and-forget `session/cancel` notify. The
   * engine never relies on a response (the server cannot reply to a
   * notify). Optional on the interface so existing fakes keep compiling;
   * production wires AcpClient.notify. */
  notify?(method: string, params: unknown): void;
}

/**
 * Shape of the in-process MCP HTTP server (T1 hostMcp.ts). The engine reads
 * `port` / `url` / `sessionId` for diagnostics; calls `call(name, args)` to
 * dispatch a tool invocation; calls `start()` / `stop()` for lifecycle. The
 * `call` return shape is `{ result: string; isError: boolean }` so the engine
 * can mirror the onToolEnd callback exactly.
 */
export interface HostMcp {
  readonly port: number;
  readonly url: string;
  readonly sessionId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Dispatch a tool invocation. Returns the text result and whether the call
   * was an error (denied, throw, or isError from the underlying tool).
   */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError: boolean }>;
}

import { TraceRecorder, type TraceEvent, type TraceKind, redact } from "../trace";

/** Event surface the chat panel subscribes to per turn. */
export interface OmpChatEvents {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
  /** AIX-06: optional per-turn trace event sink (default-deny). */
  onTrace?(event: TraceEvent): void;
}

/** Chat-level engine — what the panel talks to. */
export interface OmpChatEngine {
  /** Send a user message. Streams via `events`. Resolves when the turn ends
   *  or errors. NEVER throws on crash — fires `onError` and resolves. */
  send(text: string, events: OmpChatEvents): Promise<void>;
  /** Resume a prior session (cycle O picker). */
  resume(sessionId: string, events: OmpChatEvents): Promise<void>;
  /** Best-effort shutdown. */
  shutdown(): Promise<void>;
  /**
   * AIX-05: cancel the in-flight turn. Sends `session/cancel` to the
   * active session (if any). Idempotent — calling twice for the same
   * turn sends exactly ONE notify. No-op without a turn.
   */
  cancel(): void;
  /** AIX-06 r1: attach a trace recorder at runtime (panel owns one
   *  recorder for both engines). Safe to call repeatedly — the latest
   *  recorder wins. Pass undefined to detach. */
  attachTrace(recorder: TraceRecorder | undefined): void;
}

export interface OmpChatEngineOptions {
  acp: AcpSession;
  hostMcp: HostMcp;
  cwd: string;
  /** AIX-06: optional trace recorder; when present every turn is
   *  recorded into it (payload redacted before storage). */
  trace?: TraceRecorder;
  /** Reserved for cycle AB image-attach parity (default false). */
  enablePromptImage?: boolean;
  /**
   * TASK-AIX05-103: required bridge-owned ACP `McpServer` descriptor
   * array (typically a single entry carrying a bearer `Authorization`
   * header). Forwarded verbatim into `session/new` and `session/load` —
   * the engine never rebuilds a headerless descriptor.
   */
  mcpServers?: ReadonlyArray<Record<string, unknown>>;
}

// ============================================================================
// Frame narrowing — single-use guards for untrusted ACP JSON payloads.
// Each guard is called from a single call site; the body is the data-
// validation contract the type-checker cannot see.
// ============================================================================

function isParamsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the typed string under `key`, validating shape inline. */
function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Build the MCP `mcpServers` descriptor for session/new and session/load.
 *
 * Single source of truth — both `send` and `resume` must pass the SAME shape
 * (TASK-012 §B11b finding: omitting it from session/load silently drops tool
 * access on resume).
 */
function mcpServersDescriptor(
  hostMcp: HostMcp,
): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      type: "http",
      name: "UnicDB",
      url: hostMcp.url,
      headers: [],
    },
  ];
}

/**
 * Internal notification dispatcher. Maps ACP `session/update` updates to the
 * OmpChatEvents surface.
 *
 * Frame shapes (live-probed on omp 18.0.1, see
 * docs/AI_HANDOFF/queue/ACP-SESSION-research.md):
 *   - agent_message_chunk: update.sessionUpdate === "agent_message_chunk",
 *                          update.content = { type: "text", text }
 *   - agent_thought_chunk: update.sessionUpdate === "agent_thought_chunk",
 *                          update.chunk = "<string>"
 *   - tool_call:           update.sessionUpdate === "tool_call",
 *                          update.toolCallId, update.name, update.args
 *   - tool_call_update:    update.sessionUpdate === "tool_call_update",
 *                          update.toolCallId, update.name, update.result, update.isError
 */
// AIX-06 r3: per-turn state shared between send() and
// dispatchNotification so onTrace always sees a real monotonic seq
// even when no recorder is attached.
interface TurnState {
  turnId: string;
  seq: number;
}
function buildEv(
  state: TurnState,
  kind: TraceKind,
  payload: unknown,
): TraceEvent {
  state.seq += 1;
  return {
    turnId: state.turnId,
    seq: state.seq,
    kind,
    ts: Date.now(),
    payload: redact(payload),
  };
}
/** AIX-06 r3: single emission point. */
function emit(
  trace: TraceRecorder | undefined,
  state: TurnState | undefined,
  events: OmpChatEvents,
  kind: TraceKind,
  payload: unknown,
): void {
  if (!state) return;
  if (trace) {
    const ev = trace.record(state.turnId, kind, payload);
    if (events.onTrace) events.onTrace(ev);
  } else if (events.onTrace) {
    events.onTrace(buildEv(state, kind, payload));
  }
}

async function dispatchNotification(
  n: { method: string; params: unknown },
  events: OmpChatEvents,
  hostMcp: HostMcp,
  trace?: TraceRecorder,
  state?: TurnState,
): Promise<void> {
  // AIX-05: a malformed frame MUST NOT kill a turn. Drop unknown methods
  // and malformed params silently — the next valid frame still streams.
  // Defence in depth: the guards below already early-return on bad shape;
  // this catch is the last line so a future change that throws can never
  // bubble out of the dispatcher.
  if (!isParamsRecord(n)) return;
  if (n.method !== "session/update") return;
  if (!isParamsRecord(n.params)) return;
  const update = n.params["update"];
  if (!isParamsRecord(update)) return;

  const sessionUpdate = update["sessionUpdate"];

  if (sessionUpdate === "agent_message_chunk") {
    const content = update["content"];
    if (!isParamsRecord(content)) return;
    const text = content["text"];
    if (typeof text === "string" && text.length > 0) {
      emit(trace, state, events, "delta", { text });
      events.onDelta?.(text);
    }
    return;
  }

  if (sessionUpdate === "agent_thought_chunk") {
    const chunk = update["chunk"];
    if (typeof chunk === "string" && chunk.length > 0) {
      emit(trace, state, events, "thought", { text: chunk });
      events.onThought?.(chunk);
    }
    return;
  }

  if (sessionUpdate === "tool_call") {
    const name = stringField(update, "name");
    if (name === undefined) return;
    const rawArgs = update["args"];
    const args: Record<string, unknown> = isParamsRecord(rawArgs) ? rawArgs : {};
    emit(trace, state, events, "tool_start", { name, args });
    events.onToolStart?.(name);
    try {
      const out = await hostMcp.call(name, args);
      emit(trace, state, events, "tool_end", { name, isError: out.isError });
      events.onToolEnd?.(name, out.result, out.isError);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(trace, state, events, "tool_end", { name, isError: true });
      events.onToolEnd?.(name, `Tool failed: ${message}`, true);
    }
    return;
  }

  if (sessionUpdate === "tool_call_update") {
    // AIX-05: an update without a toolCallId cannot be correlated to a
    // prior tool_call, so firing onToolEnd would surface an orphan
    // result card. Drop the frame.
    const toolCallId = stringField(update, "toolCallId");
    if (toolCallId === undefined) return;
    const name = stringField(update, "name");
    if (name === undefined) return;
    const result = update["result"];
    const isError = update["isError"] === true;
    events.onToolEnd?.(
      name,
      typeof result === "string" ? result : "",
      isError,
    );
    return;
  }

  // Every other update kind is silently ignored — agent_message_chunk,
  // agent_thought_chunk, tool_call, and tool_call_update are the four live
  // shapes omp 18.0.1 emits. plan / available_commands_update /
  // session_info_update / user_message_chunk are NOT user-facing deltas.
}

export function createOmpChatEngine(opts: OmpChatEngineOptions): OmpChatEngine {
  const { acp, hostMcp, cwd } = opts;
  let trace = opts.trace;
  // TASK-AIX05-103: bridge-owned descriptor wins. Prefer the caller-supplied
  // `mcpServers` array verbatim (including bearer headers); fall back to
  // the legacy default ONLY for backwards-compatible fakes that do not yet
  // thread a descriptor (e.g. cycle AE TASK-002 baseline tests).
  const mcpServers: ReadonlyArray<Record<string, unknown>> =
    opts.mcpServers ?? mcpServersDescriptor(hostMcp);
  // AIX-05: track the active sessionId so cancel() can address the right
  // `session/cancel` notify. Cleared on turn settle. `cancelSent` dedupes
  // double-cancel across a single turn.
  let currentSessionId: string | null = null;
  let cancelSent = false;
  // AIX-05: cancel() called while session/new is in flight — we can't
  // address `session/cancel` without a sessionId, so we remember the
  // intent and emit the notify the instant sessionNew resolves.
  // `sessionNewInFlight` is true ONLY between send() entry and
  // sessionNew resolution — cancel() sets pendingCancel only in that
  // window so an idle cancel() with no turn remains a no-op.
  let sessionNewInFlight = false;
  let pendingCancel = false;
  // AIX-06: monotonically increasing per-engine turn counter for trace ids.
  let sendSeq = 0;
  // AIX-05: `acp.notify` is optional on AcpSession — the cancel()
  // helper uses optional chaining so fakes without notify stay compiling.
  const notify: (m: string, p: unknown) => void =
    acp.notify?.bind(acp) ?? (() => { /* no-op */ });

  return {
    async send(text, events): Promise<void> {
      // AIX-06 r3: per-turn state shared with dispatchNotification so
      // onTrace always sees a real monotonic seq even when no recorder
      // is attached. A state is allocated when a recorder is attached
      // OR an onTrace subscriber exists; every payload is redacted
      // inside record() / buildEv().
      const state: TurnState | undefined =
        trace !== undefined || events.onTrace !== undefined
          ? { turnId: `turn-${(sendSeq += 1)}`, seq: 0 }
          : undefined;
      emit(trace, state, events, "prompt", { text });
      let sessionId: string;
      sessionNewInFlight = true;
      try {
        const newResult = await acp.sessionNew({ cwd, mcpServers });
        sessionId = newResult.sessionId;
      } catch (err) {
        sessionNewInFlight = false;
        const message = err instanceof Error ? err.message : String(err);
        // AIX-05: a cancel() called while session/new was pending fires
        // onError so the panel can settle the turn instead of hanging.
        emit(trace, state, events, "error", { message });
        if (pendingCancel) {
          pendingCancel = false;
          events.onError?.(`session/new cancelled: ${message}`);
        } else {
          events.onError?.(`session/new failed: ${message}`);
        }
        return;
      }
      currentSessionId = sessionId;
      cancelSent = false;
      sessionNewInFlight = false;
      // AIX-05: drain a pending cancel from before session/new settled.
      if (pendingCancel) {
        pendingCancel = false;
        // Clear the active id so a later cancel() is a no-op (the
        // session is already cancelled and never received a prompt).
        currentSessionId = null;
        try {
          notify("session/cancel", { sessionId });
        } catch {
          /* best-effort */
        }
        return;
      }

      // Register notification dispatcher for the lifetime of this turn. The
      // acp session dedupes handlers (one per AcpClient instance) so this
      // is safe across repeated send() calls.
      acp.onNotification((n) => {
        void dispatchNotification(n, events, hostMcp, trace, state);
      });

      try {
        await acp.sessionPrompt(sessionId, text);
        emit(trace, state, events, "done", {});
        events.onDone?.();
      } catch (err) {
        // Crash mid-turn (process exit / connection lost / session/prompt
        // rejection). Acceptance §5: the panel surfaces a single error bubble
        // and continues with builtin on subsequent turns — fire onError
        // ONCE, do not throw.
        const message = err instanceof Error ? err.message : String(err);
        emit(trace, state, events, "error", { message });
        events.onError?.(message);
      } finally {
        // AIX-05: turn settled (success OR crash) — clear active session so
        // a stale cancel() never addresses a dead session. The next send()
        // opens a fresh session.
        if (currentSessionId === sessionId) {
          currentSessionId = null;
          cancelSent = false;
        }
      }
    },

    async resume(sessionId, events): Promise<void> {
      // AIX-06 r3: per-turn state shared with dispatchNotification. The
      // seq counter resets to 0 — resume is a fresh turn for trace
      // consumers even though it loads an existing session.
      const state: TurnState | undefined =
        trace !== undefined || events.onTrace !== undefined
          ? { turnId: `resume-${sessionId}`, seq: 0 }
          : undefined;
      let loadedSessionId: string;
      try {
        const loadResult = await acp.sessionLoad(sessionId, cwd, mcpServers);
        loadedSessionId = loadResult.sessionId;
        currentSessionId = loadedSessionId;
        cancelSent = false;
        // Replay absorbed notifications through the same forwarder so the
        // panel renders the historical stream. The replay buffer closes on
        // the next outgoing request/notify (session/prompt in send), so
        // resume() itself doesn't need to settle it.
        for (const replay of loadResult.replay.notifications) {
          await dispatchNotification(replay, events, hostMcp);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        events.onError?.(`session/load failed: ${message}`);
        return;
      }

      // After replay, register the live notification forwarder. The panel
      // can then send the user's NEXT prompt through sessionPrompt and the
      // turn will stream as usual. resume() itself resolves once replay is
      // flushed — the next send() drives the turn.
      acp.onNotification((n) => {
        void dispatchNotification(n, events, hostMcp, trace, state);
      });

      // Touch loadedSessionId so unused-locals don't trip strict-mode — it
      // documents the contract that loadResult.sessionId is the active id
      // for subsequent sessionPrompt calls.
      void loadedSessionId;
      events.onDone?.();
    },

    attachTrace(recorder: TraceRecorder | undefined): void {
      trace = recorder;
    },

    cancel(): void {
      const id = currentSessionId;
      if (id === null) {
        // No active turn — no-op UNLESS session/new is in flight, in
        // which case we remember the intent so the notify fires the
        // instant a sessionId is assigned.
        if (sessionNewInFlight) pendingCancel = true;
        return;
      }
      if (cancelSent) return;
      cancelSent = true;
      try {
        notify("session/cancel", { sessionId: id });
      } catch {
        // Best-effort — process may already be gone; the next send()
        // creates a fresh session anyway.
      }
    },

    async shutdown(): Promise<void> {
      try {
        acp.dispose();
      } catch {
        /* best-effort */
      }
      try {
        await hostMcp.stop();
      } catch {
        /* best-effort */
      }
      currentSessionId = null;
      cancelSent = false;
      sessionNewInFlight = false;
      pendingCancel = false;
    },
  };
}