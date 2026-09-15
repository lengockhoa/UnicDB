// webview/aiChat/__tests__/store.test.ts — TASK-CHATV2-004
//
// Pure reducer tests for the V2 single state authority
// (`webview/aiChat/store.ts`). No DOM, no clock, no random ids, no transport —
// every assertion drives `reduceChatState(state, action)` and inspects the
// returned serializable state.
//
// Mirrors the §Test Cases table:
//   1. unit        — full turn lifecycle (exact phases, one stable stream item)
//   2. edge        — wrong session / stale sequence → same logical state
//   3. race        — terminal then late delta → terminal survives
//   4. race        — old mention result after Escape / new revision
//   5. regression  — busy draft editing (edits yes, submit effect no)
//   6. boundary    — >200 rendered items (viewport capped, paging retained)
//   7. purity      — serializable state (JSON round-trip, no DOM/function)

import { beforeEach, describe, expect, it } from "vitest";

import { resolveEngineCapabilities } from "../../../src/ai/capabilities";
import type { AiChatContextRefV2, AiChatHostFrameV2 } from "../../../src/ui/aiChatPanelMessages";
import type { ChatTranscriptItem } from "../store";
import { RENDER_CAP, createInitialChatState, reduceChatState } from "../store";

// ---- Fixtures --------------------------------------------------------------

const SESSION = "sess-1";

const capabilities = resolveEngineCapabilities({
  engine: "omp",
  adapter: { state: "ready" },
  modelRoles: [{ role: "work", modelId: "unic-sonnet", vision: true }],
  activeRole: "work",
  policy: { dbContext: true, workspaceContext: true, bypassAllowed: true },
});

let seq = 0;
beforeEach(() => {
  seq = 0;
});

interface FrameOpts {
  sessionId?: string;
  sequence?: number;
}

/** Build one V2 host frame with a monotonically increasing sequence unless an
 * explicit `sequence` (used for the stale-sequence case) is supplied. */
function f(body: Record<string, unknown>, opts: FrameOpts = {}): AiChatHostFrameV2 {
  seq = opts.sequence ?? seq + 1;
  return {
    protocolVersion: 2,
    sessionId: opts.sessionId ?? SESSION,
    sequence: seq,
    ...body,
  } as unknown as AiChatHostFrameV2;
}

/** A hydrated session state (capabilities + session_hydrated consumed). */
function hydrated() {
  let s = createInitialChatState();
  s = reduceChatState(s, {
    type: "HOST_FRAME",
    frame: f({ kind: "capabilities", capabilities }),
  });
  s = reduceChatState(s, {
    type: "HOST_FRAME",
    frame: f({ kind: "session_hydrated", hasHistory: false, visionCapable: false }),
  });
  return s;
}

function host(state: ReturnType<typeof createInitialChatState>, frame: AiChatHostFrameV2) {
  return reduceChatState(state, { type: "HOST_FRAME", frame });
}

const textItem = (id: string, raw: string, turnId = "t1"): ChatTranscriptItem => ({
  id,
  kind: "text",
  turnId,
  messageId: id,
  raw,
});

// ---- #1 full turn lifecycle (unit) ----------------------------------------

