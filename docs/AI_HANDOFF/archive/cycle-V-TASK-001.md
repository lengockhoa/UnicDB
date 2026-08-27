# TASK-001 — SQL TextMate injection grammar + package.json contribution

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Coloring, Layer 1)

## Goal

Ship a TextMate **injection** grammar layered on top of VS Code's built-in `source.sql`
so VSDB adds dialect scopes the built-in grammar misses (`ILIKE`, `RETURNING`, `TOP`,
`OFFSET … FETCH`, `[bracket]` / `` `backtick` `` quoted identifiers) without replacing —
and therefore without regressing — the built-in grammar.

## Target Files

- `syntaxes/vsdb-sql-injection.tmLanguage.json` **(new)** — the injection grammar. Root
  keys: `scopeName: "source.sql.vsdb"`, `injectionSelector: "L:source.sql"`, `patterns: []`.
- `package.json` — add `contributes.grammars` (one entry, `injectTo: ["source.sql"]`,
  `path: "./syntaxes/vsdb-sql-injection.tmLanguage.json"`, `scopeName: "source.sql.vsdb"`).
  Do **not** add `contributes.languages` for `sql` — VS Code already owns that languageId
  and re-declaring it can shadow the built-in grammar. `scripts` / `dependencies` untouched.
- `src/__tests__/sqlGrammar.test.ts` **(new)** — tests below.

`.vscodeignore` is **not** edited: it lists `src/**`, `webview/**`, `tests/**`, `docs/**`,
`scripts/**` but not `syntaxes/**`, so the new folder ships in the `.vsix` by default. The
test below asserts that stays true.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `package.json contributes a grammar injected into source.sql` | `contributes.grammars` has length ≥ 1; entry `.injectTo` contains `"source.sql"`; `.scopeName === "source.sql.vsdb"` | read `package.json` from disk |
| 2 | unit (happy) | `grammar file exists at the contributed path and parses as JSON` | `fs.existsSync(path)` true; `JSON.parse` does not throw; parsed `.scopeName` equals the contributed `scopeName` | path read out of `package.json`, not hardcoded |
| 3 | unit (happy) | `grammar declares at least the VSDB dialect keywords` | joined `match` strings contain `ILIKE`, `RETURNING`, `TOP`, `FETCH` | parsed grammar |
| 4 | edge (regex safety) | `no pattern matches the empty string` | for every `match`/`begin` regex `r`, `new RegExp(r).exec("")` is `null` | an empty-matching rule makes the TextMate engine spin — this is the classic grammar hang |
| 5 | edge (packaging) | `.vscodeignore does not exclude the syntaxes folder` | `.vscodeignore` contents contain no line matching `/^syntaxes/` | read `.vscodeignore` from disk |
| 6 | edge (non-regression) | `no contributes.languages entry claims languageId "sql"` | `contributes.languages` is `undefined`, or no entry has `id === "sql"` | guards against shadowing VS Code's built-in SQL language |

Case 4 and case 5 are different kinds on purpose: 4 is a runtime-hang boundary inside the
artifact, 5 is a packaging/distribution failure outside it.

## Test Files

- `src/__tests__/sqlGrammar.test.ts` — all six cases. Sits beside the existing
  `src/__tests__/releaseHygiene.test.ts`, which already uses the read-from-disk style
  (`repoRoot = path.resolve(__dirname, "..", "..")`, `readJson`) — mirror it.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/__tests__/sqlGrammar.test.ts
npm test
```

`npm run compile` is not required: this task adds no TypeScript to any bundle.

## Acceptance Criteria

- [ ] `syntaxes/vsdb-sql-injection.tmLanguage.json` exists and `JSON.parse` succeeds.
- [ ] `package.json` `contributes.grammars[0].injectTo` includes `"source.sql"`.
- [ ] No `contributes.languages` entry with `id === "sql"` was added.
- [ ] All 6 Test Cases PASS.
- [ ] `npm run typecheck` clean.
- [ ] `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.
- [ ] `CHANGELOG.md` note deferred to the cycle-close docs sync (user-facing feature is
      only complete once TASK-002/003 land).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces:
  - grammar scope name `source.sql.vsdb` — TASK-002's semantic token types layer on top of
    these TextMate scopes; TASK-002 must not assume this grammar exists at runtime.
  - Token scope names TASK-003's webview tokenizer mirrors for visual consistency:
    `keyword.other.vsdb.sql`, `string.quoted.single.sql`, `constant.numeric.sql`,
    `comment.line.double-dash.sql`, `entity.name.function.vsdb.sql`.

