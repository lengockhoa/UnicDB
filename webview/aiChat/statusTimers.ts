// webview/aiChat/statusTimers.ts — TASK-CHATV2-007
//
// Deterministic turn-stall / elapsed timer service for the V2 chat surface.
// It owns NO DOM and NO clock of its own: a {@link StatusClock} is injected so
// tests drive time by hand, and every observation leaves through the injected
// `dispatch` callback (the controller decides whether it becomes copy, a live
// announcement, or nothing at all).
//
// CONTRACT (PLAN §6)
// - Elapsed updates emit AT MOST once per second, even if the injected clock
//   jumps or does not advance between ticks.
// - At 12,000 ms since the last USER-VISIBLE event, one `Still working. You can
//   stop this turn.` warning fires — never declaring failure.
// - At 30,000 ms the `Still waiting for <engine>. Check engine status or stop.`
//   warning fires, naming the engine the host actually reported.
// - Any new visible event (`noteVisibleEvent`) resets the stall window and
//   re-arms both warnings.
// - A retry is ONLY ever reported from a host retry frame (`retry`). This
//   module never schedules, guesses, or fabricates one; invalid attempt/total
//   pairs are ignored rather than clamped.
//
// Pure DOM-free TypeScript: no `vscode`, no node builtins.

/** Handle returned by {@link StatusClock.setInterval}. */
export type TimerHandle = ReturnType<typeof setInterval>;

