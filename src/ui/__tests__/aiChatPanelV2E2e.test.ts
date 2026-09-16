// src/ui/__tests__/aiChatPanelV2E2e.test.ts — TASK-CHATV2-017
//
// PRODUCTION-BUNDLE end-to-end suite. Loads dist/aiChatPanel.js (built by
// `npm run compile`) into jsdom, stubs acquireVsCodeApi, boots the real V2
// chat UI and drives it through the behaviour families the task names:
// boot · keyboard · send/stop · streaming transcript · tool timeline ·
// permission · security/CSP/privacy · lifecycle remount.
//
// It asserts against the PRODUCTION bundle — not the modules directly — so a
// regression in the boot seam, the controller wiring or the host contract is
// caught here. No browser storage, no base64 payloads, no raw secrets.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const distPath = resolve(process.cwd(), "dist", "aiChatPanel.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface BundleHandle {
  received: Array<Record<string, unknown>>;
}

/** Message listeners registered by every bundle eval — torn down on reload so a
 * prior eval never handles a later frame. */
const bundleListeners: Array<{
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}> = [];

const _origAdd = window.addEventListener.bind(window);
window.addEventListener = function (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  const evtListener =
    typeof listener === "function"
      ? (listener as EventListener)
      : (listener as EventListenerObject).handleEvent.bind(listener);
  bundleListeners.push({ type, listener: evtListener, options });
  return _origAdd(type, listener, options);
} as typeof window.addEventListener;

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error("dist/aiChatPanel.js missing — run `npm run compile` before this test");
  }
  for (const { type, listener, options } of bundleListeners) {
    window.removeEventListener(type, listener, options);
  }
  bundleListeners.length = 0;
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-form-body"></div>';

  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = { postMessage: (msg) => received.push(msg as Record<string, unknown>) };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi = () => api;
  (0, eval)(bundleSrc);
  return { received };
}

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

/** Let the controller's queued microtask render run before asserting. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Wait past the transcript's coalesced stream-paint fallback (100ms). */
async function flushStreamPaint(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130));
  await flush();
}

const root = (): HTMLElement => document.getElementById("UnicDB-root") as HTMLElement;
const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/**
 * Boot the bundle, hydrate a session and open a live turn. Returns the received
 * post array plus the clientRequestId the open turn acknowledges.
 */
