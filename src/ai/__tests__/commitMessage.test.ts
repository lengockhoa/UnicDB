// src/ai/__tests__/commitMessage.test.ts
// Unit tests for src/ai/commitMessage.ts (pure) — TASK-GC-003 §Test Cases #1..#6
// No vscode import. No fetch. Deterministic pure functions.
import { describe, it, expect } from "vitest";
import {
  buildCommitPrompt,
  buildRetryCommitPrompt,
  sanitizeCommitMessage,
  COMMIT_SUBJECT_MAX_CHARS,
  COMMIT_MESSAGE_MAX_CHARS,
} from "../commitMessage";
import type { ChatMessage } from "../provider";

describe("ai/commitMessage — buildCommitPrompt", () => {
  it("Test #1 — prompt carries repo, files, diff", () => {
    const messages = buildCommitPrompt({
      repoName: "UnicDB",
      files: ["src/a.ts"],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Conventional Commits");
    expect(typeof messages[1].content).toBe("string");
    const user = messages[1].content as string;
    expect(user).toContain("UnicDB");
    expect(user).toContain("src/a.ts");
    expect(user).toContain("diff --git a/src/a.ts b/src/a.ts");
  });

  it("Test #1b — branch line included when provided", () => {
    const messages = buildCommitPrompt({
      repoName: "UnicDB",
      branch: "feature/gc-003",
      files: ["src/ai/commitMessage.ts"],
      diffText: "+// new module",
    });
    const user = messages[1].content as string;
    expect(user).toContain("Repo: UnicDB");
    expect(user).toContain("Branch: feature/gc-003");
    expect(user).toContain("Changed files:");
    expect(user).toContain("src/ai/commitMessage.ts");
    expect(user).toContain("Diff:");
    expect(user).toContain("+// new module");
  });

  it("Test #1c — branch line omitted when not provided", () => {
    const messages = buildCommitPrompt({
      repoName: "UnicDB",
      files: ["src/a.ts"],
      diffText: "x",
    });
    const user = messages[1].content as string;
    expect(user).not.toContain("Branch:");
  });
});

describe("ai/commitMessage — sanitizeCommitMessage", () => {
  it("Test #2a — strips surrounding ``` fences (no language tag)", () => {
    expect(sanitizeCommitMessage("```\nfeat(db): add index\n```")).toBe(
      "feat(db): add index",
    );
  });

  it("Test #2b — strips surrounding ``` fences (with language tag)", () => {
    expect(sanitizeCommitMessage("```text\nfeat(db): add index\n```")).toBe(
      "feat(db): add index",
    );
  });

  it("Test #2c — strips one layer of double quotes", () => {
    expect(sanitizeCommitMessage('"feat(db): add index"')).toBe(
      "feat(db): add index",
    );
  });

  it("Test #2d — strips one layer of single quotes", () => {
    expect(sanitizeCommitMessage(" 'feat(db): add index' ")).toBe(
      "feat(db): add index",
    );
  });

  it("Test #3 — subject clamped at 72 chars (body preserved)", () => {
    const longSubject = "x".repeat(90);
    const raw = `${longSubject}\nThis is the body line explaining the change.`;
    const out = sanitizeCommitMessage(raw);
    const firstLine = out.split("\n")[0];
    expect(firstLine.length).toBe(72);
    expect(out).toContain("This is the body line explaining the change.");
  });

  it("Test #4 — whole message capped at 600 chars", () => {
    const raw = "y".repeat(1000);
    const out = sanitizeCommitMessage(raw);
    expect(out.length).toBeLessThanOrEqual(600);
  });

  it("Test #5 — empty / whitespace-only raw → empty string", () => {
    expect(sanitizeCommitMessage("  \n  ")).toBe("");
    expect(sanitizeCommitMessage("")).toBe("");
    expect(sanitizeCommitMessage("\n\n\n")).toBe("");
  });

  it("Test #6 — 6 blank lines collapse to exactly 1 blank line (2 newlines)", () => {
    const raw = "feat(db): add index\n\n\n\n\n\nbody line";
    const out = sanitizeCommitMessage(raw);
    // Subject + blank line + body = exactly 2 \n between the two text lines
    expect(out).toBe("feat(db): add index\n\nbody line");
  });
});

describe("ai/commitMessage — constants", () => {
  it("exports COMMIT_SUBJECT_MAX_CHARS = 72 and COMMIT_MESSAGE_MAX_CHARS = 600", () => {
    expect(COMMIT_SUBJECT_MAX_CHARS).toBe(72);
    expect(COMMIT_MESSAGE_MAX_CHARS).toBe(600);
  });
});

describe("ai/commitMessage — serializeCommitPrompt", () => {
  it("returns plain text for string content and preserves role labels", async () => {
    const { serializeCommitPrompt } = await import("../commitMessage");
    const out = serializeCommitPrompt([
      { role: "system", content: "Be terse" },
      { role: "user", content: "Diff:" },
    ]);
    expect(out).toBe("SYSTEM:\nBe terse\n\nUSER:\nDiff:");
  });

  it("renders typed text parts cleanly", async () => {
    const { serializeCommitPrompt } = await import("../commitMessage");
    const out = serializeCommitPrompt([
      { role: "user", content: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }] },
    ]);
    expect(out).toBe("USER:\nalphabeta");
  });

  it("renders image_url parts via the imageUrl fallback", async () => {
    const { serializeCommitPrompt } = await import("../commitMessage");
    const out = serializeCommitPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "see " },
          { type: "image_url", imageUrl: "https://x/y.png" },
        ],
      },
    ]);
    expect(out).toBe("USER:\nsee https://x/y.png");
  });

  it("throws a structured Error when a part carries a non-string text/imageUrl", async () => {
    const { serializeCommitPrompt } = await import("../commitMessage");
    expect(() =>
      serializeCommitPrompt([
        {
          role: "user",
          content: [{ type: "text", text: { junk: "object" } as unknown as string }],
        },
      ]),
    ).toThrow(/ChatContentPart\[0\]\.text\/imageUrl must be a string/);
  });

  it("throws a structured Error when message.content is neither string nor array", async () => {
    const { serializeCommitPrompt } = await import("../commitMessage");
    expect(() =>
      serializeCommitPrompt([
        { role: "user", content: 42 as unknown as string },
      ]),
    ).toThrow(/must be string or string-part array/);
  });
});

