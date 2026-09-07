// src/ai/claudeCode/claudeCodeChatEngine.ts — TASK-009
//
// Chat-level adapter that turns the TASK-005 `ClaudeCodeProcessHandle` into
// the existing seven-callback agent event contract (`OmpChatEvents` shape),
// starts the in-process HostMcp server before each turn, and stops it on
// dispose. The panel's chat surface (TASK-011) consumes this factory through
// `AiChatPanelOptions.claudeCodeChatEngine`; TASK-012 wires real production
// dependencies.
//
// Architecture (§3(3), §4 in PLAN.md):
//   panel.send(text, attachments?)
//     → ClaudeCodeChatEngine.send(text, events, attachments?)
//     → await hostMcp.start()                (Acceptance: start-before-send)
//     → process.send({ text, attachments? }, forwarded)
//     → forward stream-json events through ClaudeCodeChatEvents callbacks
//     → on result-error / crash → onError → resolve
//
// Resume is intentionally unsupported (TASK-005 did not verify Claude's
// `--resume` flag locally): the engine emits the canonical unsupported error
// and refuses to spawn. This is test-covered.
//
// Privacy invariant (cycle AA): this module NEVER embeds the apiKey, the DB
// credentials, or any secret in any wire frame. HostMcp.start() is the only
// HostMcp interaction — no descriptor is forwarded through Claude Code from
// this layer. Trace payloads (recorded via `redact()`) never carry image
// attachments: the prompt payload is `{ text }` only, so base64 cannot leak
// onto disk or the wire even if a future change forgets to scrub.

// ============================================================================
// Public types
// ============================================================================

import type {
  ClaudeCodeProcessEvents,
  ClaudeCodeProcessHandle,
  ClaudeCodeTurnInput,
} from "./claudeCodeProcess";
import type { HostMcp } from "../omp/ompChatEngine";
import { TraceRecorder, type TraceEvent, type TraceKind, redact } from "../trace";

/**
 * Event surface the chat panel subscribes to per turn.
 *
 * Mirrors `OmpChatEvents` from `src/ai/omp/ompChatEngine.ts:107-116` exactly.
 * Callback signatures must stay byte-for-byte compatible so the same panel
 * subscription works for both engines.
 */
export interface ClaudeCodeChatEvents {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
  /** Optional per-turn trace event sink (default-deny). */
  onTrace?(event: TraceEvent): void;
}

/** Chat-level engine — what the panel talks to. */
export interface ClaudeCodeChatEngine {
  /** Send a user message. Streams via `events`. Resolves when the turn ends
   *  or errors. NEVER throws on crash — fires `onError` and resolves. */
  send(
    text: string,
    events: ClaudeCodeChatEvents,
    attachments?: ReadonlyArray<{ mime: string; base64: string }>,
  ): Promise<void>;
  /** Resume a prior session. TASK-005 did not verify `--resume`; this
   *  implementation surfaces a deterministic unsupported error without
   *  spawning a child. Test-covered. */
  resume(sessionId: string, events: ClaudeCodeChatEvents): Promise<void>;
  /** Best-effort shutdown. Idempotent. */
  dispose(): Promise<void>;
  /** TASK-011 R4.5 fix: cancel the in-flight turn (delegates to the
   *  process handle's `cancel()`, which is idempotent and sends SIGTERM).
   *  Idempotent — safe to call when no turn is in flight or after dispose. */
  cancel(): void;
}

export interface ClaudeCodeChatEngineOptions {
  /** TASK-005 process handle. One instance handles many turns
   *  (each `send()` spawns a fresh child). */
  process: ClaudeCodeProcessHandle;
  /** In-process MCP HTTP server. The engine starts it before each send and
   *  stops it on dispose. No credential / apiKey ever crosses this seam. */
  hostMcp: HostMcp;
  /** Optional trace recorder. When present every turn is recorded; the
   *  engine also forwards to `events.onTrace` for live UI subscribers. */
  trace?: TraceRecorder;
  /** Path passed verbatim to the process as `--mcp-config` (Acceptance: only
   *  forwarded when supplied and non-empty). TASK-012 wires the live path. */
  mcpConfigPath?: string;
}

// ============================================================================
// Internals
// ============================================================================

/** Deterministic message sent to `events.onError` when `send()` is called on
 *  a disposed engine. Test #5 asserts this exact string. */
const DISPOSED_MESSAGE = "claude code chat engine is disposed";

/** Deterministic message sent to `events.onError` for an unsupported resume.
 *  Test #6 asserts this exact string. */
const RESUME_UNSUPPORTED_MESSAGE = "Claude Code session resume is unavailable";

/** Per-turn state shared with the trace emission point. Mirrors the
 *  TurnState pattern in ompChatEngine so `onTrace` sees a monotonic seq
 *  even when no recorder is attached. */
interface TurnState {
  turnId: string;
  seq: number;
}

