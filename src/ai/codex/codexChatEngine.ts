// src/ai/codex/codexChatEngine.ts — TASK-010
//
// Chat-level glue that wires the AI Chat panel to TASK-006's `codex exec
// --json` adapter (`CodexProcessHandle`) and the in-process HostMcp server.
// Mirrors the OmpChatEngine shape so the panel consumes both engines
// through one set of callbacks (Acceptance criterion 1).
//
// IMPORTANT — independence from TASK-009 (per TASK-010 Discussion):
//   The ompChatEngine shape is duplicated LOCALLY here. No shared
//   agent-engine abstraction is introduced. The TASK-004 audit may
//   nominate a future `AgentChatEngine` extraction; until then both
//   TASK-009 and TASK-010 ship their own shape.
//
// Architecture (per-turn lifecycle):
//   panel.send(text, attachments)
//     → CodexChatEngine.send(text, events, attachments)
//     → hostMcp.start()
//     → createProcess() → handle
//     → handle.send({text, attachments}, bridged-events)
//     → forward normalized CodexProcessEvents through CodexChatEvents
//     → on dispose → handle.dispose() (always, success or error)
//
// Privacy invariant (cycle AA parity, no leak through logs / trace / errors):
//   - attachments are forwarded ONLY through process.send() stdin.
//   - trace payloads carry the prompt text + per-event metadata (kind,
//     tool name, isError). base64 is never serialised.
//   - tool_end payloads run `result` through `redact()` before tracing.
//   - error messages run through `redact()` before tracing.

import {
  TraceRecorder,
  type TraceEvent,
  type TraceKind,
  redact,
} from "../trace";

// ============================================================================
// Public contract — types
// ============================================================================

/**
 * Minimal HostMcp surface the engine actually touches. Declared locally
 * instead of importing the full omp/hostMcp — keeps this module
 * independent of any cross-engine shared extraction (TASK-009 / audit).
 */
export interface CodexHostMcp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Image attachment carried with a chat turn. */
export interface CodexImageAttachment {
  mime: string;
  base64: string;
}

/**
 * Normalized callback surface the chat panel subscribes to per turn.
 *
 * Mirrors OmpChatEvents 1:1 — every callback signature and meaning is
 * identical so the panel can route both engines through one set of
 * subscribers (Acceptance criterion 1).
 */
export interface CodexChatEvents {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
  /** Per-turn trace event sink — same shape as OmpChatEvents.onTrace. */
  onTrace?(event: TraceEvent): void;
}

/**
 * Process handle surface the engine consumes. Re-declared locally so the
 * engine can be unit-tested with a fake handle that does NOT pull in the
 * real spawn/stdio machinery. Production wires `CodexProcess` from
 * TASK-006 (`createProcess: () => new CodexProcess(opts).start()`).
 */
export interface CodexProcessHandle {
  sessionId: string;
  version: string;
  state(): string;
  cancel(): void;
  dispose(): Promise<void>;
  send(
    input: {
      text: string;
      attachments?: ReadonlyArray<CodexImageAttachment>;
    },
    events: {
      onDelta?(delta: string): void;
      onThought?(chunk: string): void;
      onToolStart?(toolName: string): void;
      onToolEnd?(toolName: string, result: string, isError: boolean): void;
      onError?(message: string): void;
      onDone?(): void;
    },
  ): Promise<void>;
  getStderrTail(): string;
}

/** Chat-level engine — what the panel talks to. */
export interface CodexChatEngine {
  /**
   * Send a user message with optional image attachments. Streams via
   * `events`. Resolves when the turn ends or errors. NEVER throws on
   * crash — fires `onError` and resolves.
   *
   * `attachments: undefined` is passed through as `undefined` (NOT `[]`)
   * — Acceptance criterion (no payload when no images).
   */
  send(
    text: string,
    events: CodexChatEvents,
    attachments?: ReadonlyArray<CodexImageAttachment>,
  ): Promise<void>;
  /**
   * Resume a prior session.
   *
   * TASK-010 acceptance: TASK-006 noted Codex session-resume is
   * unverified against the upstream CLI. Per the task's hard rule the
   * engine surfaces an explicit
   * `onError("Codex session resume is unavailable")` without spawning a
   * process. Test-pinned.
   */
  resume(sessionId: string, events: CodexChatEvents): Promise<void>;
  /**
   * Best-effort teardown. Idempotent — calling twice is safe; the second
   * call returns the same settled promise. After dispose, `send()` does
   * not spawn and emits `onError("disposed")`.
   */
  dispose(): void | Promise<void>;
  /** TASK-011 R4.5 fix: cancel the in-flight turn (delegates to the
   *  per-turn `CodexProcessHandle.cancel()`, which is idempotent and
   *  sends a termination signal to the child). Safe to call when no
   *  turn is in flight (no-op). */
  cancel(): void;
}