// TASK-CG2-002 — Vietnamese SYSTEM_PROMPT (SPEC §8.1) + buildRetryCommitPrompt (§8.2)
describe("ai/commitMessage — SYSTEM_PROMPT (Vietnamese contract, SPEC §8.1)", () => {
  it("Test #2 — teaches Vietnamese output + word/char limits + example", () => {
    const messages = buildCommitPrompt({
      repoName: "UnicDB",
      files: ["src/a.ts"],
      diffText: "+a",
    });
    const system = messages[0].content as string;
    expect(system).toContain("You generate git commit messages");
    expect(system).toContain("Conventional Commits");
    expect(system).toContain("VIETNAMESE (tiếng Việt)");
    expect(system).toContain("12 words");
    expect(system).toContain("100 words");
    expect(system).toContain("feat(db): thêm chỉ mục cho bảng users");
  });
});

describe("ai/commitMessage — buildRetryCommitPrompt (SPEC §8.2)", () => {
  const original: ChatMessage[] = [
    { role: "system", content: "SYSTEM TEXT" },
    { role: "user", content: "Repo: X\nDiff: +a" },
  ];

  it("Test #3 — carries original system, user context, reasons and rejected text", () => {
    const messages = buildRetryCommitPrompt(original, "garbage text", ["hash-like"]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(original[0]);
    const content = messages[1].content as string;
    expect(content).toContain("Repo: X");
    expect(content).toContain("+a");
    expect(content).toContain("hash-like");
    expect(content).toContain("garbage text");
    expect(content).toContain("Vietnamese");
  });

  it("Test #4 — multiple reasons joined with ', '", () => {
    const messages = buildRetryCommitPrompt(original, "bad", [
      "hash-like",
      "message-too-long",
    ]);
    const content = messages[1].content as string;
    expect(content).toContain("hash-like, message-too-long");
  });

  it("Test #5 — rejected text truncated to 240 chars and whitespace collapsed", () => {
    const truncated = buildRetryCommitPrompt(original, "x".repeat(300), ["empty"]);
    const content = truncated[1].content as string;
    expect(content).toContain("x".repeat(240));
    expect(content).not.toContain("x".repeat(300));

    const spaced = buildRetryCommitPrompt(original, "a\n\n  b\t c", ["empty"]);
    const spacedContent = spaced[1].content as string;
    expect(spacedContent).toContain('"a b c"');
  });

  it("Test #6 — throws a structured Error when no user message is present", () => {
    expect(() =>
      buildRetryCommitPrompt([{ role: "user", content: "only" }], "x", ["empty"]),
    ).not.toThrow();
    expect(() =>
      buildRetryCommitPrompt([{ role: "system", content: "s" }], "x", ["empty"]),
    ).toThrow(/retry prompt requires a user message/);
  });

  it("Test #7 — does not mutate the original messages array", () => {
    const snapshot = JSON.parse(JSON.stringify(original));
    buildRetryCommitPrompt(original, "garbage text", ["hash-like"]);
    expect(original).toEqual(snapshot);
    expect(original).toHaveLength(2);
  });
});