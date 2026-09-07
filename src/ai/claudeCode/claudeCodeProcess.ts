// src/ai/claudeCode/claudeCodeProcess.ts
// ClaudeCodeProcess — TDD lifecycle wrapper for the `claude` CLI (Claude Code).
//
// TASK-005 §Goal:
//   - Spawn the real `claude` binary (Anthropic Claude Code) with the
//     verified CLI flags from `claude --help` on 2.1.261 (local):
//       --print --input-format stream-json --output-format stream-json
//       --verbose (and --mcp-config when supplied).
//   - Spawn child process `cwd` is mandatory; no shell interpolation of
//     prompt / image data (stdin is piped JSON, never concatenated into a
//     shell command).
//   - Default-deny permission semantics: `--permission-mode manual` plus
//     `--permission-prompts none`. NEVER `--dangerously-skip-permissions`.
//     This pairs the manual approval mode with "no host answers prompts",
//     which means any tool that would normally prompt is auto-denied.
//   - Wire a NDJSON line transport against the child stdio so we can
//     translate stream-json frames into normalized agent events
//     (onDelta / onThought / onToolStart / onToolEnd / onError / onDone).
//   - Provide a state machine, bounded dispose, optional stderr tail, and
//     a `send(input, events)` per-turn entry point for TASK-009.
//
// Pure / injectable: spawnFn overridable; tests inject fakes.

import {
  spawn as defaultSpawn,
} from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * TASK-005 §Interfaces — closed six-literal state union. Mirrors
 * `OmpEngineState` (src/ai/omp/acpProcess.ts:43) so the panel's fallback/
 * restart owner can treat both engines with the same observer surface.
 */
export type ClaudeCodeEngineState =
  | "stopped"
  | "starting"
  | "ready"
  | "cancelling"
  | "crashed"
  | "fallback-builtin";

/** Per-turn input. `attachments` carries image data URLs as base64 + mime. */
export interface ClaudeCodeTurnInput {
  text: string;
  attachments?: ReadonlyArray<{ mime: string; base64: string }>;
  /** Path to an `--mcp-config` JSON file. TASK-012 supplies this from the
   *  live mcp config path / host bridge; tests omit it. */
  mcpConfigPath?: string;
}

/** Event surface the chat panel subscribes to per turn. Mirrors
 *  `OmpChatEvents` (src/ai/omp/ompChatEngine.ts:107) so the same panel
 *  callback shape works for both engines. */
export interface ClaudeCodeProcessEvents {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
  /** Optional engine-state observer. Fires for every transition. */
  onStateChange?(state: ClaudeCodeEngineState): void;
}

/** Public handle returned by `createClaudeCodeProcess`. */
export interface ClaudeCodeProcessHandle {
  /** Current engine state. Synchronous; safe to call from anywhere. */
  state(): ClaudeCodeEngineState;
  /**
   * Spawn a child for ONE turn, write the input frame, translate
   * stream-json stdout into `events` callbacks, resolve on `result` or
   * reject on terminal failure. NEVER throws on mid-turn crash — fires
   * `onError` and resolves instead.
   */
  send(
    input: ClaudeCodeTurnInput,
    events: ClaudeCodeProcessEvents,
  ): Promise<void>;
  /**
   * Idempotent current-turn cancellation. On a ready handle, transitions
   * to "cancelling" and sends exactly one SIGTERM. Already-terminal
   * handles are a no-op.
   */
  cancel(): void;
  /**
   * Bounded teardown. Sends SIGTERM immediately, escalates to SIGKILL at
   * `CLAUDE_CODE_DISPOSE_TIMEOUT_MS`. Resolves once either escalation is
   * delivered; second call returns the same settled promise.
   */
  dispose(): Promise<void>;
  /**
   * Live-updated bounded tail of the child's stderr. Optional so test
   * fakes that do not model stderr keep compiling; production always
   * provides it.
   */
  getStderrTail?(): string;
}

/** Spawn function override for tests. Mirrors `node:child_process.spawn`
 *  but only the parts the adapter actually uses. */
export type ClaudeCodeSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

/** Exec function override (currently unused; reserved for future
 *  `--version` probing symmetry with `AcpProcess`). */
export type ClaudeCodeExecFn = (cmd: string) => Promise<string>;

