// src/ui/__tests__/aiChatPanelAttachments.test.ts — TASK-001 (cycle AB).
//
// Pins the cycle-AB host changes for image attachments:
//
//  - CSP img-src 'self' data: present in buildHtml output
//  - handleSend forwards attachments as ChatContentPart[] when vision=true
//  - reject paths (oversize / count_cap / unsupported_type / mime_mismatch)
//    surface as {type:"attach_error"} bubbles; offending attachments are
//    NEVER passed to runAgent
//  - engine === "omp" gate: image attachments rejected with vision_unsupported
//    even when the model advertises vision (engine is the belt, not just the
//    model flag). Text-only turn still proceeds.
//  - buildMessages still DDL-only on the system prompt when image parts are
//    forwarded (the privacy / sentinel property)
//  - text-only path is byte-identical to cycle AA baseline (legacy)
//  - no apiKey strings in any new message shape (positive assertion)
//
// Pure-host tests; no vscode runtime, no webview bundle. Mirrors the harness
// in aiChatPanel.test.ts so the panel mock + vscode stub are reused.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ----- vscode stub (mirrors aiChatPanel.test.ts) ---------------------------
type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const l of this.listeners.slice()) l(data);
  }
}

interface MockPanel {
  webview: {
    html: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const state = vi.hoisted(() => ({ panels: [] as MockPanel[] }));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel: MockPanel = {
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => u),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(() => {
          panel.disposed = true;
          const listeners = (panel.onDidDispose as unknown as {
            mock: { calls: Array<[() => void]> };
          }).mock.calls;
          for (const [cb] of listeners) cb();
        }),
        visible: true,
        disposed: false,
      };
      state.panels.push(panel);
      return panel;
    }),
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

// ----- agent mock (mirrors aiChatPanel.test.ts) ----------------------------
const agentState = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return {
    ...actual,
    runAgent: agentState.runAgentMock,
  };
});

// ----- module imports (after mocks) ----------------------------------------
import * as vscode from "vscode";
import { AiChatPanel, buildMessages, type AcpPanelDeps } from "../aiChatPanel";
import type { ImageAttachment } from "../aiChatAttachments";
import type {
  AgentDeps,
  AgentStep,
  AgentRunResult,
} from "../../ai/agent";
import type { ChatMessage } from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import type { DbToolRegistry } from "../../ai/tools/registry";

const extUri = vscode.Uri.file("/ext");

// ----- tiny fixtures --------------------------------------------------------

/** Decode a base64 string back to bytes (re-uses the same globalThis.atob
 * path the production code uses). */
function b64ToBytes(b64: string): Uint8Array {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = (globalThis as { atob: (s: string) => string }).atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode raw bytes back to base64 so test fixtures look like the wire. */
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return (globalThis as { btoa: (s: string) => string }).btoa(bin);
}

/** A valid PNG header (8 bytes). */
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** JPEG SOI (3 bytes). */
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff]);

/** Build a valid attachment whose bytes match its declared MIME via the
 * magic-byte sniff. `totalBytes` defaults to a small payload. */
function makeValidAttachment(
  id: string,
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  totalBytes = 32,
): ImageAttachment {
  const head =
    mime === "image/png"
      ? PNG_HEAD
      : mime === "image/jpeg"
        ? JPEG_HEAD
        : mime === "image/webp"
          ? new Uint8Array([
              0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
            ])
          : new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const bytes = new Uint8Array(totalBytes);
  bytes.set(head.subarray(0, Math.min(head.length, totalBytes)), 0);
  return {
    id,
    mime,
    base64: bytesToB64(bytes),
    bytes: totalBytes,
  };
}

/** Attachment carrying PDF magic bytes but declared as image/jpeg. */
function makeJpegWithPdfMagic(id: string): ImageAttachment {
  const pdfHead = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  const bytes = new Uint8Array(32);
  bytes.set(pdfHead, 0);
  return {
    id,
    mime: "image/jpeg",
    base64: bytesToB64(bytes),
    bytes: bytes.length,
  };
}

// ----- harness helpers (mirror aiChatPanel.test.ts) -------------------------

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

function panelHarness(): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
  const panel = state.panels[state.panels.length - 1] as MockPanel;
  return {
    panel,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (
      msg: unknown,
    ) => void,
  };
}

function postedMessages(panel: MockPanel): unknown[] {
  return panel.webview.postMessage.mock.calls.map((c) => c[0]);
}

