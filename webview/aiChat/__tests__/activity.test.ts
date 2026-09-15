// webview/aiChat/__tests__/activity.test.ts — TASK-CHATV2-007
//
// Contract tests for the keyed activity timeline. State is built through the
// REAL TASK-CHATV2-004 reducer (never hand-rolled) so the timeline is exercised
// against the shapes the host actually produces.
//
// Covers the task §Test Cases table:
//   1 DOM     tool lifecycle — one keyed row running→success/fail/deny/cancel
//   2 capability reasoning unavailable — neutral Working only, no Thinking
//   3 capability allowed reasoning — collapsed Reasoning, safe text, no live spam
//   5 edge    unknown status/host strings — safe class/text, no injection
//   6 regression always-streaming header — idle/completed show Ready
//   7 a11y    expanded state — button/aria-expanded/controls synchronized
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialChatState, reduceChatState, type ChatViewState } from "../store";
import type { AiChatHostFrameV2 } from "../../../src/ui/aiChatPanelMessages";
import type { EngineCapabilitySnapshot } from "../../../src/ai/capabilities";
import {
  UNKNOWN_STATUS_LABEL,
  createActivityTimeline,
  deriveEngineState,
  formatDuration,
  mapToolState,
  phaseCopyLabel,
  type ActivityTimeline,
} from "../activity";

const PREFIX = "UnicDB-ai-chat-v2";

interface FrameBody {
  readonly [key: string]: unknown;
}

function frame(body: FrameBody, sequence: number): AiChatHostFrameV2 {
  return { protocolVersion: 2, sessionId: "s1", sequence, ...body } as unknown as AiChatHostFrameV2;
}

function host(state: ChatViewState, body: FrameBody, sequence: number): ChatViewState {
  return reduceChatState(state, { type: "HOST_FRAME", frame: frame(body, sequence) });
}

/** A capability snapshot with just the supports the timeline gates on. */
function capabilities(overrides: { streamThought?: boolean; displayName?: string; status?: string }): EngineCapabilitySnapshot {
  return {
    engine: "claude",
    displayName: overrides.displayName ?? "Claude Code",
    status: (overrides.status ?? "ready") as EngineCapabilitySnapshot["status"],
    supports: {
      streamText: true,
      streamThought: overrides.streamThought === true,
      toolTimeline: true,
      imageInput: false,
      nativeSessionResume: false,
      savedTranscriptResume: false,
      engineCommands: false,
      permissions: false,
      bypassPermissions: false,
      modelRoles: false,
      workspaceMentions: false,
      dbMentions: false,
      exportTranscript: false,
    },
    commands: [],
    modelRoles: [],
  };
}

/** Open turn `t1` with capabilities already resolved. */
function openTurn(caps: EngineCapabilitySnapshot, seq = 0): { state: ChatViewState; next: number } {
  let s = reduceChatState(createInitialChatState(), { type: "DRAFT_CHANGED", text: "hello" });
  s = reduceChatState(s, { type: "SUBMIT_REQUESTED", clientRequestId: "c1" });
  let n = seq + 1;
  s = host(s, { kind: "capabilities", capabilities: caps }, n++);
  s = host(s, { kind: "turn_started", turnId: "t1", clientRequestId: "c1" }, n++);
  return { state: s, next: n };
}

let mount: HTMLElement;
let activities: HTMLElement;
let live: HTMLElement;
let timeline: ActivityTimeline;
let copied: Array<[string, string]>;

beforeEach(() => {
  document.body.innerHTML = "";
  mount = document.createElement("div");
  activities = document.createElement("div");
  live = document.createElement("div");
  mount.append(activities, live);
  document.body.append(mount);
  copied = [];
  timeline = createActivityTimeline(
    { activities, statusLiveRegion: live },
    { onCopyDetail: (id, text) => copied.push([id, text]) },
  );
});

afterEach(() => {
  timeline.dispose();
  document.body.innerHTML = "";
});

const rows = () => Array.from(activities.querySelectorAll<HTMLElement>(`.${PREFIX}-activity-row`));
const rowFor = (id: string) =>
  activities.querySelector<HTMLElement>(`.${PREFIX}-activity-row[data-chat-key="${id}"]`);

// ---------------------------------------------------------------------------

