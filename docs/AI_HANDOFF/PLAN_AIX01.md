# Cycle AIX-01 Plan — Grounded Workspace Context

Date: 2026-08-30 · Base: main @ 3b30f7c (post DBX-04) · Roadmap: PRODUCT_ROADMAP.md wave 2
Status: planned · Executor: unic-code · Reviewer: unic-smart (Aix01Reviewer, mandatory)

## §1 Intent

Let users ask questions over selected/open workspace files PLUS attributed
schema context, with bounded, inspectable retrieval — not opaque prompt
stuffing. Every attached fact is visible as a `path:lineRange` (files) or
`connection.object` (schema) reference in the answer's context block.

Non-goals (hard): no repository-wide unrestricted indexing, no vector
store, no background scanning, no secrets/binary content into prompts, no
autonomous file writes (AIX-02 scope).

## §2 Current seams (surveyed)

- `src/ui/aiChatPanel.ts` already has: @-mention resolution
  (`parseMentionTokens`, `resolveMentionsForTurn` — file tokens read via
  workspace.fs with 100 KB cap, DB tokens via DDL-only introspection),
  `formatSystemPrompt` (budget 12_000 chars), attachment pipeline,
  `--- Referenced context ---` augmentation block.
- `src/ai/agent.ts` `AgentTool` contract: `{ name, description,
  parameters (JSON Schema), execute(args) -> string }`.
- `src/ai/tools/registry.ts` + `dbAwareTools` + `DbToolPermissionGate`
  (default-deny permission cards).
- `src/ui/aiChatAttachments.ts` — pure validation helpers precedent.

Gaps AIX-01 closes:
1. No "selected text / active editor" grounding — users can't say "about
   this selection".
2. No workspace-file search tool for the model — mention is user-driven
   only; the model cannot retrieve files itself.
3. No per-turn attribution record — the context block is not preserved
   in a queryable, inspectable form.

## §3 Architecture

Pure modules (NO vscode import — scaffold hygiene guards):

- `src/ai/grounding/selection.ts`
  - `GroundedSelection { path; startLine; endLine; text; truncated }`
  - `extractSelection(raw: { path; startLine?; endLine?; text }): GroundedSelection | null`
    — trims blank edges, enforces MAX_SELECTION_CHARS (8_000) with
    `truncated` flag, clamps line range to text line count, rejects
    empty input → null.
  - `formatSelectionBlock(sel: GroundedSelection): string` — fenced
    block with `path:startLine-endLine` header (1-based, inclusive).
- `src/ai/grounding/fileSearch.ts`
  - `FileHit { path; startLine; endLine; lineText; score }`
  - `searchWorkspaceFiles(files: GroundedFile[], query: SearchQuery): FileHit[] & { excluded: string[] }`
    — pure ranking over pre-read file contents (host reads files, this
    module never touches fs): case-insensitive term matches, score =
    match count; deterministic tie-break (path, then line); hard caps
    MAX_FILE_HITS (8) and MAX_CONTEXT_LINES (40) across hits;
  - `SearchQuery { terms: string[]; glob?: string }` with simple
    `*`/`**`/`?` matcher, pure.
  - Binary/secret guard: `isProbablyBinary(content)` (NUL byte in first
    8 KB) and `containsSecretHeuristic(content)` (AKIA…, BEGIN PRIVATE
    KEY, ghp_, xox[bp]-, sk-ant-) — matching files are excluded from
    retrieval and reported in `excluded`.
- `src/ai/grounding/attribution.ts`
  - `AttributionEntry { kind: "file" | "selection" | "schema"; ref; bytes }`
  - `AttributionRecord { entries: AttributionEntry[]; totalBytes; turnId }`
  - `recordAttribution(rec, entries)` (dedupe by ref, order-stable) +
    `formatAttributionFooter(rec)` — the answer-visible
    "Grounded in: …" list; pure.

Host modules:

