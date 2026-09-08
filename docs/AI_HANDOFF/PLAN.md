# PLAN — Cycle AGT-UI: AI Chat panel = faithful Claude Code VS Code extension clone (BLUE accent, big "U" mark)

## §1 Intent

**Problem (verbatim from user):**
"[Image #32] có cách nào cải tiến cái chat giống y chang như Claude code vscode extension kiểu này không. Tôi rất thích kiểu này luôn. Clone được thì càng tốt. Clone luôn cho tôi thì càng mừng. bộ này nè https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code. hãy tham khảo ở đây nữa https://code.claude.com/docs/en/vs-code. tìm luôn trên mạng nếu có chỗ nào tham khảo thì làm tham khảo luôn. Càng giống nó càng tốt. Từ cái nút. từ behavior hay cảm giác sử dụng thì quá tốt luôn"

**Mid-cycle clarifications (recorded 2026-09-07):**
- Color: BLUE replaces Claude's orange — same accent placement, just blue palette.
- Brand mark: big letter "U" (UnicDB), blue, treated as the panel icon. Must be large + easy to see.
- Everything else: position, layout, behavior, control placement, animations, dark theme — clone the Claude Code extension as faithfully as possible.
- Design references: marketplace page + https://code.claude.com/docs/en/vs-code + user's screenshot (red square stop button + input area with "+" / "/N" / model chip / bypass-permissions toggle / mic).

