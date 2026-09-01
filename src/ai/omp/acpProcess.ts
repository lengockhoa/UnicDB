// src/ai/omp/acpProcess.ts
// AcpProcess — TDD lifecycle wrapper cho `omp acp`.
//
// TASK-002 §Goal:
//   - Spawn real `omp acp` (no `--mode rpc`, no yolo/--approval-mode/--auto-approve).
//   - Spawn child process `cwd` is mandatory; `--cwd` flag is conditional on
//     TASK-001-evidenced support.
//   - Wire AcpClient (TASK-001) through a NDJSON transport against the child stdio.
//   - Run initialize → initialized → session/new to produce session metadata.
//   - Expose sessionId + version + dispose + onNotification/onServerRequest for TASK-004.
//
// Pure / injectable: spawnFn and execFn overridable; tests inject fakes.

import {
  spawn as defaultSpawn,
  exec as defaultExec,
} from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { AcpClient, type AcpTransport, type AcpNotificationHandler, type AcpServerRequestHandler } from "./acp";

export type AcpSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type AcpExecFn = (cmd: string) => Promise<string>;

/** Bounded tail of the child's stderr retained for startup-error messages. */
const STDERR_TAIL_LIMIT = 8 * 1024; // 8 KB

/**
 * TASK-AIX05-101: bound on a single dispose attempt before termination is
 * escalated to SIGKILL. Pinned at 2000 ms by §Test Cases #7.
 */
export const OMP_ACP_DISPOSE_TIMEOUT_MS = 2000;

/**
 * TASK-AIX05-101: the six literal engine states. The set is closed: no
 * other value may ever be emitted to onStateChange, and AcpProcessHandle.state()
 * always returns one of these.
 */
export type OmpEngineState =
  | "stopped"
  | "starting"
  | "ready"
  | "cancelling"
  | "crashed"
  | "fallback-builtin";

/** Expected ACP protocol version; initialize replies with any other value reject. */
const EXPECTED_OMP_PROTOCOL_VERSION = 1;

export interface AcpProcessOptions {
  /**
   * Resolved omp binary path. Defaults to "omp"; callers should pass the path
   * from `detectOmp()` so missing binaries surface as a startup error here.
   */
  ompPath?: string;
  /** Workspace cwd — supplied to spawn() unconditionally. */
  cwd: string;
  /**
   * TASK-001 evidence: `omp acp --cwd <workspace>` accepted by omp 18.0.1.
   * Set to false to probe a server that does NOT accept --cwd; the spawn
   * option `cwd` always enforces the workspace boundary either way.
   */
  supportCwdFlag: boolean;
  execFn?: AcpExecFn;
  /**
   * TASK-006 (B4b): per-request bound in ms passed through to AcpClient.
   * Default 30_000 (AcpClient's DEFAULT_ACP_REQUEST_TIMEOUT_MS); tests pass
   * a small value so a stalled handshake fails fast instead of hanging.
   */
  requestTimeoutMs?: number;
  /**
   * TASK-012 (B11a): ACP `McpServer` descriptor array forwarded verbatim into
   * `session/new`'s `mcpServers` param. Previously hardcoded to `[]`, which
   * meant the omp engine had zero database tool access. Defaults to `[]` so
   * every existing caller/test that omits it keeps today's behavior exactly.
   */
  mcpServers?: ReadonlyArray<Record<string, unknown>>;
}

export interface AcpStartHandlers {
  onNotification?: AcpNotificationHandler;
  onServerRequest?: AcpServerRequestHandler;
  /**
   * TASK-AIX05-101: observer for the six-literal engine state machine.
   * Fires synchronously for every transition; not invoked again for a
   * state the handle is already in. Optional so existing test fakes
   * continue to compile unchanged.
   */
  onStateChange?: (state: OmpEngineState) => void;
}