---

## Discussion

### 2026-08-25 · planner · bao-opus

Verified before writing: `package.json` `contributes` currently has exactly
`commands, keybindings, menus, views, viewsContainers, viewsWelcome, configuration` — no
`grammars`, no `languages`. So this contribution is genuinely new, not an edit.

`syntaxes/` does not exist yet — create the directory. `.vscodeignore` was read in full;
it has no `syntaxes` line, so no edit is needed there, but test case 5 pins that.

→ @executor: resist the urge to also register `.pgsql` / `.tsql` file extensions. That is
a `contributes.languages` change and case 6 will fail it. Scope is injection only.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (first run of the new test, before any implementation — `npx vitest run src/__tests__/sqlGrammar.test.ts`):

```
 FAIL  src/__tests__/sqlGrammar.test.ts > vsdb sql injection grammar (TASK-001) > package.json contributes a grammar injected into source.sql
AssertionError: contributes.grammars must have at least one entry: expected 0 to be greater than or equal to 1
 ❯ src/__tests__/sqlGrammar.test.ts:54:8
        |
   53|     expect(grammars.length, "contributes.grammars must have at least o…
   54|       .toBeGreaterThanOrEqual(1);
        |        ^
   55|
   56|     const entry = grammars[0];

 FAIL  src/__tests__/sqlGrammar.test.ts > vsdb sql injection grammar (TASK-001) > grammar file exists at the contributed path and parses as JSON
TypeError: Cannot read properties of undefined (reading 'path')
 ❯ src/__tests__/sqlGrammar.test.ts:66:18
   66|     expect(entry.path).toBeTruthy();

 FAIL  src/__tests__/sqlGrammar.test.ts > vsdb sql injection grammar (TASK-001) > grammar declares at least the VSDB dialect keywords
Error: ENOENT: no such file or directory, open '.../syntaxes/vsdb-sql-injection.tmLanguage.json'
 ❯ readJson src/__tests__/sqlGrammar.test.ts:20:18

 FAIL  src/__tests__/sqlGrammar.test.ts > vsdb sql injection grammar (TASK-001) > no pattern matches the empty string
Error: ENOENT: no such file or directory, open '.../syntaxes/vsdb-sql-injection.tmLanguage.json'

 Test Files  1 failed (1)
      Tests  4 failed | 2 passed (6)
```

RED confirmed for the 4 implementation-gated cases. The 2 already-passing cases are the packaging guard
(case 5, `.vscodeignore` correctly has no `syntaxes` line) and the no-languages guard (case 6,
`contributes.languages` is undefined) — both pin pre-existing correct state, so they are expected to
pass before implementation.

Verification Output:

1. `npm run typecheck` → exit 0, clean (`tsc --noEmit`, no errors).
2. `npx vitest run src/__tests__/sqlGrammar.test.ts`:
```
 ✓ src/__tests__/sqlGrammar.test.ts  (6 tests) 3ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```
3. `npm test` (after `npm run compile` — the fresh worktree had no `dist/`, and two bundle tests
   read `dist/*.js`; per PLAN §5 compile must run first):
```
 Test Files  96 passed | 1 skipped (97)
      Tests  1333 passed | 2 skipped (1335)
```
Baseline 1327 passed / 2 skipped / 0 failed; +6 new tests, 0 regressions.

Status: PASS

Note: `npm run compile` was required as a prerequisite for `npm test` only because this isolated
worktree had no prebuilt `dist/`; TASK-001 itself adds no TypeScript to any bundle and `compile`
completed without errors. Grammar regexes are intentionally kept JS/Oniguruma-dual-compatible
(no `(?i)` inline flags) so the no-empty-match test can construct each pattern with `new RegExp(r)`;
dialect keywords are therefore matched in their conventional uppercase form. `entity.name.function.vsdb.sql`
is emitted by a generic identifier-before-paren pattern to honor the Interfaces "Produces" contract
with TASK-003. `package-lock.json` unchanged by `npm ci`/`npm install` (no dependency drift). No
`contributes.languages` added. No git add/commit/push performed.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN: PASS
  command: npm run typecheck && npx vitest run src/__tests__/sqlGrammar.test.ts
  result: 6 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Clean delivery. Grammar has 8 non-empty patterns covering all required VSDB dialect tokens; regex safety confirmed; no contributes.languages re-declaration; vscodeignore correctly ships syntaxes/. All 6 test cases assert real behavior.
