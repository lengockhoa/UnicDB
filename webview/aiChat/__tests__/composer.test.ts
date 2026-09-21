// webview/aiChat/__tests__/composer.test.ts — TASK-CHATV2-008
//
// Covers the seven cases in the task contract: control inventory, state
// rendering, busy-draft regression, invalid-draft edge, auto-grow boundary,
// narrow/label CSS branches and the architecture boundary (this component owns
// neither keyboard submit nor host transport).
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_AUTO_GROW_MAX_PX,
  COMPOSER_AUTO_GROW_MIN_PX,
  COMPOSER_BUSY_HINT,
  COMPOSER_IDS,
  COMPOSER_QUEUE_FULL_LABEL,
  COMPOSER_QUEUE_HINT_LABEL,
  COMPOSER_QUEUE_SUFFIX,
  COMPOSER_REASON_EMPTY,
  COMPOSER_REASON_UNRESOLVED,
  COMPOSER_SEND_LABEL,
  COMPOSER_STOP_LABEL,
  COMPOSER_STOP_LOCK_MS,
  renderComposerV2,
  type ComposerCallbacks,
  type ComposerSelection,
  type ComposerView,
} from "../composer";
import { createContextChipStrip, CONTEXT_CHIP_MARKER } from "../contextChips";
import { createSchemaControl } from "../schemaControl";
import { buildContextRefs } from "../../../src/ui/aiChatContext";
import { createInitialChatState, type ChatViewState } from "../store";
import { decideComposerKey, type ComposerKeyInput } from "../keyboard";

interface Recorder {
  inputs: Array<{ value: string; selection: ComposerSelection }>;
  selections: ComposerSelection[];
  attach: number;
  slash: number;
  model: number;
  schema: number;
  permission: number;
  primary: number;
  previews: string[];
  removals: string[];
}

function recorder(): Recorder & ComposerCallbacks {
  // Counters are incremented on the SAME object the test reads — a spread copy
  // would freeze every numeric field at its initial value.
  const rec = {
    inputs: [] as Array<{ value: string; selection: ComposerSelection }>,
    selections: [] as ComposerSelection[],
    attach: 0,
    slash: 0,
    model: 0,
    schema: 0,
    permission: 0,
    primary: 0,
    previews: [] as string[],
    removals: [] as string[],
  };
  const callbacks: ComposerCallbacks = {
    onInput: (value, selection) => rec.inputs.push({ value, selection }),
    onSelectionChange: (selection) => rec.selections.push(selection),
    onAttachOpen: () => {
      rec.attach += 1;
    },
    onSlashOpen: () => {
      rec.slash += 1;
    },
    onModelOpen: () => {
      rec.model += 1;
    },
    onContextActivate: (id) => rec.previews.push(id),
    onContextRemove: (id) => rec.removals.push(id),
    onSchemaOpen: () => {
      rec.schema += 1;
    },
    onPermissionOpen: () => {
      rec.permission += 1;
    },
    onPrimaryActivate: () => {
      rec.primary += 1;
    },
  };
  return Object.assign(rec, callbacks);
}

/** State with a valid idle draft (send enabled). */
function idleValid(overrides: Partial<ChatViewState> = {}): ChatViewState {
  const base = createInitialChatState();
  return {
    ...base,
    draft: { ...base.draft, text: "hello world", revision: 1 },
    ...overrides,
  };
}

/** Force a measured `scrollHeight` on the textarea for auto-grow assertions. */
function stubScrollHeight(prompt: HTMLTextAreaElement, value: number): void {
  Object.defineProperty(prompt, "scrollHeight", {
    configurable: true,
    get: () => value,
  });
}
/** Build a `decideComposerKey` input with sane defaults (mirrors the
 * keyboard.test.ts helper) so each assertion states only what matters. */
function keyInput(overrides: Partial<ComposerKeyInput> = {}): ComposerKeyInput {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    composing: false,
    phase: "idle",
    draftText: "hello",
    hasUnresolvedContext: false,
    permissionFocused: false,
    autocompleteOpen: false,
    autocompleteItemCount: 0,
    ...overrides,
  };
}


