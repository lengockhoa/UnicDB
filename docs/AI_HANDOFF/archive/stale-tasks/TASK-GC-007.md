# TASK-GC-007 — `UnicDB.generateCommitMessage`: wiring + registration

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3

## Goal

The orchestration behind the sparkle: collect the diff (GC-002), resolve the Lite Model +
engine (GC-001), generate the message (GC-003 via builtin provider or omp one-shot), and
inject it into `repository.inputBox.value` — with the frozen toasts for every failure mode.
Registration is one line in `src/extension.ts`.

## Target Files

- `src/ai/commitGenCommand.ts` (new) — exports:
  - `CommitGenDeps` — injected ports: `loadSettings(): Promise<AiSettings | null>`,
    `loadConfig(): Promise<AiConfig | null>`, `detectOmp(): Promise<OmpDetection>`,
    `resolveEngine(input): EngineChoice` (injectable for tests),
    `buildOmpEngine(choice: EngineChoice): Promise<OmpOneShot>` where
    `OmpOneShot = { generate(prompt: string): Promise<string> }`,
    `builtinComplete(cfg: AiConfig, req: ProviderRequest): Promise<ProviderResult>`,
    `collectDiff(): Promise<CommitDiffInput-like | null>` (structural match to GC-002),
    `setInputBox(message: string): void`, `showInfo(m: string): void`,
    `showError(m: string): void`, `showSettingsToast(m: string, action: string): Promise<string | undefined>`,
    `openSettings(): void`.
  - `runGenerateCommitMessage(deps: CommitGenDeps): Promise<void>` — flow (frozen):
    1. settings = loadSettings(); if null or `settings.models.lite?.modelId.trim()` empty →
       `showSettingsToast("Configure the Lite Model in UnicDB AI Settings to use Generate
       Commit Message", "Open Settings")`; when the action is picked → `openSettings()`; return.
    2. diff = collectDiff(); null → `showInfo("UnicDB: no changes to summarize.")`; return.
    3. engine = `settings.models.lite.engine ?? "omp"`.
       - `"omp"`: choice = resolveEngine({ detection: await detectOmp(), config: null });
         if `choice.engine !== "omp"` → `showError("UnicDB: omp engine unavailable — " +
         (choice.hint ?? "install omp"))`; return. Else message = sanitize(await
         buildOmpEngine(choice).generate(prompt)).
       - `"builtin"`: cfg = loadConfig(); null → settings-style toast "Configure the AI
         backend (base URL + API key) in UnicDB AI Settings" + Open Settings; return.
         Else result = builtinComplete(cfg, { modelId: lite.modelId, messages:
         buildCommitPrompt(diff), maxOutputTokens: 300, temperature: 0.2 });
         message = sanitize(result.text).
    4. `setInputBox(message)` (never called on any failure path).
  - vscode stays OUT of this module — every interaction is a port (pattern:
    `AiSettingsFormOptions`).
- `src/extension.ts` — register inside the existing `disposables.push(...)` block (near the
  `UnicDB.openAiSettings` registration, ~line 813):
  `vscode.commands.registerCommand("UnicDB.generateCommitMessage", () => vscode.window.withProgress(...runGenerateCommitMessage(buildCommitGenDeps(aiStore))))`.
  `buildCommitGenDeps` binds: GC-002 `getGitApi`/`pickRepository`/`collectCommitDiff`,
  `inputBox.value` on the picked repo, real `detectOmp`/`resolveEngine`/`createProviderClient`,
  an omp one-shot adapter mirroring `buildOmpChatEngine` (~line 1752) but with
  `createOmpChatEngine({ acp, hostMcp: noopHostMcp, cwd, mcpServers: [] })` (no DB tools)
  collecting `onDelta` into a buffer, and `commandOpenAiSettings` as `openSettings`.
  `hostMcp` is REQUIRED and non-nullable (`OmpChatEngineOptions`, ompChatEngine.ts:141) —
  pass a local no-op stub satisfying `HostMcp` (`src/ai/omp/hostMcp.ts:64`):
  `{ port: 0, url: "http://127.0.0.1:0", sessionId: "commit-gen", start: async () => {},
  stop: async () => {}, respond: () => false, handle: async () => ({}),
  call: async () => ({ result: "", isError: true }) }`. With `mcpServers: []` the
  `mcpServersDescriptor(hostMcp)` fallback (ompChatEngine.ts:344) never fires and
  `hostMcp.call` (ompChatEngine.ts:301) is unreachable — zero tools advertised, stub
  never touched at runtime.
- `src/ai/__tests__/commitGenCommand.test.ts` (new) — fakes for every port; no vscode mock
  needed at all.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | builtin happy path | deps with lite `{modelId:"m", engine:"builtin"}`, staged diff, provider resolving fenced text → `setInputBox` called with sanitized message; no toasts | fake ports |
