// src/ui/__tests__/aiChatPanelMessagesV2.test.ts — TASK-CHATV2-003
//
// Pure protocol tests for the versioned V2 host/webview contract:
//   - frame/intent unions + runtime narrow guards (src/ui/aiChatPanelMessages.ts)
//
// These tests are pure — no vscode, no DOM. They cover the cases named in
// the task file: ordered turn frames, unknown/malformed intents, stale/wrong
// session frames, mention correlation and forbidden-field security shape.
//
// TASK-CHATV2-017 — the temporary V1→V2 compatibility translation
// (`src/ui/aiChatPanelV1Adapter.ts`) was deleted with the V1 cutover, so the
// former "#6 V1 compatibility" block is replaced by a regression assertion
// that no V1 adapter module survives (see the last describe block).

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEngineCapabilities } from "../../ai/capabilities";
import type {
  AiChatFrameEnvelopeV2,
  AiChatHostFrameV2,
  AiChatHostFrameMentionResultsV2,
  AiChatWebviewIntentV2,
} from "../aiChatPanelMessages";
import {
  AI_CHAT_PROTOCOL_VERSION_V2,
  isAiChatHostFrameV2,
  isMentionResponseCurrentV2,
  nextV2Envelope,
  parseAiChatWebviewIntentV2,
  shouldAcceptHostFrameV2,
} from "../aiChatPanelMessages";

// ---- Fixtures --------------------------------------------------------------

const capabilities = resolveEngineCapabilities({
  engine: "omp",
  adapter: { state: "ready" },
  modelRoles: [{ role: "work", modelId: "unic-sonnet", vision: true }],
  activeRole: "work",
  policy: { dbContext: true, workspaceContext: true, bypassAllowed: true },
});

describe("CHATV2-003 #1 — ordered turn frames (unit)", () => {
  it("V2 envelope is mandatory: version/session/sequence and turnId on turn frames", () => {
    // The envelope itself starts at sequence 1 for a freshly hydrated session.
    const env = nextV2Envelope(null, "sess-1");
    expect(env).toEqual({
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      sessionId: "sess-1",
      sequence: 1,
    });
    expect(AI_CHAT_PROTOCOL_VERSION_V2).toBe(2);

    // A turn frame carries its envelope fields AND a turnId.
    const frame: AiChatHostFrameV2 = {
      ...nextV2Envelope(env, "sess-1"),
      kind: "text_delta",
      turnId: "turn-1",
      messageId: "msg-1",
      text: "hello",
    };
    expect(frame.sequence).toBe(2);
    expect(frame.turnId).toBe("turn-1");
    expect(isAiChatHostFrameV2(frame)).toBe(true);
  });

  it("sequence is monotonic per session and restarts at 1 on a new session", () => {
    const first = nextV2Envelope(null, "sess-1");
    const second = nextV2Envelope(first, "sess-1");
    const third = nextV2Envelope(second, "sess-1");
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);

    // A different session id (re-hydration) restarts the counter at 1.
    const rehydrated = nextV2Envelope(third, "sess-2");
    expect(rehydrated.sequence).toBe(1);
    expect(rehydrated.sessionId).toBe("sess-2");
  });

  it("turnId is required by the type on turn frames (compile-time shape)", () => {
    // Compile-time proof: a turn-scoped frame shape without `turnId` is NOT
    // assignable to the V2 host union. If the union ever drops the mandatory
    // `turnId`, `_TurnIdRequired` resolves to `never` and this line stops
    // compiling (a real build failure, not a silent type regression).
    type MissingTurn = {
      protocolVersion: 2;
      sessionId: string;
      sequence: number;
      kind: "text_delta";
      messageId: string;
      text: string;
    };
    type _TurnIdRequired = MissingTurn extends AiChatHostFrameV2 ? never : true;
    const _turnIdRequired: _TurnIdRequired = true;
    expect(_turnIdRequired).toBe(true);

    // Runtime proof: the narrowing guard rejects a turn frame with no turnId.
    const missingTurn = {
      protocolVersion: 2,
      sessionId: "sess-1",
      sequence: 1,
      kind: "text_delta",
      messageId: "m",
      text: "x",
    };
    expect(isAiChatHostFrameV2(missingTurn)).toBe(false);
  });
});

