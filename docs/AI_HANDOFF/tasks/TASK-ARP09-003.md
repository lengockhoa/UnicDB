# TASK-ARP09-003 — Lazy redacted Output Channel wiring

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (09.3) — wave 2

## Goal

Wire the lazy, redacted `VSDB` Output Channel into `src/extension.ts`: a module-level lazy `createOutputChannel("VSDB")` with a bounded pending-buffer, `vsdb.diagnostics.show` (reveal) and `vsdb.diagnostics.clear` commands (registered + contributed in package.json), lifecycle/connection/AI summary lines at the REAL existing seams, exactly-once dispose in `deactivate()` (ARP-02 sentinel byte-untouched), and mandatory privacy byte-scan pins proving no raw secret/SQL/connection config ever reaches the channel.

## Target Files

- `src/extension.ts` — (1) module state near `deactivating` (`94`)/singletons (`95-114`): `let diagOutputChannel: vscode.OutputChannel | null = null` + bounded `diagPendingLines` (max 100, drop-oldest) + `ensureDiagChannel()` (lazy create + flush) + `logDiagnostic()` (formats via 001's `logLine`; routing: if channel exists → appendLine; else if a REAL diagnostic write (any non-lifecycle line, or lifecycle `warn`/`error`) → `ensureDiagChannel()` creates the channel exactly once, flushes pending, then appends; else the activate-end lifecycle `info` line → buffer only; no-op after deactivate) + `getDiagChannel()` (flush + return for reveal). (2) Lifecycle line at `activate()` end (`1047-1054`) — buffered, does NOT create the channel; `deactivating` line at `deactivate()` start (`1056`). (3) Connection: one new subscription `mgr.onDidChangeActive((cfg) => logDiagnostic("connection","info", cfg ? "connection changed" : "connection closed"))` — NEVER the config; optionally `onDidChangeRecoveryStatus` (status text only). (4) AI lines at existing seams: `commandOpenAiChat` panel build (`1177-1230`) and/or the `vsdb.ai.exportTrace`/`vsdb.ai.clearTrace`/`vsdb.ai.showPolicy` handlers (`676-690`, `1468-1576`) — engine/command names only. (5) Register `vsdb.diagnostics.show`/`vsdb.diagnostics.clear`. (6) Deactivate: after `consolePanel` dispose (`1075-1076`), `diagOutputChannel?.dispose(); diagOutputChannel = null;` — exactly once, additive.
- `src/extension.test.ts` — extend the `vi.mock("vscode", ...)` mock (line 70) with `window.createOutputChannel` returning a recording fake `OutputChannel` (`appendLine`/`show`/`reveal`/`clear`/`dispose` call records); add the test cases below.
- `package.json` — contributes.commands: add `vsdb.diagnostics.show` ("VSDB: Show Diagnostics") and `vsdb.diagnostics.clear` ("VSDB: Clear Diagnostics"); activationEvents: add `onCommand:vsdb.diagnostics.show` and `onCommand:vsdb.diagnostics.clear`. Do NOT touch scripts (002 owns them in wave 1) or configuration (deliberately no verbosity setting).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 17 | happy | plain `activate()` (lifecycle line buffered, channel NOT created) then the first REAL diagnostic write — a `mgr.onDidChangeActive` event fires | `createOutputChannel` called exactly once, triggered BY the real write (create-on-first-real-write), not by plain activation; captured lines start with the flushed buffered `[lifecycle] [info] VSDB activated` line then a `[connection]` line | mock emits one active-change |
| 18 | happy | invoke `vsdb.diagnostics.show` | channel created lazily (if absent) and `show()`/`reveal()` called | no prior diagnostics |
| 19 | happy | invoke `vsdb.diagnostics.clear` | `clear()` called on the channel | channel exists |
| 20 | edge (lazy-create) | `activate()` with NO events/commands | `createOutputChannel` called ZERO times (strict pin) | empty activation |
| 21 | edge (privacy byte-scan) | connection event near a config with `password:"s3cr3t-p4ss"`; a bearer-shaped and an SQL fixture fragment are passed to the seam's vicinity | every captured channel line lacks `s3cr3t-p4ss`, `Bearer `, `Basic `, opaque long runs (≥24 chars), and the SQL fixture text; the connection handler received NO config object | captured appendLine history inspected |
| 22 | edge (exactly-once dispose) | `deactivate()` then a post-deactivate `logDiagnostic` | channel `dispose()` called exactly once; post-deactivate call → no create, no append | call records |
| 23 | regression | ARP-02 sentinel preserved | existing deactivate-sentinel tests (in-flight `runStatements` continuation after deactivate short-circuits panel writes) stay green; deactivate ordering additive only | unchanged existing tests |
| 24 | happy | invoke `vsdb.ai.exportTrace` (or `vsdb.ai.clearTrace` / open the AI panel) | a captured `[ai]`-category line appears | command invoked on mock |

## Test Files

- `src/extension.test.ts` — contains cases 17-24 (vscode mock extended; see RULES tests-map: `src/extension.ts` → this file is the owned target).

## Verification Commands

```bash
npm run typecheck
npm run compile                      # bundle gate — extension.ts + package.json changes
npx vitest run src/extension.test.ts
```

## Acceptance Criteria

- [ ] Channel is LAZY: zero `createOutputChannel` on plain activation (pin #20); created exactly once on the first real diagnostic write or command invocation (create-on-first-real-write, pin #17), never on the buffered lifecycle line alone.
- [ ] `vsdb.diagnostics.show` reveals and `vsdb.diagnostics.clear` clears; both registered and contributed in package.json.
- [ ] Lifecycle + connection + AI summary lines land at the real seams; the connection handler never receives the config; `logDiagnostic` no-ops after deactivate.
- [ ] Exactly-once channel dispose in `deactivate()`; ARP-02 sentinel (`deactivating`) byte-untouched; existing ARP-02 tests stay green.
- [ ] Byte-scan pins hold: no fixture password / `Bearer `/`Basic `/long-run / SQL text in any captured channel line.
- [ ] Known gap recorded in Discussion: one line per agent-run-completion is NOT wired this cycle (seam lives in `aiChatPanel.ts`, outside this task's roadmap file set); `logDiagnostic` is exported for a future cycle.
- [ ] `npm run typecheck`, `npm run compile`, and the focused vitest run exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP09-001 must complete first (003 imports `logLine` from `src/core/diagnostics.ts`; runs in wave 2). 002 is wave-1 only and disjoint except for the serialized `package.json` sections (002 = scripts, 003 = commands/activationEvents).

## Interfaces

- Consumes: `logLine`/`DiagCategory`/`DiagSeverity`/`MAX_DIAG_LINE_CHARS` from `src/core/diagnostics.ts` (001); `mgr.onDidChangeActive: vscode.Event<ConnectionConfig | null>` (connectionManager.ts:87) and `mgr.onDidChangeRecoveryStatus: vscode.Event<ConnectionRecoveryStatus>` (connectionManager.ts:91) — existing events; existing AI command registration sites (`extension.ts:676-690`).
- Produces: module-level `logDiagnostic(category, severity, message, correlationId?)` (host helper, lazy channel + pending flush, no-op after deactivate); commands `vsdb.diagnostics.show` / `vsdb.diagnostics.clear`; package.json command contributions + activationEvents. 004 (wave 2) greps these call sites to prove no unredacted write path exists.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
