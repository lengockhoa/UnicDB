# ADR 0003 — Fail-closed AI SQL policy: one decision, two guard profiles

- Status: **Accepted** (gating ARP-06 — this ADR lands before/with any ARP-06 source change; TASK-ARP06-001 writes it and pins the core profile, -002 adopts it in `run_sql`, -003/-004/-005 are usage-visibility work outside this policy)
- Date: 2026-09-02
- Deciders: UnicDB maintainers (recorded in `docs/AI_HANDOFF/PLAN.md` §1–§3, cycle ARP-06 commissioning brief; source roadmap `docs/plans/2026-09-01-UnicDB-additive-roadmap.md` §ARP-06)
- Scope: `src/ai/tools/readonlySqlParser.ts` (core profile), `src/ai/tools/sqlTool.ts` (`run_sql` profile — cited as existing behavior at write time; ARP-06.2 owns any change to it), `src/ai/tools/dbAwareTools.ts` / `src/ai/tools/analysisTools.ts` (core-profile consumers). ARP-01's dialect-aware read-only classifier and `guardAdapter` are NOT part of this decision and must not be perturbed.

## 1. Context and problem

Two SQL read-only guards exist side by side in the AI tooling with different vocabularies
and, until now, no documented relationship:

- **`parseReadonly`** (`src/ai/tools/readonlySqlParser.ts`) — accepts first-keyword
  SELECT/WITH only, deliberately over-rejecting everything else. Consumed by
  `dbAwareTools` (`run_readonly_query`, `list_table_data_sample`) and `analysisTools`
  (`analyze_table`, `diagnose_query`) via their shared `guardSql`.
- **`isReadOnlySql`** (`src/ai/tools/sqlTool.ts`) — the guard in front of the `run_sql`
  tool; admits SELECT/SHOW/EXPLAIN/WITH with bespoke checks for writable CTEs, INTO,
  row locks, and multi-statement scripts.

Both guards were tuned in earlier cycles (ARP-01 enforcement, TASK-AIX03-101 row locks)
and each is individually fail-closed, but nothing recorded **which decision they are
profiles of**, what each admits or denies, or why the stricter one is allowed to
over-reject. Consequences of the missing record:

- A future guard change could silently diverge from the other without anyone being able
  to cite the policy both must satisfy.
- The deliberate over-rejection (e.g. rejecting `SELECT created_at FROM t` because it
  contains `create`) reads as a bug to a new maintainer rather than as policy, inviting
  an unsafe "fix".
- The EXPLAIN hazard — PostgreSQL's `EXPLAIN ANALYZE` **executes** the wrapped
  statement, so `EXPLAIN ANALYZE DELETE FROM t` is a mutation — is handled differently
  by each profile and the rule was written nowhere.

This ADR is the **wave-0 mandatory gate** for ARP-06: it records the one fail-closed
decision, the two documented profiles, and the allowed/denied construct matrix. It
cites `sqlTool.ts`'s existing `run_sql` behavior as the source of truth **at write
time**; per the ownership rule (§8), ARP-06.2 reconciles any drift between this matrix
and the guard's behavior by an ADR correction in wave 2 — never as a silent divergence.

## 2. The one decision

> **A statement executes only if a profile of this policy admits it; any uncertainty
> rejects.**

Three binding corollaries:

1. **Fail-closed direction.** Between a false rejection (legitimate read denied) and a
   false admission (mutation executed), the policy always chooses rejection. A denied
   read costs the model one retry with different SQL; an admitted mutation can destroy
   data. Over-rejection is therefore a *feature of the decision*, not a defect.
2. **Uncertainty is rejection.** If the parser cannot prove a statement is read-only —
   malformed structure, unbalanced parens, unknown first keyword, a token it cannot
   fully account for — the statement is rejected. No heuristic admits on "probably
   safe".