/** Read the addEventListener types actually registered by the component. */
function listenerTypes(view: ComposerView): string[] {
  const spy = vi.spyOn(view.prompt, "addEventListener");
  view.destroy();
  return spy.mock.calls.map((call) => String(call[0]));
}

const COMPOSER_SRC = readFileSync(
  resolve(process.cwd(), "webview", "aiChat", "composer.ts"),
  "utf8",
);

/** Executable source only: strip line + block comments so prose documenting a
 * forbidden pattern cannot trip the boundary assertions. */
const COMPOSER_CODE = COMPOSER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const STYLES = readFileSync(
  resolve(process.cwd(), "webview", "aiChat", "styles.css"),
  "utf8",
);

describe("TASK-CHATV2-008 composer — control inventory (#1)", () => {
  let mount: HTMLElement;
  let view: ComposerView;
  let cb: ReturnType<typeof recorder>;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    cb = recorder();
    view = renderComposerV2(mount, cb);
  });

  it("renders the exact id inventory on semantic elements", () => {
    const expected: Record<string, string> = {
      composerV2: COMPOSER_IDS.composer,
      promptV2: COMPOSER_IDS.prompt,
      attachContextBtn: COMPOSER_IDS.attach,
      slashCommandBtn: COMPOSER_IDS.slash,
      modelChipBtnV2: COMPOSER_IDS.model,
      contextChipList: COMPOSER_IDS.contextList,
      permissionBtn: COMPOSER_IDS.permission,
      primaryTurnBtn: COMPOSER_IDS.primary,
      composerHint: COMPOSER_IDS.hint,
    };
    for (const [name, id] of Object.entries(expected)) {
      const node = document.getElementById(id);
      expect(node, `#${name} (${id}) must exist`).not.toBeNull();
    }
    expect(view.root.id).toBe("composerV2");
    expect(view.prompt.tagName).toBe("TEXTAREA");
    for (const btn of [
      view.attachButton,
      view.slashButton,
      view.modelButton,
      view.permissionButton,
      view.primaryButton,
    ]) {
      expect(btn.tagName).toBe("BUTTON");
    }
    expect(view.contextList.tagName).toBe("DIV");
  });

  it("re-homes #schemaChipBtnV2 onto the mounted V2 schema control", () => {
    // TASK-CHATV2-013: the schema chip belongs to `createSchemaControl`; the
    // composer only positions it. The composer boots with NO second chip, and
    // the handoff detaches the placeholder so no duplicate id can exist.
    expect(document.getElementById(COMPOSER_IDS.schema)).toBeNull();
    const control = createSchemaControl({
      container: document.createElement("div"),
      id: COMPOSER_IDS.schema,
      onPickSchema: () => cb.schema++,
    });
    view.setSchemaControl(control.element);
    const node = document.getElementById(COMPOSER_IDS.schema);
    expect(node).toBe(control.element);
    expect(node!.tagName).toBe("BUTTON");
    control.element.click();
    expect(cb.schema).toBe(1);
    control.destroy();
  });

  it("gives every icon-only control identical title and aria-label", () => {
    for (const btn of [view.attachButton, view.slashButton, view.primaryButton]) {
      const title = btn.getAttribute("title");
      const aria = btn.getAttribute("aria-label");
      expect(title).toBeTruthy();
      expect(aria).toBe(title);
    }
  });

  it("uses an upward arrow for send and never renders a microphone or paper plane", () => {
    view.render(idleValid());
    expect(view.primaryButton.querySelector('[data-icon="arrow-up"]')).not.toBeNull();
    const html = view.root.innerHTML.toLowerCase();
    expect(html).not.toContain("mic");
    expect(html).not.toContain("paper-plane");
    expect(html).not.toContain("send-plane");
  });
});

