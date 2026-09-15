// webview/aiChat/__tests__/engineModelMenus.test.ts — TASK-CHATV2-012
//
// Engine/model listboxes, acknowledged switching and the truthful engine pill.
// Covers task cases #1 (four engine rows), #2 (ack/fail), #3 (busy stop-and-
// switch), #4 (model roles/vision, empty opens settings), #5 (listbox keyboard
// + ARIA), #6 (truthful header, no unconditional streaming) and #7 (stale ack).
//
// Harness: a fresh jsdom document per test; no vscode imports.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineCapabilitySnapshot } from "../../../src/ai/capabilities";
import type { ChatModelsState, ChatViewState, TurnPhase } from "../store";
import { createInitialChatState } from "../store";
import { CHAT_V2_ROOT_CLASS } from "../shell";
import { createChatIcon } from "../icons";
import {
  ENGINE_MENU_ORDER,
  ENGINE_SWITCH_CONFIRM_CANCEL_LABEL,
  ENGINE_SWITCH_CONFIRM_STOP_LABEL,
  MODEL_CHIP_UNCONFIGURED,
  activeModelRoleState,
  buildEngineRows,
  buildModelRows,
  createEngineMenu,
  createEngineSwitchView,
  createModelMenu,
  enginePillModel,
  engineRowModel,
  engineStatusLabel,
  engineSwitchConfirmBody,
  engineSwitchFailureCopy,
  friendlyModelName,
  isEngineSelectable,
  modelChipModel,
  renderEnginePill,
  type EngineMenuEntry,
} from "../engineModelMenus";
import { OVERLAY_DIALOG_MARKER, OVERLAY_MENU_MARKER } from "../overlays";

const ROOT = CHAT_V2_ROOT_CLASS;

function el(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`missing selector ${selector}`);
  return node as HTMLElement;
}

function makeCapabilities(
  engine: EngineCapabilitySnapshot["engine"],
  status: EngineCapabilitySnapshot["status"] = "ready",
): EngineCapabilitySnapshot {
  return {
    engine,
    displayName: engine === "claude-code" ? "Claude Code" : engine === "omp" ? "OMP" : engine === "codex" ? "Codex" : "Builtin",
    status,
    supports: {
      streamText: true,
      streamThought: false,
      toolTimeline: true,
      imageInput: false,
      nativeSessionResume: false,
      savedTranscriptResume: false,
      engineCommands: false,
      permissions: true,
      bypassPermissions: true,
      modelRoles: true,
      workspaceMentions: true,
      dbMentions: true,
      exportTranscript: true,
    },
    commands: [],
    modelRoles: [],
  };
}

function stateWith(
  capabilities: EngineCapabilitySnapshot | null,
  phase: TurnPhase = "idle",
  models: ChatModelsState | null = null,
): Pick<ChatViewState, "capabilities" | "phase" | "models"> {
  return { capabilities, phase, models };
}

const ALL_ENTRIES: readonly EngineMenuEntry[] = [
  { engine: "omp", displayName: "OMP", status: "ready", resolution: "" },
  { engine: "claude-code", displayName: "Claude Code", status: "starting", resolution: "This engine is starting up." },
  {
    engine: "codex",
    displayName: "Codex",
    status: "unavailable",
    resolution: "This engine is not available in the current workspace.",
    setupAvailable: true,
  },
  {
    engine: "builtin",
    displayName: "Builtin",
    status: "not-installed",
    resolution: "This engine is not installed.",
    setupAvailable: true,
  },
];

let root: HTMLDivElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  root.classList.add(ROOT);
  document.body.appendChild(root);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---- #1 capability ---------------------------------------------------------