export interface AcpProcessHandle {
  acp: AcpClient;
  sessionId: string;
  version: string;
  /**
   * TASK-AIX05-101: current engine state, observable by callers (e.g. the
   * panel's fallback/restart owner) on every transition.
   */
  state(): OmpEngineState;
  /**
   * TASK-AIX05-101: idempotent current-turn cancellation. On a ready
   * handle, transitions to "cancelling" and sends exactly one termination
   * signal. Safe to call more than once; safe to call after the handle
   * has already entered "stopped"/"crashed"/"fallback-builtin" (no-op).
   */
  cancel(): void;
  /**
   * TASK-AIX05-101: bounded teardown. Sends SIGTERM immediately, then
   * escalates to SIGKILL after OMP_ACP_DISPOSE_TIMEOUT_MS if the child is
   * still alive. Resolves once either escalation is delivered; a late
   * exit after resolve does NOT emit a new state or another kill. Safe
   * to call more than once (idempotent — second call returns immediately).
   */
  dispose(): Promise<void>;
  /**
   * Review Finding 4: bounded tail of the child's stderr, live-updated for
   * the lifetime of the process — NOT just up to the handshake. Pre-fix,
   * the tail was only ever attached to a handshake-failure error
   * (`attachStderrTail` inside `start()`'s catch); after a successful
   * handshake the tail kept filling but was never read again, so an omp
   * auth/model error DURING `session/prompt` produced an empty assistant
   * bubble with the explanatory stderr silently discarded. Callers (the
   * panel's `runAcpTurn` catch) should append this to a mid-turn error.
   * Optional so existing test fakes that don't model stderr keep compiling;
   * production `start()` always provides it.
   */
  getStderrTail?: () => string;
}

interface ChildLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | string): void;
}

export class AcpProcess {
  private readonly opts: AcpProcessOptions;
  private readonly spawnFn: AcpSpawnFn;
  private readonly execFn: AcpExecFn;
  private child: ChildLike | null = null;
  private acp: AcpClient | null = null;
  private disposed = false;
  /**
   * TASK-AIX05-101: the six-literal state machine. Single source of truth
   * for both internal transitions and the handle.state() observer. Every
   * external state change must funnel through setState() so onStateChange
   * fires in lockstep with the read view.
   */
  private engineState: OmpEngineState = "stopped";
  private onStateChange: ((state: OmpEngineState) => void) | null = null;
  /**
   * TASK-AIX05-101: a "cancel was requested" flag set the first time
   * `handle.cancel()` is called on a ready handle. The state machine uses
   * this to decide whether a subsequent child exit is "stopped" (cancel-
   * initiated) or "crashed" (unexpected) once we're past the ready phase.
   * Cleared once the exit has been classified.
   */
  private cancelRequested = false;
  /**
   * TASK-AIX05-101: promise that resolves when the dispose() teardown is
   * complete. Stored so a second dispose() call (or dispose() called after
   * the child has already exited) returns the same settled promise without
   * firing a second SIGTERM/SIGKILL.
   */
  private disposePromise: Promise<void> | null = null;
  /**
   * TASK-AIX05-101: timer handle for the SIGKILL escalation scheduled by
   * dispose(). Kept so a late exit (or an already-completed dispose) can
   * clear it and avoid firing an extra kill on a long-dead child.
   */
  private escalateTimer: NodeJS.Timeout | null = null;
  /**
   * TASK-AIX05-101: set true on the FIRST observed child exit. Every later
   * exit (real or fake) is a no-op for state changes and kills. The
   * AcpClient's onClose path is wired through the same single-shot so
   * post-handshake exit fires the panel's onClose listeners exactly once
   * (preserved from the prior fix).
   */
  private childExited = false;
  /**
   * TASK-AIX05-101: marks the spawn step complete and the handshake
   * finished. Once true, child exits are classified as crashes (unless
   * cancel was requested, in which case they're "stopped"). Set after
   * session/new resolves successfully.
   */
  private readyReached = false;
  /**
   * TASK-AIX05-101: tracks whether a spawn 'error' has been observed.
   * Handshake-time exits see this and reject with a start-failure rather
   * than racing a "crashed → fallback-builtin" transition. Cleared once
   * used so the post-handshake "error" path is a real crash.
   */
  private spawnErrored = false;
  /**
   * TASK-AIX05-101: the most recent spawn error, captured so start()'s
   * outer catch can reject with the ORIGINAL spawn error rather than the
   * generic "exited before handshake" message that the error/exit race
   * would otherwise pick.
   */
  private lastSpawnError: Error | null = null;

