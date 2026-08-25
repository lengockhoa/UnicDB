// src/ui/__tests__/aiChatPanelMessages.test.ts — TASK-003 host message protocol.
//
// Pure type-shape and runtime-narrowing tests for the ACP permission message
// kinds added to src/ui/aiChatPanelMessages.ts.
//
// Security contract under test:
//   - Permission request carries a HOST-GENERATED opaque requestId.
//   - Each option carries an opaque optionId.
//   - Tool name and detail text are present (for UI rendering).
//   - NO apiKey field of any shape exists on either direction.
//   - Webview response carries only requestId plus a user-selected optionId OR
//     no optionId at all (deny/cancel path).
//
// These tests are pure (no DOM, no jsdom). They assert both compile-time shape
// (TypeScript-only narrowing) and runtime values for fixtures.

import { describe, it, expect } from "vitest";
import type {
  AiChatPanelHostMessage,
  AiChatPanelWebviewMessage,
  AiChatPanelPermissionRequest,
  AiChatPanelPermissionResponse,
} from "../aiChatPanelMessages";

// ---- Fixtures -------------------------------------------------------------

const hostileRequest: AiChatPanelPermissionRequest = {
  type: "permission_request",
  requestId: "req-host-7c4f",
  tool: {
    id: "tool_write_file",
    name: "<script>alert(1)</script>",
    detail: "writes path 'C:\\tmp\\evil.md' & <img onerror=x>",
  },
  options: [
    { optionId: "allow-once", label: "Allow once" },
    {
      optionId: "deny",
      label: "**Refuse** & <img src=x onerror=alert(1)>",
    },
  ],
};

const denyResponse: AiChatPanelPermissionResponse = {
  type: "permission_response",
  requestId: "req-host-7c4f",
};

const allowResponse: AiChatPanelPermissionResponse = {
  type: "permission_response",
  requestId: "req-host-7c4f",
  optionId: "allow-once",
};

// ---- #1 — host permission message exposes opaque IDs + no apiKey ----------
describe("AiChatPanelMessages — permission_request (host → webview)", () => {
  it("#1a exposes opaque requestId, tool name/detail, and option IDs (no apiKey)", () => {
    // Required fields exist with the expected opaque-string shape.
    expect(hostileRequest.type).toBe("permission_request");
    expect(typeof hostileRequest.requestId).toBe("string");
    expect(hostileRequest.requestId.length).toBeGreaterThan(0);
    // Tool detail is plain text — must accept markup-laden values verbatim.
    expect(hostileRequest.tool.name).toBe("<script>alert(1)</script>");
    expect(hostileRequest.tool.detail).toContain("C:\\tmp\\evil.md");
    // Option IDs are opaque strings the host picks; labels are plain text.
    expect(hostileRequest.options).toHaveLength(2);
    for (const opt of hostileRequest.options) {
      expect(typeof opt.optionId).toBe("string");
      expect(opt.optionId.length).toBeGreaterThan(0);
      expect(typeof opt.label).toBe("string");
    }
    // No apiKey-shaped field anywhere on the request shape.
    const asJson = JSON.stringify(hostileRequest);
    expect(asJson).not.toMatch(/api_?key/i);
    expect(asJson).not.toMatch(/sk-[a-z0-9]/i);
    expect(asJson).not.toMatch(/secret/i);
  });

  it("#1b permission_request is part of the host union (assignable)", () => {
    const hostMsgs: AiChatPanelHostMessage[] = [
      { type: "init", hasHistory: false },
      { type: "step", label: "list_tables" },
      { type: "delta", text: "hello" },
      { type: "assistant", text: "done", markdown: false },
      { type: "error", message: "x" },
      { type: "engine", name: "builtin" },
      { type: "done" },
      hostileRequest,
    ];
    const found = hostMsgs.find((m) => m.type === "permission_request");
    expect(found).toBeDefined();
    expect(found).toEqual(hostileRequest);
  });

  it("#1c runtime narrowing: AiChatPanelPermissionRequest is a request shape", () => {
    const m: unknown = hostileRequest;
    if (
      !!m &&
      typeof m === "object" &&
      (m as { type?: unknown }).type === "permission_request"
    ) {
      const req = m as AiChatPanelPermissionRequest;
      expect(req.requestId).toBe("req-host-7c4f");
      expect(req.tool.id).toBe("tool_write_file");
      return;
    }
    throw new Error("permission_request did not narrow");
  });
});

