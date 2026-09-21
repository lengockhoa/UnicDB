// webview/aiChat/__tests__/shell.test.ts — TASK-CHATV2-005
//
// Covers test cases #1 (semantic shell), #3 (idempotent repeated mount),
// #4 (CSS leakage / scoping) and #5 (responsive primitives). The icon
// allowlist lives in icons.test.ts; the compiled bundle marker lives in
// src/ui/__tests__/aiChatPanelBundle.test.ts.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_V2_ALERT_LIVE_ID,
  CHAT_V2_LISTENER_MARKER,
  CHAT_V2_ROOT_CLASS,
  CHAT_V2_SCREENSHOT_FIXTURES,
  CHAT_V2_SHELL_MARKER,
  CHAT_V2_STATUS_LIVE_ID,
  mountChatShell,
} from "../shell";

const ROOT_CLASSES = ["UnicDB-chat", CHAT_V2_ROOT_CLASS];

function makeRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = "UnicDB-root";
  root.className = ROOT_CLASSES.join(" ");
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("TASK-CHATV2-005 mountChatShell — semantic shell (#1)", () => {
  it("mounts exactly one header, main and composer", () => {
    const root = makeRoot();
    mountChatShell(root);
    expect(root.querySelectorAll("header, [class*='-header']").length).toBeGreaterThanOrEqual(1);
    expect(root.querySelectorAll(`.${CHAT_V2_ROOT_CLASS}-header`).length).toBe(1);
    expect(root.querySelectorAll("main").length).toBe(1);
    expect(root.querySelectorAll(`.${CHAT_V2_ROOT_CLASS}-composer`).length).toBe(1);
  });

  it("mounts exactly two visually-hidden live regions with stable ids", () => {
    const root = makeRoot();
    mountChatShell(root);

    const status = document.getElementById(CHAT_V2_STATUS_LIVE_ID);
    const alert = document.getElementById(CHAT_V2_ALERT_LIVE_ID);
    expect(status, "polite status live region must exist").not.toBeNull();
    expect(alert, "assertive alert live region must exist").not.toBeNull();
    expect(status!.getAttribute("aria-live")).toBe("polite");
    expect(alert!.getAttribute("aria-live")).toBe("assertive");

    // Both are visually hidden (class), and NOT display:none.
    for (const region of [status!, alert!]) {
      expect(
        region.classList.contains(`${CHAT_V2_ROOT_CLASS}-visually-hidden`),
        "live region must carry the visually-hidden utility class",
      ).toBe(true);
      expect(region.getAttribute("aria-hidden")).not.toBe("true");
    }

    // Exactly two aria-live regions in the shell.
    expect(
      root.querySelectorAll("[aria-live]").length,
      "the shell must expose exactly two aria-live regions",
    ).toBe(2);
  });

  it("exposes the header mark/title, engine pill and 32x32 overflow", () => {
    const root = makeRoot();
    mountChatShell(root);
    const refs = mountChatShell(root);
    expect(refs.header.querySelector(`.${CHAT_V2_ROOT_CLASS}-mark svg`)).not.toBeNull();
    expect(refs.header.querySelector(`.${CHAT_V2_ROOT_CLASS}-title`)?.textContent).toBe("UnicDB AI");
    expect(refs.header.querySelector(`.${CHAT_V2_ROOT_CLASS}-engine`)).not.toBeNull();
    expect(refs.header.querySelector(`.${CHAT_V2_ROOT_CLASS}-overflow`)).not.toBeNull();
  });

  it("returns refs whose mount points are all live children of the root", () => {
    const root = makeRoot();
    const refs = mountChatShell(root);
    expect(refs.root).toBe(root);
    for (const el of [
      refs.header,
      refs.banner,
      refs.main,
      refs.composer,
      refs.hint,
      refs.statusLiveRegion,
      refs.alertLiveRegion,
    ]) {
      expect(el.isConnected, "every mount point must be connected").toBe(true);
      expect(root.contains(el), "every mount point must live inside the root").toBe(true);
    }
    expect(refs.main.contains(refs.transcript)).toBe(true);
    expect(refs.main.contains(refs.context)).toBe(true);
    expect(refs.composer.contains(refs.composerTop)).toBe(true);
    expect(refs.composer.contains(refs.composerBottom)).toBe(true);
  });
});

describe("TASK-CHATV2-005 mountChatShell — repeated mount (#3)", () => {
  it("is idempotent: a second mount adds no duplicate root/header/live region", () => {
    const root = makeRoot();
    const first = mountChatShell(root);
    const second = mountChatShell(root);

    expect(second).toBe(first); // same refs object
    expect(document.querySelectorAll("#UnicDB-root").length).toBe(1);
    expect(root.querySelectorAll(`.${CHAT_V2_ROOT_CLASS}-header`).length).toBe(1);
    expect(root.querySelectorAll(`.${CHAT_V2_ROOT_CLASS}-composer`).length).toBe(1);
    expect(root.querySelectorAll("[aria-live]").length).toBe(2);
    expect(document.querySelectorAll(`#${CHAT_V2_STATUS_LIVE_ID}`).length).toBe(1);
    expect(document.querySelectorAll(`#${CHAT_V2_ALERT_LIVE_ID}`).length).toBe(1);
  });

  it("marks the root and never double-binds listeners", () => {
    const root = makeRoot();
    mountChatShell(root);
    const firstCount = root.getAttribute(CHAT_V2_LISTENER_MARKER);
    mountChatShell(root);
    mountChatShell(root);
    expect(root.getAttribute(CHAT_V2_SHELL_MARKER)).toBe("1");
    expect(root.getAttribute(CHAT_V2_LISTENER_MARKER)).toBe(firstCount);
    expect(Number(firstCount)).toBeGreaterThan(0);
  });
});