describe("CHATV2-004 #1 — full turn lifecycle (unit)", () => {
  it("walks idle → validating → connecting → waiting → streaming → completed", () => {
    let s = hydrated();
    expect(s.phase).toBe("idle");
    expect(s.sessionId).toBe(SESSION);
    expect(s.hydration.hydrated).toBe(true);
    expect(s.capabilities?.engine).toBe("omp");

    // Local edit bumps the revision but keeps the draft.
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "hello" });
    expect(s.draft.text).toBe("hello");
    expect(s.draft.revision).toBe(1);

    // Submit raises the effect but must NOT clear the draft yet.
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    expect(s.phase).toBe("validating");
    expect(s.pendingSubmit?.clientRequestId).toBe("req-1");
    expect(s.pendingSubmit?.draft.text).toBe("hello");
    expect(s.draft.text).toBe("hello");
    // The user bubble is keyed by the request id — one stable entity.
    expect(s.transcript.order).toContain("user-req-1");

    // Controller posts then drains the effect.
    s = reduceChatState(s, { type: "SUBMIT_CONSUMED", clientRequestId: "req-1" });
    expect(s.pendingSubmit).toBeNull();

    // Host ack: turn opens AND the matching draft clears once.
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    expect(s.turn?.turnId).toBe("t1");
    expect(s.phase).toBe("validating");
    expect(s.draft.text).toBe("");
    expect(s.draft.revision).toBe(2);

    s = host(s, f({ kind: "phase", turnId: "t1", phase: "connecting" }));
    expect(s.phase).toBe("connecting");
    s = host(s, f({ kind: "phase", turnId: "t1", phase: "waiting_for_first_event" }));
    expect(s.phase).toBe("waiting_for_first_event");

    // First delta opens streaming and creates exactly one assistant item.
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "Hel" }));
    expect(s.phase).toBe("streaming");
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "lo" }));
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "!" }));

    const textItems = Object.values(s.transcript.entities).filter((i) => i.kind === "text");
    expect(textItems).toHaveLength(1);
    const streamed = s.transcript.entities["m1"];
    expect(streamed?.kind).toBe("text");
    if (streamed?.kind === "text") expect(streamed.raw).toBe("Hello!");

    // Terminal closes the turn exactly once.
    s = host(s, f({ kind: "turn_finished", turnId: "t1", outcome: "completed" }));
    expect(s.phase).toBe("completed");
    expect(s.turn?.closed).toBe(true);
    expect(s.turn?.outcome).toBe("completed");
  });

  it("does not clear the draft when turn_started carries a different request id", () => {
    let s = hydrated();
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "keep me" });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "someone-else" }));
    expect(s.turn).toBeNull();
    expect(s.draft.text).toBe("keep me");
    expect(s.pendingSubmit?.clientRequestId).toBe("req-1");
  });
});

// ---- #2 wrong session / stale sequence (edge) ------------------------------

describe("CHATV2-004 #2 — wrong session / stale sequence (edge)", () => {
  it("ignores a frame from another session (same logical state)", () => {
    const s = hydrated();
    const next = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "x" }, { sessionId: "other" }));
    expect(next).toBe(s);
    expect(next.sessionId).toBe(SESSION);
  });

  it("ignores a duplicate/stale sequence (same logical state)", () => {
    const s = hydrated();
    const stale = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "x" }, { sequence: seq }));
    expect(stale).toBe(s);
    expect(stale.lastSequence).toBe(s.lastSequence);
  });

  it("adopts the session id from the very first frame, then enforces it", () => {
    let s = createInitialChatState();
    expect(s.sessionId).toBeNull();
    s = host(s, f({ kind: "capabilities", capabilities }));
    expect(s.sessionId).toBe(SESSION);
    expect(s.lastSequence).toBe(1);

    const other = host(s, f({ kind: "capabilities", capabilities }, { sessionId: "other" }));
    expect(other).toBe(s);
  });
});

// ---- #3 terminal then delta (race) ----------------------------------------

describe("CHATV2-004 #3 — terminal then late delta (race)", () => {
  it("ignores a delta that arrives after the turn completed", () => {
    let s = hydrated();
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "hi" });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "Hello" }));
    s = host(s, f({ kind: "turn_finished", turnId: "t1", outcome: "completed" }));
    expect(s.phase).toBe("completed");

    const after = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "LATE" }));
    expect(after.phase).toBe("completed");
    const item = after.transcript.entities["m1"];
    expect(item?.kind).toBe("text");
    if (item?.kind === "text") expect(item.raw).toBe("Hello");
  });

  it("ignores a delta for a different (wrong) turn", () => {
    let s = hydrated();
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "hi" });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    const after = host(s, f({ kind: "text_delta", turnId: "t9", messageId: "mZ", text: "no" }));
    expect(after.transcript.entities["mZ"]).toBeUndefined();
    expect(after.phase).toBe("validating");
  });

  it("closes a turn on the first terminal frame only", () => {
    let s = hydrated();
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "hi" });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    s = host(s, f({ kind: "turn_finished", turnId: "t1", outcome: "failed" }));
    expect(s.phase).toBe("failed");
    const second = host(s, f({ kind: "turn_finished", turnId: "t1", outcome: "completed" }));
    expect(second.phase).toBe("failed");
    expect(second.turn?.outcome).toBe("failed");
  });
});

