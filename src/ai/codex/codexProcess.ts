// src/ai/codex/codexProcess.ts
// CodexProcess — TDD lifecycle wrapper cho `codex exec --json` (OpenAI Codex CLI).
//
// TASK-006 §Goal:
//   - Spawn real `codex exec --json -` (the `-` sentinel forces prompt-from-stdin
//     so the adapter can stream a deterministic wire payload; verified from
//     openai/codex `codex-rs/exec/src/cli.rs` line 80).
//   - Spawn child process `cwd` is mandatory; no `--cd` flag is required because
//     `codex exec` does not expose a root-level `--cd` (only `resume`/`fork` do,
//     per developers.openai.com/codex/developer-commands.md).
//   - JSONL line transport: stdout emits one JSON event per line (per the
//     noninteractive doc: `thread.started`, `turn.started`, `turn.completed`,
//     `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`).
//   - Run handshake (thread.started → ready), then per-turn write the translated
//     input frame to stdin and await `turn.completed`/`turn.failed`.
//   - Expose sessionId + version + dispose + send + cancel + state + stderrTail
//     for TASK-010.
//
// Pure / injectable: spawnFn overridable; tests inject fakes. The same six-state
// lifecycle as omp's AcpProcess (TASK-AIX05-101) — keeps the panel's engine-state
// owner uniform across both engines.

import {
  spawn as defaultSpawn,
  exec as defaultExec,
} from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

// ---- Constants ---------------------------------------------------------------

/** Bounded tail of the child's stderr retained for failure messages. */
const STDERR_TAIL_LIMIT = 8 * 1024; // 8 KB

/**
 * TASK-006: bound on a single dispose attempt before termination is escalated
 * to SIGKILL. Pinned at 2000 ms by §Test Cases #3 (same posture as the omp
 * adapter's OMP_ACP_DISPOSE_TIMEOUT_MS).
 */
export const CODEX_DISPOSE_TIMEOUT_MS = 2000;

// ---- Public types ------------------------------------------------------------

export type CodexSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type CodexExecFn = (cmd: string) => Promise<string>;

/**
 * TASK-006 (mirroring omp/AcpProcess §OmpEngineState): the six literal engine
 * states. The set is closed: no other value may ever be emitted to
 * onStateChange, and CodexProcessHandle.state() always returns one of these.
 */
export type CodexEngineState =
  | "stopped"
  | "starting"
  | "ready"
  | "cancelling"
  | "crashed"
  | "fallback-builtin";

/** A single attachment the adapter can ship with a turn. */
export interface CodexAttachment {
  mime: string;
  base64: string;
}

/** Per-turn input handed to `CodexProcessHandle.send()`. */
export interface CodexTurnInput {
  text: string;
  attachments?: ReadonlyArray<CodexAttachment>;
  /**
   * Optional host-MCP config seam. The adapter NEVER embeds DB credentials,
   * apiKey, or base64 into this descriptor — it only forwards the
   * caller-supplied path. Default `undefined` keeps the previous
   * (no-host-MCP) behaviour intact.
   */
  mcpConfigPath?: string;
}

/** Normalized callback surface for one turn. Mirrors omp's OmpChatEvents. */
export interface CodexProcessEvents {
  onDelta?(delta: string): void;
  onThought?(chunk: string): void;
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, result: string, isError: boolean): void;
  onError?(message: string): void;
  onDone?(): void;
}

export interface CodexProcessOptions {
  /**
   * Resolved codex binary path (from `detectCodex()`). Defaults to `"codex"`;
   * callers should pass `CodexDetection.path` so missing binaries surface as
   * a startup error here rather than a confusing `codex: not found` mid-turn.
   */
  codexPath?: string;
  /** Workspace cwd — supplied to spawn() unconditionally. */
  cwd: string;
  /**
   * Optional override for the `codex --version` probe. Default uses the
   * promisified child_process.exec; tests inject a fake.
   */
  execFn?: CodexExecFn;
}

export interface CodexStartHandlers {
  /**
   * TASK-006: observer for the six-literal engine state machine. Fires
   * synchronously for every transition; not invoked again for a state the
   * handle is already in.
   */
  onStateChange?: (state: CodexEngineState) => void;
}

