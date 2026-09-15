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
import { createInitialChatState, type ChatViewState } from "../store";

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
    onContextPreview: (id) => rec.previews.push(id),
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
      schemaChipBtnV2: COMPOSER_IDS.schema,
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
      view.schemaButton,
      view.permissionButton,
      view.primaryButton,
    ]) {
      expect(btn.tagName).toBe("BUTTON");
    }
    expect(view.contextList.tagName).toBe("DIV");
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

  it("emits context preview/remove callbacks from real chip controls", () => {
    view.render(
      idleValid({
        draft: {
          ...createInitialChatState().draft,
          text: "hello",
          context: [{ kind: "table", id: "t1", label: "public.users" }],
        },
      }),
    );
    view.contextList.querySelector<HTMLButtonElement>(".UnicDB-ai-chat-v2-context-chip-body")!.click();
    view.contextList.querySelector<HTMLButtonElement>(".UnicDB-ai-chat-v2-context-chip-remove")!.click();
    expect(cb.previews).toEqual(["t1"]);
    expect(cb.removals).toEqual(["t1"]);
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

  it("clamps measured scrollHeight to 64–160px and scrolls beyond the max", () => {
    stubScrollHeight(view.prompt, 20);
    view.render(idleValid());
    expect(view.prompt.style.height).toBe(`${COMPOSER_AUTO_GROW_MIN_PX}px`);
    expect(view.prompt.classList.contains("UnicDB-ai-chat-v2-input-scroll")).toBe(false);

    stubScrollHeight(view.prompt, 120);
    view.render(idleValid());
    expect(view.prompt.style.height).toBe("120px");

    stubScrollHeight(view.prompt, 400);
    view.render(idleValid());
    expect(view.prompt.style.height).toBe(`${COMPOSER_AUTO_GROW_MAX_PX}px`);
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
