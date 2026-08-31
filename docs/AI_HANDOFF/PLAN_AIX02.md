# PLAN_AIX02 — Safe File Operations

Date: 2026-08-31
Base: main @ 5b0e3f3 (v1.20.0 released)
Reviewer: unic-smart (cycle reviewer, MUST differ from executor unic-code)
Release target: v1.21.0

## Goal

Let the AI agent propose workspace file edits through a new file-operation tool boundary:
diff preview → explicit user approval → workspace-trust + path-scope checks → atomic write
with failure reporting. No silent edits, no shell execution, no edits outside workspace roots.
Depends on AIX-01 (shipped v1.19.0): reuses the grounding file list (host-curated workspace
roots) and the DbToolPermissionGate card flow for explicit approval.

## Non-goals

- No shell/command execution, ever.
- No writes outside the host-curated workspace file list (the grounding allowlist IS the scope).
- No multi-file transactions (per-file atomicity only: temp file + rename).
- No editor-side patch application (whole-file write via host callback).

## Architecture

- NEW `src/ai/tools/fileOpsTool.ts` — pure `AgentTool` factory `createFileOpsTool(deps)`.
  - deps: `readFile(path)`, `writeFile(path, content)` (host owns fs), `files: readonly string[]`
    (host-curated allowlist from grounding), `permissionDenied?` escape hatch for tests.
  - args: `{ path: string, newContent: string }`.
  - Behavior:
    1. Permission deny → JSON `{ applied: false, reason: "permission-denied" }` (host gate already
       fronts this tool with the approve card; this is the belt-and-suspenders default).
    2. Path NOT in allowlist → `{ applied: false, reason: "outside-workspace" }` — path traversal
       (`..`, absolute escapes) cannot widen scope because membership is exact-string against the
       allowlist (no path math).
    3. Read current content; compute a unified diff via `buildUnifiedDiff` (NEW pure module
       `src/ai/fileDiff.ts`: LCS-based line diff, ≤ 200 rendered lines cap, `\ No newline`
       handling).
    4. Atomic write: temp-write + rename is the HOST's job; the tool invokes
       `writeFile(path, content)` only after the diff is built and reports
       `{ applied: false, reason: "write-failed", detail }` when the host throws — the host
       implementation must not leave partial state (temp+rename inside the host callback).
  - Returns JSON: `{ applied: true, path, diff }` — the DIFF is the preview surface; the panel
    renders it in the existing permission/step card.
- Approval: `DbToolPermissionGate.wrap()` already gates every execute behind an explicit card
  (allow-once / allow-session / deny). The `detail` summary for file ops shows the path + diff
  size so the card is meaningful. Registration wraps it, same as the DB-aware tools.
- Registration (aiChatPanel `runBuiltinTurn` + omp mirror at ~1918): register ONLY when grounding
  is on (scope = grounding file list). Off → tool absent, model never sees it.
- NEW webview diff rendering is NOT in scope — the card shows the unified diff text in a `<pre>`
  via the existing permission card detail path (textContent only).

## Tasks

- TASK-AIX02-001 — `src/ai/fileDiff.ts` pure unified-diff (LCS, cap, newline sentinel) + tests.
- TASK-AIX02-002 — `src/ai/tools/fileOpsTool.ts` tool factory: allowlist scope, permission no-op,
  atomic write contract, JSON result envelope + tests (RED: outside-root, denied, write-fail).
- TASK-AIX02-003 — Registration wiring (aiChatPanel builtin turn + omp mirror at ~1918) + gate
  wrap + permission-card detail for file ops + tests.
- TASK-AIX02-004 — Scaffold hygiene (no vscode in pure modules; no shell/exec in file ops;
  CSP-clean webview unchanged) + CHANGELOG/README/docs.

## Verification

```bash
npx vitest run src/ai/__tests__/fileDiff.test.ts src/ai/tools/__tests__/fileOpsTool.test.ts src/ui/__tests__/aix02Registration.test.ts src/__tests__/aix02Scaffold.test.ts
npm test
npm run typecheck
npm run compile
```

## Review gate

Executor commits with `git -c user.name=vsdb -c user.email=vsdb@local`, spawns the unic-smart
cycle reviewer (NOT unic-code), iterates fix rounds until VERDICT: APPROVED, then docs closure →
release v1.21.0 (bump, vsix, tag, push, GitHub Release) → clear/compact → next cycle (AIX-03).
