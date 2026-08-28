// src/ui/__tests__/chatLayoutCss.test.ts
// TASK-003 - Chat layout CSS contract (pinned composer + full-height thread,
// plus TASK-002 affordances + TASK-005 mention-dropdown selectors + fix-round-1
// height-chain + 6 missing TASK-002 affordance styles + cycle-AB image-attach
// strip + button + warning + dark theme tokens).
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

  // -----------------------------------------------------------------------
  // Cycle AB — TASK-003 image-attach CSS contract.
  // The webview needs:
  //   - .vsdb-chat-attach-btn     (icon button next to send)
  //   - .vsdb-chat-attachments    (thumbnail strip ABOVE the textarea)
  //   - .vsdb-chat-thumb          (56×56 frame, hosts an <img>)
  //   - .vsdb-chat-thumb-remove   (absolute overlay on the thumbnail)
  //   - .vsdb-chat-attach-warning (amber notice bubble)
  // Plus theme tokens declared at :root (light defaults) and overridden in a
  // [data-theme="dark"] block:
  //   --vsdb-warning-bg / --vsdb-warning-fg / --vsdb-warning-border
  //   --vsdb-overlay-bg
  //   --vsdb-input-hover-bg
  //   --vsdb-error-bg
  // The thumb strip lives inside .vsdb-chat-input so the cycle-AA pinned
  // composer + height chain still owns scrolling; the css contract test below
  // guards that lock too (case h).
  // -----------------------------------------------------------------------
  describe("TASK-003 cycle AB — image attach CSS contract", () => {
    it("a) .vsdb-chat-attach-btn present with cursor:pointer", () => {
      const body = ruleBody(".vsdb-chat-attach-btn");
      expect(body, ".vsdb-chat-attach-btn rule block must exist").not.toBe("");
      expect(
        /cursor:\s*pointer/i.test(body),
        ".vsdb-chat-attach-btn must declare cursor:pointer",
      ).toBe(true);
    });

    it("a-focus) .vsdb-chat-attach-btn:focus-visible declares a visible focus ring via theme token", () => {
      // The focus rule lives in a sibling block (selector + :focus-visible),
      // so scan the file-level CSS rather than ruleBody().
      expect(
        /\.vsdb-chat-attach-btn(?:\.[\w-]+)*\s*:focus-visible\s*\{[^}]*outline\s*:/i.test(
          css,
        ),
        ".vsdb-chat-attach-btn:focus-visible must declare an outline (visible focus ring)",
      ).toBe(true);
    });

    it("b) .vsdb-chat-attachments strip layout (display:flex, gap:8px, overflow-x:auto, max-height:80px)", () => {
      const body = ruleBody(".vsdb-chat-attachments");
      expect(body, ".vsdb-chat-attachments rule block must exist").not.toBe("");
      expect(
        /display:\s*flex/i.test(body),
        ".vsdb-chat-attachments must declare display:flex (horizontal row of thumbnails)",
      ).toBe(true);
      expect(
        /gap:\s*8px/i.test(body),
        ".vsdb-chat-attachments must declare gap:8px",
      ).toBe(true);
      expect(
        /overflow-x:\s*auto/i.test(body),
        ".vsdb-chat-attachments must declare overflow-x:auto (strip scrolls horizontally)",
      ).toBe(true);
      expect(
        /max-height:\s*80px/i.test(body),
        ".vsdb-chat-attachments must declare max-height:80px (capped row height)",
      ).toBe(true);
    });

    it("c) .vsdb-chat-thumb is a 56×56 frame with position:relative (anchors the remove button)", () => {
      const body = ruleBody(".vsdb-chat-thumb");
      expect(body, ".vsdb-chat-thumb rule block must exist").not.toBe("");
      expect(
        /width:\s*56px/i.test(body),
        ".vsdb-chat-thumb must declare width:56px",
      ).toBe(true);
      expect(
        /height:\s*56px/i.test(body),
        ".vsdb-chat-thumb must declare height:56px",
      ).toBe(true);
      expect(
        /position:\s*relative/i.test(body),
        ".vsdb-chat-thumb must declare position:relative (anchors .vsdb-chat-thumb-remove)",
      ).toBe(true);
    });

    it("d) .vsdb-chat-thumb img uses object-fit:cover (fills the 56×56 frame without distortion)", () => {
      // ruleBody() does not understand compound selectors like
      // ".vsdb-chat-thumb img", so scan the file-level CSS for a rule body
      // that declares object-fit:cover under that selector.
      expect(
        /\.vsdb-chat-thumb\s+img\s*\{[^}]*object-fit:\s*cover/i.test(css),
        ".vsdb-chat-thumb img must declare object-fit:cover",
      ).toBe(true);
    });

    it("e) .vsdb-chat-thumb-remove is an absolute overlay (top:2px, right:2px)", () => {
      const body = ruleBody(".vsdb-chat-thumb-remove");
      expect(
        body,
        ".vsdb-chat-thumb-remove rule block must exist",
      ).not.toBe("");
      expect(
        /position:\s*absolute/i.test(body),
        ".vsdb-chat-thumb-remove must declare position:absolute (overlay)",
      ).toBe(true);
      expect(
        /top:\s*2px/i.test(body),
        ".vsdb-chat-thumb-remove must declare top:2px",
      ).toBe(true);
      expect(
        /right:\s*2px/i.test(body),
        ".vsdb-chat-thumb-remove must declare right:2px",
      ).toBe(true);
    });

    it("f) .vsdb-chat-attach-warning references var(--vsdb-warning-bg) (theme-token contract)", () => {
      const body = ruleBody(".vsdb-chat-attach-warning");
      expect(
        body,
        ".vsdb-chat-attach-warning rule block must exist",
      ).not.toBe("");
      expect(
        /var\(\s*--vsdb-warning-bg\s*\)/i.test(body),
        ".vsdb-chat-attach-warning must reference var(--vsdb-warning-bg)",
      ).toBe(true);
    });

    it("g) [data-theme=\"dark\"] block declares at least one of the new tokens (dark variant present)", () => {
      // The dark block may be one or many rules; scan every body in the file
      // that opens with [data-theme="dark"] { … } and require at least one
      // cycle-AB token inside. At minimum this proves the token system is
      // wired; surface-specific dark overrides may be added later.
      const re = /\[data-theme=["']dark["']\]\s*\{([^}]*)\}/gi;
      const bodies: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(css)) !== null) bodies.push(m[1]);
      const tokens = [
        "--vsdb-warning-bg",
        "--vsdb-warning-fg",
        "--vsdb-warning-border",
        "--vsdb-overlay-bg",
        "--vsdb-input-hover-bg",
        "--vsdb-error-bg",
      ];
      const found = bodies.some((b) =>
        tokens.some((tok) => new RegExp(tok + "\\s*:", "i").test(b)),
      );
      expect(
        found,
        `[data-theme="dark"] block must declare at least one of: ${tokens.join(", ")}`,
      ).toBe(true);
    });

    it("h) regression: body.vsdb-chat-body { height: 100vh } rule still present (cycle AA height chain)", () => {
      const body = ruleBody("body.vsdb-chat-body");
      expect(
        body,
        "body.vsdb-chat-body rule block must still exist (cycle AA lock)",
      ).not.toBe("");
      expect(
        /height:\s*100vh/i.test(body),
        "body.vsdb-chat-body must still declare height:100vh",
      ).toBe(true);
    });
  });
});