- `src/ui/groundingService.ts`
  - `collectGrounding(deps): Promise<GroundingBundle>` — reads active
    editor selection via injected `getSelection()` (vscode-free
    interface, host supplies), reads workspace files via injected
    `readFile(path)`, per-file 100 KB cap (same constant value as
    MENTION_RESOLVE_FILE_CAP_BYTES), runs
    isProbablyBinary/containsSecretHeuristic, builds
    `GroundingBundle { selection; files; excluded; record }`.
- `src/ui/groundingMessages.ts` — wire types: `grounding_state`
  (host→webview chips) and `grounding_toggle` (webview→host,
  panel-scoped).

Wiring (minimal, no new commands):

- `aiChatPanel.handleSend`: before the turn, collect grounding
  (selection first, capped) and merge into the per-turn context block
  AFTER the mention block, tagged `--- Grounded workspace context ---`
  with per-file `path:start-end` headers; post `grounding_state` so
  the webview shows chips of what was attached. Toggle off / nothing
  to attach → block omitted (zero drift for existing turns).
- `src/ai/tools/registry.ts`: register `workspace_search` AgentTool
  (parameters `{ terms: string[]; glob?: string }`, execute →
  FileHit JSON) so the model can retrieve capped, attributed file hits
  mid-turn; gated through the existing permission lane (deny →
  structured no-op JSON).
- `extension.ts`: pass `getSelection` + workspace-file reader into
  `AiChatPanelOptions.grounding` (optional — tests can omit).

## §4 Tests (TDD, targeted per task)

- `src/ai/grounding/__tests__/selection.test.ts` (~8): blank-edge trim,
  8 KB cap + truncated, line clamp, empty → null, format header math,
  CRLF handling, unicode content preserved.
- `src/ai/grounding/__tests__/fileSearch.test.ts` (~10): ranking order,
  determinism, term scoring, glob filter (`*`, `**`, `?`), caps
  (MAX_FILE_HITS, MAX_CONTEXT_LINES), binary exclusion, secret
  heuristics (each pattern), excluded list, empty query → [].
- `src/ai/grounding/__tests__/attribution.test.ts` (~6): dedupe by ref,
  order-stable, footer format, totalBytes accounting, kind mix, empty
  record footer "".
- `src/ui/__tests__/groundingService.test.ts` (~8): selection present /
  absent, file read failure → skipped, binary file → excluded, secret
  file → excluded, cap enforcement, record correctness, disabled path,
  never throws.
- `src/ui/__tests__/aiChatGrounding.test.ts` (~6): handleSend merges
  grounded block after mention block; toggle off → no block;
  grounding_state posted; attribution footer reflects attached files;
  existing behavior untouched when no grounding deps (regression).
- `src/ai/tools/__tests__/workspaceSearchTool.test.ts` (~5): schema
  shape, capped output, permission-deny path returns attributed no-op
  JSON, determinism, empty workspace → [].
- `src/__tests__/aix01Scaffold.test.ts` (~5): purity (no vscode in
  src/ai/grounding/*), no network imports, no eval, secret patterns
  word-safe.

## §5 Task split

- TASK-AIX01-001: selection.ts + attribution.ts + tests (wave 1).
- TASK-AIX01-002: fileSearch.ts + tests (wave 1, parallel with 001).
- TASK-AIX01-003: groundingService.ts + groundingMessages.ts +
  aiChatPanel wiring + workspace_search tool registration (wave 2).
- TASK-AIX01-004: aix01Scaffold.test.ts + full regression + report
  (wave 3).

## §6 Risks

- Secret leakage: heuristic deny-list is best-effort; mitigation
  boundary = explicit toggle + visible attribution chips (documented).
- Prompt bloat: hard caps (8 KB selection + 40 file lines + existing
  12 KB schema budget) enforced in pure modules with tests.
- Model tool misuse: workspace_search is read-only and permission-
  gated; deny path returns structured JSON, never throws.

## Reviewer gate

Aix01Reviewer (unic-smart, different model than executor) re-runs
typecheck + targeted tests fresh and appends superseding verdicts to
TASK-AIX01-003.md / TASK-AIX01-004.md — same protocol as DBX-03/DBX-04.
