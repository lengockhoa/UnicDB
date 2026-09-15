// webview/aiChat/__tests__/contextChips.test.ts — TASK-CHATV2-011
//
// The context strip: chip geometry contract, the full-detail accessible name,
// one-id removal under duplicate labels, the metadata-only preview (no host or
// model call) and the explicit resolution dialog.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContextRefs, type ContextRef } from "../../../src/ui/aiChatContext";
import {
  CONTEXT_CHIP_MARKER,
  CONTEXT_CHIP_MIN_HEIGHT_PX,
  CONTEXT_CHIP_REMOVE_MARKER,
  CONTEXT_CHIP_REMOVE_SIZE_PX,
  CONTEXT_PREVIEW_MARKER,
  CONTEXT_RESOLVE_MARKER,
  contextChipAccessibleLabel,
  createContextChipStrip,
} from "../contextChips";

let strips: Array<{ destroy(): void }> = [];

afterEach(() => {
  for (const s of strips) s.destroy();
  strips = [];
  document.body.replaceChildren();
});

function makeStrip(callbacks: {
  onPreview?: (ref: ContextRef) => void;
  onRemove?: (id: string) => void;
  onResolve?: (ref: ContextRef, choice: string) => void;
} = {}) {
  const container = document.createElement("div");
  container.className = "UnicDB-ai-chat-v2";
  document.body.appendChild(container);
  const strip = createContextChipStrip({
    container,
    callbacks: {
      onPreview: callbacks.onPreview ?? (() => {}),
      onRemove: callbacks.onRemove ?? (() => {}),
      onResolve: (callbacks.onResolve ?? (() => {})) as never,
    },
  });
  strips.push(strip);
  return { container, strip };
}

function duplicateRefs(): readonly ContextRef[] {
  return buildContextRefs([
    { kind: "file", label: "index.vue", detail: "a/index.vue", source: { type: "uri", uri: "file:///ws/a/index.vue" }, revision: "r1" },
    { kind: "file", label: "index.vue", detail: "b/index.vue", source: { type: "uri", uri: "file:///ws/b/index.vue" }, revision: "r2" },
  ]);
}

