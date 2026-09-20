// src/ai/commitMessage.ts
// Pure module that turns a diff into Lite-Model chat messages (Conventional Commits style)
// and sanitizes the model's raw reply into a clean single commit message.
// No vscode import. No fetch. Deterministic pure functions.
// Spec: docs/AI_HANDOFF/tasks/TASK-GC-003.md (GC-003), frozen system text per PLAN.md.

import type { ChatMessage } from "./provider";

// ---- constants --------------------------------------------------------------
export const COMMIT_SUBJECT_MAX_CHARS = 72;
export const COMMIT_MESSAGE_MAX_CHARS = 600;

// ---- frozen system prompt (TASK-CG2-002, SPEC §8.1 planner-locked) --------
const SYSTEM_PROMPT =
  "You generate git commit messages. Reply with ONLY the commit message — no explanations, no code fences, no quotes, no reasoning. " +
  "Use Conventional Commits style with an English type prefix: `type(scope): subject` in imperative mood. " +
  "Write the subject and body in VIETNAMESE (tiếng Việt). Example: `feat(db): thêm chỉ mục cho bảng users`. " +
  "Limits: subject max 12 words (72 chars), whole message max 100 words (600 chars).";

// ---- types -----------------------------------------------------------------
export interface CommitPromptInput {
  repoName: string;
  branch?: string;
  files: readonly string[];
  diffText: string;
}

// ---- buildCommitPrompt -----------------------------------------------------
export function buildCommitPrompt(input: CommitPromptInput): ChatMessage[] {
  const fileList =
    input.files.length > 0 ? input.files.map((f) => `- ${f}`).join("\n") : "- (none)";
  const branchLine = input.branch ? `Branch: ${input.branch}\n` : "";
  const userContent =
    `Repo: ${input.repoName}\n` +
    branchLine +
    `Changed files:\n${fileList}\n` +
    `Diff:\n${input.diffText}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

// ---- buildRetryCommitPrompt ------------------------------------------------
/**
 * Build a corrective retry prompt for a rejected commit message (SPEC §8.2).
 *
 * Pure: never mutates `original`. Returns the original system turn unchanged
 * plus one corrective user turn that restates the repository context, lists the
 * guard reasons, and shows the rejected text (truncated to 240 chars with
 * whitespace collapsed) so the model can avoid repeating it.
 *
 * Throws a structured Error when `original` carries no user message, mirroring
 * the defence-in-depth style of `serializeCommitPrompt` — the corrective turn
 * must always include the repository context to be actionable.
 */
export function buildRetryCommitPrompt(
  original: readonly ChatMessage[],
  rejectedMessage: string,
  reasons: readonly string[],
): ChatMessage[] {
  const userMessage = original.find((message) => message.role === "user");
  if (!userMessage || typeof userMessage.content !== "string") {
    throw new Error("commit-gen: retry prompt requires a user message");
  }
  const truncated = rejectedMessage.slice(0, 240).replace(/\s+/g, " ");
  const correctiveContent =
    `${userMessage.content}\n\n` +
    `Your previous reply was rejected for these reasons: ${reasons.join(", ")}.\n` +
    `Rejected text (do NOT repeat it): "${truncated}".\n` +
    `Reply again with ONLY a valid commit message:\n` +
    `- Plain text only: no code fences, no quotes, no explanations, no reasoning.\n` +
    `- English Conventional-Commits type prefix (feat/fix/refactor/chore/...), subject and body in Vietnamese (tiếng Việt).\n` +
    `- Subject: max 12 words (72 chars). Whole message: max 100 words (600 chars).`;
  return [
    original[0],
    { role: "user", content: correctiveContent },
  ];
}

/**
 * Render the commit chat messages as plain text for engines whose ACP prompt
 * accepts one string rather than a ChatMessage array. The role labels keep the
 * commit-only instruction and repository context distinct.
 *
 * Throws a structured Error if a `ChatContentPart` carries a non-string
 * `text`/`imageUrl` or a `ChatMessage.content` is neither a string nor an
 * array. Letting either case reach the template literal would silently
 * stringify the object and emit `[object Object]` into the commit prompt.
 * Pure commit prompts always carry plain string content, so the throw is a
 * defence-in-depth check, not a hot path.
 */
export function serializeCommitPrompt(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      let content: string;
      if (typeof message.content === "string") {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        content = message.content
          .map((part, index) => {
            const text = part.text;
            const imageUrl = part.imageUrl;
            if (typeof text === "string") return text;
            if (typeof imageUrl === "string") return imageUrl;
            throw new Error(
              `commit-gen: ChatContentPart[${index}].text/imageUrl must be a string`,
            );
          })
          .join("");
      } else {
        throw new Error(
          "commit-gen: ChatMessage.content must be string or string-part array",
        );
      }
      return `${message.role.toUpperCase()}:
${content}`;
    })
    .join("\n\n");
}

// ---- sanitizeCommitMessage -------------------------------------------------
/**
 * Normalize a model's raw reply into a single Conventional-Commits commit message.
 *
 * Pipeline (order is significant):
 *   1. trim
 *   2. strip surrounding ``` ``` code fences (with or without language tag)
 *   3. strip one layer of surrounding `"` or `'` quotes
 *   4. collapse 3+ consecutive newlines to exactly 2
 *   5. clamp the first line (subject) to 72 chars
 *   6. hard-cap the whole message at 600 chars
 */
export function sanitizeCommitMessage(raw: string): string {
  // 1. trim
  let out = raw.trim();

  if (out.length === 0) {
    return "";
  }

  // 2. strip surrounding ``` fences (with or without language tag)
  //    Acceptable outer forms: ```\n...\n```  or  ```lang\n...\n```
  const fenceRe = /^```[^\n`]*\n([\s\S]*?)\n?```$/;
  const fenceMatch = out.match(fenceRe);
  if (fenceMatch) {
    out = fenceMatch[1];
  }

  // 3. strip one layer of surrounding `"` or `'` quotes
  if (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) ||
      (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1);
  }

  // 4. collapse 3+ consecutive newlines to exactly 2
  out = out.replace(/\n{3,}/g, "\n\n");

  // 5. clamp the first line (subject) to 72 chars
  const firstNewline = out.indexOf("\n");
  if (firstNewline === -1) {
    if (out.length > COMMIT_SUBJECT_MAX_CHARS) {
      out = out.slice(0, COMMIT_SUBJECT_MAX_CHARS);
    }
  } else {
    const subject = out.slice(0, firstNewline);
    const rest = out.slice(firstNewline);
    if (subject.length > COMMIT_SUBJECT_MAX_CHARS) {
      out = subject.slice(0, COMMIT_SUBJECT_MAX_CHARS) + rest;
    }
  }

  // 6. hard-cap the whole message at 600 chars
  if (out.length > COMMIT_MESSAGE_MAX_CHARS) {
    out = out.slice(0, COMMIT_MESSAGE_MAX_CHARS);
  }

  return out;
}