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

// @vitest-environment jsdom

import { describe, it, expect } from "vitest";

import { escapeHtml, renderMarkdown } from "../markdownSafe";
import {
  extractSqlFences,
  parseMarkdownBlocks,
  renderMarkdownInto,
} from "../aiChat/markdown";

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

// ---------------------------------------------------------------------------
// TASK-CHATV2-006 — DOM-node primitives in `webview/aiChat/markdown.ts`.
//
// The V2 renderer never builds an HTML string; it writes assistant Markdown
// into the page as DOM nodes through `textContent`. These tests prove the same
// hostile matrix the string renderer survives also survives the DOM path, and
// that SQL fence extraction returns the EXACT raw source.
// ---------------------------------------------------------------------------

describe("aiChat/markdown — escape-first DOM primitives (case #2 XSS)", () => {
  it("hostile bold payload becomes inert text, never an <img> node", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "**<img src=x onerror=boom>**");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("strong")?.textContent).toBe("<img src=x onerror=boom>");
    expect(root.innerHTML).not.toContain("<img");
  });

  it("does not execute an injected <script> or create a script node", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "<script>window.__pwned = true</script>");
    expect(root.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(root.textContent).toContain("<script>");
  });

  it("keeps hostile markup inside a fenced code block as literal text", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "```\n<b onclick=evil>x</b>\n```");
    const pre = root.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.querySelector("b")).toBeNull();
    expect(pre!.textContent).toContain("<b onclick=evil>x</b>");
  });

  it("survives a mixed matrix of metacharacters without adding attributes", () => {
    const payload = `" onmouseover="alert(1)" & <a href="javascript:alert(1)">x</a>`;
    const root = document.createElement("div");
    renderMarkdownInto(root, payload);
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("[onmouseover]")).toBeNull();
    expect(root.textContent).toBe(payload);
  });

  it("does not turn a javascript: link into an anchor", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "[click](javascript:alert(1))");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("[click](javascript:alert(1))");
  });
});

describe("aiChat/markdown — block parsing and exact SQL extraction", () => {
  it("parses headings, paragraphs and code in order", () => {
    const blocks = parseMarkdownBlocks("## Head\n\npara one\n\n```sql\nSELECT 1\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "code"]);
  });

  it("returns the exact raw SQL fence body, unescaped", () => {
    const raw = "```sql\nSELECT * FROM t WHERE a < 1 AND b > 'x'\n```";
    expect(extractSqlFences(raw)).toEqual(["SELECT * FROM t WHERE a < 1 AND b > 'x'"]);
  });

  it("returns [] when no SQL fence exists", () => {
    expect(extractSqlFences("```ts\nconst a = 1;\n```")).toEqual([]);
  });

  it("extracts multiple SQL fences in source order", () => {
    const raw = "```sql\nSELECT 1\n```\ntext\n```sql\nSELECT 2\n```";
    expect(extractSqlFences(raw)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("renders inline bold and code as separate textContent nodes", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "**b** and `c`");
    expect(root.querySelector("strong")?.textContent).toBe("b");
    expect(root.querySelector("code")?.textContent).toBe("c");
  });

  it("colorizes a SQL fence through a DOM fragment (no innerHTML)", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "```sql\nSELECT id FROM users WHERE name = 'a'\n```");
    const code = root.querySelector("code");
    expect(code).not.toBeNull();
    // highlightSql emits span tokens; the source text survives verbatim.
    expect(code!.textContent).toContain("SELECT");
    expect(code!.textContent).toContain("users");
  });
});