describe("activity timeline — tool lifecycle (case 1)", () => {
  it("creates ONE keyed row on tool_started and updates it on tool_finished", () => {
    let { state, next } = openTurn(capabilities({}));
    state = host(state, { kind: "tool_started", turnId: "t1", toolId: "tool-1", label: "Read file", action: "read" }, next++);
    timeline.render(state);

    expect(rows()).toHaveLength(1);
    const row = rowFor("tool-1")!;
    expect(row.dataset.state).toBe("running");
    // 12px spinner is the running glyph.
    expect(row.querySelector('[data-icon="spinner"]')).not.toBeNull();

    state = host(
      state,
      { kind: "tool_finished", turnId: "t1", toolId: "tool-1", label: "Read file", status: "ok", summary: "read", durationMs: 1200 },
      next++,
    );
    timeline.render(state);

    // Same single node — updated, never duplicated.
    expect(rows()).toHaveLength(1);
    expect(rowFor("tool-1")).toBe(row);
    expect(row.dataset.state).toBe("succeeded");
    expect(row.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(row.querySelector(`.${PREFIX}-activity-row-duration`)?.textContent).toBe("1.2s");
  });

  it("renders each terminal state with its allowlisted glyph", () => {
    let { state, next } = openTurn(capabilities({}));
    const cases: Array<[string, string, string]> = [
      ["tool-ok", "ok", "check"],
      ["tool-fail", "failed", "x"],
      ["tool-deny", "denied", "shield-alert"],
      ["tool-cancel", "cancelled", "stop-square"],
    ];
    for (const [toolId, status] of cases) {
      state = host(state, { kind: "tool_started", turnId: "t1", toolId, label: toolId, action: "read" }, next++);
      state = host(
        state,
        { kind: "tool_finished", turnId: "t1", toolId, label: toolId, status, summary: "", durationMs: 10 },
        next++,
      );
    }
    timeline.render(state);
    expect(rows()).toHaveLength(4);
    for (const [toolId, , icon] of cases) {
      expect(rowFor(toolId)!.querySelector(`[data-icon="${icon}"]`), toolId).not.toBeNull();
    }
    expect(rowFor("tool-cancel")!.dataset.state).toBe("cancelled");
  });

  it("tool_finished without a prior tool_started still yields one row", () => {
    let { state, next } = openTurn(capabilities({}));
    state = host(
      state,
      { kind: "tool_finished", turnId: "t1", toolId: "late", label: "Late", status: "ok", summary: "s" },
      next++,
    );
    timeline.render(state);
    expect(rows()).toHaveLength(1);
    expect(rowFor("late")!.dataset.state).toBe("succeeded");
  });
});

describe("activity timeline — reasoning gate (cases 2 and 3)", () => {
  it("reasoning unavailable: neutral Working copy, no Thinking/Reasoning disclosure", () => {
    let { state, next } = openTurn(capabilities({ streamThought: false }));
    state = host(state, { kind: "reasoning_delta", turnId: "t1", messageId: "m1", text: "secret chain of thought" }, next++);
    state = host(state, { kind: "phase", turnId: "t1", phase: "waiting_for_first_event" }, next++);
    timeline.render(state, { elapsedSeconds: 3 });

    const text = activities.textContent ?? "";
    expect(text).not.toContain("Thinking");
    expect(text).not.toContain("Reasoning");
    expect(text).not.toContain("secret chain of thought");
    const summary = activities.querySelector(`.${PREFIX}-activity-summary`)!;
    expect(summary.textContent).toContain("Working… 3s");
    // No Reasoning section is created at all while the gate is closed.
    expect(activities.querySelector(`.${PREFIX}-activity-reasoning`)).toBeNull();
  });

  it("allowed reasoning: collapsed Reasoning section, safe text, no live spam", () => {
    let { state, next } = openTurn(capabilities({ streamThought: true }));
    state = host(state, { kind: "reasoning_delta", turnId: "t1", messageId: "m1", text: "<img src=x onerror=alert(1)>" }, next++);
    timeline.render(state);

    const section = activities.querySelector<HTMLElement>(`.${PREFIX}-activity-reasoning`)!;
    expect(section.hidden).toBe(false);
    const header = section.querySelector(`.${PREFIX}-activity-reasoning-header`)!;
    const body = section.querySelector<HTMLElement>(`.${PREFIX}-activity-reasoning-body`)!;
    expect(header.textContent).toBe("Reasoning");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    // Payload is inert text, not an element.
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent).toBe("<img src=x onerror=alert(1)>");
    // Reasoning is NEVER announced: no reasoning text and no `Reasoning` label
    // reach the live region (only the phase status copy may).
    expect(live.textContent).not.toContain("Reasoning");
    expect(live.textContent).not.toContain("img src=x");

    // A second reasoning delta must not re-announce either.
    const afterFirst = live.textContent;
    state = host(state, { kind: "reasoning_delta", turnId: "t1", messageId: "m1", text: "more" }, next++);
    timeline.render(state);
    expect(live.textContent).toBe(afterFirst);
    expect(live.textContent).not.toContain("more");
  });
});