export interface CodexChatEngineOptions {
  /** Factory that returns a live CodexProcessHandle (or rejects). The
   *  engine owns handle.dispose() — production wires
   *  `() => new CodexProcess(opts).start()`. */
  createProcess: () => Promise<CodexProcessHandle>;
  /** Optional HostMcp. Started before every live turn, stopped on dispose. */
  hostMcp?: CodexHostMcp;
  /** Optional trace recorder; every turn's events are recorded into it
   *  (payload redacted before storage). */
  trace?: TraceRecorder;
}

// ============================================================================
// Internal — per-turn state + trace bridge
// ============================================================================

interface TurnState {
  turnId: string;
  seq: number;
}

/**
 * Single trace emission point. Mirrors the ompChatEngine `emit()` shape:
 * if a recorder is attached, the recorder owns the seq; otherwise
 * `state.seq` advances monotonically so onTrace still sees a real seq
 * (AIX-06 r3 parity).
 */
function emit(
  trace: TraceRecorder | undefined,
  state: TurnState | undefined,
  events: CodexChatEvents,
  kind: TraceKind,
  payload: unknown,
): void {
  if (state === undefined) return;
  if (trace !== undefined) {
    const ev = trace.record(state.turnId, kind, payload);
    if (events.onTrace !== undefined) events.onTrace(ev);
    return;
  }
  if (events.onTrace !== undefined) {
    state.seq += 1;
    events.onTrace({
      turnId: state.turnId,
      seq: state.seq,
      kind,
      ts: Date.now(),
      payload: redact(payload),
    });
  }
}

/**
 * Bridge CodexProcessEvents → CodexChatEvents. Re-emits every process
 * event through the chat-events callbacks, recording each one into the
 * trace recorder (with redacted payload) and forwarding to onTrace.
 *
 * The trace payloads NEVER carry base64/secret — `prompt` is recorded
 * with `{ text }` only (no attachments), and tool payloads carry only
 * the tool name + isError flag + redacted result.
 */
function bridgeProcessEvents(
  events: CodexChatEvents,
  trace: TraceRecorder | undefined,
  state: TurnState | undefined,
): {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
} {
  return {
    onDelta: (delta) => {
      emit(trace, state, events, "delta", { text: delta });
      events.onDelta?.(delta);
    },
    onThought: (chunk) => {
      emit(trace, state, events, "thought", { text: chunk });
      events.onThought?.(chunk);
    },
    onToolStart: (name) => {
      emit(trace, state, events, "tool_start", { name });
      events.onToolStart?.(name);
    },
    onToolEnd: (name, result, isError) => {
      // The tool result is the model's output — redact it before tracing
      // so any echoed secret / base64 stays out of the audit log.
      emit(trace, state, events, "tool_end", {
        name,
        isError,
        result: redact(result),
      });
      events.onToolEnd?.(name, result, isError);
    },
    onError: (message) => {
      // Redact the error message — codex process errors may echo stderr
      // tails that contain sensitive paths or config.
      emit(trace, state, events, "error", { message: redact(message) });
      events.onError?.(message);
    },
    onDone: () => {
      emit(trace, state, events, "done", {});
      events.onDone?.();
    },
  };
}

// ============================================================================
// Implementation
// ============================================================================

