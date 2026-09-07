# PLAN — Cycle AGT: Claude Code + Codex as first-class agents, AIChat as the universal interface, images+text for all capable engines

## §1 Intent

UnicDB's AI Chat currently supports exactly one external agent engine: `omp`. The user wants
Claude Code (`claude` CLI) and Codex (`codex` CLI) added as first-class engines, the existing
AIChat panel (`src/ui/aiChatPanel.ts`) to be the single primary interface for ALL engines, and
image + text input to work wherever the active engine can accept images. Additionally: audit
`src/ai/omp/` for optimization opportunities (findings only — no rewrite this cycle).

Success looks like:
1. `UnicDB.ai.engine` accepts `"claude-code"` and `"codex"`; choosing one (settings form
   dropdown) routes AI Chat turns through that CLI when it is installed and version-OK.
2. Both new engines speak through the existing panel surface (deltas, thoughts, tool events,
   stop, resume, engine banner) exactly like omp does today.
3. Sending an image + text in AIChat works on `claude-code` and `codex` (the omp image gate
   stays; `builtin` keeps its `work.vision` model flag).
4. An omp audit report with file:line findings + next-cycle actions exists in TASK-004.

P0 answers (USER-CONFIRMED, verbatim — later phases treat these as the user's words):

- **P0.1 Integration model for new agents:** "ACP-based wrapper (Recommended) — Mirror the omp
  pattern (binary detection → subprocess spawn → JSON-RPC over NDJSON → host-side MCP bridge →
  chat engine). Where Claude Code / Codex don't speak ACP natively, build a minimal adapter that
  translates between their CLI/SDK and the existing ACP session/notification surface. Reuse the
  existing engine/hostMcp/mcpBridge machinery where possible."
- **P0.2 omp UKit optimization scope:** "Parallel omp audit task (Recommended) — Add a task that
  reviews `src/ai/omp/` (detect.ts, acp.ts, acpProcess.ts, hostMcp.ts, mcpBridge.ts,
  ompChatEngine.ts, mcpExtensionRegistry.ts) for code quality, test coverage gaps, error paths,
  and performance. Surface findings in a markdown report appended to the task file. NO rewrite
  this cycle — findings become a queue for the next cycle."
- **P0.3 Engine resolution policy:** "User-chosen in settings (Recommended) — Settings form gets
  a dropdown: `[omp, claude-code, codex, builtin]`. Resolution: if global `engine` field is set
  to one of the agent engines and that binary is installed + version-OK → use it. If global is
  'builtin' OR the chosen agent is unavailable → fall back to 'builtin' with a clear UI hint
  (mirror the existing omp install/update hint pattern at `src/ai/omp/detect.ts:6-7`). Per-model
  `engine` override stays supported."

## §2 Scope

In-scope:
- Engine vocabulary: `AiEngine = "builtin" | "omp" | "claude-code" | "codex"` across
  `src/ai/settings.ts` (validator + `redactAiConfig`) and `src/ai/config.ts` (persistence).
- New modules `src/ai/claudeCode/` and `src/ai/codex/`: detect.ts, process/session adapter,
  chat engine — mirroring `src/ai/omp/detect.ts`, `src/ai/omp/acpProcess.ts`,
  `src/ai/omp/ompChatEngine.ts` contracts (real signatures quoted in task Interfaces blocks).
- `resolveEngine()` (`src/ai/engineChoice.ts`) becomes settings-driven per P0.3, with a
  backward-compatible optional input so mid-cycle typecheck stays green (see §3).
- `src/ai/policy.ts` engine-vocabulary guard widened to the 4 values.
- Settings form dropdown extended to 4 options (`webview/aiSettingsFormMain.ts` — the
  `<select id="engine">` at :325 and the webview-local validator mirror at :186).
- Panel (`src/ui/aiChatPanel.ts`): `EngineKind` :1051 widened; per-engine turn dispatch beside
  `runOmpEngineTurn` :2154; image pipeline un-blocked for image-capable engines (the hardcoded
  `visionCapable = false` for omp at :1644-1645 and the `this.engine === "builtin"` belt in
  `prepareAttachments` :1852 stay scoped to omp only).
- Host wiring (`src/extension.ts`): activation gate :1075-1100 generalized to the chosen agent;
  `commandOpenAiChat` :1908 builds the chosen engine via new `buildClaudeCodeChatEngine` /
  `buildCodexChatEngine` factories reusing `createHostMcp` (`src/ai/omp/hostMcp.ts:152`) +
  `createMcpBridge` (`src/ai/omp/mcpBridge.ts:201`); new `UnicDB.ai.useWithClaudeCode` /
  `UnicDB.ai.useWithCodex` commands mirroring `commandUseWithOmp` :3497.
- Chat webview switcher + engine banner (`webview/aiChatPanelMain.ts` `type:"engine"` :63).
- Manifest (`package.json`): `UnicDB.ai.engine` enum + 2 new commands + activationEvents, and
  the locked command list in `src/ui/__tests__/commitGenManifest.test.ts`.
- Read-only omp audit (TASK-004) → findings report inside its task file.

Out-of-scope (this cycle):
- NO omp rewrite — TASK-004 is read-only; its findings queue next cycle.
- No omp image support (ACP `session/prompt` is text-only; relaxing it is a next-cycle item
  recorded in TASK-004 follow-ups).
- No new npm dependencies — CLIs are spawned via `node:child_process`; no Agent SDK packages.
- No multi-repo, no headless/CLI-only invocation mode, no changes to commit-gen (per-model
  `lite.engine: "omp"` untouched), no MCP tool registry changes.
- No new DB tools beyond what `createMcpBridge` already exposes.

Pre-wave cleanup (orchestrator I1, before wave 1): delete ALL prior-cycle task files under
`docs/AI_HANDOFF/tasks/` per RULES "Clear Handoff" step 5 — i.e. all prior-cycle task files
excluding `_TEMPLATE.md` and this cycle's TASK-001..014 (every prefix, ~160 files, including
the never-started GC cycle's `TASK-GC-*`). The planner already removed the
stale cycle-AB `TASK-001..005.md` that collided with this cycle's IDs.

Same-wave disjointness: verified — no two tasks in the same wave share a file (wave table at
the end of this section; each task's Target Files lists its owned paths).

Wave plan (inferred from task `Dependencies`):

| Wave | Tasks (parallel) |
|------|------------------|
| 1 | TASK-001 (engine vocabulary) · TASK-002 (claude detect) · TASK-003 (codex detect) · TASK-004 (omp audit, read-only) · TASK-013 (manifest) |
| 2 | TASK-005 (claude process) · TASK-006 (codex process) · TASK-007 (resolution policy) · TASK-008 (settings dropdown UI) |
| 3 | TASK-009 (claude chat engine) · TASK-010 (codex chat engine) |
| 4 | TASK-011 (panel dispatch + image pipeline) |
| 5 | TASK-012 (extension wiring + chat webview switcher) |
| 6 | TASK-014 (integration + live smoke) |

`handoff.maxParallelAgents = 2` — waves batch 2 at a time. Waves 4 and 5 are single-task by
necessity: TASK-011 is the only owner of `src/ui/aiChatPanel.ts`, and TASK-012 consumes the
panel option fields TASK-011 defines (genuine symbol dependency, not an ordering preference).

## §3 Approach

Mirror, don't refactor. The omp integration is proven (detect → AcpProcess → OmpChatEngine →
panel dispatch); each new engine gets its own `src/ai/<engine>/` module with the same layering:

1. **Detection** (`detect.ts`): same `OmpDetection`-shaped result
   `{ available, ok, path?, version?, reason? }`, same `ExecFn` injection, win32-aware
   `where`/`which` locator, and `compareVersions` **reused** from `../omp/detect`. Version
   floors are planner-chosen constants (`MIN_CLAUDE_CODE_VERSION = "1.0.0"`,
   `MIN_CODEX_VERSION = "0.20.0"`); executors may adjust the floor with a Discussion note if
   the installed binary proves otherwise — the constant, not the logic, carries the policy.
2. **Process/session adapter** (`<engine>Process.ts`): mirror of `AcpProcess` — injectable
   `spawnFn`, closed state-machine literal union, bounded dispose (2000 ms SIGTERM→SIGKILL),
   8 KB stderr tail, mandatory `cwd`. Claude Code is spawned with
   `--input-format stream-json --output-format stream-json` (+ `--mcp-config` pointing at an
   ephemeral local config that references the in-process HostMcp HTTP server for DB tools).
   Codex command/transport/MCP argument names are deliberately UNVERIFIED because the binary is
   absent locally: TASK-006 must ground them in official Codex CLI documentation before code.
   Exact frame schemas are pinned per task with fixtures; where upstream naming is
   version-sensitive the task says "verify against the installed binary at implementation time"
   — unit tests pin the translator against recorded fixtures so a wrong guess surfaces in the
   env-gated live smoke (TASK-014), not as a false green.
3. **Chat engine** (`<engine>ChatEngine.ts`): mirror of `OmpChatEngine` — same 7-callback event
   surface as `OmpChatEvents` (`ompChatEngine.ts:107-116`), `send`/`resume`/`dispose`, plus an
   optional `attachments` parameter on `send` for image blocks. `HostMcp` type is imported from
   `../omp/ompChatEngine` (reuse, no duplicate). Privacy invariant inherited: no apiKey / DB
   credential ever crosses a wire frame.
4. **Resolution** (P0.3): `resolveEngine` gains an optional `engine: AiEngine` input + a
   `detections` map. Supplied → the configured engine wins iff its detection is `ok`, else
   builtin + hint. Absent → legacy behavior (omp-wins-when-ok) so the 3 existing call sites in
   `extension.ts` keep compiling and passing until TASK-012 migrates them. **This supersedes
   locked decision #2** ("omp ok ⇒ always the engine"): after TASK-012, `engine: "builtin"` with
   a healthy omp install yields builtin. That is the user-confirmed P0.3 policy, not a
   regression; TASK-007 tests pin both modes and TASK-012 flips the callers in one commit.
5. **Panel + images**: `EngineKind` widens; each agent engine gets a panel option field
   (`claudeCodeChatEngine` / `codexChatEngine`) and a `runXEngineTurn` sibling of
   `runOmpEngineTurn` that forwards image parts as engine-native image blocks. The image belt
   becomes engine-capability-based: omp = false (unchanged), claude-code/codex = true, builtin =
   true at belt level (model-level `work.vision` still gates the init announcement exactly as
   today).
6. **Host + manifest**: activation gate and `commandOpenAiChat` generalize from
   "detectOmp + omp fallback" to "detect the configured agent"; `useWithClaudeCode` /
   `useWithCodex` mirror `commandUseWithOmp` but deliberately write NO new config file formats —
   they refresh the existing `.vscode/UnicDB-db-context.md` and show a copy-pasteable CLI
   command (avoiding new workspace-polluting formats was chosen over mirroring the YAML export).

Alternatives rejected:
- **Agent SDK packages** (`@anthropic-ai/claude-agent-sdk`, etc.) — adds runtime deps to a
  VS Code extension and a second update channel; child_process + stream-json is dep-free and
  matches the omp precedent. Rejected.
- **Generic `AgentChatEngine` refactor of `OmpChatEngine`** — one shared interface would touch
  the omp hot path mid-cycle; the omp audit (TASK-004) can propose extraction as a next-cycle
  finding instead. Rejected for risk.
- **Always-on multi-detection** (detect all three engines per panel open) — 3 subprocess probes
  per open; P0.3 only needs the chosen engine probed. Rejected for latency.
- **Writing engine-specific config files in useWith* commands** — new file formats in the user's
  workspace with unclear ownership; copyable command + existing db-context.md is enough. Rejected.

## §4 Test Plan

Framework: vitest, colocated `__tests__/*.test.ts` (pattern: `src/ai/omp/__tests__/detect.test.ts`).
Full-suite run at every wave boundary is the regression net for the per-task narrowed selections.

| Type | Test | Expected |
|------|------|----------|
| happy | engine round-trip: save + load `engine: "claude-code"` (and `"codex"`) | stored settings reload with the same engine value; `aiSettingsErrors` returns `[]` |
| happy | `resolveEngine` with `engine: "claude-code"`, detection ok | `{ engine: "claude-code", requiresConfig: false, path, version }` |
| happy | panel send with fake claude-code engine | engine receives text turn, deltas stream to the chat |
| happy | image + text send on claude-code/codex | adapter emits image content block with the attachment's base64 + mime; text part intact |
| happy | settings form renders 4-option engine select | `<select id="engine">` accepts and round-trips `claude-code` / `codex` |
| edge (empty) | engine send with zero attachments | `send(text, events)` — no image block, byte-identical to legacy text-only turn |
| edge (invalid value) | stored `engine: "vscode-copilot"` | `loadSettings()` returns null (fail-closed → defaults), `aiSettingsErrors` non-empty |
| edge (boundary) | binary version exactly `MIN_*` | detection `ok: true`; one patch below → `ok: false, reason: "version-too-old"` |
| edge (unavailable) | configured `codex`, `detectCodex` not-installed | builtin fallback + install hint; activation gate flips setting back with notice |
| edge (malformed input) | claude stream-json frame that is not JSON / unknown event type | adapter skips or maps to onError; no throw, no hang |
| edge (lifecycle) | dispose while prompt in flight | bounded teardown resolves ≤ 2000 ms; state ends `stopped`; idempotent second call no-ops |
| regression | `redactAiConfig` on `engine: "omp"` (settings.ts:159 currently coerces non-omp → builtin) | returns `"omp"` unchanged; would FAIL on today's code once `"claude-code"` exists |
| regression | `engine: "builtin"` + healthy omp → builtin after TASK-012 | pins the P0.3 policy flip (was: omp always won) |
| audit | TASK-004 report exists with ≥1 finding per audited file, each with file:line + severity + next-cycle action | verifiable by checklist (no code test — see task) |

## §5 Verification

Per-task (each task file lists its exact narrowed selection):

```bash
npx vitest run <owned test files>     # narrowed selection via .cache/index/tests-map.json
npm run typecheck                      # tsc --noEmit — MANDATORY in every task
```

- This project has **NO lint script** (package.json `scripts` verified: compile, watch, test,
  test:integration, typecheck, package, publish:*, verify:fast, verify:release, profile:*).
  Lint is N/A everywhere; do not invent one.
- Wave boundary (orchestrator): full `npm test` + `npm run typecheck` + `npm run compile`.
- `.cache/index/tests-map.json` maps `sourceFile → tests[]` (verified:
  `src/ai/engineChoice.ts → src/ai/__tests__/engineChoice.test.ts`); new files have no entry,
  so their tasks name the new test file explicitly.

## §6 Acceptance

- [ ] `package.json` `UnicDB.ai.engine` enum is `["builtin","omp","claude-code","codex"]`; both new commands + activationEvents present; locked command-list test updated (TASK-013).
- [ ] Settings form saves and re-renders `engine: "claude-code"` and `"codex"` (TASK-008, verified by `npx vitest run src/ui/__tests__/aiSettingsFormBundle.test.ts`).
- [ ] With `engine: "claude-code"` and `claude` installed + version-OK, opening AIChat routes turns through `ClaudeCodeChatEngine`; same for `codex` (TASK-011/012, `src/extension.test.ts` + `aiChatPanelEngine.test.ts`).
- [ ] With the configured agent missing/old, chat falls back to builtin with a hint and the stored setting flips back (TASK-012, mirrors `src/extension.ts:1934-1944`).
- [ ] Image + text turn reaches a fake claude-code/codex engine as an image block; omp turns remain text-only (TASK-011, `aiChatPanelAttachments.test.ts` + `aiChatPanelAgentEngines.test.ts`).
- [ ] `redactAiConfig` + `aiSettingsErrors` handle all 4 engine values; unknown value fails closed (TASK-001).
- [ ] Env-gated live smokes exist for both CLIs and are skipped when the gate env var is absent (TASK-014, pattern: `acpLiveSmoke.test.ts`).
- [ ] TASK-004 omp audit report present in the task file; zero production code changed by it (`git diff --stat src/ai/omp` empty).
- [ ] Full suite green: `npm test` 0 failed at the final wave boundary; `npm run typecheck` clean.

## §7 Global Constraints

- No new npm dependencies — engines integrate via `node:child_process` only.
- Node >= 20.12: never `spawn()` a bare command that may be a `.cmd` shim — thread the detected
  binary `path` through spawn exactly as `EngineChoice.path` does for omp (`engineChoice.ts:28-38`).
- Privacy invariant: no apiKey / DB credential in any wire frame, log, or stderr tail
  (`ompChatEngine.ts:23-27`; `summarizeAttachmentsForLog` never logs base64).
- All subprocess spawns carry a mandatory `cwd` (workspace boundary) — mirror `acpProcess.ts`.
- Version floors as named constants; changing one requires a Discussion note with evidence.
- Copy strings: user-facing fallback notices follow the existing
  `"UnicDB: <engine> engine unavailable — falling back to builtin. <hint>"` shape.
- Preserve UTF-8 no-BOM + LF for all touched files.
- TDD mandatory: test first, paste actual RED output in the Executor Report, then GREEN.
- Executor declares `EXECUTOR_MODEL` (= `unic-code` hint); reviewer (`unic-smart`) must differ.
- `handoff.maxParallelAgents = 2`; same-wave tasks never share a file.
- This project has no lint script — `npm run typecheck` is the static gate everywhere.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) moved TASK-013 from wave 6 to wave 1 — it is dependency-free and disjoint (manifest + its lock tests only); (2) `resolveEngine` keeps a legacy call mode (TASK-007 test 5) after discovering 3 `extension.ts` call sites would otherwise break typecheck mid-cycle — TASK-012 is the single migration commit; (3) `redactAiConfig` engine coercion (`settings.ts:159`) found and covered as a REGRESSION test in TASK-001 (would silently map `claude-code` → `builtin`); (4) TASK-009/010 `resume()` pinned to verified-protocol-or-explicit-onError instead of inventing CLI session-resume support; (5) softened the `codex proto` assumption in §3 — Codex transport is UNVERIFIED locally and TASK-006 must ground it in official docs; (6) marked `webview/__tests__/aiSettingsFormMain.test.ts` `(new)` after confirming `webview/__tests__/` has no aiSettings test.
Known gaps: (a) Codex CLI is not installed in this workspace (`command -v codex` failed) — its protocol syntax is intentionally UNVERIFIED; TASK-006 must cite official Codex CLI docs before implementing, and TASK-014's `UnicDB_CODEX_SMOKE=1` live smoke is the ground-truth proof when a Codex environment exists. (b) omp image support is deliberately NOT delivered this cycle (out of scope, §2) — queued via TASK-004 follow-ups. (c) Claude `resume` depends on TASK-005's implementation-time protocol verification.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Plan Review Log

