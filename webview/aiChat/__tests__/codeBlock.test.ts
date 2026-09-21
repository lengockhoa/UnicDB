// webview/aiChat/__tests__/codeBlock.test.ts — TASK-CHATUX-003
//
// Contract tests for the W3 code-block visual system (SPEC FR-005 / §8.2):
// every fenced block renders inside a `-codeblock` wrapper carrying a header
// strip (language label + Copy button) around the existing `pre.-code`.
// Copy feedback is the frozen label round-trip Copy → Copied|Failed → Copy
// after 1500 ms, and a missing/rejecting clipboard never throws.
//
// Covers the task §Test Cases table:
//   1 happy       sql fence → wrapper + header + lang label + Copy
//   2 edge        fence without language → "text" label + -plain class
//   3 edge        clipboard rejection → Failed then restores Copy (1500ms)
//   + missing clipboard API → Failed, no throw
//   + rapid clicks reset the restore timer (SPEC §10)
//   + source scan: markdown.ts never assigns innerHTML
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { createCodeBlock, renderMarkdownInto } from "../markdown";

const PREFIX = "UnicDB-ai-chat-v2";
const COPY_LABEL = "Copy";
const COPIED_LABEL = "Copied";
const FAILED_LABEL = "Failed";
const RESTORE_MS = 1500;

function stubClipboard(impl: (text: string) => Promise<void>): Mock<(text: string) => Promise<void>> {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function copyButtonOf(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector<HTMLButtonElement>(`.${PREFIX}-codeblock-copy`);
  expect(btn, "expected a codeblock Copy button").not.toBeNull();
  return btn!;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("code block — TASK-CHATUX-003 FR-005", () => {
  it("#1 sql fence renders codeblock wrapper with header, lang label and Copy", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, "```sql\nselect 1\n```");

    const wrapper = root.querySelector<HTMLElement>(`.${PREFIX}-codeblock`);
    expect(wrapper, "expected the -codeblock wrapper").not.toBeNull();
    expect(wrapper!.getAttribute("data-lang")).toBe("sql");

    const header = wrapper!.querySelector<HTMLElement>(`.${PREFIX}-codeblock-header`);
    expect(header, "expected the -codeblock-header strip").not.toBeNull();
    expect(header!.querySelector(`.${PREFIX}-codeblock-lang`)?.textContent).toBe("sql");

    const copy = header!.querySelector<HTMLButtonElement>(`.${PREFIX}-codeblock-copy`);
    expect(copy, "expected the Copy button inside the header").not.toBeNull();
    expect(copy!.type).toBe("button");
    expect(copy!.getAttribute("aria-label")).toBe("Copy code");
    expect(copy!.textContent).toBe(COPY_LABEL);

    // The existing pre.-code node is preserved INSIDE the wrapper.
    const pre = wrapper!.querySelector(`pre.${PREFIX}-code`);
    expect(pre, "expected pre.-code inside the wrapper").not.toBeNull();
    expect(pre!.querySelector("code")?.className).toBe(`${PREFIX}-code-sql`);
    expect(pre!.textContent).toContain("select 1");
  });

  it("#2 fence without language renders 'text' label and -plain code class", () => {
    const wrapper = createCodeBlock({ lang: "", code: "ls" });

    expect(wrapper.className).toBe(`${PREFIX}-codeblock`);
    expect(wrapper.hasAttribute("data-lang")).toBe(false);
    expect(wrapper.querySelector(`.${PREFIX}-codeblock-lang`)?.textContent).toBe("text");
    const code = wrapper.querySelector(`pre.${PREFIX}-code code`);
    expect(code?.className).toBe(`${PREFIX}-code-plain`);
    expect(code?.textContent).toBe("ls");
  });

  it("#3 clipboard rejection shows Failed then restores Copy after 1500ms", async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.reject(new Error("denied")));
    const wrapper = createCodeBlock({ lang: "sql", code: "select 1" });
    const copy = copyButtonOf(wrapper);

    copy.click();
    await vi.advanceTimersByTimeAsync(0); // drain the rejected writeText
    expect(copy.textContent).toBe(FAILED_LABEL);

    await vi.advanceTimersByTimeAsync(RESTORE_MS);
    expect(copy.textContent).toBe(COPY_LABEL);
  });

  it("copy success writes the raw code and shows Copied then restores Copy", async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard(() => Promise.resolve());
    const wrapper = createCodeBlock({ lang: "", code: "echo hi" });
    const copy = copyButtonOf(wrapper);

    copy.click();
    expect(writeText).toHaveBeenCalledWith("echo hi");
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.textContent).toBe(COPIED_LABEL);

    await vi.advanceTimersByTimeAsync(RESTORE_MS);
    expect(copy.textContent).toBe(COPY_LABEL);
  });

  it("missing clipboard API shows Failed then restores Copy — never throws", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const wrapper = createCodeBlock({ lang: "sql", code: "select 1" });
    const copy = copyButtonOf(wrapper);

    expect(() => copy.click()).not.toThrow();
    expect(copy.textContent).toBe(FAILED_LABEL);

    await vi.advanceTimersByTimeAsync(RESTORE_MS);
    expect(copy.textContent).toBe(COPY_LABEL);
  });

  it("rapid copy clicks reset the 1500ms restore timer", async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());
    const wrapper = createCodeBlock({ lang: "", code: "x" });
    const copy = copyButtonOf(wrapper);

    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.textContent).toBe(COPIED_LABEL);
    await vi.advanceTimersByTimeAsync(RESTORE_MS - 100);

    // Second click inside the feedback window restarts the countdown.
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RESTORE_MS - 100);
    expect(copy.textContent).toBe(COPIED_LABEL);

    await vi.advanceTimersByTimeAsync(100);
    expect(copy.textContent).toBe(COPY_LABEL);
  });

  it("source scan: markdown.ts never assigns innerHTML", () => {
    const source = readFileSync(
      resolve(process.cwd(), "webview", "aiChat", "markdown.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    expect(source).not.toMatch(/innerHTML\s*=/);
  });
});

