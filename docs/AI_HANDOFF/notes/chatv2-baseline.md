# CHATV2-001 — Baseline and capability audit

- Task: `docs/AI_HANDOFF/tasks/TASK-CHATV2-001.md`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§1–9
- Git baseline (worktree `handoff/task-chatv2-001`): `0a3d3b772629356bd6415dac571fdc6008e273f1`
- Purpose: freeze current behavior and produce the migration map that TASK-CHATV2-002…017 consume.
  This task changes **no runtime source**; every claim below is anchored to a real line in this worktree.

## 1. Capability matrix — four engines × twelve capabilities

Every cell is either a real `file:line` anchor in this worktree, or the explicit token `absent`
or `unknown`. No cell claims parity from a bare boolean; a capability that the source does not
demonstrate is recorded `unknown`, never inferred.

| Engine | text stream | reasoning stream | tools | permissions | bypass | image | model roles | native resume | saved transcript | provider commands | cancel | export |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| builtin | verified src/ui/aiChatPanel.ts:2372 | absent | verified src/ui/aiChatPanel.ts:2303 | verified src/ui/aiChatPanel.ts:809 | verified src/ui/aiChatPanel.ts:1267 | verified src/ui/aiChatPanel.ts:2043 | verified src/ui/aiChatPanel.ts:2466 | absent | absent | absent | verified src/ui/aiChatPanel.ts:3737 | verified webview/aiChatPanelMain.ts:653 |
| omp | verified src/ai/omp/ompChatEngine.ts:279 | verified src/ai/omp/ompChatEngine.ts:288 | verified src/ai/omp/ompChatEngine.ts:301 | verified src/ui/aiChatPanel.ts:809 | verified src/ui/aiChatPanel.ts:2942 | absent | absent | verified src/ai/omp/ompChatEngine.ts:453 | absent | absent | verified src/ai/omp/ompChatEngine.ts:501 | verified webview/aiChatPanelMain.ts:653 |
| claude-code | verified src/ai/claudeCode/claudeCodeProcess.ts:714 | unknown — callback declared at src/ai/claudeCode/claudeCodeProcess.ts:63 but no emit site | verified src/ai/claudeCode/claudeCodeProcess.ts:710 | verified src/ui/aiChatPanel.ts:809 | unknown — no engine-level toggle in this adapter; CLI default-deny only, see src/ai/claudeCode/claudeCodeProcess.ts:405 | verified src/ai/claudeCode/claudeCodeChatEngine.ts:203 | absent | absent | absent | absent | verified src/ai/claudeCode/claudeCodeChatEngine.ts:307 | verified webview/aiChatPanelMain.ts:653 |
| codex | verified src/ai/codex/codexProcess.ts:468 | verified src/ai/codex/codexProcess.ts:473 | unknown — callbacks declared at src/ai/codex/codexProcess.ts:87 but no emit site | unknown — no approval/permission parsing in src/ai/codex/codexProcess.ts | unknown — no engine-level toggle in this adapter | verified src/ai/codex/codexChatEngine.ts:331 | absent | absent | absent | absent | verified src/ai/codex/codexChatEngine.ts:383 | verified webview/aiChatPanelMain.ts:653 |

The matrix surfaces four explicit `unknown` cells (claude-code reasoning stream and bypass;
codex tools and permissions) rather than inferring parity.

### 1.1 Why each `absent` is absent

- **builtin / reasoning stream** — `AgentCallbacks` (`src/ai/agent.ts:134`) exposes no
  `onThought`, and `runBuiltinTurn` (`src/ui/aiChatPanel.ts:2298`) subscribes no reasoning
  callback. Provider-side reasoning keys exist (`src/ai/provider.ts:147`) but are never
  streamed to the webview.
- **builtin / native resume, saved transcript, provider commands** — no host session store;
  `this.history` is explicitly panel-session only (`src/ui/aiChatPanel.ts:1265`,
  appended at `src/ui/aiChatPanel.ts:2482`). `/resume` is gated to omp
  (`src/ui/aiChatPanel.ts:4029`) and the slash set is a closed local registry with no provider
  commands (`src/ui/aiChatPanelCommands.ts:59`).
- **omp / image** — the panel forces `visionCapable = false` for omp
  (`src/ui/aiChatPanel.ts:1864`); `enablePromptImage` is reserved and default-off
  (`src/ai/omp/ompChatEngine.ts:147`).
