# PLAN — ARP-09: Redacted support diagnostics and release-confidence profiles

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-09 (lines ~399-431; P2; deps ARP-02, ARP-05, ARP-06 — all shipped; preserve ARP-02 deactivate sentinel, ARP-06 AI policy, ARP-07 DDL-invalidation seam, ARP-08 draft wiring byte-untouched).
Base: `main @ c2baff7` (v1.44.0, released commit 93efafd). Executor: `unic-code`. Reviewer: `unic-smart`. No lint script — static gate is `npm run typecheck`; bundle gate `npm run compile`. Baseline: 3160 passed | 2 skipped. Release target: **v1.45.0** (minor bump, house-style CHANGELOG entry).

**Verified source facts (cited, not re-derived):**
- Zero `OutputChannel` usage today — `grep -rn "createOutputChannel" src/` returns nothing outside `__tests__`. The only vscode-mock in `src/extension.test.ts` is `vi.mock("vscode", ...)` at line 70 (no `createOutputChannel` member yet — executor must add it).
- `src/ai/trace.ts` exports pure `redact(value: unknown): unknown` at line 57 (recursive, never throws; `SECRET_KEY_RE`/`HEADER_RE`/`BEARER_RE`/`BASIC_RE`/`KV_RE`/`AUTH_KV_RE`/`LONG_RUN_RE` scrubbing). It is directly importable from `src/core/diagnostics.ts`. **It must be imported, never re-implemented or copied.**
- `src/ai/auditExport.ts` (`serializeAuditExport`) already ends in `JSON.stringify(redact(...))` as the final pass — 004 must prove it stays byte-intact, not change it.
- `package.json` scripts: `compile`, `watch`, `test`, `test:integration`, `typecheck`, `package`, `verify:fast`, `verify:release`, `vscode:prepublish`. No lint script.
- `src/__tests__/releaseVerify.test.ts` pins (MUST NOT be broken): `verify:release === "npm test && npm run typecheck && npm run compile"` (exact); `verify:fast` is exactly one of two allowed strings; `verify:fast`/`verify:release` have no shell-injection surface; `verify:*` values reference only pre-existing script keys; the four baseline scripts (`test`/`typecheck`/`compile`/`test:integration`) are preserved byte-identical; `scripts/verify-release.sh` exists, is executable, has a POSIX shebang, and emits ordered `PASS <stage>` / first-failure `FAIL <stage>` + `FAIL verify:release` with verbatim exit-code propagation. The shell-injection + reference-integrity checks iterate ONLY the two `verify:*` keys — new `profile:*` keys are NOT scanned, so 09.2 adds them freely while adding its own pins in `releaseHygiene.test.ts`.
- `src/__tests__/releaseHygiene.test.ts` currently has 3 tests (lock root version sync, README `vsdb-<version>.vsix` placeholder, package.json semver) — 09.2 appends the new profile pins to this file (roadmap-sanctioned).
- `src/core/connectionManager.ts`: `onDidChangeActive: vscode.Event<ConnectionConfig | null>` (line 87) and `onDidChangeRecoveryStatus: vscode.Event<ConnectionRecoveryStatus>` (line 91) are existing events extension.ts already subscribes to (`mgr.onDidChangeActive(...)` at `extension.ts:342,729`). Consuming them for a summary line is NOT new callback plumbing.
- `extension.ts` anchors: `deactivating` sentinel at line 94 (byte-untouched); `activate()` end ~`1047-1054` (lifecycle line goes into a pending buffer — see §3); `deactivate()` at `1056-1091` (channel dispose appended additively after `consolePanel` dispose ~`1075-1076`, before the function ends); AI command registrations `vsdb.ai.showPolicy`/`vsdb.ai.exportTrace`/`vsdb.ai.clearTrace` at `676-690`; `AiChatPanel` construction at `1228`; existing `mgr.onDidChangeActive` handler at `342`.
- Tests-map (`.cache/index/tests-map.json`): `src/extension.ts` → `[extension.test.ts, extensionAutocomplete.test.ts, extensionConfigExport.test.ts, mcpExtensionRegistry.test.ts]`; `src/ai/trace.ts` → `[trace.test.ts]`; `src/ai/auditExport.ts` → `[auditExport.test.ts]`. `src/core/diagnostics.ts`, `package.json`, `scripts/verify-release.sh` are unmapped → new-file/script-target convention (releaseHygiene + releaseVerify).

## §1 Intent

**Problem.** AI trace/audit redaction already exists (`src/ai/trace.ts` `redact()`; `src/ai/auditExport.ts` final-pass), but VSDB has **no extension-wide Output Channel** (verified: zero `createOutputChannel` in `src/`). When a user hits a support issue there is no local, discoverable, redacted diagnostics surface to share — and `package.json` exposes full/integration suites but no named fast/release confidence profile users or CI can point at by name.

**Success.** (1) A lazy `vscode.window.createOutputChannel("VSDB")` records redacted, single-line lifecycle/connection/AI summaries; the channel is created exactly once, on the first REAL diagnostic write (create-on-first-real-write) or command invocation — never at plain activation, and never for the buffered activate-end lifecycle line alone. (2) `vsdb.diagnostics.show` reveals it and `vsdb.diagnostics.clear` clears it. (3) Every line goes through `trace.ts` `redact()` — no raw SQL, connection strings, passwords, prompts, or tokens can reach the channel (byte-scan-pinned). (4) New named scripts `profile:fast` and `profile:release` exist, reference ONLY real pre-existing commands, and leave every pinned baseline/verify script byte-identical. (5) No new runner script is needed — `scripts/verify-release.sh` already provides the portable staged runner and is pinned by `releaseVerify.test.ts`; `profile:release` names a portable gate (`npm run verify:release`). (6) Redaction is reused, not re-implemented — evidence-pinned by 004 (expected close NOT-NEEDED).

