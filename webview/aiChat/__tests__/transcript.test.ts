// webview/aiChat/__tests__/transcript.test.ts — TASK-CHATV2-006
//
// Contract tests for the keyed V2 transcript renderer. State is built through
// the REAL TASK-CHATV2-004 reducer (never hand-rolled) so the renderer is
// exercised against the same shapes the host produces.
//
// Covers the task §Test Cases table:
//   1 DOM     stable streaming item
//   2 security hostile payload matrix
//   3 edge    empty/duplicate terminal
//   4 regression stopped partial text
//   5 edge    clipboard rejection
//   6 boundary 201+ items
//   7 content  SQL action
// plus the coalesced paint + callback-payload contracts.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createInitialChatState,
  reduceChatState,
  type ChatViewState,
} from "../store";
import type { AiChatHostFrameV2 } from "../../../src/ui/aiChatPanelMessages";
import {
  COPY_FAIL_LABEL,
  COPY_OK_LABEL,
  LOAD_EARLIER_LABEL,
  STOPPED_LABEL,
  createTranscriptRenderer,
  type TranscriptRenderer,
} from "../transcript";

const PREFIX = "UnicDB-ai-chat-v2";

// ---------------------------------------------------------------------------
// State builders (real reducer)
// ---------------------------------------------------------------------------

interface FrameBody {
  readonly [key: string]: unknown;
}

function frame(body: FrameBody, sequence: number): AiChatHostFrameV2 {
  return { protocolVersion: 2, sessionId: "s1", sequence, ...body } as unknown as AiChatHostFrameV2;
}

function host(state: ChatViewState, body: FrameBody, sequence: number): ChatViewState {
  return reduceChatState(state, { type: "HOST_FRAME", frame: frame(body, sequence) });
}

/** Open turn `t1` for client request `c1` with an optional user draft. */
function openTurn(seq = 1): { state: ChatViewState; next: number } {
  let state = reduceChatState(createInitialChatState(), { type: "DRAFT_CHANGED", text: "hello" });
  state = reduceChatState(state, { type: "SUBMIT_REQUESTED", clientRequestId: "c1" });
  state = host(state, { kind: "turn_started", turnId: "t1", clientRequestId: "c1" }, seq);
  return { state, next: seq + 1 };
}

function streamText(state: ChatViewState, seq: number, text: string, messageId = "m1"): ChatViewState {
  return host(state, { kind: "text_delta", turnId: "t1", messageId, text }, seq);
}

function finishTurn(
  state: ChatViewState,
  seq: number,
  outcome: "completed" | "stopped" | "failed" = "completed",
): ChatViewState {
  return host(state, { kind: "turn_finished", turnId: "t1", outcome }, seq);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLElement;
let renderer: TranscriptRenderer;
const rafQueue: Array<FrameRequestCallback> = [];

function makeRefs(): {
  transcript: HTMLElement;
  statusLiveRegion: HTMLElement;
  alertLiveRegion: HTMLElement;
} {
  const statusLiveRegion = document.createElement("div");
  statusLiveRegion.id = `${PREFIX}-status-live`;
  const alertLiveRegion = document.createElement("div");
  alertLiveRegion.id = `${PREFIX}-alert-live`;
  document.body.append(statusLiveRegion, alertLiveRegion);
  return { transcript: container, statusLiveRegion, alertLiveRegion };
}

function flushRaf(): void {
  while (rafQueue.length > 0) {
    const cb = rafQueue.shift()!;
    cb(performance.now());
  }
}

function items(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${PREFIX}-item`));
}

/** Let queued promise jobs (clipboard then/catch) drain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function byKey(key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-chat-key="${key}"]`);
}

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  container.className = `${PREFIX}-transcript`;
  document.body.appendChild(container);
  rafQueue.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (): void => {
    rafQueue.length = 0;
  });
  renderer = createTranscriptRenderer(makeRefs());
});