### Round 1 — Issues Found (2026-09-07) · unic-smart
Status: Issues Found
REVIEWER_MODEL: unic-smart (planner unic-smart, executor hint unic-code — reviewer/executor isolation holds for Phase 3/4)

COMPLETENESS: none — §1-§6 + §7 Global Constraints + Self-Audit + `PLANNER_MODEL: unic-smart` footer all present; P0.1-P0.3 recorded verbatim; cycle goal explicit.
CONSISTENCY: wave table matches all 14 `Dependencies` fields (verified per file); same-wave Target Files disjoint; `npm run typecheck` present in every task (TASK-014 ×2); "project has NO lint script" claim TRUE against package.json scripts; cited line refs (settings.ts:20/:159, aiChatPanel.ts:1051/:1644-1645/:2154, engineChoice.ts:28-38, aiChatPanelMain.ts:63, extension.ts:1075/:3497, omp/detect.ts:6-7) all accurate; manifest-registration tests are one-directional (`registeredCommands.has(...)` fixed lists, commitGenManifest churn-tolerant) so TASK-013 in wave 1 does not red the suite before TASK-012; TASK-006 contains the required docs-grounding acceptance criterion (TASK-006.md:44,:67).
CLARITY: none — every task carries Goal/Target Files/concrete Test Cases with fixtures/Test Files/Verification Commands; acceptance rows map to §5 commands + task checkboxes.
SCOPE: none — explicit out-of-scope list holds; TASK-014's conditional `src/extension.test.ts` edit is cross-wave (5 vs 6), allowed.
YAGNI: none — Agent SDK deps, generic AgentChatEngine refactor, always-on multi-detection, and new config file formats all rejected with reasons.