  constructor(
    opts: AcpProcessOptions,
    spawnFn: AcpSpawnFn = defaultSpawn as unknown as AcpSpawnFn,
  ) {
    this.opts = opts;
    this.spawnFn = spawnFn;
    this.execFn = opts.execFn ?? defaultExecFn;
  }

  /**
   * Spawn omp + complete initialize / initialized / session/new handshake.
   * Resolves with `{ acp, sessionId, version, dispose, cancel, state }`.
   */
  async start(handlers: AcpStartHandlers = {}): Promise<AcpProcessHandle> {
    this.onStateChange = handlers.onStateChange ?? null;
    this.setState("starting");

    const ompPath = this.opts.ompPath ?? "omp";
    const args: string[] = ["acp"];
    if (this.opts.supportCwdFlag) {
      args.push("--cwd", this.opts.cwd);
    }

    const isWin32 = process.platform === "win32";
    // Review Finding 1 (fix round 2): with `shell: true` on win32, Node
    // composes `cmd /d /s /c "<command> <arg1> <arg2> ...>"` by plain
    // SPACE-JOINING `command` + `args` — it does NOT quote each token for
    // cmd.exe (see lib/internal/child_process.js normalizeSpawnArguments).
    // Two consequences: an install path with spaces (`C:\Program
    // Files\...\omp.cmd`) splits into multiple cmd.exe tokens and fails to
    // spawn; a workspace cwd containing a cmd.exe metacharacter (e.g. `&`)
    // is parsed by cmd.exe as a command separator, i.e. arbitrary command
    // execution at session start. Node's own outer quote-wrap doesn't save
    // us: because `/s` is also passed, cmd.exe's own /c handling falls into
    // its documented fallback ("strip the first char if it's a quote, and
    // remove the LAST quote character on the line") — which, with no other
    // quotes in the composed string, just strips the two outer quotes Node
    // added and hands the unprotected text straight to cmd.exe's parser.
    // Quoting every token ourselves (mirroring `quoteForShell` in
    // detect.ts, but always-on since cmd.exe metacharacters need
    // neutralizing, not just whitespace) keeps our quotes intact through
    // that same strip-first-and-last-char step, so cmd.exe sees each
    // token as one already-quoted unit. No-op on macOS/Linux (shell stays
    // false there; omp is a real executable on those platforms).
    const spawnCommand = isWin32 ? quoteForCmdExe(ompPath) : ompPath;
    const spawnArgs = isWin32 ? args.map(quoteForCmdExe) : args;

    const child = this.spawnFn(spawnCommand, spawnArgs, {
      // Pipe stdin/stdout/stderr so AcpClient can talk NDJSON to the child.
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      // Review Finding 2: on Windows, `where omp` typically resolves
      // `omp.cmd` — a shell shim, not a real PE executable. Node >= 20.12
      // refuses to spawn a `.cmd` file directly without `shell: true`
      // (CVE-2024-27980 mitigation), so every session start would die with
      // ENOENT despite detectOmp() reporting omp usable. No-op on
      // macOS/Linux (spawnFn's default is already effectively `shell:
      // false` there and omp is a real executable on those platforms).
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

    // TASK-006 (B10): drain stderr continuously from spawn onwards — an
    // unread pipe can block the child once its OS buffer fills, and omp's
    // own auth/model/config error text was previously discarded entirely.
    // Keep a bounded tail so startup errors can surface it.
    let stderrTail = "";
    spawnLike.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail += text;
      if (stderrTail.length > STDERR_TAIL_LIMIT) {
        stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_LIMIT);
      }
    });

    // Race: ready handshake vs spawn 'error' / child 'exit' failure. We
    // record the original spawn error so the outer catch (which would
    // otherwise race the exit-rejection path) can surface the real cause.
    // Any pre-handshake exit (clean OR non-zero) is a failure: a clean
    // exit before `initialize` resolves means the agent never finished
    // handshaking, and start() must reject — not hang waiting for a
    // response that will never come.
    const startError = new Promise<never>((_, reject) => {
      spawnLike.on("error", (err) => {
        this.spawnErrored = true;
        this.lastSpawnError = err instanceof Error ? err : new Error(String(err));
        reject(this.lastSpawnError);
      });
      spawnLike.on("exit", (code) => {
        reject(new Error(`omp acp exited before handshake (code=${code ?? "null"})`));
      });
    });

