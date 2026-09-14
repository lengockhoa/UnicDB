# Prompt Caching — guidance for UKit projects

Prompt caching is a **prefix match**: a provider can reuse the computation of an input prefix
when a later request reproduces that prefix byte-for-byte. UKit cannot control the transport or
the provider cache engine, but it *does* control the instruction, skill, tool and hook-injected
content it renders. This file ships with UKit so every installed project gets the same rules for
keeping that content deterministic and stable. Read it on demand — it is deliberately not loaded
into every session.

## Why stable context matters

- Cache reuse is **reported**, not controllable. A `cache_read` counter (or a vendor equivalent)
  proves the provider *reported* a reuse; it never proves which layer served it.
- Three mechanisms must never be conflated: the **provider prompt cache** (reuses input
  computation), a **local tool-result cache** (the host reuses a still-valid result), and a
  **response cache** (the application replays a stored answer).
- Three counts must never be conflated: a **logical model turn**, a **client HTTP attempt**, and a
  **tool execution**.
- The rules below hold even if no cache capability exists behind your provider, because they
  govern content UKit itself renders.

## CTX rules — MUST

| ID | Rule | What it means in practice |
|---|---|---|
| CTX-01 | Same logical input and config produce the same segment bytes | Render owned blocks deterministically; no ordering that varies run-to-run |
| CTX-02 | Preserve instruction/user/tool roles and conversation order | Never move a user ask into system or reorder history to lengthen a prefix |
| CTX-03 | Keep all tool IDs and required native continuation state intact | Never strip tool-call IDs or reasoning/continuation fields to shrink a request |
| CTX-04 | Do not inject clock/random IDs into static instructions | Static blocks carry no date, UUID or counter; volatile values go in the tail |
| CTX-05 | Every summary/compaction creates a new context epoch | Compaction is a decision with a cost; when it happens it starts a new epoch |
| CTX-06 | Never change data or code to match the cache | Cache optimization never edits content semantics — correctness over prefix |
| CTX-07 | Do not self-send a field the adapter has not confirmed as supported | Optional cache params only when capability is verified; HTTP 200 is not proof |
| CTX-08 | Tool-result cache reuse only when freshness/dependency is valid | Local reuse needs a freshness predicate and dependency fingerprint, not just a query match |
| CTX-09 | Never treat missing usage as zero | Missing cache counters are unknown plus lowered coverage, never a reported miss |
| CTX-10 | Never exceed existing instructions/permissions to cut calls | Reducing tool calls never means skipping a required check or test |

## Never do

- Never sort messages or reasoning blocks alphabetically.
- Never trim code literals, signed content, or data where whitespace is meaningful.
- Never rewrite native reasoning/signature/encrypted continuation fields.
- Never move a user request into system to lengthen the stable prefix.
- Never promote untrusted documents or tool output to the developer/system role.
- Never hash one text and assume every occurrence shares the provider cache.
- Never add a timestamp just to log — keep log metadata outside model-visible content.

## Runtime tool-call policy (condensed, guidance only)

This is guidance for how an assistant should decide when to call tools. It is **not** a rigid
"always at least N tools" or "max N tools" rule, and UKit does not change any default behavior
on its basis.

1. Before calling a tool, decide which data is still missing to finish the request.
2. Reuse evidence you already hold if it is still valid; check the version before reuse.
3. Batch independent reads when the interface supports it.
4. For dependent actions, wait for the needed result before deciding the next step.
5. Prefer scoped queries with enough output to verify.
6. If a result was truncated or insufficient, widen deliberately.
7. On tool error, distinguish parameter error, transient error, and unknown state.
8. After a change, run the check appropriate to the risk and the repo's requirements.
9. When the completion condition is met, return the result — check further only for specific
   remaining risk.

## Vendor cheat sheet

The sections below describe how each upstream vendor documents its own caching. They are
**reference material only** — see "Upstream docs are not provider guarantees" below. Provider
minimums and rates change; treat the shapes here as orientation and **verify against the current
official docs** (links in each section) before relying on a number.

### Anthropic

- **Mechanism:** explicit cache breakpoints (`cache_control: {"type": "ephemeral"}`) on cacheable
  content blocks; a single top-level marker enables automatic caching on the last eligible block.
- **Minimum cacheable size:** model-dependent, roughly 512 to 4096 input tokens; shorter prompts
  are silently not cached.
- **Discount shape:** cache reads are billed at a small fraction of the normal input rate; cache
  writes carry a premium; an optional longer TTL costs more to write.
- **Docs:** https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching ·
  https://docs.anthropic.com/en/docs/about-claude/pricing

### OpenAI

- **Mechanism:** implicit (automatic) caching; recent models also accept explicit cache markers,
  and a prompt cache key can steer routing or cache accounting.
- **Minimum cacheable size:** roughly 1024 visible input tokens on recent models; varies with
  request settings on older ones.
- **Discount shape:** cached reads are heavily discounted relative to input; cache writes are
  billed at a modest premium on recent models and carry no extra write charge on older ones.
- **Docs:** https://developers.openai.com/api/docs/guides/prompt-caching

### DeepSeek

- **Mechanism:** automatic, best-effort prefix caching; a cached prefix is an indivisible unit, so
  partial overlap does not hit.
- **Minimum cacheable size:** not documented.
- **Discount shape:** a separate lower per-model cache-hit rate versus the cache-miss rate.
- **Note:** with tools present, reasoning content must be passed back on every later request.
- **Docs:** https://api-docs.deepseek.com/guides/kv_cache

### GLM

- **Mechanism:** implicit caching triggered by content similarity; no explicit create or
  invalidate API is documented.
- **Minimum cacheable size:** not documented.
- **Discount shape:** a separate per-model cached-input rate, not a universal ratio — do not
  assume a fixed percentage.
- **Docs:** https://docs.z.ai/guides/capabilities/cache

### MiniMax

- **Mechanism:** passive automatic prefix caching, plus explicit Anthropic-compatible
  `cache_control` breakpoints on cacheable blocks.
- **Minimum cacheable size:** caching applies from roughly 512 tokens upward.
- **Discount shape:** explicit cache writes are billed at a premium and reads at a fraction of
  input; passive cache writes carry no additional charge.
- **Docs:** https://platform.minimax.io/docs/api-reference/text-prompt-caching.md

## Upstream docs are not provider guarantees

A vendor documenting a cache feature does **not** mean the gateway or route you actually use
forwards it, returns the same usage fields, or bills it the same way. Treat every statement about
cache behavior behind a gateway as a hypothesis, not a guarantee: verify cache parameters and
usage counters against the raw response of the exact endpoint you call, and against the current
official docs linked above. If a usage counter is absent, it is **unknown** — never a reported
zero (CTX-09). When project information changes mid-session, prefer correctness over a preserved
prefix: send the new version and accept whatever cache invalidation follows.
