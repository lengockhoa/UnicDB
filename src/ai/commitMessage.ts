// src/ai/commitMessage.ts
// Pure module that turns a diff into Lite-Model chat messages (Conventional Commits style)
// and sanitizes the model's raw reply into a clean single commit message.
// No vscode import. No fetch. Deterministic pure functions.
// Spec: docs/AI_HANDOFF/tasks/TASK-GC-003.md (GC-003), frozen system text per PLAN.md.

import type { ChatMessage } from "./provider";

// ---- constants --------------------------------------------------------------
export const COMMIT_SUBJECT_MAX_CHARS = 72;
export const COMMIT_MESSAGE_MAX_CHARS = 600;

// ---- frozen system prompt (GC-003 §Target Files, planner-locked) ----------
const SYSTEM_PROMPT =
  "You generate git commit messages. Reply with ONLY the commit message — no explanations, no code fences, no quotes. Use Conventional Commits style: `type(scope): subject` in imperative mood, subject max 72 chars, then an optional short body.";

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