afterEach(() => {
  renderer.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Case 1 — stable streaming item
// ---------------------------------------------------------------------------

describe("transcript — case 1: one stable node per messageId", () => {
  it("keeps ONE node across many deltas and the terminal frame", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "Hel");
    renderer.render(state);
    const first = byKey("m1");
    expect(first).not.toBeNull();

    // A burst of deltas coalesces; each render never replaces the node.
    for (const chunk of ["lo ", "wor", "ld"]) {
      state = streamText(state, next++, chunk);
      renderer.render(state);
      expect(byKey("m1")).toBe(first);
    }
    flushRaf();

    state = finishTurn(state, next++);
    renderer.render(state);
    expect(byKey("m1")).toBe(first);
    expect(items().filter((n) => n.dataset.chatKey === "m1").length).toBe(1);
    expect(first!.querySelector(`.${PREFIX}-assistant-body`)?.textContent).toContain("Hello world");
  });

  it("coalesces a delta burst into a single deferred paint", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "a");
    renderer.render(state);
    flushRaf();
    const renderSpy = vi.spyOn(Number.prototype, "toString"); // no-op holder
    renderSpy.mockRestore();

    state = streamText(state, next++, "b");
    renderer.render(state);
    state = streamText(state, next++, "c");
    renderer.render(state);
    // Not painted yet — the frame callback has not run.
    expect(container.querySelector(`.${PREFIX}-assistant-body`)?.textContent).toBe("a");
    flushRaf();
    expect(container.querySelector(`.${PREFIX}-assistant-body`)?.textContent).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// Case 2 — hostile payload matrix
// ---------------------------------------------------------------------------

describe("transcript — case 2: hostile payload matrix", () => {
  it("keeps assistant <script> inert and never creates a script node", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "<script>window.__xss = 1</script>");
    renderer.render(state);
    flushRaf();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(container.textContent).toContain("<script>");
  });

  it("keeps assistant <img onerror> inert", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "**<img src=x onerror=boom>**");
    renderer.render(state);
    flushRaf();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(`.${PREFIX}-assistant-body strong`)?.textContent).toBe(
      "<img src=x onerror=boom>",
    );
  });

  it("writes user text, tool label/summary and errors through textContent", () => {
    let state = createInitialChatState();
    state = reduceChatState(state, {
      type: "DRAFT_CHANGED",
      text: "<b onmouseover=alert(1)>hi</b>",
    });
    state = reduceChatState(state, { type: "SUBMIT_REQUESTED", clientRequestId: "c1" });
    state = host(state, { kind: "turn_started", turnId: "t1", clientRequestId: "c1" }, 1);
    state = host(
      state,
      { kind: "tool_started", turnId: "t1", toolId: "tool1", label: "<i>run</i>", action: "file" },
      2,
    );
    state = host(
      state,
      {
        kind: "tool_finished",
        turnId: "t1",
        toolId: "tool1",
        label: "<i>run</i>",
        status: "ok",
        summary: "rows < 5 & done",
      },
      3,
    );
    renderer.render(state);

    const userText = container.querySelector(`.${PREFIX}-user-text`);
    expect(userText?.textContent).toBe("<b onmouseover=alert(1)>hi</b>");
    expect(container.querySelector("b")).toBeNull();
    const tool = byKey("tool1");
    expect(tool?.querySelector(`.${PREFIX}-tool-label`)?.textContent).toBe("<i>run</i>");
    expect(tool?.querySelector(`.${PREFIX}-tool-summary`)?.textContent).toBe("rows < 5 & done");
    expect(tool?.querySelector("i")).toBeNull();
  });

  it("never lets a provider payload produce an event-bearing element", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, '"><svg/onload=alert(1)>');
    renderer.render(state);
    flushRaf();
    // Decorative icons are legitimate SVG; the proof is that no event
    // attribute and no provider-derived element node was created. The payload
    // survives only as escaped text inside the assistant body.
    expect(container.querySelector("[onload]")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    const body = container.querySelector(`.${PREFIX}-assistant-body`)!;
    expect(body.querySelector("svg")).toBeNull();
    expect(body.textContent).toBe('"><svg/onload=alert(1)>');
  });
});

// ---------------------------------------------------------------------------
// Case 3 — empty / duplicate terminal
// ---------------------------------------------------------------------------

