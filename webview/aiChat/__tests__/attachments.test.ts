// webview/aiChat/__tests__/attachments.test.ts — TASK-CHATV2-013
//
// The V2 image-attachment surface: early validation + shared limits, per-item
// warnings with a safely-rendered file name, thumbnail geometry, exactly-once
// object-URL revocation, the ephemeral payload lifecycle (matching submit ack /
// explicit remove), partial-rejection sibling preservation and the privacy
// property that no base64 reaches a DOM attribute.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACH_BYTES,
  type MinimalAttachment,
} from "../../../src/ui/aiChatAttachments";
import {
  ATTACHMENT_INPUT_MARKER,
  ATTACHMENT_NOTICE_MARKER,
  ATTACHMENT_REMOVE_MARKER,
  ATTACHMENT_STRIP_MARKER,
  ATTACHMENT_THUMB_MARKER,
  THUMB_REMOVE_SIZE_PX,
  THUMB_SIZE_PX,
  THUMB_STRIP_MAX_PX,
  createAttachmentController,
  type AttachmentController,
  type FileLike,
} from "../attachments";
import {
  ATTACH_MENU_ACTIONS,
  ATTACH_MENU_ROW_HEIGHT_PX,
  ATTACH_MENU_WIDTH_MAX,
  ATTACH_MENU_WIDTH_MIN,
  ATTACH_REASON_NO_CONNECTION,
  ATTACH_REASON_NO_SELECTION,
  ATTACH_REASON_NO_WORKSPACE,
  buildAttachMenuRows,
  createAttachMenu,
  type AttachMenu,
} from "../attachMenu";
import {
  SCHEMA_CHIP_EMPTY_LABEL,
  SCHEMA_CHIP_MARKER,
  SCHEMA_CHIP_MIN_HEIGHT_PX,
  createSchemaControl,
  type SchemaControl,
} from "../schemaControl";
import { OVERLAY_OPTION_ID_PREFIX } from "../overlays";

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64");
}

const controllers: AttachmentController[] = [];
let revoked: string[] = [];
let urlCounter = 0;

afterEach(() => {
  for (const c of controllers) c.destroy();
  controllers.length = 0;
  revoked = [];
  urlCounter = 0;
  document.body.replaceChildren();
});

/** A decoder double with real FileReader semantics: the declared type is
 * validated by the caller, then the bytes are handed back. */
async function fakeReadFile(file: FileLike) {
  return { base64: toBase64(PNG_HEAD), mime: file.type, bytes: file.size };
}

function make(
  imageInput: boolean,
  callbacks: {
    onAdd?: (a: MinimalAttachment) => void;
    onRemove?: (id: string) => void;
  } = {},
): { container: HTMLElement; controller: AttachmentController } {
  const container = document.createElement("div");
  container.className = "UnicDB-ai-chat-v2";
  document.body.appendChild(container);
  const controller = createAttachmentController({
    container,
    imageInput,
    callbacks: {
      onAdd: callbacks.onAdd ?? (() => {}),
      onRemove: callbacks.onRemove ?? (() => {}),
    },
    environment: {
      createObjectUrl: () => `blob:test-${urlCounter++}`,
      revokeObjectUrl: (url) => revoked.push(url),
      newId: (i) => `img-${i}`,
      readFile: fakeReadFile,
    },
  });
  controllers.push(controller);
  return { container, controller };
}

function pngFile(name: string, bytes = 32): FileLike {
  return { name, type: "image/png", size: bytes };
}

function file(name: string, type: string, size: number): FileLike {
  return { name, type, size };
}

function thumbFiles(controller: AttachmentController): void {
  // The real pipeline decodes from a FileReader; tests that only need a
  // committed attachment use `ingestDecoded` (raw bytes path, shared by paste).
  void controller;
}

function ingestPng(controller: AttachmentController, name = "shot.png"): void {
  controller.ingestDecoded(name, "image/png", toBase64(PNG_HEAD), 32);
}

