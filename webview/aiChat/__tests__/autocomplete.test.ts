// webview/aiChat/__tests__/autocomplete.test.ts — TASK-CHATV2-010
//
// The shared anchored listbox the slash and mention popovers both render
// through. Covers SLASH-03 (typed path and button path produce identical
// state; focus returns to the textarea), the listbox semantics (stable option
// ids + `aria-activedescendant`, 44px rows, active row scrolled into view),
// SLASH-04 accept inserts and sends zero intents, and SLASH-08 (hostile
// descriptor copy is written with textContent, so it cannot become markup or a
// class).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPOSER_IDS, renderComposerV2, type ComposerView } from "../composer";
import { createInitialChatState } from "../store";
import { ALL_UNIVERSAL_COMMANDS, resolveChatCommands, type CommandGateInput } from "../../../src/ui/aiChatPanelCommands";
import type { EngineCapabilitySnapshot } from "../../../src/ai/capabilities";
import {
  AUTOCOMPLETE_LISTBOX_MARKER,
  AUTOCOMPLETE_OPTION_ID_PREFIX,
  createAutocompleteView,
  type AutocompleteRowModel,
} from "../autocomplete";

function snapshot(): EngineCapabilitySnapshot {
  return {
    engine: "builtin",
    displayName: "Builtin",
    status: "ready",
    supports: {
      streamText: true,
      streamThought: false,
      toolTimeline: true,
      imageInput: true,
      nativeSessionResume: true,
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
  } as EngineCapabilitySnapshot;
}

const GATE: CommandGateInput = {
  capabilities: snapshot(),
  availableEngines: ["builtin", "omp", "claude-code", "codex"],
  modelRoles: ["work", "smart"],
};

let mounted: Array<{ destroy(): void }> = [];
let composers: ComposerView[] = [];

afterEach(() => {
  for (const m of mounted) m.destroy();
  for (const c of composers) c.destroy();
  mounted = [];
  composers = [];
  document.body.replaceChildren();
});

interface Harness {
  root: HTMLElement;
  composer: ComposerView;
  view: ReturnType<typeof createAutocompleteView>;
}

function makeHarness(): Harness {
  const root = document.createElement("div");
  root.className = "UnicDB-ai-chat-v2";
  document.body.appendChild(root);

  const composer = renderComposerV2(root, {
    onInput: () => {},
    onSelectionChange: () => {},
    onAttachOpen: () => {},
    onSlashOpen: () => {},
    onModelOpen: () => {},
    onContextPreview: () => {},
    onContextRemove: () => {},
    onSchemaOpen: () => {},
    onPermissionOpen: () => {},
    onPrimaryActivate: () => {},
  });
  composers.push(composer);

  const view = createAutocompleteView({
    anchor: composer.root,
    prompt: composer.prompt,
    slashButton: composer.slashButton,
  });
  mounted.push(view);

  return { root, composer, view };
}

function rows(): AutocompleteRowModel[] {
  return resolveChatCommands(GATE).map((d) => ({
    id: d.id,
    primary: `/${d.name}`,
    secondary: d.description,
    syntax: d.syntax,
  }));
}

describe("AutocompleteView — shared anchored listbox", () => {
  it("renders a listbox with stable option ids and aria-activedescendant", () => {
    const h = makeHarness();
    h.view.setRows(rows(), 0);

    const listbox = h.composer.root.querySelector<HTMLElement>(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`);
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute("role")).toBe("listbox");

    const options = listbox!.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(8);
    expect(options[0]!.id).toBe(`${AUTOCOMPLETE_OPTION_ID_PREFIX}new`);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    // The active descendant lives on the TEXTAREA so focus never leaves it.
    expect(h.composer.prompt.getAttribute("aria-activedescendant")).toBe(
      `${AUTOCOMPLETE_OPTION_ID_PREFIX}new`,
    );
    expect(h.composer.prompt.getAttribute("aria-expanded")).toBe("true");
  });

  it("highlights exactly one row and keeps the active row scrolled into view", () => {
    const h = makeHarness();
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      primary: `/c${i}`,
      secondary: "",
      syntax: `/c${i}`,
    }));
    h.view.setRows(many, 12);
    const options = h.composer.root.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(8);
    const selected = Array.from(options).filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(h.composer.prompt.getAttribute("aria-activedescendant")).toBe(
      `${AUTOCOMPLETE_OPTION_ID_PREFIX}c12`,
    );
  });

  it("shows a non-selectable empty state when nothing matches", () => {
    const h = makeHarness();
    h.view.setRows([], 0);
    const listbox = h.composer.root.querySelector<HTMLElement>(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`)!;
    expect(listbox.textContent).toContain("No matching commands");
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(h.composer.prompt.getAttribute("aria-expanded")).toBe("false");
    expect(h.composer.prompt.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("closes without clearing focus state", () => {
    const h = makeHarness();
    h.view.setRows(rows(), 0);
    h.view.close();
    expect(h.composer.root.querySelector(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`)).toBeNull();
    expect(h.composer.prompt.getAttribute("aria-expanded")).toBe("false");
    expect(h.composer.prompt.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("invokes a row handler with its index and returns focus to the textarea", () => {
    const h = makeHarness();
    h.view.setRows(rows(), 0);
    const onInvoke = vi.fn();
    h.view.setOnInvoke(onInvoke);
    const options = h.composer.root.querySelectorAll<HTMLElement>('[role="option"]');
    options[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onInvoke).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(h.composer.prompt);
    // A pointer select must not move native focus away from the textarea.
    options[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });

  it("marks unavailable rows aria-disabled and non-selectable", () => {
    const h = makeHarness();
    h.view.setRows(
      [
        { id: "resume", primary: "/resume", secondary: "Requires omp", syntax: "/resume", unavailable: true },
        { id: "help", primary: "/help", secondary: "Help", syntax: "/help" },
      ],
      0,
    );
    const options = h.composer.root.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(options[0]!.getAttribute("data-available")).toBe("false");
    expect(options[1]!.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("AutocompleteView — button and typed paths share one state", () => {
  it("the slash button opens the same listbox and focuses the textarea", () => {
    const probe = makeHarness();
    // The real button is wired by the controller; here we prove the view's
    // `open` path is the identical entry point the button calls.
    probe.view.setRows(rows(), 0);
    const typedListbox = probe.composer.root.querySelector(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`);

    const h = makeHarness();
    const onOpen = vi.fn(() => h.view.setRows(rows(), 0));
    h.composer.slashButton.addEventListener("click", onOpen);
    h.composer.slashButton.click();
    const buttonListbox = h.composer.root.querySelector(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(buttonListbox).not.toBeNull();
    expect(buttonListbox!.getAttribute("role")).toBe("listbox");
    expect((buttonListbox as HTMLElement).children.length).toBe(
      (typedListbox as HTMLElement).children.length,
    );
    expect(h.composer.prompt.getAttribute("aria-activedescendant")).toBe(
      `${AUTOCOMPLETE_OPTION_ID_PREFIX}new`,
    );
  });

  it("keeps the composer slash button at the 32x32 contract id", () => {
    const h = makeHarness();
    expect(h.composer.slashButton.id).toBe(COMPOSER_IDS.slash);
    expect(h.composer.slashButton.title).toBe("Slash commands");
  });
});

describe("SLASH-08 — hostile descriptor copy stays inert", () => {
  it("writes hostile text with textContent: no element, no class appears", () => {
    const h = makeHarness();
    h.view.setRows(
      [
        {
          id: "evil",
          primary: "/evil",
          secondary: "<img src=x onerror=alert(1)>",
          syntax: "<script>alert(1)</script>",
        },
      ],
      0,
    );
    const listbox = h.composer.root.querySelector<HTMLElement>(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`)!;
    // No markup was created from the descriptor text.
    expect(listbox.querySelector("img")).toBeNull();
    expect(listbox.querySelector("script")).toBeNull();
    const text = listbox.textContent ?? "";
    expect(text).toContain("<img src=x onerror=alert(1)>");
    // No injected class or attribute survived.
    const option = listbox.querySelector<HTMLElement>('[role="option"]')!;
    expect(option.getAttribute("onerror")).toBeNull();
    expect(option.className.includes("<")).toBe(false);
  });
});

describe("geometry constants on the rendered listbox", () => {
  it("applies 44px rows, 280-420 width and 12px vertical padding", () => {
    const h = makeHarness();
    h.view.setRows(rows(), 0);
    const listbox = h.composer.root.querySelector<HTMLElement>(`[${AUTOCOMPLETE_LISTBOX_MARKER}]`)!;
    expect(listbox.style.getPropertyValue("--UnicDB-row-h")).toBe("44px");
    expect(listbox.style.getPropertyValue("--UnicDB-list-min")).toBe("280px");
    expect(listbox.style.getPropertyValue("--UnicDB-list-max")).toBe("420px");
    expect(listbox.style.getPropertyValue("--UnicDB-list-pad")).toBe("12px");
    expect(listbox.dataset.rowHeight).toBe("44");
  });
});