// ---- #4 mention result after Escape / new revision (race) ------------------

describe("CHATV2-004 #4 — stale mention result after Escape / new revision (race)", () => {
  it("a late result cannot reopen an escape-closed popover", () => {
    let s = hydrated();
    s = reduceChatState(s, {
      type: "AUTOCOMPLETE_OPENED",
      mode: "mention",
      requestId: "r1",
      draftRevision: s.draft.revision,
      query: "@a",
    });
    expect(s.autocomplete.open).toBe(true);
    const openGeneration = s.autocomplete.generation;

    s = reduceChatState(s, { type: "AUTOCOMPLETE_CLOSED", reason: "escape" });
    expect(s.autocomplete.open).toBe(false);
    expect(s.autocomplete.generation).toBeGreaterThan(openGeneration);

    const late = host(
      s,
      f({
        kind: "mention_results",
        requestId: "r1",
        draftRevision: 0,
        query: "@a",
        items: [{ kind: "table", label: "users", detail: "public", token: "users" }],
      }),
    );
    expect(late.autocomplete.open).toBe(false);
    expect(late.autocomplete.items).toHaveLength(0);
  });

  it("keeps new results intact when the old response arrives late", () => {
    let s = hydrated();
    s = reduceChatState(s, {
      type: "AUTOCOMPLETE_OPENED",
      mode: "mention",
      requestId: "r2",
      draftRevision: 5,
      query: "@u",
    });
    s = host(
      s,
      f({
        kind: "mention_results",
        requestId: "r2",
        draftRevision: 5,
        query: "@u",
        items: [{ kind: "table", label: "users", detail: "public", token: "users" }],
      }),
    );
    expect(s.autocomplete.items).toHaveLength(1);
    expect(s.autocomplete.loading).toBe(false);

    // Old request/revision from before the current open state.
    const late = host(
      s,
      f({
        kind: "mention_results",
        requestId: "r1",
        draftRevision: 4,
        query: "@o",
        items: [{ kind: "view", label: "orders", detail: "public", token: "orders" }],
      }),
    );
    expect(late.autocomplete.items).toHaveLength(1);
    expect(late.autocomplete.items[0]?.label).toBe("users");
    expect(late.autocomplete.requestId).toBe("r2");
  });
});

// ---- #5 busy draft editing (regression) -----------------------------------

describe("CHATV2-004 #5 — busy draft editing (regression)", () => {
  it("edits the next draft while streaming but creates no submit effect", () => {
    let s = hydrated();
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "first" });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "..." }));
    expect(s.phase).toBe("streaming");

    const before = s.draft.revision;
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "next message" });
    expect(s.draft.text).toBe("next message");
    expect(s.draft.revision).toBeGreaterThan(before);

    // Busy submit is refused: no effect, phase unchanged.
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-2" });
    expect(s.pendingSubmit).toBeNull();
    expect(s.phase).toBe("streaming");
    expect(s.transcript.entities["user-req-2"]).toBeUndefined();
  });

  it("Stop intent moves to stopping only after the controller dispatches it", () => {
    let s = hydrated();
    s = reduceChatState(s, { type: "DRAFT_CHANGED", text: "hi" });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "..." }));
    expect(s.phase).toBe("streaming");

    // Intent recorded, phase NOT yet changed.
    s = reduceChatState(s, { type: "STOP_REQUESTED", clientRequestId: "stop-1" });
    expect(s.pendingStop?.clientRequestId).toBe("stop-1");
    expect(s.phase).toBe("streaming");

    // Dispatch flips the phase to stopping.
    s = reduceChatState(s, { type: "STOP_DISPATCHED", clientRequestId: "stop-1" });
    expect(s.phase).toBe("stopping");

    // The host closes it as stopped → terminal completed (phase vocabulary has
    // no `stopped`; the outcome is preserved on the turn record).
    s = host(s, f({ kind: "turn_finished", turnId: "t1", outcome: "stopped" }));
    expect(s.phase).toBe("completed");
    expect(s.turn?.outcome).toBe("stopped");

    // A late delta after the stop cannot reopen the stream.
    const late = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "LATE" }));
    const item = late.transcript.entities["m1"];
    if (item?.kind === "text") expect(item.raw).toBe("...");
  });
});

