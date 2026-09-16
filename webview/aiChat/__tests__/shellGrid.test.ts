// webview/aiChat/__tests__/shellGrid.test.ts — TASK-CHATFIX-001
//
// CSS-text contract for the explicit V2 shell grid placement: a display:none
// banner must never shift auto-placed grid children, so every shell child is
// pinned to an explicit grid-row (header=1, banner=2, main=3, composer=4,
// hint=5) and the main element becomes a flex column that lets the transcript
// stay the sole scroll region.
// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = resolve(process.cwd(), "webview", "aiChat", "styles.css");
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

/** Strip CSS comments so brace counting / body matching see real code only. */
function stripped(): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Body of the FIRST rule whose selector matches `selector` exactly. */
function ruleBody(selector: string): string | undefined {
  const m = stripped().match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  return m?.[1];
}

function ruleBodyHas(selector: string, declaration: string): boolean {
  const body = ruleBody(selector);
  return body !== undefined && new RegExp(declaration).test(body);
}

describe("TASK-CHATFIX-001 explicit shell grid placement", () => {
  it("pins all five shell children to explicit grid-row 1..5", () => {
    const cases: Array<[string, number]> = [
      ["\\.UnicDB-ai-chat-v2-header", 1],
      ["\\.UnicDB-ai-chat-v2-banner", 2],
      ["\\.UnicDB-ai-chat-v2-main", 3],
      ["\\.UnicDB-ai-chat-v2-composer", 4],
      ["\\.UnicDB-ai-chat-v2-hint", 5],
    ];
    for (const [selector, row] of cases) {
      expect(
        new RegExp(`${selector}\\s*\\{[^}]*grid-row:\\s*${row}\\b`).test(stripped()),
        `expected ${selector.replace(/\\\\/g, "")} to declare grid-row: ${row}`,
      ).toBe(true);
    }
  });

  it("keeps the composer on a content-sized track that cannot be crushed", () => {
    const root = ruleBody("\\.UnicDB-ai-chat-v2");
    expect(root, "root .UnicDB-ai-chat-v2 rule must exist").toBeDefined();
    expect(root).toMatch(/grid-template-rows:[^;]*minmax\(0,\s*1fr\)/);
    expect(ruleBodyHas("\\.UnicDB-ai-chat-v2-composer", "grid-row:\\s*4")).toBe(true);
  });

  it("makes the transcript the sole scroll region via a flex main", () => {
    const main = ruleBody("\\.UnicDB-ai-chat-v2-main");
    expect(main, ".UnicDB-ai-chat-v2-main rule must exist").toBeDefined();
    expect(main).toMatch(/display:\s*flex/);
    expect(main).toMatch(/flex-direction:\s*column/);
    expect(main).toMatch(/min-width:\s*0/);
    expect(main).toMatch(/min-height:\s*0/);
    const transcript = ruleBody("\\.UnicDB-ai-chat-v2-transcript");
    expect(transcript, ".UnicDB-ai-chat-v2-transcript rule must exist").toBeDefined();
    expect(transcript).toMatch(/overflow-y:\s*auto/);
    expect(transcript).toMatch(/min-height:\s*0/);
  });

  it("clips at the root only — main never hides overflow", () => {
    const root = ruleBody("\\.UnicDB-ai-chat-v2");
    expect(root).toMatch(/overflow:\s*hidden/);
    const main = ruleBody("\\.UnicDB-ai-chat-v2-main");
    expect(main).toBeDefined();
    expect(main).not.toMatch(/overflow:\s*hidden/);
  });

  it("keeps every new placement rule V2-scoped with balanced braces", () => {
    const selectors = [
      "\\.UnicDB-ai-chat-v2-header",
      "\\.UnicDB-ai-chat-v2-banner",
      "\\.UnicDB-ai-chat-v2-main",
      "\\.UnicDB-ai-chat-v2-composer",
      "\\.UnicDB-ai-chat-v2-hint",
    ];
    for (const selector of selectors) {
      expect(new RegExp(`${selector}\\s*\\{`).test(stripped())).toBe(true);
      expect(selector).toContain("\\.UnicDB-ai-chat-v2");
    }
    const withoutComments = stripped();
    const opens = (withoutComments.match(/\{/g) ?? []).length;
    const closes = (withoutComments.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("lets a hidden banner keep its explicit track", () => {
    expect(
      /\.UnicDB-ai-chat-v2-banner\[hidden\]\s*\{[^}]*display:\s*none/.test(stripped()),
    ).toBe(true);
    expect(ruleBodyHas("\\.UnicDB-ai-chat-v2-banner", "grid-row:\\s*2")).toBe(true);
  });
});