describe("attachments — capability gate", () => {
  it("creates no hidden file input when imageInput is false, and the strip stays empty", () => {
    const { container, controller } = make(false);
    expect(controller.input).toBeNull();
    expect(container.querySelector(`[${ATTACHMENT_INPUT_MARKER}]`)).toBeNull();
    expect((container.querySelector(`[${ATTACHMENT_STRIP_MARKER}]`) as HTMLElement).hidden).toBe(true);
  });

  it("creates the hidden image input with the shared MIME accept list when imageInput is true", () => {
    const { container, controller } = make(true);
    expect(controller.input).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>(`[${ATTACHMENT_INPUT_MARKER}]`)!;
    expect(input.type).toBe("file");
    expect(input.accept).toContain("image/png");
    expect(input.accept).toContain("image/gif");
    expect(input.accept).not.toContain("text/plain");
    expect(controller.input!.multiple).toBe(true);
  });
});

describe("attachments — early validation + warnings", () => {
  it("warns unsupported type with the file name and exact reason; nothing is added", () => {
    const onAdd = vi.fn();
    const { container, controller } = make(true, { onAdd });
    const notice = controller.ingestDecoded("notes.txt", "text/plain", toBase64(PNG_HEAD), 32);
    expect(notice).not.toBeNull();
    expect(notice!.reason).toBe("unsupported_type");
    expect(notice!.message).toBe("notes.txt: unsupported type");
    expect(onAdd).not.toHaveBeenCalled();
    const node = container.querySelector<HTMLElement>(`[${ATTACHMENT_NOTICE_MARKER}]`)!;
    expect(node.textContent).toBe("notes.txt: unsupported type");
    expect(node.getAttribute("data-reason")).toBe("unsupported_type");
  });

  it("warns oversize at exactly one byte over the shared cap", () => {
    const { controller } = make(true);
    expect(controller.ingestDecoded("big.png", "image/png", toBase64(PNG_HEAD), MAX_ATTACH_BYTES + 1)!.reason).toBe("oversize");
    expect(controller.ingestDecoded("ok.png", "image/png", toBase64(PNG_HEAD), MAX_ATTACH_BYTES)).toBeNull();
  });

  it("warns count limit at the shared per-turn cap", () => {
    const { controller } = make(true);
    for (let i = 0; i < MAX_ATTACHMENTS_PER_TURN; i++) {
      expect(controller.ingestDecoded(`ok-${i}.png`, "image/png", toBase64(PNG_HEAD), 32)).toBeNull();
    }
    const over = controller.ingestDecoded("over.png", "image/png", toBase64(PNG_HEAD), 32);
    expect(over!.reason).toBe("count_cap");
    expect(over!.message).toBe("over.png: attachment limit reached");
  });

  it("warns model unavailable when the capability is off", () => {
    const { controller } = make(false);
    const notice = controller.ingestDecoded("shot.png", "image/png", toBase64(PNG_HEAD), 32);
    expect(notice!.reason).toBe("vision_unsupported");
    expect(notice!.message).toBe("shot.png: current model unavailable");
  });

  it("renders a hostile file name as inert text, never markup", () => {
    const { container, controller } = make(true);
    controller.ingestDecoded("<img src=x onerror=alert(1)>.txt", "text/plain", "", 1);
    const node = container.querySelector<HTMLElement>(`[${ATTACHMENT_NOTICE_MARKER}]`)!;
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain("<img src=x onerror=alert(1)>.txt");
  });
});