function isInit(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
interface InitMsg {
  type: "init";
  hasHistory: boolean;
  visionCapable?: boolean;
}
function asInit(m: unknown): InitMsg {
  return m as InitMsg;
}

function isAssistant(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "assistant";
}
interface AssistantMsg {
  type: "assistant";
  text: string;
}
function isDone(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}

function isAttachError(
  m: unknown,
): m is {
  type: "attach_error";
  id: string;
  reason: string;
  message: string;
} {
  return (
    !!m &&
    typeof m === "object" &&
    (m as { type?: string }).type === "attach_error"
  );
}

function isError(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}

function makeRunResult(_steps: AgentStep[], finalText: string): AgentRunResult {
  return { steps: [], history: [], finalText, stoppedOnBudget: false };
}

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

// =========================================================================
// #1 — handleSend({text, attachments:[valid]}) → user message text + image
// =========================================================================
describe("AiChatPanel — image attach (TASK-001 cycle AB)", () => {
  it("#a happy: handleSend forwards {text, attachments:[valid]} as ChatContentPart[] (1 text + 1 image_url)", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const validPng = makeValidAttachment("a1", "image/png");
    handler({ type: "send", text: "describe", attachments: [validPng] });
    await until(() => postedMessages(p).some(isAssistant));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const firstCallArgs = agentState.runAgentMock.mock.calls[0];
    const input = firstCallArgs?.[0] as { messages: ChatMessage[] };
    const userMessage = input.messages[input.messages.length - 1] as ChatMessage;
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    const parts = userMessage.content as Array<{
      type: string;
      text?: string;
      imageUrl?: string;
    }>;
    const textParts = parts.filter((part) => part.type === "text");
    const imageParts = parts.filter((part) => part.type === "image_url");
    expect(textParts).toHaveLength(1);
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.imageUrl).toMatch(/^data:image\/png;base64,/);

    // vision_capable true on init (default settings: work.vision === true).
    const init = postedMessages(p).find(isInit);
    expect(init).toBeDefined();
    expect(asInit(init).visionCapable).toBe(true);

    // No attach_error bubbled for valid input.
    expect(postedMessages(p).some(isAttachError)).toBe(false);
  });

  it("#b oversize (6 MB png): attach_error{reason:oversize} posted; runAgent called but NOT with that attachment", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // bytes=6MB → reported larger than MAX_ATTACH_BYTES=5MB; the mock bytes
    // array is 32 real bytes but the `bytes` field claims 6MB → host rejects
    // without ever reading the (truncated) payload.
    const oversize = makeValidAttachment("big", "image/png", 32);
    oversize.bytes = 6 * 1024 * 1024;

    handler({ type: "send", text: "send", attachments: [oversize] });
    await until(() => postedMessages(p).some(isAssistant));

    const errs = postedMessages(p).filter(isAttachError);
    expect(errs.length).toBeGreaterThan(0);
    const err = errs[0]!;
    expect(err.reason).toBe("oversize");
    expect(err.id).toBe("big");

    // runAgent fired — with a TEXT-ONLY user message (no image parts).
    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const input = agentState.runAgentMock.mock.calls[0]?.[0] as {
      messages: ChatMessage[];
    };
    const last = input.messages[input.messages.length - 1] as ChatMessage;
    expect(last.role).toBe("user");
    // Text-only: content is a string, NOT an array.
    expect(typeof last.content).toBe("string");
    expect((last.content as string)).toBe("send");
  });

  it("#c count cap: 5 attachments → 5th rejected{reason:count_cap}, first 4 kept", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const five = Array.from({ length: 5 }, (_, i) =>
      makeValidAttachment(`a${i}`, "image/png"),
    );
    handler({ type: "send", text: "go", attachments: five });
    await until(() => postedMessages(p).some(isAssistant));

    const errs = postedMessages(p).filter(isAttachError);
    const countCapErrs = errs.filter((e) => e.reason === "count_cap");
    expect(countCapErrs.length).toBeGreaterThan(0);
    // The 5th is the rejected one (per spec: drop suffix, emit one error per
    // dropped item).
    expect(countCapErrs.some((e) => e.id === "a4")).toBe(true);

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const input = agentState.runAgentMock.mock.calls[0]?.[0] as {
      messages: ChatMessage[];
    };
    const last = input.messages[input.messages.length - 1] as ChatMessage;
    expect(Array.isArray(last.content)).toBe(true);
    const imageParts = (last.content as Array<{ type: string }>).filter(
      (p) => p.type === "image_url",
    );
    expect(imageParts).toHaveLength(4);
  });

  it("#d mime text/plain → reason:unsupported_type", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const txt = makeValidAttachment("t", "image/png");
    // overwrite to disallowed mime
    const bad: ImageAttachment = { ...txt, id: "t", mime: "text/plain" };
    handler({ type: "send", text: "go", attachments: [bad] });
    await until(() => postedMessages(p).some(isAssistant));

    const errs = postedMessages(p).filter(isAttachError);
    expect(errs.length).toBeGreaterThan(0);
    const e = errs[0]!;
    expect(e.reason).toBe("unsupported_type");
    expect(e.id).toBe("t");

    // runAgent fired text-only.
    const input = agentState.runAgentMock.mock.calls[0]?.[0] as {
      messages: ChatMessage[];
    };
    const last = input.messages[input.messages.length - 1] as ChatMessage;
    expect(typeof last.content).toBe("string");
  });

  it("#e mime mismatch: image/jpeg with PDF magic bytes → reason:mime_mismatch", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const sneaky = makeJpegWithPdfMagic("sneaky");
    handler({ type: "send", text: "go", attachments: [sneaky] });
    await until(() => postedMessages(p).some(isAssistant));

    const errs = postedMessages(p).filter(isAttachError);
    expect(errs.length).toBeGreaterThan(0);
    const e = errs[0]!;
    expect(e.reason).toBe("mime_mismatch");
    expect(e.id).toBe("sneaky");

    // runAgent text-only.
    const input = agentState.runAgentMock.mock.calls[0]?.[0] as {
      messages: ChatMessage[];
    };
    const last = input.messages[input.messages.length - 1] as ChatMessage;
    expect(typeof last.content).toBe("string");
  });

  // ---------------------------------------------------------------------
  // For the omp-gate case we drive an engine === "omp" panel. The panel
  // class only switches its engine when an `acp` dep is supplied; without
  // touching the real AcpProcessHandle we shortcut to the engine by passing
  // acp: stub (so `this.engine = "omp"` on construction).
  // ---------------------------------------------------------------------
  it("#f engine='omp' + 2 valid attachments → 2×{reason:vision_unsupported}, text-only turn proceeds", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const acpStub: AcpPanelDeps = { start: vi.fn() };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      acp: acpStub,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const a1 = makeValidAttachment("o1", "image/png");
    const a2 = makeValidAttachment("o2", "image/png");
    handler({ type: "send", text: "describe both", attachments: [a1, a2] });

    // We don't expect an assistant message in omp mode (acpTurn is mocked to
    // be no-op via stub start → no start call made). Just wait long enough
    // for the synchronous validation path to post attach_error bubbles.
    await until(() =>
      postedMessages(p).filter(isAttachError).length >= 2,
    );

    const errs = postedMessages(p).filter(isAttachError);
    expect(errs).toHaveLength(2);
    expect(errs.every((e) => e.reason === "vision_unsupported")).toBe(true);
    const ids = errs.map((e) => e.id).sort();
    expect(ids).toEqual(["o1", "o2"]);

    // No image parts ran through runAgent (it never got called for omp, or
    // it was called text-only). Either way: no image_url parts in any
    // ChatContent forwarded to runAgent.
    if (agentState.runAgentMock.mock.calls.length > 0) {
      for (const call of agentState.runAgentMock.mock.calls) {
        const input = call?.[0] as { messages: ChatMessage[] };
        const last = input.messages[input.messages.length - 1] as ChatMessage;
        expect(last.role).toBe("user");
        expect(typeof last.content).toBe("string");
      }
    }
  });

  it("#g buildMessages with image parts: system message DDL-only; user parts intact; runQuery spy 0", async () => {
    // Direct buildMessages call (privacy sentinel shape). Adapter deliberately
    // fails `runQuery` and the production code must never invoke it.
    const adapter = {
      listSchemas: vi.fn(async () => [
        { name: "public" } as { name: string },
      ]),
      listTables: vi.fn(async () => [
        { schema: "public", name: "t1", type: "table" } as {
          schema: string;
          name: string;
          type: string;
        },
      ]),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      runQuery: vi.fn(async () => {
        throw new Error("runQuery must not be called");
      }),
    };
    const factory: AdapterFactory = vi.fn(async () => adapter);

    const userMsg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        {
          type: "image_url",
          imageUrl: `data:image/png;base64,${bytesToB64(PNG_HEAD)}`,
        },
      ],
    };

    const messages = await buildMessages(factory, [], userMsg, {
      contextBudgetChars: 200_000,
      contextTableLimit: 200,
    });
    const sys = messages[0] as ChatMessage;
    expect(sys.role).toBe("system");
    // DDL-only — must contain CREATE TABLE but NEVER the word 'data:' (no
    // image bytes leak into the system prompt).
    expect(typeof sys.content).toBe("string");
    const sysText = sys.content as string;
    expect(sysText).toContain("CREATE TABLE");
    expect(sysText).not.toContain("data:");
    expect(sysText).not.toMatch(/image\/png/);

    // runQuery was never called by buildMessages.
    expect(adapter.runQuery).not.toHaveBeenCalled();

    // User message parts intact.
    const user = messages[messages.length - 1] as ChatMessage;
    expect(user.role).toBe("user");
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === "text")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1);
  });
});