export interface CodexProcessHandle {
  /** Codex thread id captured from `thread.started`. */
  sessionId: string;
  /** Codex version (from `codex --version`), or "unknown" if unavailable. */
  version: string;
  /** Current engine state. */
  state(): CodexEngineState;
  /**
   * TASK-006: idempotent current-turn cancellation. On a ready handle,
   * transitions to "cancelling" and sends exactly one termination signal.
   * Safe to call more than once; safe to call after the handle has already
   * entered "stopped"/"crashed"/"fallback-builtin" (no-op).
   */
  cancel(): void;
  /**
   * TASK-006: bounded teardown. Sends SIGTERM immediately, then escalates
   * to SIGKILL after CODEX_DISPOSE_TIMEOUT_MS if the child is still alive.
   * Resolves once either escalation is delivered. Safe to call more than
   * once (idempotent — second call returns immediately).
   */
  dispose(): Promise<void>;
  /**
   * TASK-006: send a user turn. Streams frames through `events`. Resolves on
   * `turn.completed` / `turn.failed` / process exit / dispose. NEVER throws
   * on crash — fires `onError` and resolves.
   */
  send(input: CodexTurnInput, events: CodexProcessEvents): Promise<void>;
  /**
   * TASK-006: live tail of the child's stderr, bounded to ≤8 KiB. Surface
   * it for callers (the panel's run-turn catch) so auth/model errors that
   * happen mid-turn are visible instead of silently discarded.
   */
  getStderrTail(): string;
}

// ---- Internal child shape ---------------------------------------------------

interface ChildLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | string): void;
}

// ---- Implementation ---------------------------------------------------------

export class CodexProcess {
  private readonly opts: CodexProcessOptions;
  private readonly spawnFn: CodexSpawnFn;
  private readonly execFn: CodexExecFn;
  private child: ChildLike | null = null;
  private disposed = false;
  /**
   * TASK-006: the six-literal state machine. Single source of truth for
   * both internal transitions and the handle.state() observer. Every external
   * state change must funnel through setState() so onStateChange fires in
   * lockstep with the read view.
   */
  private engineState: CodexEngineState = "stopped";
  private onStateChange: ((state: CodexEngineState) => void) | null = null;
  /**
   * TASK-006: a "cancel was requested" flag set the first time
   * `handle.cancel()` is called on a ready handle. The state machine uses
   * this to decide whether a subsequent child exit is "stopped" (cancel-
   * initiated) or "crashed" (unexpected) once we're past the ready phase.
   */
  private cancelRequested = false;
  /**
   * TASK-006: promise that resolves when the dispose() teardown is complete.
   * Stored so a second dispose() call returns the same settled promise
   * without firing a second SIGTERM/SIGKILL.
   */
  private disposePromise: Promise<void> | null = null;
  private disposeResolve: (() => void) | null = null;
  /**
   * TASK-006: timer handle for the SIGKILL escalation scheduled by dispose().
   * Cleared on real exit so a late kill never lands on a long-dead child.
   */
  private escalateTimer: NodeJS.Timeout | null = null;
  /**
   * TASK-006: set true on the FIRST observed child exit. Every later exit
   * (real or fake) is a no-op for state changes and kills.
   */
  private childExited = false;
  /**
   * TASK-006: marks the spawn step complete and the handshake finished.
   * Once true, child exits are classified as crashes (unless cancel was
   * requested, in which case they're "stopped"). Set after `thread.started`
   * resolves.
   */
  private readyReached = false;
  /** Live stderr tail (bounded), shared with `getStderrTail()`. */
  private stderrTail = "";
  /** Captured thread id from `thread.started`. Empty string until the frame lands. */
  private threadId = "";
  /** Resolver for the start() promise; settles once thread.started arrives. */
  private startResolve:
    | ((handle: { sessionId: string; version: string }) => void)
    | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private startSettled = false;

  constructor(
    opts: CodexProcessOptions,
    spawnFn: CodexSpawnFn = defaultSpawn as unknown as CodexSpawnFn,
  ) {
    this.opts = opts;
    this.spawnFn = spawnFn;
    this.execFn = opts.execFn ?? defaultExecFn;
  }

