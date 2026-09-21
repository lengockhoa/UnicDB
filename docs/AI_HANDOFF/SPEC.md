# SPEC — BACKLOG: Generate-commit-message UX hardening + AIChat W5 a11y/perf audit

<!--
Written by the planner at handoff-create (P2, before PLAN.md tasks).
Rule: executor implements without guessing — exact paths, signatures, frozen
strings, thresholds, test expectations. Open questions resolved in §14.
Source: user report (GITMSG-001) + advisor spec §19 W5 (CHATUX-W5), mapped to
verified code anchors.
-->

## 1. Problem and context

Two queued backlog items, disjoint file sets.

**GITMSG-001 — Generate Commit Message UX.** User reports: generation is very
slow, the loading state hangs/loops forever, and the loading UI appears
repeatedly. Verified current state:

- `src/extension.ts:1277-1289` registers `UnicDB.generateCommitMessage`
  (manifest `package.json:456`, `scm/title` menu `:539`) as
  `vscode.window.withProgress({ location: SourceControl, title: "UnicDB:
  generating commit message…" }, () => runGenerateCommitMessage(...))`.
  Defects: (a) `cancellable` is not set → no Cancel button; (b) no re-entrancy
  guard → every click spawns another `withProgress` notification (the
  "repeated loading UI"); (c) the callback receives no `progress` handle →
  zero stage feedback for the whole wait (the "hangs" perception).
- `src/ai/commitGenCommand.ts` `runGenerateCommitMessage(deps)` — pure
  orchestration. `builtinComplete` calls `createProviderClient(...).complete`
  which is bounded only by `cfg.timeoutMs` (settings range 1000..600000,
  `src/ai/settings.ts:34`); `ProviderRequest` has no `signal` field and
  `complete()` (`src/ai/provider.ts:684-821`) builds a private
  `AbortController` → user cancellation cannot reach the fetch.
- omp path: `driveCommitGenOneShot` (`src/ai/commitGenOmpOneShot.ts:78-131`)
  already bounds the turn at `COMMIT_GEN_OMP_TIMEOUT_MS = 120_000` and
  auto-answers server requests, but exposes no `cancel()` — a user cancel
  cannot settle the turn early.
- Slowness analysis (recorded, §14 Q3): diff is already capped at
  `GIT_DIFF_MAX_BYTES = 12_288` (`src/adapters/gitDiff.ts:56`); the wait is
  dominated by the non-streaming model round-trip + up to one guard retry +
  (omp) a fresh `AcpProcess` spawn per click. The fix is bounded wait +
  visible stages + cancel, not a protocol rewrite.

**CHATUX-W5 — AIChat V2 a11y/perf audit** (advisor spec §19 W5, queued from
cycle CHATUX-2026-09-21). Verified current state:

- Focus rings: `:focus-visible` rules exist for ~20 selectors
  (`styles.css:184+`); `outline: none` appears exactly once, on the composer
  textarea (`styles.css:314`) whose wrapper carries `:focus-within`.
- aria: one polite + one assertive live region (`a11y.ts` `LIVE_REGION_IDS`),
  coalescing announcer, combobox `aria-activedescendant` linkage, icon
  buttons carry `aria-label` (`transcript.ts:140`).
- Reduced motion: three `@media (prefers-reduced-motion: reduce)` blocks
  (`styles.css:523, 978, 2971`) but they MISS: `-live-dot` pulse (:896),
  `-activity-icon.-activity-state-running` spin (:1428),
  `-autocomplete-spinner` spin (:1937), `-engine-working` descendants beyond
  `-engine-dot`, and `-toast` transitions.
- ≤30fps batching: stream paints are rAF-coalesced
  (`transcript.ts:224-237`) — up to ~60 markdown re-renders/sec on a 60Hz
  display, above the 30fps spec cap.
- Memoized blocks: `renderMarkdownInto` (`markdown.ts:243-249`) does
  `root.replaceChildren(fragment)` — every paint rebuilds ALL block DOM,
  re-parsing and re-creating code blocks (losing copy-button state) even
  though only the last block grows during streaming.

## 2. Goals

- GITMSG: at most ONE in-flight generation per window; cancellable progress
  with per-stage feedback; a hard 120s ceiling on the builtin path (omp
  already has one); cancel settles the omp turn early; a second click shows
  a single info toast instead of a second spinner.
- W5: every animation/transition suppressed under
  `prefers-reduced-motion: reduce`; focus-ring coverage pinned by CSS-scan
  tests; stream paints capped at ≤30fps; unchanged markdown blocks reuse
  their DOM nodes (memoized) so a streaming paint only rebuilds the tail.

