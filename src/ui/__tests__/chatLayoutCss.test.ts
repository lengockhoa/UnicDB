// src/ui/__tests__/chatLayoutCss.test.ts
// TASK-003 - Chat layout CSS contract (pinned composer + full-height thread,
// plus TASK-002 affordances + TASK-005 mention-dropdown selectors).
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

/** True if any `selector:hover` (or `selector.x:hover`) rule exists in the file. */
function hasHoverRule(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match either `selector:hover` or compound `.vsdb-x.vsdb-chat-resume-row:hover` etc.
  const re = new RegExp(`${escaped}(?:\\.[\\w-]+)*\s*:hover\\s*\\{`);
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
    expect(
      /max-height:\s*60vh/i.test(body),
      ".vsdb-chat-thread must NOT contain max-height:60vh (kills the bug)",
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
});