describe("TASK-CHATV2-008 composer — state rendering (#2)", () => {
  let mount: HTMLElement;
  let view: ComposerView;
  let cb: ReturnType<typeof recorder>;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    cb = recorder();
    view = renderComposerV2(mount, cb);
  });

  it("disables an empty idle send with the exact reason", () => {
    view.render(createInitialChatState());
    expect(view.primaryButton.disabled).toBe(true);
    expect(view.primaryButton.getAttribute("aria-label")).toBe(COMPOSER_REASON_EMPTY);
    expect(view.primaryButton.title).toBe(COMPOSER_REASON_EMPTY);
    expect(view.hint.hidden).toBe(true);
  });

  it("enables a valid idle send with the blue-arrow label", () => {
    view.render(idleValid());
    expect(view.primaryButton.disabled).toBe(false);
    expect(view.primaryButton.getAttribute("aria-label")).toBe(COMPOSER_SEND_LABEL);
    expect(view.primaryButton.classList.contains("UnicDB-ai-chat-v2-primary-send")).toBe(true);
    expect(view.primaryButton.querySelector('[data-icon="arrow-up"]')).not.toBeNull();
  });

  it("renders a red stop while busy with the fixed draft hint", () => {
    view.render(idleValid({ phase: "streaming" }));
    expect(view.primaryButton.querySelector('[data-icon="stop-square"]')).not.toBeNull();
    expect(view.primaryButton.getAttribute("aria-label")).toBe(COMPOSER_STOP_LABEL);
    expect(view.primaryButton.classList.contains("UnicDB-ai-chat-v2-primary-busy")).toBe(true);
    expect(view.hint.hidden).toBe(false);
    expect(view.hint.textContent).toBe(COMPOSER_BUSY_HINT);
  });

  it("locks the primary slot for 250ms while stopping but keeps the textarea editable", () => {
    vi.useFakeTimers();
    try {
      view.render(idleValid({ phase: "stopping" }));
      expect(view.isPrimaryLocked()).toBe(true);
      expect(view.primaryButton.disabled).toBe(true);
      expect(view.prompt.disabled).toBe(false);
      vi.advanceTimersByTime(COMPOSER_STOP_LOCK_MS);
      expect(view.isPrimaryLocked()).toBe(false);
      expect(view.primaryButton.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not update the model chip optimistically (renders state only)", () => {
    view.render(idleValid());
    expect(view.modelButton.textContent).toContain("No model");
    view.render(
      idleValid({
        models: { active: "sonnet", roles: [{ role: "work", modelId: "sonnet", vision: true }] },
      }),
    );
    expect(view.modelButton.textContent).toContain("sonnet");
  });
});

describe("TASK-CHATV2-008 composer — busy draft regression (#3)", () => {
  let mount: HTMLElement;
  let view: ComposerView;
  let cb: ReturnType<typeof recorder>;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    cb = recorder();
    view = renderComposerV2(mount, cb);
  });

  it("keeps textarea and context chips editable while busy and never queue-sends", () => {
    view.render(
      idleValid({
        phase: "streaming",
        draft: {
          ...createInitialChatState().draft,
          text: "next draft",
          context: [{ kind: "file", id: "f1", label: "a.ts" }],
        },
      }),
    );
    expect(view.prompt.disabled).toBe(false);
    expect(view.prompt.readOnly).toBe(false);
    expect(view.prompt.value).toBe("next draft");
    expect(view.contextList.hidden).toBe(false);

    // A draft edit while busy emits onInput and NOT a send.
    view.prompt.value = "next draft edited";
    view.prompt.dispatchEvent(new Event("input"));
    expect(cb.inputs.at(-1)?.value).toBe("next draft edited");
    expect(cb.primary).toBe(0);

    // Pressing the slot emits the SINGLE semantic primary callback; there is no
    // separate send/queue path the component could take on its own.
    view.primaryButton.click();
    expect(cb.primary).toBe(1);
  });
});

