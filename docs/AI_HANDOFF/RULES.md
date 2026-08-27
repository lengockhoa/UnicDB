# Handoff Rules

## Token Budget (MANDATORY)

- **Combined handoff reads must stay under 200 lines per request.**
- Read order: `ACTIVE.md` (if needed) → `INDEX.md` (scan tasks) → single `tasks/TASK-xxx.md` (implement one task).
- Do NOT read `RULES.md` every request — only when you need flow clarification.
- Do NOT read multiple task files in one request.
- If ACTIVE.md + INDEX.md + task file would exceed budget, read only the task file.
- Auto-compact: if any **state file** (`ACTIVE.md`, `INDEX.md`, or any single `tasks/TASK-xxx.md`) exceeds 80 lines, trigger `clear handoff` / split task. `PLAN.md` and `RULES.md` are reference/spec — exempt.

## How Human Submits Ideas

- Natural language is enough: `ukit:handoff`, `collect ideas`, `split into tasks`, `put into handoff`.
- If request is already a concrete task (clear file/logic/output, small enough to do now), bypass handoff and execute directly.
- If request is broad/ambiguous/multi-step, use handoff.

## Hard rule — All work stays in `docs/AI_HANDOFF/`

All AI communication inside the handoff runs ONLY through files under `docs/AI_HANDOFF/`:

- `PLAN.md` — brainstorm + global Test Plan (Phase 1).
- `INDEX.md` — task table + status (read/write by every phase).
- `tasks/TASK-xxx.md` — living record for each task: Goal + Test Cases + Verification + Executor Report + Reviewer Verdict + **Discussion thread**.
- `ACTIVE.md` — snapshot of the current cycle.
- `archive/` — past cycles.

**Forbidden**: AI send questions/comments through a different chat tool, a commit message, or any file outside this directory. Reason: cross-tool/cross-subagent synchronization only happens via files. An AI that does not read this folder is not participating in the handoff.

### Discussion thread (AI-to-AI comments)

When a phase needs to ask back / push back / suggest changes for another phase, the AI writes into `## Discussion` of the task file (template in `tasks/_TEMPLATE.md`). Format:

```
### <YYYY-MM-DD> · <role: planner|executor|reviewer> · <tool/model>
<content — address @planner / @executor / @reviewer when there is a specific recipient>
```

The next phase MUST read the Discussion before continuing — treat it as an inbox.

## Autonomy Model — ask once, run to completion

The handoff is designed to run **without a person watching**. Config: `.ukit/storage/config.json` → `handoff.autonomy`.

**The only asking window is at plan time.** `/ukit:handoff-create` (and the P0 step of `/ukit:handoff-fullstack`) collect every question into **one** `AskUserQuestion` call, then close the window. Answers are recorded verbatim into `PLAN.md §1` — later phases treat that as the user's words and do not ask again.

From then on, every branch has an automatic resolution:

| Situation | Automatic handling |
|-----------|------------------|
| Scope spans multiple subsystems | split into modules, plan module 1, queue the rest into `INDEX.md` |
| Plan review still reports `Issues Found` after 2 rounds | planner applies the findings and continues, recording them in the Plan Review Log |
| Two tasks in the same wave touch one file | push the second task down to the next wave (add a dependency) |
| Working tree is dirty | commit a checkpoint, then continue |
| Reviewer returns `changes_requested`/`critical_block` | enter an auto-fix round, maximum 2 rounds |
| A task still fails after 2 fix rounds | mark `blocked`, **other tasks still continue through to push** |

Only escalate to a human when: the blocker lives outside the repo (missing credentials, dead service), or a task still fails after both fix rounds. Even then, finish every other task first before reporting.

**The quality gate does not relax.** Drop the *asking the human* step, but never drop the *verification* step: TDD RED→GREEN stays mandatory, the reviewer must still be a different model from the executor, Verification Commands are still re-run, claiming DONE without fresh PASS is still forbidden.

### Run cursor — `RUN.md`

Each command updates `docs/AI_HANDOFF/RUN.md` after **every step**:

```
Command: <handoff-fullstack|handoff-implement|handoff-review>
Goal: <one sentence>
Base: <branch>
Phase: <current phase | done>
Cursor: wave <N> batch <M> — <what just finished>
Next: <exact next step>
```

`Phase:` other than `done` means a run is still in progress. Re-invoking the command will **resume from the cursor**, not re-plan, not ask. The `SessionStart` hook (`handoff-resume.sh`) reads this file and auto-injects the resume command — so compacting or losing a session mid-run does not lose the run.

### Context: never stop mid-task

