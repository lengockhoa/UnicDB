// webview/markdownSafe.ts — TASK-CLEAN2-007
//
// Canonical safe-markdown helpers for the webview. Both
// `webview/aiChatPanelMain.ts` and `webview/aiChatPanelThread.ts` import
// from here; aiChatPanelThread re-exports `renderMarkdown` for back-compat
// with existing external import paths.
//
// SECURITY: this module is part of the webview asset boundary; nothing in
// it may execute on the host. The TASK-002 escape-first / controlled-
// replace contract applies in full: every user-controlled character is
// HTML-escaped BEFORE the controlled markdown replacement set runs.

// ------------------------------------------------------------------
// Helpers (escaped text + a tiny markdown → safe-HTML string helper).
// ------------------------------------------------------------------

/** Escape the five HTML metacharacters. Used by both renderMarkdown and
 * the assistant plain-text branch. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

/**
 * Minimal markdown → safe HTML. Only the syntax the agent is expected to
 * emit:
 *   - ## / ### headings
 *   - fenced code ```…```
 *   - inline `code`
 *   - **bold**
 *   - line breaks (blank line → new paragraph)
 *
 * The contract is: escape FIRST, then re-introduce the controlled subset
 * of HTML through replacement. User content can never reach the page as
 * live nodes.
 */
export function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  const fences: Array<{ lang: string; code: string }> = [];
  let html = escaped.replace(
    /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const idx = fences.length;
      fences.push({ lang, code: code.replace(/\n$/, "") });
      return "\u0000FENCE" + idx + "\u0000";
    },
  );
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const blocks = html.split(/\n{2,}/);
  const joined = blocks
    .map((b) => (b.startsWith("<") ? b : `<p>${b.replace(/\n/g, "<br>")}</p>`))
    .join("\n");
  return joined.replace(
    /\u0000FENCE(\d+)\u0000/g,
    (_m, idxStr: string) => {
      const idx = Number(idxStr);
      const f = fences[idx]!;
      return `<pre class="UnicDB-md-code" data-raw="${escapeHtml(f.code)}"><code class="UnicDB-md-code-lang-${escapeHtml(f.lang)}">${f.code}</code><button type="button" class="UnicDB-md-copy">Copy</button></pre>`;
    },
  );
}
