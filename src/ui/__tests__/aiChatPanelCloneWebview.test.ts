// src/ui/__tests__/aiChatPanelCloneWebview.test.ts — TASK-AGTUI-007
//
// Integration seam: webview/aiChatPanelMain.ts is rewired to compose
// renderHeader (TASK-AGTUI-003) + renderComposer (TASK-AGTUI-004) into a
// Claude Code–style panel, while preserving the element-id contract the
// existing suite pins. This file adds tests for the new clone affordances
// (model chip, bypass toggle, mic, slash hint) and for the host frames
// `models` / `model_select` / `bypass_permissions` — none of which are
// covered by the existing aiChatPanelWebview*.test.ts suites.
//
// Harness mirrors aiChatPanelWebviewTask005.test.ts:
//   @vitest-environment jsdom
//   esbuild bundles webview/aiChatPanelMain.ts to IIFE at module load,
//   then eval'd inside a fresh jsdom window with stubbed acquireVsCodeApi.
//
// The existing pinned assertions (engine banner textContent for the four
// closed engine values; busy-disable on send/resume/regenerate/attach;
// sessionChip classes/labels) are NOT re-implemented here — they are
// the "regression" suite in case #7 and live unmodified in the existing
// files.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// @vitest-environment jsdom

const sourcePath = resolve(process.cwd(), "webview", "aiChatPanelMain.ts");

const esbuildBin = (() => {
  const here = resolve(process.cwd(), "node_modules", ".bin", "esbuild");
  if (existsSync(here)) return here;
  const parent = resolve(process.cwd(), "..", "..", "node_modules", ".bin", "esbuild");
  if (existsSync(parent)) return parent;
  return here;
})();
const compiled = execFileSync(
  esbuildBin,
  ["--target=es2022", "--format=iife", "--bundle", sourcePath],
  { encoding: "utf8" },
).toString();

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface Harness {
  received: Array<Record<string, unknown>>;
  dispatch: (msg: Record<string, unknown>) => void;
  root: HTMLDivElement;
}