// ---- #2 — webview response message: Allow + Deny, opaque-only -------------
describe("AiChatPanelMessages — permission_response (webview → host)", () => {
  it("#2a Allow posts {type:'permission_response', requestId, optionId} (no apiKey)", () => {
    expect(allowResponse.type).toBe("permission_response");
    expect(allowResponse.requestId).toBe("req-host-7c4f");
    expect(allowResponse.optionId).toBe("allow-once");
    const asJson = JSON.stringify(allowResponse);
    expect(asJson).not.toMatch(/api_?key/i);
    expect(asJson).not.toMatch(/sk-[a-z0-9]/i);
  });

  it("#2b Deny posts {type:'permission_response', requestId} with NO optionId field", () => {
    expect(denyResponse.type).toBe("permission_response");
    expect(denyResponse.requestId).toBe("req-host-7c4f");
    // Deny means "no chosen option". The optionId key MUST be absent from the
    // wire — not undefined, not null, but not there at all.
    expect("optionId" in denyResponse).toBe(false);
    const asJson = JSON.stringify(denyResponse);
    expect(asJson).not.toMatch(/api_?key/i);
  });

  it("#2c permission_response is part of the webview union (assignable)", () => {
    const webMsgs: AiChatPanelWebviewMessage[] = [
      { type: "ready" },
      { type: "send", text: "hi" },
      { type: "stop" },
      { type: "clear" },
      denyResponse,
      allowResponse,
    ];
    const responses = webMsgs.filter(
      (m) => m.type === "permission_response",
    );
    expect(responses).toHaveLength(2);
    expect(
      (responses[0] as AiChatPanelPermissionResponse).optionId,
    ).toBeUndefined();
    expect(
      (responses[1] as AiChatPanelPermissionResponse).optionId,
    ).toBe("allow-once");
  });
});

// ---- #1d — backward compatibility: existing kinds still dispatch correctly
describe("AiChatPanelMessages — backward compatibility", () => {
  it("#1d existing host kinds still narrow and discriminated union is open", () => {
    const cases: AiChatPanelHostMessage[] = [
      { type: "init", hasHistory: true },
      { type: "step", label: "x" },
      { type: "delta", text: "y" },
      { type: "assistant", text: "z", markdown: true },
      { type: "error", message: "boom" },
      { type: "engine", name: "omp" },
      { type: "done" },
    ];
    const types = new Set(cases.map((c) => c.type));
    expect(types.has("init")).toBe(true);
    expect(types.has("step")).toBe(true);
    expect(types.has("delta")).toBe(true);
    expect(types.has("assistant")).toBe(true);
    expect(types.has("error")).toBe(true);
    expect(types.has("engine")).toBe(true);
    expect(types.has("done")).toBe(true);
    expect(types.has("permission_request")).toBe(false); // not in this slice
  });
});

// ---- TASK-003 §Interfaces — resume message protocol (frozen shapes) ----
import {
  HISTORY_RENDER_CAP,
} from "../aiChatPanelMessages";
import type {
  AiChatPanelResumeList,
  AiChatPanelResumePick,
  AiChatPanelResumeCancel,
  AiChatPanelResumeSessions,
  AiChatPanelHistory,
} from "../aiChatPanelMessages";

describe("AiChatPanelMessages — resume_list / resume_pick / resume_cancel (webview → host)", () => {
  it("#R1 resume_list carries no payload beyond the discriminator", () => {
    const msg: AiChatPanelResumeList = { type: "resume_list" };
    expect(msg.type).toBe("resume_list");
    expect(JSON.stringify(msg)).toBe(JSON.stringify({ type: "resume_list" }));
    // Must not include any credential-shaped field.
    expect(JSON.stringify(msg)).not.toMatch(/api_?key|sk-[a-z0-9]|secret/i);
  });

  it("#R2 resume_pick carries the opaque sessionId the webview was given", () => {
    const msg: AiChatPanelResumePick = {
      type: "resume_pick",
      sessionId: "sess-load-9c4f",
    };
    expect(msg.type).toBe("resume_pick");
    expect(msg.sessionId).toBe("sess-load-9c4f");
    // No credential leakage even on resume_pick (sessionId is opaque).
    const asJson = JSON.stringify(msg);
    expect(asJson).not.toMatch(/api_?key|sk-[a-z0-9]|secret/i);
  });

  it("#R3 resume_cancel closes the picker with no payload", () => {
    const msg: AiChatPanelResumeCancel = { type: "resume_cancel" };
    expect(msg.type).toBe("resume_cancel");
    expect(JSON.stringify(msg)).toBe(JSON.stringify({ type: "resume_cancel" }));
  });

  it("#R4 webview union members are assignable to AiChatPanelWebviewMessage", () => {
    const arr: AiChatPanelWebviewMessage[] = [
      { type: "ready" },
      { type: "send", text: "hi" },
      { type: "stop" },
      { type: "clear" },
      denyResponse,
      allowResponse,
      { type: "resume_list" },
      { type: "resume_pick", sessionId: "s1" },
      { type: "resume_cancel" },
    ];
    const types = new Set(arr.map((m) => m.type));
    expect(types.has("resume_list")).toBe(true);
    expect(types.has("resume_pick")).toBe(true);
    expect(types.has("resume_cancel")).toBe(true);
    // Existing kinds still present (no breaking change).
    expect(types.has("ready")).toBe(true);
    expect(types.has("send")).toBe(true);
    expect(types.has("stop")).toBe(true);
    expect(types.has("clear")).toBe(true);
    expect(types.has("permission_response")).toBe(true);
  });
});

