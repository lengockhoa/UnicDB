// webview/aiChat/__tests__/icons.test.ts — TASK-CHATV2-005 (test case #2).
//
// The icon factory is a closed allowlist with a hard "no raw markup" contract.
// These cases pin: every allowlisted name renders real SVG geometry; unknown
// input is rejected into an inert placeholder without ever reaching the DOM.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  CHAT_ICON_NAMES,
  createChatIcon,
  isChatIconName,
} from "../icons";

describe("TASK-CHATV2-005 createChatIcon — closed allowlist", () => {
  it("exposes the exact closed allowlist from the task spec", () => {
    expect([...CHAT_ICON_NAMES].sort()).toEqual(
      [
        "arrow-up",
        "check",
        "chevron-down",
        "chevron-right",
        "copy",
        "database",
        "edit",
        "ellipsis",
        "file",
        "plug",
        "plus",
        "retry",
        "routine",
        "schema",
        "selection",
        "shield-alert",
        "shield-check",
        "slash",
        "spinner",
        "stop-square",
        "table",
        "view",
        "warning",
        "x",
      ].sort(),
    );
  });

  // Case #2 — happy: every allowlisted name renders an SVG with geometry.
  it("renders a 24x24 currentColor aria-hidden SVG for every allowlisted name", () => {
    for (const name of CHAT_ICON_NAMES) {
      const svg = createChatIcon(name, 18);
      expect(svg.tagName.toLowerCase(), `${name}: must be an svg element`).toBe("svg");
      expect(svg.namespaceURI, `${name}: must be in the SVG namespace`).toBe(
        "http://www.w3.org/2000/svg",
      );
      expect(svg.getAttribute("viewBox"), `${name}: viewBox`).toBe("0 0 24 24");
      expect(svg.getAttribute("width"), `${name}: width`).toBe("18");
      expect(svg.getAttribute("height"), `${name}: height`).toBe("18");
      expect(svg.getAttribute("aria-hidden"), `${name}: aria-hidden`).toBe("true");
      expect(svg.getAttribute("data-icon"), `${name}: data-icon`).toBe(name);
      // Geometry must exist and be non-empty.
      const paths = svg.querySelectorAll("path");
      expect(paths.length, `${name}: must contain at least one path`).toBeGreaterThan(0);
      for (const p of Array.from(paths)) {
        const d = p.getAttribute("d") ?? "";
        expect(d.length, `${name}: path d must be non-empty`).toBeGreaterThan(0);
      }
      // Stroked glyphs use currentColor via stroke; solid glyphs via fill.
      const fill = svg.getAttribute("fill");
      const stroke = svg.getAttribute("stroke");
      expect(
        fill === "currentColor" || stroke === "currentColor",
        `${name}: must paint with currentColor`,
      ).toBe(true);
    }
  });

  it("defaults the size to 16px when none is supplied", () => {
    const svg = createChatIcon("database");
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });

  it("falls back to 16px for non-finite or non-positive sizes", () => {
    expect(createChatIcon("check", 0).getAttribute("width")).toBe("16");
    expect(createChatIcon("check", -4).getAttribute("width")).toBe("16");
    expect(createChatIcon("check", Number.NaN).getAttribute("width")).toBe("16");
  });

  // Case #2 — edge (hostile): an unknown name never reaches the DOM.
  it("rejects an unknown name into an inert placeholder (no raw markup)", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const svg = createChatIcon(hostile, 16);
    expect(svg.getAttribute("data-icon")).toBe("unknown");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    // The hostile string must appear NOWHERE in the serialized subtree.
    expect(svg.outerHTML).not.toContain("onerror");
    expect(svg.outerHTML).not.toContain("<img");
    expect(svg.textContent ?? "").toBe("");
    expect(svg.querySelectorAll("img").length).toBe(0);
    // No attribute value may carry the raw input.
    for (const attr of Array.from(svg.attributes)) {
      expect(attr.value).not.toContain(hostile);
    }
  });

  it("returns a fresh element each call and never a string", () => {
    const a = createChatIcon("plus");
    const b = createChatIcon("plus");
    expect(a).not.toBe(b);
    expect(typeof a).not.toBe("string");
    expect(a.outerHTML).not.toContain("innerHTML");
  });

  it("isChatIconName narrows only allowlisted strings", () => {
    expect(isChatIconName("database")).toBe(true);
    expect(isChatIconName("not-an-icon")).toBe(false);
    expect(isChatIconName("<script>")).toBe(false);
    expect(isChatIconName(null)).toBe(false);
    expect(isChatIconName(42)).toBe(false);
  });
});