FINDINGS:
  critical: none
  important: docs/AI_HANDOFF/tasks/TASK-004.md:32 — `git diff --stat -- src/ai/omp src/ui src/ai` ("ZERO changed source files by this task") is wave-unsafe: TASK-004 shares wave 1 with TASK-001, which edits tracked files under `src/ai/` (settings.ts, config.ts, tests), and `commitPerWave` means the shared-tree diff spans the whole wave. Whether the gate passes depends on unspecified batch order; a fresh executor either fails the gate or rationalizes the "by this task" qualifier, and the Phase-4 re-run is ambiguous. Fix: scope the no-code-change proof to `git diff --stat -- src/ai/omp` (no wave-1 task touches src/ai/omp) and align TASK-004 Acceptance criterion 5; optionally note that non-omp `src/ai` entries in shared-tree output belong to wave-mates.
  minor: docs/AI_HANDOFF/PLAN.md:75-78 — pre-wave cleanup names only `TASK-GC-*` while ~160 prior-cycle files across many prefixes (AIX/ARP/BQ/DBX/RLX/RP/UX/AIC/AF/AG/AH/AHL/AI/CL/DX/MENU/OC4O/SH…) sit in docs/AI_HANDOFF/tasks/; add one line "apply RULES Clear Handoff step 5 to ALL prior-cycle prefixes, never this cycle's TASK-001..014". | docs/AI_HANDOFF/tasks/TASK-013.md:29 — either-or target for test 4 (`src/scaffold.test.ts` vs `commitGenManifest.test.ts`): fine as a decision rule, but require the executor to record the chosen home in the Executor Report.