function makeHarness(): Harness {
  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg: unknown) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi })
    .acquireVsCodeApi = () => api;

  document.body.innerHTML =
    '<div id="UnicDB-root" class="UnicDB-form-body"></div>';

  // Mirror aiChatPanelWebview.test.ts: capture only the LATEST message
  // handler so re-evals don't accumulate and leak prior DOM.
  const originalAdd = window.addEventListener.bind(window);
  let latestMessageHandler: ((ev: MessageEvent) => void) | null = null;
  (window as unknown as { addEventListener: typeof originalAdd }).addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "message") {
      latestMessageHandler = listener as (ev: MessageEvent) => void;
      return;
    }
    return originalAdd(type, listener, options);
  }) as typeof originalAdd;

  (0, eval)(compiled);

  (window as unknown as { addEventListener: typeof originalAdd }).addEventListener =
    originalAdd;

  const dispatch = (msg: Record<string, unknown>): void => {
    if (latestMessageHandler) {
      latestMessageHandler(new MessageEvent("message", { data: msg }));
      return;
    }
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  };

  return {
    received,
    dispatch,
    root: document.getElementById("UnicDB-root") as HTMLDivElement,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// =====================================================================
// Test 1 — clone DOM mounts with legacy ids (happy)
// =====================================================================
describe("AiChatPanelCloneWebview — TASK-AGTUI-007 #1 DOM mount with legacy ids", () => {
  it("#1 dispatch init{hasHistory:false,visionCapable:true} → DOM contains every pinned element id", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    // Header brand mark + banner (clone-owned via renderHeader).
    const header = h.root.querySelector(".UnicDB-chat-header");
    expect(header).not.toBeNull();
    const brand = h.root.querySelector("#chatBrandMark");
    expect(brand).not.toBeNull();
    expect(brand?.textContent).toBe("U");

    // Pinned legacy ids the existing suite asserts on.
    for (const id of [
      "thread",
      "prompt",
      "sendBtn",
      "stopBtn",
      "attachBtn",
      "resumeBtn",
      "clearBtn",
      "regenerateBtn",
      "jumpLatest",
      "engineBanner",
    ]) {
      expect(document.getElementById(id), `#${id} must exist`).not.toBeNull();
    }

    // New clone affordances owned by renderComposer.
    for (const id of [
      "modelChipBtn",
      "bypassToggle",
      "micBtn",
      "slashHintBtn",
    ]) {
      expect(document.getElementById(id), `#${id} must exist`).not.toBeNull();
    }

    // The session chip is created lazily by host `session_state` frames;
    // after init only the banner is mounted. The pinned assertion that
    // the chip carries `UnicDB-chat-sessionchip` + legacy classes lives
    // in aiChatPanelSessionStateWebview.test.ts:85-118.

    // Busy-disable contract: send/resume/regenerate/attach start enabled
    // (per aiChatPanelWebview.test.ts:788-801 baseline).
    expect(
      (document.getElementById("sendBtn") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (document.getElementById("resumeBtn") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (document.getElementById("regenerateBtn") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (document.getElementById("attachBtn") as HTMLButtonElement).disabled,
    ).toBe(false);
    // ClearBtn is NEVER touched by setBusy — explicitly enabled.
    expect(
      (document.getElementById("clearBtn") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

// =====================================================================
// Test 2 — `models` frame drives the chip + chip click posts model_select
// =====================================================================
describe("AiChatPanelCloneWebview — TASK-AGTUI-007 #2 models frame drives chip + select", () => {
  it("#2 host posts {type:\"models\", active:\"smart\", roles:[work,smart]} → chip shows smart; click chip row work → one {type:\"model_select\",role:\"work\"}", async () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    h.dispatch({
      type: "models",
      active: "smart",
      roles: [
        { role: "work", modelId: "gpt-5", vision: true },
        { role: "smart", modelId: "claude-opus", vision: true },
      ],
    });

    // Chip label must reflect the active role. The composer formats it as
    // "<role> · <modelId>" — pin the role prefix + modelId.
    const chip = document.getElementById(
      "modelChipBtn",
    ) as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("smart");
    expect(chip!.textContent).toContain("claude-opus");

    // Open the menu by clicking the chip.
    chip!.click();
    // Menu lives at the wrap level — query by id "modelChipMenu".
    const menu = document.getElementById("modelChipMenu") as
      | HTMLDivElement
      | null;
    expect(menu).not.toBeNull();
    const rows = menu!.querySelectorAll<HTMLButtonElement>(
      ".UnicDB-chat-chipmenu-row",
    );
    expect(rows.length).toBe(2);

    // Click the row for "work".
    const workRow = Array.from(rows).find(
      (r) => r.dataset.role === "work",
    ) as HTMLButtonElement | undefined;
    expect(workRow).toBeTruthy();
    workRow!.click();

    // Exactly one model_select with role "work" was posted.
    const selects = h.received.filter((m) => m.type === "model_select");
    expect(selects.length).toBe(1);
    expect(selects[0]?.role).toBe("work");
    // No send posted on a chip-row click.
    expect(h.received.filter((m) => m.type === "send").length).toBe(0);
  });
});

// =====================================================================
// Test 3 — empty roles → inert chip (edge)
// =====================================================================
describe("AiChatPanelCloneWebview — TASK-AGTUI-007 #3 empty roles → inert chip", () => {
  it("#3 `models` with roles:[] → chip disabled, label 'No models configured', clicking posts nothing; panel still usable for send", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    h.dispatch({
      type: "models",
      active: "work",
      roles: [],
    });

    const chip = document.getElementById(
      "modelChipBtn",
    ) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toBe("No models configured");

    // Click is a no-op (composer guards `models.length === 0`).
    const before = h.received.length;
    chip.click();
    // Clicking an already-disabled button in jsdom still fires the
    // listener — assert the listener guard produced no outbound message.
    expect(h.received.length).toBe(before);

    // The panel is still usable for send.
    const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    prompt.value = "hello";
    sendBtn.click();
    const sends = h.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(1);
    expect(sends[0]?.text).toBe("hello");
  });
});

// =====================================================================
// Test 4 — bypass toggle alternation (edge: state repeat)
// =====================================================================
describe("AiChatPanelCloneWebview — TASK-AGTUI-007 #4 bypass toggle alternation", () => {
  it("#4 two clicks on #bypassToggle → exactly two bypass_permissions frames in order true, false; aria-checked alternates", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const toggle = document.getElementById(
      "bypassToggle",
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    // Initial aria-checked is "false" (clone default OFF).
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    toggle.click();
    const posts1 = h.received.filter((m) => m.type === "bypass_permissions");
    expect(posts1.length).toBe(1);
    expect(posts1[0]?.enabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    toggle.click();
    const posts2 = h.received.filter((m) => m.type === "bypass_permissions");
    expect(posts2.length).toBe(2);
    expect(posts2[0]?.enabled).toBe(true);
    expect(posts2[1]?.enabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

// =====================================================================
// Test 5 — legacy flows unchanged (edge: parity)
// =====================================================================
describe("AiChatPanelCloneWebview — TASK-AGTUI-007 #5 legacy flows unchanged", () => {
  it("#5a whitespace-only send posts nothing", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    prompt.value = "   \n  ";
    sendBtn.click();
    expect(h.received.filter((m) => m.type === "send").length).toBe(0);
  });

  it("#5b Enter on non-empty text posts {type:'send',text}", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
    prompt.value = "hello world";
    prompt.setSelectionRange(11, 11);
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    const sends = h.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(1);
    expect(sends[0]?.text).toBe("hello world");
  });

  it("#5c stop while busy posts {type:'stop'}", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    prompt.value = "go";
    sendBtn.click();
    stopBtn.click();
    const stops = h.received.filter((m) => m.type === "stop");
    expect(stops.length).toBe(1);
  });

  it("#5d engine frame with unknown name → #engineBanner falls back to label builtin + UnicDB-chat-engine-builtin class", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    h.dispatch({ type: "engine", name: "skynet" });
    const banner = document.getElementById("engineBanner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe("Engine: builtin — streaming");
    expect(banner!.classList.contains("UnicDB-chat-engine-builtin")).toBe(
      true,
    );
  });

  it("#5e static title node stays 'UnicDB AI' even after engine frames", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    h.dispatch({ type: "engine", name: "claude-code" });
    const titles = h.root.querySelectorAll(".UnicDB-chat-title");
    const staticTitle = Array.from(titles).find(
      (n) => n.textContent === "UnicDB AI",
    );
    expect(staticTitle, "static 'UnicDB AI' title must survive engine frames").toBeTruthy();
  });
});

// =====================================================================
// Test 6 — XSS invariants survive refactor (edge: security)
// =====================================================================
describe("AiChatPanelCloneWebview — TASK-AGTUI-007 #6 XSS invariants", () => {
  it("#6 hostile `tool.name` / detail in permission_request renders as text only — re-run of existing aiChatPanelWebview.test.ts #3a contract", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    h.dispatch({
      type: "permission_request",
      requestId: "req-clone-007",
      tool: {
        id: "tool_write",
        name: "<script>window.__pwned_clone=1</script>",
        detail:
          "writes path 'C:\\tmp\\x.md' & <img src=x onerror=alert(1)>",
      },
      options: [
        { optionId: "allow-once", label: "Allow once" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    const html = h.root.innerHTML;
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(h.root.textContent ?? "").toContain(
      "<script>window.__pwned_clone=1</script>",
    );
    expect(h.root.textContent ?? "").toContain(
      "<img src=x onerror=alert(1)>",
    );
    const w = window as unknown as Record<string, unknown>;
    expect("__pwned_clone" in w).toBe(false);
  });

  it("#6b hostile engine name never reaches textContent verbatim", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const hostile = "<img onerror=alert(1) src=x>";
    h.dispatch({ type: "engine", name: hostile });
    const banner = document.getElementById("engineBanner");
    expect(banner).not.toBeNull();
    // Whitelist fallback to builtin — hostile string never reaches DOM.
    expect(banner!.textContent).toBe("Engine: builtin — streaming");
    expect(banner!.querySelectorAll("img").length).toBe(0);
  });
});

// =====================================================================
// Test 7 — regression: full existing webview suite still passes
// (no specific assertions here — see the existing suites in the
// verification command list).
// =====================================================================
