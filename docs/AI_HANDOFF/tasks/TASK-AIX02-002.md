# TASK-AIX02-002 — fileOpsTool tool factory (scope + atomicity + envelope)

**Status:** implemented — awaiting reviewer (unic-smart)
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

### Executor (unic-code)

**RED evidence**: first run of `src/ai/tools/__tests__/fileOpsTool.test.ts` failed at module load — `../fileOpsTool` did not exist (import-time RED). After the factory was created, 1 further RED: the `not-found` test initially used a path outside the allowlist and got `outside-workspace` (correct behavior exposed a wrong test fixture) — the test was fixed to allowlist the file but have `readFile` throw.

**GREEN evidence**: 7/7. Envelope contract verified: never throws, `writeFile` NOT called for outside-workspace / permission-denied / not-found / bad-args (asserted via writes.length === 0); write-throw → `write-failed` with error detail; happy path → one write with exact new content + unified diff. Traversal attempt (`src/../src/a.ts`) rejected by exact-string membership (no normalization by design).

