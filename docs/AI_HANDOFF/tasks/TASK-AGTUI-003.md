# TASK-AGTUI-003 — Header + brand module: big BLUE "U" glyph + engine-aware title

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3

## Goal

New pure-DOM webview module that builds the Claude Code–style header bar: large blue "U" brand glyph (plain text character, P0 #2), engine-aware title, and session-state chip. No wiring — integration is TASK-AGTUI-007.

## Target Files

- `webview/aiChatPanelHeader.ts` (new) — exports `renderHeader` factory.
- `webview/__tests__/aiChatPanelHeader.test.ts` (new) — jsdom unit test (pattern: `webview/__tests__/*.test.ts`, no esbuild bundling needed for a standalone module).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | renders brand + title | `renderHeader()` returns element `.UnicDB-chat-header` containing `#chatBrandMark` with textContent exactly `"U"`, class `UnicDB-chat-brand`, `aria-hidden="true"`, `title="UnicDB"`; `setEngine("claude-code")` → banner text `Engine: Claude Code — streaming` (legacy format), banner element carries class `UnicDB-chat-engine UnicDB-chat-engine-claude-code`, static title node still `UnicDB AI` | empty jsdom document |
| 2 | edge (malformed input) | unknown engine falls back | `setEngine("skynet")` → banner text `Engine: builtin — streaming` + banner class `builtin` (legacy `safeEngineLabel` whitelist fallback, never raw wire string in className/textContent); static title node remains `UnicDB AI` (static, never wire-derived) | unknown wire literal |
| 3 | edge (boundary) | optional version + absent version | `setEngine("omp","18.0.1")` → banner text contains `oh-my-pi (omp)` and `v18.0.1` (legacy label: `Engine: oh-my-pi (omp) v18.0.1 — streaming`); `setEngine("omp")` (no version) → no version fragment rendered (no stray "undefined") | two calls |
| 4 | edge (state repeat) | session chip replaces, not appends | calling `setSessionState("connecting")` then `setSessionState("running")` leaves exactly ONE `#sessionChip` node; its `className` carries the LEGACY classes `UnicDB-chat-session UnicDB-chat-session-running` (state suffix swapped per call) PLUS the additional clone class `UnicDB-chat-sessionchip` (additive — never a replacement for the legacy classes), textContent-only label `Running…` with zero child nodes; legacy label map `connecting→"Connecting…"`, `running→"Running…"`, `done→"Done"`, `error→"Error"` (pinned by `aiChatPanelSessionStateWebview.test.ts:85-118`, which TASK-AGTUI-007 must pass UNMODIFIED); `setSessionState(null)` removes the chip | repeated calls |
| 5 | edge (XSS) | hostile label safe | header never uses innerHTML with wire-derived strings; `setEngine` with a string containing `<img onerror>` renders as inert text or falls back to the `builtin` label (whitelist wins, legacy `safeEngineLabel` semantics) | hostile input |

## Test Files

- `webview/__tests__/aiChatPanelHeader.test.ts` (new)

## Verification Commands

```bash
npx vitest run webview/__tests__/aiChatPanelHeader.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; module has zero imports from host-only code (webview-safe: no `vscode` import).
- [ ] Brand "U" is a plain glyph styled via `.UnicDB-chat-brand` (TASK-AGTUI-001 tokens) — no image/SVG asset.
- [ ] Banner compatibility contract: engine title node carries `id="engineBanner"` + whitelisted `UnicDB-chat-engine UnicDB-chat-engine-<name>` classes, and its textContent uses the LEGACY closed map verbatim (`webview/aiChatPanelMain.ts:1437-1465`): `omp→"oh-my-pi (omp)"`, `claude-code→"Claude Code"`, `codex→"Codex"`, `builtin|unknown|null→"builtin"`, format `Engine: <label>[ v<version>] — <state>` — pinned 15x by `aiChatPanelWebview.test.ts:424-461,880-935`, which TASK-AGTUI-007 must pass UNMODIFIED. "UnicDB AI" branding lives ONLY in the brand "U" glyph (`title="UnicDB"`) + the separate static title node, NEVER in `#engineBanner` textContent.

## Dependencies

- none

## Interfaces

- Consumes: CSS `.UnicDB-chat-header`, `.UnicDB-chat-brand`, `.UnicDB-chat-title`, `.UnicDB-chat-sessionchip` from TASK-AGTUI-001 (classes only; this task compiles without it).
- Produces (exact signature):
```ts
export type HeaderEngine = "omp" | "claude-code" | "codex" | "builtin";
export interface UnicDBHeader {
  el: HTMLElement;              // .UnicDB-chat-header, contains #engineBanner + #chatBrandMark + #sessionChip
  setEngine(name: HeaderEngine | null, version?: string): void; // null → "builtin"
  setSessionState(state: "connecting" | "running" | "done" | "error" | null): void;
  //   Legacy contract (pinned by aiChatPanelSessionStateWebview.test.ts:85-118 — TASK-AGTUI-007
  //   must pass UNMODIFIED; legacy source webview/aiChatPanelMain.ts:1503-1525): creates/reuses
  //   ONE node id="sessionChip"; className = `UnicDB-chat-session UnicDB-chat-session-<state>`
  //   + the ADDITIONAL clone class `UnicDB-chat-sessionchip`; textContent-only labels —
  //   connecting→"Connecting…", running→"Running…", done→"Done", error→"Error" (no child
  //   nodes, never innerHTML); null → removes the chip.
}
export function renderHeader(root: HTMLElement): UnicDBHeader; // appends el to root
```
  Engine→banner label map (closed — MUST reuse the legacy strings verbatim from `ENGINE_LABELS`/`safeEngineLabel`, `webview/aiChatPanelMain.ts:1437-1465`): `omp→"oh-my-pi (omp)"`, `claude-code→"Claude Code"`, `codex→"Codex"`, `builtin|unknown|null→"builtin"`; banner text format `Engine: <label>[ v<version>] — <state>`. "UnicDB AI" branding lives ONLY in the brand "U" glyph (`title="UnicDB"`) + the separate static title node — NEVER inside `#engineBanner` textContent. Consumed by TASK-AGTUI-007.

## Executor Report

(appended below by executor)

---

## Reviewer Verdict

(appended below by reviewer)
