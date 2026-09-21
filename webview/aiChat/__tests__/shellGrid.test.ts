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
  it("pins all four shell children to explicit grid-row 1..4", () => {
    const cases: Array<[string, number]> = [
      ["\\.UnicDB-ai-chat-v2-header", 1],
      ["\\.UnicDB-ai-chat-v2-banner", 2],
      ["\\.UnicDB-ai-chat-v2-main", 3],
      ["\\.UnicDB-ai-chat-v2-composer", 4],
    ];
    for (const [selector, row] of cases) {
      expect(
        new RegExp(`${selector}\\s*\\{[^}]*grid-row:\\s*${row}\\b`).test(stripped()),
        `expected ${selector.replace(/\\\\/g, "")} to declare grid-row: ${row}`,
      ).toBe(true);
    }
    // The bottom info bar is gone — no -hint rule may remain.
    expect(/\.UnicDB-ai-chat-v2-hint\s*\{/.test(stripped())).toBe(false);
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
      "\\.UnicDB-ai-chat-v2-footnote",
      "\\.UnicDB-ai-chat-v2-usage",
      "\\.UnicDB-ai-chat-v2-engine-state",
    ];
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

describe("TASK-CHATUX-001 layout stabilization contract", () => {
  it("keeps minmax(0,1fr) transcript track and transcript as sole overflow-y:auto region", () => {
    const root = ruleBody("\\.UnicDB-ai-chat-v2");
    expect(root, "root .UnicDB-ai-chat-v2 rule must exist").toBeDefined();
    expect(root).toMatch(
      /grid-template-rows:\s*40px\s+auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/,
    );

    const transcript = ruleBody("\\.UnicDB-ai-chat-v2-transcript");
    expect(transcript, ".UnicDB-ai-chat-v2-transcript rule must exist").toBeDefined();
    const scrollDecls = transcript!.match(/overflow-y:\s*auto/g) ?? [];
    expect(scrollDecls).toHaveLength(1);

    // Context strip scrolls horizontally only — never a second vertical region.
    const context = ruleBody("\\.UnicDB-ai-chat-v2-context");
    expect(context, ".UnicDB-ai-chat-v2-context rule must exist").toBeDefined();
    expect(context).toMatch(/overflow-x:\s*auto/);
    expect(context).not.toMatch(/overflow-y:\s*auto/);
  });

  it("TASK-CHATUX2-001: 4-row root grid, 5px bottom padding, footnote + header stat rules", () => {
    const root = ruleBody("\\.UnicDB-ai-chat-v2");
    expect(root, "root .UnicDB-ai-chat-v2 rule must exist").toBeDefined();
    // Exactly four tracks: header · banner · main · composer.
    expect(root).toMatch(
      /grid-template-rows:\s*40px\s+auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/,
    );
    // ~5px gap between the composer card and the panel edge.
    expect(root).toMatch(/padding:\s*10px\s+12px\s+5px\s*;/);

    // The keyboard hint lives inside the composer card, right-aligned.
    const footnote = ruleBody("\\.UnicDB-ai-chat-v2-footnote");
    expect(footnote, "-footnote rule must exist").toBeDefined();
    expect(footnote).toMatch(/font-size:\s*11px/);
    expect(footnote).toMatch(/line-height:\s*16px/);
    expect(footnote).toMatch(/color:\s*var\(--UnicDB-ai-chat-v2-muted\)/);
    expect(footnote).toMatch(/text-align:\s*right/);

    // Header stats: muted 11/16, nowrap; usage pinned to the right zone.
    for (const sel of [
      "\\.UnicDB-ai-chat-v2-usage",
      "\\.UnicDB-ai-chat-v2-engine-state",
    ]) {
      const body = ruleBody(sel);
      expect(body, `${sel} rule must exist`).toBeDefined();
      expect(body).toMatch(/font-size:\s*11px/);
      expect(body).toMatch(/line-height:\s*16px/);
      expect(body).toMatch(/color:\s*var\(--UnicDB-ai-chat-v2-muted\)/);
      expect(body).toMatch(/white-space:\s*nowrap/);
    }
    expect(ruleBody("\\.UnicDB-ai-chat-v2-usage")).toMatch(
      /margin-left:\s*auto/,
    );
  });

  it("TASK-CHATUX2-001: tree rail + branch stubs + dimmed reasoning", () => {
    // The rail extends to reasoning items (shared ::before selector).
    const rail = stripped().match(
      /\.UnicDB-ai-chat-v2-item-tool::before\s*,\s*\.UnicDB-ai-chat-v2-item-reasoning::before\s*\{([^}]*)\}/,
    );
    expect(rail, "shared -item-tool/-item-reasoning ::before rail must exist").not.toBeNull();
    expect(rail![1]).toMatch(/left:\s*9px/);
    expect(rail![1]).toMatch(/top:\s*0/);
    expect(rail![1]).toMatch(/bottom:\s*0/);

    // Reasoning items anchor their rail/stub like tool items.
    const reasoningItem = ruleBody("\\.UnicDB-ai-chat-v2-item-reasoning");
    expect(reasoningItem).toMatch(/position:\s*relative/);

    // data-tree variants trim the rail at run boundaries.
    const first = stripped().match(
      /\.UnicDB-ai-chat-v2-item-tool\[data-tree~="first"\]::before\s*,\s*\.UnicDB-ai-chat-v2-item-reasoning\[data-tree~="first"\]::before\s*\{([^}]*)\}/,
    );
    expect(first, 'data-tree="first" rail variant must exist').not.toBeNull();
    expect(first![1]).toMatch(/top:\s*14px/);
    const last = stripped().match(
      /\.UnicDB-ai-chat-v2-item-tool\[data-tree~="last"\]::before\s*,\s*\.UnicDB-ai-chat-v2-item-reasoning\[data-tree~="last"\]::before\s*\{([^}]*)\}/,
    );
    expect(last, 'data-tree="last" rail variant must exist').not.toBeNull();
    expect(last![1]).toMatch(/bottom:\s*calc\(100%\s*-\s*14px\)/);

    // Branch stub: 1px × 10px horizontal tick on both step kinds.
    const stub = stripped().match(
      /\.UnicDB-ai-chat-v2-item-tool::after\s*,\s*\.UnicDB-ai-chat-v2-item-reasoning::after\s*\{([^}]*)\}/,
    );
    expect(stub, "shared ::after branch stub must exist").not.toBeNull();
    expect(stub![1]).toMatch(/left:\s*9px/);
    expect(stub![1]).toMatch(/top:\s*14px/);
    expect(stub![1]).toMatch(/width:\s*10px/);

    // Thinking text: dimmed (muted color) + smaller.
    const body = ruleBody("\\.UnicDB-ai-chat-v2-reasoning-body");
    expect(body, "-reasoning-body rule must exist").toBeDefined();
    expect(body).toMatch(/font-size:\s*12px/);
    expect(body).toMatch(/line-height:\s*18px/);
    expect(body).toMatch(/color:\s*var\(--UnicDB-ai-chat-v2-muted\)/);

    const toggle = ruleBody("\\.UnicDB-ai-chat-v2-reasoning-toggle");
    expect(toggle, "-reasoning-toggle rule must exist").toBeDefined();
    expect(toggle).toMatch(/min-height:\s*24px/);
    expect(toggle).toMatch(/font-size:\s*11px/);
  });

  it("has no fixed positioning or fixed widths on message blocks", () => {
    expect(stripped()).not.toMatch(/position:\s*fixed/);

    const m = stripped().match(
      /\.UnicDB-ai-chat-v2-item-text[^{]*\{([^}]*)\}/,
    );
    expect(m, "item-text/item-reasoning rule must exist").not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/max-width:\s*92%/);
    expect(body).not.toMatch(/(^|;)\s*width\s*:/);
    expect(body).not.toMatch(/(^|;)\s*max-inline-size\s*:/);
  });

  it("normalizes Markdown block spacing", () => {
    const paragraph = ruleBody("\\.UnicDB-ai-chat-v2-md-paragraph");
    expect(paragraph, "md-paragraph rule must exist").toBeDefined();
    expect(paragraph).toMatch(/margin:\s*0 0 8px/);

    const heading = ruleBody("\\.UnicDB-ai-chat-v2-md-heading");
    expect(heading, "md-heading rule must exist").toBeDefined();
    expect(heading).toMatch(/margin:\s*12px 0 6px/);

    const code = ruleBody("\\.UnicDB-ai-chat-v2-code");
    expect(code, "code rule must exist").toBeDefined();
    expect(code).toMatch(/overflow-x:\s*auto/);
    expect(code).toMatch(/white-space:\s*pre\s*;/);
  });
});
