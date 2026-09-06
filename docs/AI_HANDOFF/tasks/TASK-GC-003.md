# TASK-GC-003 — Commit message core: prompt builder + response sanitizer (pure)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§4

## Goal

Pure module that turns a diff into Lite-Model chat messages and turns the model's raw reply
into a clean single commit message (Conventional Commits style). No vscode import — fully
unit-testable.

## Target Files

- `src/ai/commitMessage.ts` (new) — exports:
  - `COMMIT_SUBJECT_MAX_CHARS = 72`, `COMMIT_MESSAGE_MAX_CHARS = 600`.
  - `buildCommitPrompt(input: { repoName: string; branch?: string; files: readonly string[]; diffText: string }): ChatMessage[]`
    — returns exactly 2 messages: system (frozen text: "You generate git commit messages.
    Reply with ONLY the commit message — no explanations, no code fences, no quotes. Use
    Conventional Commits style: `type(scope): subject` in imperative mood, subject max 72
    chars, then an optional short body.") and user (`Repo: <repoName>`, `Branch: <branch>`
    when present, `Changed files:` list, then `Diff:` + `diffText`).
  - `sanitizeCommitMessage(raw: string): string` — trim; strip surrounding ```` ``` ````
    code fences (with or without language tag); strip one layer of surrounding `"` or `'`
    quotes; collapse 3+ consecutive newlines to exactly 2; clamp the first line (subject)
    to 72 chars; hard-cap the whole message at 600 chars.
- `src/ai/__tests__/commitMessage.test.ts` (new).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | prompt carries repo, files, diff | messages[0].role = "system" contains "Conventional Commits"; messages[1].content contains "UnicDB", "src/a.ts", and the diff text | input `{repoName:"UnicDB", files:["src/a.ts"], diffText:"diff --git …"}` |
| 2 | happy | sanitize strips fences + quotes | returns `feat(db): add index` from inputs `"```\nfeat(db): add index\n```"`, `"\"feat(db): add index\""`, and `" 'feat(db): add index' "` | fenced / double-quoted / single-quoted variants |
| 3 | edge (boundary) | subject clamped at 72 | a 90-char first line comes back with `length === 72`; second line preserved | long subject + body |
| 4 | edge (boundary) | whole message capped at 600 | 1000-char message returns ≤ 600 chars | oversized body |
| 5 | edge (empty) | empty / whitespace-only raw → "" | `sanitizeCommitMessage("  \n  ")` returns `""` | empty model reply |
| 6 | edge (malformed) | blank lines collapsed | 6 blank lines between subject and body come back as exactly one blank line (2 newlines) | padded reply |

## Test Files

- `src/ai/__tests__/commitMessage.test.ts` (new) — contains tests #1–#6.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ai/__tests__/commitMessage.test.ts
```

(No lint script exists in this project — typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] All tests #1–#6 green; `npm run typecheck` clean.
- [ ] Module has zero `vscode` import and zero `fetch` — deterministic pure functions.
- [ ] `ChatMessage` imported from `../ai/provider` (existing type, no duplication).

## Dependencies

- (none)

## Interfaces

- Consumes: `ChatMessage` / `ChatContentPart` from `src/ai/provider.ts` (existing).
- Produces (GC-007 consumes): `buildCommitPrompt(input): ChatMessage[]` — the `input`
  parameter is an INLINE structural type (frozen above) identical to GC-002's
  `CommitDiffInput`, so GC-002 and GC-003 stay order-independent; and
  `sanitizeCommitMessage(raw): string` with the exact behaviors of tests #2–#6.

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: deliberately NO import of `CommitDiffInput` from `src/adapters/gitDiff.ts`
(same-wave sibling). Keep the 4-field inline structural parameter — TypeScript makes the two
assign-compatible and the planner-locked shape prevents drift. Cap constants are exported so
GC-007 tests can reference them without magic numbers.

(no comments yet)
