// src/ai/__tests__/commitMessageGuard.test.ts
// Unit tests for src/ai/commitMessageGuard.ts (pure) — TASK-CG2-001 §Test Cases #1..#8
// No vscode import. Deterministic pure functions — spec §7 / §7.1.3.
import { describe, it, expect } from "vitest";
import {
  checkCommitMessage,
  COMMIT_SUBJECT_MAX_WORDS,
  COMMIT_MESSAGE_MAX_WORDS,
  GUARD_BLOB_TOKEN_MIN_CHARS,
  GUARD_SYMBOL_RATIO_MAX,
} from "../commitMessageGuard";

describe("ai/commitMessageGuard — Test #1 happy (VN có dấu + không dấu, pure)", () => {
  it("passes a diacritic Vietnamese message and an unaccented one", () => {
    expect(checkCommitMessage("feat(db): thêm chỉ mục cho bảng users")).toEqual({
      ok: true,
      reasons: [],
    });
    expect(checkCommitMessage("feat(db): cap nhat ket qua truy van")).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("is pure — repeated calls return identical results (no cache/state)", () => {
    const a = "feat(db): thêm chỉ mục cho bảng users";
    const b = "feat(db): cap nhat ket qua truy van";
    const firstA = checkCommitMessage(a);
    const firstB = checkCommitMessage(b);
    expect(checkCommitMessage(a)).toEqual(firstA);
    expect(checkCommitMessage(b)).toEqual(firstB);
    expect(checkCommitMessage(a)).toEqual(firstA);
    expect(checkCommitMessage(b)).toEqual(firstB);
  });
});

describe("ai/commitMessageGuard — Test #2 edge (empty short-circuit)", () => {
  it("returns exactly ['empty'] for '' and whitespace-only input", () => {
    expect(checkCommitMessage("")).toEqual({ ok: false, reasons: ["empty"] });
    expect(checkCommitMessage("   \n  ")).toEqual({
      ok: false,
      reasons: ["empty"],
    });
  });

  it("empty short-circuits — no other reason is emitted", () => {
    expect(checkCommitMessage("").reasons).toEqual(["empty"]);
    expect(checkCommitMessage("   \n  ").reasons).toEqual(["empty"]);
  });
});

describe("ai/commitMessageGuard — Test #3 edge (blob boundary 39 vs 40)", () => {
  it("39-char token has NO unbroken-blob; 40-char token HAS it", () => {
    expect(checkCommitMessage("a".repeat(39)).reasons).not.toContain(
      "unbroken-blob",
    );
    expect(checkCommitMessage("a".repeat(40)).reasons).toContain(
      "unbroken-blob",
    );
  });

  it("documents the frozen boundary constant", () => {
    expect(GUARD_BLOB_TOKEN_MIN_CHARS).toBe(40);
  });
});

describe("ai/commitMessageGuard — Test #4 edge (hex 36 chars)", () => {
  it("flags hash-like but NOT unbroken-blob for a 36-char hex token", () => {
    const reasons = checkCommitMessage("3f9a2c".repeat(6)).reasons;
    expect(reasons).toContain("hash-like");
    expect(reasons).not.toContain("unbroken-blob");
  });
});

describe("ai/commitMessageGuard — Test #5 edge (ratio + reasoning markers)", () => {
  it("flags symbol-heavy when non-letter/digit ratio exceeds 0.5", () => {
    expect(checkCommitMessage("feat: {{{[[[()]]]}}}").reasons).toContain(
      "symbol-heavy",
    );
  });

  it("flags reasoning-marker on a 'we need to' line", () => {
    expect(
      checkCommitMessage("We need to add an index to speed up lookups").reasons,
    ).toContain("reasoning-marker");
  });

  it("flags reasoning-marker when the text contains a code fence", () => {
    expect(
      checkCommitMessage("feat(db): add index\n```\ndiff stuff\n```").reasons,
    ).toContain("reasoning-marker");
  });

  it("flags reasoning-marker on a repeated interjection (okay x2)", () => {
    expect(checkCommitMessage("okay this looks fine okay").reasons).toContain(
      "reasoning-marker",
    );
  });

  it("documents the frozen symbol ratio constant", () => {
    expect(GUARD_SYMBOL_RATIO_MAX).toBe(0.5);
  });
});

describe("ai/commitMessageGuard — Test #6 edge (language detection)", () => {
  it("flags clean English as not-vietnamese", () => {
    expect(
      checkCommitMessage("feat(db): add index to the users table").reasons,
    ).toContain("not-vietnamese");
  });

  it("accepts a Vietnamese subject — the English type prefix is not an error", () => {
    expect(checkCommitMessage("feat(ui): sửa lỗi hiển thị")).toEqual({
      ok: true,
      reasons: [],
    });
  });
});

describe("ai/commitMessageGuard — Test #7 edge (word boundaries 12/13, 100/101)", () => {
  it("flags subject-too-long at 13 subject words, not at 12", () => {
    const subject13 = ["feat(db):", ...Array(12).fill("sua")].join(" ");
    expect(checkCommitMessage(subject13).reasons).toContain(
      "subject-too-long",
    );

    const subject12 = ["feat(db):", ...Array(11).fill("sua")].join(" ");
    expect(checkCommitMessage(subject12).reasons).not.toContain(
      "subject-too-long",
    );
    // The short locked example from the task table.
    expect(checkCommitMessage("feat(db): sua loi nang cap").reasons).not.toContain(
      "subject-too-long",
    );
  });

  it("accepts a 100-word total and flags message-too-long at 101", () => {
    const subject = "feat(db): sua loi nang cap"; // 5 words, marker "sua"
    const body95 = Array(95).fill("sua").join(" ");
    const at100 = `${subject}\n${body95}`;
    expect(checkCommitMessage(at100)).toEqual({ ok: true, reasons: [] });

    const at101 = `${subject}\n${body95} sua`;
    const reasons = checkCommitMessage(at101).reasons;
    expect(reasons).toContain("message-too-long");
    expect(reasons).not.toContain("subject-too-long");
  });

  it("documents the frozen word-count constants", () => {
    expect(COMMIT_SUBJECT_MAX_WORDS).toBe(12);
    expect(COMMIT_MESSAGE_MAX_WORDS).toBe(100);
  });
});

describe("ai/commitMessageGuard — Test #8 regression (72-char blob bug signature)", () => {
  it("emits exactly ['unbroken-blob', 'hash-like', 'not-vietnamese'] in order", () => {
    const token72 = "0123456789abcdef".repeat(4) + "01234567";
    expect(token72).toHaveLength(72);
    expect(checkCommitMessage(token72).reasons).toEqual([
      "unbroken-blob",
      "hash-like",
      "not-vietnamese",
    ]);
  });
});