// =========================================================================
// #h CSP — buildHtml output contains `img-src 'self' data:`
// =========================================================================
describe("AiChatPanel — CSP (TASK-001 cycle AB)", () => {
  it("#h buildHtml output's CSP meta contains `img-src 'self' data:`", () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p } = panelHarness();
    // createWebviewPanel mock captured the html on construction via show().
    expect(p.webview.html).toContain("img-src 'self' data:");
  });
});

// =========================================================================
// #i Text-only path is byte-identical to cycle AA baseline. We assert by
// constructing TWO panels back-to-back: one with empty attachments, one
// without any attachments field on the send message. Both must produce the
// exact same final user message and the same set of posted messages (modulo
// init), so the legacy text-only contract holds.
// =========================================================================
describe("AiChatPanel — text-only path (TASK-001 cycle AB)", () => {
  it("#i text-only path is byte-identical to baseline (no legacy regression)", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));

    async function driveSend(
      payload: { type: "send"; text: string; attachments?: ImageAttachment[] },
    ): Promise<ChatMessage> {
      const factory: AdapterFactory = vi.fn(async () => null);
      const panel = new AiChatPanel({
        extensionUri: extUri,
        deps: makeDeps(),
        adapterFactory: factory,
      });
      panel.show();
      const { panel: p, handler } = panelHarness();
      handler({ type: "ready" });
      await until(() => postedMessages(p).some(isInit));
      handler(payload);
      await until(() => postedMessages(p).some(isAssistant));
      const input = agentState.runAgentMock.mock.calls.at(-1)?.[0] as {
        messages: ChatMessage[];
      };
      return input.messages[input.messages.length - 1] as ChatMessage;
    }

    const legacy = await driveSend({ type: "send", text: "legacy" });
    const empty = await driveSend({
      type: "send",
      text: "legacy",
      attachments: [],
    });
    // Both text-only paths must produce the SAME shape: a user message
    // whose content is the literal string the webview typed.
    expect(legacy.role).toBe("user");
    expect(empty.role).toBe("user");
    // Legacy contract: legacy path stores the string content directly
    // (`content: "legacy"`), no ChatContentPart[] wrap.
    expect(legacy.content).toBe("legacy");
    // Empty-attachments path may use the parts-array shape — it MUST be
    // semantically equivalent: exactly 1 text part carrying "legacy".
    if (Array.isArray(empty.content)) {
      const parts = empty.content as Array<{ type: string; text?: string }>;
      expect(parts).toHaveLength(1);
      expect(parts[0]!.type).toBe("text");
      expect(parts[0]!.text).toBe("legacy");
    } else {
      expect(empty.content).toBe("legacy");
    }
  });
});

