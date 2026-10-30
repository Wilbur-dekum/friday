# Friday Architecture

Local-first, headless agent daemon with a SvelteKit dashboard exposed via Cloudflare Tunnel. Single user, multi-device. Postgres is the canonical store; Zero (by Rocicorp) is the sync engine that replicates settled state to each client's reactive cache. SSE survives as a narrow side-channel for live-turn token deltas. See ADR-023 and ADR-024.

## Goals

- **Headless daemon, dashboard-primary.** The daemon is a pure API tier. The dashboard is the primary interface, with a single persistent chat with Friday at `/`.
- **Local-first with public reachability.** Runs on the user's machine; reachable from anywhere via CFT. No third-party services beyond the Claude SDK and learned integrations (Linear, future GH Issues, etc.).
- **Single user, multi-device.** Phone, tablet, laptop. One identity, one chat thread, shared memory across devices.
- **Full mobile usability.** Every page is fully usable on phone and tablet — not just responsive cosmetics.
- **Markdown-first content.** System prompts, identity, skills live as markdown files, not multi-line strings in TypeScript.
- **TypeScript top-to-bottom**, ESM, strong typing, monorepo (pnpm workspaces + Turborepo).
- **Postgres-backed persistence.** Host-installed Postgres (Homebrew + `brew services`); Friday owns a dedicated database + role within that install. Replaces the original SQLite design (ADR-001 → ADR-023).
- **Local-first clients with Zero.** Each browser/PWA holds a reactive cache (Zero, IndexedDB-backed); `zero-cache` sidecar tails Postgres logical replication and serves clients over WebSocket via the dashboard reverse proxy. Live token deltas continue to ride a narrow SSE side-channel (ADR-024).

## Non-goals (v1)

- Slack as an interface or output. (Future integration package possible; not v1.)
- Multi-tenant / multi-user identity.
- 2FA, passkey, social login. (Future BetterAuth additions.)
- Cloudflare Access edge layer, rate limiting. (Future hardening.)
- Multi-profile / per-branch boot isolation.
- Math (KaTeX) and Mermaid rendering. (Plugin slots ready; activation in v2 — see `docs/roadmap.md`.)
- Migration of old Friday's data. Greenfield means greenfield.

## Topology

```
                       Cloudflare Tunnel (public)
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  SvelteKit Dashboard   │ ◄── BetterAuth (in-process)
                    │   (adapter-node)       │
                    │  /zero         ─ WS proxy → zero-cache
                    │  /api/sync/refresh ─ Zero JWT mint
                    │  /api/events   ─ SSE proxy → daemon
                    │  /api/mutators ─ Zero push-url
                    │  /api/capture  ─ Capture-key-gated → daemon /api/intake
                    └────┬──────────────┬────┘
                         │              │
                         │              │ writes Postgres directly
                         │              │ (mutator-driven changes)
                         ▼              ▼
                    ┌────────────────────────┐
                    │       Postgres         │ ◄── zero-cache  ─── WS → Clients
                    │  (logical replication) │      (sidecar)        (PWA / browser)
                    └────▲───────────────────┘
                         │ writes runtime state
                         │ (block streaming on close,
                         │  agent status, mail rows,
                         │  scheduler firings, etc.)
                    ┌────┴───────────────────┐
                    │    Friday Daemon       │ ◄────► Claude API
                    │   (127.0.0.1 only)     │
                    │  /api/events  (SSE)    │
                    │  /api/intake  (capture router)
                    │  /api/internal/* fast-paths
                    │  • Claude Agent SDK    │
                    │  • Agent registry      │
                    │  • Forked workers      │
                    │  • LISTEN on Postgres  │
                    └──────────┬─────────────┘
                               ▲
                               │  localhost HTTP
                    ┌─────────────────────┐
                    │     friday CLI      │
                    └─────────────────────┘
```

- **Dashboard** is the only public-facing process; the BetterAuth session gates every request **except** the deliberately sessionless `POST /api/capture`, which is gated by a write-scoped **Capture key** (better-auth apiKey plugin, no session minted) and proxies to the daemon's loopback `/api/intake` (ADR-047). Hosts Zero mutator execution, reverse-proxies the Zero WS, and proxies SSE.
- **Daemon** is the sole runtime for the Claude Agent SDK. Writes runtime state to Postgres directly (block closes, agent status, mail-bridge rows, scheduler). LISTENs on Postgres NOTIFY channels for row-as-intent dispatch from dashboard mutators. Owns the stateless **intake router** (`/api/intake`) that classifies and routes Captures (ADR-047). Binds to `127.0.0.1`.
- **zero-cache** is the Zero sidecar process. Tails Postgres logical replication, serves clients over WS through the dashboard's reverse proxy. Binds to `127.0.0.1`.
- **Postgres** is the canonical store. Host-managed (Homebrew + `brew services`), not owned by `friday start/stop`.
- **CLI** talks to the daemon directly on localhost — no auth, the OS provides the boundary (`~/.friday/` is `0700`).

**Reboot independence** (a load-bearing property of this topology):

- **Dashboard reboot** — already-connected client WS to zero-cache survive a brief reverse-proxy hop blip (sockets remain on the upstream zero-cache). Daemon continues writing Postgres → zero-cache → live clients see realtime updates throughout. New WS connections and mutator calls fail until dashboard returns; Zero queues mutations client-side and flushes on reconnect.
- **Daemon reboot** — dashboard mutators continue to commit Postgres. zero-cache continues to replicate. Already-connected clients see new rows arrive normally. Side effects (Claude turns, worker forks, mail-bridge IPC) pause until the daemon comes back; daemon boot recovery scans `WHERE status='pending'` rows and re-dispatches missed side effects. Writes always succeed; side effects are eventually-consistent.

## Tech stack

| Concern             | Choice                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language            | TypeScript, ESM                                                                                                                                                                                                                                                                 |
| Build               | pnpm workspaces + Turborepo                                                                                                                                                                                                                                                     |
| Tests               | Vitest (co-located `*.test.ts`)                                                                                                                                                                                                                                                 |
| Daemon runtime      | Node.js                                                                                                                                                                                                                                                                         |
| Agent runtime       | Claude Agent SDK (default model: `claude-opus-4-7`)                                                                                                                                                                                                                             |
| Database            | Postgres (Homebrew, host-managed) + Drizzle ORM (ADR-023)                                                                                                                                                                                                                       |
| Sync engine         | Zero (Rocicorp), Apache-2; `zero-cache` sidecar tailing logical replication                                                                                                                                                                                                     |
| Client cache        | Zero reactive cache (IndexedDB-backed)                                                                                                                                                                                                                                          |
| Live-turn stream    | Per-agent SSE (`/api/events?agent=<name>`), narrow scope (ADR-024)                                                                                                                                                                                                              |
| Dashboard framework | SvelteKit + Svelte 5 (runes) + adapter-node                                                                                                                                                                                                                                     |
| Auth                | BetterAuth (u/p only in v1; see ADR-008) + JWT bridge to zero-cache                                                                                                                                                                                                             |
| CLI                 | citty + @clack/prompts + picocolors                                                                                                                                                                                                                                             |
| Markdown            | marked + DOMPurify + Shiki (Catppuccin Latte / Mocha)                                                                                                                                                                                                                           |
| Image processing    | sharp (HEIC → PNG, dimension caps)                                                                                                                                                                                                                                              |
| Process supervision | launchd via `friday-supervisor` for daemon/dashboard/zero-cache (ADR-028); `brew services` for Postgres (ADR-023); `cloudflared service install` as a separate user launch agent for the tunnel, reconciled by `friday start` against `tunnel.serve` + token presence (ADR-042) |

## Repo layout

```
agent-friday/
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
  Brewfile
  .env.example
  CLAUDE.md
  README.md
  bin/                              # `friday` shim → packages/cli/dist/index.js
  docs/
    architecture.md
    chat-ux.md                      # single-chat UX, sidebar, slash, attachments
    mobile-ux.md                    # priority+ nav, virtualization, PWA
    mcp.md                          # MCP server surface table
    sandbox.md                      # Worker isolation (M1–M5) + residual risk
    decisions.md                    # ADRs
    roadmap.md                      # open work, watch list
    setup.md
    running.md
    run/                            # autostart unit examples (launchd, systemd)
  packages/
    shared/                         # @friday/shared
      src/
        config.ts
        env.ts
        log.ts
        agents.ts
        usage.ts
        transcript.ts
        atomic-write.ts
        cron.ts
        skills.ts
        wire/events.ts              # SSE event schema (TS discriminated union)
        prompts/
          CONSTITUTION.md
          agents/{orchestrator,builder,helper,scheduled,bare}.md
          protocols/{memory.md, linear.md, pr-links.md}
          fragments/{soul.default.md, auto-recall-header.md}
          skills/                   # built-in skills (empty in v1)
        services/                   # mail, tickets, attachments, turns, usage
        markdown/plugins.ts         # extension registry (KaTeX/Mermaid in v2)
        db/
          schema.ts                 # Drizzle
          client.ts
          migrate.ts
          drizzle/                  # generated migrations
    memory/                         # @friday/memory (file + FTS5 + auto-recall)
    evolve/                         # @friday/evolve (store + types; pipeline pending)
    cli/                            # @friday/cli, bin: friday (citty + clack)
    integrations/
      linear/                       # @friday/integrations-linear
  services/
    daemon/                         # @friday/daemon
      src/
        index.ts
        api/                        # HTTP routes + SSE
        agent/                      # lifecycle, worker, workspace, jsonl-mirror, registry, watchdog, workspace-guard, compact-flush
        scheduler/                  # cron tick + state.md continuity + spawn + nightly compaction sweep
        comms/                      # mail-bridge, mail-prompt
        events/                     # EventBus + ring buffer
        mcp/                        # friday-{mail,chat,agents,memory,tickets,schedule,evolve,echo}
        monitor/                    # health.json heartbeat
    dashboard/                      # @friday/dashboard (SvelteKit + Svelte 5 runes)
      src/
        routes/                     # /, /dashboard, /sessions, /tickets, /schedules, /habits, /memory, /evolve, /logs, /settings
        lib/                        # components, stores, hooks
      static/                       # PWA manifest + icons
      scripts/generate-icons.mjs    # regenerate PWA icons from a source SVG
```