describe("CHATV2-003 #2 — unknown/malformed intent (edge)", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    42,
    "submit_turn",
    [],
    {},
    { type: "ready" }, // a V1 message is NOT a V2 intent
    { kind: "bogus_kind", protocolVersion: 2, clientRequestId: "c1" },
    { kind: "submit_turn", protocolVersion: 2 }, // missing clientRequestId
    { kind: "submit_turn", protocolVersion: 1, clientRequestId: "c1" }, // wrong version
    { kind: "submit_turn", protocolVersion: 2, clientRequestId: "" }, // empty id
    { kind: "set_engine", protocolVersion: 2, clientRequestId: "c1", engine: "turbo" },
    { kind: "search_context", protocolVersion: 2, clientRequestId: "c1", requestId: "r", draftRevision: "x", query: "" },
  ];

  it("every malformed input is rejected safely — parse never throws, host stays alive", () => {
    for (const raw of malformed) {
      let result: ReturnType<typeof parseAiChatWebviewIntentV2> | null = null;
      expect(() => {
        result = parseAiChatWebviewIntentV2(raw);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
    }
  });

  it("a well-formed intent parses and joins the union", () => {
    const raw = {
      kind: "submit_turn",
      protocolVersion: 2,
      clientRequestId: "req-1",
      draft: { text: "hi", revision: 3, context: [], attachments: [] },
    };
    const parsed = parseAiChatWebviewIntentV2(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const intent: AiChatWebviewIntentV2 = parsed.intent;
      expect(intent.kind).toBe("submit_turn");
      expect(intent.clientRequestId).toBe("req-1");
    }
  });
});

describe("CHATV2-003 #3 — stale/wrong-session frame (race)", () => {
  const gate = { sessionId: "sess-1", lastSequence: 4 };

  it("accepts a strictly newer sequence for the right session", () => {
    const frame: AiChatFrameEnvelopeV2 = {
      protocolVersion: 2,
      sessionId: "sess-1",
      sequence: 5,
    };
    expect(shouldAcceptHostFrameV2(gate, frame)).toBe(true);
  });

  it("rejects duplicate/stale sequence (<= lastSequence) deterministically", () => {
    for (const sequence of [4, 3, 0, -1]) {
      const frame: AiChatFrameEnvelopeV2 = {
        protocolVersion: 2,
        sessionId: "sess-1",
        sequence,
      };
      expect(shouldAcceptHostFrameV2(gate, frame)).toBe(false);
    }
  });

  it("rejects a frame for a different session regardless of sequence", () => {
    const frame: AiChatFrameEnvelopeV2 = {
      protocolVersion: 2,
      sessionId: "sess-OTHER",
      sequence: 999,
    };
    expect(shouldAcceptHostFrameV2(gate, frame)).toBe(false);
  });
});

describe("CHATV2-003 #4 — mention correlation (race)", () => {
  const request = {
    requestId: "req-77",
    draftRevision: 12,
    query: "pu",
  };

  const response: AiChatHostFrameMentionResultsV2 = {
    ...nextV2Envelope(null, "sess-1"),
    kind: "mention_results",
    ...request,
    items: [
      { kind: "table", label: "public.users", detail: "public · table", token: "public.users" },
    ],
  };

  it("response echoes requestId, draftRevision and query exactly", () => {
    expect(response.requestId).toBe(request.requestId);
    expect(response.draftRevision).toBe(request.draftRevision);
    expect(response.query).toBe(request.query);
    expect(response.items).toHaveLength(1);
  });

  it("a response matching the open request is current; stale revision is not", () => {
    expect(isMentionResponseCurrentV2(request, response)).toBe(true);
    expect(
      isMentionResponseCurrentV2({ ...request, draftRevision: 13 }, response),
    ).toBe(false);
    expect(
      isMentionResponseCurrentV2({ ...request, requestId: "req-other" }, response),
    ).toBe(false);
    // No open request (dismissed popover) → nothing is current.
    expect(isMentionResponseCurrentV2(null, response)).toBe(false);
  });
});

