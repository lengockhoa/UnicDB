# VSDB — Project Context

## Stack

- Runtime: Node v22.22.1 | OS: darwin | PM: npm
- Frontend: false | Backend API: false | PostgreSQL: false
- Provider: true

## Architecture

<!-- 3-5 sentences describing what this system does, its main components, and how they connect. -->
<!-- Fill in after initial setup. If empty, AI must read source carefully — no shortcuts. -->

## Key Modules

<!-- path/ — what it is responsible for — entry point if non-obvious -->
<!-- Example: src/auth/    — JWT + session management        — auth.service.ts -->
<!-- Example: src/orders/  — core business logic             — orders.service.ts -->

## Data Flow

<!-- How data moves through the system end-to-end. -->
<!-- Example: HTTP request → auth.guard → controller → service → repository → PostgreSQL -->
<!-- Include: external APIs called, message queues, background jobs, key middleware. -->

## Business Rules & Domain Constraints

<!-- Rules that CANNOT be violated. Non-obvious logic that isn't clear from the code. -->
<!-- Example: "Orders cannot be deleted — only cancelled. Status machine: draft→confirmed→cancelled." -->
<!-- If this section is empty, AI must not assume business rules from code patterns alone. -->

## Known Dangerous Areas

<!-- Complex, fragile, or bug-prone code. Flag before AI touches these areas. -->
<!-- Example: src/pricing.ts — complex discounting logic, 2 past bugs, always run full test suite. -->

## Delivery Profile

- Primary workflow: natural-language AI tooling installed by UKit
- Shared adapters: Claude Code, OpenAI Codex, Antigravity
- Change policy: smallest correct change with clear verification

## Session Start Routine

1. Run `ukit memory recall "<current task>"` for non-trivial work; reuse relevant `## Previous Context` before asking the user to restate prior decisions
2. Read `docs/MEMORY.md` — architecture decisions, active constraints, known bugs
3. Read `docs/AI_HANDOFF/ACTIVE.md` when continuing cross-AI planning, task breakdown, or task implementation handoff work
4. Read `docs/CODE_MAP.md` if it exists — structural navigation index
5. Use the installed source-code index / routed helpers to localize the smallest relevant file + test set first
6. Scan recent `docs/WORKLOG.md` entries if continuing prior work
7. Verify understanding against source before acting — **docs orient, source is truth; keep the index-first workflow intact**