describe("activity timeline — unknown status safety (case 5)", () => {
  it("maps every unrecognised wire status to the generic state", () => {
    expect(mapToolState("exploded")).toBe("unknown");
    expect(mapToolState("<script>")).toBe("unknown");
    expect(mapToolState(undefined)).toBe("unknown");
    expect(mapToolState("ok")).toBe("succeeded");
    expect(mapToolState("cancelled")).toBe("cancelled");
    expect(mapToolState("canceled")).toBe("cancelled");
  });

  it("renders a safe generic label and never injects a class from the wire", () => {
    let { state, next } = openTurn(capabilities({}));
    state = host(state, { kind: "tool_started", turnId: "t1", toolId: "t9", label: "Bad", action: "read" }, next++);
    // Force a hostile status through the reducer's tool_finished.
    state = host(
      state,
      { kind: "tool_finished", turnId: "t1", toolId: "t9", label: '"><img src=x>', status: "kaboom<class>", summary: "s" },
      next++,
    );
    timeline.render(state);

    const row = rowFor("t9")!;
    expect(row.dataset.state).toBe("unknown");
    expect(row.querySelector(`.${PREFIX}-activity-status`)!.textContent).toBe(UNKNOWN_STATUS_LABEL);
    expect(row.querySelector(`.${PREFIX}-activity-state-unknown`)).not.toBeNull();
    // No wire-derived class leaked (class list comes only from the closed set).
    expect(activities.querySelectorAll("img")).toHaveLength(0);
    expect(row.outerHTML).not.toContain("kaboom");
    expect(row.querySelector(`.${PREFIX}-activity-label`)!.textContent).toBe('"><img src=x>');
  });

  it("hostile detail text stays inert and copy fires only when copyable", () => {
    let { state, next } = openTurn(capabilities({}));
    state = host(state, { kind: "tool_started", turnId: "t1", toolId: "t1", label: "L", action: "read" }, next++);
    state = host(
      state,
      { kind: "tool_finished", turnId: "t1", toolId: "t1", label: "L", status: "ok", summary: "s" },
      next++,
    );
    timeline.render(state, { details: { t1: { text: "<b>hostile</b>", copyable: false } } });

    const row = rowFor("t1")!;
    const toggle = row.querySelector<HTMLButtonElement>(`.${PREFIX}-activity-detail-toggle`)!;
    expect(toggle).not.toBeNull();
    expect(row.querySelector(`.${PREFIX}-activity-detail-text`)!.textContent).toBe("<b>hostile</b>");
    expect(row.querySelector("b")).toBeNull();
    // copyable:false → no copy control.
    expect(row.querySelector(`.${PREFIX}-activity-copy`)).toBeNull();

    timeline.render(state, { details: { t1: { text: "safe line", copyable: true } } });
    const copy = row.querySelector<HTMLButtonElement>(`.${PREFIX}-activity-copy`)!;
    expect(copy).not.toBeNull();
    copy.click();
    expect(copied).toEqual([["t1", "safe line"]]);
  });
});

