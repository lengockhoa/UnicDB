// webview/aiChat/__tests__/statusTimers.test.ts — TASK-CHATV2-007
//
// Contract tests for the injected-clock stall/elapsed timer service. Time is
// advanced by hand through a FakeClock, so every threshold is deterministic —
// no wall-clock sleeps.
//
// Covers task §Test Cases:
//   4 timer   exact 12s/30s warnings; a visible event resets the window
//   plus      <=1 elapsed update/second, host-only retry copy, engine naming,
//             and hostile engine-label sanitisation.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ELAPSED_TICK_MS,
  STALL_WAITING_MS,
  STALL_WORKING_MESSAGE,
  STALL_WORKING_MS,
  createStatusTimers,
  formatRetryCopy,
  stallWaitingMessage,
  type StatusClock,
  type StatusTimerUpdate,
  type TimerHandle,
} from "../statusTimers";

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

class FakeClock implements StatusClock {
  private current = 0;
  private next = 1;
  private readonly timers = new Map<number, { handler: () => void; ms: number; due: number }>();

  now(): number {
    return this.current;
  }

  setInterval(handler: () => void, ms: number): TimerHandle {
    const id = this.next++;
    this.timers.set(id, { handler, ms, due: this.current + ms });
    return id as unknown as TimerHandle;
  }

  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  /** Advance time and fire every interval whose due time is reached. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let earliest = Number.POSITIVE_INFINITY;
      let dueId: number | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.due <= target && timer.due < earliest) {
          earliest = timer.due;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.current = timer.due;
      timer.due += timer.ms;
      timer.handler();
    }
    this.current = target;
  }

  /** Number of live intervals (proves start/stop cleanup). */
  liveTimers(): number {
    return this.timers.size;
  }
}

let clock: FakeClock;
let updates: StatusTimerUpdate[];

function make() {
  return createStatusTimers(clock, (u) => updates.push(u));
}

const elapsed = () => updates.filter((u) => u.kind === "elapsed");
const stalls = () => updates.filter((u) => u.kind === "stall");

beforeEach(() => {
  clock = new FakeClock();
  updates = [];
});

afterEach(() => {
  clock = new FakeClock();
  updates = [];
});

// ---------------------------------------------------------------------------

describe("createStatusTimers — elapsed cadence", () => {
  it("emits at most one elapsed update per second", () => {
    const timers = make();
    timers.start();
    clock.advance(3 * ELAPSED_TICK_MS);

    const seconds = elapsed().map((u) => (u.kind === "elapsed" ? u.seconds : -1));
    expect(seconds).toEqual([1, 2, 3]);
  });

  it("does not repeat an elapsed update when the clock does not advance", () => {
    const timers = make();
    timers.start();
    clock.advance(ELAPSED_TICK_MS);
    // Force an extra tick at the same wall time (scheduler lag / frozen clock).
    clock.advance(0);
    expect(elapsed()).toHaveLength(1);
  });

  it("elapsedMs tracks the injected clock while running", () => {
    const timers = make();
    timers.start();
    clock.advance(2500);
    expect(timers.elapsedMs()).toBe(2500);
    timers.stop();
    expect(timers.elapsedMs()).toBe(0);
  });
});

describe("createStatusTimers — stall thresholds", () => {
  it("fires the 12s working warning exactly once at the threshold", () => {
    const timers = make();
    timers.start();
    clock.advance(STALL_WORKING_MS);

    const working = stalls().filter((u) => u.kind === "stall" && u.level === "working");
    expect(working).toHaveLength(1);
    expect(working[0]).toMatchObject({ message: STALL_WORKING_MESSAGE, elapsedMs: STALL_WORKING_MS });
    // Not yet the 30s warning.
    expect(stalls().some((u) => u.kind === "stall" && u.level === "waiting")).toBe(false);
  });

  it("fires the 30s waiting warning with the host engine name", () => {
    const timers = make();
    timers.setEngine("Claude Code");
    timers.start();
    clock.advance(STALL_WAITING_MS);

    const waiting = stalls().filter((u) => u.kind === "stall" && u.level === "waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      message: "Still waiting for Claude Code. Check engine status or stop.",
    });
    expect(stalls().some((u) => u.kind === "stall" && u.level === "working")).toBe(true);
  });

  it("does not warn before 12s", () => {
    const timers = make();
    timers.start();
    clock.advance(STALL_WORKING_MS - 1);
    expect(stalls()).toHaveLength(0);
  });

  it("a new visible event resets the stall window and re-arms both warnings", () => {
    const timers = make();
    timers.start();
    clock.advance(STALL_WORKING_MS);
    expect(stalls().filter((u) => u.level === "working")).toHaveLength(1);

    timers.noteVisibleEvent();
    clock.advance(STALL_WORKING_MS);
    // Re-armed: a second working warning fires after the reset.
    expect(stalls().filter((u) => u.level === "working")).toHaveLength(2);
  });

  it("re-arms the 30s warning after a visible event", () => {
    const timers = make();
    timers.start();
    clock.advance(STALL_WAITING_MS);
    expect(stalls().filter((u) => u.level === "waiting")).toHaveLength(1);

    timers.noteVisibleEvent();
    clock.advance(STALL_WAITING_MS - 1);
    expect(stalls().filter((u) => u.level === "waiting")).toHaveLength(1);
    clock.advance(1);
    expect(stalls().filter((u) => u.level === "waiting")).toHaveLength(2);
  });
});