// ---- CSS scoping + responsive primitives (#4, #5) -------------------------

const cssPath = resolve(process.cwd(), "webview", "aiChat", "styles.css");
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

describe("TASK-CHATV2-005 V2 scoped styles (#4 leakage)", () => {
  it("loads webview/aiChat/styles.css as a NEW V2-only file", () => {
    expect(css, "webview/aiChat/styles.css must exist").not.toBe("");
    // Legacy stylesheet must be untouched by this task's file.
    const legacyPath = resolve(process.cwd(), "webview", "styles.css");
    const legacy = existsSync(legacyPath) ? readFileSync(legacyPath, "utf8") : "";
    expect(legacy).not.toContain(".UnicDB-ai-chat-v2");
  });

  it("scopes every selector to .UnicDB-ai-chat-v2 (or namespaced utility)", () => {
    // Strip comments + at-rule prelude blocks, then collect top-level and
    // nested selectors; each must be V2-scoped, a namespaced keyframe step,
    // or a namespaced keyframes/at-rule name.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // Remove @media / @supports wrappers but keep their inner selectors.
    const withoutAt = stripped
      .replace(/@media[^{]*\{/g, "")
      .replace(/@supports[^{]*\{/g, "");
    const selectors = Array.from(withoutAt.matchAll(/([^{}]+)\{/g))
      .map((m) => m[1].trim())
      .filter((s) => s.length > 0)
      .filter((s) => !s.startsWith("@keyframes"))
      .filter((s) => !/^\d+%$|^from$|^to$/i.test(s));

    for (const sel of selectors) {
      // Handle comma-separated selector lists.
      for (const part of sel.split(",")) {
        const token = part.trim();
        if (token.length === 0) continue;
        // Skip @keyframes step selectors (`0%`, `50%`, `from`, `to`) — they
        // are namespaced by their @keyframes name, not by a class.
        if (/^\d+%$|^from$|^to$/i.test(token)) continue;
        expect(
          token.includes(".UnicDB-ai-chat-v2"),
          `V2 stylesheet selector must be scoped to .UnicDB-ai-chat-v2: "${token}"`,
        ).toBe(true);
      }
    }
    // Balanced braces.
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it("declares no global .button/.chat selector or remote asset", () => {
    expect(/(^|\n)\s*\.button\s*\{/.test(css)).toBe(false);
    expect(/(^|\n)\s*\.chat\s*\{/.test(css)).toBe(false);
    expect(/@import\s+url\(/i.test(css)).toBe(false);
    expect(/url\(\s*['"]?https?:/i.test(css)).toBe(false);
  });
});

describe("TASK-CHATV2-005 responsive primitives (#5)", () => {
  it("contains <420px and <320px branches", () => {
    expect(/@media\s*\(max-width:\s*419px\)/.test(css), "<420px branch").toBe(true);
    expect(/@media\s*\(max-width:\s*319px\)/.test(css), "<320px branch").toBe(true);
    // <420 hides optional labels; <320 wraps composer actions into two rows.
    expect(/\.UnicDB-ai-chat-v2-label-optional\s*\{[^}]*display:\s*none/.test(css)).toBe(true);
    expect(/@media\s*\(max-width:\s*319px\)[\s\S]*grid-template-rows/.test(css)).toBe(true);
  });

  it("declares 32px control minima and a 32x32 send slot", () => {
    const control = css.match(/\.UnicDB-ai-chat-v2-control\s*\{([^}]*)\}/);
    expect(control, ".UnicDB-ai-chat-v2-control rule must exist").not.toBeNull();
    expect(/min-width:\s*32px/.test(control![1])).toBe(true);
    expect(/min-height:\s*32px/.test(control![1])).toBe(true);

    const send = css.match(/\.UnicDB-ai-chat-v2-send\s*\{([^}]*)\}/);
    expect(send, ".UnicDB-ai-chat-v2-send rule must exist").not.toBeNull();
    expect(/width:\s*32px/.test(send![1])).toBe(true);
    expect(/height:\s*32px/.test(send![1])).toBe(true);
  });

  it("implements the PLAN §3 grid: 40px header, minmax(0,1fr) transcript, min-width:0 boundaries", () => {
    const rootRule = css.match(/\.UnicDB-ai-chat-v2\s*\{([^}]*)\}/);
    expect(rootRule, ".UnicDB-ai-chat-v2 root rule must exist").not.toBeNull();
    expect(/grid-template-rows:[^;]*40px/.test(rootRule![1])).toBe(true);
    expect(/minmax\(0,\s*1fr\)/.test(rootRule![1])).toBe(true);
    expect(/min-width:\s*0/.test(rootRule![1])).toBe(true);
    expect(/min-height:\s*0/.test(rootRule![1])).toBe(true);
  });

  it("declares a reduced-motion guard", () => {
    expect(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css)).toBe(true);
  });

  it("exposes the 320/420/768 x dark/light/high-contrast screenshot fixtures", () => {
    const expected = [320, 420, 768].flatMap((w) =>
      ["dark", "light", "high-contrast"].map((t) => `chat-v2-${w}-${t}.png`),
    );
    expect([...CHAT_V2_SCREENSHOT_FIXTURES].sort()).toEqual(expected.sort());
    expect(CHAT_V2_SCREENSHOT_FIXTURES).toHaveLength(9);
  });
});
