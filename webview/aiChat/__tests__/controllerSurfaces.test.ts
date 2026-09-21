// webview/aiChat/__tests__/controllerSurfaces.test.ts — TASK-CHATV2-017 (M2b/M2d)
//
// The controller is the SINGLE V2 owner. This suite proves the keyed transcript
// renderer, the scroll viewport controller and the coalescing live announcer are
// wired into it exactly once, render from reducer state, and are torn down by
// `dispose()` — the V2-only boot the cutover requires.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatController, type ChatController, type VsCodeApiLike } from "../controller";
import { AI_CHAT_PROTOCOL_VERSION_V2 } from "../../../src/ui/aiChatPanelMessages";
import { CHAT_V2_STATUS_LIVE_ID, CHAT_V2_ALERT_LIVE_ID } from "../shell";
import { SCROLL_PILL_MARKER } from "../scroll";
import { ERROR_CARD_MARKER } from "../errors";
import { SESSIONS_IDS } from "../sessions";
import { ATTACH_MENU_MARKER } from "../attachMenu";
import { ATTACHMENT_INPUT_MARKER, ATTACHMENT_STRIP_MARKER } from "../attachments";
import { AUTOCOMPLETE_LISTBOX_MARKER } from "../autocomplete";
import { SCHEMA_CHIP_MARKER } from "../schemaControl";
import {
  CONTEXT_CHIP_MARKER,
  CONTEXT_CHIP_PREVIEW_MARKER,
  CONTEXT_CHIP_REMOVE_MARKER,
} from "../contextChips";
import { OVERLAY_MENU_MARKER } from "../overlays";
import {
  ENGINE_SWITCH_CONFIRM_CANCEL_LABEL,
  ENGINE_SWITCH_CONFIRM_STOP_LABEL,
  ENGINE_SWITCH_CONFIRM_TITLE,
  type EngineMenuEntry,
} from "../engineModelMenus";

let controllers: ChatController[] = [];

interface Harness {
  controller: ChatController;
  root: HTMLElement;
  sent: unknown[];
  send(frame: Record<string, unknown>): void;
}

function makeHarness(opts: { engineEntries?: readonly EngineMenuEntry[] } = {}): Harness {
  const root = document.createElement("div");
  root.id = "UnicDB-root";
  document.body.appendChild(root);
  const sent: unknown[] = [];
  const api: VsCodeApiLike = { postMessage: (message) => sent.push(message) };
  const controller = createChatController({
    root,
    vscode: api,
    nextId: (() => {
      let n = 0;
      return () => `req-${++n}`;
    })(),
    schedule: (fn) => fn(),
    ...(opts.engineEntries === undefined ? {} : { engineEntries: opts.engineEntries }),
  });
  controllers.push(controller);
  return {
    controller,
    root,
    sent,
    send: (frame) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, ...frame },
        }),
      ),
  };
}

afterEach(() => {
  for (const c of controllers) {
    try {
      c.dispose();
    } catch {
      /* already disposed */
    }
  }
  controllers = [];
  document.body.innerHTML = "";
  window.localStorage?.clear?.();
  window.sessionStorage?.clear?.();
});

/** Host-provided catalog (DATA) for the engine menu — never name-derived. */
const ENGINE_ENTRIES: readonly EngineMenuEntry[] = [
  { engine: "builtin", displayName: "Built-in", status: "ready", resolution: "" },
  { engine: "codex", displayName: "Codex", status: "ready", resolution: "" },
];

/** Capability snapshot matching test #7's exact `supports` shape. */
function capsSnapshot(engine: "builtin" | "codex", displayName: string): Record<string, unknown> {
  return {
    engine,
    displayName,
    status: "ready",
    supports: {
      streamText: true,
      streamThought: false,
      toolTimeline: true,
      imageInput: false,
      nativeSessionResume: false,
      savedTranscriptResume: false,
      engineCommands: false,
      permissions: false,
      bypassPermissions: false,
      modelRoles: false,
      workspaceMentions: true,
      dbMentions: true,
      exportTranscript: false,
    },
    commands: [],
    modelRoles: [],
  };
}