/** The injectable time source. Tests supply a manually-advanced fake. */
export interface StatusClock {
  now(): number;
  setInterval(handler: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** Wall-clock implementation used in production. */
export const systemStatusClock: StatusClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/** Elapsed repaint cadence (ms). One update per second at most. */
export const ELAPSED_TICK_MS = 1000;

/** Time without a user-visible event before the "still working" warning. */
export const STALL_WORKING_MS = 12_000;

/** Time without a user-visible event before the "still waiting" warning. */
export const STALL_WAITING_MS = 30_000;

/** Fixed copy for the 12 s stall warning. */
export const STALL_WORKING_MESSAGE = "Still working. You can stop this turn.";

/** Fallback engine label when the host has not reported a display name. */
const ENGINE_FALLBACK = "engine";

/** Longest engine label accepted into copy. */
const ENGINE_LABEL_MAX = 40;

/**
 * Build the 30 s stall warning for `engineLabel`. The label is host data, so it
 * is sanitised first (control characters stripped, whitespace collapsed,
 * length-capped); it is never interpolated raw.
 */
export function stallWaitingMessage(engineLabel: string): string {
  return `Still waiting for ${sanitizeEngineLabel(engineLabel)}. Check engine status or stop.`;
}

/**
 * Format a HOST retry frame's copy. Returns `null` when the frame does not
 * describe a real retry (non-integer, out of range, or attempt > total), so a
 * caller can never fabricate progress.
 */
export function formatRetryCopy(attempt: unknown, total: unknown): string | null {
  if (!Number.isInteger(attempt) || !Number.isInteger(total)) return null;
  const a = attempt as number;
  const t = total as number;
  if (t < 1 || a < 1 || a > t) return null;
  return `Retrying connection (${a} of ${t})…`;
}

/** Normalise a host engine label into safe, single-line copy. */
function sanitizeEngineLabel(value: unknown): string {
  if (typeof value !== "string") return ENGINE_FALLBACK;
  // Strip Unicode control + format characters (C0/C1, bidi overrides, etc.).
  const stripped = value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return ENGINE_FALLBACK;
  return collapsed.length > ENGINE_LABEL_MAX ? collapsed.slice(0, ENGINE_LABEL_MAX) : collapsed;
}

/** One observation produced by the timer service. */
export type StatusTimerUpdate =
  | { readonly kind: "elapsed"; readonly elapsedMs: number; readonly seconds: number }
  | {
      readonly kind: "stall";
      readonly level: "working" | "waiting";
      readonly message: string;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "retry";
      readonly attempt: number;
      readonly total: number;
      readonly message: string;
    };

/** Sink the timer service reports through. */
export type StatusTimerDispatch = (update: StatusTimerUpdate) => void;

/** Public timer-service handle. */
export interface StatusTimers {
  /** Begin tracking a turn. Idempotent while already running. */
  start(): void;
  /** A user-visible event occurred: reset the stall window and re-arm warnings. */
  noteVisibleEvent(): void;
  /** Record the host-reported engine display name for the 30 s copy. */
  setEngine(displayName: unknown): void;
  /** Report a HOST retry frame (never scheduled internally). */
  retry(attempt: unknown, total: unknown): void;
  /** Stop without reporting anything further. */
  stop(): void;
  /** Stop and permanently neutralise the service. */
  dispose(): void;
  /** True while a turn is tracked. */
  isRunning(): boolean;
  /** Ms since `start()` (0 when not running). */
  elapsedMs(): number;
}

/**
 * Create the timer service.
 *
 * @param clock Injectable time source + interval scheduler.
 * @param dispatch Observation sink.
 */
export function createStatusTimers(
  clock: StatusClock,
  dispatch: StatusTimerDispatch,
): StatusTimers {
  let handle: TimerHandle | null = null;
  let running = false;
  let disposed = false;
  let startedAt = 0;
  let lastVisibleAt = 0;
  let warnedWorking = false;
  let warnedWaiting = false;
  let lastEmittedSecond = -1;
  let engineLabel = ENGINE_FALLBACK;

  function tick(): void {
    if (disposed || !running) return;
    const now = clock.now();
    const elapsed = Math.max(0, now - startedAt);
    const second = Math.floor(elapsed / ELAPSED_TICK_MS);
    // At most one elapsed update per whole second, even for a frozen or
    // jumping clock.
    if (second !== lastEmittedSecond) {
      lastEmittedSecond = second;
      dispatch({ kind: "elapsed", elapsedMs: elapsed, seconds: second });
    }

    const stall = Math.max(0, now - lastVisibleAt);
    if (!warnedWorking && stall >= STALL_WORKING_MS) {
      warnedWorking = true;
      dispatch({ kind: "stall", level: "working", message: STALL_WORKING_MESSAGE, elapsedMs: stall });
    }
    if (!warnedWaiting && stall >= STALL_WAITING_MS) {
      warnedWaiting = true;
      warnedWorking = true;
      dispatch({ kind: "stall", level: "waiting", message: stallWaitingMessage(engineLabel), elapsedMs: stall });
    }
  }

  function clear(): void {
    if (handle !== null) {
      clock.clearInterval(handle);
      handle = null;
    }
  }

  return {
    start(): void {
      if (disposed || running) return;
      running = true;
      const now = clock.now();
      startedAt = now;
      lastVisibleAt = now;
      warnedWorking = false;
      warnedWaiting = false;
      lastEmittedSecond = -1;
      handle = clock.setInterval(tick, ELAPSED_TICK_MS);
    },

    noteVisibleEvent(): void {
      if (disposed || !running) return;
      lastVisibleAt = clock.now();
      warnedWorking = false;
      warnedWaiting = false;
    },

    setEngine(displayName: unknown): void {
      engineLabel = sanitizeEngineLabel(displayName);
    },

    retry(attempt: unknown, total: unknown): void {
      if (disposed) return;
      const message = formatRetryCopy(attempt, total);
      if (message === null) return; // never fabricate a retry
      const a = attempt as number;
      const t = total as number;
      // A host retry is a visible event: it re-arms the stall window.
      if (running) this.noteVisibleEvent();
      dispatch({ kind: "retry", attempt: a, total: t, message });
    },

    stop(): void {
      clear();
      running = false;
    },

    dispose(): void {
      clear();
      running = false;
      disposed = true;
    },

    isRunning(): boolean {
      return running && !disposed;
    },

    elapsedMs(): number {
      if (!running || disposed) return 0;
      return Math.max(0, clock.now() - startedAt);
    },
  };
}