- The subagent writes **the full log into the task file on disk**, returning only ≤10 lines (executor) / ≤6 lines (reviewer) to the orchestrator. Pasting logs back into the orchestrator is the #1 cause of runs dying from context exhaustion.
- End of every wave: commit, write the cursor, **collapse** that wave down to 1 line/task in working memory, then continue.
- The `/compact` request **only** goes at the end of a command, between two cycles. Mid-cycle it is strictly forbidden — all state already lives in git + `INDEX.md` + `RUN.md`, so compacting at a cycle boundary loses nothing.
- Exceeding `compact.hardCapTokens` (default 220k, sized for a 256k context window) while `RUN.md` still has a run in progress: `context-hardcap-gate` allows `compact.hardCapGraceCalls` (default 10) extra tool calls before hard-blocking. **The grace window is only for landing** — finish the in-progress edit, commit, write the cursor, push. No new tasks, no more file reads, no spawning agents. Once grace is spent, the gate blocks for real; the budget only resets when the real token estimate drops (a real compact happens), not per wave.
- No hook can call `/compact` — that is a client-only command. But since 2.1.3, default settings set `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = 180000` < `hardCapTokens` (220k), so **the client auto-compacts before the gate blocks**. The normal path: auto-compact fires → `handoff-resume.sh` replays the cursor → run continues, no human needed. The grace window above only remains as a safety net.
- Editing either of those two numbers requires keeping `autoCompactWindow < hardCapTokens`. Reversing them deadlocks: the gate blocks tools first → the transcript stops growing → the auto-compact threshold is never reached. `tests/core/autoCompactWindow.test.js` locks this invariant.

### Git

- `handoff-implement`: **1 commit / wave**, no push. Each wave is independently revertable.
- `handoff-review` / `handoff-fullstack`: commit additionally on every auto-fix round, then **push once** at the end. Push is silent (`Bash(git push:*)` is in `allow`); force-push is still denied.

## Handoff Flow (tool-agnostic, file-based state machine)

UKit handoff runs on **file state**. You pick any tool for each phase — Claude Code / Kilo Code / Codex / OpenCode / future tools — all are supported. UKit only cares about the **role of the model**, not the tool.

3 phases × 3 model roles:

- **Plan** — the strongest model available (reasoning model). Can run in any tool that supports planning well.
- **Execute** — a cheap-but-still-smart model (code model). Could be Kilo's code subagent, OpenCode's build agent, or Claude Code's feature-implementer.
- **Review** — **MODEL DIFFERENT from the executor** (typically a reasoning model). Could be a different tool, or the same tool but a subagent using a different model (Kilo, for example, has separate code and review subagents).

Both implementation models are valid:
- **Cross-tool**: for example Claude (plan) → Kilo (execute) → Claude (review). Bridged via files.
- **Same-tool different-subagent**: for example Kilo:plan → Kilo:code → Kilo:review, as long as the three subagents use different MODELS for their respective roles.

Each tool/subagent reads the same `INDEX.md` + `tasks/TASK-xxx.md` → picks a task by `status` → updates the status when finished.

> **Important — UKit does not enforce the model:** `handoff.executor.cheapSmartModelHint` and `handoff.reviewer.model` in `.ukit/storage/config.json` are only **labels** so you know what you INTEND to use. Which tool uses which model is your choice inside that tool's settings. UKit enforces the contract by requiring the executor to DECLARE `EXECUTOR_MODEL` in its Executor Report; the reviewer compares against itself and refuses when they match. So if in Kilo you set both the code subagent and the review subagent to the same model → the reviewer will refuse itself, never silently pass.

### Status state machine

```
brainstorm ──[plan approved]──▶ ready ──[executor pick]──▶ in_progress
                                                              ├─[PASS]──▶ pending_review
                                                              └─[FAIL]──▶ blocked
pending_review ──[reviewer]──▶ approved | approved_minor ──▶ done
                            ├▶ changes_requested ──[fix]──▶ in_progress
                            └▶ critical_block      ──[fix]──▶ in_progress
```

### 4 Phases

**Phase 1 — Idea + Plan** (smart/reasoning model)
- The human submits ideas in natural language.
- AI writes into `PLAN.md`: §1 Intent, §2 Scope, §3 Approach, **§4 Test Plan (mandatory, TDD-style)**, §5 Verification Commands, §6 Acceptance Criteria.
- This is the **only asking window** for the whole pipeline: collect every question into one `AskUserQuestion` call before writing, and record the answers into §1.
- Output: a complete PLAN.md + Planner Self-Audit. Standalone run (`/ukit:handoff-create`) stops here for human review; run inside `/ukit:handoff-fullstack` continues straight into Phase 2 — an independent plan review is the gate instead of the human.

**Phase 2 — Create Tasks (TDD-embedded, MANDATORY)** (smart/reasoning model, usually same as phase 1)
- Human approves the plan → AI splits `PLAN.md §7` into several `tasks/TASK-xxx.md` files.
- **Every TASK file MUST carry its own Test Plan**, not only point back to PLAN.md. Specifically:
  - `§ Test Cases`: a test table (type, test name, expected) for this task's slice — happy + ≥2 edge cases of DIFFERENT kinds (e.g. null/empty + boundary/concurrent, two near-identical cases do not count) + regression (when fixing a bug).
  - `§ Test Files`: the concrete path of the test file to create/modify (for example `tests/auth/login.test.js`).
  - `§ Verification Commands`: the commands the executor will run to confirm PASS. If the project already has lint/typecheck scripts → they MUST be listed here, not only the test command. If the project has none, say N/A explicitly; silently skipping is not allowed.
  - `§ Acceptance Criteria`: a checklist.

