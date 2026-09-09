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
  it("non-chat selectors are untouched and every new rule is chat-scoped", () => {
    const toolbar = ruleBody(".UnicDB-toolbar");
    expect(toolbar, ".UnicDB-toolbar rule block must still exist").not.toBe("");
    expect(/flex-wrap:\s*wrap/i.test(toolbar), ".UnicDB-toolbar must pin flex-wrap:wrap so WHERE/ORDER BY inputs can drop to their own rows").toBe(true);

    const tab = ruleBody(".UnicDB-tab");
    expect(tab, ".UnicDB-tab rule block must still exist").not.toBe("");
    expect(/cursor:\s*pointer/i.test(tab), ".UnicDB-tab must still declare cursor:pointer").toBe(true);

    const gridHost = ruleBody(".UnicDB-grid-host");
    expect(gridHost, ".UnicDB-grid-host rule block must still exist").not.toBe("");
    expect(/flex:\s*1/i.test(gridHost), ".UnicDB-grid-host must still declare flex:1").toBe(true);

    const btn = ruleBody(".UnicDB-btn");
    expect(btn, ".UnicDB-btn rule block must still exist").not.toBe("");
    expect(/background:\s*var\(/i.test(btn), ".UnicDB-btn must still use --vscode-button-background").toBe(true);

    // For every NEW selector that the task requires, the rule block exists
    // and its selector text starts with `.UnicDB-chat` (exact match — no
    // accidental .UnicDB-chat-foo-bar that is actually a descendant of a
    // non-chat parent).
    for (const sel of REQUIRED_SELECTORS) {
      const body = ruleBody(sel);
      expect(body, `${sel} rule block must exist`).not.toBe("");
    }

    // Walk every top-level rule selector in the file and ensure each new
    // one is chat-scoped. We measure by re-parsing the stylesheet at top
    // level only (no nested @media descent). Every top-level selector's
    // FIRST token must either be a known pre-existing selector or be
    // chat-scoped (.UnicDB-chat* / body.UnicDB-chat*). Skip @keyframes
    // percentage tokens (`0%`, `50%`, `100%`, `from`, `to`) and @media
    // blocks since those aren't top-level selectors.
    const selectors = Array.from(
      css.matchAll(/(^|\n)([^\{\n@][^\{\n]*?)\s*\{/g),
    )
      .map((m) => m[2].trim())
      .filter((s) => !/^\d+%$|^from$|^to$/i.test(s));

    // Pre-cycle baseline via git HEAD — avoids hardcoding a known-set that
    // would drift as new non-chat tasks ship selectors.
    let preCycleCss = "";
    try {
      preCycleCss = execFileSync("git", ["show", "HEAD:webview/styles.css"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
    } catch {
      preCycleCss = "";
    }
    const preCycleSelectors = preCycleCss
      ? Array.from(
          preCycleCss.matchAll(/(^|\n)([^\{\n@][^\{\n]*?)\s*\{/g),
        )
        .map((m) => m[2].trim())
        .filter((s) => !/^\d+%$|^from$|^to$/i.test(s))
      : [];
    const preCycleHeads = new Set(
      preCycleSelectors.map((s) => s.split(/\s|,|>|~|\+|:/)[0]),
    );

    // Cross-panel additions that ship alongside this cycle but live in
    // other webviews' DOM (NOT a chat-panel leak). The chat-clone test
    // exists to keep non-chat CSS out of the chat panel's bundle;
    // these selectors target other panels' toolbars (console panel +
    // results panel) and the AI-chat-composer schema chip mirrors them
    // visually via `.UnicDB-chat-schema-chip`.
    const ALLOWED_OFF_CHAT = new Set([
      ".UnicDB-schema-chip",
      ".UnicDB-console-schema-chip",
      // TASK-RANGE-001 — cell-range selection highlight for the results
      // grid (Excel-style rectangle drag). Lives in styles.css alongside
      // the dirty/edit highlights; not a chat-panel selector.
      ".UnicDB-cell-range",
      // Combined rule for a cell that is BOTH inside the range AND dirty.
      // Higher specificity than either individual class — handles the
      // !important background conflict between orange-dirty and blue-range.
      ".UnicDB-cell-range.UnicDB-cell-dirty",
    ]);

    // Any selector first-token in the current file but absent from the
    // pre-cycle file must start with `.UnicDB-chat` (cycle contract).
    const offChatNew = selectors.filter((s) => {
      const head = s.split(/\s|,|>|~|\+|:/)[0];
      if (head.startsWith(".UnicDB-chat")) return false;
      if (preCycleHeads.has(head)) return false;
      if (ALLOWED_OFF_CHAT.has(head)) return false;
      // Allow pre-existing structural selectors that aren't `.UnicDB-` prefixed
      // (`*`, `:root`, `[data-theme=…]`, `html`, `body`).
      return !/^[*\[]|^:|^body|^html/i.test(head);
    });
    expect(
      offChatNew,
      `unexpected off-chat top-level selectors introduced: ${offChatNew.join(", ")}`,
    ).toEqual([]);
  });

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
  it(".UnicDB-chat-brand is the big BLUE 'U' brand glyph", () => {
    const body = ruleBody(".UnicDB-chat-brand");
    expect(body, ".UnicDB-chat-brand rule block must exist").not.toBe("");
    // 28px+ bold sans-serif BLUE
    expect(/font-weight:\s*(?:[6-9]\d\d|[1-9]\d{3,})/i.test(body), ".UnicDB-chat-brand must declare font-weight >= 600").toBe(true);
    expect(/font-size:\s*(?:2[89]|[3-9]\d|\d{3,})px/i.test(body), ".UnicDB-chat-brand must declare font-size >= 28px").toBe(true);
    // BLUE accent (any of the token family, case-insensitive)
    expect(
      /(?:var\(--UnicDB-chat-accent|#3b82f6|#60a5fa|#2563eb)/i.test(body),
      ".UnicDB-chat-brand must declare BLUE accent (token or hex)",
    ).toBe(true);
    // sans-serif (default `sans-serif`, or any sans-serif keyword fallback)
    expect(/font-family:\s*[^;]*sans-serif/i.test(body), ".UnicDB-chat-brand must declare sans-serif font-family").toBe(true);
  });

  // Stop button: square, red, with pulse animation hook.
  it(".UnicDB-chat-stop is a red square; .UnicDB-chat-stop-live animates the pulse", () => {
    const stop = ruleBody(".UnicDB-chat-stop");
    expect(stop, ".UnicDB-chat-stop rule block must exist").not.toBe("");
    // Red: either the stop token or the literal hex
    expect(
      /(?:var\(--UnicDB-chat-stop|#dc2626)/i.test(stop),
      ".UnicDB-chat-stop must declare red (token or hex)",
    ).toBe(true);
    // Square: equal width and height (both numeric px)
    const width = stop.match(/width:\s*(\d+)px/i);
    const height = stop.match(/height:\s*(\d+)px/i);
    expect(width, ".UnicDB-chat-stop must declare width:Npx").toBeTruthy();
    expect(height, ".UnicDB-chat-stop must declare height:Npx").toBeTruthy();
    if (width && height) {
      expect(
        width[1],
        ".UnicDB-chat-stop must be square (width === height)",
      ).toBe(height[1]);
    }
    expect(/border-radius:\s*0/i.test(stop), ".UnicDB-chat-stop must be square (border-radius:0)").toBe(true);

    const live = ruleBody(".UnicDB-chat-stop-live");
    expect(live, ".UnicDB-chat-stop-live rule block must exist").not.toBe("");
    expect(
      /animation:\s*[^\n;]*UnicDB-chat-pulse/i.test(live),
      ".UnicDB-chat-stop-live must reference UnicDB-chat-pulse animation",
    ).toBe(true);

    // @keyframes UnicDB-chat-pulse is declared somewhere in the file.
    expect(
      /@keyframes\s+UnicDB-chat-pulse/i.test(css),
      "@keyframes UnicDB-chat-pulse must be declared",
    ).toBe(true);

    // Reduced-motion guard exists for the pulse keyframes.
    expect(
      /@media\s+\(prefers-reduced-motion:\s*reduce\)/i.test(css),
      "a prefers-reduced-motion media query must be declared",
    ).toBe(true);
  });

  // Bypass-permissions toggle: BLUE OFF, amber ON.
  it(".UnicDB-chat-toggle BLUE OFF, .UnicDB-chat-toggle-on amber ON", () => {
    const off = ruleBody(".UnicDB-chat-toggle");
    expect(off, ".UnicDB-chat-toggle rule block must exist").not.toBe("");
    expect(
      /(?:var\(--UnicDB-chat-accent|#3b82f6|#60a5fa|#2563eb)/i.test(off),
      ".UnicDB-chat-toggle (OFF) must declare BLUE accent",
    ).toBe(true);

    const on = ruleBody(".UnicDB-chat-toggle-on");
    expect(on, ".UnicDB-chat-toggle-on rule block must exist").not.toBe("");
    expect(
      /(?:var\(--UnicDB-chat-warn|#f59e0b)/i.test(on),
      ".UnicDB-chat-toggle-on (ON) must declare amber accent",
    ).toBe(true);
  });
});