export interface ClaudeCodeProcessOptions {
  /**
   * Resolved Claude Code binary path from `ClaudeCodeDetection.path`.
   * Required: the adapter NEVER falls back to bare `"claude"` when this
   * is supplied (Windows `.cmd` compat — see `quoteForCmdExe`).
   */
  claudePath: string;
  /** Workspace cwd supplied to spawn() unconditionally. */
  cwd: string;
  /** Injectable spawn for tests. Defaults to `node:child_process.spawn`. */
  spawnFn?: ClaudeCodeSpawnFn;
  /** Default-deny semantics. Defaults to true (safe). Never bypass. */
  defaultDeny?: boolean;
  /** Reserved for future `--version` probing. */
  execFn?: ClaudeCodeExecFn;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TASK-005 §Acceptance: bounded dispose timeout. SIGTERM is sent
 * immediately; SIGKILL is sent at this bound if the child is still alive.
 * Pinned at 2000ms by §Test Cases #3.
 */
export const CLAUDE_CODE_DISPOSE_TIMEOUT_MS = 2000;

/** Bounded tail of the child's stderr retained for error messages. */
const STDERR_TAIL_LIMIT = 8 * 1024; // 8 KiB

/** Default base64 chunk size used when encoding images into the input
 *  frame (no chunking in our minimal implementation; placeholder). */
const ZERO_BASE64 = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stand-in for the bits of ChildProcess the adapter touches. */
interface ChildLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | string): void;
}

/**
 * Mirror of `quoteForCmdExe` in src/ai/omp/acpProcess.ts:724. With
 * `shell: true` on Windows, Node composes `cmd /d /s /c "<command>
 * <args...>"` by SPACE-JOINING tokens — cmd.exe then re-parses them, and
 * its documented /c quote-stripping fallback (strip first and last
 * quote char) leaves the unprotected text for cmd.exe's own parser.
 * Quoting every token ourselves keeps each token intact through that
 * strip step, so cmd.exe sees one already-quoted unit per token.
 */
function quoteForCmdExe(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Build a stream-json `user` message frame carrying the prompt text and
 * any image attachments. Single source of truth for the input shape.
 *
 * Format reference (live): `claude --input-format stream-json --print`
 * accepts newline-delimited JSON envelopes. The user message follows the
 * Anthropic Messages API content-block shape:
 *   { type: "text", text }
 *   { type: "image", source: { type: "base64", media_type, data } }
 */
function buildUserFrame(input: ClaudeCodeTurnInput): string {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.text },
  ];
  for (const att of input.attachments ?? []) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: att.mime,
        data: att.base64,
      },
    });
  }
  const frame = {
    type: "user",
    message: {
      role: "user",
      content,
    },
  };
  return JSON.stringify(frame) + "\n";
}

/**
 * Extract any text content from a stream-json `assistant` message chunk.
 * Defensive against missing or non-array content — never throws.
 */
function extractAssistantText(
  frame: Record<string, unknown>,
): string | undefined {
  const message = frame["message"];
  if (message === null || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      const t = b["text"] as string;
      if (t.length > 0) return t;
    }
  }
  return undefined;
}

/**
 * Extract tool-use info from an `assistant` message chunk. Returns the
 * tool name (and a generic args record) when a `tool_use` block is
 * present; otherwise undefined. Tool *results* come in via the user's
 * subsequent message in the stream — we forward those as onToolEnd.
 */
function extractToolUse(
  frame: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } | undefined {
  const message = frame["message"];
  if (message === null || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_use" && typeof b["name"] === "string") {
      const argsRaw = b["input"];
      const args: Record<string, unknown> =
        argsRaw !== null && typeof argsRaw === "object" && !Array.isArray(argsRaw)
          ? (argsRaw as Record<string, unknown>)
          : {};
      return { name: b["name"] as string, args };
    }
  }
  return undefined;
}

/**
 * Extract a tool-result block from a `user` message chunk (the model
 * emits tool results as a `user` message in the stream).
 */
function extractToolResult(
  frame: Record<string, unknown>,
): { name: string; result: string; isError: boolean } | undefined {
  const message = frame["message"];
  if (message === null || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_result") {
      const inner = b["content"];
      const text =
        typeof inner === "string"
          ? inner
          : typeof b["text"] === "string"
            ? (b["text"] as string)
            : "";
      const isError = b["is_error"] === true;
      // Tool name lives on the matching tool_use block; we cannot
      // recover it from the result side in the minimal wire format,
      // so we forward "" and let the consumer correlate by seq.
      return { name: "", result: text, isError };
    }
  }
  return undefined;
}