- **omp / model roles** — `OmpChatEngine.send` (`src/ai/omp/ompChatEngine.ts:122`) takes no
  role; omp owns its own model selection.
- **omp, claude-code, codex / saved transcript, provider commands** — no persisted host
  transcript exists, and omp's `available_commands_update` is explicitly ignored
  (`src/ai/omp/ompChatEngine.ts:330`); claude-code / codex expose no command parser.
- **claude-code / native resume** — deterministic unsupported error
  (`src/ai/claudeCode/claudeCodeChatEngine.ts:280`).
- **codex / native resume** — deterministic unsupported error
  (`src/ai/codex/codexChatEngine.ts:364`).
- **claude-code, codex / model roles** — neither process adapter builds a `--model` argument
  (`src/ai/claudeCode/claudeCodeProcess.ts:394`, `src/ai/codex/codexProcess.ts:256`), so the
  panel's `activeRole` is not forwarded to them.

### 1.2 Why each `unknown` is unknown

- **claude-code / reasoning stream** — `onThought` is declared on the process event contract
  (`src/ai/claudeCode/claudeCodeProcess.ts:63`) and bridged to the chat events, but this
  adapter never calls it. Whether the upstream CLI emits a thought frame is unverified here;
  we do not claim parity with omp.
- **claude-code / bypass** — there is no engine-level bypass toggle in the adapter. The CLI is
  pinned to default-deny (`--permission-mode manual --permission-prompts none`,
  `src/ai/claudeCode/claudeCodeProcess.ts:405`). Whether a future host bypass could reach the
  CLI is unverified.
- **codex / tools** — `onToolStart` / `onToolEnd` are declared
  (`src/ai/codex/codexProcess.ts:87`) and bridged (`src/ai/codex/codexChatEngine.ts:224`), but
  the codex process emits no tool frame today. Whether the CLI can emit tool items is
  unverified against source.
- **codex / permissions** — `src/ai/codex/codexProcess.ts` contains no approval/permission
  parsing and no wiring evidence that the codex child is fronted by the shared DB tool gate.
  Recording this `unknown` avoids assuming parity with omp/claude-code.

### 1.3 Shared notes

- **permissions** for builtin / omp / claude-code all route through the same
  `DbToolPermissionGate` (`src/ui/aiChatPanel.ts:809`); the omp/claude-code DB tools reach it
  through the HostMcp bridge (`src/ai/omp/ompChatEngine.ts:301`).
- **export** is engine-independent in V1: `webview/aiChatPanelMain.ts:653` scrapes
  `innerText` from `#thread`. It is cited identically for all four engines because no engine
  gates it. PLAN §9 (line 86) and `docs/AI_CHAT_PROFESSIONAL_SPEC.md:169` forbid DOM-scraped
  export; CHATV2-015 replaces it with a host-written export.

## 2. Baseline evidence — reproducible DOM fixtures

Screenshots require a real bundled webview (`PLAN.md:82`); jsdom cannot prove geometry. The
seven states below are captured as reproducible DOM fixtures driven by the existing tests
(jsdom) until the CHATV2-017 browser checklist replaces them with real screenshots. Width and
theme variants are listed because the harness supports them only at CHATV2-017.

| # | State | Reproducible fixture in this worktree | Widths / themes |
|---|---|---|---|
| 1 | empty/idle | `webview/__tests__/aiChatPanelComposer.test.ts:45` | 320 / 420 / 768 — deferred to CHATV2-017 |
| 2 | long transcript | `webview/__tests__/aiChatPanelThread.test.ts:281` (empty + long payloads) and `webview/__tests__/aiChatPanelThread.test.ts:360` | deferred to CHATV2-017 |
| 3 | streaming | `src/ui/__tests__/aiChatPanel.test.ts:605` (builtin streaming) | deferred to CHATV2-017 |
| 4 | tool + reasoning | `webview/__tests__/aiChatPanelThread.test.ts:49` (bubbles/tool rows) + `src/ui/__tests__/aiChatPanelMessages.test.ts:163` (thought frame) | deferred to CHATV2-017 |
| 5 | permission | `src/ui/__tests__/aiChatPanelMessages.test.ts:56` (permission_request) | deferred to CHATV2-017 |
| 6 | error | `src/ui/__tests__/aiChatPanel.test.ts:474` | deferred to CHATV2-017 |
| 7 | slash + mention | `src/ui/__tests__/aiChatPanelMentions.test.ts` and `src/ui/__tests__/aiChatPanelCommands.test.ts:7` | deferred to CHATV2-017 |