describe("AiChatPanelMessages — resume_sessions / history (host → webview)", () => {
  it("#R5 resume_sessions carries only opaque-id + label + detail per entry", () => {
    const msg: AiChatPanelResumeSessions = {
      type: "resume_sessions",
      sessions: [
        { sessionId: "s1", label: "Fix schema", detail: "12 messages" },
        { sessionId: "s2", label: "(untitled)", detail: "0 messages" },
        // Hostile labels stay verbatim — textContent-only rendering.
        { sessionId: "s3", label: "<script>alert(1)</script>", detail: "<img onerror=x>" },
      ],
    };
    expect(msg.type).toBe("resume_sessions");
    expect(msg.sessions).toHaveLength(3);
    expect(msg.sessions[0]?.label).toBe("Fix schema");
    expect(msg.sessions[1]?.label).toBe("(untitled)");
    // Entries carry only opaque-id + label + detail — no extra fields.
    const keys0 = Object.keys(msg.sessions[0] as object).sort();
    expect(keys0).toEqual(["detail", "label", "sessionId"]);
    // No credential leakage.
    const asJson = JSON.stringify(msg);
    expect(asJson).not.toMatch(/api_?key|sk-[a-z0-9]|secret/i);
  });

  it("#R6 history carries items, truncated, truncatedCount (frozen shape)", () => {
    const msg: AiChatPanelHistory = {
      type: "history",
      items: [
        { kind: "user", text: "hi" },
        { kind: "assistant", text: "hello" },
        { kind: "tool", text: "list_tables" },
      ],
      truncated: true,
      truncatedCount: 7,
    };
    expect(msg.type).toBe("history");
    expect(msg.items).toHaveLength(3);
    expect(msg.items[0]?.kind).toBe("user");
    expect(msg.items[1]?.kind).toBe("assistant");
    expect(msg.items[2]?.kind).toBe("tool");
    expect(msg.truncated).toBe(true);
    expect(msg.truncatedCount).toBe(7);
    // Every item carries only kind + text (no payload, no tool args).
    for (const item of msg.items) {
      expect(Object.keys(item).sort()).toEqual(["kind", "text"]);
    }
    const asJson = JSON.stringify(msg);
    expect(asJson).not.toMatch(/api_?key|sk-[a-z0-9]|secret/i);
  });

  it("#R7 history union assignable to AiChatPanelHostMessage", () => {
    const arr: AiChatPanelHostMessage[] = [
      { type: "init", hasHistory: false },
      { type: "step", label: "x" },
      { type: "delta", text: "y" },
      { type: "assistant", text: "z", markdown: true },
      { type: "error", message: "boom" },
      { type: "engine", name: "omp" },
      { type: "done" },
      { type: "resume_sessions", sessions: [] },
      { type: "history", items: [], truncated: false, truncatedCount: 0 },
    ];
    const types = new Set(arr.map((m) => m.type));
    expect(types.has("resume_sessions")).toBe(true);
    expect(types.has("history")).toBe(true);
    // Existing kinds still present.
    expect(types.has("init")).toBe(true);
    expect(types.has("permission_request")).toBe(false); // not in this slice
  });

  it("#R8 HISTORY_RENDER_CAP is exported and equals 50 (frozen)", () => {
    expect(HISTORY_RENDER_CAP).toBe(50);
  });
});

// ---- TASK-011 (B8) — AiChatPanelEngine gains an optional `version` field --
describe("AiChatPanelMessages — engine (B8: version field)", () => {
  it("#B8a version round-trips on the engine message when omp is active", () => {
    const msg: AiChatPanelHostMessage = {
      type: "engine",
      name: "omp",
      version: "18.0.1",
    };
    expect(msg.type).toBe("engine");
    if (msg.type === "engine") {
      expect(msg.name).toBe("omp");
      expect(msg.version).toBe("18.0.1");
    }
  });

  it("#B8b version is absent (not present, not undefined-on-wire) for builtin", () => {
    const msg: AiChatPanelHostMessage = { type: "engine", name: "builtin", hint: "x" };
    expect("version" in msg).toBe(false);
    expect(JSON.stringify(msg)).not.toMatch(/version/);
  });

  it("#B8c engine message with hint + no version still narrows correctly (backward compatible)", () => {
    const msg: AiChatPanelHostMessage = { type: "engine", name: "builtin" };
    expect(msg.type).toBe("engine");
    if (msg.type === "engine") {
      expect(msg.hint).toBeUndefined();
      expect(msg.version).toBeUndefined();
    }
  });
});
