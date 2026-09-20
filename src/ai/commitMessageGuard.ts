// src/ai/commitMessageGuard.ts
// Pure commit-message validity guard — SPEC COMMITGUARD §7 / §7.1 / §8.3.
// Zero imports, deterministic, editor-runtime free — safe to unit test and reuse in CG2-003 wiring.

export type CommitMessageIssue =
  | "empty"
  | "unbroken-blob"
  | "hash-like"
  | "symbol-heavy"
  | "reasoning-marker"
  | "not-vietnamese"
  | "subject-too-long"
  | "message-too-long";

export interface CommitMessageGuardResult {
  ok: boolean;
  reasons: readonly CommitMessageIssue[];
}

export const COMMIT_SUBJECT_MAX_WORDS = 12;
export const COMMIT_MESSAGE_MAX_WORDS = 100;
export const GUARD_BLOB_TOKEN_MIN_CHARS = 40;
export const GUARD_SYMBOL_RATIO_MAX = 0.5;

/** VN diacritic signal — SPEC §7 rule 6a. */
const VN_DIACRITIC_RE =
  /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

/** Hex-shaped blob — SPEC §7 rule 3. */
const HASH_LIKE_RE = /^[0-9a-f]{32,}$/i;

/** Unicode letter-or-digit — SPEC §7 rule 4. */
const LETTER_OR_DIGIT_RE = /\p{L}|\p{N}/u;

/** Repeated-interjection signal — SPEC §7 rule 5d. */
const INTERJECTION_RE = /\b(okay|wait)\b/gi;

/** Frozen VN word markers — SPEC §7.1 (match `\b<phrase>\b`, case-insensitive). */
const VN_WORD_MARKERS: readonly string[] = [
  "sua",
  "xoa",
  "cap nhat",
  "nang cap",
  "loi",
  "chuc nang",
  "nguoi dung",
  "hien thi",
  "du lieu",
  "ket qua",
  "khong",
  "cai thien",
  "bao mat",
  "xay dung",
  "chinh sua",
  "truy van",
  "co so du lieu",
  "kien truc",
  "phan mem",
  "ung dung",
];

/** Reasoning line-openers — SPEC §7 rule 5b. */
const REASONING_LINE_OPENERS: readonly string[] = [
  "we need to",
  "let me",
  "the user",
  "first,",
  "okay,",
  "wait,",
  "step 1",
  "step 2",
  "i will",
  "i'll",
  "here is",
  "here's",
];

/** Whole-text reasoning phrases — SPEC §7 rule 5c. */
const REASONING_PHRASES: readonly string[] = ["thinking process", "chain of thought"];

function countWords(text: string): number {
  const s = text.trim();
  return s === "" ? 0 : s.split(/\s+/).length;
}

function subjectOf(candidate: string): string {
  const trimmed = candidate.trim();
  const nl = trimmed.indexOf("\n");
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

function hasUnbrokenBlob(tokens: readonly string[]): boolean {
  return tokens.some((t) => t.length >= GUARD_BLOB_TOKEN_MIN_CHARS);
}

function hasHashLike(tokens: readonly string[]): boolean {
  return tokens.some((t) => HASH_LIKE_RE.test(t));
}

function isSymbolHeavy(candidate: string): boolean {
  const nonWhitespace = candidate.replace(/\s+/g, "");
  if (nonWhitespace.length === 0) return false;
  let symbolCount = 0;
  for (const ch of nonWhitespace) {
    if (!LETTER_OR_DIGIT_RE.test(ch)) symbolCount += 1;
  }
  return symbolCount / nonWhitespace.length > GUARD_SYMBOL_RATIO_MAX;
}

function hasReasoningMarker(candidate: string): boolean {
  if (candidate.includes("```")) return true;

  const lines = candidate.split("\n");
  for (const line of lines) {
    const start = line.trimStart().toLowerCase();
    if (start === "" ) continue;
    for (const opener of REASONING_LINE_OPENERS) {
      if (start.startsWith(opener)) return true;
    }
  }

  const lowered = candidate.toLowerCase();
  for (const phrase of REASONING_PHRASES) {
    if (lowered.includes(phrase)) return true;
  }

  const interjections = candidate.match(INTERJECTION_RE);
  if (interjections !== null && interjections.length >= 2) return true;

  return false;
}

function isNotVietnamese(candidate: string): boolean {
  if (VN_DIACRITIC_RE.test(candidate)) return false;
  for (const marker of VN_WORD_MARKERS) {
    const re = new RegExp(`\\b${marker}\\b`, "i");
    if (re.test(candidate)) return false;
  }
  return true;
}

/**
 * Check a candidate commit message against the frozen guard rules (SPEC §7).
 * Reasons are collected in SPEC §7 order; `ok === (reasons.length === 0)`.
 */
export function checkCommitMessage(candidate: string): CommitMessageGuardResult {
  if (candidate.trim() === "") {
    return { ok: false, reasons: ["empty"] };
  }

  const tokens = candidate.trim().split(/\s+/);
  const reasons: CommitMessageIssue[] = [];

  if (hasUnbrokenBlob(tokens)) reasons.push("unbroken-blob");
  if (hasHashLike(tokens)) reasons.push("hash-like");
  if (isSymbolHeavy(candidate)) reasons.push("symbol-heavy");
  if (hasReasoningMarker(candidate)) reasons.push("reasoning-marker");
  if (isNotVietnamese(candidate)) reasons.push("not-vietnamese");
  if (countWords(subjectOf(candidate)) > COMMIT_SUBJECT_MAX_WORDS) {
    reasons.push("subject-too-long");
  }
  if (countWords(candidate) > COMMIT_MESSAGE_MAX_WORDS) {
    reasons.push("message-too-long");
  }

  return { ok: reasons.length === 0, reasons };
}
