# PLAN — BACKLOG-2026-09-21: commit-gen UX hardening + AIChat W5 a11y/perf

## §1 Intent

Process the two queued backlog items:

1. **GITMSG-001** — user report: Generate Commit Message is very slow, the
   loading state hangs/loops forever, and the loading UI appears repeatedly.
   Verified causes: `withProgress` is not cancellable and has no re-entrancy
   guard (each click stacks another spinner), no stage feedback (one static
   title for the whole wait), builtin path bounded only by the user's global
   `timeoutMs` (up to 600s), and no cancel channel into `complete()` or the
   omp driver.
2. **CHATUX-W5** — advisor spec §19 W5 audit: focus rings, aria,
   reduced-motion, ≤30fps update batching, memoized blocks. Verified gaps:
   reduced-motion misses `-live-dot`/`-activity-icon`/`-autocomplete-spinner`;
   paints run at rAF rate (~60fps); `renderMarkdownInto` rebuilds all block
   DOM per paint.

Success: one cancellable progress entry with stage text and a 120s ceiling;
second click toasts instead of stacking; cancel settles builtin + omp paths
silently; every animation suppressed under reduced-motion; stream paints
≤30fps; unchanged markdown blocks keep their DOM nodes.

## §2 Scope

**In scope**
- `src/ai/commitGenGate.ts` (new), `src/ai/commitGenCommand.ts`,
  `src/ai/provider.ts` (signal field), `src/ai/commitGenOmpOneShot.ts`,
  `src/extension.ts` (command wiring only).
- `webview/aiChat/styles.css`, `webview/aiChat/a11y.ts`,
  `webview/aiChat/transcript.ts`, `webview/aiChat/markdown.ts`.
- Tests: `src/ai/__tests__/commitGenGate.test.ts` (new),
  `commitGenCommand.test.ts`, `provider.test.ts`,
  `commitGenOmpOneShot.test.ts`, `src/ui/__tests__/commitGen{Manifest,
  Integration}.test.ts`, `webview/aiChat/__tests__/errorsScrollA11y.test.ts`,
  `transcript.test.ts`, `codeBlock.test.ts`.

**Out of scope** — streaming commit-gen, prompt/model changes, multi-repo
picker, claude-code/codex commit adapters, V1 webview appenders,
engine/protocol/permission code, new dependencies, version bump/publish.
The 18 `TASK-AIX0{3,5,6}-*` files in `tasks/` are prior-cycle leftovers
verified done in P1 — not folded, not re-planned.

**File-collision constraint:** GITMSG-002 consumes GITMSG-001's exports →
serialized. W5-1 owns `styles.css`+`a11y.ts`; W5-2 owns
`transcript.ts`+`markdown.ts` — disjoint. GITMSG and CHATUX areas share no
file. `errorsScrollA11y.test.ts` is W5-1's; `transcript.test.ts` +
`codeBlock.test.ts` are W5-2's.

## §3 Approach

- **Single-flight:** a pure `createCommitGenGate()` (acquire → release fn |
  null) held at module scope in `extension.ts`; second click → frozen info
  toast, return before `withProgress`. Pure module keeps it unit-testable
  without vscode.
