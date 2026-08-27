// src/ui/__tests__/chatLayoutCss.test.ts
// TASK-003 - Chat layout CSS contract (pinned composer + full-height thread,
// plus TASK-002 affordances + TASK-005 mention-dropdown selectors + fix-round-1
// height-chain + 6 missing TASK-002 affordance styles).
//
// jsdom does not apply external stylesheets, so the contract is asserted
// against the source CSS text directly via regex (same pattern as
// webviewToolbar.test.ts and resultsGridModelNull.test.ts).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = resolve(process.cwd(), "webview", "styles.css");
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

/** Extract the body of the FIRST top-level rule block matching `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  if (!m) return "";
  return m[2] ?? "";
}

/** True if any `selector:hover` (or `selector.x:hover`) rule exists in the file.
 * FIX ROUND 1 — minor: \s inside the template string previously degraded to `s`;
 * it worked by accident because the literal `s*` matches zero `s` chars. Escape
 * it now so the regex compiles as whitespace. */
function hasHoverRule(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?:\\.[\\w-]+)*\\s*:hover\\s*\\{`);
  return re.test(css);
}

describe("TASK-003 - chat layout CSS contract", () => {
  it("loads webview/styles.css", () => {
    expect(css, "webview/styles.css must exist").not.toBe("");
  });

  it(".vsdb-chat-thread grows via flex:1 and no longer caps at 60vh", () => {
    const body = ruleBody(".vsdb-chat-thread");
    expect(body, ".vsdb-chat-thread rule block must exist").not.toBe("");
    expect(
      /flex:\s*1(?:[^;]*;|$)/.test(body),
      ".vsdb-chat-thread must declare flex:1 (or flex:1 1 auto)",
    ).toBe(true);
    // FIX ROUND 1 — minor: the original `/max-height: \s*60vh/` had a literal
    // space after the colon, so `max-height:60vh` (no space) slipped through.
    // Already space-tolerant, but document the invariant with a space-free
    // form check too.
    expect(
      /max-height:\s*60vh/i.test(body),
      ".vsdb-chat-thread must NOT contain max-height:60vh (kills the bug)",
    ).toBe(false);
    expect(
      /max-height:60vh/i.test(body),
      ".vsdb-chat-thread must NOT contain space-free max-height:60vh either",
    ).toBe(false);
    expect(
      /overflow-y:\s*auto/i.test(body),
      ".vsdb-chat-thread must keep overflow-y:auto so the thread scrolls",
    ).toBe(true);
  });

  it(".vsdb-chat shell is a full-height flex column so the composer pins bottom", () => {
    const body = ruleBody(".vsdb-chat");
    expect(body, ".vsdb-chat rule block must exist").not.toBe("");
    expect(
      /display:\s*flex/i.test(body),
      ".vsdb-chat must declare display:flex",
    ).toBe(true);
    expect(
      /flex-direction:\s*column/i.test(body),
      ".vsdb-chat must declare flex-direction:column",
    ).toBe(true);
    expect(
      /height:\s*100%/i.test(body),
      ".vsdb-chat must declare height:100%",
    ).toBe(true);
  });

  it(".vsdb-chat-input is a flex child (not absolutely positioned) AFTER the thread", () => {
    const body = ruleBody(".vsdb-chat-input");
    expect(body, ".vsdb-chat-input rule block must exist").not.toBe("");
    expect(
      /position:\s*absolute/i.test(body),
      ".vsdb-chat-input must NOT be position:absolute",
    ).toBe(false);
    const threadIdx = css.search(/\.vsdb-chat-thread\s*\{/);
    const inputIdx = css.search(/\.vsdb-chat-input\s*\{/);
    expect(
      threadIdx >= 0 && inputIdx >= 0 && threadIdx < inputIdx,
      ".vsdb-chat-thread rule must appear before .vsdb-chat-input in stylesheet order",
    ).toBe(true);
  });

  // FIX ROUND 1 — critical: height-chain.
  // `<body class="vsdb-form-body">` (src/ui/aiChatPanel.ts buildHtml) had no
  // height rule, so `.vsdb-chat { height:100% }` collapsed against auto → ~205px
  // root. Add a chat-scoped body class + height rule; do not break OTHER forms
  // (connectionForm etc. still share `vsdb-form-body`).
  it("chat webview body establishes a real height chain (body.vsdb-chat-body height:100vh)", () => {
    const body = ruleBody("body.vsdb-chat-body");
    expect(
      body,
      "body.vsdb-chat-body rule block must exist — fixes the 205px panel collapse (CRITICAL)",
    ).not.toBe("");
    expect(
      /height:\s*100vh/i.test(body),
      "body.vsdb-chat-body must declare height:100vh (fills the webview viewport)",
    ).toBe(true);
    expect(
      /overflow:\s*hidden/i.test(body),
      "body.vsdb-chat-body must declare overflow:hidden so the panel owns scrolling",
    ).toBe(true);
  });

  it(".vsdb-chat fills its body (height:100% + min-height:0) — chain to 100vh", () => {
    const body = ruleBody(".vsdb-chat");
    expect(body, ".vsdb-chat rule block must exist").not.toBe("");
    expect(
      /height:\s*100%/i.test(body),
      ".vsdb-chat must declare height:100% so it fills body.vsdb-chat-body",
    ).toBe(true);
    expect(
      /min-height:\s*0/i.test(body),
      ".vsdb-chat must declare min-height:0 (flex children need explicit min-height to shrink)",
    ).toBe(true);
  });

  it("vsdb-form-body (other forms) is NOT touched by the height chain — scope preserved", () => {
    const formBody = ruleBody(".vsdb-form-body");
    expect(formBody, ".vsdb-form-body rule block must still exist").not.toBe("");
    expect(
      /height:\s*100vh/i.test(formBody),
      ".vsdb-form-body (shared with connectionForm etc.) must NOT declare height:100vh",
    ).toBe(false);
  });

  // FIX ROUND 1 — important: 6 missing TASK-002 affordance styles.
  describe("TASK-002 affordances (CSS contract)", () => {
    it("thinking block: vsdb-chat-thinking uses a card-like surface", () => {
      const body = ruleBody(".vsdb-chat-thinking");
      expect(body, ".vsdb-chat-thinking rule block must exist").not.toBe("");
      expect(
        /border:\s*1px\s+solid/i.test(body),
        ".vsdb-chat-thinking must declare a 1px solid border",
      ).toBe(true);
      expect(
        /background:\s*var\(/i.test(body),
        ".vsdb-chat-thinking must use a --vscode- themed background",
      ).toBe(true);
      const bodyInner = ruleBody(".vsdb-chat-thinking-body");
      expect(
        bodyInner,
        ".vsdb-chat-thinking-body rule block must exist",
      ).not.toBe("");
      expect(
        /padding:\s*\d/i.test(bodyInner),
        ".vsdb-chat-thinking-body must declare a padding value",
      ).toBe(true);
    });

    it("jump-to-latest: floating button pinned bottom-right of the thread", () => {
      const body = ruleBody(".vsdb-chat-jump");
      expect(body, ".vsdb-chat-jump rule block must exist").not.toBe("");
      expect(
        /position:\s*(?:fixed|absolute)/i.test(body),
        ".vsdb-chat-jump must be position:fixed or position:absolute (floating)",
      ).toBe(true);
      expect(
        /bottom:\s*\d/i.test(body),
        ".vsdb-chat-jump must anchor bottom",
      ).toBe(true);
      expect(
        /right:\s*\d/i.test(body),
        ".vsdb-chat-jump must anchor right",
      ).toBe(true);
      expect(
        /z-index:\s*\d+/i.test(body),
        ".vsdb-chat-jump must declare a z-index (floats above the thread)",
      ).toBe(true);
    });

    it("md-copy: small inline button attached to a code block", () => {
      const body = ruleBody(".vsdb-md-copy");
      expect(body, ".vsdb-md-copy rule block must exist").not.toBe("");
      expect(
        /font-size:\s*\d/i.test(body),
        ".vsdb-md-copy must declare a font-size (compact button)",
      ).toBe(true);
      expect(
        /cursor:\s*pointer/i.test(body),
        ".vsdb-md-copy must declare cursor:pointer",
      ).toBe(true);
    });

    it("queued marker: small visual indicator distinct from a settled bubble", () => {
      const body = ruleBody(".vsdb-chat-queued");
      expect(body, ".vsdb-chat-queued rule block must exist").not.toBe("");
      // Accept either animation, opacity-based blink, or explicit inline-block
      // sizing — anything that makes the otherwise zero-width span visible.
      expect(
        /(animation:\s*\w+|opacity:\s*0?\.\d|display:\s*inline-block)/i.test(
          body,
        ),
        ".vsdb-chat-queued must declare animation/opacity/display (visual marker)",
      ).toBe(true);
    });

    it("streaming caret: visible glyph on a streaming assistant bubble", () => {
      // The caret can live on the streaming bubble via ::after OR on the
      // .vsdb-chat-caret span itself (TASK-002 used the latter: ensureStreamingCaret
      // appends <span class="vsdb-chat-caret">). Accept either form.
      const directBody = ruleBody(".vsdb-chat-caret");
      const streamingAfter =
        /\.vsdb-chat-assistant\.vsdb-chat-streaming::after\s*\{[^}]*content:\s*['"]/i.test(
          css,
        );
      const hasDirect =
        directBody !== "" &&
        /(display:\s*inline(?:-block)?|animation:\s*\w+|opacity:\s*0?\.\d|font-family)/i.test(
          directBody,
        );
      expect(
        hasDirect || streamingAfter,
        "streaming caret must be visible: either .vsdb-chat-caret with display/animation OR .vsdb-chat-assistant.vsdb-chat-streaming::after with a non-empty content",
      ).toBe(true);
    });

    it("regenerateBtn: button-level affordance styled or inherits .vsdb-chat-secondary", () => {
      const rule = ruleBody("#regenerateBtn");
      const secondaryBody = ruleBody(".vsdb-chat-secondary");
      const hasInline = /(padding|margin|font-size|color|background|border|cursor):\s*[^\s;]/i.test(
        rule,
      );
      const hasSecondaryClass = /\.vsdb-chat-secondary/.test(css);
      expect(
        hasInline || hasSecondaryClass,
        "#regenerateBtn must be styled inline OR inherit from .vsdb-chat-secondary (which must itself be styled)",
      ).toBe(true);
      if (!hasInline) {
        // Fallback path: regenerateBtn shares .vsdb-chat-secondary — make sure
        // that class has at least minimal button styling (font-size + cursor).
        expect(secondaryBody, ".vsdb-chat-secondary rule block must exist").not.toBe("");
        expect(
          /(font-size|padding|cursor):\s*[^\s;]/i.test(secondaryBody),
          ".vsdb-chat-secondary must declare at least one visual property",
        ).toBe(true);
      }
    });
  });

  it("resume-picker: row uses cursor:pointer + padding; card mirrors permission-card pattern", () => {
    const row = ruleBody(".vsdb-chat-resume-row");
    expect(row, ".vsdb-chat-resume-row rule block must exist").not.toBe("");
    expect(
      /cursor:\s*pointer/i.test(row),
      ".vsdb-chat-resume-row must declare cursor:pointer",
    ).toBe(true);
    expect(
      /padding:\s*\d/i.test(row),
      ".vsdb-chat-resume-row must declare a padding value",
    ).toBe(true);
    expect(
      hasHoverRule(".vsdb-chat-resume-row"),
      ".vsdb-chat-resume-row must have a :hover rule",
    ).toBe(true);

    const card = ruleBody(".vsdb-chat-resume-card");
    expect(card, ".vsdb-chat-resume-card rule block must exist").not.toBe("");
    expect(
      /border:\s*1px\s+solid/i.test(card),
      ".vsdb-chat-resume-card must declare a 1px solid border",
    ).toBe(true);
    expect(
      /background:\s*var\(/i.test(card),
      ".vsdb-chat-resume-card must use a --vscode- themed background",
    ).toBe(true);
    expect(
      /padding:\s*\d/i.test(card),
      ".vsdb-chat-resume-card must declare a padding value",
    ).toBe(true);

    const label = ruleBody(".vsdb-chat-resume-label");
    expect(label, ".vsdb-chat-resume-label rule block must exist").not.toBe("");
    expect(
      /font-weight:\s*600/i.test(label),
      ".vsdb-chat-resume-label must be bold (font-weight:600)",
    ).toBe(true);
    const detail = ruleBody(".vsdb-chat-resume-detail");
    expect(detail, ".vsdb-chat-resume-detail rule block must exist").not.toBe("");
    expect(
      /font-size:\s*\d/i.test(detail),
      ".vsdb-chat-resume-detail must declare a font-size",
    ).toBe(true);
  });

  it("mention-dropdown: CSS-first selectors exist (consumed by TASK-005)", () => {
    for (const sel of [
      ".vsdb-chat-mention-dropdown",
      ".vsdb-chat-mention-row",
      ".vsdb-chat-mention-kind",
    ]) {
      const body = ruleBody(sel);
      expect(body, `${sel} rule block must exist`).not.toBe("");
    }
    const card = ruleBody(".vsdb-chat-mention-dropdown");
    expect(
      /border:\s*1px\s+solid/i.test(card),
      ".vsdb-chat-mention-dropdown must declare a 1px solid border",
    ).toBe(true);
    expect(
      /background:\s*var\(/i.test(card),
      ".vsdb-chat-mention-dropdown must use a --vscode- themed background",
    ).toBe(true);
    expect(
      /padding:\s*\d/i.test(card),
      ".vsdb-chat-mention-dropdown must declare a padding value",
    ).toBe(true);
    const row = ruleBody(".vsdb-chat-mention-row");
    expect(
      /cursor:\s*pointer/i.test(row),
      ".vsdb-chat-mention-row must declare cursor:pointer",
    ).toBe(true);
    expect(
      hasHoverRule(".vsdb-chat-mention-row"),
      ".vsdb-chat-mention-row must have a :hover rule",
    ).toBe(true);
    const kind = ruleBody(".vsdb-chat-mention-kind");
    expect(
      /font-size:\s*\d/i.test(kind),
      ".vsdb-chat-mention-kind must declare a font-size",
    ).toBe(true);
  });

  it("getHtml emits vsdb-chat-body on <body> so the height chain actually applies (fix round 1 re-review)", () => {
    // The CSS rule alone is dead if buildHtml never puts the class on the
    // body element. Same text-contract approach as the CSS checks above:
    // parse the panel source and assert the emitted body tag carries both
    // classes (the wire side of the height chain, reviewer R4.5 finding).
    const panelSrc = readFileSync(
      resolve(process.cwd(), "src", "ui", "aiChatPanel.ts"),
      "utf8",
    );
    expect(panelSrc).toContain('<body class="vsdb-form-body vsdb-chat-body">');
  });
});
