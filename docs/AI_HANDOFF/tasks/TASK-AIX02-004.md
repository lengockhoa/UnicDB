# TASK-AIX02-004 — scaffold hygiene + docs

**Status:** pending
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

NEW `src/__tests__/aix02Scaffold.test.ts`:
- `fileDiff.ts` + `fileOpsTool.ts` never import vscode (import-statement regex only).
- `fileOpsTool.ts` has no shell:true / execSync / child_process usage (pure over injected deps).
- No webview changes: existing connectionForm CSP scaffold still green.

Docs: CHANGELOG `## [1.21.0]` section + compare link; README key-features bullet
(Safe File Operations — diff preview, explicit approval card, allowlist scope, atomic write);
docs closure (ACTIVE/INDEX/WORKLOG/STATUS).

## Verification

```bash
npx vitest run src/__tests__/aix02Scaffold.test.ts src/__tests__/dbx05Scaffold.test.ts
npm test
npm run compile
```

## Executor Report

(to be filled by executor with RED + GREEN evidence)