Widths 320 / 420 / 768 and dark / light / high-contrast are **not** reproducible in jsdom; the
authoritative pass is the CHATV2-017 real-bundle screenshot checklist. This gap is recorded
rather than claimed as covered.

## 3. V1 listener inventory affecting send / slash / mention / attach / stop / model

Every V1 `keydown` / `keyup` / `input` / click listener that affects a controlled action, with
the V2 task that removes or replaces it. Two listeners currently own **Enter**, which is the
duplicate-ownership defect the PLAN calls out.

| Listener | Location | Affects | V2 owner |
|---|---|---|---|
| textarea `keydown` Enter=send (bubble phase) | `webview/aiChatPanelComposer.ts:521` | send | CHATV2-009 (removed; one capture-phase controller) |
| textarea `keydown` capture phase (Ctrl/Cmd+Enter no-op + dropdown nav) | `webview/aiChatPanelMain.ts:816` | send / slash / mention | CHATV2-009 + CHATV2-010 + CHATV2-011 |
| document `keydown` Escape→close chip menu | `webview/aiChatPanelComposer.ts:514` | model menu | CHATV2-012 |
| textarea `input` slash dropdown refresh | `webview/aiChatPanelMain.ts:923` | slash | CHATV2-010 |
| textarea `keyup` mention dropdown refresh | `webview/aiChatPanelMain.ts:933` | mention | CHATV2-011 |
| document `mousedown` outside-click mention close | `webview/aiChatPanelMain.ts:962` | mention | CHATV2-011 |
| document `click` outside-click chip menu close | `webview/aiChatPanelComposer.ts:503` | model menu | CHATV2-012 |
| `sendBtn` click | `webview/aiChatPanelComposer.ts:445` | send | CHATV2-008 (delegates to controller) |
| `stopBtn` click | `webview/aiChatPanelComposer.ts:451` | stop | CHATV2-008 |
| `attachBtn` click → hidden file input | `webview/aiChatPanelComposer.ts:461` | attach | CHATV2-013 |
| file input `change` ingest | `webview/aiChatPanelMain.ts:987` | attach | CHATV2-013 |
| textarea `paste` image ingest | `webview/aiChatPanelMain.ts:996` | attach | CHATV2-013 |
| `slashHintBtn` click | `webview/aiChatPanelComposer.ts:465` | slash | CHATV2-010 |
| `chipBtn` click / chip rows | `webview/aiChatPanelComposer.ts:483`, `webview/aiChatPanelComposer.ts:357` | model | CHATV2-012 |
| `schemaChipBtn` click | `webview/aiChatPanelComposer.ts:497` | model / schema | CHATV2-013 |
| `bypassToggle` click | `webview/aiChatPanelComposer.ts:455` | permissions | CHATV2-014 |
| `resumeBtn` / `regenerateBtn` / `clearBtn` click | `webview/aiChatPanelMain.ts:779`, `:788`, `:798` | session | CHATV2-015 |
| plan `approve` / `reject` click | `webview/aiChatPanelMain.ts:1235`, `:1240` | permissions / plan | CHATV2-014 |
| tool card header click/keydown toggle | `webview/aiChatPanelMain.ts:1166`, `:1167` | activity | CHATV2-007 |

### 3.1 Duplicate Enter ownership (explicit flag)

Enter is currently owned by **two** competing listeners on the same textarea:

- **Owner A** — `webview/aiChatPanelComposer.ts:521`, a bubble-phase `keydown` that calls
  `preventDefault()` and invokes `cb.onSend(...)`. This is the actual Enter=send path.
- **Owner B** — `webview/aiChatPanelMain.ts:816`, a capture-phase `keydown` that
  `stopImmediatePropagation()`s Enter/Tab while a mention or slash dropdown is open, and
  suppresses Ctrl/Cmd+Enter. It relies on listener ordering to shadow Owner A.

This is a **duplicate Enter-ownership** path: correctness depends on capture-vs-bubble
ordering rather than a single controller. It is recorded here as regression evidence and is
resolved by **TASK-CHATV2-009** (one capture-phase composer keyboard controller), with
CHATV2-010 (slash) and CHATV2-011 (mention) moving their key handling into that controller.
No new listener may be added to either module in the meantime.