## §2 Scope

**In**
- ARP-09.1 (wave 1) — pure redacted formatter in `src/core/diagnostics.ts` (NEW, no vscode import) + `src/core/__tests__/diagnostics.test.ts` (NEW): `logLine(category, severity, message, correlationId?, now?)` producing `[<ISO time>] [<category>] [<severity>] <redacted single-line message>` (+ ` (corr:<id>)`); reuses `redact()` from `src/ai/trace.ts` (the one sanctioned import); never throws on any input; single-line invariant; 2000-char bound applied to the ASSEMBLED line (after prefix + corr-suffix assembly, as the last step); categories `lifecycle|connection|ai|schema|general`, severities `info|warn|error`.
- ARP-09.2 (wave 1) — profile design in `package.json` (scripts section ONLY) + `src/__tests__/releaseHygiene.test.ts`: NEW keys `profile:fast = "npm run typecheck && npm run compile"` and `profile:release = "npm run verify:release"`; new pins that these keys reference only real artifacts, have no shell-injection surface, and that all pinned baseline/verify scripts stay byte-identical. Cross-file constraint: `releaseVerify.test.ts` is NOT modified but MUST stay green.
- ARP-09.3 (wave 2) — channel wiring in `src/extension.ts` + `src/extension.test.ts` + `package.json` (contributes.commands + activationEvents sections ONLY, serialized after 002's wave-1 scripts edit): lazy `createOutputChannel("VSDB")` with a bounded pending-buffer flush; commands `vsdb.diagnostics.show` / `vsdb.diagnostics.clear`; exactly-once dispose in `deactivate()`; lifecycle + connection (`mgr.onDidChangeActive`, optionally `onDidChangeRecoveryStatus`) + AI (existing extension.ts command/panel seams) summary lines; privacy byte-scan pins.
- ARP-09.4 (wave 2, verify-first) — redaction-reuse gate: prove by source evidence that 001 imports and uses `trace.ts` `redact()` (no copy), that `auditExport.ts` final-pass is byte-intact, and that the channel wiring never emits pre-redaction content. Expected close: NOT-NEEDED (no trace/audit source change). Owns `src/ai/__tests__/trace.test.ts` (read-only evidence append) + a docs note.
- ARP-09.5 (wave 3, conditional) — runner gate: expected NOT-NEEDED. `scripts/verify-release.sh` already exists (POSIX, staged PASS/FAIL, exit-code propagation, pinned by `releaseVerify.test.ts`), and `profile:release` now names a portable gate. If the executor finds a real gap (e.g. Windows `.cmd` wrapper genuinely required), design it then — conditional only.

**Out**
- Telemetry / upload / persistence of diagnostics to disk.
- Raw SQL, SQL results, prompts, tool args, connection strings, host/user/port, passwords, tokens — in channel lines or captured content.
- Changing any assertion to make a test pass; mandatory integration (`test:integration`) per edit.
- New dependencies; changes to `scripts/verify-release.sh`; changes to `verify:*` or the four baseline scripts; a `vsdb.diagnostics.verbosity` configuration setting (rejected — YAGNI, see §3).
- Any source change to `src/ai/trace.ts` / `src/ai/auditExport.ts` (004) or to `src/ui/aiChatPanel.ts` (per-run AI summary seam — outside 003's roadmap file set, documented as a known gap).

**File disjointness.** Wave 1: 001 owns `src/core/diagnostics.ts` + `src/core/__tests__/diagnostics.test.ts`; 002 owns `package.json` (scripts only) + `src/__tests__/releaseHygiene.test.ts`. Disjoint. Wave 2: 003 owns `src/extension.ts` + `src/extension.test.ts` + `package.json` (commands + activationEvents); 004 owns `src/ai/__tests__/trace.test.ts` (evidence append) + docs note. Disjoint. `package.json` is edited in BOTH 001's wave-1 sibling 002 (scripts) and wave-2 003 (commands/activationEvents) — this is legal because the edits are serialized across waves (002 lands first, 003 is wave 2) and each task touches a different section. Documented explicitly so reviewers do not flag a false same-file collision.

## §3 Approach

**09.1 — pure formatter (`src/core/diagnostics.ts`, NEW).** No `vscode` import (unit-testable in plain vitest). API (the Interfaces contract later tasks consume):
```ts
export type DiagCategory = "lifecycle" | "connection" | "ai" | "schema" | "general";
export type DiagSeverity = "info" | "warn" | "error";
export const MAX_DIAG_LINE_CHARS = 2000;
export function logLine(
  category: DiagCategory,
  severity: DiagSeverity,
  message: unknown,
  correlationId?: string,
  now?: Date,                       // test seam — defaults to new Date()
): string;
```
Pipeline (never throws): (1) coerce `message` to a string — strings pass through; otherwise `JSON.stringify` in try/catch, falling back to `String(value)`, then to `"[unserializable]"`. (2) run `redact(coerced)` (the sole sanctioned import from `../ai/trace`). (3) enforce the single-line invariant — replace every `\r\n`/`\r`/`\n` run with a single space. (4) `trim()`. (5) assemble `[<ISO from now|new Date()>] [<category>] [<severity>] <message>` and, when `correlationId` is a non-empty string, append ` (corr:<id>)` with the id itself single-lined, trimmed, and sliced to 64 chars. (6) THEN, as the LAST step, bound the **assembled line** to `MAX_DIAG_LINE_CHARS` (2000) — the bound applies to the final line (prefix + message + corr suffix), never to the raw message before assembly, so a long message plus the ~40-char prefix still yields a total `line.length <= 2000` (the message tail is what gets cut, not the prefix). RED-first proof: a message containing `Authorization: Bearer …`, `password = '…'`, `apiKey=…`, or a ≥24-char opaque run is scrubbed by `redact()` before it is formatted; category/severity/correlation remain useful.

**Opt-in verbosity decision (rejection documented).** A `vsdb.diagnostics.verbosity` configuration setting is REJECTED (YAGNI): roadmap lists "opt-in verbosity", which the reveal/clear commands already satisfy — the user opts in by revealing, and a channel that nothing meaningful ever created is never created at all. Severity set is `info|warn|error`; a `debug` severity is deliberately NOT added (no per-severity threshold exists this cycle). `package.json` configuration contributions therefore remain untouched — this also removes any configuration-section conflict between 002 (scripts) and 003 (commands). A future cycle can add a pure `shouldLog(severity, minSeverity)` predicate and a setting without changing the formatter contract.

**09.2 — profile design (`package.json` + `releaseHygiene.test.ts`).** Add exactly two NEW script keys (the roadmap's real gap is "no named profile keys at all"):
- `"profile:fast": "npm run typecheck && npm run compile"` — the fast confidence profile (typecheck + bundle, no test loop; satisfies "no mandatory integration per edit").
- `"profile:release": "npm run verify:release"` — names the existing pinned release gate. Chosen over `bash scripts/verify-release.sh` for portability: npm executes scripts through the platform shell, where `bash` may be absent on Windows non-Git-Bash installs; `npm run verify:release` is a portable, deterministic, ordered (`test → typecheck → compile`) chain whose `&&` propagates the first non-zero exit. The staged PASS/FAIL runner still exists and stays independently pinned by `releaseVerify.test.ts`.
**`profile:fast` being byte-identical in effect to the existing `verify:fast` (`npm run typecheck && npm run compile`) is INTENDED, not a bug** — the roadmap gap is the absence of NAMED profile keys, and the deliverable is the nameable key itself, not a third implementation. `profile:*` and `verify:*` are two namespaces over the same stage sets (fast, release) and are deliberately kept in lockstep so the named-profile surface never diverges from the pinned verify gate. The `verify:release` string and the four baseline scripts are pinned byte-identical by `releaseVerify.test.ts` — they CANNOT change. The releaseVerify reference-integrity/shell-injection checks scan only `verify:*`, so the new `profile:*` keys are unconstrained there; 09.2 instead appends its own pins to `releaseHygiene.test.ts`: (a) `profile:fast`/`profile:release` exist with the exact values above; (b) every `npm run <key>` fragment of `profile:*` resolves to a real package.json script key; (c) `profile:*` values contain no shell-injection surface (`\``, `$(`, `;`, `|`, `>`, `<`); (d) regression: the four baseline scripts + `verify:fast` + `verify:release` stay byte-identical; (e) `releaseVerify.test.ts` (unchanged) still passes.

**09.3 — channel wiring (`extension.ts` + `extension.test.ts` + `package.json`).** Module state near the other singletons (`extension.ts:94-114`): `let diagOutputChannel: vscode.OutputChannel | null = null` and `const diagPendingLines: string[] = []` (bounded, max 100, drop-oldest). Helper `ensureDiagChannel()` creates `vscode.window.createOutputChannel("VSDB")` on first real need and flushes pending lines via `appendLine`. `logDiagnostic(category, severity, message, correlationId?)` formats via 001's `logLine` and routes as follows: if a channel already exists → `appendLine` directly; else if the line is a **REAL diagnostic write** (any non-lifecycle line — connection/AI/general — or a lifecycle `warn`/`error`) → `ensureDiagChannel()` creates the channel **exactly once**, flushes the pending buffer into it via `appendLine`, then appends the current line; else (the activate-end lifecycle `info` line only) → push to the pending buffer, so that line is logged eagerly WITHOUT creating the channel (the strict lazy-create pin: plain activate with zero real diagnostics → zero `createOutputChannel` calls). `getDiagChannel()` (for the reveal command) also flushes pending. After `deactivate()` sets `deactivating = true` and disposes the channel, `logDiagnostic` no-ops (never re-creates). No raw values ever reach `logLine` at the call sites: the connection handler logs a fixed summary string and NEVER passes the `ConnectionConfig`; AI seams log engine/command names only.
- Lifecycle: at `activate()` end (~`1047-1054`) `logDiagnostic("lifecycle","info","VSDB activated")` — lands in pending, does NOT create the channel; at `deactivate()` start (`1056`) `logDiagnostic("lifecycle","info","deactivating")`.
- Connection: add one subscription `mgr.onDidChangeActive((cfg) => logDiagnostic("connection","info", cfg ? "connection changed" : "connection closed"))` — never the config itself. Optionally one `onDidChangeRecoveryStatus` line (status text only). These consume EXISTING events (connectionManager.ts:87,91) — not new plumbing.
- AI: one line at the existing extension.ts seams — `commandOpenAiChat` panel build (`extension.ts:1177-1230`), and the `vsdb.ai.exportTrace`/`vsdb.ai.clearTrace`/`vsdb.ai.showPolicy` handlers (`676-690`, `1468-1576`). **Known gap (documented):** one line *per agent run completion* is NOT wired this cycle — that seam lives inside `aiChatPanel.ts` (where `runAgent` resolves `AgentRunResult`), which is outside 003's roadmap file set and would require new callback plumbing (explicitly out). `logDiagnostic` is exported module-level so a future cycle can hook the panel.
- Commands: register `vsdb.diagnostics.show` (→ `getDiagChannel().show()` + reveal) and `vsdb.diagnostics.clear` (→ `getDiagChannel().clear()`); add both to `package.json` `contributes.commands` and to `activationEvents` (VS Code also auto-activates contributed commands, but the repo explicitly lists every command — keep convention).
- Deactivate: after the existing `consolePanel` dispose (~`1075-1076`) and before the function ends (`1091`): `diagOutputChannel?.dispose(); diagOutputChannel = null;` — exactly once, additive, ARP-02 sentinel (`deactivating` line 94) byte-untouched. A subsequent `logDiagnostic` no-ops.
- Privacy pins (mandatory, byte-scan): with the mocked `OutputChannel` capturing every `appendLine`, the tests assert no captured line contains `s3cr3t-*` fixture passwords, `Bearer `, `Basic `, opaque long runs (from redact fixtures), or raw SQL fragment text; and the connection-handler pin proves the handler never receives the config. `extension.test.ts` `vi.mock("vscode", ...)` (line 70) must gain a `createOutputChannel` + `OutputChannel` (appendLine/reveal/clear/dispose) mock that records calls.

**09.4 — redaction-reuse gate (verify-first).** Expected close: NOT-NEEDED (mirrors ARP-04-004 / ARP-05-004 precedent). Evidence checks (appended to `src/ai/__tests__/trace.test.ts` as a new read-only describe, or a docs note if a source assertion is impractical): 001 imports `redact` from `../ai/trace` and calls it; 001 defines no copy of a secret scrubber (source scan: no `Bearer\s+` / no new `RegExp(` secret pattern in `diagnostics.ts`); the audit exporter final-pass is intact (`git diff src/ai/auditExport.ts` empty; `serializeAuditExport` still ends `JSON.stringify(redact(...))`); and 003's channel writes go only through `logDiagnostic` → `logLine` (no direct `appendLine` of unredacted content — cross-check 003's byte-scan pins). If evidence surfaces a real bypass, fix it within the same file set (003's extension.ts or a one-line seam) — do not change `trace.ts`.

**09.5 — runner gate (conditional).** Expected close: NOT-NEEDED. Evidence: `scripts/verify-release.sh` exists, is executable, POSIX shebang, and its staged PASS/FAIL + exit-code propagation are pinned by `releaseVerify.test.ts` (no change); `profile:release` names a portable ordered release gate. If a genuine gap appears (the only plausible one is a Windows `.cmd` wrapper, made moot because `profile:release` uses `npm run` with no `bash` dependency), design it as a new file owned by 005.

**Rejected alternatives.** (1) Eager channel at activate — rejected: violates the roadmap's "lazy" and the lazy-create pin. (2) Per-run AI completion via new `onRunComplete` callback on `AgentDeps`/`AcpPanelDeps` — rejected: new callback plumbing is explicitly out and would widen 003's file set into `aiChatPanel.ts`. (3) `vsdb.diagnostics.verbosity` setting + `debug` severity — rejected: YAGNI (see above). (4) `profile:release = "bash scripts/verify-release.sh"` — rejected for Windows portability; `npm run verify:release` is portable, ordered, deterministic, and non-zero-propagating. (5) A new runner script — rejected: `verify-release.sh` already exists and is pinned; 005 closes NOT-NEEDED.

## §4 Test Plan

Every row below lands in exactly one task's `§Test Cases`. Edge cases are of genuinely different kinds (secret/redaction, multiline, length-boundary, non-string coercion, degenerate/circular, reference-integrity, shell-injection, lazy-create, privacy byte-scan, exactly-once dispose, regression, source-shape evidence, portability) — not near-duplicates.

| # | Task | Type | Test name | Expected |
|---|------|------|-----------|----------|
| 1 | 001 | happy | `logLine("connection","info","connection opened", undefined, FIXED)` | exact string `[2026-09-02T00:00:00.000Z] [connection] [info] connection opened` |
| 2 | 001 | happy | `logLine("ai","warn","retry", "run-42", FIXED)` | ends with ` (corr:run-42)`; prefix `[2026-09-02T00:00:00.000Z] [ai] [warn]` |
| 3 | 001 | edge (secret) | `logLine("ai","error", 'provider failed: Authorization: Bearer eyJhbGciOiJFUzI1NiIs…', undefined, FIXED)` | output contains `<redacted>`, does NOT contain the bearer token substring |
| 4 | 001 | edge (KV-in-SQL) | `logLine("general","warn","SELECT * FROM users WHERE password = 'hunter2'")` | output does NOT contain `hunter2`; contains `password<redacted>` (KV_RE via redact) |
| 5 | 001 | edge (multiline) | message with `\n`, `\r\n`, `\r` | output contains zero `\n`/`\r`, is exactly one line, `trim()`-equal to itself |
| 6 | 001 | edge (length bound) | 5000-char message | assembled line `length <= 2000` (bound applied AFTER prefix + corr-suffix assembly, as the last step); prefix `[` … `]` intact; the MESSAGE tail is what gets cut |
| 7 | 001 | edge (non-string) | `logLine("general","info",{a:1})` / `null` / `undefined` | contains `{"a":1}` / `null` / `undefined`; never throws |
| 8 | 001 | edge (degenerate) | circular `const c:any={}; c.self=c` | returns a string, never throws, contains `"[object Object]"` (JSON.stringify falls back) |
| 9 | 001 | happy | every category × severity accepted | `logLine` accepts all 5 categories × 3 severities and emits the right `[<cat>] [<sev>]` tokens |
| 10 | 002 | happy | `profile:fast` exists | equals exactly `"npm run typecheck && npm run compile"` |
| 11 | 002 | happy | `profile:release` exists | equals exactly `"npm run verify:release"` |
| 12 | 002 | edge (reference integrity) | every `npm run <key>` fragment of `profile:*` | resolves to a real package.json script key |
| 13 | 002 | edge (shell-injection) | `profile:*` values | contain no `` ` ``, `$(`, `;`, `|`, `>`, `<` |
| 14 | 002 | regression | baseline + verify pins | four baseline scripts AND `verify:fast`/`verify:release` byte-identical; `releaseVerify.test.ts` (unchanged) still passes |
| 15 | 002 | edge (config untouched) | package.json `contributes.configuration` | contains NO `vsdb.diagnostics.verbosity` key (documents the YAGNI rejection) |
| 16 | 002 | regression | `releaseVerify.test.ts` stays green | run it unchanged — its `verify:*` + baseline + runner pins all pass (cross-file constraint; file NOT modified) |
| 17 | 003 | happy | plain `activate()` (lifecycle line buffered, channel NOT created) then the first REAL diagnostic write — a `mgr.onDidChangeActive` event fires | `createOutputChannel` called exactly once, triggered BY the real write (create-on-first-real-write), not by plain activation; captured lines start with the flushed buffered `[lifecycle] [info] VSDB activated` line then a `[connection]` summary |
| 18 | 003 | happy | `vsdb.diagnostics.show` command | channel created lazily (if absent) and `show()`/`reveal()` called |
| 19 | 003 | happy | `vsdb.diagnostics.clear` command | `clear()` called on the channel |
| 20 | 003 | edge (lazy-create) | `activate()` with NO events/commands | `createOutputChannel` called ZERO times (strict pin) |
| 21 | 003 | edge (privacy byte-scan) | connection event near a config with `password:"s3cr3t-p4ss"` + SQL fixture + bearer-shaped fixture | every captured channel line lacks `s3cr3t-p4ss`, `Bearer `, `Basic `, opaque long runs, and the SQL fixture text |
| 22 | 003 | edge (exactly-once dispose) | `deactivate()` then a post-deactivate `logDiagnostic` | channel `dispose()` called exactly once; post-deactivate call → no create, no append |
| 23 | 003 | regression | ARP-02 sentinel | existing deactivate-sentinel tests (in-flight `runStatements` continuation after deactivate short-circuits panel writes) stay green; deactivate ordering additive only |
| 24 | 003 | happy | `vsdb.ai.exportTrace` (or `vsdb.ai.clearTrace` / panel open) | a captured `[ai]`-category line appears |
| 25 | 004 | happy (source evidence) | `src/core/diagnostics.ts` imports `redact` from `../ai/trace` (or `../../ai/trace`) and calls it | import present; ≥1 `redact(` call in `logLine`'s path |
| 26 | 004 | edge (no re-implementation) | source scan of `diagnostics.ts` | NO new copy of a secret scrubber: no `Bearer\s+` / `Basic\s+` regex literal and no `new RegExp(` secret pattern in the file |
| 27 | 004 | edge (applied, not imported-only) | run 001's secret test cases (rows 3-4) | scrubbed output — proves the `redact` import is actually used |
| 28 | 004 | edge (auditExport intact) | `git diff src/ai/auditExport.ts` | empty; `serializeAuditExport` still returns `JSON.stringify(redact(buildAuditEnvelope(...)))` |
| 29 | 004 | edge (no bypass in wiring) | grep channel-write sites in `src/extension.ts` | every `appendLine` argument is logLine-formatted (REDACTED) — redaction reused, NO raw unformatted writes of user/provider/connection content; an `appendLine(<raw>)` anywhere is a FAIL (direct matches at the flush site are expected by design and must be redacted logLine output) |
| 30 | 005 | happy | `scripts/verify-release.sh` | exists, executable, POSIX shebang, ordered `PASS` stages (already pinned — re-run `releaseVerify.test.ts`) |
| 31 | 005 | happy | `profile:release` references a real gate | equals `npm run verify:release` → chain `test → typecheck → compile` ordered, `&&` propagates first non-zero |
| 32 | 005 | edge (portable) | no `bash` dependency in npm scripts | `profile:*` + `verify:*` contain no `bash`/`sh` invocation; runs on Windows/macOS/Linux npm unchanged |
| 33 | 005 | edge (non-zero propagation) | `releaseVerify.test.ts` FAIL-stage case | first non-zero stage aborts, later stages do NOT run, exit code propagated verbatim (runner untouched) |

## §5 Verification

Worktree note: fresh worktrees need `npm run compile` before vitest only for bundle tests (dist/ required); this cycle's focused suites are source-level except 003's extension suite, but `npm run compile` is still the mandatory bundle gate for the `extension.ts`/`package.json` changes. Symlink `node_modules` in fresh worktrees.

Per-task exact commands (every task MUST also run the static gate — there is no lint script):

```bash
# Static gate (all tasks)
npm run typecheck

# TASK-ARP09-001
npx vitest run src/core/__tests__/diagnostics.test.ts

# TASK-ARP09-002  (releaseHygiene gets the new pins; releaseVerify MUST stay green)
npx vitest run src/__tests__/releaseHygiene.test.ts src/__tests__/releaseVerify.test.ts

# TASK-ARP09-003  (bundle gate first, then focused extension suite)
npm run compile
npx vitest run src/extension.test.ts

# TASK-ARP09-004  (evidence-gate: re-run 001 + trace suites, source greps)
npx vitest run src/ai/__tests__/trace.test.ts src/core/__tests__/diagnostics.test.ts
git diff --stat src/ai/auditExport.ts src/ai/trace.ts        # expect: empty (or whitespace-only)

# TASK-ARP09-005  (runner gate)
npx vitest run src/__tests__/releaseVerify.test.ts
node -e 'const p=require("./package.json"); if(p.scripts["profile:fast"]!=="npm run typecheck && npm run compile")process.exit(1); if(p.scripts["profile:release"]!=="npm run verify:release")process.exit(1); console.log("profiles ok")'
```

Release gate (used at v1.45.0 close, not per-edit): `npm run verify:release` — full `npm test && npm run typecheck && npm run compile` (3160 passed | 2 skipped baseline).

## §6 Acceptance

- [ ] `src/core/diagnostics.ts` exists (NEW), pure (no vscode import), and every `logLine` output is one redacted single line: `[ISO] [category] [severity] message` (+ ` (corr:id)`), length ≤ 2000, never throws. → TASK-ARP09-001
- [ ] All 5 categories and 3 severities are emitted correctly; secret/KV/multiline/length/non-string/degenerate inputs are pinned (§4 rows 1-9). → TASK-ARP09-001
- [ ] `package.json` gains exactly `profile:fast` and `profile:release`; baseline + `verify:*` scripts byte-identical; new releaseHygiene pins pass; releaseVerify pins (unchanged file) pass. → TASK-ARP09-002
- [ ] Channel is lazy (zero `createOutputChannel` on plain activate), reveals/clears via two commands, disposes exactly once in `deactivate()`, and the ARP-02 sentinel is byte-untouched (deactivate additive only). → TASK-ARP09-003
- [ ] Lifecycle, connection, and AI summary lines appear at the real seams; per-run AI completion gap documented in PLAN §3/003 Discussion. → TASK-ARP09-003
- [ ] Byte-scan pins hold: no captured channel line contains a fixture password, `Bearer `/`Basic `, opaque long run, or raw SQL fragment; connection handler never receives the config. → TASK-ARP09-003
- [ ] 004 closes NOT-NEEDED (or fixes a found bypass within its file set) with source evidence that `redact` is imported-and-used, not copied; `auditExport.ts`/`trace.ts` unchanged (`git diff` empty). → TASK-ARP09-004
- [ ] 005 closes NOT-NEEDED with evidence that the existing runner + `profile:release` cover the roadmap's runner requirement; no new script. → TASK-ARP09-005
- [ ] `npm run typecheck` and `npm run compile` exit 0; focused suites green; no unrelated changes; CHANGELOG v1.45.0 entry written; version bumped 1.44.0 → 1.45.0 at release. → whole cycle

## §7 Global Constraints

- Node v22 / `npm`; VS Code `^1.75.0` + TypeScript 5.4 compat; NO new dependencies (package.json `dependencies`/`devDependencies` untouched).
- No lint script — every task MUST run `npm run typecheck`; 003 MUST also run `npm run compile` (bundle gate for extension.ts/package.json changes).
- The channel NEVER records credential/auth/raw SQL/raw prompts/tool args/connection config — mandatory byte-scan pins in 003 (§4 row 21) and 004 (§4 row 29).
- ARP-02 deactivate sentinel (`deactivating` at `extension.ts:94`) and the existing deactivate disposal ordering remain behavior-identical — 003 is additive only.
- `verify:release` (exact pinned string) and the four baseline scripts (`test`/`typecheck`/`compile`/`test:integration`) are pinned by `releaseVerify.test.ts` — MUST NOT change. New named profiles are NEW keys only (`profile:*`).
- `profile:fast` being byte-identical in effect to `verify:fast` is INTENDED — the deliverable is the NAMED profile key itself (roadmap "named profiles"), not a third implementation; `profile:*` is a naming namespace over the same stage sets as `verify:*`, deliberately kept in lockstep so the two never diverge.
- `trace.ts` `redact()` must be IMPORTED and reused, never re-implemented or copied; `trace.ts`/`auditExport.ts` source must not change this cycle (004 verify-only).
- Wave disjointness mandatory: no task modifies a file another same-wave task owns; `package.json` is serialized across waves (002 = wave-1 scripts, 003 = wave-2 commands/activationEvents).

## Planner Report
PLAN_REVIEW: Approved by unic-smart (round 2, after one revision round)
PLANNER_MODEL: unic-smart

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit: (1) Verified zero `createOutputChannel` in `src/` and that `extension.test.ts`'s vscode mock (line 70) needs a `createOutputChannel`/`OutputChannel` member — recorded as an executor step, not assumed. (2) Resolved the lazy-create vs. "lifecycle line at activate end" tension with a bounded pending-buffer design so the activate line is logged eagerly WITHOUT creating the channel — the strict pin holds and the reveal command still shows the buffered history. (3) Read `releaseVerify.test.ts` in full and confirmed its shell-injection/reference-integrity checks iterate ONLY `verify:fast`/`verify:release`, so `profile:*` keys are free to add — and pinned the new keys in `releaseHygiene.test.ts` instead. (4) Chose `profile:release = "npm run verify:release"` over `bash scripts/verify-release.sh` for Windows portability and recorded the rejection. (5) Verified `mgr.onDidChangeActive`/`onDidChangeRecoveryStatus` are real existing events extension.ts already subscribes to (connectionManager.ts:87,91; extension.ts:342,729) — the connection summary consumes existing seams, not new plumbing. (6) Confirmed the per-run AI completion seam lives in `aiChatPanel.ts` (outside 003's roadmap file set) and recorded it as a documented known gap rather than silently widening scope. (7) Added cross-file constraint rows so 002 owns releaseHygiene pins but releaseVerify stays green, and package.json is serialized across waves.
Known gaps: (1) One line per agent run completion is NOT wired — the seam is in `aiChatPanel.ts`, outside 003's roadmap file set; `logDiagnostic` is exported module-level for a future cycle to hook. 003's AI lines cover panel-open, trace export/clear, and policy show at real extension.ts seams. (2) If nothing meaningful ever happens, no channel is created and pending lines are dropped at deactivate — acceptable: nothing meaningful to show; the reveal command flushes buffered history when the user asks. (3) Manual support-flow acceptance (open channel, reproduce, copy lines) is release-time and cannot be automated here.

## Plan Review Log

### Round 1 — 2026-09-02 · unic-smart
Status: Issues Found

COMPLETENESS:
  - none — no TODOs/placeholders; §4 rows 1-32 cover all five tasks with genuinely distinct edge cases; §5 commands runnable (typecheck/vitest/compile all exist); §6 acceptance checkable; privacy byte-scan pins present (task 003 #20).
CONSISTENCY:
  - important — PLAN §3 `logDiagnostic` bullet ("if a channel exists → appendLine; else → push to the pending buffer") omits the create-on-first-real-write path, contradicting §1 success (1) ("created only on first real diagnostic write or command invocation") and task 003 test #16 (a `mgr.onDidChangeActive` event must call `createOutputChannel` exactly once). Fix: state that logDiagnostic/ensureDiagChannel creates the channel once on the first non-lifecycle "real" write and flushes pending; only the activate-end lifecycle line is pure-buffer.
  - minor — test-numbering drift: task 002 ships 7 tests (#10-16) but PLAN §4 lists only rows 10-15 for 002; its extra #16 ("releaseVerify stays green") collides with PLAN row 16, which belongs to 003. Substance is required in §3(09.2e)/§5, so documentation-only. Fix: add the releaseVerify-green row to the §4 table for 002 (or renumber 003-005 rows).
CLARITY:
  - important — length-bound semantics contradictory. §3 pipeline step (5) bounds the MESSAGE to MAX_DIAG_LINE_CHARS (2000) BEFORE assembly (step 6), but task 001 test #6 and §6 acceptance require the FINAL line `length <= 2000`. A 2000-char message + ~44-char `[ISO] [cat] [sev] ` prefix exceeds 2000; test #6's own wording ("tail cut at the bound" + `line.length <= 2000`) is internally inconsistent. Fix: pin the bound to the assembled line (truncate total to 2000), or bound the message to 2000 minus prefix length, and align the test wording.
  - minor — task 004 #28 ("no direct appendLine(<raw>)") can be misread as "no appendLine anywhere", which would contradict 003's ensureDiagChannel flush (it MUST appendLine already-redacted logLine output; task 004's own `grep -n appendLine src/extension.ts` returns matches by design). Fix: reword to "every appendLine argument is a logLine-formatted (redacted) string".
SCOPE:
  - none — target files per task match plan scope; waves 1/2/3 disjoint (001/002 parallel; 003/004 parallel; 005); package.json serialized 002 w1 (scripts) → 003 w2 (commands+activationEvents), different sections; 004's soft dependency on 003's wiring for #28 is explicitly gated in its Dependencies. Verified against HEAD @ c2baff7: zero createOutputChannel in src/ outside __tests__; trace.ts:57 redact(); auditExport.ts:101 final-pass; releaseVerify.test.ts scans ONLY verify:* (lines 157/193) so profile:* keys are unconstrained there; releaseHygiene has exactly 3 tests; deactivating sentinel extension.ts:94; connectionManager.ts:87/91 events; verify-release.sh executable POSIX. The plan's key design claim (profile:* not scanned by releaseVerify) HOLDS.
YAGNI:
  - minor — `profile:fast` is byte-identical to the existing `verify:fast` ("npm run typecheck && npm run compile"). Defensible as a named profile namespace (roadmap gap is "no named profile keys"), but confirm profiles are not intended to diverge from verify:* semantics.
  - (checked, no issue) verbosity-setting rejection is documented (§3 opt-in decision), pinned (002 #15), and conditional closes 004/005 carry concrete "if a real gap" conditions; out-set (telemetry/upload, raw SQL/prompts/tokens, assertion-changing, mandatory integration per edit) is explicit.

NOTES: Plan is executable — all cited source facts verified against HEAD @ c2baff7. Two important clarity/consistency defects (logDiagnostic create-path; length-bound semantics) are TDD-recoverable but should be pinned before execution so 003/001 implement the intended behavior on the first pass.

### Round 1 — planner revision
- 1 (IMPORTANT, logDiagnostic create-path): PLAN §3 09.3 now states **create-on-first-real-write** — if a channel exists → `appendLine`; else if the line is a REAL diagnostic write (any non-lifecycle line, or lifecycle `warn`/`error`) → `ensureDiagChannel()` creates the channel exactly once, flushes the pending buffer, then appends; only the activate-end lifecycle `info` line is pure-buffer. §1 success (1) aligned ("created exactly once, on the first REAL diagnostic write ... or command invocation"); 003 test #16 → #17 reworded to pin "exactly once, triggered BY the real write, not by plain activation"; 003 Target Files `logDiagnostic()` description updated to the same routing.
- 2 (IMPORTANT, length-bound semantics): bound changed from "message bounded to 2000 before assembly" to "the ASSEMBLED final LINE is bounded to 2000 chars" — §3 pipeline reordered so assembly (prefix + message + corr suffix) precedes the bound, applied as the LAST step; §2 09.1 wording, §4 row 6, and 001 test #6 / Interfaces line-shape updated to "assembled line ≤ 2000; the MESSAGE tail is what gets cut".
- 3 (MINOR, numbering drift): §4 gained 002's missing `releaseVerify stays green` row as new row 16; 003-005 rows renumbered 17-33 (was 16-32); §7 byte-scan row references updated (rows 20,28 → 21,29); 003/004/005 task test numbers renumbered to match (§4 rows ↔ task numbers now correspond).
- 4 (MINOR, 004 no-bypass wording): 004 test #28 → #29 (and §4 row 29) reworded to "every `appendLine` argument is logLine-formatted (REDACTED) — redaction reused, no raw unformatted writes; an `appendLine(<raw>)` anywhere is a FAIL; direct matches at the flush site are expected by design"; 004 Goal (d) clarified accordingly.
- 5 (MINOR, profile:fast = verify:fast): §3 09.2 and §7 now state explicitly that `profile:fast` being byte-identical in effect to `verify:fast` is INTENDED — the deliverable is the named profile key itself (roadmap "named profiles"), a naming namespace over the same stage sets, deliberately kept in lockstep; no third implementation. 002 Goal carries the same one-line note.

### Round 2 — 2026-09-02 · unic-smart
Status: Approved

COMPLETENESS:
  - none — §4 rows 1-33 map 1:1 to task test numbers #1-33 (001=1-9, 002=10-16, 003=17-24, 004=25-29, 005=30-33); no gaps, orphans, or leftover references to the old 1-32 scheme outside this log.
CONSISTENCY:
  - none — R1 finding 1 (create-path) resolved consistently: §1 success (1), §2 09.3, §3 09.3 routing, §4 row 17, and 003 Goal/Test #17/Target Files all state create-on-first-real-write, buffered-activate-lifecycle-only, exactly-once dispose; no stale "else → buffer" wording remains.
  - none — R1 finding 3 (numbering) resolved: 002's releaseVerify-green row is §4 row 16 = task 002 #16; 003-005 rows renumbered 17-33 with matching task numbers; §7 byte-scan refs updated to rows 21/29; 004 #27 still cites rows 3-4 (unchanged).
CLARITY:
  - none — R1 finding 2 (bound semantics) resolved consistently: §2 09.1, §3 pipeline (assembly precedes bound-as-last-step), §4 row 6, and 001 Goal/Test #6/Interfaces all pin "ASSEMBLED line ≤ 2000, message tail cut, prefix intact".
  - none — R1 finding 4 (no-bypass wording) resolved: 004 #29 + §4 row 29 + 004 Goal (d) all read "every appendLine argument is logLine-formatted (REDACTED); flush-site matches expected by design; appendLine(<raw>) is the FAIL".
SCOPE:
  - none — renumbering introduced no cross-file drift; wave/serialization (002 scripts w1 → 003 commands w2) unchanged; task 002's node -e profile check is a superset of PLAN §5's 002 block, not a conflict.
YAGNI:
  - none — R1 finding 5 resolved: §3 09.2, §7, and 002 Goal all state profile:fast ≡ verify:fast is INTENDED (named-profile namespace, kept in lockstep, no third implementation).

NOTES: Non-blocking clarification only — §3 09.1 "the MESSAGE tail is what gets cut" is exact for the no-correlationId case (row 6 / test #6). If a future corr+long-message case is pinned, decide whether the bound may cut the corr suffix (whole-line slice) or must preserve it (message-only truncate); today's tests and acceptance do not exercise it, so no action needed.