async function bootWithOpenTurn(): Promise<{ received: Array<Record<string, unknown>>; turnId: string }> {
  const h = loadBundle();
  const prompt = byId<HTMLTextAreaElement>("promptV2")!;
  prompt.value = "hello";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  dispatch({ kind: "session_hydrated", protocolVersion: 2, sessionId: "s1", sequence: 1, hasHistory: false, visionCapable: false });
  await flush();
  byId<HTMLButtonElement>("primaryTurnBtn")!.click();
  const ack = h.received.find((m) => m.kind === "submit_turn")!;
  dispatch({
    kind: "turn_started",
    protocolVersion: 2,
    sessionId: "s1",
    sequence: 2,
    turnId: "t1",
    clientRequestId: ack.clientRequestId,
  });
  await flush();
  return { received: h.received, turnId: "t1" };
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("chat V2 production bundle — TASK-CHATV2-017", () => {
  beforeEach(() => {
    window.localStorage?.clear?.();
    window.sessionStorage?.clear?.();
  });

  itIfBundle("#1 V2 boot: one shell, one V2 composer, posts ready_v2 exactly once", () => {
    const { received } = loadBundle();
    const r = root();
    // The V2 root class is authoritative.
    expect(r.classList.contains("UnicDB-ai-chat-v2")).toBe(true);
    expect(r.getAttribute("data-chat-v2-shell")).toBe("1");
    expect(byId("composerV2")).not.toBeNull();
    expect(byId("promptV2")).not.toBeNull();
    expect(byId("primaryTurnBtn")).not.toBeNull();
    // TASK-CHATV2-017 Lane 3: the V1 composer/header are DELETED — none of the
    // legacy ids may exist anywhere in the production DOM.
    for (const legacyId of [
      "composer",
      "prompt",
      "sendBtn",
      "stopBtn",
      "engineBanner",
      "chatBrandMark",
      "sessionChip",
      "attachStrip",
    ]) {
      expect(byId(legacyId), `V1 remnant #${legacyId} must be absent`).toBeNull();
    }
    // Exactly one ready_v2, and no legacy ready.
    expect(received.filter((m) => m.kind === "ready_v2").length).toBe(1);
    expect(received.some((m) => m.type === "ready")).toBe(false);
    // Exactly one window message listener (the controller).
    expect(bundleListeners.filter((l) => l.type === "message").length).toBe(1);
  });

  itIfBundle("#2 typed send on the V2 prompt posts one submit_turn with the draft", async () => {
    const { received } = loadBundle();
    const prompt = byId<HTMLTextAreaElement>("promptV2")!;
    prompt.value = "show me users";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    byId<HTMLButtonElement>("primaryTurnBtn")!.click();
    const submits = received.filter((m) => m.kind === "submit_turn");
    expect(submits.length).toBe(1);
    expect((submits[0].draft as { text: string }).text).toBe("show me users");
    expect(submits[0].protocolVersion).toBe(2);
  });

  itIfBundle("#3 empty draft → the primary slot posts no submit_turn", async () => {
    const { received } = loadBundle();
    byId<HTMLButtonElement>("primaryTurnBtn")!.click();
    await flush();
    expect(received.some((m) => m.kind === "submit_turn")).toBe(false);
  });

  itIfBundle("#4 Enter sends, Shift+Enter inserts a newline (single keyboard owner)", async () => {
    const { received } = loadBundle();
    const prompt = byId<HTMLTextAreaElement>("promptV2")!;
    prompt.value = "hello";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(received.filter((m) => m.kind === "submit_turn").length).toBe(1);
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    await flush();
    // Shift+Enter is a newline, never a second submit.
    expect(received.filter((m) => m.kind === "submit_turn").length).toBe(1);
  });

  itIfBundle("#5 streaming frames paint the keyed V2 transcript", async () => {
    await bootWithOpenTurn();
    dispatch({ kind: "text_delta", protocolVersion: 2, sessionId: "s1", sequence: 3, turnId: "t1", messageId: "m1", text: "**hi** there" });
    await flushStreamPaint();
    const transcript = root().querySelector(".UnicDB-ai-chat-v2-transcript")!;
    expect(transcript.querySelectorAll("[data-chat-key]").length).toBeGreaterThanOrEqual(1);
    expect(transcript.textContent).toContain("hi");
  });

  itIfBundle("#6 tool timeline renders from V2 tool frames", async () => {
    await bootWithOpenTurn();
    dispatch({ kind: "tool_started", protocolVersion: 2, sessionId: "s1", sequence: 3, turnId: "t1", toolId: "tool-1", label: "list_tables", action: "tool" });
    dispatch({ kind: "tool_finished", protocolVersion: 2, sessionId: "s1", sequence: 4, turnId: "t1", toolId: "tool-1", label: "list_tables", status: "ok", summary: "3 tables" });
    await flush();
    expect(root().querySelector("[data-chat-key]")).not.toBeNull();
  });

  itIfBundle("#7 pending permission on an open turn is surfaced without an unsolicited response", async () => {
    const { received } = await bootWithOpenTurn();
    const before = received.filter((m) => m.kind === "permission_response").length;
    dispatch({
      kind: "permission_requested",
      protocolVersion: 2,
      sessionId: "s1",
      sequence: 3,
      turnId: "t1",
      requestId: "pr-1",
      tool: { id: "tool-1", name: "workspace_write", detail: "write a file" },
      options: [{ optionId: "allow", label: "Allow" }, { optionId: "deny", label: "Deny" }],
    });
    await flush();
    // Opening a host request never auto-answers it.
    expect(received.filter((m) => m.kind === "permission_response").length).toBe(before);
    // The request is surfaced to the user.
    expect(root().textContent).toMatch(/permission/i);
  });

  itIfBundle("#8 no apiKey, base64 data-URL or browser-storage payload ever rides the wire", async () => {
    const { received } = loadBundle();
    const prompt = byId<HTMLTextAreaElement>("promptV2")!;
    prompt.value = "secret";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    byId<HTMLButtonElement>("primaryTurnBtn")!.click();
    await flush();
    const all = JSON.stringify(received);
    expect(all).not.toMatch(/sk-/i);
    expect(all).not.toMatch(/api_?key/i);
    expect(all).not.toMatch(/data:image\//i);
  });

  itIfBundle("#9 the bundle references no browser-storage or legacy V1 composer selector", () => {
    expect(bundleSrc!).not.toMatch(/localStorage/);
    expect(bundleSrc!).not.toMatch(/sessionStorage/);
    expect(bundleSrc!).not.toMatch(/indexedDB/i);
    // TASK-CHATV2-017 Lane 3: the V1 archive marker written by the deleted
    // archiveV1Composer() must be gone from the production bundle.
    expect(bundleSrc!).not.toMatch(/data-chat-v1-archived/);
    // The V1 composer/header modules are deleted: their names must not appear.
    expect(bundleSrc!).not.toMatch(/aiChatPanelComposer/);
    expect(bundleSrc!).not.toMatch(/aiChatPanelHeader/);
  });

  itIfBundle("#10 remounting the bundle leaves exactly one handler per interaction", () => {
    loadBundle();
    loadBundle();
    // Every prior eval's listeners were removed before the second eval; the
    // single-message-listener invariant survives remount.
    expect(bundleListeners.filter((l) => l.type === "message").length).toBe(1);
    expect(root().getAttribute("data-chat-v2-shell")).toBe("1");
    expect(document.querySelectorAll("#composerV2").length).toBe(1);
    expect(document.querySelectorAll("#promptV2").length).toBe(1);
  });

  // ------------------------------------------------------------------------
  // REVIEW-CHATV2-R1 fix round 1 — the dual-wire hole. Production speaks
  // BOTH frame families; each logical event must render EXACTLY ONCE even
  // when the legacy twin and its V2 seam frame arrive together.
  // ------------------------------------------------------------------------

  /** Count how many times `needle` occurs in the rendered root text. */
  function occurrences(needle: string): number {
    return root().textContent.split(needle).length - 1;
  }

  let dualSeq = 2;
  function dualEnvelope(): Record<string, unknown> {
    dualSeq += 1;
    return { protocolVersion: 2, sessionId: "s1", sequence: dualSeq };
  }

  itIfBundle("#R1 dual-wire text: legacy delta twin adds NOTHING to the V2 render", async () => {
    await bootWithOpenTurn();
    dualSeq = 2;
    dispatch({ ...dualEnvelope(), kind: "text_delta", turnId: "t1", messageId: "m1", text: "DUPMARKERXYZ" });
    await flushStreamPaint();
    const v2Baseline = occurrences("DUPMARKERXYZ");
    expect(v2Baseline).toBe(1);
    dispatch({ type: "delta", text: "DUPMARKERXYZ" } as Record<string, unknown>);
    await flushStreamPaint();
    expect(occurrences("DUPMARKERXYZ")).toBe(v2Baseline);
  });

  itIfBundle("#R1 dual-wire final: legacy assistant twin adds NOTHING; the V2 seal closes the turn", async () => {
    await bootWithOpenTurn();
    dualSeq = 2;
    dispatch({ ...dualEnvelope(), kind: "text_delta", turnId: "t1", messageId: "m1", text: "STREAMBODYMARKER" });
    await flushStreamPaint();
    const v2Baseline = occurrences("STREAMBODYMARKER");
    expect(v2Baseline).toBe(1);
    // The legacy final-assistant twin (never sent by the V2-authoritative
    // host) must not paint a second copy of the turn's text.
    dispatch({ type: "assistant", text: "STREAMBODYMARKER FINALMARKERXYZ", markdown: true } as Record<string, unknown>);
    dispatch({ ...dualEnvelope(), kind: "turn_finished", turnId: "t1", outcome: "completed" });
    await flushStreamPaint();
    expect(occurrences("STREAMBODYMARKER")).toBe(v2Baseline);
    expect(occurrences("FINALMARKERXYZ")).toBe(0);
  });

  itIfBundle("#R1 dual-wire tools: legacy step/tool_result twins add NOTHING to the V2 timeline", async () => {
    await bootWithOpenTurn();
    dualSeq = 2;
    dispatch({ ...dualEnvelope(), kind: "tool_started", turnId: "t1", toolId: "tool-1", label: "TOOLMARKERXYZ", action: "tool" });
    dispatch({
      ...dualEnvelope(),
      kind: "tool_finished",
      turnId: "t1",
      toolId: "tool-1",
      label: "TOOLMARKERXYZ",
      status: "ok",
      summary: "did a thing",
    });
    await flushStreamPaint();
    // V2 baseline: the tool paints once per V2 surface (keyed transcript row
    // + activity timeline row — the store keeps ONE entity per toolId).
    const v2Baseline = occurrences("TOOLMARKERXYZ");
    expect(v2Baseline).toBeGreaterThanOrEqual(1);
    dispatch({ type: "step", label: "TOOLMARKERXYZ" } as Record<string, unknown>);
    dispatch({
      type: "tool_result",
      tool: "TOOLMARKERXYZ",
      status: "ok",
      summary: "did a thing",
    } as Record<string, unknown>);
    await flushStreamPaint();
    expect(occurrences("TOOLMARKERXYZ")).toBe(v2Baseline);
  });

  itIfBundle("#R1 dual-wire attach_error: exactly ONE visible notice (legacy bridge is its live renderer)", async () => {
    await bootWithOpenTurn();
    dualSeq = 2;
    // The V2 attach_error frame is store-only (no live V2 renderer yet) —
    // it must not change the visible output.
    dispatch({ ...dualEnvelope(), kind: "attach_error", id: "att-1", reason: "type", message: "ATTACHMARKERXYZ" });
    await flushStreamPaint();
    expect(occurrences("ATTACHMARKERXYZ")).toBe(0);
    dispatch({
      type: "attach_error",
      id: "att-1",
      reason: "type",
      message: "ATTACHMARKERXYZ",
    } as Record<string, unknown>);
    await flushStreamPaint();
    expect(occurrences("ATTACHMARKERXYZ")).toBe(1);
  });

  itIfBundle("#R1 model chip populates from the V2 models frame, never the legacy twin", async () => {
    const { received } = loadBundle();
    void received;
    // The legacy `models` frame is NOT a V2-seam surface: it must not
    // populate the chip (the host mirrors models on the V2 ready seam).
    dispatch({ type: "models", active: "work", roles: [{ role: "work", modelId: "unic-sonnet", vision: true }] } as Record<string, unknown>);
    await flush();
    expect(byId("modelChipBtnV2")!.textContent).toContain("No model");
    dispatch({
      kind: "models",
      protocolVersion: 2,
      sessionId: "boot",
      sequence: 1,
      active: "work",
      roles: [{ role: "work", modelId: "unic-sonnet", vision: true }],
    });
    await flush();
    expect(byId("modelChipBtnV2")!.textContent).toContain("unic-sonnet");
    expect(byId("modelChipBtnV2")!.getAttribute("aria-label")).toContain("unic-sonnet");
  });

  itIfBundle("#R1 dual-wire permission: ONE surface, one response, composer never wedges", async () => {
    const { received } = await bootWithOpenTurn();
    dualSeq = 2;
    const legacyCard = {
      type: "permission_request",
      requestId: "pr-dual",
      tool: { id: "tool-1", name: "workspace_write", detail: "write a file" },
      options: [{ optionId: "allow-once", label: "Allow once" }, { optionId: "deny", label: "Deny" }],
    } as Record<string, unknown>;
    const v2Sheet = {
      ...dualEnvelope(),
      kind: "permission_requested" as const,
      turnId: "t1",
      requestId: "pr-dual",
      tool: { id: "tool-1", name: "workspace_write", detail: "write a file" },
      options: [{ optionId: "allow-once", label: "Allow once" }, { optionId: "deny", label: "Deny" }],
    };
    dispatch(legacyCard);
    dispatch(v2Sheet);
    await flush();
    // Exactly ONE live surface: the V2 anchored sheet. The legacy in-thread
    // card must never mount alongside it.
    expect(document.querySelectorAll(".UnicDB-chat-permission").length).toBe(0);
    expect(document.querySelectorAll("[data-chat-permission-request]").length).toBe(1);
    // Allow is reachable and answers EXACTLY once.
    const allow = document.querySelector<HTMLButtonElement>('[data-chat-permission-request] [data-action="allow-once"]');
    expect(allow).not.toBeNull();
    expect(allow!.disabled).toBe(false);
    allow!.click();
    await flush();
    const responses = received.filter((m) => m.kind === "permission_response");
    expect(responses.length).toBe(1);
    expect((responses[0] as { optionId?: string }).optionId).toBe("allow-once");
    // Settling the sheet must never leave the composer keyboard wedged.
    dispatch({ ...dualEnvelope(), kind: "turn_finished", turnId: "t1", outcome: "completed" });
    await flush();
    const before = received.filter((m) => m.kind === "submit_turn").length;
    const prompt = byId<HTMLTextAreaElement>("promptV2")!;
    prompt.value = "next turn";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(received.filter((m) => m.kind === "submit_turn").length).toBe(before + 1);
  });

  // ------------------------------------------------------------------------
  // TASK-AG-001 (restored) — icon-only composer controls: one inline SVG,
  // synced tooltip + accessible name, pointer-events CSS guard. Re-pinned on
  // the V2 composer after the V1 archive (the deleted bundle suite's sweep).
  // ------------------------------------------------------------------------

  /** The V2 icon-only controls, in composer DOM order. */
  const V2_ICON_BUTTON_IDS = ["attachContextBtn", "slashCommandBtn", "primaryTurnBtn"] as const;

  itIfBundle("#AG1 each V2 icon-only control renders exactly one inline SVG icon", () => {
    loadBundle();
    for (const id of V2_ICON_BUTTON_IDS) {
      const b = byId(id);
      expect(b, `#${id} must exist in the V2 composer`).not.toBeNull();
      const svgs = b!.querySelectorAll("svg");
      expect(svgs.length, `#${id} must contain exactly one <svg>`).toBe(1);
      expect(svgs[0]!.getAttribute("aria-hidden"), `#${id} svg must be aria-hidden`).toBe("true");
    }
  });

  itIfBundle("#AG2 each V2 icon-only control is icon-only (no visible text label)", () => {
    loadBundle();
    for (const id of V2_ICON_BUTTON_IDS) {
      const b = byId(id)!;
      expect((b.textContent ?? "").trim(), `#${id} must be icon-only`).toBe("");
    }
  });

  itIfBundle("#AG3 every V2 icon-only control has a non-empty title synced with aria-label", () => {
    loadBundle();
    for (const id of V2_ICON_BUTTON_IDS) {
      const b = byId(id)!;
      const title = b.getAttribute("title") ?? "";
      const aria = b.getAttribute("aria-label") ?? "";
      expect(title, `#${id} must carry a hover tooltip`).not.toBe("");
      expect(aria, `#${id} must carry an accessible name`).not.toBe("");
      expect(title === aria, `#${id} title and aria-label must match`).toBe(true);
    }
  });

  itIfBundle("#AG9 V2 svg sizing rules keep the pointer-events guard in styles.css", () => {
    const cssPath = resolve(process.cwd(), "webview", "aiChat", "styles.css");
    const css = readFileSync(cssPath, "utf8");
    for (const rule of [
      ".UnicDB-ai-chat-v2-control svg",
      ".UnicDB-ai-chat-v2-primary svg",
    ]) {
      expect(
        new RegExp(`${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*pointer-events:\\s*none`).test(css),
        `${rule} must keep pointer-events: none`,
      ).toBe(true);
    }
  });
});
