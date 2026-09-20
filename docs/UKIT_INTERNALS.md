# UKIT Internal Orchestration

Loaded on demand — root contracts carry the compact contract; this file carries the detail.

Everything below is internal orchestration: end users only ever need `ukit install` plus
natural language. None of it adds commands or user-facing surface.

## Long-Run Continuity — detail

The root contract carries the LAND/DEFER/DELEGATE summary. This section mirrors what UKit
hooks inject at runtime on Claude Code and omp; on harnesses without hooks (Codex, OpenCode)
the root contract is the only carrier — keep both in sync with
`.claude/hooks/context-window-guard.sh`.

- Near token-cap: **LAND one thing** — finish the smallest in-flight item end-to-end
  (edit + verify, ≤3 tool calls) and report it done. **DEFER the rest** — one line per
  remaining step into `docs/STATUS.md`, or split into bounded `docs/AI_HANDOFF/` tasks.
  **DELEGATE** broad work (searches, big reads, multi-file edits) to subagents whose tool
  output lives in their own windows. Only then compact.
- After any compact or handoff: do not reread pre-compact context — continue from the
  persisted disk state, delegate broad work, keep replies short. If the first turn after a
  compact still sits at ≥60% of the cap, stop rereading immediately and recover by
  delegating or starting a fresh session from the disk state; do not burn the window again.
- A run ends only on completion evidence, a genuine blocker, or a user-only action — and
  every such stop names its reason in the final reply.

## Index-First Loop — helper commands

- `node .claude/ukit/index/refresh-index.mjs` — refresh when `.cache/index/` is stale or
  missing; fallback: `node .claude/ukit/index/build-index.mjs`.
- `node .claude/ukit/index/query-index.mjs "<error|symbol|path>"` — likely files.
- `node .claude/ukit/index/triage.mjs "<error signature>"` — bug signatures.
- `query-index` and `resolve-context` print an `outline:` block (`line: signature`) for the
  top suspects — jump straight to the relevant region with `Read(file, offset=<line>)`
  instead of reading the whole file.

## Automatic Skill Activation — route memory

- If docs work is detected, read `.claude/skills/docs-quality/SKILL.md` when present.
- Reuse `.claude/ukit/skill-router-state.json` when it already carries compact route memory.
- If shared route state already includes `previous-context` or `recent-output`, reuse those
  first.
- Prefer routed context and routed verification over ad-hoc broad reading.

## Internal Helper Policy — detail

- Prefer `node .claude/ukit/index/route-task.mjs "<prompt>" [--tool-command <cmd>]
  [--target <file>]` when routing is complex or ambiguous.
- Prefer `node .claude/ukit/index/resolve-context.mjs ...` for indexed related-file context.
- Prefer `node .claude/ukit/index/verify-context.mjs ...` for concrete verification lanes.
- Do not ask normal contributors to memorize `ukit doctor`, `ukit diff`, `ukit uninstall`,
  or `ukit index ...` unless they explicitly need maintainer/debug help.
- If the workspace needs a refresh, prefer telling them to rerun `ukit install`.

## Skill Quality (maintainer-only)

- When editing a template skill/agent under `templates/.claude/`, read
  `.claude/skills/skill-quality/SKILL.md` before shipping the change.

## Shared Runtime — detail

- Shared runtime state lives in `.ukit/storage/`.
- Treat `.ukit/storage/config.json` as the source of runtime toggles for compact, token
  pipeline, router, memory, validation, and Safe Patch behavior.
- Reusable cache/compact/output state lives in
  `.ukit/storage/cache/prompt-cache.json`,
  `.ukit/storage/cache/compact-history.json`,
  `.ukit/storage/cache/compact-pressure.json`,
  `.ukit/storage/cache/output-history.json`, and preserved raw tool outputs under
  `.ukit/storage/cache/tee/`.
- If an older repo still has a visible `ukit/` runtime root, rerun `ukit install`; UKit
  should migrate the shared runtime into hidden `.ukit/` when safe.
- Maintainers can inspect runtime state with `ukit status` and `ukit memory export`, but
  normal teammates should still only need `ukit install`.
- Threshold-based compact pressure is internal orchestration; do not expose it to users.
- For Codex Desktop long sessions, UKit can use soft auto-compact handoffs. Default
  `compact.codexContext.compactTarget=150` means about 150 compact handoff lines
  (120-150 preferred, hard max 170), not 150 tokens.

## Safe Patch — internal helper

- Use `node .claude/ukit/index/safe-patch.mjs` internally when normal Edit/Write may
  normalize bytes or when anchor-based matching is needed.
- Safe Patch is internal orchestration: normal users still only need `ukit install` and
  natural language.

## Context + Verification Budget — detail

- `docs/STATUS.md`: stale status is orientation only.
- `docs/TASKS.md`: safely clean exact duplicates/completed overflow by default without
  deleting unfinished human-authored tasks.
- `docs/WORKLOG.md`: follow the Budget Rules at the top of the file; archive oldest entries
  to `docs/WORKLOG_ARCHIVE.md` when over limits.
- Follow routed verification policy: targeted first, widen only when risk/shared scope
  justifies it, ask before blanket broad runs.

## Living Status Workflow — detail

- `docs/STATUS.md` captures compact current state, active work, debug threads, blockers,
  verification, and next candidates.
- For "what next?" / "continue" prompts without a concrete target, use `next-step` and show
  a freshness cue before relying on the status file.
- For concrete debug/implementation/review prompts, keep the concrete workflow primary even
  if the user asks for an approach or next step.
- After meaningful work, use `update-status`; skip trivial/no-state-change tasks and avoid
  transcript-style noise.
- `docs/TASKS.md` is a local AI task queue: prefer `Ready for AI` when asked to pick queued
  work, and clean duplicates/prune `Done Recently` safely when reading/updating it.