describe("TASK-CHATV2-012 #1 — four engine rows", () => {
  it("renders the four engines in canonical order with exact status/resolution", () => {
    const rows = buildEngineRows(ALL_ENTRIES, "omp", () => {});
    expect(rows.map((r) => r.id)).toEqual([...ENGINE_MENU_ORDER]);
    expect(rows.map((r) => r.label)).toEqual(["OMP", "Claude Code", "Codex", "Builtin"]);

    const omp = rows[0]!;
    expect(omp.disabled).toBeUndefined(); // ready → selectable
    expect(omp.checked).toBe(true);
    expect(omp.meta).toBe("Ready");

    const claude = rows[1]!;
    expect(claude.disabled).toBe(true); // starting → not selectable
    expect(claude.meta).toBe("Starting");
    expect(claude.description).toBe("This engine is starting up.");

    const codex = rows[2]!;
    expect(codex.disabled).toBe(true);
    expect(codex.meta).toBe("Unavailable");
    expect(codex.description).toBe(
      "This engine is not available in the current workspace.",
    );
    expect(typeof codex.action?.label).toBe("string"); // setup help available

    const builtin = rows[3]!;
    expect(builtin.meta).toBe("Not installed");
    expect(builtin.description).toBe("This engine is not installed.");
  });

  it("a selectable row never carries an action; a non-selectable row cannot select", () => {
    expect(isEngineSelectable(ALL_ENTRIES[0]!)).toBe(true);
    expect(isEngineSelectable(ALL_ENTRIES[2]!)).toBe(false);
    const row = engineRowModel(ALL_ENTRIES[0]!, "builtin", () => {});
    expect(row.action).toBeUndefined();
    expect(row.checked).toBe(false);
  });

  it("status labels are the exact four literals", () => {
    expect(engineStatusLabel("ready")).toBe("Ready");
    expect(engineStatusLabel("starting")).toBe("Starting");
    expect(engineStatusLabel("unavailable")).toBe("Unavailable");
    expect(engineStatusLabel("not-installed")).toBe("Not installed");
  });

  it("unknown/hostile copy renders as text and never as markup", () => {
    const hostile: EngineMenuEntry = {
      engine: "codex",
      displayName: "<img onerror=alert(1) src=x>",
      status: "unavailable",
      resolution: "<script>alert(1)</script>",
    };
    const menu = createEngineMenu({
      anchor: root,
      trigger: root.appendChild(document.createElement("button")),
      onSelectEngine: () => {},
      onOpenSetup: () => {},
    });
    menu.setEntries([hostile]);
    menu.open();
    const list = el(`[${OVERLAY_MENU_MARKER}]`);
    expect(list.querySelectorAll("img").length).toBe(0);
    expect(list.querySelectorAll("script").length).toBe(0);
    expect(list.textContent).toContain("<img onerror=alert(1) src=x>");
    menu.destroy();
  });
});

// ---- #6 regression: truthful header ---------------------------------------

describe("TASK-CHATV2-012 #6 — truthful engine pill", () => {
  it("labels `<displayName> · <Ready|Starting|Working|Unavailable>`", () => {
    expect(enginePillModel(stateWith(makeCapabilities("omp"), "idle")).label).toBe("OMP · Ready");
    expect(enginePillModel(stateWith(makeCapabilities("claude-code"), "idle")).label).toBe("Claude Code · Ready");
    expect(enginePillModel(stateWith(makeCapabilities("codex", "starting"), "idle")).label).toBe("Codex · Starting");
    expect(enginePillModel(stateWith(makeCapabilities("builtin", "unavailable"), "idle")).label).toBe("Builtin · Unavailable");
  });

  it("never says streaming; a busy phase reports Working only while runnable", () => {
    const working = enginePillModel(stateWith(makeCapabilities("omp"), "streaming"));
    expect(working.statusWord).toBe("Working");
    expect(working.label).not.toMatch(/stream/i);

    // An UNAVAILABLE engine never claims to be working even mid-phase.
    const unavailable = enginePillModel(stateWith(makeCapabilities("codex", "unavailable"), "streaming"));
    expect(unavailable.statusWord).toBe("Unavailable");

    // Pre-hydration is truthfully "Starting", never Ready/streaming.
    const pre = enginePillModel(stateWith(null, "idle"));
    expect(pre.statusWord).toBe("Starting");
  });

  it("renderEnginePill writes the exact label, status class and tone", () => {
    const trigger = document.createElement("button");
    const dot = document.createElement("span");
    dot.className = `${ROOT}-engine-dot`;
    const label = document.createElement("span");
    label.className = `${ROOT}-engine-label`;
    trigger.append(dot, label);
    root.appendChild(trigger);

    const model = renderEnginePill(trigger, stateWith(makeCapabilities("omp"), "idle"));
    expect(model.label).toBe("OMP · Ready");
    expect(label.textContent).toBe("OMP · Ready");
    expect(trigger.getAttribute("aria-label")).toBe("Engine: OMP · Ready");
    expect(trigger.classList.contains(`${ROOT}-engine-ready`)).toBe(true);
    expect(dot.getAttribute("data-tone")).toBe("success");

    renderEnginePill(trigger, stateWith(makeCapabilities("builtin", "unavailable"), "idle"));
    expect(label.textContent).toBe("Builtin · Unavailable");
    expect(trigger.classList.contains(`${ROOT}-engine-unavailable`)).toBe(true);
    expect(trigger.classList.contains(`${ROOT}-engine-ready`)).toBe(false);
  });

  it("the shell's plug icon is allowlisted and 14px-capable", () => {
    const svg = createChatIcon("plug", 14);
    expect(svg.getAttribute("data-icon")).toBe("plug");
    expect(svg.getAttribute("width")).toBe("14");
  });
});