## 3. Non-goals

- KHÔNG streaming commit-gen (SSE → progress) — `streamComplete` exists but
  rewiring the guard/retry pipeline to incremental text is out of scope;
  stage messages + cancel deliver the UX fix.
- KHÔNG prompt/model changes — system prompt, `GIT_DIFF_MAX_BYTES`,
  `maxOutputTokens: 300`, `temperature: 0.2` stay frozen.
- KHÔNG multi-repo picker, KHÔNG new engines (claude-code/codex adapters).
- KHÔNG đụng V1 appenders (`aiChatPanelMain.ts`, `markdownSafe.ts`,
  `webview/styles.css`); V2 (`webview/aiChat/`) is the live surface.
- KHÔNG engine/protocol/permission code in the webview (`store.ts` event
  kinds, `controller.ts` transport).
- KHÔNG new dependencies, KHÔNG version bump / publish (ship pipeline is the
  orchestrator's end-of-run step, not a task).

## 4. User journeys

- **Single generation:** user clicks the SCM sparkle → one Source Control
  progress entry appears with a Cancel button → stage text updates
  ("collecting diff…" → "contacting model…" → "validating message…") →
  message lands in the commit box. A second click while running → one info
  toast, no second spinner.
- **Cancel:** user clicks Cancel → in-flight fetch/omp turn settles
  immediately → progress closes → nothing is injected, no error toast.
- **Slow provider:** provider stalls → at 120s the progress closes with the
  existing provider-error toast (timeout), never spins forever.
- **Reduced motion:** OS "reduce motion" on → no pulse/spin/caret animation
  anywhere in the chat panel; status stays readable (static icon + text).
- **Streaming:** assistant deltas arrive in bursts → transcript repaints at
  most ~30×/sec; completed blocks keep their DOM (code-block Copy button
  state, scroll anchors, selection survive a repaint).

## 5. Functional requirements

- **FR-001 (single-flight gate):** new pure module
  `src/ai/commitGenGate.ts` exports
  `createCommitGenGate(): { acquire(): (() => void) | null }` — `acquire()`
  returns a release function when the slot is free, `null` when a run is in
  flight. Release is idempotent. `src/extension.ts` holds ONE gate at module
  scope; the command callback acquires first and, on `null`, shows
  `TOAST_GENERATION_IN_PROGRESS` and returns without calling `withProgress`.
- **FR-002 (cancellable progress + stages):** `withProgress` options become
  `{ location: SourceControl, title: "UnicDB: generating commit message…",
  cancellable: true }`; the callback signature becomes
  `(progress, token)`. `CommitGenDeps` gains:
  ```ts
  report?(message: string): void;
  isCancelled?(): boolean;
  ```
  `runGenerateCommitMessage` reports the frozen stage strings
  `PROGRESS_COLLECTING_DIFF` / `PROGRESS_CONTACTING_MODEL` /
  `PROGRESS_VALIDATING` / `PROGRESS_RETRYING` at the matching points and
  returns silently (no toast, no injection) when `isCancelled()` is true at
  the post-diff and post-outcome checkpoints.
- **FR-003 (cancel reaches the fetch):** `ProviderRequest` gains
  `signal?: AbortSignal`; `complete()` links it to its internal
  `AbortController` (abort propagates; a pre-aborted signal aborts before
  fetch). `builtinComplete` port signature becomes
  `(cfg, req: ProviderRequest & { signal?: AbortSignal }) => Promise<ProviderResult>`
  — the request type already carries it, so the port signature is unchanged
  in shape. `src/extension.ts` passes `token` through an `AbortController`
  (`token.onCancellationRequested(() => controller.abort())`).
- **FR-004 (bounded builtin wait):** new export
  `COMMIT_GEN_TIMEOUT_MS = 120_000` in `src/ai/commitGenCommand.ts`; the
  builtin/fallback `builtinComplete` calls pass
  `maxOutputTokens: 300, temperature: 0.2` unchanged, and the host wires
  `createProviderClient({ ..., timeoutMs: COMMIT_GEN_TIMEOUT_MS })` for the
  commit-gen client (overrides the user `cfg.timeoutMs` for this flow only).
- **FR-005 (omp cancel):** `OmpOneShot` gains `cancel?(): void`;
  `CommitGenOneShotDriver` gains `cancel(): void` — settles the driver with
  a `commit-gen: cancelled` Error and runs `onSettle` (engine shutdown).
  `buildCommitGenOmpOneShot` wires `token.onCancellationRequested` →
  `oneShot.cancel()`. Cancelled outcome → `runGenerateCommitMessage`
  returns silently (the `isCancelled` checkpoint), no error toast.
- **FR-006 (reduced-motion coverage):** `styles.css` — extend the
  `@media (prefers-reduced-motion: reduce)` blocks so EVERY selector that
  sets `animation`/`transition` outside those blocks is suppressed inside
  them: add `-live-dot`, `-activity-icon.-activity-state-running`,
  `-autocomplete-spinner`, `-engine-working` (all descendants), `-toast`,
  `-menu-row`/`-overlay-modal`/`-dialog` transitions. A CSS-scan test
  asserts: every `animation:`/`transition:` declaration outside a
  reduced-motion block belongs to a selector listed inside one.
- **FR-007 (focus-ring audit):** CSS-scan test pins: (a) `outline: none`
  appears ONLY on `-input` (composer textarea, ring via `:focus-within`);
  (b) every interactive class that is keyboard-focusable has a
  `:focus-visible` rule — pinned list: `-control`, `-send`, `-action`,
  `-chip`, `-context-chip-body`, `-context-chip-remove`, `-primary`,
  `-activity-header`, `-activity-reasoning-header`, `-menu-row`,
  `-dialog-action`, `-title-input`, `-resume-row`, `-permission-action`,
  `-permission-details-toggle`, `-permission-detail-copy`,
  `-overlay-modal-action`, `-change-plan-action`, `-error-card-action`,
  `-scroll-pill`, `-codeblock-copy`, `-load-earlier`, `-reasoning-toggle`,
  `-tool-head`. Any interactive selector found without a rule → add the
  rule (2px `var(--UnicDB-ai-chat-v2-focus)` + 2px offset).
- **FR-008 (aria audit):** pin existing invariants with tests (no behavior
  change unless a gap is found): exactly one polite + one assertive live
  region per shell (`countLiveRegions`); every icon-only `actionButton`
  carries `aria-label`; combobox `aria-activedescendant` resolves to an
  existing option (`activeDescendantResolves`). Gaps found in files owned
  by TASK-CHATUX-W5-2 (transcript.ts) are fixed there; gaps elsewhere are
  recorded in Discussion, not fixed cross-task.
- **FR-009 (≤30fps paint):** `transcript.ts` — add
  `STREAM_PAINT_MIN_INTERVAL_MS = 33`; `schedulePaint` keeps the rAF path
  but, when a flush ran < 33ms ago, schedules the next flush via
  `setTimeout(remaining)` instead of a bare rAF. The 100ms
  `STREAM_PAINT_FALLBACK_MS` fallback is unchanged. Observable contract:
  N rapid `schedulePaint` calls within one 33ms window produce ≤1 flush.
- **FR-010 (memoized blocks):** `markdown.ts` — `renderMarkdownInto` keeps a
  per-root block cache (`WeakMap<HTMLElement, { keys: string[]; nodes:
  HTMLElement[] }>`). Block key = `kind|level|lang|text/code` serialized.
  On each call: parse blocks → for each index, reuse the cached node when
  the key matches, else `createBlockElement` → `replaceChildren(...nodes)`
  (reused nodes re-append in place, listeners/state survive). Cache is
  per-root so two bodies never share nodes. No `innerHTML` anywhere;
  `extractSqlFences` unchanged.

## 6. Fullstack scope

### Backend
Extension host only: `src/extension.ts` (command wiring),
`src/ai/commitGenCommand.ts`, `src/ai/commitGenGate.ts` (new),
`src/ai/commitGenOmpOneShot.ts`, `src/ai/provider.ts` (signal field).

### Database / schema / migrations
N/A.

### API contract
Module-level — §8. No message-protocol changes.

### Frontend UI and state
V2 surface only: `webview/aiChat/{transcript,markdown,a11y}.ts` +
`styles.css` + `__tests__/`.

### Integration
`runGenerateCommitMessage` stays the single entry; `withProgress` remains
the only progress surface. `renderState()`/scroll driver untouched.

### Security and permissions
No new permissions; clipboard stays click-gesture; escape-first markdown
contract preserved (memoization reuses nodes, never markup strings).

### Performance
Builtin commit-gen bounded at 120s; stream paints ≤30fps; unchanged blocks
skip re-parse + re-create.

### Observability / logging
Existing toasts/debug dumps unchanged; new stage strings are progress text,
not logs.

### Deployment and rollback
Pure source/webview change; rollback = revert commit.

## 7. State machines (frozen)

### 7.1 Commit-gen single-flight

```
acquire() → release fn   (slot free → run proceeds; release() in finally)
acquire() → null         (in flight → TOAST_GENERATION_IN_PROGRESS, return)
release()                (idempotent; frees the slot exactly once)
```

### 7.2 Stream paint throttle

```
schedulePaint(record, raw):
  pendingPaint.set(key, {record, raw})
  if a flush is already scheduled → return
  elapsed = now - lastFlushAt
  elapsed >= 33ms → rAF(flush) + setTimeout(100ms) fallback (unchanged)
  elapsed <  33ms → setTimeout(flush, 33ms - elapsed)
flushPending(): lastFlushAt = now; paint every pending record once
```

## 8. API contract (module-level, frozen)

### 8.1 `src/ai/commitGenGate.ts` (new)

```ts
export function createCommitGenGate(): { acquire(): (() => void) | null };
```

### 8.2 `src/ai/commitGenCommand.ts`

```ts
export const COMMIT_GEN_TIMEOUT_MS = 120_000;
export const TOAST_GENERATION_IN_PROGRESS =
  "UnicDB: a commit message is already being generated — wait for it to finish or cancel it.";
export const PROGRESS_COLLECTING_DIFF = "Collecting diff…";
export const PROGRESS_CONTACTING_MODEL = "Contacting model…";
export const PROGRESS_VALIDATING = "Validating message…";
export const PROGRESS_RETRYING = "Retrying with corrective prompt…";

export interface OmpOneShot {
  generate(prompt: string): Promise<string>;
  cancel?(): void;
}
export interface CommitGenDeps {
  // …existing ports unchanged…
  report?(message: string): void;
  isCancelled?(): boolean;
}
```

### 8.3 `src/ai/provider.ts`

```ts
export interface ProviderRequest {
  // …existing fields…
  signal?: AbortSignal;   // user-cancel channel; complete() links it
}
```

### 8.4 `src/ai/commitGenOmpOneShot.ts`

```ts
export interface CommitGenOneShotDriver {
  events: CommitGenOneShotEvents;
  fail(error: unknown): void;
  cancel(): void;                 // NEW — settle with "commit-gen: cancelled"
  promise: Promise<string>;
}
```

### 8.5 `webview/aiChat/transcript.ts`

```ts
export const STREAM_PAINT_MIN_INTERVAL_MS = 33;   // NEW
export const STREAM_PAINT_FALLBACK_MS = 100;      // unchanged
```

### 8.6 `webview/aiChat/markdown.ts`

```ts
export function renderMarkdownInto(root: HTMLElement, raw: string): void;
// same signature; internally memoized per root (§5 FR-010)
```

## 9. UI behavior

- SCM progress: single entry, cancellable, stage text rotates through the
  frozen PROGRESS_* strings; second click → info toast only.
- Cancel: progress closes, no injection, no error toast.
- Chat: no visible change except smoother streaming under load; reduced-
  motion users see zero animation.

## 10. Edge cases

- Double-click sparkle → exactly one progress entry + one toast.
- Cancel before diff resolves → silent return, no engine call.
- Cancel mid-retry → silent return; no injection.
- Pre-aborted signal → `complete()` rejects AbortError before fetch.
- omp turn cancelled → driver settles `commit-gen: cancelled`, engine
  shutdown runs once.
- Provider slower than 120s → timeout ProviderError → existing error toast.
- jsdom without rAF → setTimeout fallbacks keep tests green.
- Streaming burst >30 deltas/sec → ≤1 paint per 33ms window.
- Markdown where only the last paragraph grows → earlier block nodes are
  the SAME object across paints (identity-pinned test).
- Reduced-motion + running activity row → static icon, no spin.

## 11. Test matrix

| Area | Cases | Test file |
|------|-------|-----------|
| Gate | acquire→null while held; release→acquire succeeds; release idempotent | `src/ai/__tests__/commitGenGate.test.ts` (NEW) |
| Orchestration | report() called with frozen stages in order; isCancelled → silent return (no setInputBox, no toast); builtinComplete receives signal; COMMIT_GEN_TIMEOUT_MS exported | `src/ai/__tests__/commitGenCommand.test.ts` (extend) |
| Provider signal | linked signal aborts in-flight fetch (AbortError→timeout=false? — pinned: rejects, never hangs); pre-aborted signal rejects before fetch | `src/ai/__tests__/provider.test.ts` (extend) |
| omp driver | cancel() settles with "commit-gen: cancelled"; onSettle runs once; cancel after done is a no-op | `src/ai/__tests__/commitGenOmpOneShot.test.ts` (extend) |
| Wiring | manifest unchanged; command callback acquires gate (source-scan or deps-level test) | `src/ui/__tests__/commitGenManifest.test.ts` + `commitGenIntegration.test.ts` (extend) |
| Reduced motion | CSS scan: every animated/transitioned selector is covered by a reduce block | `webview/aiChat/__tests__/errorsScrollA11y.test.ts` (extend) |
| Focus ring | CSS scan: single `outline: none`; pinned `:focus-visible` selector list | same file (extend) |
| Paint throttle | burst of schedulePaint → ≤1 flush per 33ms (fake timers); fallback intact | `webview/aiChat/__tests__/transcript.test.ts` or `autoScroll.test.ts` (extend) |
| Memoization | unchanged block node identity across two renderMarkdownInto calls; changed tail rebuilds; code-block copy still works after repaint | `webview/aiChat/__tests__/codeBlock.test.ts` or `transcript.test.ts` (extend) |

## 12. Acceptance criteria

- [ ] `npx vitest run src/ai/__tests__/commitGenGate.test.ts src/ai/__tests__/commitGenCommand.test.ts src/ai/__tests__/provider.test.ts` — PASS.
- [ ] `npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts` — PASS.
- [ ] `npx vitest run webview/aiChat/__tests__/` — PASS.
- [ ] `npm run typecheck` — 0 errors; `npm run compile` — bundle OK.
- [ ] `npm test` — full suite PASS at wave boundary.
- [ ] `withProgress` call carries `cancellable: true`; exactly one gate
      instance; `ProviderRequest.signal` consumed by `complete()`.
- [ ] No `animation:`/`transition:` selector outside reduced-motion
      coverage; `outline: none` only on `-input`.

## 13. Migration / upgrade steps

N/A — no persisted state. Intentional behavior changes: second click
toasts instead of stacking spinners; builtin commit-gen capped at 120s;
cancel closes the flow silently.

## 14. Open questions and chosen defaults

| Question | Chosen default | Rationale |
|----------|----------------|-----------|
| Q1: Second click behavior? | Info toast `TOAST_GENERATION_IN_PROGRESS`, no second spinner. | Silent no-op feels broken; a second spinner is the reported bug. |
| Q2: Builtin timeout value? | `COMMIT_GEN_TIMEOUT_MS = 120_000`, matching the omp ceiling. | A commit message never needs 10 minutes; symmetric bounds are easier to reason about. |
| Q3: Why is generation slow — fix the root cause? | The wait is the model round-trip (non-streaming) + possible retry + omp spawn; diff is already capped at 12KB. Fix = bounded wait + stage feedback + cancel (the UX defect), not a protocol rewrite. Streaming commit-gen recorded as out-of-scope (§3). | Streaming through the guard/retry pipeline is a larger refactor; the reported defects are hang/duplication/no-feedback. |
| Q4: Cancel UX? | Silent close (no toast, no injection). | Cancel is a deliberate user act; an error toast would be noise. |
| Q5: 30fps mechanism? | Min-interval throttle (33ms) on top of the existing rAF coalescer. | rAF alone allows ~60fps; a timestamp gate caps it without changing the fallback contract. |
| Q6: Memoization granularity? | Per-block DOM node reuse keyed by serialized block content, per-root WeakMap. | Streaming only grows the tail; block-level reuse preserves code-block state and is testable by node identity. |
| Q7: Task split? | GITMSG-001 (core: gate+deps+provider signal) → GITMSG-002 (wiring: extension.ts+omp driver); W5-1 (styles.css+a11y.ts) ∥ W5-2 (transcript.ts+markdown.ts). | Same-file rule; core must land before wiring consumes its exports. |

## 15. Review checklist

- [x] Every FR testable (§11 maps each FR to file + concrete expectations).
- [x] All layers covered or N/A'd (no DB/protocol work).
- [x] Thresholds frozen: 120s ceilings, 33ms paint interval, 100ms
      fallback, 12KB diff cap (unchanged), frozen strings listed in §8.
- [x] Dependencies: GITMSG-002 after GITMSG-001 (consumes its exports);
      W5-1 ∥ W5-2 disjoint files; GITMSG ∥ CHATUX disjoint areas.
- [x] Phase 0 sweep: INDEX queued rows GITMSG-001 + CHATUX-W5 folded in;
      18 AIX leftovers verified done (P1) — not re-planned; `git status`
      shows only RUN.md modified (runner-owned).
- [x] Anti-requirements honored: no streaming rewrite, no prompt changes,
      no new deps, no V1 surface, no engine/protocol edits.