3. **Two profiles, one decision.** The guards are NOT merged. `parseReadonly` is the
   **core profile** (strictest; used everywhere except `run_sql`), `isReadOnlySql` is
   the **`run_sql` profile** (additionally admits SHOW and EXPLAIN-with-reduction).
   Both enforce the same fail-closed principle; neither may admit a construct the
   matrix in §4 denies for it. Merging them is explicitly rejected (§7) so that
   ARP-01's dialect-aware classifier and `guardAdapter` coverage stay untouched.

## 3. The two profiles

### 3.1 Core profile — `parseReadonly` (strictest)

`src/ai/tools/readonlySqlParser.ts`. Consumed by `dbAwareTools.guardSql` and
`analysisTools.guardSql`. admits exactly two statement shapes: first-keyword `SELECT`
and first-keyword `WITH`. Everything else — SHOW, EXPLAIN, every DML/DDL/utility
keyword — is rejected with `{ ok:false, reason:"non_select" }` before any adapter call.
Structural rejections (`multi_statement`, `unbalanced_parens`, `empty`) cover malformed
input. The core profile never admits EXPLAIN at all: it has no need for the statement
plan and thereby never has to reason about `EXPLAIN ANALYZE` execution semantics.

### 3.2 `run_sql` profile — `isReadOnlySql`

`src/ai/tools/sqlTool.ts`, in front of `createSqlTool`'s `run_sql` tool. Admits
first-keyword SELECT/SHOW/EXPLAIN/WITH after its bespoke checks pass (writable CTE,
INTO, row-lock clause, multi-statement). It exists because `run_sql` legitimately
serves `SHOW` introspection and `EXPLAIN` plan inspection; the EXPLAIN reduction rule
(§6) is what keeps that extra surface safe. This section records existing behavior at
write time — it is the profile ARP-06.2 pins and adopts; drift between this text and
`sqlTool.ts` after that task lands is reconciled per §8.

## 4. Allowed/denied construct matrix

Enforcement vocabulary: each profile rejects with its own stable reason — the core
profile with `ParseFailReason` (`non_select`, `multi_statement`, `empty`,
`unbalanced_parens`), the `run_sql` profile with its fixed reason strings
(`READ_ONLY_REASON`, `INTO_REASON`, `WCTE_REASON`, `ROW_LOCK_REASON`,
`MULTI_STMT_REASON`). Denial messages are **stable and non-secret**: they carry a
reason class only — never SQL text, tool arguments, or connection material.