## Components

| Path                           | Purpose                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`              | Types, config, logger, DB layer (Drizzle), wire schema, prompts, services (mail/tickets/attachments/turns/usage), markdown plugins, skills loader  |
| `packages/cli`                 | `friday` CLI (citty + clack + picocolors)                                                                                                          |
| `packages/memory`              | File-based memory store + DB-backed FTS5 + auto-recall block                                                                                       |
| `packages/evolve`              | Self-improvement pipeline: signal scanners (friction/preference/dreaming) → propose → rank → enrich → cluster → apply; memory hygiene; Dream Diary |
| `packages/integrations/linear` | Optional Linear API integration (reconcile() pending)                                                                                              |
| `services/daemon`              | Headless API. Owns SDK, agent registry, fork-per-agent workers, MCP servers, EventBus, SSE, scheduler, mail bridge, watchdog                       |
| `services/dashboard`           | SvelteKit + Svelte 5 (runes). Auth-gated public surface, proxy + UI                                                                                |

## Data architecture

### Postgres as canonical store (ADR-023)

- Host-installed Postgres (`brew install postgresql@18`, `brew services start postgresql@18`). Friday provisions a dedicated `friday` database + role; no custom PGDATA, no Friday-managed Postgres lifecycle.
- **Peer writers.** Daemon writes runtime state (block rows on close, agent status, mail-bridge rows, scheduler firings, app-lifecycle reconcile). Dashboard mutators write mutator-driven changes (user messages, abort intents, archive intents, ticket/memory/schedule edits, client telemetry). Neither "owns" the DB; both write directly.
- **Row-as-intent.** Mutators encode side-effect intent as a status field on the data row itself (`pending`, `abort_requested`, `archive_requested`, etc.). The daemon LISTENs on Postgres NOTIFY channels per status transition and dispatches side effects (fork worker, fire AbortController, archive agent). Boot recovery scans the same WHERE clauses, so the live path and recovery path are the same code.
- **Fast-path + durable-path.** For latency-sensitive ops (abort, critical-mail-wakeup, cancel-queued), the dashboard mutator additionally sidebands a `POST 127.0.0.1:<daemonPort>/api/internal/<op>` (localhost-only, fire-and-forget). The daemon handler is idempotent: whichever path fires first wins. See ADR-023.
- **Drizzle ORM** for schema + migrations (Postgres adapter). Daemon applies pending migrations at startup before zero-cache reconnects, then reconciles the Zero replication publication `friday_pub` to the just-migrated schema (`reconcileSyncPublication`, ADR-045) so a `friday update` deploy that introduces a new replicated table lands it in the publication automatically — no `friday setup` re-run. `Date.now()` discipline on `_journal.json:when` is unchanged from the SQLite era (see project CLAUDE.md).
- **CLI inspection** queries Postgres directly via the daemon API or read-only `psql` against the `friday` database when daemon is down.

Schema reference: see [`packages/shared/src/db/schema.ts`](../packages/shared/src/db/schema.ts) (Drizzle definitions; `drizzle-kit generate` derives migrations from this file).

### Sync engine (Zero) — settled state to clients

- `zero-cache` runs as a sidecar on `127.0.0.1:4848`, tailing Postgres logical replication. Apache-2 licensed (no licensing wrinkles for self-hosted).
- Dashboard reverse-proxies `/zero` (WS) → zero-cache; auth via short-lived JWT minted from the BetterAuth session.
- Client subscribes to reactive queries against the synced schema. Phase 1 bootstrap is the orchestrator's last 50 blocks + non-archived agents/tickets/schedules/apps/settings (target <2s broadband). Phase 2 fills full history for active agents and the last 24h of archives. Phase 3 is lazy on demand for very old data.
- **Streaming rows excluded from sync.** Block rows for the in-flight turn live only in the daemon's in-memory `blockStream` accumulator; they're written to Postgres only on `block_complete` with `streaming=0`. Clients' reactive queries are scoped to `WHERE streaming=0`. See ADR-024.
- **Read cursors are synced** (`read_cursors` table, per `device_id`). Unread badges become cross-device-correct by construction; today's localStorage-only badge state retires.
- **Client retention**: blocks for agents archived >30 days ago are expunged from the client cache; blocks older than 90 days are expunged regardless. Memory/tickets/agents/schedules/apps are never expunged (small). Server data is never deleted by this — retention is a client-cache property only.
- **Tiered cold-start hydration** (FRI-161): after a schema-changing `friday update` the browser discards its IndexedDB replica and must re-hydrate the whole 90-day blocks window. To keep first paint at ~1–2 s rather than 30–45 s, the foreground per-agent query cold-starts on a narrow 2-day (day-quantized) window; once it materializes, a background backfill widens the replica to the full 90 days via sequentially-awaited, epoch-aligned 1-day chunk preloads (newest-first, each its own server hydration batch/poke so focus switches interleave). A per-client-group `localStorage` flag marks the replica warm so subsequent reloads bind the full window directly and skip the tiered dance.

### File storage layout (`~/.friday/`)

Full layout reference lives in [`docs/running.md#data-location`](running.md#data-location). Postgres holds canonical state; `~/.friday/` holds operational files (config, secrets, identity, attachment bytes, memory-entry bodies, builder worktrees, per-agent home dirs, per-builder sandbox profiles, structured logs).

### Block model and in-flight state

- The chat is modeled as a **`blocks` table** — one row per content block, not per turn. Block kinds are `text`, `thinking`, `tool_use`, `tool_result`, `user`, and `mail`. Each row has a stable UUID `block_id`, a parent `turn_id`, a `seq` cursor, a `streaming` boolean, and a `source` enum (`worker` for live streaming, `jsonl` for boot recovery, `dashboard-mutator` for client-originated user blocks). Full-text search lives on the content column via Postgres `tsvector` + GIN (port of the SQLite FTS5 design).
- **In-flight bytes live in memory only.** During streaming, the daemon's in-memory `blockStream` registry holds partial bytes, half-assembled tool-use args, and the working buffer for the next delta. The block row is **written to Postgres only on `block_complete`** with `streaming=0`. This is the change from ADR-016's original "write partial bytes to the row continuously" model — it's necessary because Zero replicates Postgres row changes, and replicating 5–50 Hz partial-byte updates per active block would degrade live-typing fidelity and exceed Zero's designed envelope. See ADR-024.
- **Live deltas ride per-agent SSE.** Clients open `GET /api/events?agent=<name>` when focusing an agent's chat. The daemon maintains a small per-turn replay buffer (~100–500 frames typical) so reconnect-mid-turn replays from `turn_started` — preserves the "refresh during stream returns identical bytes" property. Settled blocks (those with `streaming=0`) are delivered via Zero, not SSE.
- **JSONL is boot-recovery only** (ADR-012, revised): on daemon restart, `services/daemon/src/agent/jsonl-recovery.ts` walks each session's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` once and back-fills any blocks that should exist but don't (worker crashed before `block_complete` DB write, or daemon crashed mid-stream). Idempotent on `block_id`.
- **Pagination falls back** to `GET /api/agents/:name/blocks?before=...` for blocks older than the client's sync window (>90 days, or for agents archived >24h ago that the client hasn't yet pulled). Cursors: `before` / `after` / `around_ts`.

See ADR-016 for the original block-model rationale; ADR-024 for the in-memory-accumulator amendment.

### Habits (FRI-169, ADR-043)

Habits are a **core** concept (not a Friday App — see ADR-043 for why: cross-app MCP reach + a first-class dashboard surface, neither of which an app can provide). Two canonical tables: **`habits`** (definition — name, `mode` `ongoing|bounded`, `target`/`period`/`days_of_week`, time-of-day `bucket`, `color_index`, bounded `window_start`/`window_end`, `status`) and **`habit_checkins`** (the append-only completion log). Both replicate to clients via Zero (`ANYONE_CAN` select) alongside `agents`/`tickets`/`schedules`/`apps`.

