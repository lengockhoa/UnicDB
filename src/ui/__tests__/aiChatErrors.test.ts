// src/ui/__tests__/aiChatErrors.test.ts — TASK-CHATV2-016
//
// Covers the task §Test Cases table:
//   1 unit      error category matrix — exact copy/actions/id per class
//   2 security  raw provider error never reaches frame/DOM/copy-details
//   3 regression failed Stop — stays working/stoppable, no false Stopped
//   8 race      diagnostic ids are deterministic (no clock/random)

import { describe, expect, it } from "vitest";

import { reasonForUnavailable } from "../../ai/capabilities";
import {
  AI_CHAT_ERROR_CATEGORIES,
  DATABASE_CHANGED_COPY,
  GENERIC_ERROR_COPY,
  STOP_FAILURE_COPY,
  containsForbiddenErrorDetail,
  diagnosticIdForError,
  errorActionAllowed,
  errorDiagnosticIds,
  errorMatrixEntry,
  mapHostChatError,
  resolveStopFailure,
  safeErrorDetail,
  terminalAfterStopFailure,
  type AiChatErrorCategory,
} from "../aiChatErrors";

// ---------------------------------------------------------------------------
// 1 — category matrix
// ---------------------------------------------------------------------------

describe("aiChatErrors — category matrix", () => {
  it("covers every required failure class", () => {
    const required: AiChatErrorCategory[] = [
      "engine_unavailable",
      "engine_not_installed",
      "auth_config",
      "connection_timeout",
      "connection_disconnect",
      "provider_crash",
      "tool_denied",
      "tool_failed",
      "context_changed",
      "context_missing",
      "attachment_rejected",
      "export_storage_failure",
      "stop_failure",
    ];
    for (const category of required) {
      expect(AI_CHAT_ERROR_CATEGORIES).toContain(category);
    }
  });

  it("reuses the capability copy verbatim for 'not installed'", () => {
    expect(errorMatrixEntry("engine_not_installed").safeMessage).toBe(reasonForUnavailable("not-installed"));
  });

  it("engine not installed is not retryable and offers Change engine", () => {
    const e = errorMatrixEntry("engine_not_installed");
    expect(e.retryable).toBe(false);
    expect(e.actions).toContain("change_engine");
    expect(e.actions).not.toContain("retry");
  });

  it("engine unavailable is retryable and offers Retry + Change engine", () => {
    const e = errorMatrixEntry("engine_unavailable");
    expect(e.retryable).toBe(true);
    expect(e.actions).toEqual(expect.arrayContaining(["retry", "change_engine", "copy_details"]));
  });

  it("auth/config is not retryable (retrying the same credentials cannot help)", () => {
    const e = errorMatrixEntry("auth_config");
    expect(e.retryable).toBe(false);
    expect(e.actions).not.toContain("retry");
  });

  it("connection timeout and disconnect are retryable", () => {
    expect(errorMatrixEntry("connection_timeout").retryable).toBe(true);
    expect(errorMatrixEntry("connection_disconnect").retryable).toBe(true);
  });

  it("provider crash is retryable and offers Change engine", () => {
    const e = errorMatrixEntry("provider_crash");
    expect(e.retryable).toBe(true);
    expect(e.actions).toContain("change_engine");
  });

  it("a denied tool is NOT a crash and is not mislabeled as one", () => {
    const e = errorMatrixEntry("tool_denied");
    expect(e.userDenial).toBe(true);
    expect(e.retryable).toBe(false);
    expect(e.safeMessage.toLowerCase()).not.toContain("crash");
    expect(e.safeMessage.toLowerCase()).not.toContain("stopped unexpectedly");
  });

  it("tool failure is distinct from denial and is retryable", () => {
    const e = errorMatrixEntry("tool_failed");
    expect(e.userDenial).toBeUndefined();
    expect(e.retryable).toBe(true);
  });

  it("context change carries the exact locked database copy", () => {
    expect(errorMatrixEntry("context_changed").safeMessage).toBe(DATABASE_CHANGED_COPY);
    expect(DATABASE_CHANGED_COPY).toBe("Database connection changed. Start a new request when it is ready.");
  });

  it("context missing is not retryable", () => {
    expect(errorMatrixEntry("context_missing").retryable).toBe(false);
  });

  it("attachment rejection and export/storage failure are display-only", () => {
    for (const category of ["attachment_rejected", "export_storage_failure"] as const) {
      const e = errorMatrixEntry(category);
      expect(e.retryable).toBe(false);
      expect(e.actions).toEqual(["copy_details"]);
    }
  });

  it("stop failure carries the exact locked copy and is non-terminal", () => {
    const e = errorMatrixEntry("stop_failure");
    expect(e.safeMessage).toBe(STOP_FAILURE_COPY);
    expect(STOP_FAILURE_COPY).toBe("Could not stop yet. The engine may still be working.");
    expect(e.nonTerminal).toBe(true);
    expect(e.actions).not.toContain("retry");
  });

  it("an unknown category maps to the generic safe copy and an id", () => {
    const frame = mapHostChatError({ category: "totally-hostile-value" });
    expect(frame.category).toBe("unknown");
    expect(frame.safeMessage).toBe(GENERIC_ERROR_COPY);
    expect(frame.diagnosticId).toMatch(/^diag-[0-9a-f]{8}$/);
  });

  it("every category yields a deterministic diag id and never an empty message", () => {
    const ids = errorDiagnosticIds();
    for (const category of AI_CHAT_ERROR_CATEGORIES) {
      expect(ids[category]).toMatch(/^diag-[0-9a-f]{8}$/);
      expect(errorMatrixEntry(category).safeMessage.length).toBeGreaterThan(0);
    }
    // Determinism: same inputs → same id (no clock/random — CTX-04).
    expect(diagnosticIdForError("provider_crash", errorMatrixEntry("provider_crash").safeMessage)).toBe(
      ids.provider_crash,
    );
  });

  it("action gating reflects the frame's allowed set", () => {
    const notInstalled = mapHostChatError({ category: "engine_not_installed" });
    expect(errorActionAllowed(notInstalled, "change_engine")).toBe(true);
    expect(errorActionAllowed(notInstalled, "retry")).toBe(false);
    const timeout = mapHostChatError({ category: "connection_timeout" });
    expect(errorActionAllowed(timeout, "retry")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 — privacy
// ---------------------------------------------------------------------------

describe("aiChatErrors — privacy", () => {
  const RAW = [
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    '{"error":{"message":"invalid_api_key","type":"authentication_error"}}',
    "Authorization: Bearer sk-live-abcdef0123456789",
    "psql --host=db.internal --password=hunter2",
    "at Object.<anonymous> (/app/node_modules/x/index.js:12:7)",
  ];

  it("raw provider detail never survives into the frame", () => {
    for (const raw of RAW) {
      const frame = mapHostChatError({ category: "connection_disconnect", detail: raw });
      const serialized = JSON.stringify(frame);
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("sk-live");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("node_modules");
      expect(serialized).not.toContain("invalid_api_key");
      expect(serialized).not.toContain("Bearer");
      expect(frame.safeDetail).toBeUndefined();
    }
  });

  it("safeErrorDetail drops anything with markup, quotes, braces or secrets", () => {
    expect(safeErrorDetail("<script>alert(1)</script>")).toBeUndefined();
    expect(safeErrorDetail('{"a":1}')).toBeUndefined();
    expect(safeErrorDetail("token=abc")).toBeUndefined();
    expect(safeErrorDetail("token")).toBeUndefined();
    expect(safeErrorDetail("engine out of date")).toBe("engine out of date");
    expect(safeErrorDetail("")).toBeUndefined();
    expect(safeErrorDetail(42)).toBeUndefined();
    expect(safeErrorDetail("x".repeat(121))).toBeUndefined();
  });

  it("containsForbiddenErrorDetail detects leaked detail in any payload", () => {
    expect(containsForbiddenErrorDetail({ a: "Bearer sk-123" })).toBe(true);
    expect(containsForbiddenErrorDetail({ safeMessage: GENERIC_ERROR_COPY })).toBe(false);
  });

  it("an acceptable short detail survives (collapsed safe detail)", () => {
    const frame = mapHostChatError({ category: "connection_timeout", detail: "retry 2 of 3" });
    expect(frame.safeDetail).toBe("retry 2 of 3");
  });
});

// ---------------------------------------------------------------------------
// 3 — stop failure regression
// ---------------------------------------------------------------------------

describe("aiChatErrors — failed Stop never fakes a stopped turn", () => {
  it("keeps the turn active and stoppable", () => {
    const r = resolveStopFailure("streaming");
    expect(r.stopped).toBe(false);
    expect(r.terminal).toBe(false);
    expect(r.stopActive).toBe(true);
    expect(r.phase).toBe("streaming");
    expect(r.message).toBe(STOP_FAILURE_COPY);
  });

  it("a stop that fails from 'stopping' falls back to a live phase, not terminal", () => {
    const r = resolveStopFailure("stopping");
    expect(r.phase).toBe("streaming");
    expect(r.terminal).toBe(false);
  });

  it("an unrecognized phase still yields a live turn", () => {
    const r = resolveStopFailure("bogus-phase");
    expect(r.terminal).toBe(false);
    expect(r.stopActive).toBe(true);
  });

  it("a later terminal host event wins", () => {
    expect(terminalAfterStopFailure("completed")).toBe("completed");
    expect(terminalAfterStopFailure("stopped")).toBe("stopped");
    expect(terminalAfterStopFailure("failed")).toBe("failed");
  });
});