- **Cancel:** `withProgress({ cancellable: true })` → `CancellationToken` →
  `AbortController` → `ProviderRequest.signal` (new optional field; the
  client's internal controller links it) for builtin, and →
  `OmpOneShot.cancel()` → `CommitGenOneShotDriver.cancel()` (settles with
  `commit-gen: cancelled`, runs `onSettle` → engine shutdown) for omp.
  `isCancelled()` checkpoints in `runGenerateCommitMessage` return silently.
- **Bounded wait:** `COMMIT_GEN_TIMEOUT_MS = 120_000` (matches the existing
  omp ceiling) wired as the commit-gen provider client's `timeoutMs` —
  overrides the user's global timeout for this flow only.
- **Stage feedback:** `deps.report` receives frozen `PROGRESS_*` strings at
  collect/contact/validate/retry points; `withProgress` maps them to
  `progress.report({ message })`.
- **Slowness (investigation outcome, SPEC §14 Q3):** diff already capped at
  12KB; the wait is the non-streaming model round-trip + up to one guard
  retry + (omp) a fresh `AcpProcess` spawn. The fix is bounded wait +
  visible stages + cancel — streaming the generation is deliberately
  rejected (larger refactor through the guard/retry pipeline, no new
  information for the user mid-turn).
- **W5:** CSS-scan tests pin reduced-motion coverage (every animated
  selector listed in a reduce block) and the focus-ring selector list;
  `STREAM_PAINT_MIN_INTERVAL_MS = 33` throttles the existing rAF coalescer;
  `renderMarkdownInto` memoizes block DOM per root via a WeakMap keyed by
  serialized block content.

## §4 Test Plan

| Type | Test name | Expected |
|------|-----------|----------|
| happy | gate acquire→release→acquire | second acquire succeeds after release |
| edge (re-entrancy) | acquire while held | returns null; release idempotent |
| regression | command callback acquires gate / manifest unchanged | `extension.ts` source-scan: gate acquire precedes `withProgress`; existing manifest guards still pass |
| happy | report stages | `report()` sees PROGRESS_COLLECTING_DIFF → CONTACTING_MODEL → VALIDATING in order |
| edge (cancel) | isCancelled true after diff | silent return: no setInputBox, no toast, no engine call |
| edge (timing) | cancel mid-retry | `isCancelled` true at post-outcome checkpoint after a guard retry → silent return, no injection, no toast |
| regression | builtinComplete receives `req.signal` | fake port observes an AbortSignal (today: field absent) |
| happy | `COMMIT_GEN_TIMEOUT_MS` export | `=== 120_000`, exported from `commitGenCommand.ts` |
| edge (boundary) | pre-aborted signal into `complete()` | rejects before fetch is called |
| happy | driver.cancel() | promise rejects `commit-gen: cancelled`; onSettle once |
| edge (ordering) | cancel after onDone | no-op, promise stays resolved |
| happy | reduced-motion CSS scan | every `animation:`/`transition:` selector outside reduce blocks is covered inside one |
| edge (different kind: CSS invariant) | `outline: none` count | exactly 1 (composer `-input`); pinned `:focus-visible` list all present |
| happy | paint throttle | 5 schedulePaint calls in <33ms → exactly 1 flush (fake timers) |
| edge (boundary) | flush at exactly 33ms | next paint allowed via rAF path |
| regression | memoized blocks | second `renderMarkdownInto` reuses unchanged block node identity (today: all nodes rebuilt) |
| edge (malformed) | raw with only a fence, then fence+paragraph | code node reused; paragraph appended; copy button still bound |

## §5 Verification

```bash
npx vitest run src/ai/__tests__/commitGenGate.test.ts src/ai/__tests__/commitGenCommand.test.ts src/ai/__tests__/provider.test.ts
npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts
npx vitest run webview/aiChat/__tests__/errorsScrollA11y.test.ts webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/codeBlock.test.ts
npm run typecheck
npm run compile   # esbuild bundle — can fail where tsc --noEmit passes (SPEC §12)
npm test   # full suite at wave boundary (regression net)
```

## §6 Acceptance

- [ ] All §4 tests pass; `npm run typecheck` clean; `npm run compile` bundles; `npm test` green at wave boundary.
- [ ] `withProgress` carries `cancellable: true`; exactly one gate; second click → toast only.
- [ ] `ProviderRequest.signal` consumed by `complete()`; builtin client uses `COMMIT_GEN_TIMEOUT_MS`.
- [ ] `OmpOneShot.cancel`/`CommitGenOneShotDriver.cancel` settle the turn once.
- [ ] CSS scans pass: reduced-motion coverage complete; `outline: none` only on `-input`.
- [ ] `STREAM_PAINT_MIN_INTERVAL_MS = 33` enforced; block memoization preserves node identity.

## §7 Global Constraints

- No `vscode` import in `src/ai/*` or `webview/aiChat/*` modules — ports only.
- No `innerHTML` anywhere; markdown stays escape-first (textContent nodes).
- Frozen strings live in the owning module as exported consts — tests import, never retype.
- No new dependencies; no version bump; no publish steps inside tasks.
- VS Code theme tokens / existing `--UnicDB-ai-chat-v2-*` vars only — no hard-coded colors.
- jsdom compat: guard `requestAnimationFrame`/`ResizeObserver` with setTimeout fallbacks.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Planner Self-Audit
Checklist: 14/14 pass
Fixed during audit: split GITMSG into core(001)→wiring(002) after confirming
GITMSG-002 consumes GITMSG-001's new exports (real dependency, not ordering
preference); assigned transcript.ts aria fixes to W5-2 to keep W5-1's file
set disjoint; moved provider signal into GITMSG-001 so the port contract
lands with its consumers.
Known gaps: streaming commit-gen deliberately out of scope (SPEC §14 Q3);
aria gaps outside owned files are recorded in Discussion, not fixed
cross-task.