    const transport: AcpTransport = createAcpLineTransport(spawnLike.stdin, spawnLike.stdout);
    const acp = new AcpClient(transport, { requestTimeoutMs: this.opts.requestTimeoutMs });
    if (handlers.onNotification !== undefined) acp.onNotification(handlers.onNotification);
    if (handlers.onServerRequest !== undefined) acp.onServerRequest(handlers.onServerRequest);

    // Single child-exit observer: classifies the exit per TASK-AIX05-101
    // §Test Cases #2/#3/#4 and fires the AcpClient onClose path exactly
    // once (preserved from the prior fix). Replaces the two previous
    // per-listener "exit" handlers with one canonical routing.
    spawnLike.on("exit", (code) => {
      this.handleChildExit(code);
    });

    // Bind the client to the handle so handleChildExit() can actually
    // dispose it. Previously this.acp was never assigned, so the
    // post-exit dispose was a no-op and the panel's onClose hook never
    // fired on real exit.
    this.acp = acp;

    try {
      const initResult = (await Promise.race([
        acp.request("initialize", {
          protocolVersion: EXPECTED_OMP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "vsdb-extension", version: "1.5.1" },
        }),
        startError,
      ])) as { protocolVersion?: unknown; agentInfo?: { version?: string } };

      // TASK-AIX05-101 §Test Cases #6: validate the protocol version BEFORE
      // sending `initialized` or `session/new`. An incompatible reply
      // terminates the child, transitions to fallback-builtin, and rejects
      // with the pinned error message. The child is left alive just long
      // enough for the SIGTERM to land (it never reads another NDJSON
      // frame after we close stdin); onClose listeners are NOT fired here
      // because the spawned child never finished handshaking.
      if (initResult.protocolVersion !== EXPECTED_OMP_PROTOCOL_VERSION) {
        const received =
          initResult.protocolVersion === undefined
            ? "undefined"
            : JSON.stringify(initResult.protocolVersion);
        const mismatch = new Error(
          `OMP ACP protocol version mismatch: expected ${EXPECTED_OMP_PROTOCOL_VERSION}, received ${received}`,
        );
        // Tear down before the throw so the terminal state lands and the
        // child is reaped.
        this.handleProtocolMismatch();
        throw attachStderrTail(mismatch, stderrTail);
      }

      // TASK-006 (B4a): the handshake is initialize → initialized →
      // session/new. `initialized` is a notification (no `id`, no reply
      // expected) — sending it was previously skipped entirely.
      acp.notify("initialized", {});

      const sessionResult = (await Promise.race([
        acp.request("session/new", {
          cwd: this.opts.cwd,
          mcpServers: this.opts.mcpServers ?? [],
        }),
        startError,
      ])) as { sessionId?: unknown };

      const sessionId = typeof sessionResult.sessionId === "string"
        ? sessionResult.sessionId
        : "";

      // Surface omp version through execFn (best-effort; ignored on failure).
      let version = "unknown";
      try {
        const raw = await this.execFn(`${ompPath} --version`);
        const match = raw.match(/omp\/(\S+)/);
        if (match !== null && match[1] !== undefined) {
          version = match[1];
        }
      } catch {
        /* keep "unknown" */
      }
      // Prefer agent-reported version if available.
      const agentVersion = initResult.agentInfo?.version;
      if (typeof agentVersion === "string" && agentVersion.length > 0) {
        version = agentVersion;
      }

      // Mark the runtime ready BEFORE flipping state so the ready
      // observer sees the metadata. From this point on, child exits are
      // "crashed" (or "stopped" if cancel was requested).
      this.readyReached = true;
      this.setState("ready");

