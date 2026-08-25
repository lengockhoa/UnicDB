// src/ui/__tests__/sqlHighlight.test.ts — TASK-003 cases 1-7.
//
// Pure node tests for the webview SQL tokenizer. The file runs under jsdom
// because `highlightSql` builds a DocumentFragment; cases 1-2 / 5 / 7 only
// touch the pure `tokenizeSql` function (no DOM needed).
//
// SECURITY under test (case 4): hostile SQL that embeds HTML must never
// become live markup — the tokenizer writes every character through
// span.textContent, so `<img src=x onerror=…>` stays literal text.
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { tokenizeSql, highlightSql } from "../../../webview/sqlHighlight";

describe("sqlHighlight — tokenizeSql", () => {
  it("case 1 — tokenizes keywords, identifiers, numbers", () => {
    const tokens = tokenizeSql("SELECT 1 FROM t");
    // Whitespace is emitted as `ws` tokens explicitly (asserted either way).
    const kinds = tokens.map((t) => t.kind);
    expect(kinds.filter((k) => k !== "ws")).toEqual([
      "keyword",
      "number",
      "keyword",
      "ident",
    ]);
    // Whitespace must actually be present as ws tokens between the tokens.
    expect(kinds).toContain("ws");
  });

  it("case 2 — string literal and line comment are single tokens", () => {
    const tokens = tokenizeSql("SELECT 'a b' -- c");
    const strings = tokens.filter((t) => t.kind === "string");
    const comments = tokens.filter((t) => t.kind === "comment");
    expect(strings).toHaveLength(1);
    expect(strings[0]!.text).toBe("'a b'");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toBe("-- c");
  });

  it("case 5 — unterminated string terminates and does not hang", () => {
    const start = Date.now();
    const tokens = tokenizeSql("SELECT 'abc");
    const elapsed = Date.now() - start;
    // Explicit elapsed-time bound — a lexer that never advances on an
    // unterminated quote would spin forever; this fails fast.
    expect(elapsed).toBeLessThan(50);
    const tail = tokens[tokens.length - 1]!;
    expect(tail.kind).toBe("string");
    expect(tail.text).toBe("'abc");
  });

  it("case 7 — bracket and backtick identifiers are one ident token each", () => {
    const tokens = tokenizeSql("SELECT [a b], `c d` FROM t");
    const idents = tokens.filter((t) => t.kind === "ident");
    const texts = idents.map((t) => t.text);
    // mssql [..] and mysql `..` quoting — each a single ident token.
    expect(texts).toContain("[a b]");
    expect(texts).toContain("`c d`");
  });
});

describe("sqlHighlight — highlightSql fragment", () => {
  it("case 3 — fragment textContent round-trips a 5-statement sample", () => {
    const input = [
      "SELECT id, name FROM users WHERE age > 21;",
      "INSERT INTO logs (msg) VALUES ('hello world');",
      "-- note: do not run",
      "UPDATE t SET x = 1.5 WHERE id = 3;",
      "SELECT * FROM [order] WHERE total >= 100;",
    ].join("\n");
    const frag = highlightSql(input);
    // No character is dropped or duplicated.
    expect(frag.textContent).toBe(input);
  });

  it("case 4 — hostile SQL never becomes live markup", () => {
    const frag = highlightSql("SELECT '<img src=x onerror=alert(1)>'");
    // The literal `<img …>` must never parse into a live element.
    expect(frag.querySelectorAll("img").length).toBe(0);
    expect(frag.textContent).toContain("<img");
  });

  it("case 6a — empty input yields an empty fragment", () => {
    const frag = highlightSql("");
    expect(frag.childNodes.length).toBe(0);
  });

  it("case 6b — whitespace-only input round-trips whitespace", () => {
    const frag = highlightSql("   ");
    expect(frag.textContent).toBe("   ");
  });
});
