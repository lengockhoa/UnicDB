// src/ai/__tests__/commitGenOmpOneShot.test.ts
// Regression tests for the Generate Commit Message omp one-shot hang.
//
// Root cause: the one-shot never answered `session/request_permission`, so the
// unbounded `session/prompt` never settled and the SCM progress spinner hung.
// These tests pin (1) the auto-answer policy and (2) the single-settle bound.
import { describe, it, expect, vi } from "vitest";
import {
  answerCommitGenServerRequest,
  driveCommitGenOneShot,
  createCommitGenOmpTurn,
  COMMIT_GEN_OMP_TIMEOUT_MS,
  type CommitGenOneShotEvents,
} from "../commitGenOmpOneShot";
import type { AcpServerRequest } from "../omp/acp";

// ---- auto-answer policy -----------------------------------------------------

describe("answerCommitGenServerRequest — permission auto-answer", () => {
  it("answers session/request_permission with a cancelled outcome (deny)", () => {
    const respond = vi.fn();
    const respondError = vi.fn();
    const call: AcpServerRequest = {
      id: 0,
      method: "session/request_permission",
      params: {},
      respond,
      respondError,
    };

    answerCommitGenServerRequest(call);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ outcome: { outcome: "cancelled" } });
    expect(respondError).not.toHaveBeenCalled();
  });

  it("replies method-not-found to any other server request", () => {
    const respond = vi.fn();
    const respondError = vi.fn();
    const call: AcpServerRequest = {
      id: 7,
      method: "fs/read_text_file",
      params: {},
      respond,
      respondError,
    };

    answerCommitGenServerRequest(call);

    expect(respond).not.toHaveBeenCalled();
    expect(respondError).toHaveBeenCalledTimes(1);
    expect(respondError.mock.calls[0][0]).toBe(-32601);
  });

  it("never throws when the process is already gone", () => {
    const call: AcpServerRequest = {
      id: 1,
      method: "session/request_permission",
      params: {},
      respond: () => {
        throw new Error("EPIPE");
      },
      respondError: () => {
        throw new Error("EPIPE");
      },
    };

    expect(() => answerCommitGenServerRequest(call)).not.toThrow();
  });
});

// ---- single-settle driver ---------------------------------------------------

describe("driveCommitGenOneShot — one settled outcome", () => {
  it("resolves with the buffered text on onDone", async () => {
    const onSettle = vi.fn();
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle });
    d.events.onDelta("feat: ");
    d.events.onDelta("add thing");
    d.events.onDone();

    await expect(d.promise).resolves.toBe("feat: add thing");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("ignores non-string deltas (defends the [object Object] contract)", async () => {
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle: vi.fn() });
    (d.events.onDelta as (x: unknown) => void)({ text: "nope" });
    d.events.onDelta("ok");
    d.events.onDone();

    await expect(d.promise).resolves.toBe("ok");
  });

  it("rejects on onError", async () => {
    const onSettle = vi.fn();
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle });
    d.events.onError("omp crashed");

    await expect(d.promise).rejects.toThrow("omp crashed");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("rejects on an external engine.send() rejection (fail)", async () => {
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle: vi.fn() });
    d.fail(new Error("transport closed"));

    await expect(d.promise).rejects.toThrow("transport closed");
  });

  it("rejects and calls onSettle when the turn times out with no outcome", async () => {
    const onSettle = vi.fn();
    // Controllable timer: fire the timeout callback synchronously on demand.
    let fire: (() => void) | null = null;
    const d = driveCommitGenOneShot({
      timeoutMs: COMMIT_GEN_OMP_TIMEOUT_MS,
      onSettle,
      setTimer: (fn) => {
        fire = fn;
        return "handle";
      },
      clearTimer: vi.fn(),
    });

    expect(onSettle).not.toHaveBeenCalled();
    fire!();

    await expect(d.promise).rejects.toThrow(/did not finish within/);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("settles exactly once — a late onDone after onError is ignored", async () => {
    const onSettle = vi.fn();
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle });
    d.events.onError("boom");
    d.events.onDone();
    d.events.onDelta("late");

    await expect(d.promise).rejects.toThrow("boom");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("clears the timer on a normal settle so shutdown is not double-fired", async () => {
    const clearTimer = vi.fn();
    const d = driveCommitGenOneShot({
      timeoutMs: 1000,
      onSettle: vi.fn(),
      setTimer: () => "handle",
      clearTimer,
    });
    d.events.onDone();
    await d.promise;

    expect(clearTimer).toHaveBeenCalledWith("handle");
  });
});

// ---- user cancel (TASK-GITMSG-002 / SPEC FR-005) ----------------------------

describe("driveCommitGenOneShot — cancel()", () => {
  it("case 1: cancel mid-turn rejects 'commit-gen: cancelled' and runs onSettle exactly once", async () => {
    const onSettle = vi.fn();
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle });
    d.events.onDelta("feat: partial");

    d.cancel();

    await expect(d.promise).rejects.toThrow("commit-gen: cancelled");
    expect(onSettle).toHaveBeenCalledTimes(1);
    // A late outcome after cancel must not re-settle or resolve.
    d.events.onDone();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("case 2: cancel after onDone is a no-op — promise stays resolved, onSettle still once", async () => {
    const onSettle = vi.fn();
    const d = driveCommitGenOneShot({ timeoutMs: 1000, onSettle });
    d.events.onDelta("feat: done");
    d.events.onDone();

    d.cancel();

    await expect(d.promise).resolves.toBe("feat: done");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("case 3: cancel before any event rejects and clears the timer — no later timeout reject", async () => {
    const onSettle = vi.fn();
    const clearTimer = vi.fn();
    let fire: (() => void) | null = null;
    const d = driveCommitGenOneShot({
      timeoutMs: 1000,
      onSettle,
      setTimer: (fn) => {
        fire = fn;
        return "handle";
      },
      clearTimer,
    });

    d.cancel();

    await expect(d.promise).rejects.toThrow("commit-gen: cancelled");
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledWith("handle");
    // The timeout callback must be dead: firing it cannot re-settle.
    fire!();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe("createCommitGenOmpTurn — OmpOneShot.cancel reaches the live driver", () => {
  it("case 5: cancel() settles the in-flight generate() promise with 'commit-gen: cancelled'", async () => {
    const shutdown = vi.fn();
    let captured: CommitGenOneShotEvents | null = null;
    const send = vi.fn(
      (_prompt: string, events: CommitGenOneShotEvents) => {
        captured = events;
        return Promise.resolve();
      },
    );
    const turn = createCommitGenOmpTurn({ send, shutdown });

    const pending = turn.generate("prompt");
    expect(send).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();

    turn.cancel();

    await expect(pending).rejects.toThrow("commit-gen: cancelled");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("cancel() before the first generate() is a no-op", () => {
    const shutdown = vi.fn();
    const send = vi.fn(async () => {});
    const turn = createCommitGenOmpTurn({ send, shutdown });

    expect(() => turn.cancel()).not.toThrow();
    expect(shutdown).not.toHaveBeenCalled();
  });
});
