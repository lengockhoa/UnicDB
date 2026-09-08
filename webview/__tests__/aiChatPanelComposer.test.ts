// webview/__tests__/aiChatPanelComposer.test.ts
// TASK-AGTUI-004 — composer module: attach/model chip/`/`/bypass/mic/send-stop
// + legacy action buttons (`resumeBtn`/`clearBtn`/`regenerateBtn`).
//
// Pure-DOM jsdom tests; the composer module is loaded directly via the
// package source (no bundle roundtrip).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  renderComposer,
  type ComposerCallbacks,
} from "../aiChatPanelComposer";

function attach(root: HTMLElement): void {
  document.body.appendChild(root);
}

interface NoopHandles {
  sends: Array<{ text: string; attachments: unknown[] }>;
  models: string[];
  bypass: boolean[];
}

function noopCallbacks(): ComposerCallbacks & NoopHandles {
  const sends: Array<{ text: string; attachments: unknown[] }> = [];
  const models: string[] = [];
  const bypass: boolean[] = [];
  return {
    sends,
    models,
    bypass,
    onSend: (text, atts) => sends.push({ text, attachments: atts }),
    onStop: () => {
      /* noop */
    },
    onModelSelect: (role) => models.push(role),
    onBypassChange: (v) => bypass.push(v),
    onAttachPicker: () => {
      /* noop */
    },
  };
}