  /**
   * Spawn codex + complete the handshake (`thread.started` frame). Resolves
   * with `{ sessionId, version, dispose, cancel, state, send, getStderrTail }`.
   *
   * On spawn error / pre-handshake exit, rejects with an error whose message
   * includes the bounded stderr tail.
   */
  async start(handlers: CodexStartHandlers = {}): Promise<CodexProcessHandle> {
    if (handlers.onStateChange !== undefined) {
      this.onStateChange = handlers.onStateChange;
    }
    this.setState("starting");

    const codexPath = this.opts.codexPath ?? "codex";
    // Verified wire shape: openai/codex cli.rs line 10-81 — root `Cli` exposes
    // `--json` (and `--experimental-json` alias) for the JSONL stream. `-` is
    // the documented stdin-prompt sentinel (cli.rs line 80).
    const args: string[] = ["exec", "--json", "-"];

    const isWin32 = process.platform === "win32";
    // Review Finding parity with omp: with `shell: true` on win32, Node
    // composes `cmd /d /s /c "<command> <arg1> <arg2> ...>"` by plain
    // SPACE-JOINING `command` + `args`. Quote each token ourselves so an
    // install path with spaces or a cwd with cmd.exe metacharacters survives
    // cmd.exe's /s re-parse as one unit.
    const spawnCommand = isWin32 ? quoteForCmdExe(codexPath) : codexPath;
    const spawnArgs = isWin32 ? args.map(quoteForCmdExe) : args;

    const child = this.spawnFn(spawnCommand, spawnArgs, {
      // Pipe stdin/stdout/stderr so we can stream the prompt + parse JSONL.
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      // Review Finding 2 parity: on Windows, codex ships a `.cmd` shim; Node
      // >= 20.12 refuses to spawn a `.cmd` file directly without `shell: true`
      // (CVE-2024-27980 mitigation). shell stays false on macOS/Linux where
      // codex is a real executable.
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

    // TASK-006 (B10 parity): drain stderr continuously from spawn onwards — an
    // unread pipe can block the child once its OS buffer fills, and codex's
    // own auth/model/config error text would otherwise be discarded entirely.
    // Keep a bounded tail so startup errors can surface it.
    spawnLike.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.appendStderrTail(text);
    });

    // Race: thread.started handshake vs spawn 'error' / child 'exit' failure.
    const startError = new Promise<never>((_, reject) => {
      spawnLike.on("error", (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      spawnLike.on("exit", (code) => {
        reject(
          new Error(
            `codex exec exited before handshake (code=${code ?? "null"})`,
          ),
        );
      });
    });

    // JSONL line pump — see docs/AI_HANDOFF/tasks/TASK-006.md for verified
    // event envelope (one JSON object per line, tagged `type`).
    attachJsonlLineTransport(
      spawnLike.stdout,
      (frame) => this.handleFrame(frame),
    );

    // Single child-exit observer: classifies the exit per TASK-006 §Test
    // Cases #3/#4 and fires the state machine exactly once.
    spawnLike.on("exit", (code) => {
      this.handleChildExit(code);
    });

    try {
      const startPromise = new Promise<{ sessionId: string; version: string }>(
        (resolve, reject) => {
          this.startResolve = resolve;
          this.startReject = reject;
        },
      );

      // Surface codex version via execFn (best-effort; ignored on failure).
      let version = "unknown";
      try {
        const raw = await this.execFn(`${codexPath} --version`);
        const m = raw.match(/(\d+(?:\.\d+)+)/);
        if (m !== null && m[1] !== undefined) {
          version = m[1];
        }
      } catch {
        /* keep "unknown" */
      }

      const result = await Promise.race([startPromise, startError]);
      const sessionId = result.sessionId || this.threadId;

      this.readyReached = true;
      this.setState("ready");

      const handle: CodexProcessHandle = {
        sessionId,
        version,
        state: () => this.engineState,
        cancel: () => this.requestCancel(),
        dispose: () => this.dispose(),
        send: (input, events) => this.send(input, events),
        getStderrTail: () => this.stderrTail,
      };
      return handle;
    } catch (err) {
      // Child never finished handshaking — settle terminal state and surface
      // the bounded stderr tail on the rejected error.
      if (!this.disposed) {
        this.setState("fallback-builtin");
        this.markDisposed();
      }
      throw attachStderrTail(err, this.stderrTail);
    }
  }

  // ---- send() --------------------------------------------------------------

  /**
   * Translate `input` to a wire frame (one JSON object) and write it to the
   * child's stdin. Stream JSONL responses through `events`. Resolves on
   * `turn.completed`, `turn.failed`, process exit, or dispose.
   *
   * Order of input parts is preserved: text first, then attachments in their
   * original order. The adapter serialises the wire frame as
   * `{ prompt, parts: [{type:"text", text}, {type:"image", mime, base64}, ...] }`
   * — see docs/AI_HANDOFF/tasks/TASK-006.md §2026-09-07 · executor · unic-code
   * for the verified upstream behaviour (stdin appended as `<stdin>` block on
   * prompt-plus-stdin flows; `codex exec -` forces stdin-prompt).
   */
  private async send(
    input: CodexTurnInput,
    events: CodexProcessEvents,
  ): Promise<void> {
    if (this.disposed) {
      events.onError?.("disposed");
      return;
    }
    const child = this.child;
    if (child === null) {
      events.onError?.("codex child not running");
      return;
    }

    const wireFrame = buildInputFrame(input);

    return new Promise<void>((resolve) => {
      let settled = false;
      // Use a holder object so we can reassign `settle` from inside closures
      // (e.g. after the stdin write). `const settle = () => ...` would
      // otherwise crash on reassignment.
      const holder: { fn: (() => void) | null } = { fn: null };
      const settle = (): void => {
        if (settled) return;
        settled = true;
        detach();
        resolve();
      };
      holder.fn = settle;

      // Pump JSONL frames for the lifetime of this turn; filter for
      // turn-scoped events only.
      const detach = attachJsonlLineTransport(
        child.stdout,
        (frame) => {
          if (!isRecord(frame)) return;
          const type = frame["type"];
          if (typeof type !== "string") return;
          // Mid-turn: agent_message → onDelta; turn.failed/error → onError;
          // turn.completed → onDone.
          if (type === "item.completed" || type === "item.started" || type === "item.updated") {
            const item = frame["item"];
            if (isRecord(item) && item["type"] === "agent_message") {
              const text = item["text"];
              if (typeof text === "string" && text.length > 0) {
                events.onDelta?.(text);
              }
            } else if (isRecord(item) && item["type"] === "reasoning") {
              const text = item["text"];
              if (typeof text === "string" && text.length > 0) {
                events.onThought?.(text);
              }
            }
            return;
          }
          if (type === "turn.completed") {
            events.onDone?.();
            settle();
            return;
          }
          if (type === "turn.failed") {
            const errField = frame["error"];
            const msg =
              isRecord(errField) && typeof errField["message"] === "string"
                ? (errField["message"] as string)
                : "turn.failed";
            events.onError?.(msg);
            settle();
            return;
          }
          if (type === "error") {
            const msg =
              typeof frame["message"] === "string"
                ? (frame["message"] as string)
                : "codex error";
            events.onError?.(msg);
            settle();
            return;
          }
        },
      );

      // Wire the prompt to stdin. Don't include any base64/secret in the
      // frame that's *also* logged — the wire frame is JSON on stdin, never
      // echoed to logs / stderr.
      try {
        child.stdin.write(JSON.stringify(wireFrame) + "\n");
        // End stdin so codex knows the prompt is complete (and so the `-`
        // sentinel sees EOF immediately). Code reading prompt from stdin
        // gets exactly this one frame.
        try {
          child.stdin.end();
        } catch {
          /* best-effort */
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onError?.(`stdin write failed: ${msg}`);
        settle();
        return;
      }

      // Crash / dispose mid-turn: resolve the promise; onError fires with the
      // bounded stderr tail. settle() is idempotent.
      const onExit = (code: number | null): void => {
        events.onError?.(
          `codex exited mid-turn (code=${code ?? "null"})\n--- codex stderr (tail) ---\n${this.stderrTail}`,
        );
        settle();
      };
      child.on("exit", onExit);
      // Touch `holder` so the unused-binding lint stays quiet — it documents
      // the original intent (re-bindable settle), now resolved through
      // settle() being called from onExit.
      void holder;
    });
  }

  // ---- state machine -------------------------------------------------------

  private setState(next: CodexEngineState): void {
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
   * Handle a JSONL frame from the child's stdout. During the start handshake
   * we only watch for `thread.started` (to capture thread_id and settle the
   * start promise). During a `send()` turn, the per-turn JSONL pump watches
   * for `item.completed` / `turn.completed` / `turn.failed` / `error` —
   * those are handled inside `send()`'s own pump, NOT here.
   */
  private handleFrame(frame: unknown): void {
    if (!isRecord(frame)) return;
    const type = frame["type"];
    if (typeof type !== "string") return;
    if (type === "thread.started") {
      const threadId = frame["thread_id"];
      if (typeof threadId === "string" && threadId.length > 0) {
        this.threadId = threadId;
      }
      if (!this.startSettled && this.startResolve !== null) {
        this.startSettled = true;
        const r = this.startResolve;
        this.startResolve = null;
        this.startReject = null;
        r({ sessionId: this.threadId, version: "unknown" });
      }
      return;
    }
    // Other frames before start() resolves are dropped — codex won't emit
    // them before thread.started, but a buggy / non-standard build might.
  }

  private handleChildExit(code: number | null): void {
    if (this.childExited) return;
    this.childExited = true;
    if (this.escalateTimer !== null) {
      clearTimeout(this.escalateTimer);
      this.escalateTimer = null;
    }
    // Start handshake never landed — reject it now.
    if (!this.startSettled && this.startReject !== null) {
      this.startSettled = true;
      const r = this.startReject;
      this.startResolve = null;
      this.startReject = null;
      r(
        attachStderrTail(
          new Error(
            `codex exec exited before handshake (code=${code ?? "null"})`,
          ),
          this.stderrTail,
        ),
      );
    }
    if (this.disposed) {
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
      return;
    }
    if (this.cancelRequested) {
      this.setState("stopped");
      this.markDisposed();
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
      return;
    }
    if (!this.readyReached) {
      this.setState("crashed");
      this.setState("fallback-builtin");
      this.markDisposed();
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
      return;
    }
    this.setState("crashed");
    this.markDisposed();
    if (this.disposeResolve !== null) {
      const r = this.disposeResolve;
      this.disposeResolve = null;
      r();
    }
    void code;
  }

  private markDisposed(): void {
    this.disposed = true;
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

  private requestCancel(): void {
    if (this.disposed) return;
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    if (!this.readyReached) {
      this.reapChild();
      return;
    }
    this.setState("cancelling");
    this.reapChild();
  }

  private dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    if (this.childExited) {
      this.markDisposed();
      this.setState("stopped");
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }
    this.reapChild();
    this.escalateTimer = setTimeout(() => {
      this.escalateTimer = null;
      if (this.childExited) return;
      this.reapChild("SIGKILL");
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
    }, CODEX_DISPOSE_TIMEOUT_MS);
    if (typeof this.escalateTimer.unref === "function") {
      this.escalateTimer.unref();
    }
    this.disposePromise = new Promise<void>((resolve) => {
      this.disposeResolve = (): void => {
        if (this.escalateTimer !== null) {
          clearTimeout(this.escalateTimer);
          this.escalateTimer = null;
        }
        this.markDisposed();
        this.setState("stopped");
        resolve();
      };
    });
    return this.disposePromise;
  }

  private appendStderrTail(text: string): void {
    this.stderrTail += text;
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail = this.stderrTail.slice(
        this.stderrTail.length - STDERR_TAIL_LIMIT,
      );
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translate a CodexTurnInput into the wire frame written to the child's stdin.
 *
 * Shape (verified from openai/codex noninteractive doc):
 *   {
 *     "prompt": "<text>",          // top-level summary so callers that ignore
 *                                  // `parts` still see the user text.
 *     "parts": [
 *       { "type": "text", "text": "..." },
 *       { "type": "image", "mime": "image/png", "base64": "..." }
 *     ]
 *   }
 *
 * Order is preserved: `text` is always emitted first if present, then each
 * attachment in its original order. `attachments` are NOT echoed into any log
 * line; they only ever travel through the stdin pipe.
 */
export function buildInputFrame(input: CodexTurnInput): {
  prompt: string;
  parts: ReadonlyArray<Record<string, unknown>>;
} {
  const parts: Array<Record<string, unknown>> = [];
  if (input.text.length > 0) {
    parts.push({ type: "text", text: input.text });
  }
  if (input.attachments !== undefined) {
    for (const att of input.attachments) {
      parts.push({
        type: "image",
        mime: att.mime,
        base64: att.base64,
      });
    }
  }
  return { prompt: input.text, parts };
}

/**
 * TASK-006: append the retained stderr tail (if any) to a startup error's
 * message and expose it as `.stderrTail` for callers/tests.
 */
function attachStderrTail(err: unknown, tail: string): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  if (tail.length > 0) {
    base.message = `${base.message}\n--- codex stderr (tail) ---\n${tail}`;
  }
  (base as Error & { stderrTail?: string }).stderrTail = tail;
  return base;
}

/**
 * Review Finding 1 (parity with omp): quote a single argv token so it survives
 * cmd.exe's `/d /s /c "<command> <args...>"` re-parse as one unit, even when
 * it contains a space or a cmd.exe metacharacter (`&`, `|`, `<`, `>`, etc).
 */
function quoteForCmdExe(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function defaultExecFn(cmd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    defaultExec(cmd, (err, stdout) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Attach a JSONL line pump to a readable stream. The pump buffers partial
 * lines across `data` chunks, emits one frame per newline, and returns a
 * `detach()` function that removes the listener.
 */
function attachJsonlLineTransport(
  stdout: NodeJS.ReadableStream,
  onFrame: (frame: unknown) => void,
): () => void {
  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Malformed JSON line — skip silently per TASK-006 §Test Cases #2.
        continue;
      }
      try {
        onFrame(parsed);
      } catch {
        /* listener errors must not break the line pump */
      }
    }
  };
  stdout.on("data", onData);
  return () => {
    try {
      stdout.off("data", onData);
    } catch {
      /* best-effort */
    }
  };
}