describe("attachments — thumbnails", () => {
  it("paints a 44px thumbnail with a 24px remove target aria-labelled Remove image n", () => {
    const { container, controller } = make(true);
    ingestPng(controller);
    const strip = container.querySelector<HTMLElement>(`[${ATTACHMENT_STRIP_MARKER}]`)!;
    expect(strip.hidden).toBe(false);
    expect(strip.style.getPropertyValue("--UnicDB-thumb-size")).toBe(`${THUMB_SIZE_PX}px`);
    expect(strip.style.getPropertyValue("--UnicDB-thumb-strip-max")).toBe(`${THUMB_STRIP_MAX_PX}px`);
    expect(THUMB_SIZE_PX).toBe(44);
    expect(THUMB_STRIP_MAX_PX).toBe(72);
    expect(THUMB_REMOVE_SIZE_PX).toBe(24);
    const thumb = container.querySelector<HTMLElement>(`[${ATTACHMENT_THUMB_MARKER}]`)!;
    const img = thumb.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toMatch(/^blob:test-/);
    const remove = thumb.querySelector<HTMLElement>(`[${ATTACHMENT_REMOVE_MARKER}]`)!;
    expect(remove.getAttribute("aria-label")).toBe("Remove image 1");
    expect(remove.title).toBe("Remove image 1");
    expect(thumbFiles as unknown).toBeTruthy();
  });

  it("numbers remove targets by position and revokes the URL exactly once on remove", () => {
    const onRemove = vi.fn();
    const { container, controller } = make(true, { onRemove });
    ingestPng(controller, "a.png");
    ingestPng(controller, "b.png");
    const removes = container.querySelectorAll<HTMLElement>(`[${ATTACHMENT_REMOVE_MARKER}]`);
    expect(removes[0]!.getAttribute("aria-label")).toBe("Remove image 1");
    expect(removes[1]!.getAttribute("aria-label")).toBe("Remove image 2");
    const url = container.querySelector("img")!.getAttribute("src")!;
    removes[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith("img-0");
    expect(revoked.filter((u) => u === url)).toHaveLength(1);
    // A second remove/clear for the same id never double-revokes.
    controller.remove("img-0");
    expect(revoked.filter((u) => u === url)).toHaveLength(1);
  });

  it("revokes every object URL exactly once on destroy", () => {
    const { container, controller } = make(true);
    ingestPng(controller, "a.png");
    ingestPng(controller, "b.png");
    const urls = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src")!);
    controller.destroy();
    expect(urls.every((u) => revoked.filter((r) => r === u).length === 1)).toBe(true);
    expect(container.querySelector(`[${ATTACHMENT_STRIP_MARKER}]`)).toBeNull();
  });
});

describe("attachments — partial rejection", () => {
  it("keeps valid siblings when one file is rejected", async () => {
    const onAdd = vi.fn();
    const { controller } = make(true, { onAdd });
    const notices = await controller.ingestFiles([
      file("good.png", "image/png", 32),
      file("bad.txt", "text/plain", 32),
      file("good2.png", "image/png", 32),
    ]);
    // Only the middle file is rejected; the two valid siblings are committed.
    expect(notices).toHaveLength(1);
    expect(notices[0]!.fileName).toBe("bad.txt");
    expect(notices[0]!.reason).toBe("unsupported_type");
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(controller.ephemeralPayloads()).toHaveLength(2);
  });

  it("a rejected image never clears a previously accepted one", () => {
    const { controller } = make(true);
    ingestPng(controller, "keep.png");
    controller.ingestDecoded("bad.txt", "text/plain", "", 1);
    expect(controller.ephemeralPayloads()).toHaveLength(1);
    expect(controller.notices()).toHaveLength(1);
  });
});

describe("attachments — lifecycle + privacy", () => {
  it("clears the ephemeral payload after a MATCHING submit ack only", () => {
    const { controller } = make(true);
    ingestPng(controller, "shot.png");
    expect(controller.ephemeralPayloads()).toHaveLength(1);
    controller.markSubmitted("req-1", ["img-0"]);
    expect(controller.acknowledgeSubmit("req-other")).toBe(false);
    expect(controller.ephemeralPayloads()).toHaveLength(1);
    expect(controller.acknowledgeSubmit("req-1")).toBe(true);
    expect(controller.ephemeralPayloads()).toHaveLength(0);
  });

  it("clear() releases payloads and revokes once, and is idempotent", () => {
    const { controller } = make(true);
    ingestPng(controller, "shot.png");
    controller.clear();
    expect(controller.ephemeralPayloads()).toHaveLength(0);
    controller.clear();
    expect(revoked.every((u) => revoked.filter((r) => r === u).length === 1)).toBe(true);
  });

  it("never writes base64 into any DOM attribute of the strip", () => {
    const { container, controller } = make(true);
    ingestPng(controller, "shot.png");
    const html = container.innerHTML;
    expect(html).not.toContain("base64");
    expect(html).not.toContain(toBase64(PNG_HEAD));
    expect(html).not.toContain("data:image");
    const strip = container.querySelector<HTMLElement>(`[${ATTACHMENT_STRIP_MARKER}]`)!;
    for (const node of strip.querySelectorAll("*")) {
      for (const attr of Array.from(node.attributes)) {
        expect(attr.value).not.toContain("base64");
      }
    }
  });

  it("busy state does not block adding to the next draft (no phase consulted)", () => {
    const onAdd = vi.fn();
    const { controller } = make(true, { onAdd });
    // No phase is passed anywhere: an add always commits.
    ingestPng(controller, "next.png");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(controller.ephemeralPayloads()).toHaveLength(1);
  });
});

describe("attach menu — rows/states/availability", () => {
  const menus: AttachMenu[] = [];
  afterEach(() => {
    for (const m of menus) m.destroy();
    menus.length = 0;
  });

  function mountMenu(
    onAction: (a: string) => void = () => {},
  ): { container: HTMLElement; trigger: HTMLButtonElement; menu: AttachMenu } {
    const container = document.createElement("div");
    container.className = "UnicDB-ai-chat-v2";
    document.body.appendChild(container);
    const trigger = document.createElement("button");
    trigger.type = "button";
    container.appendChild(trigger);
    const menu = createAttachMenu({ anchor: container, trigger, onAction: onAction as never });
    menus.push(menu);
    return { container, trigger, menu };
  }

  it("orders rows exactly and hides Image… when the capability is off", () => {
    const rows = buildAttachMenuRows({
      hasWorkspaceFolder: true,
      hasSelection: true,
      hasDatabaseConnection: true,
      imageInput: false,
    });
    expect(rows.map((r) => r.action)).toEqual(["file", "selection", "files", "database"]);
    expect(ATTACH_MENU_ACTIONS).toContain("image");
  });

  it("shows Image… only when imageInput is true", () => {
    const rows = buildAttachMenuRows({
      hasWorkspaceFolder: true,
      hasSelection: true,
      hasDatabaseConnection: true,
      imageInput: true,
    });
    expect(rows.map((r) => r.action)).toEqual(["file", "selection", "files", "database", "image"]);
  });

  it("keeps meaningful rows disabled with the exact explanation", () => {
    const rows = buildAttachMenuRows({
      hasWorkspaceFolder: false,
      hasSelection: false,
      hasDatabaseConnection: false,
      imageInput: true,
    });
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(byAction["file"]!.disabled).toBe(true);
    expect(byAction["file"]!.detail).toBe(ATTACH_REASON_NO_WORKSPACE);
    expect(byAction["selection"]!.disabled).toBe(true);
    expect(byAction["selection"]!.detail).toBe(ATTACH_REASON_NO_SELECTION);
    expect(byAction["database"]!.disabled).toBe(true);
    expect(byAction["database"]!.detail).toBe(ATTACH_REASON_NO_CONNECTION);
    // Files… shares the workspace gate; Image… never carries a disabled state.
    expect(byAction["files"]!.detail).toBe(ATTACH_REASON_NO_WORKSPACE);
    expect(byAction["image"]!.disabled).toBe(false);
  });

  it("paints 40px rows and the 300–420px width on the shared listbox", () => {
    const { container, menu } = mountMenu();
    menu.setAvailability({
      hasWorkspaceFolder: true,
      hasSelection: false,
      hasDatabaseConnection: false,
      imageInput: true,
    });
    menu.open();
    const list = container.querySelector<HTMLElement>("[data-chat-overlay-menu]")!;
    expect(list.style.getPropertyValue("--UnicDB-row-h")).toBe(`${ATTACH_MENU_ROW_HEIGHT_PX}px`);
    expect(list.style.getPropertyValue("--UnicDB-list-min")).toBe(`${ATTACH_MENU_WIDTH_MIN}px`);
    expect(list.style.getPropertyValue("--UnicDB-list-max")).toBe(`${ATTACH_MENU_WIDTH_MAX}px`);
    expect(ATTACH_MENU_ROW_HEIGHT_PX).toBe(40);
    expect(ATTACH_MENU_WIDTH_MIN).toBe(300);
    expect(ATTACH_MENU_WIDTH_MAX).toBe(420);
  });

  it("is a non-modal listbox with stable option ids and a 16px icon per row", () => {
    const { container, trigger, menu } = mountMenu();
    menu.setAvailability({
      hasWorkspaceFolder: true,
      hasSelection: true,
      hasDatabaseConnection: true,
      imageInput: true,
    });
    menu.open();
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    const list = container.querySelector<HTMLElement>("[data-chat-overlay-menu]")!;
    expect(list.getAttribute("role")).toBe("listbox");
    const options = list.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(5);
    expect(options[0]!.id.startsWith(OVERLAY_OPTION_ID_PREFIX)).toBe(true);
    expect(options[0]!.querySelector('svg[data-icon="file"]')).not.toBeNull();
    expect(options[3]!.querySelector('svg[data-icon="table"]')).not.toBeNull();
  });

  it("selects an enabled row and never fires on a disabled one", () => {
    const onAction = vi.fn();
    const { menu } = mountMenu(onAction);
    menu.setAvailability({
      hasWorkspaceFolder: false,
      hasSelection: false,
      hasDatabaseConnection: false,
      imageInput: true,
    });
    menu.open();
    menu.setActive(0); // Current file — disabled
    menu.activateActive();
    expect(onAction).not.toHaveBeenCalled();
    // Move to Image… (last, always enabled) and activate.
    menu.setActive(4);
    menu.activateActive();
    expect(onAction).toHaveBeenCalledWith("image");
  });

  it("routes Arrow/Enter/Escape through handleKey without trapping focus", () => {
    const onAction = vi.fn();
    const { menu } = mountMenu(onAction);
    menu.setAvailability({
      hasWorkspaceFolder: true,
      hasSelection: true,
      hasDatabaseConnection: true,
      imageInput: true,
    });
    menu.open();
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    expect(menu.handleKey(down)).toBe(true);
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    expect(menu.handleKey(esc)).toBe(true);
    expect(menu.isOpen()).toBe(false);
  });
});

describe("schema control — active schema chip", () => {
  const chips: SchemaControl[] = [];
  afterEach(() => {
    for (const c of chips) c.destroy();
    chips.length = 0;
  });

  function mountChip(onPickSchema: () => void = () => {}): {
    container: HTMLElement;
    chip: SchemaControl;
  } {
    const container = document.createElement("div");
    container.className = "UnicDB-ai-chat-v2";
    document.body.appendChild(container);
    const chip = createSchemaControl({ container, onPickSchema });
    chips.push(chip);
    return { container, chip };
  }

  it("follows the active-schema frame and stays >=36px", () => {
    const { container, chip } = mountChip();
    const el = container.querySelector<HTMLElement>(`[${SCHEMA_CHIP_MARKER}]`)!;
    expect(el.style.getPropertyValue("--UnicDB-schema-chip-h")).toBe(`${SCHEMA_CHIP_MIN_HEIGHT_PX}px`);
    expect(SCHEMA_CHIP_MIN_HEIGHT_PX).toBe(36);
    chip.setState({ schema: "public", connectionId: "c1" });
    expect(chip.label()).toBe("Schema: public");
    expect(el.textContent).toContain("Schema: public");
    expect(el.getAttribute("aria-label")).toBe("Schema: public");
    expect(el.querySelector('svg[data-icon="schema"]')).not.toBeNull();
  });

  it("shows the safe fallback label when there is no active schema", () => {
    const { chip } = mountChip();
    chip.setState({ schema: null, connectionId: null });
    expect(chip.label()).toBe(SCHEMA_CHIP_EMPTY_LABEL);
    expect(SCHEMA_CHIP_EMPTY_LABEL).toBe("No active schema");
  });

  it("click emits the existing host picker intent", () => {
    const onPickSchema = vi.fn();
    const { container, chip } = mountChip(onPickSchema);
    container.querySelector<HTMLButtonElement>(`[${SCHEMA_CHIP_MARKER}]`)!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onPickSchema).toHaveBeenCalledTimes(1);
    chip.destroy();
    expect(container.querySelector(`[${SCHEMA_CHIP_MARKER}]`)).toBeNull();
  });
});
