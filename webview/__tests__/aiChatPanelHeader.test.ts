// webview/__tests__/aiChatPanelHeader.test.ts — TASK-AGTUI-003
//
// Pure-DOM unit tests for webview/aiChatPanelHeader.ts. Verifies the
// Claude Code-style header bar: large BLUE "U" brand glyph,
// engine-aware title (#engineBanner), and the AIX-05 #sessionChip
// element with the legacy closed-set label/class map.
//
// Harness: a fresh empty jsdom document per test. No vscode, no
// extension imports — the module is webview-safe (TASK-AGTUI-007 wires
// it into the live document later).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHeader, type UnicDBHeader } from "../aiChatPanelHeader";

let root: HTMLDivElement;
let header: UnicDBHeader;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  root.id = "UnicDB-root";
  document.body.appendChild(root);
  header = renderHeader(root);
});

afterEach(() => {
  document.body.innerHTML = "";
});

function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`expected selector ${selector}`);
  return node as T;
}

describe("TASK-AGTUI-003 — header module (happy)", () => {
  it("renders brand glyph U + static UnicDB AI title + appends itself to root", () => {
    expect(header.el).toBeInstanceOf(HTMLElement);
    expect(header.el.classList.contains("UnicDB-chat-header")).toBe(true);
    expect(root.contains(header.el)).toBe(true);

    const brand = el<HTMLSpanElement>("#chatBrandMark");
    expect(brand.textContent).toBe("U");
    expect(brand.classList.contains("UnicDB-chat-brand")).toBe(true);
    expect(brand.getAttribute("aria-hidden")).toBe("true");
    expect(brand.getAttribute("title")).toBe("UnicDB");

    // Static title node — never wire-derived.
    const titles = header.el.querySelectorAll(
      ".UnicDB-chat-title",
    );
    expect(titles.length).toBeGreaterThanOrEqual(1);
    const staticTitle = Array.from(titles).find(
      (n) => n.textContent === "UnicDB AI",
    );
    expect(staticTitle, "static title node 'UnicDB AI' must exist").toBeTruthy();
  });

  it("setEngine('claude-code') -> 'Engine: Claude Code — streaming' + legacy classes", () => {
    header.setEngine("claude-code");
    const banner = el<HTMLDivElement>("#engineBanner");
    expect(banner.textContent).toBe("Engine: Claude Code — streaming");
    expect(banner.classList.contains("UnicDB-chat-engine")).toBe(true);
    expect(banner.classList.contains("UnicDB-chat-engine-claude-code")).toBe(true);

    // Static title node still 'UnicDB AI' (never wire-derived).
    const titles = header.el.querySelectorAll(".UnicDB-chat-title");
    const staticTitle = Array.from(titles).find(
      (n) => n.textContent === "UnicDB AI",
    );
    expect(staticTitle).toBeTruthy();
  });
});

describe("TASK-AGTUI-003 — header module (edge: malformed input)", () => {
  it("unknown engine falls back to the closed-set builtin label + class", () => {
    header.setEngine("skynet" as never);
    const banner = el<HTMLDivElement>("#engineBanner");
    expect(banner.textContent).toBe("Engine: builtin — streaming");
    expect(banner.classList.contains("UnicDB-chat-engine-builtin")).toBe(true);
    // Raw wire value never reaches classList/textContent.
    expect(banner.className.includes("skynet")).toBe(false);
    expect(banner.textContent?.includes("skynet")).toBe(false);
    // Static title node unchanged.
    const staticTitle = Array.from(
      header.el.querySelectorAll(".UnicDB-chat-title"),
    ).find((n) => n.textContent === "UnicDB AI");
    expect(staticTitle).toBeTruthy();
  });
});

describe("TASK-AGTUI-003 — header module (edge: version boundary)", () => {
  it("with version appends ' v<ver>' before the — state", () => {
    header.setEngine("omp", "18.0.1");
    const banner = el<HTMLDivElement>("#engineBanner");
    expect(banner.textContent).toBe(
      "Engine: oh-my-pi (omp) v18.0.1 — streaming",
    );
  });

  it("absent version renders no version fragment (no stray 'undefined')", () => {
    header.setEngine("omp");
    const banner = el<HTMLDivElement>("#engineBanner");
    expect(banner.textContent).toBe("Engine: oh-my-pi (omp) — streaming");
    expect(banner.textContent).not.toContain("undefined");
  });

  it("empty-string version is treated as absent", () => {
    header.setEngine("omp", "");
    const banner = el<HTMLDivElement>("#engineBanner");
    expect(banner.textContent).toBe("Engine: oh-my-pi (omp) — streaming");
    expect(banner.textContent).not.toContain("undefined");
  });
});

describe("TASK-AGTUI-003 — session chip (edge: state repeat)", () => {
  it("reuses one node across calls; class swaps to current state + clone class", () => {
    header.setSessionState("connecting");
    header.setSessionState("running");

    const chips = document.querySelectorAll("#sessionChip");
    expect(chips.length).toBe(1);

    const chip = el<HTMLSpanElement>("#sessionChip");
    expect(chip.tagName).toBe("SPAN");
    // Legacy classes preserved + additive clone class.
    expect(chip.classList.contains("UnicDB-chat-session")).toBe(true);
    expect(chip.classList.contains("UnicDB-chat-session-running")).toBe(true);
    expect(chip.classList.contains("UnicDB-chat-sessionchip")).toBe(true);
    // Old state suffix should NOT linger.
    expect(chip.classList.contains("UnicDB-chat-session-connecting")).toBe(
      false,
    );
    // textContent-only — no ELEMENT child nodes (text node from
    // textContent assignment is fine; the legacy
    // aiChatPanelSessionStateWebview.test.ts:116 assertion uses
    // `querySelectorAll("*").length` for the same guarantee).
    expect(chip.querySelectorAll("*").length).toBe(0);
    expect(chip.textContent).toBe("Running…");
    // textContent-only — label is a plain string, no markup.
    expect(chip.innerHTML).toBe("Running…");
  });

  it("closed-set label map: Connecting… / Done / Error", () => {
    header.setSessionState("connecting");
    expect(el("#sessionChip").textContent).toBe("Connecting…");

    header.setSessionState("done");
    expect(el("#sessionChip").textContent).toBe("Done");

    header.setSessionState("error");
    expect(el("#sessionChip").textContent).toBe("Error");
    expect(
      el("#sessionChip").classList.contains("UnicDB-chat-session-error"),
    ).toBe(true);
  });

  it("null removes the chip entirely", () => {
    header.setSessionState("connecting");
    expect(document.querySelectorAll("#sessionChip").length).toBe(1);
    header.setSessionState(null);
    expect(document.querySelectorAll("#sessionChip").length).toBe(0);
  });
});

describe("TASK-AGTUI-003 — XSS defense-in-depth", () => {
  it("hostile engine name falls back to builtin label/class, never raw text", () => {
    const hostile = "<img onerror=alert(1) src=x>";
    header.setEngine(hostile as never);
    const banner = el<HTMLDivElement>("#engineBanner");
    // Whitelist closes the door: raw hostile string is dropped to builtin.
    expect(banner.textContent).toBe("Engine: builtin — streaming");
    expect(banner.classList.contains("UnicDB-chat-engine-builtin")).toBe(true);
    expect(banner.querySelectorAll("img").length).toBe(0);
    // Hostile fragment never reaches className verbatim.
    expect(banner.className.includes("img")).toBe(false);
    expect(banner.className.includes("onerror")).toBe(false);
  });
});