describe("TASK-CHATUX2-002 composer — steer queue hint", () => {
  let mount: HTMLElement;
  let view: ComposerView;
  let cb: Recorder & ComposerCallbacks;

  const queuedDraft = (text: string) => ({
    ...createInitialChatState().draft,
    text,
  });

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    cb = recorder();
    view = renderComposerV2(mount, cb);
  });

  it("shows the queued count while busy and beats the busy hint", () => {
    view.render(
      idleValid({
        phase: "streaming",
        steerQueue: [queuedDraft("one"), queuedDraft("two")],
      }),
    );
    expect(view.hint.hidden).toBe(false);
    expect(view.hint.textContent).toBe(
      `${COMPOSER_QUEUE_HINT_LABEL} 2 of 8 — ${COMPOSER_QUEUE_SUFFIX}`,
    );
    expect(view.hint.textContent).toBe("Queued 2 of 8 — sends when this turn ends");
  });

  it("shows the full-queue copy at the cap of 8", () => {
    view.render(
      idleValid({
        phase: "streaming",
        steerQueue: Array.from({ length: 8 }, (_, i) => queuedDraft(`q${i}`)),
      }),
    );
    expect(view.hint.hidden).toBe(false);
    expect(view.hint.textContent).toBe(
      `${COMPOSER_QUEUE_FULL_LABEL} (8) — ${COMPOSER_QUEUE_SUFFIX}`,
    );
    expect(view.hint.textContent).toBe("Queue full (8) — sends when this turn ends");
  });

  it("keeps the queue hint visible after the turn ends until the queue drains", () => {
    view.render(
      idleValid({
        phase: "completed",
        steerQueue: [queuedDraft("one")],
      }),
    );
    expect(view.hint.hidden).toBe(false);
    expect(view.hint.textContent).toBe("Queued 1 of 8 — sends when this turn ends");
  });

  it("hides the hint when idle with an empty queue", () => {
    view.render(idleValid({ phase: "idle", steerQueue: [] }));
    expect(view.hint.hidden).toBe(true);
  });
});

describe("TASK-CHATV2-008 composer — invalid draft edge (#4)", () => {
  let mount: HTMLElement;
  let view: ComposerView;
  let cb: ReturnType<typeof recorder>;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    cb = recorder();
    view = renderComposerV2(mount, cb);
  });

  it("refuses a whitespace-only draft with the empty reason and fires no callback", () => {
    const base = createInitialChatState();
    view.render({ ...base, draft: { ...base.draft, text: "   " } });
    expect(view.primaryButton.disabled).toBe(true);
    expect(view.primaryButton.title).toBe(COMPOSER_REASON_EMPTY);
    view.primaryButton.click();
    expect(cb.primary).toBe(0);
  });

  it("refuses a draft with unresolved context and reports the exact reason", () => {
    view.render(
      idleValid({
        draft: {
          ...createInitialChatState().draft,
          text: "hello",
          context: [{ kind: "file", id: "f1", label: "gone.ts", missing: true }],
        },
      }),
    );
    expect(view.primaryButton.disabled).toBe(true);
    expect(view.primaryButton.title).toBe(COMPOSER_REASON_UNRESOLVED);
    expect(view.primaryButton.getAttribute("aria-label")).toBe(COMPOSER_REASON_UNRESOLVED);
    view.primaryButton.click();
    expect(cb.primary).toBe(0);
  });

  it("hosts the V2 chip strip in #contextChipList and reports its activations", () => {
    // TASK-CHATV2-011: `createContextChipStrip` owns the chip DOM inside the
    // composer's lane; the composer reports the activation the strip cannot
    // observe itself, and removal still reaches the controller's callback.
    const strip = createContextChipStrip({
      container: view.contextList,
      callbacks: {
        onPreview: (ref) => cb.onContextActivate(ref.id),
        onRemove: (id) => cb.onContextRemove(id),
        onResolve: () => {},
      },
    });
    strip.render(
      buildContextRefs([
        {
          kind: "table",
          label: "public.users",
          detail: "main.public.users",
          source: { type: "object", connectionId: "main", schema: "public", name: "users", objectKind: "table" },
        },
      ]),
    );
    view.render(
      idleValid({
        draft: {
          ...createInitialChatState().draft,
          text: "hello",
          context: [{ kind: "table", id: "t1", label: "public.users" }],
        },
      }),
    );
    expect(view.contextList.querySelectorAll(`[${CONTEXT_CHIP_MARKER}]`)).toHaveLength(1);
    view.contextList.querySelector<HTMLButtonElement>(".UnicDB-ai-chat-v2-context-chip-preview")!.click();
    view.contextList.querySelector<HTMLButtonElement>(".UnicDB-ai-chat-v2-context-chip-remove")!.click();
    expect(cb.previews).toHaveLength(1);
    expect(cb.removals).toEqual(["table:main.public.users"]);
    strip.destroy();
  });
});