## Small-Task Maintainer — detail

- UKit may route low-risk internal decisions to the `ukit-small-task-maintainer` subagent
  using `subagents.smallTaskModel` (default `unic-lite`).
- Use it for safe/reversible UKit chores: cleaning `docs/TASKS.md`, queued-task
  classification, fast-vs-slow/safe-vs-risky lane decisions, skill-routing/step-budget
  hints, agent context-budget decisions, compact/summary decisions, docs/status
  summarization, auto-triage, queue maintenance, and small workspace cleanup.
- Run it as a sidecar/parallel lane only; do not block, replace, or slow the user task.
- If the small-task lane sees security, risky/shared code, release/publish, data-loss,
  architecture, deep-reasoning risk, weak context, or quality risk, it hands back to the
  main model.
- This is optional internal orchestration config from `.ukit/storage/config.json`; never
  turn it into an end-user workflow.
- Always preserve the CoDev priority: quality > safety > speed > token discipline.

## Post-Edit Sidecar Review — detail

- If routed state's `routeSummary.line` includes a `review=code-reviewer(diff)` segment, a
  `local-build` or `shared-edit` task qualifies for a non-blocking second opinion — this
  exists because the daily-flow executor model can miss edge cases.
- Only launch it once write evidence AND verification evidence already exist for the task
  (never before; never as a substitute for either).
- Launch the `code-reviewer` agent (see the harness table under 3-Tier Model Routing) with
  `REVIEW_TARGET_TYPE=diff`, in the background, on the `smart` tier per
  `subagents.diffReviewModel`. Do not wait for it — continue and report the task as done
  using the normal completion rules.
- Its findings are advisory only: never re-open, block, or delay the already-reported
  completion on their account. Surface them to the user as a follow-up note if/when they
  arrive.
- This is internal orchestration — end users never invoke it directly; `ukit install` plus
  natural language remains the whole surface. No new commands.

## Selective Subagent Policy — detail

- Good delegation triggers:
  - noisy side lanes (broad logs/search/test output)
  - 3+ independent failures/files/checks
  - explicit batch/plan execution
  - broad implementation/debug lanes that can return a concise summary
- If route memory includes `delegate=<lane>`, treat it as an internal hint after any
  required indexed-context step.

## 3-Tier Model Routing — full detail

UKit routes tasks to one of three model tiers based on task complexity. The main session
model never changes mid-turn: a tier only takes effect when work is handed to an agent
whose own definition binds that model.

| Tier | Generic alias | Claude model | Typical tasks |
|------|--------------|--------------|---------------|
| lite | `unic-lite` | claude-haiku | Reads, git queries, bash summaries, small doc edits |
| code | `unic-code` | claude-sonnet | Normal coding, local fixes, shared edits, builds, debugging, impact mapping |
| smart | `unic-smart` | claude-opus | Release review/audit, and escalated deep reasoning after repeated failure |

### Contract-to-tier mapping

| Contract | Tier |
|----------|------|
| `tiny-fix` | lite |
| `local-fix`, `local-build`, `shared-edit`, `find-cause`, `map-impact` | code |
| `review-release` | smart |

### How a tier is actually bound

| Harness | Agent definitions | How to launch one |
|---------|-------------------|-------------------|
| Claude Code | `.claude/agents/*.md` (`model:` frontmatter) | Agent tool, `subagent_type: "<name>"` |
| omp | `.omp/agents/*.md` (`model: "@lite"` / `"@code"` / `"@smart"` / `"@vision"`, resolved through `modelRoles` in `.omp/config.yml`) | task-agent `<name>` |

When a task's contract maps to a tier other than the current session model, hand it to the
matching agent instead of doing it inline. Doing everything inline is exactly what makes
UKIT behave as if it only had one model — the tier table above has no effect on its own.

### Escalation rule

When the same file or symbol fails `debugLoopThreshold` (default: 2) times in one session,
UKit routes the next attempt one tier higher (capped at `smart`). Config:
`orchestration.escalation` in `.ukit/storage/config.json`.

### Vision lane (capability, not a cost tier)

`unic-vision` is a **capability lane**, not a fourth cost tier — it is orthogonal to
lite/code/smart above and never appears as a row in the tier table. Whether a mapping can
read images is a capability fact, not a provider fact: a mapping that has not **verified**
native vision must never guess at image contents — choose native-first when verified,
otherwise route to the specialist.

- **Gateway detection**: UNIC routing for a Claude Code session is decided ONLY by what
  changes Claude Code's own outbound endpoint — `ANTHROPIC_BASE_URL` (env var, or the
  `env.ANTHROPIC_BASE_URL` key in project/home `.claude/settings.json`) containing
  `unicjsc.com`. Other tools' configs — Codex `config.toml`, Kilo `secrets.json`, or an
  `OPENAI_BASE_URL` env var — describe a different tool's endpoint entirely and never
  decide this session's routing.
- **Advisory routing (no hard block)**: when an image reaches the prompt, the vision router
  reminds the session to have `ukit-vision-analyst` analyse it before relying on its
  contents. Edits are **never blocked** — correctness relies on the model routing images
  to the analyst instead of guessing.
- This is internal orchestration — end users never invoke a vision command directly;
  `ukit install` plus natural language remains the whole surface. No new commands.

## DuraOne — detail

- Khi active: luôn đọc `.claude/skills/duraone/SKILL.md` trước khi code.
- References:
  - `.claude/skills/duraone/references/frontend.md`
  - `.claude/skills/duraone/references/backend.md`
  - `.claude/skills/duraone/references/sql.md`
  - `.claude/skills/duraone/references/workflow.md`
- Khi không active: dùng generic coding standards + project-specific patterns từ index.