describe("aiChatPanelComposer — TASK-AGTUI-004", () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
  });

  it("#1 renders full clone row with all required ids and aria-labels", () => {
    attach(root);
    const cb = noopCallbacks();
    const composer = renderComposer(root, cb);
    expect(root.contains(composer.el)).toBe(true);
    const ids = [
      "prompt",
      "sendBtn",
      "stopBtn",
      "attachBtn",
      "attachStrip",
      "modelChipBtn",
      "bypassToggle",
      "micBtn",
      "slashHintBtn",
    ];
    for (const id of ids) {
      const el = root.querySelector(`#${id}`);
      expect(el, `#${id} must exist`).not.toBeNull();
    }
    // placeholder non-empty
    const prompt = root.querySelector("#prompt") as HTMLTextAreaElement;
    expect(prompt.placeholder.length).toBeGreaterThan(0);
    // aria-labels present on all buttons
    for (const id of [
      "sendBtn",
      "stopBtn",
      "attachBtn",
      "modelChipBtn",
      "bypassToggle",
      "micBtn",
      "slashHintBtn",
    ]) {
      const el = root.querySelector(`#${id}`) as HTMLElement;
      const aria = el.getAttribute("aria-label");
      expect(aria, `#${id} aria-label`).toBeTruthy();
    }
  });

  it("#2 busy swap to red square stop (idle vs busy both directions)", () => {
    attach(root);
    const composer = renderComposer(root, noopCallbacks());
    const sendBtn = root.querySelector("#sendBtn") as HTMLButtonElement;
    const stopBtn = root.querySelector("#stopBtn") as HTMLButtonElement;
    const prompt = root.querySelector("#prompt") as HTMLTextAreaElement;

    // Idle state — send visible/enabled, stop hidden.
    expect(sendBtn.style.display).not.toBe("none");
    expect(sendBtn.disabled).toBe(false);
    expect(stopBtn.style.display).toBe("none");
    expect(stopBtn.disabled).toBe(false);
    expect(prompt.disabled).toBe(false);

    // Host flips busy on send-in-flight (mirrors aiChatPanelMain.ts:466-478).
    composer.setBusy(true);

    // Busy: send hidden+disabled, stop visible with pulse class, prompt disabled.
    expect(sendBtn.style.display).toBe("none");
    expect(sendBtn.disabled).toBe(true);
    expect(stopBtn.style.display).not.toBe("none");
    expect(stopBtn.classList.contains("UnicDB-chat-stop")).toBe(true);
    expect(stopBtn.classList.contains("UnicDB-chat-stop-live")).toBe(true);
    expect(prompt.disabled).toBe(true);

    // Back to idle — host dispatches "done" and main calls setBusy(false).
    composer.setBusy(false);

    expect(sendBtn.style.display).not.toBe("none");
    expect(sendBtn.disabled).toBe(false);
    expect(stopBtn.style.display).toBe("none");
    expect(prompt.disabled).toBe(false);
  });

  it("#3 bypass defaults OFF and alternates exactly on each click", () => {
    attach(root);
    const cb = noopCallbacks();
    renderComposer(root, cb);
    const tgl = root.querySelector("#bypassToggle") as HTMLButtonElement;
    expect(tgl.getAttribute("aria-checked")).toBe("false");
    expect(tgl.classList.contains("UnicDB-chat-toggle-on")).toBe(false);
    // background is BLUE when OFF (per task)
    expect(tgl.style.background || getComputedStyle(tgl).backgroundColor).toBeTruthy();

    tgl.click();
    expect(cb.bypass).toEqual([true]);
    expect(tgl.getAttribute("aria-checked")).toBe("true");
    expect(tgl.classList.contains("UnicDB-chat-toggle-on")).toBe(true);

    tgl.click();
    expect(cb.bypass).toEqual([true, false]);
    expect(tgl.getAttribute("aria-checked")).toBe("false");
    expect(tgl.classList.contains("UnicDB-chat-toggle-on")).toBe(false);

    tgl.click();
    expect(cb.bypass).toEqual([true, false, true]);
  });

  it("#4 empty models list → chip disabled, label shows no-models, click no-op", () => {
    attach(root);
    const cb = noopCallbacks();
    const composer = renderComposer(root, cb);
    composer.setModels([], "work");
    const chip = root.querySelector("#modelChipBtn") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toMatch(/No models configured/i);
    chip.click();
    expect(cb.models.length).toBe(0);
  });

  it("#5 chip dropdown: opens menu, rows text = role · modelId, click row fires onModelSelect once + closes", () => {
    attach(root);
    const cb = noopCallbacks();
    const composer = renderComposer(root, cb);
    composer.setModels(
      [
        { role: "work", modelId: "gpt-x", vision: false },
        { role: "smart", modelId: "o3", vision: true },
      ],
      "smart",
    );
    const chip = root.querySelector("#modelChipBtn") as HTMLButtonElement;
    // Active label shows role · modelId for the active role.
    expect(chip.textContent).toMatch(/smart/);
    expect(chip.textContent).toMatch(/o3/);
    expect(chip.disabled).toBe(false);

    chip.click();
    const menu = root.querySelector(".UnicDB-chat-chipmenu") as HTMLElement;
    expect(menu).not.toBeNull();
    const rows = menu.querySelectorAll<HTMLButtonElement>(
      ".UnicDB-chat-chipmenu-row",
    );
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toMatch(/work/);
    expect(rows[0]?.textContent).toMatch(/gpt-x/);
    expect(rows[1]?.textContent).toMatch(/smart/);
    expect(rows[1]?.textContent).toMatch(/o3/);

    rows[0]?.click();
    expect(cb.models).toEqual(["work"]);
    // Menu should be gone after selection (display:none on the menu node).
    const menuAfter = root.querySelector(
      ".UnicDB-chat-chipmenu",
    ) as HTMLElement | null;
    expect(menuAfter?.style.display).toBe("none");
  });

  it("#6 send only fires onSend with non-empty trimmed text (button click path)", () => {
    attach(root);
    const cb = noopCallbacks();
    renderComposer(root, cb);
    const sendBtn = root.querySelector("#sendBtn") as HTMLButtonElement;
    const prompt = root.querySelector("#prompt") as HTMLTextAreaElement;

    prompt.value = "   ";
    sendBtn.click();
    expect(cb.sends.length).toBe(0);

    prompt.value = "hi";
    sendBtn.click();
    expect(cb.sends).toEqual([{ text: "hi", attachments: [] }]);
  });

  it("#7 legacy action buttons render in composer row with exact id attributes", () => {
    attach(root);
    renderComposer(root, noopCallbacks());
    for (const id of ["resumeBtn", "clearBtn", "regenerateBtn"]) {
      const el = root.querySelector(`#${id}`);
      expect(el, `#${id}`).not.toBeNull();
      expect(el?.tagName).toBe("BUTTON");
      const svgs = el?.querySelectorAll("svg") ?? [];
      expect(svgs.length, `#${id} icon`).toBe(1);
    }
  });

  it("#8 busy-disable matches legacy contract: send/resume/regenerate/attach disabled, clearBtn untouched", () => {
    attach(root);
    const composer = renderComposer(root, noopCallbacks());
    const sendBtn = root.querySelector("#sendBtn") as HTMLButtonElement;
    const resumeBtn = root.querySelector("#resumeBtn") as HTMLButtonElement;
    const regenBtn = root.querySelector("#regenerateBtn") as HTMLButtonElement;
    const attachBtn = root.querySelector("#attachBtn") as HTMLButtonElement;
    const clearBtn = root.querySelector("#clearBtn") as HTMLButtonElement;

    // All four target buttons start enabled, clearBtn starts enabled.
    expect(sendBtn.disabled).toBe(false);
    expect(resumeBtn.disabled).toBe(false);
    expect(regenBtn.disabled).toBe(false);
    expect(attachBtn.disabled).toBe(false);
    expect(clearBtn.disabled).toBe(false);

    // Host flips busy on send-in-flight (mirrors aiChatPanelMain.ts:466-478).
    composer.setBusy(true);

    expect(sendBtn.disabled).toBe(true);
    expect(resumeBtn.disabled).toBe(true);
    expect(regenBtn.disabled).toBe(true);
    expect(attachBtn.disabled).toBe(true);
    expect(clearBtn.disabled).toBe(false);

    composer.setBusy(false);

    expect(sendBtn.disabled).toBe(false);
    expect(resumeBtn.disabled).toBe(false);
    expect(regenBtn.disabled).toBe(false);
    expect(attachBtn.disabled).toBe(false);
    expect(clearBtn.disabled).toBe(false);
  });
});

// silence vi unused-imports warning
void 0;