describe("TASK-CHATV2-008 composer — auto-grow boundary (#5)", () => {
  let mount: HTMLElement;
  let view: ComposerView;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    view = renderComposerV2(mount, recorder());
  });
  it("clamps measured scrollHeight to 36–88px and scrolls beyond the max", () => {
    // TASK-CHATUX-004 pins the compact clamp with literals, not just the
    // exported constants, so a silent constant change cannot self-adjust.
    expect(COMPOSER_AUTO_GROW_MIN_PX).toBe(36);
    expect(COMPOSER_AUTO_GROW_MAX_PX).toBe(88);

    stubScrollHeight(view.prompt, 20);
    view.render(idleValid());
    expect(view.prompt.style.height).toBe("36px");
    expect(view.prompt.classList.contains("UnicDB-ai-chat-v2-input-scroll")).toBe(false);

    stubScrollHeight(view.prompt, 60);
    view.render(idleValid());
    expect(view.prompt.style.height).toBe("60px");
    expect(view.prompt.classList.contains("UnicDB-ai-chat-v2-input-scroll")).toBe(false);

    stubScrollHeight(view.prompt, 400);
    view.render(idleValid());
    expect(view.prompt.style.height).toBe("88px");
    expect(view.prompt.classList.contains("UnicDB-ai-chat-v2-input-scroll")).toBe(true);
  });
});