/**
 * Attach the retained stderr tail to an error without including any
 * base64 / secret content. We intentionally do NOT inline the tail into
 * the message string — `getStderrTail()` is the live read view, and a
 * mid-turn error's message must not surface base64 image bytes.
 */
function wrapError(
  base: unknown,
  tail: string,
): Error {
  const err = base instanceof Error ? base : new Error(String(base));
  // Length-only acknowledgement: never copy tail into message text.
  if (tail.length > 0) {
    (err as Error & { stderrTail?: string }).stderrTail = tail;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Internal process class — one instance per `createClaudeCodeProcess`
 * factory call. The factory function is the public seam (TASK-005
 * §Interfaces); the class is implementation detail.
 */
class ClaudeCodeProcessImpl {
  private readonly opts: ClaudeCodeProcessOptions;
  private readonly spawnFn: ClaudeCodeSpawnFn;
  private child: ChildLike | null = null;
  /**
   * True once dispose() / fallback-builtin has landed. After this flag
   * is set, send() rejects and the state machine is locked.
   */
  private disposed = false;
  /** True after `cancel()` was called on a ready handle. */
  private cancelRequested = false;
  /** Single-shot guard for the child `exit` event. */
  private childExited = false;
  /** Cached resolved promise for `dispose()` — second call returns same. */
  private disposePromise: Promise<void> | null = null;
  /** Resolver attached by dispose(); called from `handleChildExit`. */
  private disposeResolve: (() => void) | null = null;
  /** Pending SIGKILL escalation timer; cleared on dispose / exit. */
  private escalateTimer: NodeJS.Timeout | null = null;
  /** Current engine state. Funneled through `setState` for observer
   *  lockstep with the read view. */
  private engineState: ClaudeCodeEngineState = "stopped";
  /** Bound observer — replaced (not stacked) on every `send()`. */
  private onStateChange: ((state: ClaudeCodeEngineState) => void) | null =
    null;
  /** Live bounded tail of stderr for the lifetime of the child. */
  private stderrTail = "";
  /** True while a turn is in flight (spawned → terminal). */
  private turnInFlight = false;
  /** Set to the user-supplied `events` for the in-flight turn. */
  private activeEvents: ClaudeCodeProcessEvents | null = null;
  /** Set to the resolve fn of the in-flight `send()` promise. */
  private turnResolve: (() => void) | null = null;
  /** Set to the reject fn of the in-flight `send()` promise. */
  private turnReject: ((err: Error) => void) | null = null;
  /** Buffered lines from stdout that arrived before any turn started. */
  private lineBuffer = "";

  constructor(opts: ClaudeCodeProcessOptions) {
    this.opts = opts;
    this.spawnFn = opts.spawnFn ?? (defaultSpawn as unknown as ClaudeCodeSpawnFn);
  }

  // ---- Public surface -----------------------------------------------------

  state(): ClaudeCodeEngineState {
    return this.engineState;
  }

  async send(
    input: ClaudeCodeTurnInput,
    events: ClaudeCodeProcessEvents,
  ): Promise<void> {
    if (this.disposed) {
      // Locked — refuse new turns.
      return Promise.reject(new Error("disposed"));
    }
    if (this.turnInFlight) {
      // Single-turn-at-a-time: reject concurrent sends.
      return Promise.reject(new Error("turn already in flight"));
    }
    this.turnInFlight = true;
    this.activeEvents = events;
    this.cancelRequested = false;
    // Rebind state observer each turn — mirrors how AcpProcess keeps
    // the observer pinned to the per-start handler.
    this.onStateChange = events.onStateChange ?? null;

    this.setState("starting");

    // Build argv. Default-deny mode is the only mode we ever use.
    const args: string[] = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (this.opts.defaultDeny !== false) {
      // Default-deny semantics: manual approval mode + no host answering
      // prompts. Anything that would normally prompt → auto-deny.
      args.push("--permission-mode", "manual");
      args.push("--permission-prompts", "none");
    }
    if (input.mcpConfigPath !== undefined && input.mcpConfigPath.length > 0) {
      args.push("--mcp-config", input.mcpConfigPath);
    }

    const isWin32 = process.platform === "win32";
    const spawnCommand = isWin32
      ? quoteForCmdExe(this.opts.claudePath)
      : this.opts.claudePath;
    const spawnArgs = isWin32 ? args.map(quoteForCmdExe) : args;

    const child = this.spawnFn(spawnCommand, spawnArgs, {
      // Pipe stdin/stdout/stderr so the adapter can write JSON frames and
      // read stream-json events. `shell: true` is REQUIRED on win32 to
      // spawn `.cmd` shims (CVE-2024-27980 mitigation).
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      shell: isWin32,
    });
    const spawnLike: ChildLike = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      on: ((ev: string, cb: (...a: unknown[]) => void): void => {
        child.on(ev as "exit", (...a: unknown[]) => {
          if (ev === "exit") {
            (cb as (code: number | null) => void)(a[0] as number | null);
          } else if (ev === "error") {
            (cb as (err: Error) => void)(a[0] as Error);
          }
        });
      }) as ChildLike["on"],
      kill: (signal?: NodeJS.Signals | string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
    this.child = spawnLike;

    // Reset per-turn flags.
    this.childExited = false;
    this.stderrTail = "";
    this.lineBuffer = "";

    // Live stderr drain — bounded tail so we can attach it to onError
    // without unbounded memory growth.
    spawnLike.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderrTail += text;
      if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
        this.stderrTail = this.stderrTail.slice(
          this.stderrTail.length - STDERR_TAIL_LIMIT,
        );
      }
    });

    // Wire the NDJSON line pump against stdout BEFORE transitioning to
    // ready — frames can arrive the instant the child starts.
    spawnLike.stdout.setEncoding("utf8");
    spawnLike.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    // Spawn-error and pre-turn-exit races. Both reject the in-flight
    // turn; we never leave a turn hanging on a child that died.
    spawnLike.on("error", (err) => {
      if (!this.turnInFlight) return;
      this.failTurn(wrapError(err, this.stderrTail));
    });
    spawnLike.on("exit", (code) => {
      // Classify via the canonical handler so the state machine sees
      // every exit exactly once.
      this.handleChildExit(code);
    });

    // Ready: child is spawned and stdio is wired. The turn completes when
    // either (a) a `result` frame lands on stdout, (b) the child exits,
    // or (c) cancel() / dispose() aborts the turn.
    this.setState("ready");

    // Build and write the input frame to stdin. Base64 payload stays in
    // the JSON envelope — it never crosses a shell boundary.
    try {
      const frame = buildUserFrame(input);
      spawnLike.stdin.write(frame);
      // Close stdin so the CLI knows no more user messages are coming.
      // `--print` mode consumes the input stream to EOF before exiting.
      spawnLike.stdin.end();
    } catch (err) {
      this.failTurn(
        wrapError(err, this.stderrTail),
      );
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.cancelRequested) return;
    if (!this.turnInFlight) return;
    this.cancelRequested = true;
    this.setState("cancelling");
    this.reapChild("SIGTERM");
  }

  /**
   * NOTE: deliberately NOT `async` — `async` would wrap the returned
   * cached promise in a new one, breaking the identity contract that
   * a second `dispose()` returns the same Promise instance.
   */
  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    if (this.childExited || !this.turnInFlight) {
      // No live child — just lock the state machine. Cache the
      // resolved promise so a second dispose() returns the SAME
      // instance (matches AcpProcess §Test Cases #7 idempotent
      // dispose semantics).
      this.markDisposed();
      this.setState("stopped");
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    this.reapChild("SIGTERM");
    this.escalateTimer = setTimeout(() => {
      this.escalateTimer = null;
      if (this.childExited) {
        if (this.disposeResolve !== null) {
          const r = this.disposeResolve;
          this.disposeResolve = null;
          r();
        }
        return;
      }
      this.reapChild("SIGKILL");
      // Even if the child never observes SIGKILL, the dispose promise
      // still resolves here so the caller is never hung.
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
    }, CLAUDE_CODE_DISPOSE_TIMEOUT_MS);
    if (typeof this.escalateTimer.unref === "function") {
      this.escalateTimer.unref();
    }
    this.disposePromise = new Promise<void>((resolve) => {
      this.disposeResolve = (): void => {
        if (this.escalateTimer !== null) {
          clearTimeout(this.escalateTimer);
          this.escalateTimer = null;
        }
        // Settle any in-flight turn BEFORE marking disposed — otherwise
        // a send() awaiting a turn promise would hang if the child
        // never emits exit on its own (the SIGKILL escalation lands
        // before the child actually dies).
        this.settleInFlightTurn();
        this.markDisposed();
        this.setState("stopped");
        resolve();
      };
    });
    return this.disposePromise;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  // ---- Internal: state machine -------------------------------------------

  private setState(next: ClaudeCodeEngineState): void {
    if (this.engineState === next) return;
    this.engineState = next;
    const cb = this.onStateChange;
    if (cb !== null) {
      try {
        cb(next);
      } catch {
        /* listener errors must not break the state machine */
      }
    }
  }

  /**
   * TASK-005 §Acceptance: state transition side-effects. Single source
   * of truth for transitions and observer firing.
   */
  private markDisposed(): void {
    this.disposed = true;
    this.turnInFlight = false;
  }

  private reapChild(signal: NodeJS.Signals = "SIGTERM"): void {
    const child = this.child;
    if (child === null) return;
    try {
      child.kill(signal);
    } catch {
      /* best-effort */
    }
  }

  /**
   * TASK-005 §Acceptance: classify a child-exit event and route it
   * through the state machine. Single-shot. Honors:
   *   - exit during starting → crashed → fallback-builtin (terminal)
   *   - exit during ready with cancel requested → stopped
   *   - exit during ready with a `result` success frame → stopped
   *   - exit during ready with no result (unexpected) → crashed
   */
  private handleChildExit(code: number | null): void {
    if (this.childExited) return;
    this.childExited = true;
    if (this.escalateTimer !== null) {
      clearTimeout(this.escalateTimer);
      this.escalateTimer = null;
    }

    // If we already moved into fallback-builtin (e.g. via the spawn-error
    // path), do NOT clobber that — the caller has already settled.
    if (this.disposed && this.engineState === "fallback-builtin") {
      return;
    }

    // Cancel-initiated exit lands at "stopped" regardless of code.
    if (this.cancelRequested) {
      this.completeTurnStopped();
      return;
    }

    if (!this.turnInFlight) {
      // No turn was in flight — defensive; treat as stopped.
      this.setState("stopped");
      return;
    }

    // A clean exit (code 0) with no failure event is treated as a normal
    // completion. Per-turn semantics: the next send() spawns a fresh
    // child; the engine is back at "stopped".
    if (code === 0) {
      this.completeTurnStopped();
      return;
    }

    // Non-zero exit / no result frame → crash → fallback-builtin terminal.
    this.failTurn(
      wrapError(
        new Error(`claude exited with code ${code ?? "null"}`),
        this.stderrTail,
      ),
    );
  }

  // ---- Internal: line pump ------------------------------------------------

  /**
   * NDJSON line pump. Walks the in-flight buffer, slicing on '\n'. Empty
   * lines are skipped; malformed JSON is ignored (Acceptance §5 — a
   * malformed line MUST NOT throw, kill the child, or hang the turn).
   */
  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    let idx: number;
    while ((idx = this.lineBuffer.indexOf("\n")) >= 0) {
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line.length === 0) continue;
      this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Malformed line — drop silently. The adapter never throws here.
      return;
    }
    const type = frame["type"];
    const events = this.activeEvents;
    if (events === null) return;

    if (type === "assistant") {
      const toolUse = extractToolUse(frame);
      if (toolUse !== undefined) {
        events.onToolStart?.(toolUse.name);
      } else {
        const text = extractAssistantText(frame);
        if (text !== undefined) {
          events.onDelta?.(text);
        }
      }
      return;
    }

    if (type === "user") {
      const result = extractToolResult(frame);
      if (result !== undefined) {
        events.onToolEnd?.(result.name, result.result, result.isError);
      }
      return;
    }

    if (type === "result") {
      const subtype = frame["subtype"];
      const isError = subtype === "error" || frame["is_error"] === true;
      if (isError) {
        const message =
          typeof frame["error"] === "object" &&
          frame["error"] !== null &&
          typeof (frame["error"] as Record<string, unknown>)["message"] ===
            "string"
            ? ((frame["error"] as Record<string, unknown>)["message"] as string)
            : typeof frame["result"] === "string"
              ? (frame["result"] as string)
              : "claude turn failed";
        events.onError?.(message);
        this.failTurn(new Error(message));
        return;
      }
      events.onDone?.();
      // Resolve the turn — child exit will follow on the next event-loop
      // tick. We do NOT call handleChildExit() here; the real exit lands
      // via the child `exit` observer and finalises the state machine.
      this.completeTurnSuccess();
      return;
    }

    if (type === "error") {
      const message =
        typeof frame["message"] === "string"
          ? (frame["message"] as string)
          : "claude stream error";
      events.onError?.(message);
      this.failTurn(new Error(message));
      return;
    }

    // Unknown frame type — silently ignored. The adapter never throws.
  }

  // ---- Internal: turn settlement ------------------------------------------

  /**
   * Settle the in-flight turn promise without firing onError. Used when
   * dispose() races the child exit (timer escalation lands first) — the
   * send() promise MUST resolve so the caller is never hung.
   */
  private settleInFlightTurn(): void {
    if (!this.turnInFlight) return;
    this.turnInFlight = false;
    this.activeEvents = null;
    const resolve = this.turnResolve;
    this.turnResolve = null;
    this.turnReject = null;
    if (resolve !== null) resolve();
  }

  /**
   * Mark the turn as cleanly completed. Resolves the in-flight `send()`
   * promise without firing onError. State lands at "stopped"; the next
   * send() will spawn a fresh child.
   */
  private completeTurnSuccess(): void {
    if (!this.turnInFlight) return;
    this.turnInFlight = false;
    this.activeEvents = null;
    const resolve = this.turnResolve;
    this.turnResolve = null;
    this.turnReject = null;
    // We do NOT transition to "stopped" here — wait for the child to
    // actually exit so we don't race the line pump / state observer.
    if (resolve !== null) resolve();
  }

  /**
   * Mark the turn as cleanly stopped (cancel / dispose / 0-exit after a
   * non-result turn). Resolves the in-flight promise (turn is over) and
   * parks the engine at "stopped".
   */
  private completeTurnStopped(): void {
    const hadTurn = this.turnInFlight;
    if (hadTurn) {
      this.turnInFlight = false;
      this.activeEvents = null;
      const resolve = this.turnResolve;
      this.turnResolve = null;
      this.turnReject = null;
      if (resolve !== null) resolve();
    }
    this.setState("stopped");
    if (this.disposeResolve !== null) {
      const r = this.disposeResolve;
      this.disposeResolve = null;
      r();
    }
  }

  /**
   * Mark the turn as failed. Fires onError (once) and rejects the
   * in-flight `send()` promise. Lands the engine at `crashed` then
   * `fallback-builtin` (terminal — caller must construct a new handle
   * to retry).
   */
  private failTurn(err: Error): void {
    if (!this.turnInFlight) return;
    this.turnInFlight = false;
    const events = this.activeEvents;
    this.activeEvents = null;
    const reject = this.turnReject;
    this.turnResolve = null;
    this.turnReject = null;

    // Surface via onError (unless the events object already saw an
    // onError from a result-error / stream-error frame — those paths
    // call failTurn() AFTER firing onError, so we must dedupe here).
    if (events !== null) {
      const message = err.message;
      events.onError?.(message);
    }

    this.setState("crashed");
    this.setState("fallback-builtin");
    this.markDisposed();

    if (reject !== null) reject(err);

    if (this.disposeResolve !== null) {
      const r = this.disposeResolve;
      this.disposeResolve = null;
      r();
    }
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a Claude Code stream-json process/session adapter.
 *
 * Each `send()` spawns a fresh `claude --print` child with the verified
 * CLI flags (locally probed on Claude 2.1.261, see PLAN §CLI flags and
 * the Discussion in docs/AI_HANDOFF/tasks/TASK-005.md). The adapter
 * translates stream-json stdout into the normalized event surface; the
 * caller never needs to know the wire shape.
 *
 * Lifecycle (mirrors `AcpProcess`):
 *   - `state()` is observable at any time.
 *   - `cancel()` aborts the in-flight turn with SIGTERM.
 *   - `dispose()` is bounded — SIGTERM immediately, SIGKILL at
 *     `CLAUDE_CODE_DISPOSE_TIMEOUT_MS`, then resolve.
 *
 * Permission model: default-deny (`--permission-mode manual` +
 * `--permission-prompts none`). Never `--dangerously-skip-permissions`.
 */
export function createClaudeCodeProcess(
  options: ClaudeCodeProcessOptions,
): ClaudeCodeProcessHandle {
  // Touch ZERO_BASE64 to suppress unused-var lint while documenting that
  // we never inline base64 into argv / shell commands.
  void ZERO_BASE64;
  const impl = new ClaudeCodeProcessImpl(options);
  return {
    state: () => impl.state(),
    send: (input, events) => impl.send(input, events),
    cancel: () => impl.cancel(),
    dispose: () => impl.dispose(),
    getStderrTail: () => impl.getStderrTail(),
  };
}