describe("createStatusTimers — retry frames", () => {
  it("reports host retry copy and re-arms the stall window", () => {
    const timers = make();
    timers.start();
    clock.advance(STALL_WORKING_MS);
    const before = stalls().length;

    timers.retry(1, 2);
    const retries = updates.filter((u) => u.kind === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ message: "Retrying connection (1 of 2)…", attempt: 1, total: 2 });

    // Retry is a visible event: the stall warnings reset.
    clock.advance(STALL_WORKING_MS - 1);
    expect(stalls().length).toBe(before);
    clock.advance(1);
    expect(stalls().length).toBe(before + 1);
  });

  it("never fabricates a retry from an invalid frame", () => {
    const timers = make();
    timers.start();
    timers.retry(3, 2);
    timers.retry(0, 2);
    timers.retry(1, 0);
    timers.retry("1", 2);
    timers.retry(Number.NaN, 2);
    expect(updates.filter((u) => u.kind === "retry")).toHaveLength(0);
  });

  it("formatRetryCopy validates the attempts/total pair", () => {
    expect(formatRetryCopy(1, 2)).toBe("Retrying connection (1 of 2)…");
    expect(formatRetryCopy(2, 2)).toBe("Retrying connection (2 of 2)…");
    expect(formatRetryCopy(0, 2)).toBeNull();
    expect(formatRetryCopy(3, 2)).toBeNull();
    expect(formatRetryCopy(1.5, 2)).toBeNull();
    expect(formatRetryCopy(undefined, 2)).toBeNull();
  });
});

describe("createStatusTimers — lifecycle", () => {
  it("start is idempotent and one interval is live", () => {
    const timers = make();
    timers.start();
    timers.start();
    expect(clock.liveTimers()).toBe(1);
    expect(timers.isRunning()).toBe(true);
  });

  it("stop clears the interval and silence follows", () => {
    const timers = make();
    timers.start();
    timers.stop();
    expect(clock.liveTimers()).toBe(0);
    clock.advance(4 * ELAPSED_TICK_MS);
    expect(updates).toHaveLength(0);
    expect(timers.isRunning()).toBe(false);
  });

  it("dispose is terminal", () => {
    const timers = make();
    timers.start();
    timers.dispose();
    timers.start();
    clock.advance(STALL_WAITING_MS);
    expect(updates).toHaveLength(0);
    expect(timers.isRunning()).toBe(false);
  });

  it("ignores visible events when not running", () => {
    const timers = make();
    timers.noteVisibleEvent();
    expect(timers.elapsedMs()).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe("stallWaitingMessage — hostile engine labels", () => {
  it("sanitises control/format characters and collapses whitespace", () => {
    expect(stallWaitingMessage("Claude‮Code")).toBe(
      "Still waiting for Claude Code. Check engine status or stop.",
    );
    expect(stallWaitingMessage("  A\t\tB  ")).toBe("Still waiting for A B. Check engine status or stop.");
  });

  it("falls back to a generic label and caps length", () => {
    expect(stallWaitingMessage("")).toBe("Still waiting for engine. Check engine status or stop.");
    expect(stallWaitingMessage(undefined as unknown as string)).toBe(
      "Still waiting for engine. Check engine status or stop.",
    );
    const long = stallWaitingMessage("x".repeat(200));
    expect(long).toContain("Still waiting for ");
    expect(long.length).toBeLessThan(100);
  });
});