describe("TASK-CHATV2-008 composer — narrow mode CSS branches (#6)", () => {
  it("scopes every composer rule under the V2 root and never leaks a bare selector", () => {
    const composerRules = STYLES.split("\n").filter(
      (line) => line.includes("v2-composer") || line.includes("v2-context-chip") || line.includes("v2-chip"),
    );
    expect(composerRules.length).toBeGreaterThan(0);
    for (const line of composerRules) {
      expect(line.includes("UnicDB-ai-chat-v2")).toBe(true);
    }
  });

  it("hides optional labels under 420px and wraps the bottom lane under 320px", () => {
    // The shell (005) uses the exclusive literals 419px/319px for the
    // "<420px / <320px" boundaries; the composer follows the same convention.
    const narrow420 = STYLES.slice(STYLES.indexOf("@media (max-width: 419px)"));
    expect(narrow420).not.toBe("");
    const narrow320 = STYLES.slice(STYLES.indexOf("@media (max-width: 319px)"));
    expect(narrow320).not.toBe("");
    expect(/label-optional\s*\{[^}]*display:\s*none/.test(narrow420)).toBe(true);
    // At <320px the bottom lane becomes a two-row grid: controls first, send second.
    expect(/composer-bottom[^{]*\{[^}]*grid-template-rows/.test(narrow320)).toBe(true);
    expect(/composer-lane-center[^{]*\{[^}]*overflow-x:\s*auto/.test(STYLES)).toBe(true);
    expect(/composer-lane-center[^{]*\{[^}]*min-width:\s*0/.test(STYLES)).toBe(true);
  });
});

describe("TASK-CHATV2-008 composer — architecture: no transport/key owner (#7)", () => {
  let mount: HTMLElement;
  let view: ComposerView;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    view = renderComposerV2(mount, recorder());
  });

  afterEach(() => {
    view.destroy();
  });

  it("never calls acquireVsCodeApi or postMessage", () => {
    expect(COMPOSER_CODE).not.toContain("acquireVsCodeApi");
    expect(COMPOSER_CODE).not.toContain("postMessage");
  });

  it("never registers a keydown/keyup submit listener", () => {
    expect(COMPOSER_CODE).not.toMatch(/addEventListener\(\s*["'](keydown|keyup|keypress)["']/);
    const types = listenerTypes(renderComposerV2(document.createElement("div"), recorder()));
    expect(types).not.toContain("keydown");
    expect(types).not.toContain("keyup");
    expect(types).not.toContain("keypress");
  });

  it("exposes exactly one primary activation callback and no send/queue callback", () => {
    const surface: keyof ComposerCallbacks = "onPrimaryActivate";
    expect(surface).toBe("onPrimaryActivate");
    expect(COMPOSER_CODE).not.toContain("onSend");
    expect(COMPOSER_CODE).not.toContain("onQueue");
  });
});

describe("TASK-CHATUX-004 composer — compact metrics + pinned contracts", () => {
  let mount: HTMLElement;
  let view: ComposerView;

  beforeEach(() => {
    document.body.innerHTML = "";
    mount = document.createElement("div");
    document.body.appendChild(mount);
    view = renderComposerV2(mount, recorder());
  });

  afterEach(() => {
    view.destroy();
  });

  it("CSS pins the compact metrics (≤104px collapsed footprint)", () => {
    const ruleBody = (selector: string): string => {
      const match = STYLES.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
      expect(match, `${selector} rule must exist`).not.toBeNull();
      return match![1]!;
    };

    // Top region: 36–88px auto-grow clamp, tighter padding.
    const top = ruleBody("\\.UnicDB-ai-chat-v2-composer-top");
    expect(top).toContain("min-height: 36px");
    expect(top).toContain("max-height: 88px");
    expect(top).toContain("padding: 6px 10px 4px");

    // Textarea scrolls past ~3.5 lines instead of seven.
    expect(ruleBody("\\.UnicDB-ai-chat-v2-input")).toContain("max-height: 76px");
    expect(ruleBody("\\.UnicDB-ai-chat-v2-input-v2")).toContain("max-height: 76px");

    // Bottom lane: 36px minimum, tighter padding.
    const bottom = ruleBody("\\.UnicDB-ai-chat-v2-composer-bottom");
    expect(bottom).toContain("min-height: 36px");
    expect(bottom).toContain("padding: 4px 8px");

    // Send + primary slots shrink to a 32px box.
    for (const selector of ["\\.UnicDB-ai-chat-v2-send", "\\.UnicDB-ai-chat-v2-primary"]) {
      const body = ruleBody(selector);
      expect(body).toContain("width: 32px");
      expect(body).toContain("height: 32px");
      expect(body).toContain("min-width: 32px");
      expect(body).toContain("min-height: 32px");
    }
  });

  it("IME composition Enter never submits; the Enter contract is pinned", () => {
    // Composition owns the keystroke: no prevent, no select, no send.
    expect(decideComposerKey(keyInput({ isComposing: true }))).toEqual({ kind: "ignore" });
    expect(decideComposerKey(keyInput({ composing: true }))).toEqual({ kind: "ignore" });
    expect(decideComposerKey(keyInput({ keyCode: 229 }))).toEqual({ kind: "ignore" });
    // Composition outranks even Shift+Enter and an open autocomplete.
    expect(decideComposerKey(keyInput({ isComposing: true, shiftKey: true }))).toEqual({
      kind: "ignore",
    });

    // Plain Enter on a valid idle draft submits exactly once.
    expect(decideComposerKey(keyInput())).toEqual({ kind: "submit" });
    // Shift+Enter always inserts a newline, never submits.
    expect(decideComposerKey(keyInput({ shiftKey: true }))).toEqual({ kind: "insert-newline" });
  });

  it("draft text survives a render round-trip", () => {
    const state = idleValid();
    state.draft.text = "select *";
    view.render(state);
    view.render(state);
    expect(view.prompt.value).toBe("select *");
  });
});