describe("transcript — case 3: empty delta and duplicate terminal", () => {
  it("ignores an empty delta (no blank bubble, no caret-only node)", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "", "m-empty");
    renderer.render(state);
    expect(byKey("m-empty")).toBeNull();
    expect(items().length).toBe(1); // only the user bubble

    state = streamText(state, next++, "real", "m-empty");
    renderer.render(state);
    flushRaf();
    expect(byKey("m-empty")).not.toBeNull();
    expect(container.querySelector(`.${PREFIX}-assistant-body`)?.textContent).toContain("real");
  });

  it("a duplicate terminal frame does not duplicate the action row or footer", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "partial answer");
    state = finishTurn(state, next++, "stopped");
    renderer.render(state);
    renderer.render(state); // identical duplicate terminal render

    const node = byKey("m1")!;
    expect(node.querySelectorAll(`.${PREFIX}-actions`).length).toBe(1);
    expect(node.querySelectorAll(`.${PREFIX}-stopped`).length).toBe(1);
    expect(items().filter((n) => n.dataset.chatKey === "m1").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — stopped partial text
// ---------------------------------------------------------------------------

describe("transcript — case 4: stopped partial text", () => {
  it("keeps partial text, removes the caret, adds a Stopped footer, regenerate enabled", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "half an ans");
    renderer.render(state);
    flushRaf();
    expect(container.querySelector(`.${PREFIX}-caret`)?.hasAttribute("hidden")).toBe(false);

    state = finishTurn(state, next++, "stopped");
    renderer.render(state);

    const node = byKey("m1")!;
    expect(node.querySelector(`.${PREFIX}-assistant-body`)?.textContent).toContain("half an ans");
    expect(node.querySelector(`.${PREFIX}-caret`)?.hasAttribute("hidden")).toBe(true);
    expect(node.querySelector(`.${PREFIX}-stopped`)?.textContent).toBe(STOPPED_LABEL);
    const regenerate = node.querySelector<HTMLButtonElement>('[data-action="regenerate"]');
    expect(regenerate).not.toBeNull();
    expect(regenerate!.disabled).toBe(false);
  });

  it("removes the Stopped footer when the turn is not stopped", () => {
    let { state, next } = openTurn();
    state = streamText(state, next++, "done");
    state = finishTurn(state, next++, "stopped");
    renderer.render(state);
    expect(byKey("m1")!.querySelector(`.${PREFIX}-stopped`)).not.toBeNull();

    // A fresh render of a non-stopped state clears it.
    renderer.render(reduceChatState(createInitialChatState(), { type: "SCROLL_PROXIMITY_CHANGED", distancePx: 0 }));
    expect(byKey("m1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 5 — clipboard rejection
// ---------------------------------------------------------------------------

describe("transcript — case 5: clipboard round-trip", () => {
  it("announces Copied on success through the polite status region", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    let { state, next } = openTurn();
    state = streamText(state, next++, "answer");
    state = finishTurn(state, next++);
    renderer.render(state);
    renderer.render(state);
    flushRaf();

    byKey("m1")!.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("answer");
    expect(document.getElementById(`${PREFIX}-status-live`)?.textContent).toBe(COPY_OK_LABEL);
  });

  it("announces Could not copy in the alert region on rejection (no silent catch)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    let { state, next } = openTurn();
    state = streamText(state, next++, "answer");
    state = finishTurn(state, next++);
    renderer.render(state);
    flushRaf();

    byKey("m1")!.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
    await settle();
    expect(document.getElementById(`${PREFIX}-alert-live`)?.textContent).toBe(COPY_FAIL_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — 200-item cap + load earlier
// ---------------------------------------------------------------------------

describe("transcript — case 6: viewport cap", () => {
  it("renders <=200 message units and offers Load earlier messages for 201 items", () => {
    const items201 = Array.from({ length: 201 }, (_, i) => ({
      id: `u${i}`,
      kind: "user" as const,
      clientRequestId: `c${i}`,
      text: `message ${i}`,
      context: [],
    }));
    const state = reduceChatState(createInitialChatState(), {
      type: "TRANSCRIPT_PAGE_LOADED",
      items: items201,
      total: 201,
    });
    renderer.render(state);

    expect(state.transcript.paging.hasMore).toBe(true);
    expect(items().length).toBe(200);
    const load = container.querySelector<HTMLButtonElement>(`.${PREFIX}-load-earlier`);
    expect(load).not.toBeNull();
    expect(load!.textContent).toBe(LOAD_EARLIER_LABEL);
    // The oldest item is outside the viewport; the newest is present.
    expect(byKey("u0")).toBeNull();
    expect(byKey("u200")).not.toBeNull();
  });

  it("hides Load earlier when there is no more history", () => {
    const state = reduceChatState(createInitialChatState(), {
      type: "TRANSCRIPT_PAGE_LOADED",
      items: [
        { id: "u0", kind: "user", clientRequestId: "c0", text: "only", context: [] },
      ],
      total: 1,
    });
    renderer.render(state);
    expect(container.querySelector(`.${PREFIX}-load-earlier`)).toBeNull();
    expect(items().length).toBe(1);
  });

  it("calls onLoadEarlier when the control is clicked", () => {
    const onLoadEarlier = vi.fn();
    renderer.dispose();
    renderer = createTranscriptRenderer(makeRefs(), { onLoadEarlier });
    const items201 = Array.from({ length: 201 }, (_, i) => ({
      id: `u${i}`,
      kind: "user" as const,
      clientRequestId: `c${i}`,
      text: `m${i}`,
      context: [],
    }));
    renderer.render(
      reduceChatState(createInitialChatState(), {
        type: "TRANSCRIPT_PAGE_LOADED",
        items: items201,
        total: 201,
      }),
    );
    container.querySelector<HTMLButtonElement>(`.${PREFIX}-load-earlier`)!.click();
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case 7 — SQL action + callback payloads
// ---------------------------------------------------------------------------

describe("transcript — case 7: SQL action and callback payloads", () => {
  it("shows Insert SQL only for a SQL fence and returns the exact raw SQL", () => {
    const onInsertSql = vi.fn();
    renderer.dispose();
    renderer = createTranscriptRenderer(makeRefs(), { onInsertSql });
    let { state, next } = openTurn();
    state = streamText(state, next++, "no fence here");
    state = finishTurn(state, next++);
    renderer.render(state);
    flushRaf();
    let insert = byKey("m1")!.querySelector<HTMLButtonElement>('[data-action="insert-sql"]');
    expect(insert!.hidden).toBe(true);

    // Second message with a SQL fence.
    let s2 = reduceChatState(state, { type: "DRAFT_CHANGED", text: "again" });
    s2 = reduceChatState(s2, { type: "SUBMIT_REQUESTED", clientRequestId: "c2" });
    s2 = host(s2, { kind: "turn_started", turnId: "t2", clientRequestId: "c2" }, next++);
    s2 = host(
      s2,
      { kind: "text_delta", turnId: "t2", messageId: "m2", text: "```sql\nSELECT 42\n```" },
      next++,
    );
    s2 = host(s2, { kind: "turn_finished", turnId: "t2", outcome: "completed" }, next++);
    renderer.render(s2);
    flushRaf();

    insert = byKey("m2")!.querySelector<HTMLButtonElement>('[data-action="insert-sql"]');
    expect(insert!.hidden).toBe(false);
    insert!.click();
    expect(onInsertSql).toHaveBeenCalledWith("m2", "SELECT 42");
  });

  it("passes raw source (not DOM text) to copy/edit/retry/regenerate", () => {
    const onCopyUser = vi.fn();
    const onEditUser = vi.fn();
    const onRetryUser = vi.fn();
    const onRegenerateAssistant = vi.fn();
    renderer.dispose();
    renderer = createTranscriptRenderer(makeRefs(), {
      onCopyUser,
      onEditUser,
      onRetryUser,
      onRegenerateAssistant,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    let { state, next } = openTurn();
    state = streamText(state, next++, "answer text");
    state = finishTurn(state, next++);
    renderer.render(state);
    flushRaf();

    const user = byKey("user-c1")!;
    user.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();
    user.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
    user.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    expect(onCopyUser).toHaveBeenCalledWith("user-c1", "hello");
    expect(onEditUser).toHaveBeenCalledWith("user-c1", "hello");
    expect(onRetryUser).toHaveBeenCalledWith("user-c1", "hello");

    byKey("m1")!.querySelector<HTMLButtonElement>('[data-action="regenerate"]')!.click();
    expect(onRegenerateAssistant).toHaveBeenCalledWith("m1", "answer text");
  });
});

// ---------------------------------------------------------------------------
// TASK-CHATFIX-003 — Claude Code-style tool activity timeline
// (bold label + muted summary, per-step status dot joined by a connector,
// expandable IN/OUT cards, trailing live indicator). State via the real
// reducer; stylesheet text assertions pin the polish bar.
// ---------------------------------------------------------------------------

describe("transcript — TASK-CHATFIX-003 tool activity timeline", () => {
  const css = existsSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"))
    ? readFileSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"), "utf8")
    : "";

  /** Drive one tool through the real reducer and render it. */
  function runToolTurn(detail?: string, summary = "3 files changed"): HTMLElement {
    let { state, next } = openTurn();
    state = host(
      state,
      {
        kind: "tool_started",
        turnId: "t1",
        toolId: "tool1",
        label: "Bash",
        action: "run",
        ...(detail !== undefined ? { detail } : {}),
      },
      next++,
    );
    state = host(
      state,
      { kind: "tool_finished", turnId: "t1", toolId: "tool1", label: "Bash", status: "ok", summary },
      next++,
    );
    renderer.render(state);
    const tool = byKey("tool1");
    expect(tool).not.toBeNull();
    return tool!;
  }

  it("case 1 (happy): Bash step renders bold label, IN/OUT blocks and ok dot", () => {
    const tool = runToolTurn("git status");
    expect(tool.querySelector(`.${PREFIX}-tool-label`)?.textContent).toBe("Bash");
    expect(tool.querySelector('[data-tool-block="in"]')?.textContent).toBe("git status");
    expect(tool.querySelector('[data-tool-block="out"]')?.textContent).toBe("3 files changed");
    expect(tool.querySelector(`.${PREFIX}-tool-status`)?.getAttribute("data-status")).toBe("ok");

    // Polish bar is pinned by the scoped stylesheet: bold high-contrast label,
    // muted summary line, connector line between the step dots.
    const labelRule = /\.UnicDB-ai-chat-v2-tool-label\s*\{([^}]*)\}/.exec(css);
    expect(labelRule?.[1] ?? "").toContain("font-weight");
    const summaryRule = /\.UnicDB-ai-chat-v2-tool-summary\s*\{([^}]*)\}/.exec(css);
    expect(summaryRule?.[1] ?? "").toContain("var(--UnicDB-ai-chat-v2-muted)");
    expect(css).toMatch(/\.UnicDB-ai-chat-v2-item-tool::before\s*\{[^}]*border-left/);
  });

  it("case 2 (happy): live indicator appears while the turn is open, leaves on turn_finished", () => {
    let { state, next } = openTurn();
    renderer.render(state);
    expect(container.querySelectorAll(`.${PREFIX}-live`).length).toBe(1);
    renderer.render(state); // idempotent — still exactly ONE trailing node
    expect(container.querySelectorAll(`.${PREFIX}-live`).length).toBe(1);
    state = finishTurn(state, next++);
    renderer.render(state);
    expect(container.querySelector(`.${PREFIX}-live`)).toBeNull();
  });

  it("case 3 (edge): legacy frame without detail — label + dot + OUT card, no IN card, no throw", () => {
    const tool = runToolTurn(undefined, "12 rows");
    expect(tool.querySelector('[data-tool-block="in"]')).toBeNull();
    expect(tool.querySelector(`.${PREFIX}-tool-label`)?.textContent).toBe("Bash");
    expect(tool.querySelector(`.${PREFIX}-tool-status`)).not.toBeNull();
    expect(tool.querySelector('[data-tool-block="out"]')?.textContent).toBe("12 rows");
  });

  it("case 4 (edge): hostile detail/summary stays escaped text, never an <img>", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const tool = runToolTurn(hostile, hostile);
    expect(tool.innerHTML).not.toContain("<img");
    expect(tool.querySelector('[data-tool-block="in"]')?.textContent).toBe(hostile);
    expect(tool.querySelector('[data-tool-block="out"]')?.textContent).toBe(hostile);
    expect(tool.querySelector("img")).toBeNull();
  });

  it("case 5 (boundary): 2000-char output renders in full while CSS caps the OUT card", () => {
    const long = "x".repeat(2000);
    const tool = runToolTurn(undefined, long);
    expect(tool.querySelector('[data-tool-block="out"]')?.textContent).toBe(long);
    const rule = /\.UnicDB-ai-chat-v2-tool-io-text\[data-tool-block="out"\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]!).toContain("max-height");
    expect(rule![1]!).toContain("overflow-y: auto");
  });

  it("case 6 (regression): running status gains a namespaced pulse rule", () => {
    const rule = /\.UnicDB-ai-chat-v2-tool-status\[data-status="running"\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]!).toMatch(/animation:[^;]*UnicDB-ai-chat-v2-[\w-]+/);
    expect(css).toMatch(/@keyframes UnicDB-ai-chat-v2-[\w-]+\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// TASK-CHATUX-003 — collapsed disclosure rows (SPEC FR-006 / §8.4): tool and
// reasoning items mount collapsed (data-collapsed="1", aria-expanded="false")
// and expand on toggle click.
// ---------------------------------------------------------------------------

describe("transcript — TASK-CHATUX-003 collapsed disclosure rows", () => {
  it("tool items start collapsed and expand on toggle click", () => {
    let { state, next } = openTurn();
    state = host(
      state,
      {
        kind: "tool_started",
        turnId: "t1",
        toolId: "tool1",
        label: "Bash",
        action: "run",
        detail: "git status",
      },
      next++,
    );
    state = host(
      state,
      { kind: "tool_finished", turnId: "t1", toolId: "tool1", label: "Bash", status: "ok", summary: "done" },
      next++,
    );
    renderer.render(state);

    const tool = byKey("tool1");
    expect(tool).not.toBeNull();
    expect(tool!.getAttribute("data-collapsed")).toBe("1");
    const toggle = tool!.querySelector<HTMLButtonElement>(`.${PREFIX}-tool-toggle`);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");

    toggle!.click();
    expect(tool!.getAttribute("data-collapsed")).toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  });

  it("reasoning items start collapsed behind a -reasoning-toggle disclosure", () => {
    let { state, next } = openTurn();
    state = host(
      state,
      { kind: "reasoning_delta", turnId: "t1", messageId: "m1", text: "thinking…" },
      next++,
    );
    renderer.render(state);
    flushRaf(); // streaming deltas paint on the next frame
    const item = byKey("reasoning-m1");
    expect(item, "expected the reasoning item").not.toBeNull();
    expect(item!.getAttribute("data-collapsed")).toBe("1");
    const toggle = item!.querySelector<HTMLButtonElement>(`.${PREFIX}-reasoning-toggle`);
    expect(toggle, "expected the -reasoning-toggle disclosure button").not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(item!.querySelector(`.${PREFIX}-reasoning-body`)?.textContent).toContain("thinking…");

    toggle!.click();
    expect(item!.getAttribute("data-collapsed")).toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Visual contract is pinned in the scoped stylesheet (jsdom cannot prove
// geometry; these assertions guard against the rules silently disappearing).
// ---------------------------------------------------------------------------

describe("transcript — scoped CSS keeps the PLAN §6 geometry", () => {
  const css = existsSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"))
    ? readFileSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"), "utf8")
    : "";

  it("user bubble: 70% max-width, 6x10px padding, asymmetric radius", () => {
    expect(css).not.toBe("");
    const rule = /\.UnicDB-ai-chat-v2-item-user\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule![1]!;
    expect(body).toContain("max-width: 70%");
    expect(body).toContain("padding: 6px 10px");
    expect(body).toContain("border-radius: 12px 12px 4px 12px");
  });

  it("assistant answer: unboxed 92% max-width, no fixed width, 4px 0", () => {
    const rule = /\.UnicDB-ai-chat-v2-item-text,\s*\.UnicDB-ai-chat-v2-item-reasoning\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule![1]!;
    expect(body).toContain("max-width: 92%");
    expect(body).not.toMatch(/(^|;)\s*width\s*:/);
    expect(body).not.toMatch(/(^|;)\s*max-inline-size\s*:/);
    expect(body).toContain("padding: 4px 0");
  });

  it("action buttons are 28x28 and visible at rest (no opacity gate)", () => {
    const rule = /\.UnicDB-ai-chat-v2-action\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]!).toContain("width: 28px");
    expect(rule![1]!).toContain("height: 28px");
    expect(rule![1]!).not.toContain("opacity: 0");
    // TASK-CHATUX-003: the hover/focus-within reveal rule is gone — actions
    // stay visible (muted) at rest.
    expect(css).not.toMatch(/\.UnicDB-ai-chat-v2-item:hover\s+\.UnicDB-ai-chat-v2-action/);
    expect(css).not.toMatch(/\.UnicDB-ai-chat-v2-item:focus-within\s+\.UnicDB-ai-chat-v2-action/);
  });
});