export function createCodexChatEngine(
  opts: CodexChatEngineOptions,
): CodexChatEngine {
  const { createProcess, hostMcp } = opts;
  let trace: TraceRecorder | undefined = opts.trace;
  // Per-engine turn counter for trace ids (monotonic, never resets).
  let turnCounter = 0;
  // Engine lifecycle — disposed flips on first dispose() and stays true.
  // disposePromise caches the settled promise so a second dispose() call
  // returns it verbatim instead of re-running hostMcp.stop().
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  // TASK-011 R4.5 fix: track the in-flight per-turn process handle so
  // `cancel()` can reach the subprocess. Cleared once the turn settles
  // and on dispose — a cancel() with no live handle is a no-op.
  let inFlightHandle: CodexProcessHandle | undefined;

  async function disposeOnce(): Promise<void> {
    const work: Array<Promise<unknown>> = [];
    if (hostMcp !== undefined) {
      // Idempotent — the engine never calls start() again after dispose.
      work.push(hostMcp.stop().catch(() => undefined));
    }
    await Promise.all(work);
  }

  return {
    async send(text, events, attachments): Promise<void> {
      if (disposed) {
        events.onError?.("disposed");
        return;
      }

      // Per-turn trace state — used by bridgeProcessEvents so onTrace
      // sees a real monotonic seq even when no recorder is attached.
      const state: TurnState | undefined =
        trace !== undefined || events.onTrace !== undefined
          ? { turnId: `turn-${(turnCounter += 1)}`, seq: 0 }
          : undefined;

      // Record the prompt BEFORE starting anything else — the trace
      // captures user intent first, then everything else.
      emit(trace, state, events, "prompt", { text });

      // HostMcp starts BEFORE the process so the model can call tools.
      // A failure here fires onError and resolves the turn.
      if (hostMcp !== undefined) {
        try {
          await hostMcp.start();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit(trace, state, events, "error", { message });
          events.onError?.(`hostMcp start failed: ${message}`);
          return;
        }
      }

      // Spawn the codex process. Factory-supplied so tests can inject
      // fakes without touching the real spawn / stdio machinery.
      let process: CodexProcessHandle | undefined;
      try {
        process = await createProcess();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(trace, state, events, "error", { message });
        events.onError?.(`codex process start failed: ${message}`);
        return;
      }
      // Publish the in-flight handle so cancel() can reach the subprocess
      // (TASK-011 R4.5 fix). Cleared in the finally below once the turn
      // settles, so a Stop after settle is a no-op.
      inFlightHandle = process;

      // Acceptance: pass attachments as structured `{mime, base64}` blocks
      // in their original order. `undefined` (NOT `[]`) when no images —
      // the wire frame downstream preserves the absence.
      const input =
        attachments === undefined
          ? { text }
          : { text, attachments };

      try {
        await process.send(input, bridgeProcessEvents(events, trace, state));
      } catch (err) {
        // Crash mid-turn (process exit / connection lost / send rejection).
        // Acceptance: the panel surfaces a single error bubble — onError
        // fires ONCE, the send resolves, no throw escapes.
        const message = err instanceof Error ? err.message : String(err);
        emit(trace, state, events, "error", { message });
        events.onError?.(message);
      } finally {
        // Always clear the in-flight handle, then dispose the per-turn
        // process. codex children are one-shot per turn — keeping them
        // alive across turns wastes the session-id handshake.
        inFlightHandle = undefined;
        try {
          await process.dispose();
        } catch {
          /* best-effort — process may already be gone */
        }
      }
    },

    async resume(_sessionId, events): Promise<void> {
      // TASK-010 acceptance: TASK-006 noted Codex session-resume is
      // unverified against the upstream CLI. Emit explicit onError without
      // spawning a process. The CALLER's onError callback observes the
      // unavailability; we do not forward to trace because no turn ever
      // began.
      events.onError?.("Codex session resume is unavailable");
    },

    dispose(): Promise<void> {
      if (disposePromise !== null) return disposePromise;
      disposed = true;
      disposePromise = disposeOnce();
      return disposePromise;
    },

    cancel(): void {
      // TASK-011 R4.5 fix: forward Stop to the in-flight subprocess. The
      // handle is captured into `inFlightHandle` at the top of send() and
      // cleared in its finally — a Stop after settle or before send
      // resolves to no-op (no live handle). `process.cancel()` is itself
      // idempotent and best-effort.
      const handle = inFlightHandle;
      if (handle === undefined) return;
      try {
        handle.cancel();
      } catch {
        /* best-effort */
      }
    },
  };
}