function buildTraceEvent(
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

/** Single trace emission point. Honours the recorder contract (which
 *  internally runs `redact()`) and falls back to a synthetic event for the
 *  rare case where the panel subscribes to `onTrace` without supplying a
 *  recorder. */
function emitTrace(
  trace: TraceRecorder | undefined,
  state: TurnState | undefined,
  events: ClaudeCodeChatEvents,
  kind: TraceKind,
  payload: unknown,
): void {
  if (!state) return;
  if (trace) {
    const ev = trace.record(state.turnId, kind, payload);
    if (events.onTrace) events.onTrace(ev);
    return;
  }
  if (events.onTrace) events.onTrace(buildTraceEvent(state, kind, payload));
}

// ============================================================================
// Factory
// ============================================================================

export function createClaudeCodeChatEngine(
  opts: ClaudeCodeChatEngineOptions,
): ClaudeCodeChatEngine {
  const { process: proc, hostMcp } = opts;
  let trace = opts.trace;
  const mcpConfigPath =
    opts.mcpConfigPath !== undefined && opts.mcpConfigPath.length > 0
      ? opts.mcpConfigPath
      : undefined;
  let disposed = false;
  let sendSeq = 0;

  return {
    async send(text, events, attachments): Promise<void> {
      if (disposed) {
        events.onError?.(DISPOSED_MESSAGE);
        return;
      }

      // Allocate per-turn trace state iff the caller is wired for tracing.
      // The prompt payload is `{ text }` ONLY — never include attachments or
      // base64. Even if a future change forgets to redact, the payload is
      // shaped so binary image data cannot reach a trace sink.
      const tracing = trace !== undefined || events.onTrace !== undefined;
      const state: TurnState | undefined = tracing
        ? { turnId: `claudeCode-${(sendSeq += 1)}`, seq: 0 }
        : undefined;

      emitTrace(trace, state, events, "prompt", { text });

      // Start HostMcp BEFORE spawning the child (Acceptance: start-before-send).
      // hostMcp.start() is idempotent on its own; an in-flight turn that
      // re-enters send() short-circuits at the disposed / in-flight guard
      // upstream of this code path.
      try {
        await hostMcp.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitTrace(trace, state, events, "error", { message });
        events.onError?.(`hostMcp start failed: ${message}`);
        return;
      }

      // Build the input. Attachments are forwarded ONLY when the caller
      // supplied at least one — `[]` and `undefined` both produce an input
      // whose `attachments` key is absent, so the TASK-005 process emits the
      // legacy text-only stream-json frame (Acceptance: never invent an
      // image block from a phantom empty array).
      const input: ClaudeCodeTurnInput = { text };
      if (attachments !== undefined && attachments.length > 0) {
        input.attachments = attachments;
        if (mcpConfigPath !== undefined) input.mcpConfigPath = mcpConfigPath;
      } else if (mcpConfigPath !== undefined) {
        input.mcpConfigPath = mcpConfigPath;
      }

      // Error dedupe: some process paths fire onError twice (e.g. result-error
      // frames first emit onError, then failTurn() emits it again). The chat
      // engine surfaces exactly one error bubble to the panel.
      let turnErrored = false;

      const forwarded: ClaudeCodeProcessEvents = {
        onDelta: (delta) => {
          emitTrace(trace, state, events, "delta", { text: delta });
          events.onDelta?.(delta);
        },
        onThought: (chunk) => {
          emitTrace(trace, state, events, "thought", { text: chunk });
          events.onThought?.(chunk);
        },
        // The process's onToolStart only carries the tool name — we trace
        // `{ name }` (no args at this layer, matching OmpChatEvents which is
        // also name-only). Args are extracted upstream but never reach here.
        onToolStart: (toolName) => {
          emitTrace(trace, state, events, "tool_start", { name: toolName });
          events.onToolStart?.(toolName);
        },
        // tool_end intentionally drops the `result` payload from the trace
        // (it can be large / arbitrary tool output). `redact()` is still
        // applied so the recorded payload is safe to dump.
        onToolEnd: (toolName, result, isError) => {
          emitTrace(trace, state, events, "tool_end", { name: toolName, isError });
          events.onToolEnd?.(toolName, result, isError);
        },
        onError: (message) => {
          if (turnErrored) return;
          turnErrored = true;
          emitTrace(trace, state, events, "error", { message });
          events.onError?.(message);
        },
        onDone: () => {
          emitTrace(trace, state, events, "done", {});
          events.onDone?.();
        },
        // Engine state observer is intentionally not forwarded — the chat
        // panel doesn't expose it. Re-binding is the process's responsibility.
        onStateChange: undefined,
      };

      try {
        // process.send normally resolves on turn end (onError fires inside
        // the forwarded callbacks). The catch below is a defensive last line
        // — turnErrored guards against the rare case where process.send
        // rejects synchronously AND the forwarded onError has already fired
        // (which is what R4.5's failTurn guard prevents at the process layer);
        // the panel should still see a single onError bubble.
        await proc.send(input, forwarded);
      } catch (err) {
        if (turnErrored) return;
        turnErrored = true;
        const message = err instanceof Error ? err.message : String(err);
        emitTrace(trace, state, events, "error", { message });
        events.onError?.(message);
      }
    },

    async resume(sessionId, events): Promise<void> {
      // TASK-005 did not locally verify Claude Code's `--resume` semantics.
      // Per Acceptance §3 (resume contract): surface the deterministic
      // unsupported error and refuse to spawn. The sessionId is intentionally
      // not read — keeping it in the signature preserves the chat-level
      // engine contract the panel expects.
      void sessionId;
      events.onError?.(RESUME_UNSUPPORTED_MESSAGE);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Stop-on-dispose (Acceptance §4). Both are idempotent upstream; we
      // still wrap each call in try/catch so a misbehaving teardown cannot
      // strand the other side.
      try {
        await hostMcp.stop();
      } catch {
        /* best-effort */
      }
      try {
        await proc.dispose();
      } catch {
        /* best-effort */
      }
    },

    cancel(): void {
      // TASK-011 R4.5 fix: wire Stop to the subprocess cancel path.
      // `proc.cancel()` is idempotent at the process layer (no-op once the
      // handle is disposed or no turn is in flight). We wrap in try/catch
      // so a misbehaving handle cannot break the Stop pipeline.
      try {
        proc.cancel();
      } catch {
        /* best-effort */
      }
    },
  };
}
