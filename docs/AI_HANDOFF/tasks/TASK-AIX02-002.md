# TASK-AIX02-002 — fileOpsTool tool factory (scope + atomicity + envelope)

**Status:** pending
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

NEW `src/ai/tools/fileOpsTool.ts`: `createFileOpsTool(deps: FileOpsDeps): AgentTool`.
Pure (NO vscode import). Deps: `readFile(path): Promise<string>`,
`writeFile(path, content): Promise<void>` (host implements temp+rename atomicity),
`files: readonly string[]` (host-curated allowlist), `permissionDenied?: boolean`.

- name: `workspace_write`; params `{ path: string, newContent: string }` (both required,
  additionalProperties false).
- Execute order: permission no-op → exact allowlist membership (reject `outside-workspace`)
  → read old → buildUnifiedDiff → writeFile → `{ applied: true, path, diff }`.
- Failure envelope (never throws): `{ applied: false, reason: "outside-workspace" |
  "permission-denied" | "not-found" | "write-failed", detail? }`. read error → `not-found`;
  write throw → `write-failed` with error message in `detail`.
- `writeFile` MUST NOT be called for any rejected case (assert in tests: no silent edits).

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | unit | outside-root path (and `../` traversal attempt) → outside-workspace, no write |
| 2 | unit | permissionDenied → permission-denied envelope, no read/write |
| 3 | unit | read fails → not-found, no write |
| 4 | unit | write throws → write-failed with detail, applied false |
| 5 | unit | happy path → applied true + unified diff; writeFile called once with new content |
| 6 | unit | args schema: missing/extra props rejected |

## Verification

```bash
npx vitest run src/ai/tools/__tests__/fileOpsTool.test.ts
npm run typecheck
```

## Executor Report

(to be filled by executor with RED + GREEN evidence)