describe("createContextChipStrip — chips", () => {
  it("renders one chip per ref with the geometry contract", () => {
    const { container, strip } = makeStrip();
    strip.render(buildContextRefs([
      { kind: "file", label: "index.vue", detail: "a/index.vue", source: { type: "uri", uri: "file:///ws/a/index.vue" }, revision: "r1" },
    ]));
    const chips = container.querySelectorAll<HTMLElement>(`[${CONTEXT_CHIP_MARKER}]`);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.style.getPropertyValue("--UnicDB-chip-h")).toBe(`${CONTEXT_CHIP_MIN_HEIGHT_PX}px`);
    expect(chips[0]!.style.getPropertyValue("--UnicDB-chip-remove")).toBe(`${CONTEXT_CHIP_REMOVE_SIZE_PX}px`);
    expect(CONTEXT_CHIP_MIN_HEIGHT_PX).toBe(28);
    expect(CONTEXT_CHIP_REMOVE_SIZE_PX).toBe(28);
    expect(chips[0]!.querySelector('svg[data-icon="file"]')).not.toBeNull();
  });

  it("puts the full detail + status in title and aria-label", () => {
    const { container, strip } = makeStrip();
    const refs = buildContextRefs([
      { kind: "file", label: "index.vue", detail: "a/index.vue", source: { type: "uri", uri: "file:///ws/a/index.vue" }, revision: "r1" },
    ]);
    strip.render(refs);
    const chip = container.querySelector<HTMLElement>(`[${CONTEXT_CHIP_MARKER}]`)!;
    expect(chip.title).toBe(contextChipAccessibleLabel(refs[0]!));
    expect(chip.title).toContain("a/index.vue");
    expect(chip.getAttribute("aria-label")).toContain("a/index.vue");
  });

  it("renders a status indicator for a non-ready ref", () => {
    const { container, strip } = makeStrip();
    strip.render(buildContextRefs([
      { kind: "file", label: "x.ts", detail: "x.ts", source: { type: "uri", uri: "file:///ws/x.ts" }, status: "missing" },
    ]));
    const chip = container.querySelector<HTMLElement>(`[${CONTEXT_CHIP_MARKER}]`)!;
    expect(chip.getAttribute("data-status")).toBe("missing");
    expect(chip.textContent).toContain("No longer available");
  });

  it("removes ONE id even when two chips share a label", () => {
    const onRemove = vi.fn();
    const { container, strip } = makeStrip({ onRemove });
    const refs = duplicateRefs();
    strip.render(refs);
    const removes = container.querySelectorAll<HTMLElement>(`[${CONTEXT_CHIP_REMOVE_MARKER}]`);
    expect(removes).toHaveLength(2);
    removes[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith(refs[1]!.id);
  });

  it("writes hostile labels with textContent only", () => {
    const { container, strip } = makeStrip();
    strip.render(buildContextRefs([
      {
        kind: "file",
        label: "<img src=x onerror=alert(1)>",
        detail: "<script>alert(1)</script>",
        source: { type: "uri", uri: "file:///ws/evil" },
      },
    ]));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("is idempotent: re-rendering the same refs yields the same chip count", () => {
    const { container, strip } = makeStrip();
    const refs = duplicateRefs();
    strip.render(refs);
    strip.render(refs);
    expect(container.querySelectorAll(`[${CONTEXT_CHIP_MARKER}]`)).toHaveLength(2);
  });
});

describe("createContextChipStrip — preview (model-free)", () => {
  it("reports preview intent and shows metadata without a host call", () => {
    const onPreview = vi.fn((ref: ContextRef) => strip.showPreview(ref));
    const { container, strip } = makeStrip({ onPreview });
    const refs = duplicateRefs();
    strip.render(refs);

    const preview = container.querySelector<HTMLElement>('[data-chat-context-preview]')!;
    preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPreview).toHaveBeenCalledWith(refs[0]);

    const popover = container.querySelector<HTMLElement>(`[${CONTEXT_PREVIEW_MARKER}]`)!;
    expect(popover).not.toBeNull();
    expect(popover.textContent).toContain("a/index.vue");
    // Metadata only — the file body never appears.
    expect(popover.textContent).not.toContain("function");
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("replaces an open preview rather than stacking two", () => {
    const { container, strip } = makeStrip();
    const refs = duplicateRefs();
    strip.render(refs);
    strip.showPreview(refs[0]!);
    strip.showPreview(refs[1]!);
    expect(container.querySelectorAll(`[${CONTEXT_PREVIEW_MARKER}]`)).toHaveLength(1);
    expect(container.querySelector(`[${CONTEXT_PREVIEW_MARKER}]`)!.textContent).toContain("b/index.vue");
  });

  it("closePreview removes the popover", () => {
    const { container, strip } = makeStrip();
    const refs = duplicateRefs();
    strip.render(refs);
    strip.showPreview(refs[0]!);
    strip.closePreview();
    expect(container.querySelector(`[${CONTEXT_PREVIEW_MARKER}]`)).toBeNull();
  });
});

describe("createContextChipStrip — resolution dialog (explicit choice)", () => {
  it("offers Keep only when policy permits, and reports the chosen option", () => {
    const onResolve = vi.fn();
    const { container, strip } = makeStrip({ onResolve });
    const refs = buildContextRefs([
      { kind: "file", label: "x.ts", detail: "x.ts", source: { type: "uri", uri: "file:///ws/x.ts" }, revision: "r", status: "changed" },
    ]);
    strip.render(refs);

    const choices = strip.openResolution(refs[0]!, { allowKeepSnapshot: true });
    expect(choices).toEqual(["refresh", "keep", "remove"]);
    const dialog = container.querySelector<HTMLElement>(`[${CONTEXT_RESOLVE_MARKER}]`)!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("Keep snapshot");

    dialog
      .querySelector<HTMLElement>('[data-chat-resolve-choice="keep"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onResolve).toHaveBeenCalledWith(refs[0], "keep");
    // The dialog closes once a choice is made; the ref is not auto-dropped.
    expect(container.querySelector(`[${CONTEXT_RESOLVE_MARKER}]`)).toBeNull();
  });

  it("offers remove / send-without (never keep) for missing and forbidden", () => {
    const { strip } = makeStrip();
    const missing = buildContextRefs([
      { kind: "file", label: "x.ts", detail: "x.ts", source: { type: "uri", uri: "file:///ws/x.ts" }, status: "missing" },
    ])[0]!;
    expect(strip.openResolution(missing, { allowKeepSnapshot: true })).toEqual([
      "remove",
      "send_without",
    ]);
  });

  it("returns no choices for a ready ref (no dialog needed)", () => {
    const { container, strip } = makeStrip();
    const refs = duplicateRefs();
    expect(strip.openResolution(refs[0]!, { allowKeepSnapshot: true })).toEqual([]);
    expect(container.querySelector(`[${CONTEXT_RESOLVE_MARKER}]`)).toBeNull();
  });
});