function sentCount(h: Harness, kind: string): number {
  return h.sent.filter((intent) => (intent as { kind?: string }).kind === kind).length;
}

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  expect(match, `expected a button labelled "${text}"`).toBeDefined();
  return match!;
}

function findRowByText(menu: ParentNode, text: string): HTMLElement {
  const match = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]')).find((row) =>
    row.textContent?.includes(text),
  );
  expect(match, `expected an option row containing "${text}"`).toBeDefined();
  return match!;
}

describe("controller V2 surfaces — TASK-CHATV2-017", () => {
  it("#1 boots exactly ONE scroll pill and the shell's two live regions", () => {
    const h = makeHarness();
    const pills = h.root.querySelectorAll(`[${SCROLL_PILL_MARKER}]`);
    expect(pills.length).toBe(1);
    // Exactly one polite + one assertive LIVE REGION (the shell's stable ids) —
    // the composer hint's own aria-live is a separate, non-region surface.
    expect(h.root.querySelectorAll(`#${CHAT_V2_STATUS_LIVE_ID}`).length).toBe(1);
    expect(h.root.querySelectorAll(`#${CHAT_V2_ALERT_LIVE_ID}`).length).toBe(1);
    expect(h.root.querySelectorAll(".UnicDB-ai-chat-v2-live-region[aria-live='polite']").length).toBe(1);
    expect(h.root.querySelectorAll(".UnicDB-ai-chat-v2-live-region[aria-live='assertive']").length).toBe(1);
  });

  it("#2 paints the keyed transcript from reducer state (one node per item)", () => {
    const h = makeHarness();
    h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: false, visionCapable: false });
    // Submit so the controller opens a turn we can stream into.
    const prompt = h.controller.prompt;
    prompt.value = "hello";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    h.controller.requestSubmit();
    h.send({ kind: "turn_started", sessionId: "s1", sequence: 2, turnId: "t1", clientRequestId: "req-2" });
    h.send({ kind: "text_delta", sessionId: "s1", sequence: 3, turnId: "t1", messageId: "m1", text: "hi" });
    h.controller.flushRender();

    const transcript = h.root.querySelector(".UnicDB-ai-chat-v2-transcript") as HTMLElement;
    expect(transcript).not.toBeNull();
    const keyed = transcript.querySelectorAll("[data-chat-key]");
    // The user bubble + the assistant text node — keyed, not appended blindly.
    expect(keyed.length).toBeGreaterThanOrEqual(1);
  });

  it("#3 announces a phase change into the polite live region (coalesced)", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: false, visionCapable: false });
      const prompt = h.controller.prompt;
      prompt.value = "hello";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      h.controller.requestSubmit();
      h.send({ kind: "turn_started", sessionId: "s1", sequence: 2, turnId: "t1", clientRequestId: "req-2" });
      h.send({ kind: "phase", sessionId: "s1", sequence: 3, turnId: "t1", phase: "streaming" });
      h.controller.flushRender();
      // CHATUX2-004: the announcer is now the ONLY writer of the polite region —
      // its 100ms coalesce window must elapse before the copy lands.
      vi.advanceTimersByTime(150);
      const polite = h.root.querySelector(`#${CHAT_V2_STATUS_LIVE_ID}`) as HTMLElement;
      expect(polite.textContent?.length ?? 0).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#4 mounts a change plan from its V2 frame, posts one approve intent, and tears it down", () => {
    const h = makeHarness();
    h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: false, visionCapable: false });
    h.send({
      kind: "change_plan",
      sessionId: "s1",
      sequence: 2,
      tool: "plan_change",
      plan: {
        intent: "Add an index",
        statements: [{ sql: "CREATE INDEX idx_users_email ON users(email)", tier: "ddl", dangerNote: "Schema change" }],
        drift: [],
        drifted: false,
      },
    });
    h.controller.flushRender();

    const card = h.root.querySelector<HTMLElement>("[data-chat-change-plan]");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Add an index");
    card!.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
    expect(h.sent).toContainEqual({
      kind: "plan_approve",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: "req-1",
    });

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelector("[data-chat-change-plan]")).toBeNull();
  });

  it("#5 mounts a safe failed-turn error card, retries once, focuses change-engine, and tears down", () => {
    const h = makeHarness();
    h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: false, visionCapable: false });
    h.controller.prompt.value = "retry this";
    h.controller.prompt.dispatchEvent(new Event("input", { bubbles: true }));
    h.controller.requestSubmit();
    h.send({ kind: "turn_started", sessionId: "s1", sequence: 2, turnId: "t1", clientRequestId: "req-1" });
    h.send({
      kind: "error",
      sessionId: "s1",
      sequence: 3,
      turnId: "t1",
      category: "provider_crash",
      safeMessage: "The engine stopped unexpectedly while answering.",
      diagnosticId: "diag-safe",
    });
    h.controller.flushRender();

    const card = h.root.querySelector<HTMLElement>(`[${ERROR_CARD_MARKER}]`);
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("diag-safe");
    card!.querySelector<HTMLButtonElement>('[data-action="change-engine"]')!.click();
    expect(document.activeElement).toBe(h.root.querySelector("#UnicDB-ai-chat-v2-engine"));
    card!.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    expect(h.sent).toContainEqual({
      kind: "submit_turn",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: "req-2",
      draft: expect.objectContaining({ text: "retry this" }),
    });

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelector(`[${ERROR_CARD_MARKER}]`)).toBeNull();
  });

  it("#6 mounts sessions once: resume, export, clear, new-chat and dispose use typed V2 intents", () => {
    const h = makeHarness();
    h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: true, visionCapable: false });
    h.send({
      kind: "sessions",
      sessionId: "s1",
      sequence: 2,
      items: [{ sessionId: "saved-1", label: "Saved chat", detail: "2 messages" }],
    });
    h.controller.flushRender();

    (h.controller as ChatController & { openResumePicker(): void }).openResumePicker();
    expect(h.root.querySelector(".UnicDB-ai-chat-v2-dialog-resume")?.textContent).toContain("Resume saved UnicDB chat");
    expect(h.sent).toContainEqual({ kind: "list_sessions", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });
    h.root.querySelector<HTMLButtonElement>(".UnicDB-ai-chat-v2-resume-row")!.click();
    expect(h.sent).toContainEqual(expect.objectContaining({ kind: "resume_saved_session", sessionId: "saved-1" }));

    const overflow = h.root.querySelector<HTMLButtonElement>(`#${SESSIONS_IDS.overflowButton}`)!;
    overflow.click();
    h.root.querySelector<HTMLButtonElement>('[data-action="export"]')!.click();
    h.root.querySelector<HTMLButtonElement>('[data-primary="true"]')!.click();
    expect(h.sent).toContainEqual(expect.objectContaining({ kind: "export_session", format: "json" }));

    overflow.click();
    h.root.querySelector<HTMLButtonElement>('[data-action="clear"]')!.click();
    h.root.querySelector<HTMLButtonElement>('[data-primary="true"]')!.click();
    expect(h.sent).toContainEqual(expect.objectContaining({ kind: "clear_session" }));

    overflow.click();
    h.root.querySelector<HTMLButtonElement>('[data-action="new"]')!.click();
    h.root.querySelector<HTMLButtonElement>('[data-primary="true"]')!.click();
    expect(h.sent).toContainEqual(expect.objectContaining({ kind: "create_session" }));

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelector(".UnicDB-ai-chat-v2-dialog-layer")).toBeNull();
  });

  it("#7 mounts the V2 attach menu from the composer trigger, gates Image… on host capability, and disposes it", () => {
    const h = makeHarness();
    h.send({
      kind: "capabilities",
      sessionId: "s1",
      sequence: 1,
      capabilities: {
        engine: "builtin",
        displayName: "Built-in",
        status: "ready",
        supports: {
          streamText: true,
          streamThought: false,
          toolTimeline: true,
          imageInput: true,
          nativeSessionResume: false,
          savedTranscriptResume: false,
          engineCommands: false,
          permissions: false,
          bypassPermissions: false,
          modelRoles: false,
          workspaceMentions: true,
          dbMentions: true,
          exportTranscript: false,
        },
        commands: [],
        modelRoles: [],
      },
    });
    h.controller.composer.attachButton.click();

    const menu = h.root.querySelector<HTMLElement>(`[${ATTACH_MENU_MARKER}]`);
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Image…");
    expect(h.root.querySelector(`[${ATTACHMENT_INPUT_MARKER}]`)).not.toBeNull();
    expect(h.root.querySelector(`[${ATTACHMENT_STRIP_MARKER}]`)).not.toBeNull();

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelector(`[${ATTACH_MENU_MARKER}]`)).toBeNull();
    expect(h.root.querySelector(`[${ATTACHMENT_INPUT_MARKER}]`)).toBeNull();
    expect(h.root.querySelector(`[${ATTACHMENT_STRIP_MARKER}]`)).toBeNull();
  });

  it("#8 mounts slash and mention listboxes from V2 state, accepts through the one keydown owner, and tears down", () => {
    const h = makeHarness();
    h.controller.composer.slashButton.click();
    const slashBox = h.root.querySelector<HTMLElement>(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`);
    expect(slashBox).not.toBeNull();
    expect(slashBox!.textContent).toContain("/new");
    h.controller.prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(h.controller.prompt.value).toContain("/new");
    expect(h.sent.filter((intent) => (intent as { kind?: string }).kind === "submit_turn")).toHaveLength(0);

    h.controller.prompt.value = "@us";
    h.controller.prompt.setSelectionRange(3, 3);
    h.controller.prompt.dispatchEvent(new Event("input", { bubbles: true }));
    const search = h.sent.find((intent) => (intent as { kind?: string }).kind === "search_context") as {
      requestId: string;
      draftRevision: number;
    };
    h.send({
      kind: "mention_results",
      sessionId: "s1",
      sequence: 1,
      requestId: search.requestId,
      draftRevision: search.draftRevision,
      query: "us",
      items: [{
        kind: "table",
        label: "users",
        detail: "public.users",
        token: "public.users",
        ref: {
          id: "table:main.public.users",
          kind: "table",
          label: "users",
          detail: "main.public.users",
          displayToken: "@public.users",
          source: "main.public.users",
          status: "ready",
          revision: "r1",
        },
      }],
    });
    h.controller.flushRender();
    expect(h.root.querySelector(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`)?.textContent).toContain("@public.users");
    h.controller.prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(h.controller.prompt.value).toContain("@public.users");
    expect(h.controller.getState().draft.context).toHaveLength(1);

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelector(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`)).toBeNull();
  });

  it("#9 mounts schema and context strip state, sends typed V2 picker/preview/remove intents, and tears down", () => {
    const h = makeHarness();
    h.send({
      kind: "schema",
      sessionId: "s1",
      sequence: 1,
      schema: "public",
      connectionId: "main",
    });
    h.controller.prompt.value = "@us";
    h.controller.prompt.setSelectionRange(3, 3);
    h.controller.prompt.dispatchEvent(new Event("input", { bubbles: true }));
    const search = h.sent.find(
      (intent) => (intent as { kind?: string }).kind === "search_context",
    ) as { requestId: string; draftRevision: number };
    h.send({
      kind: "mention_results",
      sessionId: "s1",
      sequence: 2,
      requestId: search.requestId,
      draftRevision: search.draftRevision,
      query: "us",
      items: [{
        kind: "table",
        label: "users",
        detail: "main.public.users",
        token: "public.users",
        ref: {
          id: "table:main.public.users",
          kind: "table",
          label: "users",
          detail: "main.public.users",
          displayToken: "@public.users",
          source: "main.public.users",
          status: "ready",
          revision: "r1",
        },
      }],
    });
    h.controller.flushRender();
    h.controller.prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    h.controller.flushRender();

    const schema = h.root.querySelector<HTMLButtonElement>(`[${SCHEMA_CHIP_MARKER}]`);
    expect(schema).not.toBeNull();
    expect(schema!.textContent).toContain("Schema: public");
    schema!.click();
    expect(h.sent).toContainEqual({ kind: "pick_active_schema", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 });

    const chip = h.root.querySelector<HTMLElement>(`[${CONTEXT_CHIP_MARKER}]`);
    expect(chip).not.toBeNull();
    chip!.querySelector<HTMLButtonElement>(`[${CONTEXT_CHIP_PREVIEW_MARKER}]`)!.click();
    expect(h.sent).toContainEqual(expect.objectContaining({
      kind: "preview_context",
      ref: expect.objectContaining({ id: "table:main.public.users" }),
    }));
    chip!.querySelector<HTMLButtonElement>(`[${CONTEXT_CHIP_REMOVE_MARKER}]`)!.click();
    expect(h.sent).toContainEqual(expect.objectContaining({
      kind: "remove_context",
      refId: "table:main.public.users",
    }));
    expect(h.controller.getState().draft.context).toHaveLength(0);

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelector(`[${SCHEMA_CHIP_MARKER}]`)).toBeNull();
    expect(h.root.querySelector(`[${CONTEXT_CHIP_MARKER}]`)).toBeNull();
  });

  it("#10 dispose() removes the transcript nodes and the scroll pill (no leak)", () => {
    const h = makeHarness();
    const before = h.root.querySelectorAll(`[${SCROLL_PILL_MARKER}]`).length;
    expect(before).toBe(1);
    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelectorAll(`[${SCROLL_PILL_MARKER}]`).length).toBe(0);
  });

  it("#11 mounts the 40px header once with ONE visible title and no raw codicons", () => {
    const h = makeHarness();
    h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: true, visionCapable: false });
    h.send({ kind: "title_updated", sessionId: "s1", sequence: 2, title: "Ops run" });
    h.controller.flushRender();

    const header = h.root.querySelector<HTMLElement>(".UnicDB-ai-chat-v2-header");
    expect(header).not.toBeNull();
    // Geometry lives in CSS, not JS: the header row is exactly 40px tall.
    const css = readFileSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"), "utf8");
    expect(css).toMatch(/\.UnicDB-ai-chat-v2-header\s*{[^}]*height:\s*40px/);
    // The host-acked title routes to the sessions-owned node — the shell's
    // placeholder title and the header's own editor are gone (single writer).
    expect(h.root.querySelectorAll(".UnicDB-ai-chat-v2-title").length).toBe(0);
    const titles = h.root.querySelectorAll(".UnicDB-ai-chat-v2-title-inline");
    expect(titles.length).toBe(1);
    expect(titles[0].textContent).toContain("Ops run");
    expect(h.root.querySelector(".UnicDB-ai-chat-v2-title-editor")).toBeNull();
    // The header is the single pill writer: it applies the min-height contract.
    const pill = h.root.querySelector<HTMLButtonElement>("#UnicDB-ai-chat-v2-engine")!;
    expect(pill.style.getPropertyValue("--UnicDB-pill-min")).toBe("32px");
    // No raw codicon text ever becomes visible.
    expect(h.root.textContent).not.toMatch(/\$\(/);

    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(() => h.controller.dispose()).not.toThrow();
    expect(h.root.querySelector(".UnicDB-ai-chat-v2-title-editor")).toBeNull();
    expect(h.root.querySelectorAll(`[${OVERLAY_MENU_MARKER}]`).length).toBe(0);
  });

  it("#12 opens the engine + model menus from their triggers and posts ack-correlated V2 intents", () => {
    const h = makeHarness({ engineEntries: ENGINE_ENTRIES });
    h.send({
      kind: "capabilities",
      sessionId: "s1",
      sequence: 1,
      capabilities: capsSnapshot("builtin", "Built-in"),
    });
    h.send({
      kind: "models",
      sessionId: "s1",
      sequence: 2,
      active: "work",
      roles: [
        { role: "work", modelId: "acme/sonnet-4", vision: false },
        { role: "smart", modelId: "acme/haiku-3", vision: false },
      ],
    });
    h.controller.flushRender();

    // Engine menu opens from the header pill with the injected catalog rows.
    const pill = h.root.querySelector<HTMLButtonElement>("#UnicDB-ai-chat-v2-engine")!;
    pill.click();
    const engineMenu = h.root.querySelector<HTMLElement>(`[${OVERLAY_MENU_MARKER}]`);
    expect(engineMenu).not.toBeNull();
    const codexRow = findRowByText(engineMenu!, "Codex");
    codexRow.click();
    expect(sentCount(h, "set_engine")).toBe(1);
    const setEngine = h.sent.find((i) => (i as { kind?: string }).kind === "set_engine") as {
      kind: string;
      protocolVersion: string;
      clientRequestId: string;
      engine: string;
    };
    expect(setEngine).toEqual({
      kind: "set_engine",
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      clientRequestId: expect.any(String),
      engine: "codex",
    });
    // No optimistic pill swap: only the correlated ack moves it.
    expect(pill.textContent).not.toContain("Codex");
    h.send({
      kind: "capabilities",
      sessionId: "s1",
      sequence: 3,
      clientRequestId: setEngine.clientRequestId,
      capabilities: capsSnapshot("codex", "Codex"),
    });
    h.controller.flushRender();
    expect(pill.textContent).toContain("Codex");

    // Model menu opens from the composer chip and posts set_model; the chip
    // only reflects the role the host acknowledged.
    const chip = h.controller.composer.modelButton;
    expect(chip.textContent).not.toContain("haiku-3");
    chip.click();
    const modelMenu = h.root.querySelector<HTMLElement>(`[${OVERLAY_MENU_MARKER}]`);
    expect(modelMenu).not.toBeNull();
    findRowByText(modelMenu!, "haiku-3").click();
    expect(sentCount(h, "set_model")).toBe(1);
    expect(chip.textContent).not.toContain("haiku-3");
    const setModel = h.sent.find((i) => (i as { kind?: string }).kind === "set_model") as {
      clientRequestId: string;
    };
    h.send({
      kind: "models",
      sessionId: "s1",
      sequence: 4,
      active: "smart",
      roles: [
        { role: "work", modelId: "acme/sonnet-4", vision: false },
        { role: "smart", modelId: "acme/haiku-3", vision: false },
      ],
      clientRequestId: setModel.clientRequestId,
    });
    h.controller.flushRender();
    expect(chip.textContent).toContain("haiku-3");

    // No configured role ⇒ settings, never an empty menu.
    const h2 = makeHarness();
    h2.send({ kind: "models", sessionId: "s2", sequence: 1, active: "work", roles: [] });
    h2.controller.flushRender();
    h2.controller.composer.modelButton.click();
    expect(h2.sent).toContainEqual(
      expect.objectContaining({ kind: "open_settings", protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2 }),
    );
    expect(h2.root.querySelectorAll(`[${OVERLAY_MENU_MARKER}]`).length).toBe(0);
  });

  it("#13 confirms a busy engine switch through the ONE stop path and keeps a single overflow owner", () => {
    const h = makeHarness({ engineEntries: ENGINE_ENTRIES });
    h.send({
      kind: "capabilities",
      sessionId: "s1",
      sequence: 1,
      capabilities: capsSnapshot("builtin", "Built-in"),
    });
    h.controller.prompt.value = "long turn";
    h.controller.prompt.dispatchEvent(new Event("input", { bubbles: true }));
    h.controller.requestSubmit();
    h.send({ kind: "turn_started", sessionId: "s1", sequence: 2, turnId: "t1", clientRequestId: "req-1" });
    h.controller.flushRender();

    // Busy: selecting an engine opens the stop-and-switch confirmation instead
    // of posting immediately.
    const pill = h.root.querySelector<HTMLButtonElement>("#UnicDB-ai-chat-v2-engine")!;
    pill.click();
    findRowByText(h.root, "Codex").click();
    expect(sentCount(h, "set_engine")).toBe(0);
    expect(h.root.textContent).toContain(ENGINE_SWITCH_CONFIRM_TITLE);
    // Cancel is the default: nothing is posted and the dialog closes.
    findButtonByText(h.root, ENGINE_SWITCH_CONFIRM_CANCEL_LABEL).click();
    expect(sentCount(h, "stop_turn")).toBe(0);
    expect(h.root.textContent).not.toContain(ENGINE_SWITCH_CONFIRM_TITLE);

    // Confirm: exactly ONE stop through the controller's single stop path; the
    // switch itself is deferred until the turn is terminal.
    pill.click();
    findRowByText(h.root, "Codex").click();
    findButtonByText(h.root, ENGINE_SWITCH_CONFIRM_STOP_LABEL).click();
    expect(sentCount(h, "stop_turn")).toBe(1);
    expect(sentCount(h, "set_engine")).toBe(0);
    h.send({ kind: "turn_finished", sessionId: "s1", sequence: 3, turnId: "t1", outcome: "stopped" });
    expect(sentCount(h, "set_engine")).toBe(1);
    expect(h.sent).toContainEqual(
      expect.objectContaining({ kind: "set_engine", engine: "codex" }),
    );

    // The sessions surface keeps the ONLY overflow menu — the header mounted
    // with ownOverflow:false adds no second menu or listener.
    h.send({
      kind: "sessions",
      sessionId: "s1",
      sequence: 4,
      items: [{ sessionId: "saved-1", label: "Saved chat", detail: "2 messages" }],
    });
    h.controller.flushRender();
    h.root.querySelector<HTMLButtonElement>("#UnicDB-ai-chat-v2-overflow")!.click();
    expect(h.root.querySelectorAll(`#${SESSIONS_IDS.menu}`).length).toBe(1);
    expect(h.root.querySelectorAll(`[${OVERLAY_MENU_MARKER}]`).length).toBe(0);

    // Dispose: no overlay survives and no dead listener reacts to clicks.
    h.controller.dispose();
    controllers = controllers.filter((c) => c !== h.controller);
    expect(h.root.querySelectorAll(`[${OVERLAY_MENU_MARKER}]`).length).toBe(0);
    const before = h.sent.length;
    pill.click();
    expect(h.sent.length).toBe(before);
  });

  it("#14 mounts exactly ONE renderer in the transcript — no activity timeline, one keyed node per tool (CHATUX2-004)", () => {
    const h = makeHarness();
    h.send({ kind: "session_hydrated", sessionId: "s1", sequence: 1, hasHistory: false, visionCapable: false });
    const prompt = h.controller.prompt;
    prompt.value = "run it";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    h.controller.requestSubmit();
    const submit = h.sent
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
      .find((m) => m["kind"] === "submit_turn");
    const clientRequestId =
      typeof submit?.["clientRequestId"] === "string" ? submit["clientRequestId"] : "req-1";
    h.send({
      kind: "turn_started",
      sessionId: "s1",
      sequence: 2,
      turnId: "t1",
      clientRequestId,
    });
    h.send({
      kind: "tool_started",
      sessionId: "s1",
      sequence: 3,
      turnId: "t1",
      toolId: "tool-1",
      label: "Run query",
      action: "query",
    });
    h.send({
      kind: "tool_finished",
      sessionId: "s1",
      sequence: 4,
      turnId: "t1",
      toolId: "tool-1",
      label: "Run query",
      status: "ok",
      summary: "3 rows",
      durationMs: 42,
    });
    h.controller.flushRender();

    const transcript = h.root.querySelector(".UnicDB-ai-chat-v2-transcript") as HTMLElement;
    expect(transcript).not.toBeNull();
    // The duplicate activity timeline is gone: no header/body/row nodes at all.
    expect(transcript.querySelectorAll('[class*="-activity-header"]').length).toBe(0);
    expect(transcript.querySelectorAll('[class*="-activity-body"]').length).toBe(0);
    expect(transcript.querySelectorAll('[class*="-activity-row"]').length).toBe(0);
    // Each tool id owns exactly ONE keyed node — the transcript renderer's.
    expect(transcript.querySelectorAll('[data-chat-key="tool-1"]').length).toBe(1);
  });
});