NOTES: Plan is internally consistent and wave-safe except the single TASK-004 gate above; Codex-protocol UNVERIFIED is correctly mitigated (docs-grounding + env-gated TASK-014 smoke + fixture-pinned translators), and the resolveEngine legacy-mode → TASK-012 single-flip migration is sound with both regression rows pinned. One one-line task-file fix + two minors before Phase 3; no re-plan needed.

## Plan Review Log — Round 1 findings applied
APPLIED_AT: 2026-09-07
APPLIED_BY: unic-smart (handoff-planner)
CHANGES:
  - TASK-004.md:32 — gate narrowed to `git diff --stat -- src/ai/omp`; Acceptance criterion 5 aligned.
  - PLAN.md:75-78 — pre-wave cleanup now states "all prior-cycle task files excluding _TEMPLATE.md and this cycle's TASK-001..014".
  - TASK-013.md:29 — Executor Report clause added: record which test-4 home (a or b) shipped, with rationale.
NOTE: No wave/dependency/target-files changes; reviewer Round 2 should re-verify.

### Round 2 — Approved (2026-09-07)
VERDICT: Approved
REVIEWER_MODEL: unic-smart
ROUND_1_FIXES_VERIFIED: 3/3
  - TASK-004.md:32-33 + Acceptance criterion 5 (:46) — gate narrowed to `git diff --stat -- src/ai/omp`, wave-mate attribution note added; both edits present and mutually consistent (PLAN §6 :205 row matches).
  - PLAN.md:75-78 — pre-wave cleanup now reads "all prior-cycle task files excluding `_TEMPLATE.md` and this cycle's TASK-001..014 (every prefix, including `TASK-GC-*`)".
  - TASK-013.md:29-30 — Executor Report clause present: MUST record which test-4 home (a `src/scaffold.test.ts` / b `commitGenManifest.test.ts`) shipped, with one-line rationale.
FINDINGS:
  critical: none
  important: none
  minor: none
NOTES: Round 2 re-check clean. Wave table re-derived from all 14 Dependencies fields is topologically exact (every task wave = max dep wave + 1; single-task waves 4/5 justified); same-wave Target Files disjoint in every wave; `npm run typecheck` in all 14 Verification Commands (TASK-008/012/013/014 add `compile`); Round 1 log entry + applied-changes block present. Directory evidence confirms zero duplicate TASK-001..014 (cycle-AB collision-removal claim TRUE) and 187 prior-cycle files still awaiting the orchestrator's pre-wave cleanup — PLAN's "~160" estimate is low, but the all-prior-cycles instruction is count-independent so behavior is unaffected. No new findings introduced by the fixes.
