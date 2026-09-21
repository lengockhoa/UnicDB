// src/ai/commitGenOmpOneShot.ts
//
// Host-side helpers for the Generate Commit Message omp one-shot adapter.
//
// Root cause this module closes: `buildCommitGenOmpOneShot` drove
// `engine.send()` WITHOUT registering an ACP server-request handler. When omp
// issued `session/request_permission`, nothing answered it, and
// `session/prompt` is intentionally unbounded (`timeoutMs: 0`) — so the turn
// never settled and the SCM sparkle's progress spinner spun forever.
//
// Fix: (1) auto-answer every server request (DENY — the commit prompt embeds
// the whole repo/branch/file list and diff, so omp never needs a tool);
// (2) bound the whole turn so it always settles with a real error instead of
// hanging. Both are pure and unit-tested; `extension.ts` only wires them.
//
// No vscode import — this module stays unit-testable.
import type { AcpServerRequest } from "./omp/acp";

/** Hard ceiling for one commit-gen omp turn. Generous for slow models; the
 *  point is that the turn ALWAYS settles (done, error, or this timeout). */
export const COMMIT_GEN_OMP_TIMEOUT_MS = 120_000;

/**
 * Answer one ACP server request from the commit-gen one-shot. The flow runs
 * unattended (progress spinner, no permission UI), so any request left
 * unanswered would hang the turn forever.
 *
 * Policy: DENY. The commit prompt already embeds the full repository context,
 * so omp never needs a tool to produce the message; denying keeps an
 * unattended background flow from executing shell/file tools. Unknown server
 * requests get a JSON-RPC method-not-found so the server can move on.
 *
 * Every write is best-effort: the process may already be gone.
 */
export function answerCommitGenServerRequest(call: AcpServerRequest): void {
  if (call.method === "session/request_permission") {
    try {
      call.respond({ outcome: { outcome: "cancelled" } });
    } catch {
      /* process gone — nothing to answer */
    }
    return;
  }
  try {
    call.respondError(-32601, `unsupported server request: ${call.method}`);
  } catch {
    /* process gone */
  }
}

/** Event surface the one-shot driver fills in for `engine.send()`. */
export interface CommitGenOneShotEvents {
  onDelta(delta: string): void;
  onDone(): void;
  onError(message: string): void;
}

export interface CommitGenOneShotDriver {
  events: CommitGenOneShotEvents;
  /** Reject the turn from an external failure (e.g. `engine.send()` rejected). */
  fail(error: unknown): void;
  /** Settle the turn early on user cancel (SPEC FR-005). Rejects the promise
   *  with `commit-gen: cancelled` and runs `onSettle` (engine shutdown).
   *  No-op once the driver has already settled. */
  cancel(): void;
  /** Resolves with the buffered text, or rejects on error/timeout/cancel. */
  promise: Promise<string>;
}

/**
 * Drive one omp turn to EXACTLY ONE settled outcome — the guarantee the old
 * inline promise lacked:
 *   - `onDone`   → resolve with the buffered text
 *   - `onError`  → reject with the message
 *   - `fail`     → reject with the external error
 *   - neither within `timeoutMs` → reject with a timeout error
 *
 * `onSettle` runs once on the winning path (production: `engine.shutdown()`),
 * so every outcome tears down the process. `setTimer`/`clearTimer` are
 * injectable so the timeout path is testable with fake timers.
 */
export function driveCommitGenOneShot(params: {
  timeoutMs: number;
  onSettle: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): CommitGenOneShotDriver {
  const setTimer =
    params.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    params.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

  let buffer = "";
  let settled = false;
  let timer: unknown;
  let resolvePromise!: (value: string) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });

  const settle = (outcome: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimer(timer);
    params.onSettle();
    outcome();
  };

  timer = setTimer(() => {
    settle(() =>
      rejectPromise(
        new Error(
          `commit-gen: omp did not finish within ${params.timeoutMs}ms — the turn was waiting on an unanswered request or a stalled model`,
        ),
      ),
    );
  }, params.timeoutMs);

  return {
    events: {
      onDelta: (delta) => {
        if (typeof delta === "string") buffer += delta;
      },
      onDone: () => settle(() => resolvePromise(buffer)),
      onError: (message) => settle(() => rejectPromise(new Error(message))),
    },
    fail: (error) =>
      settle(() =>
        rejectPromise(error instanceof Error ? error : new Error(String(error))),
      ),
    cancel: () =>
      settle(() => rejectPromise(new Error("commit-gen: cancelled"))),
    promise,
  };
}

/**
 * Build the `OmpOneShot`-shaped turn handle the host returns from
 * `buildCommitGenOmpOneShot` (SPEC FR-005). Pure — the engine surface is
 * injected as two functions so the cancel path is unit-testable without an
 * ACP process.
 *
 * `generate()` spawns a fresh driver per call (the settled-outcome contract
 * is unchanged); `cancel()` delegates to the LIVE driver and is a no-op
 * before the first `generate()` or after the turn settled.
 */
export function createCommitGenOmpTurn(engine: {
  send(prompt: string, events: CommitGenOneShotEvents): Promise<unknown>;
  shutdown(): Promise<unknown> | void;
}): { generate(prompt: string): Promise<string>; cancel(): void } {
  let driver: CommitGenOneShotDriver | null = null;
  return {
    async generate(prompt: string): Promise<string> {
      // One settled outcome guaranteed: done → text, error → reject, cancel →
      // reject, or the bounded timeout → reject. Never an indefinite pending
      // promise.
      const d = driveCommitGenOneShot({
        timeoutMs: COMMIT_GEN_OMP_TIMEOUT_MS,
        onSettle: () => {
          void engine.shutdown();
        },
      });
      driver = d;
      void engine.send(prompt, d.events).catch((e: unknown) => d.fail(e));
      return await d.promise;
    },
    cancel(): void {
      driver?.cancel();
    },
  };
}