## 4. Pinned DOM IDs / classes and their disposition

IDs and classes pinned by tests may not be renamed without an owner. Classification:
`preserve temporarily`, `replace test`, or `delete at CHATV2-017`. Permanent compatibility with
no consumer is forbidden (`PLAN.md:86`).

| Selector | Pinned by | Disposition |
|---|---|---|
| `#prompt` | `webview/__tests__/aiChatPanelComposer.test.ts:73` | replace test — v2 composer uses a controller-owned textarea |
| `#sendBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:94` | replace test |
| `#stopBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:95` | replace test |
| `#attachBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:288` | replace test |
| `#resumeBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:286` | preserve temporarily (CHATV2-015) |
| `#regenerateBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:287` | preserve temporarily (CHATV2-015) |
| `#clearBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:289` | preserve temporarily (CHATV2-015) |
| `#modelChipBtn` | `webview/__tests__/aiChatPanelComposer.test.ts:154` | replace test (CHATV2-012) |
| `#modelChipMenu` | `src/ui/__tests__/aiChatPanelCloneWebview.test.ts:206` | replace test (CHATV2-012) |
| `#bypassToggle` | `webview/__tests__/aiChatPanelComposer.test.ts:129` | replace test (CHATV2-014) |
| `.UnicDB-chat-chipmenu` | `webview/__tests__/aiChatPanelComposer.test.ts:179` | delete at CHATV2-017 |
| `.UnicDB-chat-actions-left` / `-right` | `webview/__tests__/aiChatPanelComposer.test.ts:230` | delete at CHATV2-017 |
| `#thread` | `src/ui/__tests__/aiChatPanelDbAwareWebview.test.ts:182` | preserve temporarily (CHATV2-006) |
| `#jumpLatest` | `src/ui/__tests__/aiChatPanelWebviewTask002.test.ts:382` | preserve temporarily (CHATV2-016) |
| `#engineBanner` | `webview/__tests__/aiChatPanelHeader.test.ts:61` | replace test (CHATV2-012) |
| `#sessionChip` | `webview/__tests__/aiChatPanelHeader.test.ts:121` | replace test (CHATV2-015) |
| `#chatBrandMark` | `webview/__tests__/aiChatPanelHeader.test.ts:42` | delete at CHATV2-017 |
| `#attachFileInput` | `src/ui/__tests__/aiChatPanelWebviewTask002.test.ts:927` | replace test (CHATV2-013) |
| `.UnicDB-chat-usage` | `webview/__tests__/aiChatPanelThread.test.ts:325` | preserve temporarily (CHATV2-007) |
| `.UnicDB-chat` root rule | `src/ui/__tests__/aiChatPanelCloneCss.test.ts:66` | delete at CHATV2-017 (superseded by `.UnicDB-ai-chat-v2`) |

No selector in this table keeps a permanent compatibility shim: every row names either a
replacement test, a temporary carry-over with a task, or CHATV2-017 deletion.

## 5. Build entry and dependency lock (confirmations)

- esbuild webview entry remains `webview/aiChatPanelMain.ts` → `dist/aiChatPanel.js`
  (`esbuild.js:88`, `esbuild.js:89`).
- Chat CSS remains scoped under `.UnicDB-chat` (`webview/styles.css:1104`) and is disjoint
  from the console/results webviews (`webview/main.ts:1765`).
- No CDN, no UI framework, no new runtime dependency: package scripts
  (`package.json` scripts: `compile`, `test`, `typecheck`) are unchanged by this task, and no
  new import is introduced.

## 6. Git baseline and focused tests

- Baseline commit: `0a3d3b772629356bd6415dac571fdc6008e273f1` on `handoff/task-chatv2-001`.
- Focused suites validated by §Verification Commands: `webview/__tests__/aiChatPanelComposer.test.ts`,
  `webview/__tests__/aiChatPanelThread.test.ts`, `src/ui/__tests__/aiChatPanelMessages.test.ts`,
  `src/ui/__tests__/aiChatPanelCommands.test.ts`.
- This task changes no file under `src/`, `webview/`, `package.json`, `esbuild.js`; the runtime
  diff is empty (verification command 4).