| 2 | happy | omp happy path | lite engine "omp", detectOmp ok → `buildOmpEngine` called (resolveEngine consulted with detection), engine output injected | fake ports |
| 3 | edge (missing config) | lite empty → settings toast | toast called with the frozen string + action "Open Settings"; picking the action calls `openSettings()`; `collectDiff` never called | lite modelId "" |
| 4 | edge (empty) | no changes | `collectDiff` → null → `showInfo("UnicDB: no changes to summarize.")`; `builtinComplete`/omp never called | empty repo fake |
| 5 | edge (missing config) | builtin chosen, no global config | `loadConfig` → null → settings toast with base-URL text; provider never called | lite engine "builtin", config null |
| 6 | edge (service failure) | provider throws | `showError` contains the error message; `setInputBox` NOT called | rejecting builtinComplete |
| 7 | edge (service failure) | omp down while lite engine omp | detectOmp !ok → `showError` contains hint; builtin path NOT silently used | detection `{ok:false, reason:"not-installed"}` |

## Test Files

- `src/ai/__tests__/commitGenCommand.test.ts` (new) — tests #1–#7.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ai/__tests__/commitGenCommand.test.ts src/ai/__tests__/commitMessage.test.ts src/adapters/__tests__/gitDiff.test.ts
```

(Runs its own suite plus its direct collaborators as a mini-net. No lint script exists —
typecheck is the lint-equivalent gate.)

## Acceptance Criteria

- [ ] Tests #1–#7 green; `npm run typecheck` clean; `src/extension.test.ts` still green
      (registration added without breaking activation assertions).
- [ ] `commitGenCommand.ts` imports nothing from `vscode`.
- [ ] Frozen toast strings byte-identical to PLAN §1.
- [ ] Input box is written ONLY on success; every failure path returns before injection.
- [ ] apiKey/credentials never appear in any prompt or log line (privacy invariant).

## Dependencies

- TASK-GC-001 (settings shape), TASK-GC-002 (`collectCommitDiff`/`pickRepository`),
  TASK-GC-003 (`buildCommitPrompt`/`sanitizeCommitMessage`)

## Interfaces

- Consumes: `AiSettings`/`AiConfig` (GC-001); `collectCommitDiff`, `pickRepository`,
  `getGitApi`, `repo.inputBox.value` (GC-002); `buildCommitPrompt(diff): ChatMessage[]`,
  `sanitizeCommitMessage(raw): string` (GC-003); existing `createProviderClient(...).complete(req)`
  (seam used by `src/extension.ts` aiChatDeps), `resolveEngine({detection, config}): EngineChoice`
  (`src/ai/engineChoice.ts`), `detectOmp(): Promise<OmpDetection>` (`src/ai/omp/detect.ts`),
  `createOmpChatEngine({acp, hostMcp, cwd, mcpServers?}): OmpChatEngine` +
  `send(text, events: OmpChatEvents): Promise<void>` (`src/ai/omp/ompChatEngine.ts`),
  `commandOpenAiSettings(store)` (`src/extension.ts`).
- Produces: `runGenerateCommitMessage(deps)` — GC-008 drives it end-to-end; command id
  `UnicDB.generateCommitMessage` declared by GC-004.

---

## Discussion

### 2026-09-06 · planner · unic-smart
-> @executor: omp reply quality is runtime-dependent (deltas may carry reasoning text);
`sanitizeCommitMessage` is the mitigation — do not add bespoke omp parsing. Multi-repo:
`pickRepository` = `repositories[0]` is the accepted scope cut (PLAN §2); if you find a
trivial `activeScm` improvement while wiring, note it here instead of expanding scope.

(no comments yet)

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: |
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-007
  ❯ src/ai/__tests__/commitGenCommand.test.ts  (0 test)
  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
  FAIL  src/ai/__tests__/commitGenCommand.test.ts [ src/ai/__tests__/commitGenCommand.test.ts ]
  Error: Failed to load url ../commitGenCommand (resolved id: ../commitGenCommand) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-gc-007/src/ai/__tests__/commitGenCommand.test.ts. Does the file exist?
  Test Files  1 failed (1)
       Tests  no tests
Verification Output: |
  typecheck:
    > tsc --noEmit
    (clean)

  Verification suite (vitest):
    ✓ src/ai/__tests__/commitMessage.test.ts  (12 tests)
    ✓ src/ai/__tests__/commitGenCommand.test.ts  (8 tests)
    ✓ src/adapters/__tests__/gitDiff.test.ts  (12 tests)
    Test Files  3 passed (3)
         Tests  32 passed (32)

  Extension smoke (vitest):
    ✓ src/extension.test.ts  (155 tests)
    Test Files  1 passed (1)
         Tests  155 passed (155)

  Full suite (npm test):
    Test Files  248 passed | 1 skipped (249)
         Tests  3676 passed | 2 skipped (3678)
Status: PASS
Note: All 7+1 mandated test cases green; module is pure (no vscode import) and the
production wiring reuses `buildAcpDepsCreate` + `adaptProcessToSession` from the chat
panel's `buildOmpChatEngine`, threading `mcpServers: []` and a no-op HostMcp stub so
commit-gen pays the same AcpProcess handshake cost but advertises zero tools. The omp
one-shot adapter buffers `onDelta` events into a string and resolves on `onDone`.