      const handle: AcpProcessHandle = {
        acp,
        sessionId,
        version,
        state: () => this.engineState,
        cancel: () => this.requestCancel(),
        dispose: () => this.dispose(),
        // Finding 4: `stderrTail` keeps accumulating (bounded) via the
        // "data" listener registered above for the life of the process —
        // read it live rather than only at handshake-failure time.
        getStderrTail: () => stderrTail,
      };
      return handle;
    } catch (err) {
      // The AcpClient is still bound to the transport. Disposing it
      // closes the transport (which signals any pending request
      // rejections). The child is left alone here — handleChildExit()
      // has already classified whatever exit caused the rejection, or
      // (for spawn errors) there is no exit to classify.
      this.disposeClient();
      // If handleChildExit() already moved the state through to a
      // terminal (crashed/fallback-builtin/stopped), do NOT clobber it.
      // Otherwise (e.g. spawn error which fires no exit), land at
      // fallback-builtin so the panel's restart owner sees the same
      // terminal it sees for every other unreachable-child path.
      if (!this.disposed) {
        this.setState("fallback-builtin");
        this.markDisposed();
      }
      throw attachStderrTail(err, stderrTail);
    }
  }

  /**
   * TASK-AIX05-101: state transition side-effect. Calls the observer when
   * the new value differs from the current one; updates the read view
   * regardless so the latest write wins.
   */
  private setState(next: OmpEngineState): void {
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
   * TASK-AIX05-101: classify a child-exit event and route it through the
   * state machine. Single-shot (subsequent exits are no-ops). Honours the
   * §Test Cases rules:
   *   - exit during starting → crashed → fallback-builtin
   *   - exit during ready (no cancel requested) → crashed
   *   - exit during cancelling OR after cancel requested on ready → stopped
   *   - exit during fallback-builtin (already terminal) → no new state
   */
  private handleChildExit(code: number | null): void {
    if (this.childExited) return;
    this.childExited = true;
    if (this.escalateTimer !== null) {
      clearTimeout(this.escalateTimer);
      this.escalateTimer = null;
    }
    // Post-handshake exits must fire the AcpClient onClose path exactly
    // once. Listeners (e.g. the panel's permission coordinator) get one
    // shot at writing final responses on the writable transport before
    // it closes. Pre-handshake exits leave the AcpClient alone — the
    // outer start() catch will dispose it. Disposing it here would race
    // the startError rejection with the AcpClient's "disposed" error
    // and the AcpClient always wins (its reject runs first because it's
    // already a pending promise). That swaps the test-visible error
    // from "exited before handshake" to "disposed" — wrong.
    if (this.readyReached && this.acp !== null) {
      try {
        this.acp.dispose();
      } catch {
        /* best-effort */
      }
      this.acp = null;
    }
    if (this.disposed) {
      // dispose() has already moved the state to "stopped". A late exit
      // must NOT clobber that — §Test Cases #7 requires no new state and
      // no new kill. But we still settle the dispose promise if one is
      // outstanding (caller awaits dispose() after exit).
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
      return;
    }
    if (this.cancelRequested) {
      // Cancel-initiated exit is "stopped" regardless of the current
      // state at the moment exit was observed.
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
      // Exit during starting (or during a protocol-mismatch teardown).
      // crashed is informational; fallback-builtin is the terminal that
      // callers (the panel's engine) consume.
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
    // Ready crash — append exactly one "crashed" event. The handle's
    // onClose path was already triggered by acp.dispose() above.
    this.setState("crashed");
    this.markDisposed();
    if (this.disposeResolve !== null) {
      const r = this.disposeResolve;
      this.disposeResolve = null;
      r();
    }
    // Suppress unused-arg lint while keeping the API symmetric with the
    // listener signature.
    void code;
  }

  /**
   * TASK-AIX05-101: terminal flag set after the state machine reaches any
   * terminal ("stopped", "crashed", "fallback-builtin"). Locks further
   * cancel()/dispose() work to a no-op for the routing layer while still
   * allowing the existing `disposed` guard on the client/child.
   */
  private markDisposed(): void {
    this.disposed = true;
  }

  /**
   * TASK-AIX05-101: protocol-mismatch teardown. Reaps the child, emits
   * "fallback-builtin", and locks further state transitions. Called
   * synchronously from start() before the throw.
   */
  private handleProtocolMismatch(): void {
    this.reapChild();
    this.setState("fallback-builtin");
    this.markDisposed();
  }

  /**
   * TASK-AIX05-101: send SIGTERM (or SIGKILL on escalation) to the live
   * child. Single-shot per signal — second calls are dropped silently so
   * the test fixture can observe exactly one kill per intent.
   */
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
   * TASK-AIX05-103 cancellable construction seam: public cancel() on the
   * AcpProcess instance itself so the panel can abort a same-generation
   * Stop during the handshake via `AcpPanelDeps.create()`'s returned
   * process — before `start()` resolves and without an `AcpProcessHandle`.
   * Forwards to the same idempotent `requestCancel()` path the handle's
   * `cancel()` uses.
   */
  cancel(): void {
    this.requestCancel();
  }

  /**
   * TASK-AIX05-101: idempotent current-turn cancel. On a ready handle,
   * transitions to "cancelling" and sends exactly one SIGTERM. On a
   * starting handle, sets cancelRequested so the eventual exit lands at
   * "stopped" without first emitting "crashed". Already-terminal handles
   * are a no-op.
   */
  private requestCancel(): void {
    if (this.disposed) return;
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    if (!this.readyReached) {
      // cancel() during starting aborts the handshake. Reap the child
      // so the spawn actually terminates; the exit will land at
      // "stopped" via handleChildExit's cancelRequested branch.
      this.reapChild();
      return;
    }
    this.setState("cancelling");
    this.reapChild();
  }

  /**
   * TASK-AIX05-101: bounded teardown. SIGTERM immediately, SIGKILL at
   * OMP_ACP_DISPOSE_TIMEOUT_MS, then resolve. A real exit at any earlier
   * point also resolves the promise (via handleChildExit → settleDispose).
   * Subsequent calls return the same settled promise.
   */
  private dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    if (this.childExited) {
      // Child is already gone — just lock the state machine and resolve.
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
      // If the child never observes the SIGKILL (e.g. a stuck child, or
      // a test fake that ignores signals), the dispose promise still
      // resolves here so the caller is not hung. §Test Cases #7 only
      // pins the escalation path; a hard deadlock is the worse failure.
      if (this.disposeResolve !== null) {
        const r = this.disposeResolve;
        this.disposeResolve = null;
        r();
      }
    }, OMP_ACP_DISPOSE_TIMEOUT_MS);
    // unref so a pending escalation never holds the process open.
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

  /** Resolver attached by dispose(); called from handleChildExit when exit lands. */
  private disposeResolve: (() => void) | null = null;

  /**
   * Legacy path: dispose the AcpClient + best-effort terminate the child.
   * Preserved for any caller that still invokes the old synchronous
   * `disposeClient()` flow. New code uses the public handle.dispose() /
   * handle.cancel() pair.
   */
  private disposeClient(): void {
    if (this.disposed) return;
    if (this.acp !== null) {
      try {
        this.acp.dispose();
      } catch {
        /* best-effort */
      }
      this.acp = null;
    }
    if (this.child !== null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
  }
}

// ---- helpers ----------------------------------------------------------------

/**
 * TASK-006 (B10): append the retained stderr tail (if any) to a startup
 * error's message and expose it as `.stderrTail` for callers/tests that want
 * it without string-parsing the message.
 */
function attachStderrTail(err: unknown, tail: string): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  if (tail.length > 0) {
    base.message = `${base.message}\n--- omp stderr (tail) ---\n${tail}`;
  }
  (base as Error & { stderrTail?: string }).stderrTail = tail;
  return base;
}

/**
 * Review Finding 1 (fix round 2): quote a single argv token so it survives
 * cmd.exe's `/d /s /c "<command> <args...>"` re-parse as one unit, even when
 * it contains a space or a cmd.exe metacharacter (`&`, `|`, `<`, `>`, etc).
 * Always wraps in quotes (unlike detect.ts's `quoteForShell`, which only
 * quotes on whitespace) because metacharacters — not just spaces — must be
 * neutralized here. See the call site for the full cmd.exe quoting analysis.
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

function createAcpLineTransport(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): AcpTransport {
  const listeners = new Set<(line: string) => void>();
  let buffer = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        for (const cb of listeners) {
          cb(line);
        }
      }
    }
  });
  let closed = false;
  return {
    write: (line: string) => {
      if (closed) return;
      try {
        stdin.write(line);
      } catch {
        /* EPIPE after child exit — drop silently */
      }
    },
    onLine: (cb: (line: string) => void) => {
      listeners.add(cb);
    },
    close: () => {
      if (closed) return;
      closed = true;
      listeners.clear();
      try {
        stdin.end();
      } catch {
        /* best-effort */
      }
    },
  };
}