| Construct | Core (`parseReadonly`) | `run_sql` (`isReadOnlySql`) | Enforced by |
|---|---|---|---|
| Plain `SELECT` | admit (`kind:"select"`) | admit | first-keyword check |
| `WITH … SELECT` (non-writing CTEs) | admit (`kind:"with"`) | admit | first-keyword + writable-CTE scan (run_sql) |
| `SHOW` | **deny** (over-rejection) | admit | first-keyword check |
| `EXPLAIN` (any form) | **deny** — core never admits EXPLAIN | admit ONLY if the reduced inner statement (§6) is itself admissible; `EXPLAIN ANALYZE DELETE/UPDATE/INSERT/DROP/…` deny | core first-keyword; run_sql `stripExplainPrefix` + re-check |
| DML (`INSERT`/`UPDATE`/`DELETE`/`MERGE`) | deny (`non_select`) | deny | forbidden-token scan / writable-CTE scan |
| DDL (`CREATE`/`ALTER`/`DROP`/`TRUNCATE`/`COMMENT ON`/`REINDEX`/`CLUSTER`) | deny (`non_select`) | deny | forbidden-token scan |
| Grants / roles (`GRANT`/`REVOKE`) | deny (`non_select`) | deny | forbidden-token scan |
| Server-side write (`SELECT … INTO`, `COPY`, `CALL`/`EXEC`) | deny (`non_select`) | deny (`INTO_REASON` for INTO) | INTO scan / forbidden-token scan |
| Writable CTE (`WITH x AS (INSERT/UPDATE/DELETE/MERGE …)`) | deny (`non_select`) | deny (`WCTE_REASON`) | forbidden-token scan (core) / `\b(insert\|update\|delete\|merge)\b` scan (run_sql) |
| Row locks (`FOR UPDATE`/`NO KEY UPDATE`/`SHARE`/`KEY SHARE`/`NO KEY SHARE`) | deny (`non_select`) | deny (`ROW_LOCK_REASON`) | shared `ROW_LOCK_RE` (TASK-AIX03-101), imported by both guards |
| Session/utility (`SET`, `RESET`, `VACUUM`, `ANALYZE`, `LISTEN`, `NOTIFY`, `LOCK`, `PREPARE`, `DISCARD`, …) | deny (`non_select`) | deny | first-keyword check (not in either allow-set) |
| Forbidden keyword inside string literal / dollar-quote / comment body / identifier substring (`'insert'`, `-- drop table t`, `created_at`) | **deny** — over-rejection is policy (§5) | **admit when reads-only** — run_sql has no literal/comment scanner; `SELECT 'insert'`, `SELECT 'drop table x'`, `SELECT created_at FROM t` are admitted because its residual scans (writable-CTE, row-lock, INTO) are false-positive-free on these shapes. Over-rejection is a core-profile-only policy (§5); run_sql's narrower guarantee is stated in §6. | lexical over-rejection rules (core column); run_sql: literal-transparent residual scans (R2 review correction) |
| Multi-statement (`SELECT 1; SELECT 2`, stacked writes) | deny (`multi_statement`) | deny (`MULTI_STMT_REASON`) | statement counting, literal-aware |
| Unbalanced parens | deny (`unbalanced_parens`) | deny | paren balance / parse shape |
| Empty / comment-only input | deny (`empty`) | deny | trivially not a statement |

The matrix is the *contract*; the guard code is the *implementation*. The security
corpus in `src/ai/tools/__tests__/readonlySqlParser.test.ts` (ARP-06.1) pins the core
column; the `run_sql` pins belong to TASK-ARP06-002.

## 5. Over-rejection rules (lexical policy)

The core profile is deliberately stricter than a real SQL parser. A forbidden keyword
is rejected **wherever it appears**, including:

- **Inside string literals and dollar-quoted strings** — `SELECT 'insert'` is denied.
- **Inside comment bodies** — `SELECT 1 -- drop table t` and `SELECT 1 /* delete */`
  are denied. (ARP-06.1 corpus fix: the token scans now run against the raw text so a
  comment can never hide a *denied* token; comment stripping is used only for
  structural parsing. Before this fix a comment-hidden keyword was admitted — the
  corpus proved the gap RED-first and the parser was corrected minimally.)
- **As a substring of an identifier** — `created_at` contains `create`,
  `inserted_at` contains `insert`; both are denied. `\b` word boundaries still prevent
  the *complementary* absurdity (`FORECAST` does not trip the row-lock regex).

Cost model: the model whose SQL is denied by a false positive is told via the tool
contract to rename such columns (alias-free projection) or use
`list_table_data_sample` instead. A denied read costs one retry; the over-rejection
buys immunity to every tokenizer-bypass trick that does not require shipping a full
SQL tokenizer. Relaxing any of these rules requires a new ADR (§7).

## 6. EXPLAIN-reduction rule (`run_sql` profile only)

PostgreSQL's `EXPLAIN ANALYZE` **executes** the wrapped statement, so EXPLAIN is a
mutation carrier, not a read. The rule, already implemented in `sqlTool.ts`
(`stripExplainPrefix`) at write time and pinned by TASK-ARP06-002:

> Strip a leading `EXPLAIN` plus any `ANALYZE|ANALYSE|VERBOSE` modifiers and an
> optional parenthesized options list, then run the **same guards** on the inner
> statement. Only an inner SELECT/WITH…SELECT/SHOW is admissible; anything else
> behind EXPLAIN — `EXPLAIN ANALYZE DELETE FROM t`, `EXPLAIN (ANALYZE) UPDATE …`,
> an inner `FOR SHARE`, an inner `INTO` — is rejected.