#### Test selection (which tests the Verification Commands run)

Resolution order — exactly three steps, in this order. A task's Verification Commands MUST NOT default to the full suite:

1. Target File under `src/` or `scripts/` → read `.cache/index/tests-map.json` and take the `tests` array for that `sourceFile`.
2. Target File under `templates/.claude/**` or `.claude/**` → `tests-map.json` has no coverage of these paths, so use the path convention: hooks → `tests/hooks/` + `tests/handoff/cycle*/`; manifest/settings → `tests/manifest/`; runtime `.mjs` mirrors → `tests/core/*Parity*` + `tests/index/`.
3. **Mandatory non-empty floor** — if steps 1–2 resolve to fewer than one test file, the task MUST fall back to `yarn test:release-core`. An empty selection is never permitted. This floor is a fallback for a single task's narrowed selection, not a default — most tasks resolve via steps 1–2 and never reach it.

**Wave/cycle boundary regression net** — the three steps above narrow one task's Verification Commands only; they are not a substitute for full-suite coverage. A full `yarn test` run at each wave/cycle boundary MUST happen and is the regression net for every per-task narrowed selection made under this policy. `code-reviewer.md`'s "wave-boundary full `yarn test` ... is the regression net" sentence refers to this paragraph.

- If a split task cannot ship concrete Test Cases + Test Files → that task is not yet `ready`; mark it `needs_breakdown`.
- Update `INDEX.md`: add a row for each task with status `ready`.
- This is **the last gate before code runs**: when this phase ends, the executor is allowed to pick. Inside `/ukit:handoff-fullstack`, the gate here is an independent plan review (strong model, fresh context) rather than a human — because the user has explicitly chosen to run one-shot.
- Goal: when the executor (cheap-smart model) reads the task file it immediately KNOWS which tests to write first — no inference required.

**Phase 3 — Implement + Test** (cheap-smart/code model)
- User: "execute next task" / "do TASK-001" / "implement task 1".
- Executor reads `INDEX.md` → picks a `ready` task → flips it to `in_progress` → **writes the test first → RED (paste the actual failing output, not just a confirmation claim) → implement → GREEN** → runs the Verification Commands fresh within the turn → appends `## Executor Report` (containing `EXECUTOR_TOOL`/`EXECUTOR_MODEL`/`EXECUTOR_SUBAGENT`/`RED_OUTPUT` plus verification output) at the end of the task file → flips status to `pending_review`.
- NEVER claim DONE without fresh PASS.

**Phase 4 — Review + Test** (reviewer model — DIFFERENT model from executor)
- User: "review pending tasks" / "review TASK-001".
- Reviewer reads INDEX → picks `pending_review` → reads the task file + diff → **compares model against `EXECUTOR_MODEL`, refuses when matching or unknown** → **re-runs Verification Commands fresh** (never trusting the executor) → applies the `code-review` skill → appends `## Reviewer Verdict` to the task file (verdict + findings + the reviewer model used) → changes status:
  - `approved` / `approved_minor` → allow `done`.
  - `changes_requested` → executor must fix the Important items → loop Phase 3-4.
  - `critical_block` → executor MUST fix → loop Phase 3-4.

If `handoff.reviewer.enabled=false`, Phase 4 is skipped but the reason must be logged into the task — skipping Phase 4 drops the final safety net.

## Task Gate

A task is `ready` only when it has:
- Clear target files
- Clear action
- Dependencies stated
- **Interfaces** — Consumes/Produces with real signatures (function/endpoint/type), no placeholders;
  `(none)` is valid when the task has no cross-task inputs/outputs
- **Test Plan** (PLAN.md §4) — happy path + ≥2 edge cases of different kinds (+ regression test if a bug is being fixed); or `N/A` with a reason
- Verification command (the command the executor will run) — MUST include lint/typecheck when the project already has them
- Acceptance criteria

Missing any → `needs_breakdown`, `blocked`, or `needs_human`.


## Clear Handoff

1. Archive the current cycle → `archive/cycle-NNN.md`.
2. If the archive holds > 3 files → delete the oldest, append a 1-line summary to `HISTORY.md`.
3. Reset `ACTIVE.md` to the empty template.
4. Clear `INDEX.md`.
5. Delete every file in `tasks/`.
6. Clear `PLAN.md`.

## Docs Sync

After each cycle, update only the affected docs: `WORKLOG.md`, `PROJECT.md`, `CODE_MAP.md`, `CHANGELOG.md`.