describe("CHATV2-003 #5 — forbidden fields (security)", () => {
  // The scanner is a TEST-side shape check. It lives here (not in the shipped
  // protocol module) because the protocol source is pinned by an existing
  // security test that forbids the literal field names in that file.
  const FORBIDDEN_FIELD_NAMES = [
    "apikey",
    "password",
    "connectionstring",
    "rawstderr",
    "rawtrace",
    "base64",
    "permissiontoken",
  ];
  const FORBIDDEN_FIELD_PATTERNS_V2: readonly RegExp[] = [
    /api_?key/i,
    /password/i,
    /connection_?string/i,
    /raw_?stderr/i,
    /raw_?trace/i,
    /\bbase64\b/i,
    /permission_?token/i,
  ];
  const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
    /sk-[a-z0-9]{4,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];

  /**
   * Recursively scan a value for a forbidden field name or secret-shaped
   * value. Returns a short description of the first hit, or `null` when clean.
   */
  function findForbiddenFieldV2(value: unknown): string | null {
    const seen = new WeakSet<object>();
    const walk = (node: unknown, path: string): string | null => {
      if (typeof node === "string") {
        for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
          if (pattern.test(node)) return `forbidden value shape at ${path}`;
        }
        return null;
      }
      if (node === null || typeof node !== "object") return null;
      const obj = node as object;
      if (seen.has(obj)) return null;
      seen.add(obj);
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const hit = walk(node[i], `${path}[${i}]`);
          if (hit !== null) return hit;
        }
        return null;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        if (FORBIDDEN_FIELD_NAMES.includes(normalized)) {
          return `forbidden field: ${key}`;
        }
        const hit = walk(child, path === "" ? key : `${path}.${key}`);
        if (hit !== null) return hit;
      }
      return null;
    };
    return walk(value, "");
  }

  const frames: AiChatHostFrameV2[] = [
    { ...nextV2Envelope(null, "sess-1"), kind: "capabilities", capabilities },
    { ...nextV2Envelope(null, "sess-1"), kind: "session_hydrated", hasHistory: false, visionCapable: true },
    { ...nextV2Envelope(null, "sess-1"), kind: "turn_started", turnId: "t", clientRequestId: "c" },
    { ...nextV2Envelope(null, "sess-1"), kind: "text_delta", turnId: "t", messageId: "m", text: "hi" },
    { ...nextV2Envelope(null, "sess-1"), kind: "tool_started", turnId: "t", toolId: "x", label: "list", action: "read" },
    {
      ...nextV2Envelope(null, "sess-1"),
      kind: "error",
      turnId: "t",
      safeMessage: "Could not complete this response",
      diagnosticId: "diag-1",
      safeDetail: "provider returned status 500",
    },
    { ...nextV2Envelope(null, "sess-1"), kind: "mention_results", requestId: "r", draftRevision: 0, query: "q", items: [] },
    { ...nextV2Envelope(null, "sess-1"), kind: "toast", level: "warning", safeMessage: "heads up" },
  ];

  it("real host-frame fixtures never expose a forbidden field or payload", () => {
    for (const frame of frames) {
      expect(findForbiddenFieldV2(frame)).toBeNull();
    }
    const asJson = JSON.stringify(frames);
    for (const pattern of FORBIDDEN_FIELD_PATTERNS_V2) {
      expect(pattern.test(asJson)).toBe(false);
    }
    expect(asJson).not.toMatch(/sk-[a-z0-9]/i);
  });

  it("the scanner detects nested forbidden keys and secret-shaped values", () => {
    expect(findForbiddenFieldV2({ apiKey: "x" })).toContain("apiKey");
    expect(findForbiddenFieldV2({ a: { password: "p" } })).toContain("password");
    expect(findForbiddenFieldV2([{ deep: { connectionString: "postgres://" } }])).toContain(
      "connectionString",
    );
    expect(findForbiddenFieldV2({ rawStderr: "..." })).toContain("rawStderr");
    expect(findForbiddenFieldV2({ rawTrace: [] })).toContain("rawTrace");
    expect(findForbiddenFieldV2({ payload: { base64: "AAAA" } })).toContain("base64");
    expect(findForbiddenFieldV2({ permissionToken: "t" })).toContain("permissionToken");
    expect(findForbiddenFieldV2({ token: "sk-live-abc123" })).not.toBeNull();
  });
});

// ---- #6 — V1 cutover (regression) -----------------------------------------

describe("CHATV2-017 #6 — V1 adapter deleted (regression)", () => {
  it("no V1 compatibility adapter module survives the cutover", () => {
    const adapter = resolve(process.cwd(), "src", "ui", "aiChatPanelV1Adapter.ts");
    expect(existsSync(adapter)).toBe(false);
  });
});
