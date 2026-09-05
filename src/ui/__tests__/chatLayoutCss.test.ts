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

  it(".UnicDB-chat-thread grows via flex:1 and no longer caps at 60vh", () => {
    const body = ruleBody(".UnicDB-chat-thread");
    expect(body, ".UnicDB-chat-thread rule block must exist").not.toBe("");
    expect(
      /flex:\s*1(?:[^;]*;|$)/.test(body),
      ".UnicDB-chat-thread must declare flex:1 (or flex:1 1 auto)",
    ).toBe(true);
    // FIX ROUND 1 — minor: the original `/max-height: \s*60vh/` had a literal
    // space after the colon, so `max-height:60vh` (no space) slipped through.
    // Already space-tolerant, but document the invariant with a space-free
    // form check too.
    expect(
      /max-height:\s*60vh/i.test(body),
      ".UnicDB-chat-thread must NOT contain max-height:60vh (kills the bug)",
    ).toBe(false);
    expect(
      /max-height:60vh/i.test(body),
      ".UnicDB-chat-thread must NOT contain space-free max-height:60vh either",
    ).toBe(false);
    expect(
      /overflow-y:\s*auto/i.test(body),
      ".UnicDB-chat-thread must keep overflow-y:auto so the thread scrolls",
    ).toBe(true);
  });

  it(".UnicDB-chat shell is a full-height flex column so the composer pins bottom", () => {
    const body = ruleBody(".UnicDB-chat");
    expect(body, ".UnicDB-chat rule block must exist").not.toBe("");
    expect(
      /display:\s*flex/i.test(body),
      ".UnicDB-chat must declare display:flex",
    ).toBe(true);
    expect(
      /flex-direction:\s*column/i.test(body),
      ".UnicDB-chat must declare flex-direction:column",
    ).toBe(true);
    expect(
      /height:\s*100%/i.test(body),
      ".UnicDB-chat must declare height:100%",
    ).toBe(true);
  });

  it(".UnicDB-chat-input is a flex child (not absolutely positioned) AFTER the thread", () => {
    const body = ruleBody(".UnicDB-chat-input");
    expect(body, ".UnicDB-chat-input rule block must exist").not.toBe("");
    expect(
      /position:\s*absolute/i.test(body),
      ".UnicDB-chat-input must NOT be position:absolute",
    ).toBe(false);
    const threadIdx = css.search(/\.UnicDB-chat-thread\s*\{/);
    const inputIdx = css.search(/\.UnicDB-chat-input\s*\{/);
    expect(
      threadIdx >= 0 && inputIdx >= 0 && threadIdx < inputIdx,
      ".UnicDB-chat-thread rule must appear before .UnicDB-chat-input in stylesheet order",
    ).toBe(true);
  });

  // FIX ROUND 1 — critical: height-chain.
  // `<body class="UnicDB-form-body">` (src/ui/aiChatPanel.ts buildHtml) had no
  // height rule, so `.UnicDB-chat { height:100% }` collapsed against auto → ~205px
  // root. Add a chat-scoped body class + height rule; do not break OTHER forms
  // (connectionForm etc. still share `UnicDB-form-body`).
  it("chat webview body establishes a real height chain (body.UnicDB-chat-body height:100vh)", () => {
    const body = ruleBody("body.UnicDB-chat-body");
    expect(
      body,
      "body.UnicDB-chat-body rule block must exist — fixes the 205px panel collapse (CRITICAL)",
    ).not.toBe("");
    expect(
      /height:\s*100vh/i.test(body),
      "body.UnicDB-chat-body must declare height:100vh (fills the webview viewport)",
    ).toBe(true);
    expect(
      /overflow:\s*hidden/i.test(body),
      "body.UnicDB-chat-body must declare overflow:hidden so the panel owns scrolling",
    ).toBe(true);
  });

  it(".UnicDB-chat fills its body (height:100% + min-height:0) — chain to 100vh", () => {
    const body = ruleBody(".UnicDB-chat");
    expect(body, ".UnicDB-chat rule block must exist").not.toBe("");
    expect(
      /height:\s*100%/i.test(body),
      ".UnicDB-chat must declare height:100% so it fills body.UnicDB-chat-body",
    ).toBe(true);
    expect(
      /min-height:\s*0/i.test(body),
      ".UnicDB-chat must declare min-height:0 (flex children need explicit min-height to shrink)",
    ).toBe(true);
  });

  it("UnicDB-form-body (other forms) is NOT touched by the height chain — scope preserved", () => {
    const formBody = ruleBody(".UnicDB-form-body");
    expect(formBody, ".UnicDB-form-body rule block must still exist").not.toBe("");
    expect(
      /height:\s*100vh/i.test(formBody),
      ".UnicDB-form-body (shared with connectionForm etc.) must NOT declare height:100vh",
    ).toBe(false);
  });

  // FIX ROUND 1 — important: 6 missing TASK-002 affordance styles.
  describe("TASK-002 affordances (CSS contract)", () => {
    it("thinking block: UnicDB-chat-thinking uses a card-like surface", () => {
      const body = ruleBody(".UnicDB-chat-thinking");
      expect(body, ".UnicDB-chat-thinking rule block must exist").not.toBe("");
      expect(
        /border:\s*1px\s+solid/i.test(body),
        ".UnicDB-chat-thinking must declare a 1px solid border",
      ).toBe(true);
      expect(
        /background:\s*var\(/i.test(body),
        ".UnicDB-chat-thinking must use a --vscode- themed background",
      ).toBe(true);
      const bodyInner = ruleBody(".UnicDB-chat-thinking-body");
      expect(
        bodyInner,
        ".UnicDB-chat-thinking-body rule block must exist",
      ).not.toBe("");
      expect(
        /padding:\s*\d/i.test(bodyInner),
        ".UnicDB-chat-thinking-body must declare a padding value",
      ).toBe(true);
    });

    it("jump-to-latest: floating button pinned bottom-right of the thread", () => {
      const body = ruleBody(".UnicDB-chat-jump");
      expect(body, ".UnicDB-chat-jump rule block must exist").not.toBe("");
      expect(
        /position:\s*(?:fixed|absolute)/i.test(body),
        ".UnicDB-chat-jump must be position:fixed or position:absolute (floating)",
      ).toBe(true);
      expect(
        /bottom:\s*\d/i.test(body),
        ".UnicDB-chat-jump must anchor bottom",
      ).toBe(true);
      expect(
        /right:\s*\d/i.test(body),
        ".UnicDB-chat-jump must anchor right",
      ).toBe(true);
      expect(
        /z-index:\s*\d+/i.test(body),
        ".UnicDB-chat-jump must declare a z-index (floats above the thread)",
      ).toBe(true);
    });

    it("md-copy: small inline button attached to a code block", () => {
      const body = ruleBody(".UnicDB-md-copy");
      expect(body, ".UnicDB-md-copy rule block must exist").not.toBe("");
      expect(
        /font-size:\s*\d/i.test(body),
        ".UnicDB-md-copy must declare a font-size (compact button)",
      ).toBe(true);
      expect(
        /cursor:\s*pointer/i.test(body),
        ".UnicDB-md-copy must declare cursor:pointer",
      ).toBe(true);
    });

    it("queued marker: small visual indicator distinct from a settled bubble", () => {
      const body = ruleBody(".UnicDB-chat-queued");
      expect(body, ".UnicDB-chat-queued rule block must exist").not.toBe("");
      // Accept either animation, opacity-based blink, or explicit inline-block
      // sizing — anything that makes the otherwise zero-width span visible.
      expect(
        /(animation:\s*\w+|opacity:\s*0?\.\d|display:\s*inline-block)/i.test(
          body,
        ),
        ".UnicDB-chat-queued must declare animation/opacity/display (visual marker)",
      ).toBe(true);
    });

    it("streaming caret: visible glyph on a streaming assistant bubble", () => {
      // The caret can live on the streaming bubble via ::after OR on the
      // .UnicDB-chat-caret span itself (TASK-002 used the latter: ensureStreamingCaret
      // appends <span class="UnicDB-chat-caret">). Accept either form.
      const directBody = ruleBody(".UnicDB-chat-caret");
      const streamingAfter =
        /\.UnicDB-chat-assistant\.UnicDB-chat-streaming::after\s*\{[^}]*content:\s*['"]/i.test(
          css,
        );
      const hasDirect =
        directBody !== "" &&
        /(display:\s*inline(?:-block)?|animation:\s*\w+|opacity:\s*0?\.\d|font-family)/i.test(
          directBody,
        );
      expect(
        hasDirect || streamingAfter,
        "streaming caret must be visible: either .UnicDB-chat-caret with display/animation OR .UnicDB-chat-assistant.UnicDB-chat-streaming::after with a non-empty content",
      ).toBe(true);
    });

    it("regenerateBtn: button-level affordance styled or inherits .UnicDB-chat-secondary", () => {
      // TASK-AG-001: regenerateBtn is an icon-only tile styled by the shared
      // `.UnicDB-chat-actions button` rule (28×28 square, cursor:pointer) — the
      // old per-ID override and the .UnicDB-chat-secondary text-button styling
      // are gone. Accept either the shared tile rule, a per-ID override, or
      // the legacy .UnicDB-chat-secondary class as the affordance contract.
      const rule = ruleBody("#regenerateBtn");
      const tile = ruleBody(".UnicDB-chat-actions button");
      const secondaryBody = ruleBody(".UnicDB-chat-secondary");
      const hasInline = /(padding|margin|font-size|color|background|border|cursor):\s*[^\s;]/i.test(
        rule,
      );
      const hasTile = /(width|height|cursor):\s*[^\s;]/i.test(tile);
      const hasSecondaryClass = /\.UnicDB-chat-secondary/.test(css);
      expect(
        hasInline || hasTile || hasSecondaryClass,
        "#regenerateBtn must be styled by the shared .UnicDB-chat-actions button tile, styled inline, OR inherit from .UnicDB-chat-secondary",
      ).toBe(true);
      if (!hasInline && !hasTile) {
        // Legacy fallback path: regenerateBtn shares .UnicDB-chat-secondary —
        // make sure that class has at least minimal button styling.
        expect(secondaryBody, ".UnicDB-chat-secondary rule block must exist").not.toBe("");
        expect(
          /(font-size|padding|cursor):\s*[^\s;]/i.test(secondaryBody),
          ".UnicDB-chat-secondary must declare at least one visual property",
        ).toBe(true);
      }
    });
  });

  it("resume-picker: row uses cursor:pointer + padding; card mirrors permission-card pattern", () => {
    const row = ruleBody(".UnicDB-chat-resume-row");
    expect(row, ".UnicDB-chat-resume-row rule block must exist").not.toBe("");
    expect(
      /cursor:\s*pointer/i.test(row),
      ".UnicDB-chat-resume-row must declare cursor:pointer",
    ).toBe(true);
    expect(
      /padding:\s*\d/i.test(row),
      ".UnicDB-chat-resume-row must declare a padding value",
    ).toBe(true);
    expect(
      hasHoverRule(".UnicDB-chat-resume-row"),
      ".UnicDB-chat-resume-row must have a :hover rule",
    ).toBe(true);

    const card = ruleBody(".UnicDB-chat-resume-card");
    expect(card, ".UnicDB-chat-resume-card rule block must exist").not.toBe("");
    expect(
      /border:\s*1px\s+solid/i.test(card),
      ".UnicDB-chat-resume-card must declare a 1px solid border",
    ).toBe(true);
    expect(
      /background:\s*var\(/i.test(card),
      ".UnicDB-chat-resume-card must use a --vscode- themed background",
    ).toBe(true);
    expect(
      /padding:\s*\d/i.test(card),
      ".UnicDB-chat-resume-card must declare a padding value",
    ).toBe(true);

    const label = ruleBody(".UnicDB-chat-resume-label");
    expect(label, ".UnicDB-chat-resume-label rule block must exist").not.toBe("");
    expect(
      /font-weight:\s*600/i.test(label),
      ".UnicDB-chat-resume-label must be bold (font-weight:600)",
    ).toBe(true);
    const detail = ruleBody(".UnicDB-chat-resume-detail");
    expect(detail, ".UnicDB-chat-resume-detail rule block must exist").not.toBe("");
    expect(
      /font-size:\s*\d/i.test(detail),
      ".UnicDB-chat-resume-detail must declare a font-size",
    ).toBe(true);
  });

  it("mention-dropdown: CSS-first selectors exist (consumed by TASK-005)", () => {
    for (const sel of [
      ".UnicDB-chat-mention-dropdown",
      ".UnicDB-chat-mention-row",
      ".UnicDB-chat-mention-kind",
    ]) {
      const body = ruleBody(sel);
      expect(body, `${sel} rule block must exist`).not.toBe("");
    }
    const card = ruleBody(".UnicDB-chat-mention-dropdown");
    expect(
      /border:\s*1px\s+solid/i.test(card),
      ".UnicDB-chat-mention-dropdown must declare a 1px solid border",
    ).toBe(true);
    expect(
      /background:\s*var\(/i.test(card),
      ".UnicDB-chat-mention-dropdown must use a --vscode- themed background",
    ).toBe(true);
    expect(
      /padding:\s*\d/i.test(card),
      ".UnicDB-chat-mention-dropdown must declare a padding value",
    ).toBe(true);
    const row = ruleBody(".UnicDB-chat-mention-row");
    expect(
      /cursor:\s*pointer/i.test(row),
      ".UnicDB-chat-mention-row must declare cursor:pointer",
    ).toBe(true);
    expect(
      hasHoverRule(".UnicDB-chat-mention-row"),
      ".UnicDB-chat-mention-row must have a :hover rule",
    ).toBe(true);
    const kind = ruleBody(".UnicDB-chat-mention-kind");
    expect(
      /font-size:\s*\d/i.test(kind),
      ".UnicDB-chat-mention-kind must declare a font-size",
    ).toBe(true);
  });

  it("getHtml emits UnicDB-chat-body on <body> so the height chain actually applies (fix round 1 re-review)", () => {
    // The CSS rule alone is dead if buildHtml never puts the class on the
    // body element. Same text-contract approach as the CSS checks above:
    // parse the panel source and assert the emitted body tag carries both
    // classes (the wire side of the height chain, reviewer R4.5 finding).
    const panelSrc = readFileSync(
      resolve(process.cwd(), "src", "ui", "aiChatPanel.ts"),
      "utf8",
    );
    expect(panelSrc).toContain('<body class="UnicDB-form-body UnicDB-chat-body">');
  });

  // -----------------------------------------------------------------------
  // Cycle AB — TASK-003 image-attach CSS contract.
  // The webview needs:
  //   - .UnicDB-chat-attach-btn     (icon button next to send)
  //   - .UnicDB-chat-attachments    (thumbnail strip ABOVE the textarea)
  //   - .UnicDB-chat-thumb          (56×56 frame, hosts an <img>)
  //   - .UnicDB-chat-thumb-remove   (absolute overlay on the thumbnail)
  //   - .UnicDB-chat-attach-warning (amber notice bubble)
  // Plus theme tokens declared at :root (light defaults) and overridden in a
  // [data-theme="dark"] block:
  //   --UnicDB-warning-bg / --UnicDB-warning-fg / --UnicDB-warning-border
  //   --UnicDB-overlay-bg
  //   --UnicDB-input-hover-bg
  //   --UnicDB-error-bg
  // The thumb strip lives inside .UnicDB-chat-input so the cycle-AA pinned
  // composer + height chain still owns scrolling; the css contract test below
  // guards that lock too (case h).
  // -----------------------------------------------------------------------
  describe("TASK-003 cycle AB — image attach CSS contract", () => {
    it("a) .UnicDB-chat-attach-btn present with cursor:pointer", () => {
      const body = ruleBody(".UnicDB-chat-attach-btn");
      expect(body, ".UnicDB-chat-attach-btn rule block must exist").not.toBe("");
      expect(
        /cursor:\s*pointer/i.test(body),
        ".UnicDB-chat-attach-btn must declare cursor:pointer",
      ).toBe(true);
    });

    it("a-focus) .UnicDB-chat-attach-btn:focus-visible declares a visible focus ring via theme token", () => {
      // The focus rule lives in a sibling block (selector + :focus-visible),
      // so scan the file-level CSS rather than ruleBody().
      expect(
        /\.UnicDB-chat-attach-btn(?:\.[\w-]+)*\s*:focus-visible\s*\{[^}]*outline\s*:/i.test(
          css,
        ),
        ".UnicDB-chat-attach-btn:focus-visible must declare an outline (visible focus ring)",
      ).toBe(true);
    });

    it("b) .UnicDB-chat-attachments strip layout (display:flex, gap:8px, overflow-x:auto, max-height:80px)", () => {
      const body = ruleBody(".UnicDB-chat-attachments");
      expect(body, ".UnicDB-chat-attachments rule block must exist").not.toBe("");
      expect(
        /display:\s*flex/i.test(body),
        ".UnicDB-chat-attachments must declare display:flex (horizontal row of thumbnails)",
      ).toBe(true);
      expect(
        /gap:\s*8px/i.test(body),
        ".UnicDB-chat-attachments must declare gap:8px",
      ).toBe(true);
      expect(
        /overflow-x:\s*auto/i.test(body),
        ".UnicDB-chat-attachments must declare overflow-x:auto (strip scrolls horizontally)",
      ).toBe(true);
      expect(
        /max-height:\s*80px/i.test(body),
        ".UnicDB-chat-attachments must declare max-height:80px (capped row height)",
      ).toBe(true);
    });

    it("c) .UnicDB-chat-thumb is a 56×56 frame with position:relative (anchors the remove button)", () => {
      const body = ruleBody(".UnicDB-chat-thumb");
      expect(body, ".UnicDB-chat-thumb rule block must exist").not.toBe("");
      expect(
        /width:\s*56px/i.test(body),
        ".UnicDB-chat-thumb must declare width:56px",
      ).toBe(true);
      expect(
        /height:\s*56px/i.test(body),
        ".UnicDB-chat-thumb must declare height:56px",
      ).toBe(true);
      expect(
        /position:\s*relative/i.test(body),
        ".UnicDB-chat-thumb must declare position:relative (anchors .UnicDB-chat-thumb-remove)",
      ).toBe(true);
    });

    it("d) .UnicDB-chat-thumb img uses object-fit:cover (fills the 56×56 frame without distortion)", () => {
      // ruleBody() does not understand compound selectors like
      // ".UnicDB-chat-thumb img", so scan the file-level CSS for a rule body
      // that declares object-fit:cover under that selector.
      expect(
        /\.UnicDB-chat-thumb\s+img\s*\{[^}]*object-fit:\s*cover/i.test(css),
        ".UnicDB-chat-thumb img must declare object-fit:cover",
      ).toBe(true);
    });

    it("e) .UnicDB-chat-thumb-remove is an absolute overlay (top:2px, right:2px)", () => {
      const body = ruleBody(".UnicDB-chat-thumb-remove");
      expect(
        body,
        ".UnicDB-chat-thumb-remove rule block must exist",
      ).not.toBe("");
      expect(
        /position:\s*absolute/i.test(body),
        ".UnicDB-chat-thumb-remove must declare position:absolute (overlay)",
      ).toBe(true);
      expect(
        /top:\s*2px/i.test(body),
        ".UnicDB-chat-thumb-remove must declare top:2px",
      ).toBe(true);
      expect(
        /right:\s*2px/i.test(body),
        ".UnicDB-chat-thumb-remove must declare right:2px",
      ).toBe(true);
    });

    it("f) .UnicDB-chat-attach-warning references var(--UnicDB-warning-bg) (theme-token contract)", () => {
      const body = ruleBody(".UnicDB-chat-attach-warning");
      expect(
        body,
        ".UnicDB-chat-attach-warning rule block must exist",
      ).not.toBe("");
      expect(
        /var\(\s*--UnicDB-warning-bg\s*\)/i.test(body),
        ".UnicDB-chat-attach-warning must reference var(--UnicDB-warning-bg)",
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
        "--UnicDB-warning-bg",
        "--UnicDB-warning-fg",
        "--UnicDB-warning-border",
        "--UnicDB-overlay-bg",
        "--UnicDB-input-hover-bg",
        "--UnicDB-error-bg",
      ];
      const found = bodies.some((b) =>
        tokens.some((tok) => new RegExp(tok + "\\s*:", "i").test(b)),
      );
      expect(
        found,
        `[data-theme="dark"] block must declare at least one of: ${tokens.join(", ")}`,
      ).toBe(true);
    });

    it("h) regression: body.UnicDB-chat-body { height: 100vh } rule still present (cycle AA height chain)", () => {
      const body = ruleBody("body.UnicDB-chat-body");
      expect(
        body,
        "body.UnicDB-chat-body rule block must still exist (cycle AA lock)",
      ).not.toBe("");
      expect(
        /height:\s*100vh/i.test(body),
        "body.UnicDB-chat-body must still declare height:100vh",
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // TASK-UX1-008 — R9 streaming one-char-per-line + R10 left padding tight.
  // Cases pinned in docs/AI_HANDOFF/tasks/TASK-UX1-008.md §Test Cases (1-6).
  // jsdom does not apply stylesheets, so the contract is asserted against
  // the source CSS text directly (same pattern as the rest of this file).
  // -----------------------------------------------------------------------
  describe("TASK-UX1-008 - streaming bubble layout (R9 + R10)", () => {
    it("R9 case 1: .UnicDB-chat-bubble declares min-height + width:fit-content and retains max-width<=95%", () => {
      const bubble = ruleBody(".UnicDB-chat-bubble");
      expect(bubble, ".UnicDB-chat-bubble rule block must exist").not.toBe("");
      // Positive min-height so an empty/short bubble still occupies one line
      // (prevents vertical one-char-per-line collapse during pre-first-delta).
      expect(
        /min-height:\s*\d/i.test(bubble),
        ".UnicDB-chat-bubble must declare a positive min-height (e.g. 1lh / 16px)",
      ).toBe(true);
      // fit-content so the bubble shrinks to its content width and never
      // gets reflowed into a one-char-wide column by flex sizing.
      expect(
        /width:\s*fit-content/i.test(bubble),
        ".UnicDB-chat-bubble must declare width:fit-content",
      ).toBe(true);
      // Cap retained so long SQL still wraps inside the panel.
      expect(
        /max-width:\s*95%/i.test(bubble),
        ".UnicDB-chat-bubble must RETAIN max-width:95% (regression guard)",
      ).toBe(true);
    });

    it("R9 case 2: .UnicDB-chat-caret no longer uses display:inline-block (was the one-char-per-line cause)", () => {
      const caret = ruleBody(".UnicDB-chat-caret");
      expect(caret, ".UnicDB-chat-caret rule block must exist").not.toBe("");
      expect(
        /display:\s*inline-block/i.test(caret),
        ".UnicDB-chat-caret must NOT declare display:inline-block (forces own line box, garbles streaming text)",
      ).toBe(false);
      // The fix replaces it with display:inline (or equivalent). Accept any
      // non-block value so the test stays pinned to the bug, not the syntax.
      expect(
        /display:\s*(?:inline(?:-flex)?|contents?)/i.test(caret),
        ".UnicDB-chat-caret must declare a non-block display value (inline/inline-flex/contents)",
      ).toBe(true);
    });

    it("R9 case 3: .UnicDB-chat-assistant.UnicDB-chat-streaming RETAINs white-space:pre-wrap (regression guard)", () => {
      // The naive "fix" for R9 would be white-space:normal — that would
      // collapse streamed multi-line SQL onto one line. Pinned regression.
      const streaming = ruleBody(".UnicDB-chat-assistant.UnicDB-chat-streaming");
      expect(
        streaming,
        ".UnicDB-chat-assistant.UnicDB-chat-streaming rule block must exist",
      ).not.toBe("");
      expect(
        /white-space:\s*pre-wrap/i.test(streaming),
        ".UnicDB-chat-assistant.UnicDB-chat-streaming must RETAIN white-space:pre-wrap",
      ).toBe(true);
      // Same guard at the base bubble level.
      const bubble = ruleBody(".UnicDB-chat-bubble");
      expect(
        /white-space:\s*pre-wrap/i.test(bubble),
        ".UnicDB-chat-bubble must RETAIN white-space:pre-wrap",
      ).toBe(true);
    });

    it("R10 case 4: assistant bubbles are NOT flush against the left border (padding-left>=12px or thread margin-left>=8px)", () => {
      const assistant = ruleBody(".UnicDB-chat-assistant");
      const thread = ruleBody(".UnicDB-chat-thread");
      expect(assistant, ".UnicDB-chat-assistant rule block must exist").not.toBe("");
      expect(thread, ".UnicDB-chat-thread rule block must exist").not.toBe("");
      const assistantPadding =
        /padding-left:\s*(?:1[2-9]|[2-9]\d|\d{3,})px/i.test(assistant);
      const threadMargin =
        /margin-left:\s*(?:[8-9]|[1-9]\d+)px/i.test(thread);
      expect(
        assistantPadding || threadMargin,
        "either .UnicDB-chat-assistant padding-left>=12px OR .UnicDB-chat-thread margin-left>=8px must hold (R10)",
      ).toBe(true);
    });

    it("R10 case 5: .UnicDB-chat-user retains align-self:flex-end (user bubble unaffected by R10)", () => {
      const user = ruleBody(".UnicDB-chat-user");
      expect(user, ".UnicDB-chat-user rule block must exist").not.toBe("");
      expect(
        /align-self:\s*flex-end/i.test(user),
        ".UnicDB-chat-user must RETAIN align-self:flex-end (right-aligned user bubble)",
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // TASK-UX1-009 — R11 chat improvements: case 8 (right-edge truncation).
  // The fix is anchored on the EXISTING `.UnicDB-chat-bubble` selector —
  // the task scope is APPEND-ONLY on UX1-008's existing rule block. The
  // bubble already has `white-space: pre-wrap` and `max-width:95%` from
  // UX1-008; R11 just adds `overflow-wrap: anywhere` so long SQL/code
  // lines break at the panel edge instead of overflowing horizontally.
  // -----------------------------------------------------------------------
  describe("TASK-UX1-009 - right-edge text truncation (R11)", () => {
    it("case 8: .UnicDB-chat-bubble declares overflow-wrap:anywhere (R11 truncation contract)", () => {
      const body = ruleBody(".UnicDB-chat-bubble");
      expect(body, ".UnicDB-chat-bubble rule block must exist").not.toBe("");
      expect(
        /overflow-wrap:\s*anywhere/i.test(body),
        ".UnicDB-chat-bubble must declare overflow-wrap:anywhere (R11 truncation)",
      ).toBe(true);
    });
  });
});
