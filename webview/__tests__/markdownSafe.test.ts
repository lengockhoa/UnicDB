// webview/__tests__/markdownSafe.test.ts — TASK-CLEAN2-007
//
// Direct contract tests for the canonical safe-markdown helpers.
// Mirrors the §Test Cases table in
// docs/AI_HANDOFF/tasks/TASK-CLEAN2-007.md:
//   1. happy — pinned markdown subset (bold, inline code, h2/h3, fenced code).
//   2. edge (XSS) — five-metachar escape mapping; hostile input inert.
//   3. edge (roundtrip) — fenced raw code recoverable through data-raw.
//   4. regression — aiChatPanelThread.test.ts suite (lives in a sibling file).
//   5. regression (bundle) — main panel suite + npm run compile (CI lane).

import { describe, it, expect } from "vitest";

import { escapeHtml, renderMarkdown } from "../markdownSafe";

describe("markdownSafe — escapeHtml (case #2 XSS / escaping)", () => {
  it("maps all five HTML metacharacters", () => {
    expect(escapeHtml("a&b<c>d\"e'f")).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });

  it("renders the bare five-char escape table", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("markdownSafe — renderMarkdown (case #1 happy)", () => {
  it("renders bold, inline code, h2 and h3 from the pinned subset", () => {
    const html = renderMarkdown("**b** and `c`\n\n## x\n\n### y");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<code>c</code>");
    expect(html).toContain("<h2>x</h2>");
    expect(html).toContain("<h3>y</h3>");
  });

  it("renders ## title\\n`code` keeping the h2 block raw and the trailing block bare", () => {
    // The block starts with `<h2>` so the `<p>` wrapper is skipped
    // (canonical behavior: only bare text blocks get wrapped).
    expect(renderMarkdown("## title\n`code`")).toBe(
      "<h2>title</h2>\n<code>code</code>",
    );
  });

  it("renders fenced sql block with class, lang, data-raw and Copy button", () => {
    const html = renderMarkdown("```sql\nSELECT 1\n```");
    expect(html).toContain("UnicDB-md-code");
    expect(html).toContain("UnicDB-md-code-lang-sql");
    expect(html).toContain('data-raw="SELECT 1"');
    expect(html).toContain("UnicDB-md-copy");
    expect(html).toContain(">Copy</button>");
  });
});

describe("markdownSafe — renderMarkdown (case #2 XSS / escaping)", () => {
  it("escapes hostile bold with embedded <img> before applying markdown syntax", () => {
    const html = renderMarkdown("**<img src=x onerror=boom>**");
    expect(html).toContain("<strong>&lt;img src=x onerror=boom&gt;</strong>");
    expect(html).not.toContain("<img");
  });
});

describe("markdownSafe — renderMarkdown (case #3 roundtrip via data-raw)", () => {
  it("escapes metacharacters inside fenced raw code into data-raw (double-escape contract)", () => {
    const html = renderMarkdown("```sql\nSELECT * FROM t WHERE a < 1 AND b > 2\n```");
    // fence content is escaped TWICE: once by the initial escapeHtml pass on
    // the whole input (so `<` → `&lt;`), then again when placed inside the
    // data-raw attribute (so `&lt;` → `&amp;lt;`). The Copy button handler
    // un-escapes once to land on `&lt;` and then un-escapes again via
    // `unescapeHtml` to recover the raw code.
    expect(html).toContain(
      'data-raw="SELECT * FROM t WHERE a &amp;lt; 1 AND b &amp;gt; 2"',
    );
    expect(html).toContain("UnicDB-md-copy");
  });

  it("trims a single trailing fence newline from the raw payload", () => {
    const html = renderMarkdown("```\nSELECT 1;\n```");
    expect(html).toContain('data-raw="SELECT 1;"');
    // Not the original newline-terminated body:
    expect(html).not.toContain('data-raw="SELECT 1;&#10;"');
  });
});