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
