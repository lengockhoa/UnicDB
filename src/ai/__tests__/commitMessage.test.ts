// src/ai/__tests__/commitMessage.test.ts
// Unit tests for src/ai/commitMessage.ts (pure) — TASK-GC-003 §Test Cases #1..#6
// No vscode import. No fetch. Deterministic pure functions.
import { describe, it, expect } from "vitest";
import {
  buildCommitPrompt,
  sanitizeCommitMessage,
  COMMIT_SUBJECT_MAX_CHARS,
  COMMIT_MESSAGE_MAX_CHARS,
} from "../commitMessage";

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