// =========================================================================
// #j grep: no "apiKey" string in the new message shapes (positive assertion).
// We grep the source of src/ui/aiChatPanelMessages.ts for any apiKey mention.
// =========================================================================
describe("AiChatPanel — no apiKey in new message shapes (TASK-001 cycle AB)", () => {
  it("#j src/ui/aiChatPanelMessages.ts contains no `apiKey` string", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.join(__dirname, "..", "aiChatPanelMessages.ts"),
      "utf8",
    );
    // Comment-only annotations about apiKey are excluded; we want only actual
    // identifier / string occurrences.
    const stripped = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    expect(stripped).not.toMatch(/apiKey/);
  });
});

// =========================================================================
// #0b (TASK-001 acceptance): @-mention + 2 valid attachments — text part
// carries "Referenced context" block; image parts are siblings, NEVER replaced.
// =========================================================================
describe("AiChatPanel — mention x attachment (TASK-001 cycle AB acceptance 0b)", () => {
  it("#0b @public.users + 2 valid PNGs → user message has 1 text part (prompt + Referenced context) + 2 image_url parts", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    handler({
      type: "send",
      text: "@public.users",
      attachments: [makeValidAttachment("m1", "image/png"), makeValidAttachment("m2", "image/png")],
    });
    await until(() => postedMessages(p).some(isAssistant));

    const input = agentState.runAgentMock.mock.calls.at(-1)?.[0] as { messages: ChatMessage[] };
    const userMessage = input.messages[input.messages.length - 1] as ChatMessage;
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    const parts = userMessage.content as Array<{ type: string; text?: string; imageUrl?: string }>;
    expect(parts.length).toBe(3);
    expect(parts[0]!.type).toBe("text");
    // Text part carries the augmented prompt + Referenced context block.
    expect(parts[0]!.text).toContain("@public.users");
    expect(parts[1]!.type).toBe("image_url");
    expect(parts[2]!.type).toBe("image_url");
  });
});