The core profile needs no reduction because it never admits EXPLAIN in the first
place; the run_sql profile's extra SHOW/EXPLAIN surface exists only inside this rule.

### 6.1 run_sql profile guarantee (narrower than core, still fail-closed)

The `run_sql` guard does **not** implement the core profile's literal/comment
over-rejection: it has no forbidden-keyword literal scanner, and its residual scans
(writable-CTE DML, row locks, INTO) are word-boundary matches that are
false-positive-free on literal/comment/identifier shapes (`SELECT 'insert'`,
`SELECT 'drop table x'`, `SELECT created_at FROM t` — all admitted, all reads).
The run_sql guarantee is therefore: **every admitted statement begins with an
allow-listed first keyword, is a single statement, and carries no residual
mutation surface** — mutation capability is still impossible to express; only the
stricter core profile additionally denies benign reads that merely mention
forbidden words. (R2 review correction: the matrix previously claimed run_sql
denied literal/comment keywords, which its guard does not do.)

## 7. Rejected alternatives

- **A full SQL tokenizer (literal-aware, grammar-complete).** Rejected: YAGNI. The
  deliberate over-rejection already makes parser-bypass impossible without one, and
  relaxing over-rejection is explicitly Out of ARP-06 scope
  (`docs/AI_HANDOFF/PLAN.md` §2). A tokenizer adds a dialect matrix, escape edge
  cases (`''`, `""`, dollar tags), and a fresh bypass surface to audit — risk with no
  policy gain. If a future cycle wants literal-aware scanning, it goes through a new
  ADR and must preserve the uncertain→reject principle.
- **Merging the two guards into one function.** Rejected: `run_sql` genuinely needs
  SHOW and EXPLAIN-with-reduction; the dbAware/analysis tools do not. Merging would
  either over-permit the strict tools or over-restrict `run_sql`. Two documented
  profiles of one decision preserve ARP-01's classifier and `guardAdapter` coverage
  untouched.
- **Permit-list by regex over the whole statement only (no first-keyword anchor).**
  Rejected: a permit-list alone cannot distinguish `SELECT …` from a second statement
  or a leading-comment-smuggled keyword; both profiles anchor on the first keyword of
  the comment-stripped statement and then apply the lexical policy of §5.
- **Denial messages that explain the offending token.** Rejected: echoing SQL text or
  matched tokens back turns a guard into an oracle and risks reflecting
  secret-shaped input. Denials carry the stable reason class only (§4).

## 8. Consequences and bindings

- **TASK-ARP06-001** (this task) records the decision, pins the core profile with the
  mandatory security corpus (Test Cases 1–8 of the task file), and corrected the one
  corpus-proven gap (comment-body scans, §5) RED-first in `readonlySqlParser.ts`. The
  module header names this file the **core profile** of ADR 0003.
- **TASK-ARP06-002** adopts the policy in `run_sql`: pins that only approved SQL
  executes (adapter never invoked on any denial), denial strings stay stable and
  non-secret, the EXPLAIN reduction (§6) stays, and the cursor/row-cap behavior is
  retained. **Ownership rule:** if its pins expose drift between this ADR's matrix and
  the guard's actual behavior, ARP-06.2 appends an ADR correction **in wave 2** (or via
  its own review round) — the ADR is authoritative for the decision, the guard is
  authoritative for behavior, and drift is reconciled through that append, never left
  as a silent divergence. No same-wave append.
- **ARP-06.3/004/005** (usage transport/accounting/panel) do not touch this policy;
  their contract is usage visibility.
- **Untouched by design:** ARP-01's dialect-aware read-only classifier, `guardAdapter`
  coverage, and the AIX-07/AIX-08 policy contracts. This ADR governs the AI tool
  guards only.
- Any future relaxation (literal-aware scanning, new admitted first keyword, new
  profile) requires a new ADR citing this one and must preserve the §2 decision.
