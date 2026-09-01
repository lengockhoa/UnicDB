# PLAN — ARP-06: AI SQL policy unification and usage visibility

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-06 (lines 277-320; P1; dep ARP-01 read-only enforcement — shipped v1.37.0; must preserve AIX-07/AIX-08 unchanged).
Base: `main @ 6ee4c51` (v1.41.0). Executor: `unic-code`. Reviewer: `unic-smart`.
Full-suite baseline: **3025 passed | 2 skipped** measured fresh at `main @ 65b9c4f` (v1.40.0, prior cycle). The executor records the fresh v1.41.0 baseline at commissioning (`npm test`).

## §1 Intent

**Problem.** Two SQL read-only guards exist side by side with different vocabularies and no
documented relationship: `parseReadonly` accepts only SELECT/WITH and deliberately over-rejects
(`src/ai/tools/readonlySqlParser.ts:1-11,197-236`); `isReadOnlySql`/`run_sql` accepts
SELECT/SHOW/EXPLAIN/WITH with bespoke checks (`src/ai/tools/sqlTool.ts:109-163,226-288`). Provider
replies already normalize token usage (`src/ai/provider.ts:49-54,209-214,321-325`) and the agent has a
max-step budget (`src/ai/agent.ts:264-266`), but there is **no documented fail-closed policy decision**
shared by every AI SQL route, and **no per-turn/bounded-session usage view** for the user.

**Success.** (1) ONE documented fail-closed policy decision (ADR `0003-ai-sql-policy.md`) under which
both guards are named profiles — `parseReadonly` is the strict core profile; `isReadOnlySql` is the
`run_sql` profile that additionally admits SHOW/EXPLAIN by reducing EXPLAIN to its inner statement and
re-checking it. Parser uncertainty never admits mutation-capable SQL. (2) A mandatory security parser
corpus (side-effect tests) proving every mutation-capable construct is denied before any adapter call.
(3) Usage is reported/unknown, never invented: the provider transport is pinned safe under
missing/malformed data and streams final usage once; the agent reports exact per-turn accounting and
keeps `maxSteps` as the ONLY hard stop; the chat panel surfaces policy + usage with no prompt, SQL,
secret, trace, or tool arguments on the wire.

**Method.** Documentation + test-heavy cycle. Existing behavior is presumed correct; production code
changes land **only where a pinned security/privacy corpus test proves a gap** (RED first). The two
guards are NOT merged — they are two documented profiles of one policy, so ARP-01's
dialect-aware classifier and guardAdapter coverage are untouched.

## §2 Scope

**In**
- ARP-06.1 (wave 1) — fail-closed policy decision API: ADR `0003-ai-sql-policy.md` (new) documenting
  the one decision + the allowed/denied construct matrix + the two tool profiles + the
  over-rejection/EXPLAIN-reduction rules; security parser corpus in `readonlySqlParser.test.ts` pinning
  SELECT happy / writable CTE / EXPLAIN ANALYZE mutation / SELECT INTO / multi-statement / malformed
  parens / comment-literal policy; production change in `readonlySqlParser.ts` only if the corpus
  proves a gap.
- ARP-06.2 (wave 1) — tool adoption: `sqlTool.ts` executes only what the approved policy admits; denial
  is stable and non-secret; cursor closes on success AND error; row cap retained. Module header names
  the `run_sql` profile.
- ARP-06.3 (wave 1) — usage transport: `provider.ts` missing/malformed usage safe, streaming final
  usage emitted once, no response body retained for accounting.
- ARP-06.4 (wave 2) — accounting: `agent.ts` reports exact per-turn usage (sum over steps, unknown when
  nothing reported, aborted turn never invents), hard stop remains ONLY the approved `maxSteps` budget.
- ARP-06.5 (wave 3) — panel: `aiChatPanel.ts` + `aiChatPanelMessages.ts` + `webview/aiChatPanelMain.ts`
  display policy + usage with no prompt, SQL, secret, trace, or tool arguments.

**Out** (explicit, from roadmap)
- AI DML/DDL support; raw prompt/SQL display anywhere in the new UI; cost estimates without pricing;
  weakening the ARP-01 read-only classifier / AIX-07 policy / AIX-08 MCP / redaction contracts.
- Merging the two guards into one function (they stay two documented profiles of one decision).
- Any NEW hard stop beyond the approved `maxSteps` budget (e.g. a token-based kill) — rejected in §3.

