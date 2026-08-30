import { describe, expect, it } from "vitest";
import {
  extractSelection,
  formatSelectionBlock,
  MAX_SELECTION_CHARS,
} from "../selection";

describe("extractSelection", () => {
  it("returns null for empty text", () => {
    expect(extractSelection({ path: "a.ts", text: "" })).toBeNull();
  });

  it("trims blank edges (leading and trailing empty lines)", () => {
    const sel = extractSelection({
      path: "a.ts",
      text: "\n\n  \n\nline one\nline two\n\n  \n",
    });
    expect(sel).not.toBeNull();
    expect(sel!.text).toBe("line one\nline two");
    // 4 blank lines trimmed off the top; startLine is 1-based into the
    // source file, so the first kept line is at 5.
    expect(sel!.startLine).toBe(5);
  });

  it("clamps explicit line range to the captured text", () => {
    const sel = extractSelection({
      path: "a.ts",
      text: "x\ny\nz",
      startLine: 0,
      endLine: 99,
    });
    expect(sel).not.toBeNull();
    expect(sel!.endLine).toBe(3);
  });

  it("caps text at MAX_SELECTION_CHARS and flags truncated", () => {
    const big = "a".repeat(MAX_SELECTION_CHARS + 200);
    const sel = extractSelection({ path: "huge.txt", text: big });
    expect(sel).not.toBeNull();
    expect(sel!.text.length).toBe(MAX_SELECTION_CHARS);
    expect(sel!.truncated).toBe(true);
  });

  it("keeps truncated=false when text is at or under the cap", () => {
    const sel = extractSelection({ path: "ok.txt", text: "x".repeat(MAX_SELECTION_CHARS) });
    expect(sel).not.toBeNull();
    expect(sel!.truncated).toBe(false);
  });

  it("preserves CRLF lines and unicode content", () => {
    const sel = extractSelection({
      path: "u.txt",
      text: "ẞ\n日本語\nplain",
    });
    expect(sel).not.toBeNull();
    expect(sel!.text).toBe("ẞ\n日本語\nplain");
  });

  it("formats a header + body block with 1-based inclusive lines", () => {
    const sel = extractSelection({ path: "src/x.ts", text: "alpha\nbeta" });
    expect(sel).not.toBeNull();
    const out = formatSelectionBlock(sel!);
    expect(out).toContain("src/x.ts:1-2");
    expect(out).toContain("alpha\nbeta");
  });

  it("rejects null/undefined/non-string text", () => {
    // @ts-expect-error runtime guard
    expect(extractSelection({ path: "a.ts", text: null })).toBeNull();
    // @ts-expect-error runtime guard
    expect(extractSelection({ path: "a.ts" })).toBeNull();
  });
});

describe("extractSelection — leading-blank offsets (reviewer regression)", () => {
  it("shifts host offsets past trimmed leading blanks", () => {
    // Host selection begins at document line 100; the first two lines
    // are blank, so the kept content starts at line 102.
    const sel = extractSelection({
      path: "a.ts",
      text: "\n\ncontent line A\ncontent line B",
      startLine: 100,
      endLine: 103,
    });
    expect(sel).not.toBeNull();
    expect(sel!.text).toBe("content line A\ncontent line B");
    expect(sel!.startLine).toBe(102);
    expect(sel!.endLine).toBe(103);
  });

  it("keeps verbatim host offsets when no blanks are trimmed", () => {
    const sel = extractSelection({
      path: "a.ts",
      text: "alpha\nbeta",
      startLine: 100,
      endLine: 101,
    });
    expect(sel!.startLine).toBe(100);
    expect(sel!.endLine).toBe(101);
  });
});