**P0 answers (VERBATIM — binding for all phases):**
1. **Panel scope:** Replace AiChatPanel entirely (cleanest clone; single panel with full Claude Code UI/UX)
2. **"U" mark:** Plain character glyph "U" — just the letter U rendered large in BLUE sans-serif
3. **Permission toggle:** Show, default-OFF (matches AGT's default-deny posture; safer)
4. **Model chip:** Show all configured models in dropdown (reads `cfg.models` from AGT; switching is one click; mirrors Claude Code's `/model`)

**Success definition:** Opening `UnicDB.aiChat` shows a single panel that visually and behaviorally mirrors the Claude Code VS Code extension — blue-accent header with a large blue "U" glyph + engine-aware title, dark chat thread with user/assistant bubbles + thinking blocks + tool cards, and a sticky composer row (red square stop while streaming, `+` attach, model chip dropdown fed by `cfg.models`, `/` slash-command affordance, bypass-permissions toggle default OFF, mic placeholder) — with ALL existing chat behavior (engine dispatch from AGT TASK-011/012, mentions, attachments, resume, regenerate, usage chip, permission flow) preserved and the existing test suite green.

Scope complexity: LOW — one subsystem (AI chat panel UI + its wire protocol). No multi-module decomposition; nothing queued.

## §2 Scope

**In-scope:**
- `webview/styles.css` — chat-scoped (`UnicDB-chat*` only) clone design tokens + component styles + keyframes (file is shared by ALL webviews via the single `dist/webview.css` bundle — non-chat selectors are frozen).
- `webview/aiChatPanelMain.ts` — restructured DOM via new modules, same element ids + wire behavior.
- NEW `webview/aiChatPanelHeader.ts`, `webview/aiChatPanelComposer.ts`, `webview/aiChatPanelThread.ts` — extracted pure-DOM modules (keeps executors on disjoint files, enables a wide wave 1).
- `src/ui/aiChatPanelMessages.ts` — new frames: `models` (host→webview), `model_select` + `bypass_permissions` (webview→host).
- `src/ui/aiChatPanel.ts` — host: post `models`, accept `model_select`/`bypass_permissions`; panel-session bypass flag with allow-first auto-answer + deny fallback.
- New test files listed per task; existing suites must stay green.

**Out-of-scope:**
- Engine routing/adapters (`src/ai/**`, AGT TASK-011/012 dispatch semantics) — unchanged.
- Permission policy semantics change — toggle is UI + session flag; DEFAULT stays AGT default-deny.
- New AI engines (only the 4-engine model from AGT). Marketplace/GitHub release plumbing. Version bump beyond noting 1.53.25 target (release is a separate step).

**File-ownership / wave constraint (same-wave tasks never share a file):**
- Wave 1 (parallel, 5): 001 owns `webview/styles.css` · 002 owns `src/ui/aiChatPanelMessages.ts` · 003 owns `webview/aiChatPanelHeader.ts` (new) · 004 owns `webview/aiChatPanelComposer.ts` (new) · 005 owns `webview/aiChatPanelThread.ts` (new). Each owns its own new test file.
- Wave 2 (parallel, 2): 006 owns `src/ui/aiChatPanel.ts` · 007 owns `webview/aiChatPanelMain.ts` — disjoint.
- Wave 3 (1): 008 owns `webview/aiChatPanelMain.ts` + `webview/styles.css` (both free after waves 1–2).

## §3 Approach

Replace the chat panel's DOM construction with three pure-DOM webview modules (header / composer / thread) composed by `aiChatPanelMain.ts`, restyled by a token-driven chat-scoped CSS layer, plus two new wire frames so the composer can render real data. Host keeps every existing behavior and the AGT engine dispatch untouched.

Key decisions (chosen, not asked — unattended run):
- **Accent BLUE = `#3B82F6`** (Tailwind blue-500), hover `#60A5FA`, strong `#2563EB`; stop red `#dc2626`; bypass-ON warning amber `#f59e0b`; surfaces ride VS Code dark-theme tokens (`--vscode-*`) with charcoal fallback `#1e1e1e`. Rationale: reads as VS Code-native blue on dark; distinct from Claude's orange; documented here so executors don't pick another hex.
- **Brand "U"**: plain text glyph, `font-weight:800`, large fixed box (28px+) in the header left, `aria-hidden` + `title="UnicDB"`. No image asset (P0 #2 — plain glyph).
- **Header = evolved engine banner, not a second surface**: the existing `#engineBanner` node (id + `UnicDB-chat-engine UnicDB-chat-engine-<whitelisted>` class, pinned by `aiChatPanelWebview.test.ts`) moves INTO the header title slot. Existing whitelist-safe labeling is preserved verbatim — the legacy closed map from `webview/aiChatPanelMain.ts:1437-1465` (`omp→"oh-my-pi (omp)"`, `claude-code→"Claude Code"`, `codex→"Codex"`, `builtin|unknown|null→"builtin"`, text `Engine: <label>[ v<version>] — <state>`); the "UnicDB AI" branding lives in the brand "U" glyph + a separate static title node, never inside `#engineBanner` textContent (never raw wire text in HTML).
- **Model chip** lists the four `AiModelRole`s (`work|smart|autocomplete|lite` from `src/ai/settings.ts`) filtered to roles with a non-empty `modelId`; click posts `model_select{role}`; host replies with a fresh `models` frame (no chat-bubble spam — deliberate divergence from `/model`'s assistant echo). This supersedes `/model`'s `work|smart`-only restriction; the slash command itself stays as-is.
- **Bypass-permissions toggle**: UI switch default OFF; posts `bypass_permissions{enabled}`; host keeps a panel-session flag (never persisted). While ON, an incoming ACP permission request is auto-answered with the first allow-kind option; if no allow-kind option is identifiable, the host DENIES (omits `optionId`) — deny-posture preserved on ambiguity. Exact ACP option shape is confirmed from `src/ai/omp/` at execution time (executor reads the live source; see TASK-AGTUI-006 Discussion).
- **Element-id compatibility contract**: `prompt`, `sendBtn`, `stopBtn`, `attachBtn`, `attachStrip`, `attachFileInput`, `thread`, `jumpLatest`, `engineBanner`, `usageChip` all survive the redesign so the existing chat webview suites keep passing unchanged (6 `aiChatPanel*Webview*` test files; `#engineBanner` pinned 15x in `aiChatPanelWebview.test.ts`); new controls get new ids (`modelChipBtn`, `modelChipMenu`, `bypassToggle`, `micBtn`, `slashHintBtn`). Four more legacy ids are pinned by the same suites and belong to the W1 module owners (no re-ownership needed): `#resumeBtn`, `#clearBtn`, `#regenerateBtn` — legacy action buttons living in the composer row, owned by `webview/aiChatPanelComposer.ts` (TASK-AGTUI-004); busy-disable contract = send-in-flight sets `disabled` on `sendBtn`/`resumeBtn`/`regenerateBtn`/`attachBtn` and `done` re-enables, `clearBtn` untouched (`aiChatPanelWebview.test.ts:788-801` `#AG4`; ids also pinned by `aiChatPanelBundle.test.ts:115,151,162,237-240`); `#sessionChip` — session-state chip owned by `webview/aiChatPanelHeader.ts` (TASK-AGTUI-003); legacy classes `UnicDB-chat-session UnicDB-chat-session-<state>` + textContent-only labels `Connecting…`/`Running…`/`Done`/`Error` (`aiChatPanelSessionStateWebview.test.ts:85-118`).
- **Alternatives rejected**: (a) rewriting `aiChatPanelMain.ts` monolithically in one task — too big for one reviewer gate and serializes the whole cycle; (b) a separate `.css` file per panel — breaks the single-bundle `dist/webview.css` build; (c) persisting bypass state — violates default-deny posture; (d) overriding the surface guards — unnecessary, they freeze `src/adapters/**` + `package.json` deps, none of which this cycle touches.

## §4 Test Plan

TDD mandatory per task (RED→GREEN). House patterns: CSS contract = regex over `webview/styles.css` text (chatLayoutCss.test.ts pattern); webview behavior = esbuild-bundle the module + jsdom + stubbed `acquireVsCodeApi` (aiChatPanelWebview.test.ts pattern); host = existing vitest harness.

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | Clone token block exists with BLUE accent | `--UnicDB-chat-accent: #3b82f6` (+ hover/strong/stop/warn tokens) present in styles.css |
| edge (boundary/value) | Exact accent + stop hexes | accent `#3b82f6`, stop `#dc2626`, bypass-ON `#f59e0b` — no Claude orange (#d97757 family) anywhere in chat rules |
| edge (isolation/scope) | Non-chat selectors untouched | `.UnicDB-toolbar`, `.UnicDB-tab`, `.UnicDB-grid-host` rules still present byte-equivalent; every NEW rule is scoped under `.UnicDB-chat` / `.UnicDB-chat-*` |
| happy | Composer renders clone row | `+` attach, model chip, `/` hint, bypass toggle (OFF), mic placeholder, send/stop all present with correct ids/aria |
| edge (state) | Busy swap | `setBusy(true)` hides send, shows red square stop + pulse class; `setBusy(false)` restores send |
| edge (empty) | Empty models list | chip renders disabled with "No models configured"; clicking posts nothing |
| happy | Header brand + engine banner | large blue "U" glyph + static "UnicDB AI" title node; `#engineBanner` text `Engine: <label>[ v<ver>] — streaming` per legacy closed map (`oh-my-pi (omp)`/`Claude Code`/`Codex`/`builtin`) |
| edge (malformed input) | Hostile/unknown wire text | unknown engine name → `builtin` label (banner reads `Engine: builtin — streaming`, class `builtin`); hostile tool/option labels render as textContent, never live HTML nodes |
| happy | Thread rendering parity | user/assistant bubbles, thinking block, tool card, change-plan card, usage chip render with existing classes |
| edge (duplicate) | Single response per interaction | plan approve/reject each fire exactly once per card; bypass toggle double-click posts alternating `enabled` true/false exactly |
| happy | Host models frame + role switch | `ready` → one `models` frame; valid `model_select` → activeRole set + fresh `models` frame |
| edge (permission) | Bypass ON auto-answer + fallback | allow-kind option → auto-answered with its optionId; no allow-kind option → denied with `optionId` omitted |
| edge (unknown value) | Invalid model_select | unknown role OR empty-modelId role → error bubble, activeRole unchanged |
| regression | Existing chat suites stay green | all `aiChatPanel*.test.ts`, `chatLayoutCss.test.ts`, bq surface guards pass after each wave; `npm run compile` then bundle tests pass |
| edge (accessibility/motion) | Reduced motion | `prefers-reduced-motion: reduce` disables stop pulse + typing caret (CSS contract assertion) |

## §5 Verification

```bash
npm run typecheck                 # tsc --noEmit — static gate
npx vitest run <task test file>   # per-task RED→GREEN cycle
npm test                          # full suite at wave boundaries (incl. bq surface guards)
npm run compile                   # esbuild — required before aiChatPanelBundle tests
```
No `lint` script exists in package.json (verified: compile, watch, test, test:integration, typecheck, package, publish:*, verify:fast, verify:release, profile:*) — `npm run typecheck` is the static-analysis gate. Wave-boundary gate: `npm test && npm run typecheck && npm run compile`.

## §6 Acceptance

- [ ] Panel shows header with large BLUE "U" glyph + engine-aware title (TASK-AGTUI-003, 007)
- [ ] Composer matches Claude Code layout: red square stop while streaming, `+`, model chip, `/` affordance, bypass toggle (default OFF), mic placeholder (TASK-AGTUI-004, 007)
- [ ] Model chip dropdown lists `cfg.models` roles with non-empty modelId; one click switches active role (TASK-AGTUI-002, 006, 007)
- [ ] Bypass toggle default-OFF; ON auto-answers allow-kind requests, denies on ambiguity; nothing persisted (TASK-AGTUI-002, 006)
- [ ] Thread renders bubbles/thinking/tool-cards/file mentions with clone styling (TASK-AGTUI-001, 005)
- [ ] Blue token palette everywhere Claude used orange; stop red square; amber bypass-ON (TASK-AGTUI-001)
- [ ] Stream typing animation, tool-card expand/collapse, toggle ease, stop pulse; reduced-motion respected (TASK-AGTUI-008)
- [ ] Engine dispatch from AGT TASK-011/012 untouched; `aiChatPanelAgentEngines.test.ts` green (TASK-AGTUI-006)
- [ ] All pre-existing chat tests + bq surface guards green; `npm test && npm run typecheck && npm run compile` pass (TASK-AGTUI-007, 008)

## §7 Global Constraints (inherited by every TASK-AGTUI-xxx.md by reference)

- No new npm dependencies (bq surface guards freeze the `package.json` dependency manifest).
- Never edit: `src/adapters/**`, `src/ai/**`, `src/extension.ts`, `package.json` (name/version/deps).
- `webview/styles.css` is shared by ALL panels — new/changed rules must be scoped to `.UnicDB-chat*`; non-chat selectors frozen.
- Wire protocol is additive only: existing message shapes and element ids (§3 contract) unchanged.
- Colors fixed by §3 (blue `#3b82f6` family, stop `#dc2626`, warn `#f59e0b`); no Claude orange.
- CSP unchanged (`style-src cspSource 'unsafe-inline'` already allows the CSS layer; no inline `<script>`).
- npm + vitest + esbuild only; VS Code webview target ES2022; dark theme via `--vscode-*` tokens with fallbacks.
- Permission default-deny posture inviolable; bypass flag is session-only, never persisted.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: named TASK ids cycle-prefixed (`TASK-AGTUI-xxx`) instead of plain `TASK-001..NNN` — plain ids belong to the shipped AGT cycle and must not be clobbered; dropped the caller-suggested "surface-guard carve-out" task after verifying `bqFollowupSurfaceGuard`/`bq04SurfaceGuard` freeze only `src/adapters/**` + `package.json` deps (+ one additive-safe `src/extension.ts` marker), none of which this cycle edits — guard runs are folded into every task's regression and TASK-AGTUI-008's full gate.
Known gaps: (1) visual fidelity to the Claude Code extension is judged against the documented layout/palette spec in §1/§3, not pixel-comparison against the closed-source extension — reviewer should sanity-check against the marketplace screenshots; (2) TASK-AGTUI-006's "allow-kind option" predicate depends on the real ACP permission-option shape — deliberately left as an executor read of `src/ai/omp/` with a mandatory deny fallback rather than guessed here; (3) TASK-AGTUI-002's RED state is a `npm run typecheck` failure (type-level addition), not a runtime vitest failure; (4) mic voice input is a disabled placeholder — no backend exists (matches screenshot scope).

## Plan Review Log

### Round 2 — findings applied
- [important] TASK-AGTUI-003: #engineBanner label map corrected to legacy strings (omp→"oh-my-pi (omp)", claude-code→"Claude Code", codex→"Codex", builtin|unknown|null→"builtin"); "UnicDB AI" branding moved to brand "U" glyph + separate static title node. PLAN.md §3/§4 rows updated.
- [minor] TASK-AGTUI-001: `.UnicDB-chat-stop-live` appended to selector list.
- [minor] TASK-AGTUI-006: Consumes rewritten to `deps.loadConfig(): Promise<AiConfig>` → `cfg.models: Record<AiModelRole, AiModelConfig>`.
- [minor] PLAN.md: "12 test files" → "6 aiChatPanel*Webview* files; #engineBanner pinned 15x in aiChatPanelWebview.test.ts".

### Round 3 — findings applied without re-review
- [important] Element-id compatibility contract extended: added `#resumeBtn`, `#clearBtn`, `#regenerateBtn`, `#sessionChip` (PLAN.md §3, TASK-AGTUI-007 test 1, TASK-AGTUI-004 test rows for action buttons + busy-disable, TASK-AGTUI-003 setSessionState contract for sessionChip classes/labels).
- [minor] TASK-AGTUI-007 test 5: stale "UnicDB AI/builtin class" phrase reworded to "falls back to label `builtin`, class `UnicDB-chat-engine-builtin`; static title node stays `UnicDB AI`".
- [minor] TASK-AGTUI-007 verification commands: added the 6 missing aiChatPanel*Webview*/aiChatPanelBundle test files to the contract gate.
  - Accuracy note: final vitest command is the union of the finding's 9-file block + the already-present `aiChatPanelThoughtRegen`/`aiChatPanelResume` + `aiChatPanelPolicy` (the 9th suite test 7 pins UNMODIFIED, absent from the suggested block) — so all 9 pinned suites plus `aiChatPanelBundle`/`aiChatPanelAttachments`/`aiChatPanelEngine` run at TASK-AGTUI-007's own gate; all filenames verified against `src/ui/__tests__/`.

## Planner Report
PLANNER_MODEL: unic-smart
