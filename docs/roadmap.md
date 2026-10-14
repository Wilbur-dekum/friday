# Roadmap

Open work, sequenced for execution. Items get deleted as they ship. Architectural decisions live in `docs/decisions.md` (ADRs); user-facing usage in `docs/architecture.md`, `docs/chat-ux.md`, `docs/mobile-ux.md`, and `docs/mcp.md`. Schema reference: `packages/shared/src/db/schema.ts` (Drizzle).

## Cloud / SaaS

Friday becomes a SaaS product: cloud-first, one **Deployment** (a container stack
plus Postgres) per customer **Organization**, several **User**s collaborating
through one shared Friday, reachable over multiple **Transport**s. Local install
demotes to a dev fallback on the same image.

The work lives in its own two documents rather than here, because it is a project
rather than a list of open items:

- [cloud-plan.md](cloud-plan.md) — the epics, their order, and what runs in
  parallel. Read first.
- [cloud-tickets.md](cloud-tickets.md) — the canonical verbose plan: all 50
  tickets (`FRI-2001`–`FRI-2051`), each carrying the constraint it has to
  respect. Mirrored into Friday's `tickets` table for working; the file wins if
  they disagree.

Rationale and rejected alternatives are ADR-050 — ADR-054 in
[decisions.md](decisions.md); vocabulary is in [CONTEXT.md](../CONTEXT.md).

## Watch list (no immediate trigger)

Tracked here for visibility. Promote to a phase when usage demands it.

- **Per-capability permissions** (the deferred option (c) from the Role design): a capability set per **User** checked at the MCP tool gate, replacing the coarse `admin | member` **Role**. Promote when a customer needs finer authority than two roles — the likely first ask is "members may use `friday-secrets` for _these_ secrets" or "members may spawn builders against _these_ repos."
- **Per-thread Conversations** (the rejected option (c) from the Transport design): a durable main **Conversation** per **User** plus ephemeral per-external-thread Conversations summarized back into it. Promote if the **Transport** layer turns out to hold a single self-contained topic per thread more often than not — i.e. if one continuous per-User thread proves to interleave unrelated work badly enough to hurt relevance or token cost. Needs a promotion/summarization mechanism that (a) does not.
- **Streaming Bash stdout in chat** — vs. the current "summary + DB-fetch on expand" model. Acknowledged interesting; not now.
- **Friday Apps v2** (ADR-021 v2 column): HTTP route mounting under `/apps/<id>/*` for TRMNL-style external surfaces; dedicated dashboard route with per-app drill-down; destructive UI actions behind confirmation modals; port the existing kitchen bare agent + meal memory entries + scheduled weekly schedule onto the platform once the MVP has lived a release cycle.
- **Friday Apps v3**: capability declarations (`network[]`, `filesystem[]`, `exec[]`) backed by sandbox-exec / landlock enforcement, gated on family-visibility landing. Trust-by-discipline holds at single-user scale until that point.
- **Declarative app migrations** (`memory.retag` etc.). Defer until an app demands one; the MVP's atomic install/uninstall is enough for the foreseeable future.