- **Streak is a derived projection, not a column.** `@friday/shared/habits` `computeStreak(habit, checkins, now)` is a pure function (`now` injected at the boundary) consumed identically by the daemon (`habit_list`/`habit_status`) and the browser (a single adapter mapping the `snake_case` Zero row + epoch-millis → `Date`). A streak breaks at the clock boundary when an unsatisfied Period closes, so a stored counter would be silently stale — the log is canonical, the streak is a view (the Turn-state-vs-Status-projection pattern). See ADR-043.
- **MCP + routes.** A core `friday-habit` MCP server (`habit_add`/`checkin`/`list`/`status`/`update`/`archive`/`checkin_undo`) is registered **unconditionally for all caller types** (like `friday-reminder`), POSTing to daemon `/api/habits*` routes. The dashboard check-off/undo writes are Zero mutators (`habitCheckin`/`habitCheckinUndo`); management (create/update/archive) goes through the `/api/habits` proxy.
- **Bounded archival is a reconcile, not a schedules row.** A bounded window closes on a clock boundary with no write event, so `reconcileBoundedHabits` (`services/daemon/src/habits/reconcile.ts`) flips closed-window active bounded habits to `completed`/`expired` (verdict from the engine's `terminal`) — run at boot and on a 60s daemon-internal interval (a `clearInterval`-on-shutdown timer like the scheduler tick — a daemon-internal timer, NOT a `schedules`-table row). Habits add no new `schedules.kind` and own no `schedules` rows; a reminder _about_ a habit is a separate `kind='reminder'` schedule (FRI-168).

### Evolve pipeline and memory dreaming (FRI-26, ADR-046)

`@friday/evolve` is the self-improvement loop. Its **signal scanners** read the system's own exhaust and emit `Signal[]`, deduped and merged by `signalHash`:

- `scan-friction.ts` / `scan.ts` (`scanDaemonLog`) — daemon `logs/daemon.jsonl` events (e.g. `watchdog.stall.detected`), `source: "daemon"`.
- `scan-preferences.ts` — Haiku pass over orchestrator transcripts inferring stable user preferences.
- `scan-dreaming.ts` (FRI-26) — Haiku pass over orchestrator transcripts proposing **candidate memories** the orchestrator should have saved, `source: "dream"`.

All scanners feed the same downstream: `proposeFromSignals` → `scoreProposal`/`rerankAll` → (`evolve_enrich` / cluster) → `applyProposal`, surfaced for review at the dashboard `/evolve` route and via the `evolve_*` MCP tools. The daily `scheduled-meta-daily` meta-agent drives the nightly run.

**Memory dreaming is a sub-pass of that daily run, not a new agent** (ADR-046). It rides inside `POST /api/evolve/scan` behind an `includeDreaming` flag that defaults to **true at the daemon endpoint** (the meta-agent's path) but to **false on the dashboard's manual Scan button** — the LLM-backed dreaming pass (token cost + memory auto-writes) fires only on the scheduled nightly run, never as a side effect of clicking Scan. The scan window advances via a `lastDreamScannedTs` cursor recorded in `scheduled-meta-daily`'s own `state.md`: the meta-agent reads it back and passes it as `sinceTs`, and the endpoint forwards `dreamSince = body.sinceTs ?? since` so each night re-scans only newer turns. The cursor is a cost optimization, not a correctness boundary — propose-merge signal-hash dedup plus apply-time `searchMemories` dedup make an overlapping window harmless. The flow within one scan:

- **Scan.** `scanDreaming` reads the window's orchestrator turns (`collectOrchestratorTurns` — the `blocks` table is canonical, no JSONL walker), is shown the existing corpus inline to skip already-covered facts, and emits one signal per candidate memory across the five Memory-protocol categories (`user`/`feedback`/`project`/`reference`/`person`). The LLM-authored memory payload (`{title, content, tags, category}`) rides JSON-encoded in the signal's first `EvidencePointer.path` (`kind: "dream"`), and recall/friction evidence rides additional `path` notes — the `Signal` type is **not** widened (ADR-046 Decision B). Friction co-occurrence is matched against the **configured orchestrator name** (`cfg.orchestratorName`), since `daemon.jsonl` signals carry the agent's real name, not the literal `"orchestrator"`; agentless daemon errors are not attributed. `draftFromSignal` has a dream branch that decodes the payload into a real `type:"memory"` proposal.
- **Auto-apply, gated per category.** A post-propose hook (`applyDreamProposals`, `dreaming-pipeline.ts`) auto-applies dream proposals whose reranked `score` clears a per-category threshold (`feedback:60, user:55, project:50, reference:45, person:80` — `dreaming-thresholds.ts`); `person` sits highest as a PII review-gate (ADR-046 Decision C). Below-threshold proposals (and all sub-80 `person` candidates) stay `open` for human review via `evolve_list` / `/evolve`. Before promoting, the hook dedups against the live corpus via `searchMemories`; a strong match (`>= DREAM_DEDUP_MIN_SCORE`) extends the existing entry with `updateEntry` instead of creating a duplicate (ADR-025: dedup uses the existing REST/in-proc memory-search hop, no new search surface).
- **Hygiene (anti-rot).** `runHygiene(listEntries())` then runs corpus-wide: merge near-duplicates (survivor keeps the higher `recallCount`; absorbed entry's content/tags fold in and it gains an `archived` tag) and flag cold entries as decay candidates. Hygiene is **preserve-over-delete** — it never calls `forgetEntry` (a static source assertion enforces this); pruning is tag-based archive only (ADR-046 Decision A). Archive suppresses recall because the daemon's passive-recall hook passes `excludeTags: ['person', 'archived']` (the `person` exclusion is FRI-141's PII carve-out; `searchMemories` honors only caller-supplied `excludeTags`, so this recall-side change is what makes the tag load-bearing).
- **Dream Diary.** Each run appends one timestamped markdown block (counts + a per-item `action | title | score | evidence` table) to `DREAM_DIARY_PATH` (`~/.friday/evolve/dream-diary.md`) — a flat append-only journal of what dreaming did each night. No migration, no schema change: tag-based archive plus the recall exclude is the entire archive mechanism.

### Capture & stateless intake (FRI-171, ADR-047)

A **Capture** is raw text plus a **Source** tag (`watch`, `quick_add`, …) fired at Friday from outside the chat — the Apple Watch Shortcut, the dashboard quick-add box, eventually voice. The flow is **capture → classify → route → land**, terminal and stateless (no orchestrator turn, no conversation history):

1. **Capture surface.** The Watch Shortcut / quick-add POSTs `{ text, source }` to the dashboard's sessionless `POST /api/capture`, authenticated by a write-scoped **Capture key** (better-auth apiKey plugin, `enableSessionForAPIKeys: false`, scope `{ capture: ["write"] }`; missing/invalid key → 401, never a 302→login). The route proxies the body to the daemon's loopback `POST /api/intake` with `x-friday-daemon-secret`. The daemon is never exposed through the tunnel.
2. **Intake router** (`services/daemon/src/intake/`). The daemon assembles a **routing-target registry** at call time — four core targets (`core:reminder`, `core:habit`, `core:memory`, `core:ticket`) baked in code with `guidance` prose + a zod `payloadSchema` + an executor over the existing primitive, plus one `agent:<name>` mail target per installed app's manifest `intakeRoutes[]`, plus the orchestrator as the catch-all `agent:<name>`. It then runs the **classifier**: the existing Claude Agent SDK `query()` single-turn (`maxTurns: 1`, `tools: []`, no MCP, thinking off) on the cheap `claude-haiku-4-5-20251001`, with a **code-owned Intake persona** (`INTAKE_PERSONA_PROMPT` — NOT the ADR-005 SOUL/CONSTITUTION stack). The model emits a strict-JSON `IntakeVerdict { cleaned, targetId, payload, disposition, rationale }`, JSON-parsed + zod-validated.
3. **Two gates → an Inbox item.** Gate 1: `targetId === null` ⇒ **Unsorted**, no executor. Gate 2: `disposition === "act"` AND the payload validates AND the executor succeeds ⇒ run it now → **Done** (with a result reference: `undoable` flag + `inverse_label` + `deep_link`); otherwise (`propose`, payload-invalid, executor-throws, unknown target, or a classifier failure/timeout) ⇒ **Proposed** carrying the payload. Nothing is dropped — every Capture writes one `inbox_items` row.
4. **`inbox_items`** (Zero-replicated, `ANYONE_CAN` select) holds `kind` (`done|proposed|unsorted`, CHECK-fixed at creation) and **`state`** (`open|resolved`, CHECK — named `state`, not `status`, which is reserved). The dashboard surfaces open items in an Inbox bell with a two-tone dot (attention iff any open Proposed/Unsorted; low-key when only Done FYIs, which auto-resolve on view). Lifecycle mutators (`inboxApprove`/`inboxReject`/`inboxDismiss`/`inboxTriage`/`inboxUndo`/`inboxMarkViewed`) flip state; `inboxApprove` runs the same executor the act-path would.
5. **Triage is Seth's job.** The orchestrator-only `friday-inbox` MCP server (`inbox_list` / `inbox_act`) lets Friday read and act on the Inbox **only at explicit in-chat direction** ("work through my inbox") — there is no nightly or out-of-band triage pass.

The `apikey` table backing the Capture key is declared in our Drizzle schema and provisioned by our own migration (no `@better-auth/cli` in this repo); it is server-only and NOT in `SYNC_TABLES`.

## Auth

- BetterAuth in the dashboard. u/p only in v1.
- 30-day sessions, no remember toggle.
- **No public sign-up, ever** (ADR-008). Account creation and password reset both flow through `friday setup` on the host.
- Daemon trusts localhost + filesystem permissions. SvelteKit server proc and CLI both qualify.

## Process model

### Daemon

- Single Node process, binds `127.0.0.1` on a single port (ADR-011) handling both HTTP and SSE.
- Owns Claude SDK, agent registry, MCP servers, in-memory `blockStream` accumulator, per-turn SSE replay buffer (replaces today's 5000-event ring; small per-agent channels).
- Starts one worker per active agent through the runtime seam in `agent/worker-runtime.ts` (FRI-2037). The local runtime spawns a detached process group reached over node IPC; the container runtime (FRI-2038, `agent/container-runtime.ts`) creates a per-assignment container through the builder broker and reaches it over a WebSocket command channel. Which one is used comes from configuration — see `docs/running.md` → _Containerised workers_. See `docs/chat-ux.md` for the agent lifecycle and worker model.
- **LISTENs on Postgres NOTIFY** for row-as-intent dispatch from dashboard mutators: new user blocks → fork/dispatch worker; abort_requested → fire `AbortController.abort()`; archive_requested → archive worker; new_mail → mail-bridge IPC wakeup. Same handlers run from boot-recovery scans, so live and recovery paths are the same code.
- **Localhost-only `/api/internal/*` fast-path endpoints** for ops where row→LISTEN latency matters (abort, critical-mail-wakeup, cancel-queued). Dashboard mutators sideband-call these in addition to writing the durable row; daemon handlers are idempotent against both paths.
- Mail delivery: `sendMail()` writes the row → in-process `mailBus` EventEmitter for daemon-internal callers (fast path) AND Postgres LISTEN on `new_mail` for cross-process callers (durable path). Same handler fires `mail-wakeup` IPC to the recipient worker (or spawns a fresh turn if the agent isn't live). The SSE `mail_delivered` event is retired — settled mail rows replicate via Zero (ADR-024).
- Stall watchdog every 30s. Optional refork via `config.watchdog.refork: true`.
- Nightly compaction sweep (FRI-156): a daemon-internal unref'd timer (`scheduler/compaction-sweep.ts`, ~5-min tick, fires at ~03:30 local) that `/compact`s idle orchestrator, helper, and bare agents over the sweep threshold. Not a `schedules`-table row. See _Agent lifecycle → Context compaction_.
- **Stateless Notification router** (`notifications/notify.ts`, FRI-142/ADR-048): the single server-side point holding the Web Push VAPID private key (`~/.friday/vapid.json`) and the server-only `push_subscriptions` table. Every producer fires `void notify(event)` fire-and-forget (intake `capture_attention`, agent-archive `builder_archive`, scheduler `schedule_fired`, mail-bridge `mail_delivered`, evolve `evolve_critical`). Per event the router consults the `notify_policy` map × in-memory **presence** × the **DND** window and fires zero or more channels: **Toast** (the broadcast `toast` SSE event, gated on global presence) and **Push** (per subscribed user, gated on that user's device-set presence, with the recomputed badge count stamped into each payload). Presence is in-memory only (`Map<deviceId,{lastSeen,visible}>`, 45s TTL, OR-aggregated per user) — a restart empties it and safely over-pushes. Loopback routes: `POST /api/presence` (heartbeat), `POST /api/push/subscribe` + `GET /api/push/vapid-public-key` + `POST /api/push/forget-device` (subscription lifecycle), `POST /api/notify/test` (Settings test button).

### Dashboard

- SvelteKit + Svelte 5 + adapter-node. Production: `node build/index.js`. Dev: `vite dev`.
- Public surface, gated by BetterAuth. Every API route checks the session before forwarding.
- `hooks.server.ts` logs all requests + unhandled errors via `@friday/shared` logger.
- **Three proxy surfaces under one public port:**
  - `/zero` — WS upgrade, auth-gated, reverse-proxied to `127.0.0.1:zero-cache`. Short-lived JWT minted from BetterAuth session and passed as Authorization header on the upstream WS.
  - `/api/events?agent=<name>` — per-agent SSE proxy to daemon. Live-turn deltas only (ADR-024). Also carries the agent-less broadcast `toast` event (FRI-142).
  - `/api/mutators` — Zero's `push-url`. Dashboard executes the mutator (writes Postgres + optional sideband to daemon fast-path endpoint). Returns Zero's mutation acknowledgement.
- **Notification proxy routes (FRI-142, ADR-048):** session-gated `+server.ts` handlers that forward over loopback to the daemon's Notification surface — `/api/presence` (presence heartbeat), `/api/push/subscribe`, `/api/push/vapid-public-key`, `/api/push/forget-device` (the "Forget this device" subscription drop; `userId` taken from the verified session, never the client body), and `/api/notify/test`. The Web Push VAPID private key + `push_subscriptions` never leave the daemon.
- **Connectivity widget** in the header (ADR-018, amended by ADR-024): three sequential dots — Internet / Sync / Daemon. Sync stage's tooltip surfaces both Zero WS health and live-turn SSE health (the latter is a sub-indicator, since sync is the dominant signal). Grey-cascade when an upstream stage is down. Tooltips informational only.

### CLI

`friday setup`, `doctor`, `start`, `stop`, `restart`, `status`, `logs`, `attach`, plus inspection (`agents`, `sessions`, `mail`, `tickets`, `memory`) and mutation subcommands. See `docs/running.md` for the full reference.

## Wire protocol

Two channels: **Zero WS** for settled state, **per-agent SSE** for live-turn deltas. Plus mutator HTTP for client-originated writes. See ADR-023 (sync) and ADR-024 (SSE narrowing).

| Endpoint                           | Method | Purpose                                                                                                                                                                   |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WS /zero`                         | WS     | Zero WebSocket, auth-gated by dashboard, reverse-proxied to `zero-cache`. Carries reactive query subscriptions, mutator submissions, and the bidirectional sync protocol. |
| `POST /api/mutators`               | POST   | Zero `push-url`. Dashboard executes the named mutator (writes Postgres + optional sideband to daemon fast-path). Idempotent on Zero's `mutation_id`.                      |
| `GET /api/events?agent=<name>`     | SSE    | Per-agent live-turn delta stream. Daemon replays the current in-flight turn from `turn_started` on (re)connect.                                                           |
| `POST /api/internal/abort`         | POST   | Localhost-only fast-path for abort. Daemon sideband; dashboard mutator additionally writes `abort_requested` row.                                                         |
| `POST /api/internal/mail-wakeup`   | POST   | Localhost-only fast-path for mail-bridge wake. Daemon-internal + dashboard sideband.                                                                                      |
| `POST /api/internal/cancel-queued` | POST   | Localhost-only fast-path to splice `nextPrompts`. Dashboard sideband; durable mutator deletes the row.                                                                    |
| `GET /api/agents/:name/blocks`     | GET    | Lazy fallback for blocks outside the client's sync window (>90 days, or agents archived >24h ago not yet fetched). Cursors: `before`/`after`/`around_ts`.                 |
| `GET /api/health`                  | GET    | Daemon health probe for the connectivity widget.                                                                                                                          |

The pre-sync `POST /api/chat/turn`, `POST /api/chat/turn/<id>/abort`, `DELETE /api/chat/turn/<id>/queued`, and `POST /api/chat/turn/<id>/resume` REST routes are fully retired (FRI-123 completed the ADR-024 retirement set). Clients call the equivalent mutators (`sendUserMessage`, `abortTurn`, `cancelQueued`, `resumeTurn`) via Zero; the daemon's LISTEN handlers dispatch.

### Mutator catalog (initial)

Defined in `packages/shared/src/sync/mutators.ts` (new). Each is implemented in the dashboard's `/api/mutators` handler and runs against Postgres with the user's auth context. Detailed table in ADR-023.

Side-effect-bearing mutators (daemon LISTENs and dispatches): `sendUserMessage`, `abortTurn`, `cancelQueued`, `resumeTurn`, `archiveAgent`, `createMemoryEntry`, `updateMemoryEntry`, `deleteMemoryEntry`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `installApp`, `uninstallApp`, `reloadApp`, `forgetDevice`.

Pure-data mutators (no daemon side effect): `createTicket`, `updateTicket`, `addTicketComment`, `addTicketRelation`, `linkTicketExternal`, `markRead`, `reportClientStats`, `updateSettings`.

### SSE event types (narrowed)

Schema in `packages/shared/src/wire/events.ts`. Only live-turn events remain:

- `connection_established` — first frame on every (re)connect. Carries the daemon's `boot_id`. (Boot_id cursor invalidation retires from the SSE layer — Zero handles cross-restart correctness for settled state. The field is kept for diagnostic purposes only.)
- `turn_started` — `{turn_id, agent, ts}`
- `block_start` — `{block_id, turn_id, agent, kind, ts}`
- `block_delta` — `{block_id, delta}` (text deltas, partial-JSON tool_use input)
- `block_complete` — `{block_id, status?}` — signal to client that the in-memory accumulator can be discarded; canonical row arrives via Zero with `streaming=0`.
- `turn_done` — `{turn_id, status: 'complete'|'aborted'|'error', abort_reason?: 'cooperative'|'forced'}` — usage rolls up via a synced row. `abort_reason` is present only when `status='aborted'` and distinguishes a worker-cooperative abort (`'cooperative'`) from a daemon-driven force-kill (`'forced'`). The dashboard reads it to pick the right terminal copy on the user-block footer. (FRI-95.)
- `error` — `{turn_id?, code, message, recoverable}` (live-turn errors only)
- `compacting` — `{agent, turn_id, phase: 'start'|'done'}` (FRI-156 §F). Low-latency compaction-in-progress signal: `phase:'start'` lights the dashboard's "Compacting context…" indicator; `phase:'done'` clears it. The closing-frame OUTCOME (`compact_result` success/failed) and any `compact_error` are NOT carried on this wire event — no client consumes them; they are logged daemon-side under `worker.compact.result` (AC8). The settled artifact is the durable `kind:'compaction'` marker block (below), not this event. This SSE event is in-memory on the client and lost on reload; it is now **paired with** the durable `agents.compacting_since` column (set/cleared by the daemon alongside this event, replicated via Zero) so the indicator reconstructs on reload/reconnect (while the daemon stays up). A daemon restart clears the flag at boot (`clearStaleCompacting`) and it re-lights when the resumed compaction re-signals. The client unions the two (`chat.isAgentCompacting`); the column also drives the elapsed-time readout and the sidebar's cyan compacting dot. See `docs/chat-ux.md` → _Compaction divider_.
- `toast` — `{title, body, deep_link?, event_type, priority?}` (FRI-142, ADR-048). The ephemeral **Toast Channel**: an agent-less **broadcast** event (not a per-turn delta) fired by the daemon's Notification router when policy × presence × DND resolves the `toast` channel for a machine→human event. It carries **no DB row by design** — the client routes it to a transient toast queue (`toasts.push`), never `chat.applyEvent`. This does NOT violate the ADR-024 "SSE = ephemeral, Zero = settled" invariant precisely because a toast has no settled state to replicate (contrast the Phase-5-retired `mail_delivered`/`schedule_fired`/`evolve_critical` events, which had backing rows and moved to Zero). It is the first deliberate agent-less broadcast on this side-channel; the eventBus delivers it live to every connected client and does not buffer it for per-turn replay.
- `:keepalive` comment line every 20s.

**Retired SSE events** (now observed via Zero reactive query updates instead):

- `agent_lifecycle`, `agent_status` — row updates on `agents`.
- `mail_delivered` — row insert on `mail`.
- `schedule_fired` — row insert on `schedule_runs`.
- `evolve_critical` — row insert on `evolve_proposals`.
- `system_banner` — row in a `system_banners` table.
- `compaction` (`type:'compaction'`) — the ephemeral per-turn compaction notice (FRI-156 retired it). It was lost on reload; the durable `kind:'compaction'` marker block (see _Context compaction_ below) replaces it and replicates via Zero. The separate live `compacting` SSE event (above) handles the in-flight spinner.
- `block_reload`, `block_meta_update` — row updates on `blocks` propagate via Zero directly.

### Mid-turn priority injection

`mail.priority='critical'` (ADR-014 amendment, FIX_FORWARD 8.4) lets a sender interrupt a running turn. On critical mail delivery the daemon sends a `mail-wakeup-critical` IPC; the worker checks for pending critical mail at each SDK iteration boundary and breaks out early so the next iteration sees the new mail. The parent's existing turn-complete handler then drains the queued prompts. Normal mail stays between-turn. The parent also signals `prompts-pending` IPC when a follow-up user prompt arrives mid-turn for the same agent, so the worker can short-circuit to the next iteration boundary without losing the queue if the daemon reforks.

### Live-turn rendering (ADR-024)

The daemon's contract narrows to the live-turn path: **in-memory accumulator updated before SSE emit.** The `blockStream` registry's per-block buffer reflects the delta _before_ the corresponding `block_delta` SSE frame ships. On `block_complete`, the daemon writes the canonical row to Postgres (`streaming=0`); Zero replicates it to all clients via the sync WS.

Browser focus-switch flow:

1. User clicks a sidebar entry; chat pane switches to agent B.
2. Close per-agent SSE for agent A (if open).
3. Zero already has agent B's settled blocks (Phase 2 bootstrap or active reactive subscription).
4. Open `GET /api/events?agent=B`. Daemon replays the current in-flight turn from `turn_started` (small per-turn buffer; not the old 5000-event ring).
5. Client rebuilds the in-memory accumulator for any in-flight block; live deltas flow.

**On `block_complete` arrival order:** SSE `block_complete` and Zero's canonical row insert may arrive in either order on the client.

- SSE first: client clears the in-memory accumulator (block is done); Zero row arrives shortly and replaces the in-memory representation with the canonical bytes (identical content; visual no-op).
- Zero first: client's reactive query renders the closed row; SSE `block_complete` arrives and clears any leftover in-memory state.
  Either order produces the same final state. There is no per-block cursor to manage and no boot_id invalidation needed on the SSE side.

## Identity / prompt stack

Every agent's system prompt is composed in this order:

1. `CONSTITUTION.md` — inviolate rules, source-only.
2. `SOUL.md` — identity, user-overridable at `~/.friday/SOUL.md`.
3. `agents/<type>.md` — role-specific behavior.
4. `protocols/*.md` — situational integration protocols (the final element).

`readPromptStack` (in `@friday/shared`) selects protocols per agent type from three sources, deduped in order: `DEFAULT_PROTOCOLS_BY_TYPE` (type-defaults), `envGatedProtocols()` (loaded only when a backing integration is configured), and any caller-requested names. Current fragments:

- `protocols/memory.md` — type-default for `orchestrator`/`scheduled`/`bare` (the save-side memory framework; builders/helpers are read-only and skip it).
- `protocols/linear.md` — env-gated: loads for **every** type when `LINEAR_API_KEY` is set.
- `protocols/pr-links.md` (FRI-131) — type-default for **all five** types, unconditional. Teaches agents to emit GitHub PR/issue references as clickable markdown links (`[#123](https://github.com/owner/repo/pull/123)`) rather than bare `#123` text, resolving the repo URL from their own worktree via `gh`/`git remote`. It is intentionally not env-gated (Friday reads no `GH_TOKEN`/`GITHUB_TOKEN`); the fragment self-guards by telling the agent to fall back to bare text when no GitHub remote exists. The dashboard markdown renderer needs no change — `marked` + DOMPurify already pass the link through, and `processLinks` opens absolute hrefs in a new tab.

Then per turn:

5. Skill prompt when a slash skill is invoked (injected as `<skill-context>` block).
6. `<memory-context>` auto-recall block from `@friday/memory`.
7. User message.

See ADR-005 for the full rationale.

### Prompt assembly entry points (FRI-123)

`services/daemon/src/prompts/` owns dispatch-prompt assembly behind two narrow entry points:

- `buildSystemPrompt(agentRow)` — base system prompt only. Reads the prompt stack, renders pinned facts, and threads both through `composeSystemPrompt` from `@friday/shared`. Used by the watchdog refork notice path (no intent → no hooks fire).
- `buildDispatchPrompt(agentRow, intent: DispatchIntent)` — full pipeline. Wraps `buildSystemPrompt` (or accepts a `baseSystemPromptOverride` for the `agent_spawn` path, where the `agent:bootstrap` hook augments the base) then runs `runHooks("before_prompt_build", ctx)` over the result. Two hooks subscribe: `memoryRecallHook` (in `prompts/`) appends the `<memory-context>` block; `skillContextHook` (in `hooks/`, skill concern) appends the `<skill-context>` block and emits `allowedToolsOverride`.

The `DispatchIntent` discriminated union (`kind: user_chat | mail | scheduled | scratch | agent_spawn`) is the single shape callers pass — replacing the wide positional-arg seam (`intentText`, `intentTag`, `body`, `agentType`, `baseSystemPrompt`, `skillMatch`) that was duplicated across 10 call sites. Callers pre-format wrapper strings (mail headers, schedule state-stitching); the prompts module does not import mail/scheduler schemas.

Memory recall is best-effort — a memory-store error never blocks the turn (`safeRecall` returns `""` on any error, including the 3-second listener-readiness timeout). The intent tag is captured as a forward-compat hook for an eventual memory MCP that filters recall by intent.

## Agent lifecycle

Hybrid worker model:

- **Long-lived** for orchestrator, builder, helper, bare. Worker mainLoop: run `query()` → drain mail → idle on `waitForMail` (60s timeout fallback) → repeat. Driven by user input on `/api/chat/turn` or by `mail-wakeup` IPC from the daemon's mail bridge.
- **One-shot** for scheduled. Worker fires, runs the SDK iterator, exits. State continuity across fires is handled by `<stateDir>/state.md` (agent-written) + `<stateDir>/last-run.md` (daemon-written), each capped at 64 KiB on injection.

The scheduler `schedules` table carries a `kind` discriminator. `kind='agent-run'` (the default) is the path above: a fire spawns a one-shot worker via `spawnScheduledRun`. `kind='reminder'` (FRI-143) fires through the same 30s tick / LISTEN paths but runs `deliverReminder` instead — it writes a `role:'user'`, `source:'reminder'` chat block into the target (default orchestrator) chat via `recordUserBlock` and stops. No worker spawns, no turn, no tokens; the reminder is a pure notification. The cross-device unread badge is bumped by the `friday_blocks_increment_unread()` Postgres trigger, whose source allowlist includes `'reminder'` — not by an `agent_message` SSE (a `role:'user'` block deliberately emits none). One-shot reminders (`runAt`, no cron) null their `nextRunAt` on fire so the tick filter permanently drops them; recurring reminders advance via the host-TZ `computeNext` path (FRI-98 timezone support is not yet built). See ADR-035.

### Per-agent home directories (FRI-61)

Each worker runs with a stable `cwd` so the Claude SDK's session-transcript layout (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) doesn't shift across daemon-install changes:

| Agent type                                   | `workingDirectoryFor()` returns |
| -------------------------------------------- | ------------------------------- |
| **builder**                                  | The agent's git-worktree path   |
| **app-installed** (any type)                 | `~/.friday/apps/<appId>/`       |
| **orchestrator / helper / scheduled / bare** | `~/.friday/agents/<name>/`      |

Pre-FRI-61 the non-builder, non-app branch fell through to `process.cwd()`. That made every prior `agents.session_id` unreachable to the SDK whenever the daemon was relaunched from a different directory (e.g. dev-tree → Homebrew install). The dedicated home + the boot-time `agent-cwd-pin-v1` state migration (which renames existing JSONLs into the new layout) close that gap.

### Pinned-memory injection in the prompt stack (FRI-61)

Any agent can own pinned memories: `composeSystemPrompt(stack, identity?, pinnedFacts?)` accepts an optional `pinnedFacts` string and renders it as a `# Pinned facts` section between Identity and `agents/<type>.md`. The renderer lives at `services/daemon/src/prompts/build-system-prompt.ts` (FRI-123 folded the previous standalone `agent/pinned-facts.ts` into the system-prompt builder); it queries `listPinnedForAgent(agentName)` (owner-filtered + tag-filtered + `status='ready'`) and assembles the block. `buildSystemPrompt` is the single chokepoint, called once per dispatch via `buildDispatchPrompt`.

The agent-friday repo path is a memory owned by `friday` with tag `pinned` (and a secondary `repo` tag for human filtering). Builders that need repo awareness use the same primitive — a memory owned by the builder, tagged `pinned` for always-inject, or with searchable name tokens for FTS recall. No daemon-side special-case per fact-type.

### Wedge detector — zero-block-streak (FRI-61)

A worker can land in a busy-loop where its SDK iterator yields only `result` (no `content_block_start` ever fires) — observed in production on 2026-05-20 when the daemon's cwd shifted and the SDK couldn't find prior session JSONLs. The heartbeat / turn-stall / 4-hour stale-turn guards all sleep through this (chatty worker, healthy block IPC inside other turns, threshold too lax).

The lifecycle handler tracks `blocksThisTurn` (incremented on every `block-start`) and `zeroBlockTurnStreak` (incremented when a `turn-complete` or `error` arrives with zero blocks, reset otherwise). When the streak reaches `FRIDAY_WEDGE_THRESHOLD` (default 10), the daemon calls `forceKillStuckWorker(w, { reason: "wedge" })`. Per-event signal: `worker.zero-block-turn` warn line. Final kill: `worker.wedge.force-kill`.

### Context compaction (FRI-156 + FRI-27)

The orchestrator is a persistent companion: it compacts **in place** and never rotates sessions. Compaction has four moving parts.

**A. Per-agent auto-compact ceiling.** `buildQueryOptions` (in `agent/worker.ts`) sets `settings.autoCompactWindow` per agent type from `autoCompactWindowFor(loadConfig(), agentType)` (`@friday/shared/config`). Defaults live **in code** (`DEFAULT_AUTO_COMPACT_WINDOW`, 200K for every type), placed before the config spread so a `~/.friday/config.json` `compaction.autoCompactWindow` partial override stays in effect without dropping siblings — never written to `.env`. This is the SDK-native backstop that catches a runaway day before the session hits the model's native window. Setting the field is necessary but not sufficient — the SDK must honor it — so **once per worker process** `probeAutoCompactWindow` fires a best-effort, non-blocking `Query.getContextUsage()` round-trip and logs `worker.compact.window.probe { configured_window, auto_compact_threshold, takes_effect }`: `takes_effect` is true when the SDK reports auto-compaction enabled with an `autoCompactThreshold` at or below the configured window. (Once per process, not per turn: the window is constant for the session, so the verdict can't change turn-to-turn.) **Documented SDK gap / fallback:** if `getContextUsage` is absent (older SDK), the threshold is missing, auto-compaction is reported disabled, or the threshold exceeds the window, the probe logs `takes_effect:false` with a `fallback` note. The probe verdict drives nothing directly; the fallback is the **independent §B nightly sweep**, which dispatches `/compact` on its own timer at the 100K budget regardless of whether the SDK ceiling takes effect — so context stays bounded even when the probe reports `takes_effect:false`. The probe never throws into the turn (a failed control round-trip is swallowed and logged), so it cannot stall or fail a turn.

**B. Nightly maintenance sweep.** `scheduler/compaction-sweep.ts` is a daemon-internal, unref'd `setInterval` (modeled on `watchdog.ts`) — **not** a `schedules`-table row and never surfaced in the user-facing schedules UI. On a ~5-min tick it checks `isSweepDue(now, lastSweepAt, cfg)` (a pure local hour:minute test with per-day dedup, default 03:30 local; not cron). When due, it estimates each agent's live context from the latest `usage` row (`getLatestUsageForAgent` + `estimateContextTokens` = `input + cache_creation + cache_read`, scoped to the agent's current `sessionId`) and, for every **orchestrator, helper, or bare** agent that is **currently live and idle** and over the sweep threshold (default 100K), dispatches a `/compact <persona-continuity instructions>` maintenance turn through the normal dispatch path. Builders, scheduled/planner agents, offline agents, and working/stalled agents are skipped. The dispatched turn records a real user bubble with `source:'compaction_sweep'`. Logged under `worker.compact.sweep.{started,dispatched,skipped,error}`. The **two-number scheme**: the sweep (100K) keeps each wake's cache-creation cost low; the per-agent ceiling (200K, §A) is the runaway-day backstop.

**C. Persona-continuity instructions.** `prompts/compact-instructions.ts` holds `COMPACT_CUSTOM_INSTRUCTIONS` (golden-tested in `__golden__/`), the string appended after `/compact ` so the SDK's summarizer preserves open commitments, in-flight task state, relationship tone, and recent decisions _with their reasoning_. The sweep builds the dispatch body literally (`/compact ${COMPACT_CUSTOM_INSTRUCTIONS}`) and uses `buildSystemPrompt` (which fires no hooks), so nothing can prepend text ahead of the leading `/compact ` and silently turn it into an ordinary message. A `compact` `DispatchIntent` kind is the standardized seam for any path that _does_ go through `buildDispatchPrompt`; `memoryRecallHook` early-returns on `intentTag === "compact"` so a `/compact` body never pollutes memory recall.

**D. Durable compaction marker block.** When the SDK emits a `compact_boundary` frame, the worker sends a `compaction-boundary` IPC and `lifecycle.ts` calls `recordCompactionMarker`, which INSERTs a durable `role:'system', kind:'compaction'` block into the agent's current turn with `content_json: { pre_tokens, post_tokens, duration_ms }`. The block replicates via Zero and **survives reload** — replacing the old ephemeral `type:'compaction'` SSE notice that was lost on refresh. `blocks_kind_check` was widened (migration `0030`) to allow `'compaction'`. The insert is the **second writer** of `w.blocksThisTurn` (`block-stream.open` is otherwise the sole writer): incrementing it means a legitimate `/compact` turn isn't mistaken for a zero-block wedge and shows a durable divider instead of a synthesized "Compacted — no response" bubble. The pure turn-state machine is untouched; its `blocksThisTurn === 0 + compactionThisTurn → 'compaction'` mapping stays as the genuine no-boundary-block fallback.

**E. Compaction-in-progress visibility.** The worker's message loop classifies the SDK `system/status` frame (`classifyStatusFrame`): `status:'compacting'` → a `compacting-status` IPC `phase:'start'`, a `compact_result` field → `phase:'done'` (+ `result`/`error`). `lifecycle.ts` surfaces this as the transient `compacting` SSE event (above) so the dashboard shows a live "Compacting context…" indicator, and on the closing frame logs `worker.compact.result { result, error? }` (AC8 — a failed compaction's reason is forensically captured even though it isn't surfaced in the UI); `status:'requesting'` is unrelated and filtered out.

**F. Pre-compaction memory flush (FRI-27).** Compaction summarizes — and therefore _loses_ — detail. To save what would be lost, `worker.ts` registers a SDK **PreCompact** hook (on the SDK's own hook channel, gated off `builder` agents, which have read-only memory). On fire it runs an isolated sub-query (`agent/compact-flush.ts`): it `resume`s the about-to-be-compacted session with `forkSession: true` so the flush model sees the **full pre-compaction conversation** while its turns fork onto a fresh session id — zero pollution of the user transcript and zero recursion (the flush query registers no hooks). The flush is **structurally** restricted to memory only — not merely prompt-steered: built-in tools are disabled (`tools: []` → no Bash, no filesystem) and the MCP set is reduced to `friday-memory` alone, with `allowedTools` auto-approving exactly the three memory tools (`memory_search` / `memory_get` / `memory_save` — append + dedup only, no update/forget). This matters because the fork-resumed conversation can carry untrusted ingested content and the flush runs under `bypassPermissions` with no PreToolUse hook; restricting _availability_ (not just the auto-approve list) means an injected "email/delete/exec" instruction has no tool to land on. `autoCompactWindow` is set to a large disable value so the flush itself can't compact; the hook's **30-second matcher timeout** (`HookCallbackMatcher.timeout` is in _seconds_) is wired into the sub-query's `abortController`, so a stalled flush is actually torn down and compaction proceeds — losing the flush is strictly better than blocking compaction. `savedCount` counts only memory_save tool_results that landed (non-error). A module-scope `Set<sessionId>` guard prevents two flushes per session running in parallel. The flush prompt is templated only with the existing memory index (title + tags, to bound its own token budget); it is **independent of §C's `custom_instructions`** so FRI-156 and FRI-27 stay decoupled. A **PostCompact** hook (registered for **all** agent types — logging-only, so safe for builders too) logs `worker.compact.post` with the trigger and `compact_summary.length` only (the summary content is never persisted). Flush lifecycle is logged under `worker.compact.flush.{started,saved,error}`; flush failure never affects the outer turn.

Worker IPC (`worker-protocol.ts`):

```
spawnTurn() / dispatchTurn()
  → fork(WORKER_PATH)
  → child sends { type: "ready" }
  → parent sends { type: "start", options }
  → parent may later send { type: "prompt", options } (long-lived; user follow-up turn)
  → parent may send { type: "prompts-pending" } when the queue grows mid-turn
  → parent may send { type: "mail-wakeup" } when mail-bridge sees normal mail for this agent
  → parent may send { type: "mail-wakeup-critical" } for priority='critical' mail (mid-turn break)
  → worker emits block-start, block-delta, block-stop (per content block), heartbeat, turn-complete
  → parent writes block rows via blockStream.close, then publishes the SSE frame
  → worker exits on stop / abort / fatal error / one-shot completion
```

Parent-side queue ensures multiple `prompt` IPCs don't race in-flight events with stale `turn_id`s. The queue is mirrored in `blockStream` (in-memory) so a refork survives — the new worker sees the same pending prompts on `start`.

### Agent status semantics

The `agents.status` column has four resting values (plus the transient
`archive_requested` the Zero mutator path writes before the daemon flips it to
`archived`):

| Status     | Meaning                                                                                 | Terminal? |
| ---------- | --------------------------------------------------------------------------------------- | --------- |
| `idle`     | Registered, no worker in flight, can be dispatched to                                   | No        |
| `working`  | A worker is alive and mid-turn                                                          | No        |
| `stalled`  | Watchdog flagged the worker for missing its heartbeat budget (no exit yet)              | No        |
| `archived` | Agent stopped receiving work; for builders, the worktree is gone and the branch deleted | Yes       |

Every write to `agents.status` flows through a **single writer** — the
Turn-state machine (`services/daemon/src/agent/turn-state-machine.ts`), reached
via the per-agent-name Transition queue (`transition-queue.ts`). The turn
lifecycle, archive, boot recovery, and the invariant auditor no longer write the
column on their own threads; each enqueues a Transition and the machine projects
the resulting `agents.status` through the one ADR-031 `registry.setStatus` gate
(FRI-145, ADR-032). `agents.status` is a **Status projection** of the machine's
authoritative in-memory **Turn state** (`idle | working | aborting |
force-killed`), not an independent source of truth — `force-killed` and
`aborting` are transient Turn states with no resting projection; `stalled` and
`archived` are projections with no resting Turn state.

`stalled` is produced by the per-agent watchdog (`watchdog.ts`): when a working
worker blows past its heartbeat budget the watchdog enqueues a `stall`
Transition that projects `agents.status="stalled"` through the Turn-state
machine (FRI-145 M5). The watchdog enqueues fire-and-forget and never awaits the
Transition inside its tick loop, so one stalled agent can't head-of-line-block
the watchdog across all agents; the machine stays the sole `setStatus` caller.
The dashboard paints the warn-colored sidebar dot from it.

The agent-status `error` value was **removed** (FRI-145 M5). A worker that exits
mid-turn with no terminal turn-complete/error no longer parks the row at a
sticky `error`; instead the exit handler's `hard-exit` Transition publishes the
missing `turn_done{status:"error"}` (the **wire/block** `error` namespace, which
is unrelated and stays) and self-heals the agent row to `idle` — dispatchable,
no daemon restart needed. There is no resting agent-status that requires manual
recovery.

`archived` is the **terminal** state. Once an agent is archived its session(s) remain visible in `/api/agents/:name/blocks` forever — history is history — but no new turns dispatch, no SSE events should mutate its state, and the row is never resurrected by recovery. A deliberate re-create with the same name uses `registerAgent` (status `idle`) and is conceptually a new entity sharing the namespace, not the same agent un-archived.

### Archive reason and linked-ticket close

Every call to `archiveAgent(name, { reason })` requires a `reason` — there is no default. The reason both documents intent in logs and drives the linked-ticket close behavior (see ADR-006 amendment and `services/daemon/src/services/ticket-close.ts`):

| `reason`    | Friday ticket status       | Linear stateType (if linked) | Used by                                                                          |
| ----------- | -------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `completed` | `done`                     | `completed`                  | Orchestrator MCP `agent_archive` after a successful build                        |
| `abandoned` | `closed`                   | `canceled`                   | Orchestrator MCP, REST archive, boot-time orphan sweep, `/archive` slash command |
| `failed`    | `closed` + failure comment | `canceled`                   | Orchestrator MCP when the agent gave up or errored irrecoverably                 |
| `refork`    | unchanged                  | unchanged                    | Watchdog refork path; `/clear`                                                   |

The closer reads the agent row's `ticketId` **before** `registry.archiveAgent` runs — a future refactor that nulls the row's fields on archive would silently break propagation otherwise, so the read order is pinned by a test (`lifecycle-ticket-close.test.ts`). Closer execution is fire-and-forget from `archiveAgent`'s perspective; failures inside the closer (DB error, Linear unreachable, etc.) are logged but never bubble back into the worker-teardown path.

Sidebar filter buckets reflect these semantics: "Show archived" reveals the terminal bucket; "Show inactive" reveals the transient-stall bucket (`stalled`). The focused row is always shown regardless of filter state.

### State-boundary checks (inline)

After FRI-145 (ADR-032) these are no longer three independent writers of
`agents.status` — each is a **Transition source** that enqueues onto the agent's
Transition queue, and the single-writer Turn-state machine performs the actual
`registry.setStatus`. They remain the load-bearing boundaries because each still
owns the invariant it validates before (or while) enqueuing:

- **Worker exit handler** (`lifecycle.ts:child.on("exit")` → `finalizeHardExit`, FIX_FORWARD F1-A; FRI-145 M5): a current-Generation exit drives the machine's `hard-exit` Transition, which publishes the missing `turn_done{status:"error"}` for a turn that died in flight and heals the row to `idle`. It first reads the current row's status; if `archived` (a racing archive owns it) it leaves the row alone — the terminal state never gets downgraded by an exit event, which closes the race that produced the friday-e2e-probe zombie. (A superseded Generation's exit is a structural no-op before any of this.)
- **`archiveAgent()`** (`lifecycle.ts`): sets `archived` synchronously, publishes `agent_lifecycle:archive`, then awaits the worker's actual exit. Awaiting (via the merged `POST /api/agents/:name/archive`) makes the HTTP response a strong "actually archived" signal.
- **Dashboard event apply** (`chat.svelte.ts`, PR D): `applyAgentStatus`, the `agent_lifecycle:complete` handler, and the `turn_started` handler all short-circuit when the existing row's status is `archived`. SSE ring-buffer replays for archived agents can't flip them back into the active list.

These are the load-bearing defenses. Most bugs the system has hit lived in code paths that should have validated at one of these points and didn't.

### Continuous invariant auditor (`agent/invariants.ts`)

`startInvariantAuditor()` runs one pass at boot and then every 60 s thereafter. Each pass walks every row in `agents` and checks two invariants against a **named source of truth**:

| #   | Rule                                                                   | Source of truth           | Self-heal                                                                                  |
| --- | ---------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | A builder's worktree directory must exist OR status must be `archived` | Filesystem (`existsSync`) | `registry.archiveAgent(name)` + publish `agent_lifecycle:archive(reason: orphan-worktree)` |
| 2   | `status=working` ⇒ the agent is in the in-memory `live` worker map     | `lifecycle.live` (Map)    | `registry.setStatus(name, "idle")` + publish `agent_status:idle`                           |

Rule 1 takes precedence (a row that violates both gets archived, not demoted — archived is terminal; demoting an orphan to idle would let it slip back into mail-recovery dispatch on the next boot).

Boot recovery (`recoverAgents` in `index.ts`) runs a one-shot version of rule 1 before its mail-dispatch eligibility check, so the auditor's first scheduled pass isn't the only line of defense at startup.

### Why timer-based (and not event-driven at state boundaries)

The auditor is a **safety net**, not the primary enforcement. Most invariant violations the system has hit are caught at code-controlled state boundaries (see "State-boundary checks" above). The cases the timer exists for are the ones we can't observe from inside the daemon at the moment they happen:

- The user `rm -rf`s a worktree from a terminal.
- A worker crashes hard enough that `child.on("exit")` doesn't fire (kernel panic, SIGKILL by an external process, OOM).
- An external process or future code path mutates the `friday` Postgres database directly (e.g. an operator running `psql friday`).

For these, there's no event to hook into — `fs.watch` on macOS is unreliable for delete events on certain filesystems, and process death without an exit signal can't be detected synchronously. A periodic scan is the right tool: cheap (it's a `listAgents()` + `existsSync()` per builder), idempotent, and bounded in latency to one interval.

The timer's coverage of code-controlled state boundaries is incidental defense-in-depth. If a future refactor adds a new state mutation path that doesn't enforce invariants inline, the auditor will catch it within 60 s — but the goal is for new code to enforce inline, and the auditor to find nothing on most ticks. Tick logs that consistently archive or demote the same agent point at a missing inline check upstream.

### Adding a new invariant

When a new drift mode is discovered:

1. Identify the **source of truth** for the invariant (filesystem, in-memory map, another table, etc.). Name it in the rule comment.
2. Add the rule to `audit()` in `services/daemon/src/agent/invariants.ts`. Keep checks cheap and idempotent.
3. Decide precedence relative to existing rules if a row can violate multiple at once. The general guideline: terminal states (archive) over transient states (demote), and "stop the world" over "fix the field."
4. Add a happy + sad path test in `invariants.test.ts`. If precedence matters, add a test for both rules tripping at once.
5. If the same drift mode could be prevented at a code-controlled state boundary, add the inline check there too. The auditor stays as the safety net.

## Mail and tickets

### Mail

- All-Postgres. The `mail` table is the persistence layer; Zero replicates it to the dashboard. The in-process `mailBus` EventEmitter is the daemon-side wakeup signal for `recordUserBlock`/`dispatchTurn` (no SSE event — Phase 5 retired `mail_delivered`).
- Push delivery: `sendMail()` writes row → emits `mail:to:<agent>` + `mail:any` (ADR-014) → daemon's `mail-bridge` republishes as `mail_delivered` SSE and sends `mail-wakeup` IPC to the live worker, or spawns a fresh turn for an idle long-lived agent.
- **Universal delivery primitive** (ADR-017, FIX_FORWARD 8.5): mail is the only way to deliver anything user-visible. The old `chat_reply` MCP tool and `/api/chat/reply` endpoint were removed; user-facing replies are `mail_send` to recipient `friday` (the orchestrator's box), which the mail-bridge surfaces as `mail` block rows in the chat. Builders and helpers address the user the same way.
- **Priority field** (ADR-014 amendment): `priority='critical'` triggers mid-turn injection on a live worker via `mail-wakeup-critical` IPC. `priority='normal'` (default) waits for the next turn boundary.
- Boot recovery: `replayPending()` re-emits all pending rows on startup; `recoverAgents()` drains inboxes for non-archived long-lived agents.

### Tickets

- ID format `FRI-1234` (prefix + monotonic counter from `db_meta`).
- `/tickets` page renders list + detail with comments + external links.
- External-system linking is system-agnostic (ADR-006): `ticket_external_links (ticket_id, system, external_id, url, meta)` carries Linear, GitHub, anything else as sibling rows. The `tickets` table itself doesn't know any external system exists.

## Apps

Friday Apps (ADR-021, FRI-78) are folders under `~/.friday/apps/<id>/` that are first-class registered, agent-owning, MCP-extending units. An app is **a folder + a manifest + a DB row**; the manifest on disk is the source of truth, the `apps` Postgres table is derived state.

### Memory vs. files: the hard split

- **Memory = facts.** Cross-cutting, durable, recall-able. Apps that need to remember something visible to the orchestrator save memory entries normally.
- **Files = operational state.** Libraries, generated artifacts, structured config, plans. Apps that need this put it under their own folder (`~/.friday/apps/<id>/state/`).

Earlier directions explored per-app memory namespacing or a recall ranker; the directory-per-app structure removes the namespacing problem at the source.

### Per-app MCP scoping

Each app's manifest declares zero or more stdio MCP servers (`command: "node"`, args resolved relative to the app folder, env values substituted from the app's own `.env`). When the daemon forks a worker for an agent that has `app_id` set, `spawnTurn` auto-populates `appContext` on the worker's options. The worker's `buildMcpServers` then appends those servers — only to the app's own agents. The orchestrator has no `app_id`, so it has no `appContext`, so it never sees per-app MCP servers. That's the structural containment that makes the model work.

**App folder discovery — `FRIDAY_APP_DIR` (FRI-36).** The Claude Agent SDK's `McpStdioServerConfig` type has no `cwd` field, so any cwd the daemon sets on a stdio MCP entry is silently dropped and the spawned MCP inherits the daemon's cwd. To compensate, the daemon injects `FRIDAY_APP_DIR=<app folder>` into every app MCP server's env (after manifest `${VAR}` substitution, so a manifest can't shadow it). **App MCP servers must read their folder from `process.env.FRIDAY_APP_DIR`, never from `process.cwd()`.** A robust pattern, with `fileURLToPath(import.meta.url)` walk as a defense-in-depth fallback for the conventional `<folder>/mcp/<server>.js` layout:

```js
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = process.env.FRIDAY_APP_DIR ?? dirname(dirname(fileURLToPath(import.meta.url))); // <app>/mcp/<server>.js → <app>
```

The variable is **only** set on app-declared MCP servers — built-in stdio (`playwright`) and user-configured stdio MCPs (`~/.friday/config.json`) do not receive it.

### Install / uninstall / reload lifecycle

`services/daemon/src/apps/installer.ts` is the transactional heart. All collision checks + writes happen in one Postgres transaction; post-commit side effects (drop default `.gitignore`, SSE publish, folder rename) are best-effort and log a warning on failure rather than unwind.

- **Install**: read manifest, run §6.2 collision matrix, upsert app row + agents + schedules, publish `app_lifecycle: installed`.
- **Uninstall**: archive owned agents (preserve `app_id` as tombstone), drop schedules, delete app row, optionally archive / keep / delete the folder.
- **Reload**: re-read manifest, reconcile. New agents added; removed agents NOT auto-archived (destructive — explicit uninstall required).
- **Boot reconcile**: missing folder → flip status to `orphaned` (never auto-delete). Discovered folders without DB rows are logged but never auto-installed.

### CWD rule

Agents owned by an app run with `cwd = <app folder>` (resolved in `workingDirectoryFor`). Builders override this — workspace containment is the stronger Constitution rule. The orchestrator always runs with the daemon's cwd.

### On-disk layout

```
~/.friday/apps/<id>/
  manifest.json          # required
  prompt.md              # optional; referenced by agents[].promptOverlay
  .env                   # optional; loaded only for this app's MCP servers
  .gitignore             # written on fresh install (.env + state/*.cache.json)
  mcp/                   # optional; conventional location for app-shipped MCP server source
  state/                 # optional; app's working files
  README.md              # optional; ignored by daemon
```

See [`packages/shared/src/db/schema.ts`](../packages/shared/src/db/schema.ts) for the `apps` table; ADR-021 for the load-bearing decisions; the synthetic fixture at `services/daemon/src/apps/fixtures/example-app/` for a canonical shape.

## State

| Storage                     | Lives at                                           | Owns                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                    | host `brew services postgresql`, database `friday` | accounts/sessions/users (BetterAuth), blocks (only with `streaming=0`), mail, tickets, ticket_relations, ticket_external_links, ticket_comments, attachments (metadata only), agents, schedules, memory_entries, db_meta, apps, client_devices, read_cursors, system_banners, schedule_runs, evolve_proposals. tsvector + GIN indexes on blocks + memory bodies. |
| Filesystem                  | `~/.friday/`                                       | SOUL.md, skills/_.md, uploads/<sha-bucket>/<sha>.<ext> (attachment bytes), memory/entries/_.md, evolve/proposals/_.md, schedules/<name>/{state,last-run}.md, workspaces/<name>/, logs/_.jsonl, apps/<id>/                                                                                                                                                        |
| Memory (daemon process)     | daemon                                             | `blockStream` accumulator for in-flight blocks, per-agent SSE replay buffer (~1 turn), `lifecycle.live` worker map, in-process `mailBus` EventEmitter (fast path).                                                                                                                                                                                               |
| Memory (zero-cache process) | zero-cache                                         | Logical replication tail state, per-client subscription state.                                                                                                                                                                                                                                                                                                   |
| Memory (client)             | browser / PWA                                      | Zero reactive cache (IndexedDB-backed); in-memory render state for the live-turn accumulator built from per-agent SSE.                                                                                                                                                                                                                                           |

## Logs

Structured JSONL via `@friday/shared.createLogger`, rotated at 1 MiB into gzipped archives kept indefinitely. Every request to the dashboard is logged with method, path, status, duration, and userId.

## Inheritance from the old Friday

Lifted nearly verbatim:

- `@friday/memory` (store + search + events + auto-recall block).
- Logger, transcript parser, atomic-write, cron utilities.
- Worker fork protocol (lightly extended for the new wire schema).
- EventBus + SSE pattern.
- CLI shape (citty + clack + picocolors).
- Scheduled agent state.md / last-run.md continuity convention.
- Builder workspace path-guard hook (now wired as a Claude SDK PreToolUse callback rather than a settings.json script).

Replaced:

- Slack interface — gone entirely. Mail is the universal delivery primitive (ADR-017); `slack_reply` and its short-lived successor `chat_reply` are both retired.
- Beads — replaced with the mail + tickets schema (ADR-006, ADR-014).
- `agents.json` and per-channel session files — replaced by the `agents` table (ADR-013).
- SQLite — replaced by host-installed Postgres + zero-cache logical replication (ADR-023, ADR-024).
- `turns` table as the live store — replaced by `blocks` (ADR-016); old `turns` rows are retained read-side until the migration window closes.

Pending lift (`docs/roadmap.md`):

- Linear `reconcile()` (interface ready; GraphQL queries pending).

Lifted and extended beyond the old Friday:

- Evolve scan/propose/rank/enrich/cluster/apply pipeline, plus friction/preference/dreaming signal scanners, memory hygiene, and the Dream Diary (FRI-26, ADR-046) — see "Evolve pipeline and memory dreaming" above.
