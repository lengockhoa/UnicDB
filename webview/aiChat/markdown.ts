// webview/aiChat/markdown.ts — TASK-CHATV2-006
//
// Escape-first Markdown primitives for the V2 transcript.
//
// WHY A SECOND MODULE. `webview/markdownSafe.ts` (TASK-CLEAN2-007) renders a
// Markdown *string* of escaped-then-marked HTML for the V1 bubble path. The V2
// renderer must never depend on that string contract: assistant Markdown has to
// become DOM nodes directly so a streaming message can be repainted without
// re-parsing and without any `innerHTML` assignment. This module keeps the SAME
// escape-first discipline the V1 renderer proved, but the escape step is the
// act of writing through `textContent`/`createTextNode` — there is no string of
// markup to get wrong.
//
// CONTRACT
// - `escapeHtml` is re-exported from `markdownSafe` so the webview keeps ONE
//   escape table (never a second, drifting copy).
// - Every node this module builds carries caller text via `textContent`. No
//   function here assigns `innerHTML`. A hostile payload can therefore only
//   ever become inert text.
// - The rendered subset is intentionally tiny: `##`/`###` headings, fenced code
//   blocks, `**bold**`, `` `inline code` ``, blank-line paragraphs and in-
//   paragraph line breaks. No link/image/raw-HTML syntax is recognized, so no
//   scheme filtering is needed — links simply stay text.
// - SQL fenced blocks are colorized through `highlightSql`, which itself builds
//   a fragment with `createElement` + `textContent` only.
//
// Pure DOM TypeScript: no `vscode`, no node builtins.

import { highlightSql } from "../sqlHighlight";
import { escapeHtml } from "../markdownSafe";

export { escapeHtml };

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

/** One parsed Markdown block. `code` blocks carry their raw (unescaped) body. */
export type MarkdownBlock =
  | { readonly kind: "heading"; readonly level: 2 | 3; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly code: string }
  | { readonly kind: "paragraph"; readonly text: string };

/** Precompiled fenced-code matcher (language tag optional). */
const FENCE_RE = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;

/** True when a fence language names SQL (the only language we colorize). */
export function isSqlLang(lang: string): boolean {
  return lang.toLowerCase() === "sql";
}

/**
 * Parse raw Markdown into the pinned block subset.
 *
 * Fenced blocks are extracted FIRST so markdown-looking text inside code is
 * never interpreted. A fence whose body is empty is dropped (it would render
 * as an empty box).
 */
export function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (segment: string): void => {
    for (const chunk of segment.split(/\n{2,}/)) {
      const text = chunk.replace(/\s+$/, "");
      if (text.length === 0) continue;
      const heading = /^(#{2,3})[ \t]+([\s\S]*)$/.exec(text);
      if (heading !== null && !text.includes("\n")) {
        blocks.push({ kind: "heading", level: heading[1]!.length === 2 ? 2 : 3, text: heading[2]! });
      } else {
        blocks.push({ kind: "paragraph", text });
      }
    }
  };

  while ((match = FENCE_RE.exec(raw)) !== null) {
    pushText(raw.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const code = match[2]!.replace(/\n$/, "");
    if (code.length > 0) {
      blocks.push({ kind: "code", lang: match[1]!, code });
    }
  }
  pushText(raw.slice(cursor));
  return blocks;
}

/**
 * Return the exact raw source of every SQL fenced block in `raw`, in order.
 *
 * This is the ONLY source of the `Insert SQL` action payload: the controller
 * gets the unmodified code body, never a DOM read-back and never an escaped
 * form.
 */
export function extractSqlFences(raw: string): string[] {
  const out: string[] = [];
  for (const block of parseMarkdownBlocks(raw)) {
    if (block.kind === "code" && isSqlLang(block.lang)) out.push(block.code);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline rendering (`**bold**` / `` `code` ``) — textContent only.
// ---------------------------------------------------------------------------

type InlineToken =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong"; readonly value: string }
  | { readonly type: "code"; readonly value: string };

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** Split a paragraph into text/strong/code tokens. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > cursor) tokens.push({ type: "text", value: text.slice(cursor, match.index) });
    const token = match[1]!;
    if (token.startsWith("**")) tokens.push({ type: "strong", value: token.slice(2, -2) });
    else tokens.push({ type: "code", value: token.slice(1, -1) });
    cursor = match.index + token.length;
  }
  if (cursor < text.length) tokens.push({ type: "text", value: text.slice(cursor) });
  return tokens;
}

/** Write inline tokens into `parent`, turning `\n` into `<br>` elements. */
function appendInline(parent: HTMLElement, text: string): void {
  for (const token of parseInline(text)) {
    if (token.type === "text") {
      const lines = token.value.split("\n");
      lines.forEach((line, index) => {
        if (index > 0) parent.appendChild(document.createElement("br"));
        if (line.length > 0) parent.appendChild(document.createTextNode(line));
      });
      continue;
    }
    const el = document.createElement(token.type === "strong" ? "strong" : "code");
    el.textContent = token.value;
    parent.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// DOM block builders
// ---------------------------------------------------------------------------

/** Build a `<pre><code>` code block, colorizing SQL through DOM fragments. */
export function createCodeBlock(block: { readonly lang: string; readonly code: string }): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "UnicDB-ai-chat-v2-code";
  if (block.lang.length > 0) pre.setAttribute("data-lang", block.lang);
  const code = document.createElement("code");
  code.className = `UnicDB-ai-chat-v2-code-${block.lang.length > 0 ? block.lang : "plain"}`;
  if (isSqlLang(block.lang)) {
    // highlightSql builds a fragment from createElement/textContent only.
    code.appendChild(highlightSql(block.code));
  } else {
    code.textContent = block.code;
  }
  pre.appendChild(code);
  return pre;
}

/** Build one block element. */
export function createBlockElement(block: MarkdownBlock): HTMLElement {
  if (block.kind === "code") return createCodeBlock(block);
  if (block.kind === "heading") {
    const el = document.createElement(`h${block.level}`);
    el.className = "UnicDB-ai-chat-v2-md-heading";
    appendInline(el, block.text);
    return el;
  }
  const p = document.createElement("p");
  p.className = "UnicDB-ai-chat-v2-md-paragraph";
  appendInline(p, block.text);
  return p;
}

/**
 * Replace `root`'s children with the rendered Markdown for `raw`.
 *
 * `root` should be a dedicated body element the caller owns; this function
 * clears it with `replaceChildren` and never touches the caller's own nodes.
 */
export function renderMarkdownInto(root: HTMLElement, raw: string): void {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdownBlocks(raw)) {
    fragment.appendChild(createBlockElement(block));
  }
  root.replaceChildren(fragment);
}