// ---------------------------------------------------------------------------
// TASK-CHATUX-W5-2 — memoized markdown blocks (SPEC FR-009/FR-010). A repaint
// of the same root reuses the SAME element object for every block whose key
// (kind|level|lang|text/code) is unchanged, so a streaming repaint only
// rebuilds the tail block — and listeners on reused nodes (code-block Copy)
// survive. The cache is per-root: two roots never share nodes.
// ---------------------------------------------------------------------------

describe("markdown — TASK-CHATUX-W5-2 memoized blocks", () => {
  const RAW_A = "intro paragraph\n\n```sql\nselect 1\n```\n\ntail";
  const RAW_B = "intro paragraph\n\n```sql\nselect 1\n```\n\ntail grew";

  it("#4 node identity: unchanged blocks reuse the SAME element object", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, RAW_A);
    const before = Array.from(root.children);
    expect(before.length).toBe(3);

    renderMarkdownInto(root, RAW_B);
    const after = Array.from(root.children);
    expect(after.length).toBe(3);
    expect(after[0]).toBe(before[0]); // unchanged paragraph — same node
    expect(after[1]).toBe(before[1]); // unchanged code block — same node
    expect(after[2]).not.toBe(before[2]); // changed tail — rebuilt
  });

  it("#5 changed tail rebuilds: new text renders, block order preserved", () => {
    const root = document.createElement("div");
    renderMarkdownInto(root, RAW_A);
    renderMarkdownInto(root, RAW_B);
    const after = Array.from(root.children);
    expect(after[0]!.textContent).toBe("intro paragraph");
    expect(after[1]!.textContent).toContain("select 1");
    expect(after[2]!.textContent).toBe("tail grew");
    // Order: paragraph, codeblock wrapper, paragraph.
    expect(after[0]!.tagName).toBe("P");
    expect(after[1]!.className).toBe(`${PREFIX}-codeblock`);
    expect(after[2]!.tagName).toBe("P");
  });

  it("#6 code-block Copy listener survives a repaint on a reused node", async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard(() => Promise.resolve());
    const root = document.createElement("div");
    renderMarkdownInto(root, RAW_A);
    const copyBefore = copyButtonOf(root);

    renderMarkdownInto(root, RAW_B); // code block key unchanged → node reused
    const copyAfter = copyButtonOf(root);
    expect(copyAfter).toBe(copyBefore);

    copyAfter.click();
    expect(writeText).toHaveBeenCalledWith("select 1");
    await vi.advanceTimersByTimeAsync(0);
    expect(copyAfter.textContent).toBe(COPIED_LABEL);
  });

  it("#7 per-root cache: two roots rendering the same raw get DISTINCT nodes", () => {
    const rootA = document.createElement("div");
    const rootB = document.createElement("div");
    renderMarkdownInto(rootA, RAW_A);
    renderMarkdownInto(rootB, RAW_A);
    const a = Array.from(rootA.children);
    const b = Array.from(rootB.children);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).not.toBe(b[i]);
    }
  });
});
