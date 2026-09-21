// webview/aiChat/__tests__/activity.test.ts — TASK-CHATV2-007, pruned CHATUX2-004
//
// The DOM timeline renderer was deleted in CHATUX2-004 (the keyed transcript
// is the single renderer for `shell.transcript`). What remains here is the
// pure-helper contract: wire→visual state mapping, labels, duration
// formatting, phase copy and the truthful engine-state derivation.
// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  deriveEngineState,
  engineStateLabel,
  formatDuration,
  isActivePhase,
  mapToolState,
  phaseCopyLabel,
  toolStateLabel,
  UNKNOWN_STATUS_LABEL,
  type ActivityToolState,
} from "../activity";

describe("activity pure helpers — mapToolState", () => {
  it("maps every wire status onto the closed visual set", () => {
    expect(mapToolState("queued")).toBe("queued");
    expect(mapToolState("running")).toBe("running");
    expect(mapToolState("ok")).toBe("succeeded");
    expect(mapToolState("succeeded")).toBe("succeeded");
    expect(mapToolState("denied")).toBe("denied");
    expect(mapToolState("failed")).toBe("failed");
    expect(mapToolState("cancelled")).toBe("cancelled");
    expect(mapToolState("canceled")).toBe("cancelled");
  });

  it("maps unrecognised and non-string wire values to unknown", () => {
    expect(mapToolState("bogus")).toBe("unknown");
    expect(mapToolState("")).toBe("unknown");
    expect(mapToolState(undefined)).toBe("unknown");
    expect(mapToolState(null)).toBe("unknown");
    expect(mapToolState(42)).toBe("unknown");
    expect(mapToolState({ status: "ok" })).toBe("unknown");
  });
});

describe("activity pure helpers — toolStateLabel", () => {
  it("labels every closed state; unknown falls back to the neutral copy", () => {
    const expected: Record<ActivityToolState, string> = {
      queued: "Queued",
      running: "Running",
      succeeded: "Done",
      denied: "Denied",
      failed: "Failed",
      cancelled: "Cancelled",
      unknown: UNKNOWN_STATUS_LABEL,
    };
    for (const state of Object.keys(expected) as ActivityToolState[]) {
      expect(toolStateLabel(state)).toBe(expected[state]);
    }
  });
});

describe("activity pure helpers — formatDuration", () => {
  it("formats milliseconds as N.Ns", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(42)).toBe("0.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
  });

  it("returns null for absent, non-finite or negative input", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe("activity pure helpers — isActivePhase", () => {
  it("is true exactly for the live-work phases", () => {
    for (const phase of [
      "validating",
      "connecting",
      "waiting_for_first_event",
      "streaming",
      "awaiting_permission",
      "stopping",
    ] as const) {
      expect(isActivePhase(phase)).toBe(true);
    }
    for (const phase of ["idle", "completed", "failed"] as const) {
      expect(isActivePhase(phase)).toBe(false);
    }
  });
});

describe("activity pure helpers — deriveEngineState + engineStateLabel", () => {
  it("derives starting before any capability snapshot", () => {
    expect(deriveEngineState(null, "idle", false)).toBe("starting");
    expect(deriveEngineState("starting", "streaming", true)).toBe("starting");
  });

  it("derives unavailable for unavailable/fallback engines", () => {
    expect(deriveEngineState("unavailable", "streaming", true)).toBe("unavailable");
    expect(deriveEngineState("fallback", "idle", false)).toBe("unavailable");
  });

  it("derives working only while a turn is open in a live phase — never hard-coded streaming", () => {
    expect(deriveEngineState("ready", "streaming", true)).toBe("working");
    expect(deriveEngineState("ready", "awaiting_permission", true)).toBe("working");
    // A closed turn or an idle phase reads Ready even mid-session.
    expect(deriveEngineState("ready", "streaming", false)).toBe("ready");
    expect(deriveEngineState("ready", "idle", true)).toBe("ready");
    expect(deriveEngineState("ready", "completed", false)).toBe("ready");
  });

  it("labels each engine state", () => {
    expect(engineStateLabel("ready")).toBe("Ready");
    expect(engineStateLabel("starting")).toBe("Starting");
    expect(engineStateLabel("working")).toBe("Working");
    expect(engineStateLabel("unavailable")).toBe("Unavailable");
  });
});

describe("activity pure helpers — phaseCopyLabel", () => {
  it("produces the exact phase copy (PLAN §6)", () => {
    expect(phaseCopyLabel("validating")).toBe("Preparing your request…");
    expect(phaseCopyLabel("connecting", { displayName: "Codex" })).toBe("Connecting to Codex…");
    expect(phaseCopyLabel("waiting_for_first_event", { elapsedSeconds: 3.7 })).toBe("Working… 3s");
    expect(phaseCopyLabel("streaming")).toBe("Responding…");
    expect(phaseCopyLabel("awaiting_permission")).toBe("Waiting for your permission");
    expect(phaseCopyLabel("stopping")).toBe("Stopping…");
    expect(phaseCopyLabel("completed")).toBe("Completed");
  });

  it("yields empty copy for idle/failed (the error surface owns failure)", () => {
    expect(phaseCopyLabel("idle")).toBe("");
    expect(phaseCopyLabel("failed")).toBe("");
  });

  it("sanitises the engine display name in connecting copy", () => {
    expect(phaseCopyLabel("connecting", { displayName: "  a\nb  " })).toBe("Connecting to a b…");
    expect(phaseCopyLabel("connecting", { displayName: 42 })).toBe("Connecting to engine…");
    expect(phaseCopyLabel("connecting")).toBe("Connecting to engine…");
  });
});