describe("activity timeline — truthful header (case 6)", () => {
  it("idle and completed phases show Ready, never streaming", () => {
    expect(deriveEngineState("ready", "idle", false)).toBe("ready");
    expect(deriveEngineState("ready", "completed", false)).toBe("ready");

    const caps = capabilities({});
    const engineButton = document.createElement("button");
    const engineLabel = document.createElement("span");
    const tl = createActivityTimeline({ activities, statusLiveRegion: live, engineButton, engineLabel });

    let s = reduceChatState(createInitialChatState(), { type: "HOST_FRAME", frame: frame({ kind: "capabilities", capabilities: caps }, 1) });
    tl.render(s);
    expect(engineLabel.textContent).toBe("Ready");
    expect(engineButton.classList.contains(`${PREFIX}-engine-ready`)).toBe(true);

    // Mid-turn work shows Working.
    const opened = openTurn(caps);
    tl.render(host(opened.state, { kind: "phase", turnId: "t1", phase: "streaming" }, 100));
    expect(engineLabel.textContent).toBe("Working");
    expect(engineButton.classList.contains(`${PREFIX}-engine-working`)).toBe(true);

    // Completed → Ready again (not a hard-coded streaming banner).
    const done = host(opened.state, { kind: "turn_finished", turnId: "t1", outcome: "completed" }, 101);
    tl.render(done);
    expect(engineLabel.textContent).toBe("Ready");
    expect(engineButton.classList.contains(`${PREFIX}-engine-streaming`)).toBe(false);
    tl.dispose();
  });

  it("reports starting/unavailable from the snapshot", () => {
    expect(deriveEngineState(null, "idle", false)).toBe("starting");
    expect(deriveEngineState("starting", "idle", false)).toBe("starting");
    expect(deriveEngineState("unavailable", "idle", false)).toBe("unavailable");
    expect(deriveEngineState("fallback", "idle", false)).toBe("unavailable");
    expect(deriveEngineState("ready", "streaming", true)).toBe("working");
  });

  it("phase copy matches PLAN §6 exactly", () => {
    expect(phaseCopyLabel("validating")).toBe("Preparing your request…");
    expect(phaseCopyLabel("connecting", { displayName: "Claude Code" })).toBe("Connecting to Claude Code…");
    expect(phaseCopyLabel("waiting_for_first_event", { elapsedSeconds: 4 })).toBe("Working… 4s");
    expect(phaseCopyLabel("streaming")).toBe("Responding…");
    expect(phaseCopyLabel("awaiting_permission")).toBe("Waiting for your permission");
    expect(phaseCopyLabel("stopping")).toBe("Stopping…");
    expect(phaseCopyLabel("completed")).toBe("Completed");
    expect(phaseCopyLabel("failed")).toBe("");
  });

  it("formatDuration renders N.Ns and rejects non-durations", () => {
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe("activity timeline — accessibility (case 7)", () => {
  it("header button/aria-expanded/aria-controls stay synchronized", () => {
    const header = activities.querySelector<HTMLButtonElement>(`.${PREFIX}-activity-header`)!;
    const body = activities.querySelector<HTMLElement>(`.${PREFIX}-activity-body`)!;

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    expect(header.getAttribute("aria-controls")).toBe(body.id);

    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(header.querySelector('[data-icon="chevron-down"]')).not.toBeNull();

    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
  });

  it("reasoning toggle keeps its aria wiring", () => {
    let { state, next } = openTurn(capabilities({ streamThought: true }));
    state = host(state, { kind: "reasoning_delta", turnId: "t1", messageId: "m1", text: "r" }, next++);
    timeline.render(state);

    const section = activities.querySelector<HTMLElement>(`.${PREFIX}-activity-reasoning`)!;
    const header = section.querySelector<HTMLButtonElement>(`.${PREFIX}-activity-reasoning-header`)!;
    const body = section.querySelector<HTMLElement>(`.${PREFIX}-activity-reasoning-body`)!;
    expect(header.getAttribute("aria-controls")).toBe(body.id);
    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
  });

  it("detail toggle stays synchronized and copy control is optional", () => {
    let { state, next } = openTurn(capabilities({}));
    state = host(state, { kind: "tool_started", turnId: "t1", toolId: "t1", label: "L", action: "read" }, next++);
    timeline.render(state, { details: { t1: { text: "d", copyable: false } } });
    const row = rowFor("t1")!;
    const toggle = row.querySelector<HTMLButtonElement>(`.${PREFIX}-activity-detail-toggle`)!;
    const pane = row.querySelector<HTMLElement>(`.${PREFIX}-activity-detail`)!;
    expect(toggle.getAttribute("aria-controls")).toBe(pane.id);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(pane.hidden).toBe(false);
  });
});

describe("activity timeline — lifecycle", () => {
  it("dispose removes every created node", () => {
    const { state } = openTurn(capabilities({}));
    timeline.render(state);
    timeline.dispose();
    expect(activities.childElementCount).toBe(0);
  });

  it("render after dispose is a no-op", () => {
    timeline.dispose();
    const { state } = openTurn(capabilities({}));
    timeline.render(state);
    expect(activities.childElementCount).toBe(0);
    vi.restoreAllMocks();
  });
});