**Same-wave file disjointness (absolute)**
- Wave 1: ARP-06.1 owns `readonlySqlParser.ts` + `readonlySqlParser.test.ts` + `docs/decisions/0003-ai-sql-policy.md`; ARP-06.2 owns `sqlTool.ts` + `sqlTool.test.ts`; ARP-06.3 owns `provider.ts` + `provider.test.ts`. Disjoint. **No task shares a `src/` file within wave 1.**
- Wave 2: ARP-06.4 owns `agent.ts` + `agent.test.ts` only.
- Wave 3: ARP-06.5 owns `aiChatPanelMessages.ts` + `aiChatPanel.ts` + `webview/aiChatPanelMain.ts` + the three named panel test files.
- `docs/decisions/0003-ai-sql-policy.md` is written by ARP-06.1 ONLY **in wave 1** (no other task appends in
  the same wave — unlike ARP-05's wave-1 ADR append protocol). The ADR cites `sqlTool.ts`'s **existing
  run_sql behavior as the source of truth at write time**: it records the decision + principle + the
  allowed/denied matrix, not guard internals that only ARP-06.2 can verify in the same parallel wave.
  **Ownership rule:** ARP-06.2 MAY append ADR corrections in wave 2 (or via its own review round) if its
  pins expose drift between the ADR's documented matrix and the guard's actual behavior — the ADR is
  authoritative for the decision, the guard is authoritative for behavior, and drift is reconciled through
  that append, never left as a silent divergence.

## §3 Approach

**The one fail-closed policy decision (ADR 0003).** The decision: *a statement executes only if a
profile admits it; any uncertainty rejects.* Two documented profiles:
- **Core profile** (`parseReadonly`, consumed by `dbAwareTools`): admits first-keyword SELECT and WITH
  only; deliberately over-rejects SHOW, EXPLAIN, forbidden keywords inside string literals / dollar
  quotes / identifiers (`created_at` contains `create`), INTO, row locks, and any `;` with trailing
  content. This is the STRICTEST guard; it is fail-closed by construction (over-rejection direction).
- **run_sql profile** (`isReadOnlySql`, consumed by `createSqlTool`): admits SELECT/SHOW/EXPLAIN/WITH,
  strips leading comments, reduces `EXPLAIN [ANALYZE|ANALYSE|VERBOSE|(options)]` to its inner statement
  and re-runs the same guards on it (so `EXPLAIN ANALYZE DELETE` and `EXPLAIN (ANALYZE) DELETE` are
  rejected — PostgreSQL actually executes the wrapped statement), rejects writable CTE, INTO,
  row-lock clauses, and multi-statement.

The ADR records the matrix (each construct → admit/deny per profile + the exact guard line that enforces
it), the "uncertain → reject" principle, and the reject alternative (a full tokenizer: YAGNI — the
deliberate over-rejection already makes parser-bypass impossible, and relaxing it is explicitly Out).

**ARP-06.1 — ADR + security corpus.** Write ADR 0003 (new file, no `src/` change in the ADR write).
Extend `readonlySqlParser.test.ts` with the mandatory security corpus: parametrized sweep over the
mutation-capable constructs (DML/DDL keywords, INTO, writable CTE, EXPLAIN-wrapped writes, row locks,
forbidden-in-literal, forbidden-in-identifier, multi-statement, malformed parens) asserting `parseReadonly`
returns `{ok:false}` for every one. Production change in `readonlySqlParser.ts` only if a corpus case
fails (RED). The module header gains a one-line naming: this is the **core profile** of the ARP-06 policy
decision (ADR 0003). The ADR cites `sqlTool.ts`'s existing run_sql behavior as the source of truth at
write time — it records the decision + principle + matrix, not guard lines only ARP-06.2 can verify in
the same parallel wave. Per the §2 ownership rule, ARP-06.2 may append ADR corrections in wave 2 (or via
its own review round) if its pins expose drift.

**ARP-06.2 — tool adoption.** The guard already rejects everything the matrix denies and the tool already
closes the cursor in `finally`, returns the fixed `ROW_LIMIT = 50` cap, and returns stable non-secret
reason strings (`READ_ONLY_REASON`, `INTO_REASON`, `WCTE_REASON`, `ROW_LOCK_REASON`,
`MULTI_STMT_REASON`). This task PINS those behaviors as regression + adds the new "only approved SQL
executes" side-effect assertion (adapter.runQuery is never called on any denial) + a stable-non-secret
denial check (the returned string contains no SQL text, no args, no DSN). Module header names the
**run_sql profile**. Production change only if a pin proves a gap.

**EXPLAIN reduction — already implemented, the plan only pins it.** The EXPLAIN→inner-statement reduction
is present in `sqlTool.ts` TODAY: `isReadOnlySql` strips a leading `EXPLAIN` plus optional
`ANALYZE|ANALYSE|VERBOSE` tokens and an optional parenthesized options list via `stripExplainPrefix`
(`sqlTool.ts:118-142,172-217`) and re-runs the same guards on the inner statement, so
`EXPLAIN ANALYZE DELETE` and `EXPLAIN (ANALYZE) DELETE` are already rejected. It is NOT in
`readonlySqlParser.ts` — `parseReadonly` never admits EXPLAIN at all (over-rejection, core profile).
This task PINS that behavior as regression; the executor implements a missing piece TDD-first only if a
pin turns RED.

**ARP-06.3 — usage transport.** `parseChatCompletionsResponse`/`parseResponsesResponse` already map
missing/non-numeric usage to `0`; `streamComplete` already takes usage from stream `usage` events (last
one wins, never summed). This task pins: missing usage → `{0,0}` (transport-normalized; the semantic
"unknown" is applied by the accounting layer, ARP-06.4); malformed usage (string/null/negative) → `0`,
never a throw, never NaN; streaming final usage once (multiple `usage` chunks → last chunk, not the sum);
streaming abort/error → `{0,0}`, no invented usage; response body never retained for accounting (full
`raw` string is discarded after parse; `ProviderError` keeps only the scrubbed ≤300-char snippet via
`scrubApiKey`). Production change only if a pin proves a gap.

**ARP-06.4 — accounting.** Add to `agent.ts`: `export interface TurnUsageSummary { inputTokens: number;
outputTokens: number; unknown: boolean; steps: number }` and pure
`export function summarizeTurnUsage(steps: readonly AgentStep[]): TurnUsageSummary` (sum over steps;
`unknown: true` iff every step reported `{0,0}`/no usage — never invent cost; `steps` = completed step
count). `runAgent` computes `usage: summarizeTurnUsage(steps)` on the returned `AgentRunResult` (budget
exhaustion path included — reflects only the completed steps). **No new hard stop:** `maxSteps`
(`agent.ts:265`) remains the only termination lever; `stoppedOnBudget` is unchanged. Aborted turns throw
(no `AgentRunResult`) — the task pins that no fabricated usage is ever returned on abort.

**ARP-06.5 — panel.** Extend `AiChatPanelSessionState`? NO — add a dedicated, privacy-safe host→webview
message `AiChatPanelUsage { type: "usage"; inputTokens: number; outputTokens: number; unknown: boolean;
sessionTokens: { inputTokens: number; outputTokens: number }; policyNotice: string }` to
`aiChatPanelMessages.ts`. The panel posts it once per builtin turn on the `done` path, consuming
`AgentRunResult.usage` (ARP-06.4) and accumulating the session total in a panel field; the policy notice
(`EffectivePolicy.notice`, already non-empty on denial) rides the same message and the existing denial
paths stay. The webview (`webview/aiChatPanelMain.ts`, bundled to `dist/aiChatPanel.js` via esbuild
`aiChatPanelConfig`) renders a status chip, mirroring the existing `session_state` chip. **Privacy
invariant:** the message contains ONLY the numeric fields + the notice string — never prompt text, SQL,
tool names, tool arguments, trace, or secrets. OMP turns have no usage source → the panel posts the
policy notice only (usage absent, never invented). The webview case is added to the same switch that
handles `session_state`; the panel tests extend the EXISTING `aiChatPanelPolicy.test.ts` (which already
has the `SECRET_RE` whole-turn byte-scan pattern, #3) and `aiChatPanel.test.ts`, plus the webview chip
render test in `aiChatPanelSessionStateWebview.test.ts`.

**Rejected alternatives.** Merging both guards into one function (breaks the two documented profiles and
would require re-touching ARP-01's `guardAdapter` — Out); a full SQL tokenizer to lift the over-rejection
(YAGNI, Out: the strict direction is the security property); a token-based hard stop in the agent (Out:
`maxSteps` is the approved budget; a new kill would change `AgentRunResult` semantics and the roadmap's
"hard stop only if approved policy requires it"); rendering usage into the `assistant` text (pollutes the
transcript and risks SQL/secret content — a dedicated numeric-only message is privacy-safe by shape);
normalizing usage to a "cost" display (Out: cost estimates without pricing).

## §4 Test Plan

### ARP-06.1 — fail-closed policy decision + security corpus (`src/ai/tools/__tests__/readonlySqlParser.test.ts`, extended)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | `parseReadonly` accepts plain SELECT | `{ ok:true, kind:"select" }` for `SELECT * FROM t` (and WITH → `kind:"with"`) |
| 2 | edge: mutation | writable CTE denied | `WITH x AS (UPDATE t SET a=1) SELECT * FROM x` → `{ ok:false, reason:"non_select" }` |
| 3 | edge: mutation | EXPLAIN ANALYZE DELETE denied by the core profile | `parseReadonly("EXPLAIN ANALYZE DELETE FROM t")` → `{ ok:false, reason:"non_select" }` (core never admits EXPLAIN; the run_sql profile reduces + re-checks separately) |
| 4 | edge: mutation | SELECT INTO denied | `SELECT * INTO t2 FROM t` → `non_select` |
| 5 | edge: structure | multi-statement denied | `SELECT 1; SELECT 2` → `multi_statement` |
| 6 | edge: structure | malformed parens denied | `SELECT (1` → `unbalanced_parens`; `SELECT 1)` → `unbalanced_parens` |
| 7 | edge: lexical | comment/literal over-rejection pinned | forbidden keyword inside `-- comment`, inside `'literal'`, and as an identifier substring (`created_at`) each → `non_select` |
| 8 | security corpus | sweep: no mutation-capable construct is ever admitted | parametrized over the full denied corpus (DML/DDL keywords, INTO, writable CTE, EXPLAIN, row locks, literal-hidden, identifier-substring, multi-statement, unbalanced parens) → every case `{ ok:false }` |

### ARP-06.2 — tool adoption (`src/ai/tools/__tests__/sqlTool.test.ts`, extended)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | approved SELECT executes through the cursor flow | `run_sql` returns the JSON `SqlResult` shape; `fetchBatch(50)` + `close()` called (pin `sqlTool.ts:226-258`) |
| 2 | edge: side-effect | only approved SQL executes — adapter NEVER called on denial | for each denial reason (DML, EXPLAIN ANALYZE DELETE, SELECT INTO, writable CTE, multi-statement, row lock) `isReadOnlySql` → `ok:false` AND `adapter.runQuery` is not invoked by `createSqlTool.execute` |
| 3 | edge: resource | cursor closes on success AND on error | `fetchBatch` throw → `close()` still called; result still resolves (pin `sqlTool.test.ts:414`) |
| 4 | edge: budget | row cap retained | >50 rows → `truncated:true`, `rows.length === 50`, `rowCount` = full batch length |
| 5 | edge: non-secret denial | denial string is stable + secret-free | returned denial contains the exact literal reason; contains NO SQL text, NO tool args, NO host/DSN/apiKey fragment |
| 6 | edge: resource | no-connection path | factory null → `NO_CONNECTION_MSG`; no throw |

### ARP-06.3 — usage transport (`src/ai/__tests__/provider.test.ts`, extended)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | chat/completions usage parsed | `usage: { inputTokens: 10, outputTokens: 5 }` from `prompt_tokens`/`completion_tokens` |
| 2 | edge: missing | absent usage → normalized zeros | both `parseChatCompletionsResponse` and `parseResponsesResponse` → `usage {0,0}` (transport value; semantic "unknown" applied by ARP-06.4) |
| 3 | edge: malformed | non-numeric/negative usage → 0, never a throw / never NaN | `prompt_tokens:"x"`, `completion_tokens:null`, negative → `{0,0}` / `0`; parse returns, no `ProviderError` |
| 4 | edge: streaming | final usage emitted once | two `usage` chunks in one stream → result usage = LAST chunk (7/5), NOT the sum |
| 5 | edge: streaming abort | aborted/malformed stream never invents usage | mid-stream abort or garbage events → `{0,0}`, no hang, no invented number |
| 6 | edge: retention | response body never retained for accounting | a successful parse result exposes only `text/toolCalls/finishReason/usage`; a `ProviderError` carries only the scrubbed ≤300-char `bodySnippet` (no full raw body) |

### ARP-06.4 — accounting (`src/ai/__tests__/agent.test.ts`, extended)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | exact cumulative usage across steps | 3 steps (usage 1/1, 2/3, 5/6) → `summarizeTurnUsage` → `{ inputTokens:8, outputTokens:10, unknown:false, steps:3 }`; `runAgent(...).usage` matches |
| 2 | edge: unknown | all-unknown usage never invented | every step `{0,0}` → `{ 0, 0, unknown:true, steps:N }` — never a fabricated cost |
| 3 | edge: mixed | partial unknowns are summed, not treated as unknown | steps `{0,0}`, `{5,3}`, `{0,0}` → `{ inputTokens:5, outputTokens:3, unknown:false, steps:3 }` |
| 4 | edge: empty | budget-capped with zero completed steps | 0 steps → `{ 0, 0, unknown:true, steps:0 }`; `stoppedOnBudget:true` |
| 5 | edge: aborted | aborted turn returns no invented usage | abort path rethrows (no `AgentRunResult`); assert the resolved-result path never fabricates usage |
| 6 | edge: budget | hard stop remains ONLY `maxSteps` | budget exhaustion → `stoppedOnBudget:true`, usage reflects completed steps only; no NEW stop mechanism added (assert run completes exactly `maxSteps` steps, no token-based kill) |

### ARP-06.5 — panel (`src/ui/__tests__/aiChatPanelPolicy.test.ts` + `aiChatPanel.test.ts` + `aiChatPanelSessionStateWebview.test.ts`, extended)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | builtin turn posts usage + policy notice | on `done`, a `{type:"usage"}` frame is posted with the exact summed `inputTokens/outputTokens`, `unknown:false`, session total, and `policyNotice` (non-empty when policy denies) |
| 2 | edge: unknown | all-unknown usage → `unknown:true`, never invented | provider returns `{0,0}` for every step → posted usage is `{0,0, unknown:true}` + notice |
| 3 | edge: privacy | whole-turn byte scan stays secret-free | aggregate every webview frame + history of a builtin turn that includes a secret-shaped string in a prompt/tool arg → `SECRET_RE` scan finds nothing (mirror the existing #3 pattern in `aiChatPanelPolicy.test.ts`) |
| 4 | edge: privacy | usage frame is shape-safe | the `{type:"usage"}` message contains ONLY numeric fields + `policyNotice` string — no prompt text, no SQL, no tool names/arguments, no trace |
| 5 | edge: denied policy | denied policy → notice shown, chat still completes | denied policy → generic prompt used, `policyNotice` non-empty on the usage frame, no error bubble |
| 6 | edge: abort | aborted turn never posts fabricated usage | stop mid-turn → no `{type:"usage"}` frame with invented numbers (either none, or `unknown`/partial as actually seen) |
| 7 | edge: render | webview renders the usage chip | `session_state`-style chip shows tokens/unknown state; `textContent`-only, no child nodes on hostile numeric values |

## §5 Verification Commands

Run inside a clean worktree on `main @ 6ee4c51`. No real DB required. **No lint script exists** — the
static gate is `npm run typecheck` (script verified in `package.json`); `npm run compile` is the build
gate. Default `npm test` excludes `**/*.integration.test.ts` (`vitest.config.ts`); integration suites run
only via `npm run test:integration` (cycle net, NOT per-task). Test selection follows RULES resolution
order from `.cache/index/tests-map.json` (the map is stale for `aiChatPanel.ts` — it omits
`aiChatPanelPolicy.test.ts` and the session-state webview file, both of which exist and are pinned below).

- **ARP-06.1** (wave 1):
  ```bash
  test -f docs/decisions/0003-ai-sql-policy.md
  grep -qi "run_sql" docs/decisions/0003-ai-sql-policy.md && grep -qi "parseReadonly" docs/decisions/0003-ai-sql-policy.md
  npx vitest run src/ai/tools/__tests__/readonlySqlParser.test.ts
  npm run typecheck && npm run compile
  ```
- **ARP-06.2** (wave 1):
  ```bash
  npx vitest run src/ai/tools/__tests__/sqlTool.test.ts
  npm run typecheck && npm run compile
  ```
- **ARP-06.3** (wave 1):
  ```bash
  npx vitest run src/ai/__tests__/provider.test.ts
  npm run typecheck && npm run compile
  ```
- **ARP-06.4** (wave 2, after wave 1):
  ```bash
  npx vitest run src/ai/__tests__/agent.test.ts
  npm run typecheck && npm run compile
  ```
- **ARP-06.5** (wave 3, after 004):
  ```bash
  npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts
  npm run typecheck && npm run compile
  ```
  (Tests-map for `aiChatPanel.ts` lists 10 files but is stale — it omits `aiChatPanelPolicy.test.ts` and
  the webview session-state file. The three pinned files are the DB-free targets; the omitted files are
  covered in the cycle `npm test` net.)
  **Bundle regeneration:** `npm run compile` runs `node esbuild.js` and rebuilds `dist/`, including
  `dist/aiChatPanel.js` — the esbuild bundle of `webview/aiChatPanelMain.ts` (`esbuild.js:87-89,171`). The
  vitest targets exercise only the TS source, so a stale committed bundle would otherwise pass every check
  yet ship a non-functional panel; the compile step in this sequence confirms the shipped bundle is
  regenerated from the changed webview source.
- **Cycle net (after all tasks)**:
  ```bash
  npm test
  npm run test:integration    # controlled — real fixtures only, per roadmap acceptance
  ```
  Expected: `npm test` ≥ the fresh v1.41.0 baseline (3025 passed | 2 skipped at v1.40.0; executor
  records the fresh number at commissioning). Integration: only where fixtures exist.

## §6 Acceptance Criteria

Every criterion traces to a task.

- [ ] **ARP-06.1** — `docs/decisions/0003-ai-sql-policy.md` exists and documents the one fail-closed
  policy decision, the allowed/denied construct matrix, and the two profiles (`parseReadonly` core,
  `isReadOnlySql` run_sql); the security parser corpus sweep (`readonlySqlParser.test.ts`) passes — every
  mutation-capable construct is denied and parser uncertainty never admits it; `npm run typecheck` +
  `npm run compile` exit 0. (TASK-ARP06-001)
- [ ] **ARP-06.2** — `run_sql` executes only approved SQL; `adapter.runQuery` is never invoked on any
  denial; cursor closes on success and error; the 50-row cap is retained; denial strings are stable and
  secret-free; module header names the run_sql profile; typecheck + compile exit 0. (TASK-ARP06-002)
- [ ] **ARP-06.3** — missing/malformed usage is transport-safe (`{0,0}`, never a throw/NaN); streaming
  final usage emitted once (last chunk, never summed); the raw response body is never retained for
  accounting; typecheck + compile exit 0. (TASK-ARP06-003)
- [ ] **ARP-06.4** — `runAgent` reports exact per-turn usage (`summarizeTurnUsage` + `AgentRunResult.usage`);
  all-unknown → `unknown:true`, never invented cost; aborted turns never fabricate usage; the ONLY hard
  stop remains `maxSteps` (`stoppedOnBudget` unchanged, no token-based kill); typecheck + compile exit 0.
  (TASK-ARP06-004)
- [ ] **ARP-06.5** — policy + usage displayed for builtin turns via the shape-safe `usage` frame; OMP turns
  show the policy notice with no invented usage; no prompt, SQL, secret, trace, or tool arguments reach
  the wire (SECRET_RE scan + shape assertion); webview renders the chip; typecheck + compile exit 0.
  (TASK-ARP06-005)
- [ ] **Compose** — ARP-01 dialect-aware read-only enforcement + `guardAdapter` unchanged; AIX-07
  `EffectivePolicy`/`resolvePolicy` and AIX-08 MCP contracts untouched; redaction (`redact`,
  `scrubApiKey`, `stripTrailingSqlComments`) not weakened anywhere.
- [ ] **Cycle** — `npm test` full suite green at the fresh v1.41.0 baseline; controlled
  `npm run test:integration` where fixtures exist.
- [ ] **Security review** — the mandatory security parser corpus + redaction review verdict recorded on
  TASK-ARP06-001/003/005.
- [ ] **Reviewer** verdict APPROVED or APPROVED-WITH-MINOR on PLAN and on each task.

## §7 Global Constraints

- Base: `main @ 6ee4c51` (v1.41.0). All work in a fresh worktree; no git commit in P2/P3.
- Same-wave file disjointness absolute: 001 owns `readonlySqlParser.ts`(+test) + ADR `0003`; 002 owns
  `sqlTool.ts`(+test); 003 owns `provider.ts`(+test); 004 owns `agent.ts`(+test); 005 owns
  `aiChatPanelMessages.ts` + `aiChatPanel.ts` + `webview/aiChatPanelMain.ts` + the three named panel test
  files. No `src/` or `webview/` file is shared within a wave.
- TDD mandatory: RED probe/pin output pasted before implementation in every task report; docs/corpus task
  (001) records its security-corpus evidence instead.
- Do NOT weaken ARP-01 (dialect-aware classifier + `guardAdapter`), AIX-07 (`resolvePolicy`/`EffectivePolicy`/
  `notice`), or AIX-08 MCP contracts. Do NOT relax `parseReadonly` over-rejection (it is the fail-closed
  property). No new hard stop beyond `maxSteps`. No cost estimates without pricing. No raw prompt/SQL in
  the usage display.
- No lint script exists — the static gate is `npm run typecheck` (MUST be in every task's Verification
  Commands); `npm run compile` is the build gate. Integration tests run only via `npm run test:integration`,
  never the default `npm test` net.
- Verification DB-free in a clean worktree; the full `npm test` net and controlled
  `npm run test:integration` run at the cycle boundary.

---

## Planner Report

PLANNER_MODEL: unic-smart

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit:
- **Test selection grounded in the real `.cache/index/tests-map.json` + `ls` of the test dirs**:
  `provider.ts` → `[provider.test.ts, …]` pin `provider.test.ts` (verified at `src/ai/__tests__/provider.test.ts`); `agent.ts` → `[agent.test.ts, agentStream.test.ts]` pin `agent.test.ts`; `readonlySqlParser.ts` → `[readonlySqlParser.test.ts]`; `sqlTool.ts` → `[sqlTool.test.ts]`. The map is **stale for `aiChatPanel.ts`**: it lists 10 files but omits the EXISTING `aiChatPanelPolicy.test.ts` and `aiChatPanelSessionStateWebview.test.ts` — both verified on disk and pinned for ARP-06.5.
- **Roadmap citations corrected** (all verified against current source): `readonlySqlParser.ts:1-9,176-210` → `:1-11,197-236` (parseReadonly moved); `sqlTool.ts:99-136` → `:109-163` (guard) + `:226-288` (execute/tool); `provider.ts:51-54,209-214` confirmed accurate; `agent.ts:264-266` confirmed (maxSteps at `:265`); **`aiChatPanelPolicy.test.ts` already exists (34 KB, AIX-07)** — the roadmap lists it as a candidate NEW file; ARP-06.5 EXTENDS it, matching the roadmap's own wording "aiChatPanelPolicy.test.ts; aiChatPanel.test.ts".
- **Provider/agent test paths verified at commissioning** (roadmap said "verify at commissioning"): both exist and are pinned.
- **ADR numbering verified**: `docs/decisions/` has 0001 + 0002; next free = **0003** (README table updated by TASK-ARP06-001).
- **Base corrected**: ACTIVE.md still said `main @ 0087d35`; HEAD is now `6ee4c51` (ARP-05 close-out commit, still v1.41.0) — PLAN + ACTIVE use `6ee4c51`.
- Wave structure re-derived: the roadmap's wave-2 pair (accounting + panel) is a **real interface chain** — the panel consumes `AgentRunResult.usage`/`TurnUsageSummary` that accounting creates — so it is sequenced 004 → 005 instead of parallel (a parallel panel would have to re-invent the accounting, exactly the drift this pipeline prevents). Wave 1 keeps the roadmap's three disjoint files parallel.
Known gaps:
- ARP-06.1/02/03/05 production changes are CONDITIONAL: existing behavior is presumed correct and pinned; a production change ships only where a corpus/privacy pin proves a gap (RED first). The planner did NOT change any guard/parser/provider logic.
- ARP-06.5 OMP turns have no usage source in `OmpChatEngine`; the panel shows the policy notice only for OMP (usage absent, never invented). If the executor wants usage for OMP it would require a new OMP usage seam — explicitly Out for this cycle.
- The fresh v1.41.0 full-suite baseline is recorded at commissioning (v1.40.0 measured 3025 passed | 2 skipped).

---

## Plan Review Log

### Round 1 — 2026-09-02 · unic-smart
Status: Issues Found (2 minor, non-blocking — plan is otherwise sound)

COMPLETENESS:
  - none
CONSISTENCY:
  - §2/§3 (ARP-06.1 vs ARP-06.2) — ARP-06.1 (wave 1) writes ADR `0003` documenting the run_sql profile's allowed/denied matrix (EXPLAIN reduction, writable-CTE denial), while the authoritative pin of that exact behavior lives in ARP-06.2 (same wave, parallel) and ADR appends are explicitly disallowed. If 002's pins reveal the guard deviates from the ADR's documented matrix, no wave-1 task may correct the ADR. Fix: have 001's ADR document the decision + principle and cite `sqlTool.ts`'s run_sql profile as the behavioral source of truth (avoid enumerating guard lines only 002 can verify), or explicitly allow 002 to raise ADR corrections to 001.
CLARITY:
  - §3 (ARP-06.2) — "The guard already rejects everything the matrix denies" asserts current behavior but does not state whether the EXPLAIN→inner-statement reduction (incl. `EXPLAIN ANALYSE`, `EXPLAIN (ANALYZE)`) is implemented today or must be added by the executor when the pin turns RED. Fix: one sentence — "EXPLAIN reduction is a pin; if RED the executor implements it (TDD); §6-002 'executes only approved SQL' covers both outcomes."
TESTABILITY:
  - §5 (ARP-06.5) — Verification never checks that `dist/aiChatPanel.js` (the esbuild bundle of `webview/aiChatPanelMain.ts`) is regenerated/current. All tests target the TS source, so a stale committed bundle would pass every check yet ship a non-functional panel. Fix: state explicitly that `npm run compile` regenerates the bundle, or add a bundle-freshness check (build then compare) to ARP-06.5 verification.
SCOPE:
  - none
YAGNI:
  - none

NOTES: Plan passes all six requested checks — wave disjointness and dependency ordering, fail-closed guarantee (parser uncertainty never admits mutation-capable SQL), privacy invariants (numeric-only usage frame, SECRET_RE scan, usage reported/unknown only), testability (≥1 happy + ≥2 distinct edge kinds per task, concrete per-file verification, full suite deferred to cycle boundary), scope/YAGNI discipline, and §2↔task-breakdown↔§6 consistency. Both findings are one-line clarifications that strengthen implementability; neither blocks execution.

#### Revision (Round 1)

- PLANNER_REVISION (F1 — §2/§3 ADR ownership): §2 and §3 now state the ADR cites `sqlTool.ts`'s existing run_sql behavior as the source of truth at write time (decision + principle + matrix, not guard internals only 002 can verify), and make the ownership rule explicit — 001 owns the ADR write in wave 1; ARP-06.2 may append ADR corrections in wave 2 or via its own review round if its pins expose drift. Reflected in TASK-ARP06-001 (Interfaces/ownership) and TASK-ARP06-002 (Discussion).
- PLANNER_REVISION (F2 — §3 EXPLAIN clarity): verified against source — the EXPLAIN→inner-statement reduction is ALREADY implemented in `sqlTool.ts` today (`isReadOnlySql` `:118-142` via `stripExplainPrefix` `:172-217`; `readonlySqlParser.ts` never admits EXPLAIN). §3 now states this explicitly: the plan pins existing behavior; the executor implements TDD-first only if a pin turns RED. Added to TASK-ARP06-002 Discussion.
- PLANNER_REVISION (F3 — §5 bundle freshness): §5 ARP-06.5 now states `npm run compile` runs `node esbuild.js` and rebuilds `dist/`, including `dist/aiChatPanel.js` (bundle of `webview/aiChatPanelMain.ts`, `esbuild.js:87-89,171`), so the verification sequence confirms the shipped bundle is regenerated from the changed webview source. Noted in TASK-ARP06-005 Verification.

### Round 2 — 2026-09-02 · unic-smart
Verdict: Approved

Round 1 findings verified (3/3 resolved):
1. [RESOLVED] §2 (lines 61-68) + §3 (lines 94-97) — ADR 0003 ownership rule is now explicit: 001 writes the ADR in wave 1 citing `sqlTool.ts`'s existing run_sql behavior as the source of truth at write time (decision + principle + matrix, not guard internals only 002 can verify in the parallel wave); ARP-06.2 MAY append ADR corrections in wave 2 or via its own review round if its pins expose drift — the ADR is authoritative for the decision, the guard for behavior, and drift is reconciled through that append, never silent.
2. [RESOLVED] §3 (lines 107-114) — EXPLAIN→inner-statement reduction is stated as ALREADY implemented today (`isReadOnlySql` `:118-142` via `stripExplainPrefix` `:172-217`; `readonlySqlParser.ts` never admits EXPLAIN, core profile over-rejection). The plan pins existing behavior; the executor implements a missing piece TDD-first only if a pin turns RED. Covered by test ARP-06.1 #3 (core denies EXPLAIN) + ARP-06.2 #2 (run_sql denial sweep incl. EXPLAIN ANALYZE DELETE).
3. [RESOLVED] §5 (lines 256-260) — bundle regeneration confirmed: `npm run compile` runs `node esbuild.js` and rebuilds `dist/aiChatPanel.js` from `webview/aiChatPanelMain.ts` (`esbuild.js:87-89,171`); the stale-bundle failure mode (vitest passes on TS source while shipped bundle is stale) is explicitly stated, making the compile step load-bearing in the sequence.

Fresh whole-plan pass:
COMPLETENESS:
  - none
CONSISTENCY:
  - none
CLARITY:
  - none
SCOPE:
  - none
YAGNI:
  - none

NOTES: All six checks hold on the revised plan: wave disjointness is absolute, 004→005 sequencing matches the usage interface chain (panel consumes `AgentRunResult.usage`), fail-closed guarantee is corpus-pinned, privacy invariant is shape-safe (numeric-only frame + SECRET_RE scan), every task has ≥1 happy + ≥5 edge/security tests, and §2↔§3↔§5↔§6↔§7 stay aligned. Two cosmetic nits only, non-blocking: ARP-06.3 #3 expected column "negative → {0,0} / 0" is slightly ambiguous (both token fields become 0), and ARP-06.5 #6 abort expectation is deliberately open-ended ("none, or unknown/partial as actually seen") — both are acceptable as written.
