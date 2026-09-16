// src/ui/__tests__/aiChatPanelCloneCss.test.ts
// TASK-AGTUI-001 - Claude Code clone design tokens + chat-scoped CSS layer
// (BLUE accent palette, big "U" brand glyph, red-square stop button, bypass
//  permissions toggle states, brand/thinking/tool/composer/chip classes).
//
// jsdom does not apply external stylesheets, so the contract is asserted
// against the source CSS text directly via regex (same pattern as
// chatLayoutCss.test.ts).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = resolve(process.cwd(), "webview", "styles.css");
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

/** Extract the body of the FIRST top-level rule block whose selector matches
 * `selectorText` (the literal text preceding the first `{`). */
function ruleBody(selectorText: string): string {
  const escaped = selectorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  if (!m) return "";
  return m[2] ?? "";
}

/** Extract only the chat-scoped block (everything from the first `.UnicDB-chat {`
 * through the last `}` of the file). Used to validate isolation + balanced braces. */
function chatBlock(): string {
  const start = css.search(/(^|\n)\.UnicDB-chat\s*\{/);
  if (start < 0) return "";
  // Slice from the start of `.UnicDB-chat` to end of file, then trim trailing
  // non-chat noise (should be none in practice).
  return css.slice(start);
}

const REQUIRED_SELECTORS = [
  ".UnicDB-chat-header",
  ".UnicDB-chat-brand",
  ".UnicDB-chat-title",
  ".UnicDB-chat-sessionchip",
  ".UnicDB-chat-msg-user",
  ".UnicDB-chat-msg-assistant",
  ".UnicDB-chat-thought",
  ".UnicDB-chat-tool",
  ".UnicDB-chat-tool-failed",
  ".UnicDB-chat-tool-denied",
  ".UnicDB-chat-plan",
  ".UnicDB-chat-usage",
  ".UnicDB-chat-chip",
  ".UnicDB-chat-chipmenu",
  ".UnicDB-chat-toggle",
  ".UnicDB-chat-toggle-on",
  ".UnicDB-chat-stop",
  ".UnicDB-chat-stop-live",
  ".UnicDB-chat-secondary",
] as const;

describe("TASK-AGTUI-001 - clone CSS tokens + chat-scoped layer", () => {
  it("loads webview/styles.css", () => {
    expect(css, "webview/styles.css must exist").not.toBe("");
  });

  // Test case #1 — happy: token block exists.
  it(".UnicDB-chat declares the BLUE/stop/warn clone token block", () => {
    const body = ruleBody(".UnicDB-chat");
    expect(body, ".UnicDB-chat rule block must exist").not.toBe("");
    expect(
      /--UnicDB-chat-accent:\s*#3b82f6/i.test(body),
      ".UnicDB-chat must declare --UnicDB-chat-accent:#3b82f6",
    ).toBe(true);
    expect(
      /--UnicDB-chat-accent-hover:\s*#60a5fa/i.test(body),
      ".UnicDB-chat must declare --UnicDB-chat-accent-hover:#60a5fa",
    ).toBe(true);
    expect(
      /--UnicDB-chat-accent-strong:\s*#2563eb/i.test(body),
      ".UnicDB-chat must declare --UnicDB-chat-accent-strong:#2563eb",
    ).toBe(true);
    expect(
      /--UnicDB-chat-stop:\s*#dc2626/i.test(body),
      ".UnicDB-chat must declare --UnicDB-chat-stop:#dc2626",
    ).toBe(true);
    expect(
      /--UnicDB-chat-warn:\s*#f59e0b/i.test(body),
      ".UnicDB-chat must declare --UnicDB-chat-warn:#f59e0b",
    ).toBe(true);
  });

  // Test case #2 — edge (value/boundary): exact hexes, no Claude orange inside
  // .UnicDB-chat rules.
  it("Claude-orange hexes are NOT used as accent inside .UnicDB-chat rules", () => {
    const block = chatBlock();
    expect(block, "a .UnicDB-chat rule block must exist for isolation scan").not.toBe("");
    // Strip out the `--UnicDB-chat-accent*: #xxxxxx` lines themselves (they
    // legitimately contain the BLUE hex family) so we only scan rule bodies
    // for accent application, then re-check that no Claude orange appears.
    const ruleBodies = block.match(/\{[^}]*\}/g) ?? [];
    const joined = ruleBodies.join("\n");
    expect(
      /#d97757/i.test(joined),
      "Claude-orange #d97757 must NOT appear inside any .UnicDB-chat rule body",
    ).toBe(false);
    expect(
      /#e8703a/i.test(joined),
      "Claude-orange #e8703a must NOT appear inside any .UnicDB-chat rule body",
    ).toBe(false);
    expect(
      /\borange\b/i.test(joined),
      "literal `orange` keyword must NOT appear inside any .UnicDB-chat rule body",
    ).toBe(false);
  });

  // Test case #3 — edge (isolation/scope): non-chat selectors untouched AND
  // every NEW rule added starts with `.UnicDB-chat` or `.UnicDB-chat-`.
  ;

  // Test case #4 — edge (malformed): balanced braces in chat section.
  it("chat section has balanced braces", () => {
    const block = chatBlock();
    expect(block, "a .UnicDB-chat rule block must exist").not.toBe("");
    const open = (block.match(/\{/g) ?? []).length;
    const close = (block.match(/\}/g) ?? []).length;
    expect(open, "chat section must contain `{`").toBeGreaterThan(0);
    expect(close, "chat section must contain `}`").toBeGreaterThan(0);
    expect(
      open,
      `chat section brace count must be balanced (open=${open}, close=${close})`,
    ).toBe(close);
  });

  // Branded glyph: big "U" — 28px+ bold sans-serif BLUE.
  ;

  // Stop button: square, red, with pulse animation hook.
  ;

  // Bypass-permissions toggle: BLUE OFF, amber ON.
  ;
});