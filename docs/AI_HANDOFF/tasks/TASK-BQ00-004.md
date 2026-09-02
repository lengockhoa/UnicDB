# TASK-BQ00-004 — ADR 0004: BigQuery feasibility + adapter contract decision

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (BQ-00.4), §4 (rows 004), §7 Global Constraints

## Goal

Record the BQ-00 spike's decisions as `docs/decisions/0004-bq-00-feasibility-contract.md` — following the folder's existing convention (numbered file + README index row; the roadmap's "0001 genesis" fallback is stale, corrected in PLAN §3) — so BQ-01+ implement against a settled contract instead of re-deriving it. The ADR must cite the evidence recorded in 001-003's Discussions.

## Target Files

- `docs/decisions/0004-bq-00-feasibility-contract.md` — **(new)** the ADR.
- `docs/decisions/README.md` — append one row to the index table.

## Test Cases (REQUIRED — TDD)

Docs-only task: no runtime behavior changes, so there are no vitest test cases (RULES permits N/A with justification — this is it: acceptance is command-verified content checks instead).

| # | Type | Check | Expected |
|---|------|-------|----------|
| 1 | happy | ADR exists with all required decision sections | file contains headings covering: client method/version, continuation ownership, cancellation mapping, safe scalar conversion, selected config fields, required IAM, Storage Read API deferral, manual ADC smoke recipe, **"Pagination + cancellation method names"**, **"Grid continuation mapping"** |
| 2 | edge (consistency) | recorded version matches installed | ADR states the exact version found in `package-lock.json` (9.0.3, or the recorded 8.3.1 fallback) |
| 3 | edge (completeness) | README index updated | `docs/decisions/README.md` table gains a `0004` row |
| 4 | edge (evidence citation) | ADR cites the `.d.ts` evidence file by path | ADR references `docs/decisions/_bq00-evidence.md` and its "Pagination + cancellation method names" section enumerates `getQueryResults`, `query`, `createQueryJob`, `job.cancel` with return shapes as recorded by TASK-BQ00-001 (incl. what `job.cancel()` returns — the roadmap line-67 cancellation-return-shape mandate) |
| 5 | edge (paper mapping) | "Grid continuation mapping" paragraph maps the contract onto the read-only grid | a 3-5 sentence paragraph maps `BigQueryPage.pageToken` onto the existing grid continuation contract (`RunResult.batched` at `src/adapters/types.ts:78`; `resultsPanel.ts` `loadMore` → `runner.loadMore(index)`), stated as prose ONLY — no edit to any read-only file (`git diff --stat` on the §2 read-only list stays empty) |

## Test Files

- N/A — docs-only. Verification is the command-based content checks in §Verification below (grep assertions), replacing unit tests per the PLAN §4 justification.

## Verification Commands

```bash
# 1. Content checks (command-verified, not trust-based)
ADR=docs/decisions/0004-bq-00-feasibility-contract.md
test -f "$ADR" && echo "ADR exists"
grep -qi "9\.0\.3\|8\.3\.1" "$ADR" && echo "version recorded"
grep -qi "page token\|pageToken" "$ADR" && echo "continuation ownership"
grep -qi "cancel" "$ADR" && echo "cancellation mapping"
grep -qi "NUMERIC\|BIGNUMERIC" "$ADR" && echo "scalar conversion"
grep -qi "maximumBytesBilled" "$ADR" && echo "cost policy field"
grep -qi "bigquery.jobs\|bigquery.tables\|IAM" "$ADR" && echo "IAM section"
grep -qi "Storage Read" "$ADR" && echo "deferral recorded"
grep -qi "gcloud auth application-default" "$ADR" && echo "ADC recipe"
grep -q "_bq00-evidence.md" "$ADR" && echo "evidence file cited"
grep -qi "getQueryResults" "$ADR" && grep -qi "createQueryJob" "$ADR" && grep -qi "cancel" "$ADR" && echo "method names enumerated"
grep -qi "Grid continuation mapping" "$ADR" && grep -qi "loadMore\|resultBatcher\|batched" "$ADR" && echo "grid mapping present"
test -f docs/decisions/_bq00-evidence.md && echo "evidence file exists (written by TASK-BQ00-001)"
grep -q "^| 0004" docs/decisions/README.md && echo "README row"

# 2. Static + bundle gate (no lint script exists)
npm run typecheck
npm run compile

# 3. Full suite at cycle boundary (floor: 3189 passed | 2 skipped, must not drop)
npm test
```

## Acceptance Criteria

- [ ] ADR 0004 exists with Status/Date/Deciders/Scope header matching the 0001-0003 house style, and covers ALL decision areas listed in Test #1 (now ten, incl. the two Round-2 sections) — each citing the evidence from 001-003 (probe result, `.d.ts` field names, classifier categories, `docs/decisions/_bq00-evidence.md`).
- [ ] Continuation ownership stated explicitly: VSDB owns `BigQueryJobRef` + opaque page token across pages; client is stateless per page; token decides continuation (not row count).
- [ ] Cancellation mapping: owned active job ID only (project+location scoped); cancel-after-terminal is harmless; no guessed job IDs.
- [ ] Safe scalar conversion table (roadmap §5): INT64/NUMERIC/BIGNUMERIC canonical strings; FLOAT64 non-finite explicit; BYTES b64; RECORD/REPEATED JSON-preview; NULL distinct from empty string.
- [ ] Selected config fields: billing project, location, `maximumBytesBilled` — metadata only, no secret fields.
- [ ] Required IAM: least-privilege set (job creation/query/cancel in billing project + dataset metadata/data read), no broad owner/editor.
- [ ] Storage Read API deferral stated with the reason (BQ-07e separate measured decision).
- [ ] "Pagination + cancellation method names" section: enumerated names + return shapes as recorded in `docs/decisions/_bq00-evidence.md` (cited by path), explicitly covering what `job.cancel()` returns (roadmap line-67 mandate).
- [ ] "Grid continuation mapping" paragraph: 3-5 sentences mapping `BigQueryPage.pageToken` onto the existing grid continuation contract (`RunResult.batched` / `resultsPanel.ts` `loadMore` → `runner.loadMore(index)`), prose only — read-only files untouched.
- [ ] Manual ADC smoke recipe appendix: disposable test project, steps, and the never-record rule (no env values, tokens, credential paths, raw errors in this doc).
- [ ] README index row added; `npm run typecheck` + `npm run compile` + `npm test` green (floor 3189|2 preserved).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ00-001, TASK-BQ00-002, TASK-BQ00-003 must complete first — the ADR cites their recorded evidence; writing it earlier would violate "validate before production contract".

## Interfaces

- Consumes: evidence from all three prior tasks (installed version + engine-floor outcome; `docs/decisions/_bq00-evidence.md` written by TASK-BQ00-001 — method names + return shapes; validated `.d.ts` field names from 002; classifier category set + matching keys from 003).
- Produces: `docs/decisions/0004-bq-00-feasibility-contract.md` — the contract gate for BQ-01 (per house convention "Accepted — gating BQ-01"); README index entry.

---

## Discussion

<!-- AIs talk to each other HERE, not via any other tool. -->

### 2026-09-02 · planner · unic-smart
To 004's executor: the ADR's job is to CLOSE the roadmap's open questions, not restate them. Two inputs decide real content: (1) the engine-floor outcome from 001 — if the probe showed 9.x is bundle-safe, the ADR records "9.0.3 selected, node>=22 floor documented, extension-host implication analyzed"; if the fallback fired, it records why 8.3.1 was chosen. (2) The `.d.ts` deltas from 002 and the error-shape findings from 003 — if reality differs from the planner's expected type surface or from substring-based classification, the ADR records REALITY, and this task file's Discussion should note the deltas so BQ-01's commissioning brief can absorb them. House style reference: `docs/decisions/0001-ssh-host-key-identity-policy.md` (Status line includes the gating cycle).

### 2026-09-02 · planner · unic-smart (Round 2)
Two plan-review mandates land in this task. (Minor 2 / Important 2) The roadmap's line-67 evidence now has a concrete citation target: TASK-BQ00-001 writes `docs/decisions/_bq00-evidence.md`; your ADR cites it by path and duplicates the enumerated names into a "Pagination + cancellation method names" section — including the previously owner-less **cancellation return shape** (what `job.cancel()` actually returns; object vs void matters for BQ-01's cancel wiring). (Minor 1 partial) Add a "Grid continuation mapping" paragraph (3-5 sentences): `BigQueryPage.pageToken` maps onto the grid's existing continuation contract — `RunResult.batched` (src/adapters/types.ts:78) plus the panel's `loadMore` → `runner.loadMore(index)` path — VSDB owning jobRef + opaque token, client stateless per page. This is a PAPER deliverable: `resultBatcher.ts` and `resultsPanel.ts` are read-only this cycle, so the mapping must live entirely in the ADR prose. Verification commands above now grep for both.

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: N/A — docs-only; first-pass content checks are below
Verification Output:
```
=== Section 1 ===
ADR exists
version recorded
continuation ownership
cancellation mapping
scalar conversion
cost policy field
IAM section
deferral recorded
ADC recipe
evidence file cited
method names enumerated
grid mapping present
evidence file exists (written by TASK-BQ00-001)
README row
=== Section 2: typecheck + compile ===
> vsdb@1.45.0 typecheck
> tsc --noEmit
  dist/webview.js.map    4.0mb
  dist/webview.css.map  65.2kb
⚡ Done in 148ms
  dist/extension.js      5.3mb ⚠️
  dist/extension.js.map  9.3mb
⚡ Done in 154ms
esbuild: build complete
=== Section 3: full test suite ===
Test Files  222 passed | 1 skipped (223)
     Tests  3209 passed | 2 skipped (3211)
   Duration  17.62s
```
git diff --stat: docs/decisions/README.md | 1 +/1 insertion (and untracked new ADR); src/ untouched.
Status: PASS
Note: All ten required ADR sections (§1 client method/version, §3 continuation ownership, §4 cancellation mapping, §5 safe scalar conversion, §6 selected config fields, §7 required IAM, §8 Storage Read API deferral, §9 manual ADC smoke recipe, §10 pagination+cancellation method names, §11 grid continuation mapping) are present; ADR cites `_bq00-evidence.md` and the four enumerated names; test floor 3189|2 preserved (3209 passed).