// ---- #6 >200 rendered items (boundary) -------------------------------------

describe("CHATV2-004 #6 — more than 200 rendered items (boundary)", () => {
  it("caps the viewport list while retaining the full session record", () => {
    const items: ChatTranscriptItem[] = Array.from({ length: 250 }, (_, i) =>
      textItem(`m${i}`, `t${i}`, "t1"),
    );
    const s = reduceChatState(hydrated(), {
      type: "TRANSCRIPT_PAGE_LOADED",
      items,
      total: 250,
    });

    expect(s.transcript.order).toHaveLength(250);
    expect(Object.keys(s.transcript.entities)).toHaveLength(250);
    expect(s.transcript.renderOrder).toHaveLength(RENDER_CAP);
    expect(s.transcript.paging.cap).toBe(RENDER_CAP);
    expect(s.transcript.paging.total).toBe(250);
    expect(s.transcript.paging.hasMore).toBe(true);
    // The oldest entity survives even though it left the viewport.
    expect(s.transcript.entities["m0"]).toBeDefined();
    expect(s.transcript.renderOrder).not.toContain("m0");
  });
});

// ---- #7 serializable state (purity) ----------------------------------------

describe("CHATV2-004 #7 — serializable state (purity)", () => {
  it("survives a JSON round-trip and contains no DOM/function values", () => {
    let s = hydrated();
    s = reduceChatState(s, {
      type: "DRAFT_CHANGED",
      text: "hello \"world\" <script>alert(1)</script>",
      selectionEnd: 3,
    });
    const ref: AiChatContextRefV2 = { kind: "table", id: "public.users", label: "users" };
    s = reduceChatState(s, { type: "CONTEXT_ADDED", ref });
    s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "req-1" });
    s = host(s, f({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }));
    s = host(s, f({ kind: "text_delta", turnId: "t1", messageId: "m1", text: "done" }));
    s = host(s, f({ kind: "tool_started", turnId: "t1", toolId: "tool-1", label: "Run SQL", action: "run" }));
    s = host(
      s,
      f({
        kind: "tool_finished",
        turnId: "t1",
        toolId: "tool-1",
        label: "Run SQL",
        status: "ok",
        summary: "12 rows",
        durationMs: 40,
      }),
    );
    s = host(
      s,
      f({
        kind: "permission_requested",
        turnId: "t1",
        requestId: "perm-1",
        tool: { id: "tool-1", name: "Run SQL", detail: "delete from t" },
        options: [{ optionId: "allow", label: "Allow" }],
      }),
    );
    s = host(s, f({ kind: "toast", level: "info", safeMessage: "hi" }));
    s = host(s, f({ kind: "turn_finished", turnId: "t1", outcome: "completed" }));

    const clone = JSON.parse(JSON.stringify(s));
    expect(clone).toStrictEqual(s);

    assertSerializable(s);
  });
});

/** Recursively reject anything a JSON round-trip cannot represent (or that
 * would drag a live DOM node into state). */
function assertSerializable(value: unknown, path = "state"): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return;
  if (t === "function") throw new Error(`function at ${path}`);
  if (t === "undefined") throw new Error(`undefined at ${path}`);
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertSerializable(entry, `${path}[${i}]`));
    return;
  }
  if (t === "object") {
    const node = value as { nodeType?: unknown; constructor?: { name?: string } };
    if (typeof node.nodeType === "number") throw new Error(`DOM node at ${path}`);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      assertSerializable((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  throw new Error(`non-serializable ${t} at ${path}`);
}