// ---- #5 keyboard / ARIA ----------------------------------------------------

describe("TASK-CHATV2-012 #5 — listbox keyboard + ARIA", () => {
  function mountMenu(): { trigger: HTMLButtonElement; menu: ReturnType<typeof createEngineMenu> } {
    const trigger = document.createElement("button");
    root.appendChild(trigger);
    const menu = createEngineMenu({
      anchor: root,
      trigger,
      onSelectEngine: () => {},
      onOpenSetup: () => {},
    });
    menu.setEntries(ALL_ENTRIES);
    menu.setActiveEngine("omp");
    return { trigger, menu };
  }

  function key(target: HTMLElement, k: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it("opens on the trigger, keeps focus there and wires aria-expanded/activedescendant", () => {
    const { trigger, menu } = mountMenu();
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    menu.open();
    expect(menu.isOpen()).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    const active = trigger.getAttribute("aria-activedescendant");
    expect(active).toContain("omp");

    const options = document.querySelectorAll(`[${OVERLAY_MENU_MARKER}] [role="option"]`);
    expect(options.length).toBe(4);
    // Exactly one selected option, matching the activedescendant.
    expect(document.querySelectorAll('[aria-selected="true"]').length).toBe(1);
    expect(trigger.getAttribute("aria-activedescendant")).toBe(
      document.querySelector('[aria-selected="true"]')?.id,
    );
  });

  it("ArrowDown/ArrowUp move the active row; Enter selects; Escape closes", () => {
    const selected: string[] = [];
    const trigger = document.createElement("button");
    root.appendChild(trigger);
    const menu = createEngineMenu({
      anchor: root,
      trigger,
      onSelectEngine: (engine) => selected.push(engine),
      onOpenSetup: () => {},
    });
    menu.setEntries(ALL_ENTRIES);
    menu.open();

    expect(menu.handleKey(key(trigger, "ArrowDown"))).toBe(true);
    expect(menu.menu.getActiveRow()?.id).toBe("claude-code");

    expect(menu.handleKey(key(trigger, "ArrowUp"))).toBe(true);
    expect(menu.menu.getActiveRow()?.id).toBe("omp");

    // Home/End.
    expect(menu.handleKey(key(trigger, "End"))).toBe(true);
    expect(menu.menu.getActiveRow()?.id).toBe("builtin");

    // Escape closes and restores focus; nothing selected.
    expect(menu.handleKey(key(trigger, "Escape"))).toBe(true);
    expect(menu.isOpen()).toBe(false);
    expect(selected).toEqual([]);
    expect(document.activeElement).toBe(trigger);

    // Enter on a selectable row selects it and closes.
    menu.open();
    menu.menu.setActive(0);
    expect(menu.handleKey(key(trigger, "Enter"))).toBe(true);
    expect(selected).toEqual(["omp"]);
    expect(menu.isOpen()).toBe(false);
  });

  it("Tab closes without trapping focus; a disabled row never selects", () => {
    const selected: string[] = [];
    const setup: string[] = [];
    const trigger = document.createElement("button");
    root.appendChild(trigger);
    const menu = createEngineMenu({
      anchor: root,
      trigger,
      onSelectEngine: (engine) => selected.push(engine),
      onOpenSetup: (engine) => setup.push(engine),
    });
    menu.setEntries(ALL_ENTRIES);
    menu.open();
    expect(menu.handleKey(key(trigger, "Tab"))).toBe(false); // not consumed
    expect(menu.isOpen()).toBe(false);

    // Disabled row: Enter opens setup help, never a selection.
    menu.open();
    menu.menu.setActive(2); // codex (unavailable, setupAvailable)
    menu.handleKey(key(trigger, "Enter"));
    expect(selected).toEqual([]);
    expect(setup).toEqual(["codex"]);
  });
});

// ---- #4 model --------------------------------------------------------------

describe("TASK-CHATV2-012 #4 — model rows and empty state", () => {
  const models: ChatModelsState = {
    active: "smart",
    roles: [
      { role: "work", modelId: "acme/sonnet-4", vision: true },
      { role: "smart", modelId: "acme/opus-4", vision: true },
      { role: "lite", modelId: "acme/haiku", vision: false },
      { role: "autocomplete", modelId: "acme/tiny", vision: false },
    ],
  };

  it("exact row anatomy: 16px check, role label, badge, image icon only when true", () => {
    const rows = buildModelRows(models);
    expect(rows.map((r) => r.id)).toEqual(["work", "smart", "lite", "autocomplete"]);
    expect(rows.map((r) => r.description)).toEqual(["Work", "Smart", "Lite", "Autocomplete"]);
    expect(rows[0]!.meta).toBe("Standard");
    expect(rows[1]!.meta).toBe("High");
    expect(rows[1]!.checked).toBe(true);
    // Vision proven on work/smart, absent on lite/autocomplete.
    expect(rows[0]!.icon).toBe("view");
    expect(rows[1]!.icon).toBe("view");
    expect(rows[2]!.icon).toBeUndefined();
    expect(rows[3]!.icon).toBeUndefined();
    expect(rows[0]!.label).toBe("sonnet-4"); // friendly name (last path segment)
  });

  it("chip shows `<friendly> · <quality>` and never an empty menu", () => {
    expect(modelChipModel(models).label).toBe("opus-4 · High");
    expect(modelChipModel(models).empty).toBe(false);
    expect(modelChipModel(null).empty).toBe(true);
    expect(modelChipModel({ active: "work", roles: [] }).label).toBe(MODEL_CHIP_UNCONFIGURED);
  });

  it("empty configuration opens settings, not an empty menu", () => {
    const trigger = document.createElement("button");
    root.appendChild(trigger);
    const openSettings = vi.fn();
    const menu = createModelMenu({
      anchor: root,
      trigger,
      onSelectModel: () => {},
      onOpenSettings: openSettings,
    });
    menu.setModels(null);
    menu.open();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(menu.isOpen()).toBe(false);
    expect(document.querySelector(`[${OVERLAY_MENU_MARKER}]`)).toBeNull();
  });

  it("activeModelRoleState resolves the active role, null when unconfigured", () => {
    expect(activeModelRoleState(models)?.role).toBe("smart");
    expect(activeModelRoleState({ active: "work", roles: [] })).toBeNull();
    expect(activeModelRoleState(null)).toBeNull();
  });

  it("friendlyModelName strips a provider path and handles blank input", () => {
    expect(friendlyModelName("anthropic/claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(friendlyModelName("  gpt-5  ")).toBe("gpt-5");
    expect(friendlyModelName("   ")).toBe("");
  });

  it("a configured model list opens a real listbox with selectable roles", () => {
    const trigger = document.createElement("button");
    root.appendChild(trigger);
    const picked: string[] = [];
    const menu = createModelMenu({
      anchor: root,
      trigger,
      onSelectModel: (role) => picked.push(role),
      onOpenSettings: () => {},
    });
    menu.setModels(models);
    menu.open();
    expect(menu.isOpen()).toBe(true);
    const options = document.querySelectorAll(`[${OVERLAY_MENU_MARKER}] [role="option"]`);
    expect(options.length).toBe(4);
    menu.menu.activateActive(); // active="smart" row
    expect(picked).toEqual(["smart"]);
  });

  it("model and engine selection are independent menus", () => {
    const engineTrigger = document.createElement("button");
    const modelTrigger = document.createElement("button");
    root.append(engineTrigger, modelTrigger);
    const engineMenu = createEngineMenu({
      anchor: root,
      trigger: engineTrigger,
      onSelectEngine: () => {},
      onOpenSetup: () => {},
    });
    const modelMenu = createModelMenu({
      anchor: root,
      trigger: modelTrigger,
      onSelectModel: () => {},
      onOpenSettings: () => {},
    });
    engineMenu.setEntries(ALL_ENTRIES);
    engineMenu.open();
    expect(modelMenu.isOpen()).toBe(false);
    modelMenu.setModels(models);
    modelMenu.open();
    // Two independent listboxes, each labelled for its own domain.
    const lists = document.querySelectorAll(`[${OVERLAY_MENU_MARKER}]`);
    expect(lists.length).toBe(2);
    expect(lists[0]!.getAttribute("aria-label")).toBe("Select engine");
    expect(lists[1]!.getAttribute("aria-label")).toBe("Select model");
  });
});

// ---- #2 ack -----------------------------------------------------------------

describe("TASK-CHATV2-012 #2 — acknowledged switch (no optimistic label)", () => {
  function harness(): {
    posted: string[];
    stops: string[];
    toasts: string[];
    committed: string[];
    ids: () => string;
    view: ReturnType<typeof createEngineSwitchView>;
  } {
    const posted: string[] = [];
    const stops: string[] = [];
    const toasts: string[] = [];
    const committed: string[] = [];
    let n = 0;
    const view = createEngineSwitchView({
      mount: root,
      getRequestId: () => `req-${++n}`,
      postSetEngine: (id, engine) => posted.push(`${id}:${engine}`),
      postStop: (id) => stops.push(id),
      onToast: (message) => toasts.push(message),
      displayNameFor: (engine) => (engine === "codex" ? "Codex" : engine),
      onEngineCommitted: (engine) => committed.push(engine),
      onModelCommitted: () => {},
    });
    return { posted, stops, toasts, committed, ids: () => `req-${n}`, view };
  }

  it("idle selection emits set_engine but commits only on a MATCHING ack", () => {
    const h = harness();
    h.view.requestIdle("codex");
    expect(h.posted).toEqual(["req-1:codex"]);
    expect(h.committed).toEqual([]); // no optimistic label swap

    // Mismatched ack (a different request) is ignored.
    h.view.handleHostFrame({ kind: "capabilities", clientRequestId: "other" });
    expect(h.committed).toEqual([]);

    // Matching ack commits exactly once.
    h.view.handleHostFrame({ kind: "capabilities", clientRequestId: "req-1" });
    expect(h.committed).toEqual(["codex"]);
    expect(h.view.state().kind).toBe("stable");
  });

  it("failure keeps the old engine and shows the exact safe toast", () => {
    const h = harness();
    h.view.requestIdle("codex");
    h.view.handleHostFrame({ kind: "error", clientRequestId: "req-1", safeMessage: "It is not installed." });
    expect(h.committed).toEqual([]);
    expect(h.toasts).toEqual(["Could not switch to Codex. It is not installed."]);
    expect(h.view.state().kind).toBe("stable");
  });

  it("failure copy is exact and falls back to a safe reason", () => {
    expect(engineSwitchFailureCopy("Codex", "not-installed")).toBe(
      "Could not switch to Codex. not-installed",
    );
    expect(engineSwitchFailureCopy("Codex", "")).toBe(
      "Could not switch to Codex. It is not available right now.",
    );
  });

  it("a stale ack after the request settled is ignored", () => {
    const h = harness();
    h.view.requestIdle("codex");
    h.view.handleHostFrame({ kind: "error", clientRequestId: "req-1", safeMessage: "nope" });
    // The late success ack for req-1 arrives after the failure settled it.
    h.view.handleHostFrame({ kind: "capabilities", clientRequestId: "req-1" });
    expect(h.committed).toEqual([]);
  });
});

// ---- #7 race — stale model ack --------------------------------------------

describe("TASK-CHATV2-012 #7 — stale model ack", () => {
  it("a models ack with no pending correlation is dropped", () => {
    const committed: string[] = [];
    let n = 0;
    const view = createEngineSwitchView({
      mount: root,
      getRequestId: () => `m-${++n}`,
      postSetEngine: () => {},
      postSetModel: () => {},
      postStop: () => {},
      onToast: () => {},
      displayNameFor: (e) => e,
      onEngineCommitted: () => {},
      onModelCommitted: (id) => committed.push(id),
    });
    // No request was made; an unrelated ack must not mutate the chip.
    view.handleHostFrame({ kind: "models", clientRequestId: "ghost" });
    expect(committed).toEqual([]);
  });

  it("requestModel emits set_model; only the matching ack commits once", () => {
    const posted: string[] = [];
    const committed: string[] = [];
    let n = 0;
    const view = createEngineSwitchView({
      mount: root,
      getRequestId: () => `m-${++n}`,
      postSetEngine: () => {},
      postSetModel: (id, role) => posted.push(`${id}:${role}`),
      postStop: () => {},
      onToast: () => {},
      displayNameFor: (e) => e,
      onEngineCommitted: () => {},
      onModelCommitted: (id) => committed.push(id),
    });
    view.requestModel("lite");
    expect(posted).toEqual(["m-1:lite"]);
    expect(committed).toEqual([]); // no optimistic chip swap
    view.handleHostFrame({ kind: "models", clientRequestId: "m-1" });
    expect(committed).toEqual(["m-1"]);
    // A duplicate late ack for the same id is dropped (no longer pending).
    view.handleHostFrame({ kind: "models", clientRequestId: "m-1" });
    expect(committed).toEqual(["m-1"]);
  });
});

// ---- #3 busy — stop-and-switch --------------------------------------------

describe("TASK-CHATV2-012 #3 — busy stop-and-switch", () => {
  function harness(): {
    stops: string[];
    posted: string[];
    committed: string[];
    view: ReturnType<typeof createEngineSwitchView>;
  } {
    const stops: string[] = [];
    const posted: string[] = [];
    const committed: string[] = [];
    let n = 0;
    const view = createEngineSwitchView({
      mount: root,
      getRequestId: () => `r-${++n}`,
      postSetEngine: (id, engine) => posted.push(`${id}:${engine}`),
      postStop: (id) => stops.push(id),
      onToast: () => {},
      displayNameFor: (engine) => (engine === "codex" ? "Codex" : engine),
      onEngineCommitted: (engine) => committed.push(engine),
      onModelCommitted: () => {},
    });
    return { stops, posted, committed, view };
  }

  it("opens a modal with the exact copy and Cancel default; Escape cancels", () => {
    const h = harness();
    h.view.requestBusy("codex");
    const dialog = h.view.getDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.isOpen()).toBe(true);
    expect(el(`[${OVERLAY_DIALOG_MARKER}]`).getAttribute("aria-modal")).toBe("true");
    expect(dialog!.element.textContent).toContain(
      "Stop the current response and switch to Codex? Your unsent draft is preserved.",
    );
    expect(engineSwitchConfirmBody("Codex")).toBe(
      "Stop the current response and switch to Codex? Your unsent draft is preserved.",
    );

    const confirmBtn = el(`.${ROOT}-overlay-dialog-confirm`);
    const cancelBtn = el(`.${ROOT}-overlay-dialog-cancel`);
    expect(confirmBtn.textContent).toBe(ENGINE_SWITCH_CONFIRM_STOP_LABEL);
    expect(cancelBtn.textContent).toBe(ENGINE_SWITCH_CONFIRM_CANCEL_LABEL);
    // Default focus is the SAFE action.
    expect(dialog!.focusedControl()).toBe("cancel");
    expect(document.activeElement).toBe(cancelBtn);

    // Escape cancels: no stop, no switch.
    expect(dialog!.handleKey(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(h.stops).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.view.state().kind).toBe("stable");
  });

  it("confirm sends exactly one stop and defers the switch until terminal", () => {
    const h = harness();
    h.view.requestBusy("codex");
    el(`.${ROOT}-overlay-dialog-confirm`).dispatchEvent(new MouseEvent("click"));
    expect(h.stops).toEqual(["r-1"]);
    expect(h.posted).toEqual([]); // deferred
    expect(h.view.state().kind).toBe("stopping");

    // Not yet terminal: nothing posted.
    expect(h.posted).toEqual([]);

    // Terminal arrives → the switch request is emitted once.
    h.view.handleHostFrame({ kind: "turn_finished", clientRequestId: "r-1" });
    expect(h.posted).toEqual(["r-2:codex"]);

    // Ack commits.
    h.view.handleHostFrame({ kind: "capabilities", clientRequestId: "r-2" });
    expect(h.committed).toEqual(["codex"]);
  });

  it("destroying the dialog on cancel leaves no dialog in the DOM", () => {
    const h = harness();
    h.view.requestBusy("codex");
    el(`.${ROOT}-overlay-dialog-cancel`).dispatchEvent(new MouseEvent("click"));
    expect(document.querySelector(`[${OVERLAY_DIALOG_MARKER}]`)).toBeNull();
    expect(h.view.state().kind).toBe("stable");
  });
});