## Plan Review Log

### Round 1 — 2026-09-21 · unic-smart
Status: Issues Found

COMPLETENESS:
  - PLAN §4 test table drops rows the SPEC §11 matrix mandates: no row for
    the wiring test "command callback acquires gate / manifest unchanged"
    (commitGenManifest.test.ts + commitGenIntegration.test.ts sit in §2 scope
    and §5 commands but carry no §4 expectation — the headline re-entrancy
    fix would be verified only at the gate primitive, not at the wiring
    where the reported bug lives); no row for "COMMIT_GEN_TIMEOUT_MS
    exported"; no row for SPEC §10 edge "cancel mid-retry → silent return"
    (§4 covers only post-diff cancel). Add these rows to §4.
  - PLAN §5 verification omits `npm run compile`, which SPEC §12 lists as an
    acceptance criterion — esbuild bundling can fail where `tsc --noEmit`
    passes. Add it to §5 and the §6 acceptance list.
CONSISTENCY:
  - Same mismatch as above counted once: SPEC §12 requires `npm run compile`
    green; PLAN §5/§6 never run it. Otherwise SPEC and PLAN agree on frozen
    strings, signatures, thresholds, file ownership, and task ordering.
CLARITY:
  - none — frozen strings, signatures, thresholds (120s / 33ms / 100ms /
    12KB) and per-task file ownership are unambiguous.
SCOPE:
  - none — two disjoint items; GITMSG-001→002 serialization and W5-1 ∥ W5-2
    file split are explicit and correct; 18 AIX leftovers properly excluded.
YAGNI:
  - none — streaming commit-gen rejected with rationale (SPEC §14 Q3); the
    gate is a minimal primitive; no speculative abstraction.

NOTES: All gaps are additive fixes to §4/§5 — add the missing test rows and
the compile step; no re-planning needed. FR-008 aria invariants are already
pinned by existing tests (errorsScrollA11y.test.ts, composer.test.ts), so
the plan's silence there is acceptable.

### Round 1 — findings applied
- §4: added wiring row (command callback acquires gate / manifest unchanged), `COMMIT_GEN_TIMEOUT_MS` export row, and cancel-mid-retry edge row — closing the SPEC §11/§10 matrix gaps.
- §5: added `npm run compile` (esbuild bundle) after `npm run typecheck`.
- §6: acceptance line now requires `npm run compile` green per SPEC §12.
- Task files: GITMSG-001 gained the matching export-pin + mid-retry-cancel test rows; GITMSG-002's wiring source-scan row now names the manifest-guard expectation explicitly.

### Round 2 — 2026-09-21 · unic-smart
Status: Approved

COMPLETENESS:
  - none blocking — all three Round 1 gaps verified closed: §4 now carries
    the wiring row (command callback acquires gate / manifest unchanged),
    the COMMIT_GEN_TIMEOUT_MS export row, and the cancel-mid-retry edge
    row; §5 runs `npm run compile` and §6 requires it green.
CONSISTENCY:
  - none — SPEC §12 compile criterion now matches PLAN §5/§6; thresholds,
    frozen strings, file ownership, and task ordering still agree.
CLARITY:
  - none.
SCOPE:
  - none — disjoint file sets and GITMSG-001→002 serialization unchanged.
YAGNI:
  - none.

NOTES: Non-blocking residual: SPEC §11's provider case "linked signal
aborts in-flight fetch" is not a dedicated §4 row (only the pre-aborted
boundary is pinned) — task-file test plans remain authoritative there.
Plan is ready for P3 commit.
