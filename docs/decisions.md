# Architecture Decision Records

## ADR-001 — SQLite + WAL, not Postgres

**Status:** superseded by ADR-023 (2026-05-18). Original rationale below preserved for context.

Single-user system (multi-device). Workload is sub-millisecond commits at tens of writes/sec at peak. Postgres requires a separate service that fights the local-first model. SQLite WAL handles the multi-process write contention — daemon, dashboard server proc, CLI inspections — without contention in practice. `busy_timeout=5000` mops up the rare collisions. One-file backup, content-addressed branch-isolation if we ever need it.

## ADR-002 — Daemon owns the Claude SDK; dashboard is auth + UI proxy

**Status:** accepted (amended by ADR-023, 2026-05-18)

Single SDK runtime keeps long-lived sessions, agent registry, fork pool, file watchers, and the EventBus all in one process. SvelteKit hot-reloads don't kill conversations. Auth boundary is clean: daemon binds to `127.0.0.1`, dashboard is the only public surface, CFT exposes only the dashboard.

**Amendment (ADR-023, 2026-05-18):** Under the Postgres + Zero sync model, the dashboard's role expands beyond auth + UI proxy: it also hosts Zero mutator execution (`/api/mutators`), reverse-proxies the Zero WS (`/api/sync` → `127.0.0.1:zero-cache`), and mints short-lived JWTs from BetterAuth sessions for zero-cache auth. The daemon still owns the SDK + worker runtime; it no longer "owns the database" — dashboard and daemon are peer writers to Postgres. The single public port + CFT-only-sees-dashboard invariant is preserved.

## ADR-003 — Single SSE channel, NDJSON via SSE framing

**Status:** superseded by ADR-024 (2026-05-18). Original rationale below preserved for context.

`EventSource('/api/events')` is the only persistent connection from the browser. Per-turn POST returns `{turn_id}` immediately; turn events flow on the same SSE channel tagged by `turn_id`. Native `Last-Event-ID` reconnect against the daemon's 200-event ring buffer.

## ADR-004 — DB write before SSE emit, with `last_event_seq` cursor

**Status:** superseded for settled-state events by ADR-024 (2026-05-18); narrows for live-turn events. The per-row `last_event_seq` column itself retires in FRI-125 (2026-05-28) — see Consequences below. Original rationale preserved for context.

**Consequences (FRI-125, 2026-05-28).** The `blocks.last_event_seq` column is dropped. The daemon's `writeAndPublish` helper retires, taking the `eventBus.currentSeq()+1` peek-and-stamp dance + `block.seq-skew` warning with it. The narrowed live-turn-delta invariant — "in-memory accumulator updated before SSE emit" — is now owned at one seam by `services/daemon/src/agent/block-stream.ts` (the six-method module that absorbed `live-turns.ts`, `writeAndPublish`, `insertErrorBlock`, and `finalizeStreamingBlocks`). The SSE event's own `seq` field (stamped by `eventBus.publish`) remains load-bearing; only the row-side column retires. The dashboard's `lastSeqByAgent` cursor STAYS — see the ADR-024 consequences stanza for why.

**Amendment (ADR-024, 2026-05-18):** Under the Postgres + Zero sync architecture, settled-state convergence is handled by Postgres logical replication via zero-cache — the per-block `last_event_seq` cursor + boot*id invalidation pattern retires. The invariant **narrows** to the live-turn delta path: the daemon's in-memory accumulator for the in-flight block is updated \_before* the corresponding SSE `block_delta` is emitted; on `block_complete` the Postgres row is written with `streaming=0` (which is what Zero replicates). Per-turn SSE replay buffer remains the safety net for refresh-mid-stream.

Each event has a monotonic `seq`. The block row is updated to `last_event_seq = N` _before_ the event with that seq is broadcast. Browsers on focus switch / reconnect can read DB up to cursor K and live-render only events with `seq > K`. No double-application, no missed events.

**Per-block granularity (WS-1).** The invariant now holds at the _block_ row level, not the turn level. Each row in the `blocks` table — one per content block (text / thinking / tool_use / tool_result / user / mail) — carries its own `last_event_seq`. Streaming deltas advance the row before the corresponding `block_delta` SSE event is emitted; `block_stop` flips `streaming = 0` after the row is final. This means a refresh mid-turn lands on exactly the bytes the live stream had: there's nothing to reconcile because there's no separate per-turn "canonical" representation.

**boot_id cursor reset.** SSE consumers cache `lastSeqByAgent`, which keeps them caught up across reconnects within a single daemon lifetime. Across a daemon restart, sequence numbers reset to 1 — a cached cursor of 500 would silently skip half the post-restart events. The daemon now generates a fresh `boot_id` on startup and stamps it on every `connection_established` SSE frame. Clients compare boot_ids on reconnect: a mismatch invalidates the cached cursor and triggers a full reload from the DB. Sequences stay simple integers, but cross-restart correctness is preserved.

## ADR-005 — Three-layer prompt stack: CONSTITUTION / SOUL / agent base

**Status:** accepted

`CONSTITUTION.md` is source-only, inviolate, prepended to every agent's system prompt. `SOUL.md` is the user's one override slot, copied to `~/.friday/SOUL.md` on first boot and never overwritten on upgrade. `agents/<type>.md` are role-specific bases, source-only. Protocols stack on top per agent. Skills inject per-turn. Memory auto-recall prepends to the user message.

## ADR-006 — Tickets table is system-agnostic; external systems join via `ticket_external_links`

**Status:** accepted

`tickets` doesn't know about Linear, GitHub, or any specific system. `ticket_external_links` carries `(ticket_id, system, external_id, url)` with the composite index `(system, external_id)`. Adding a new ticket integration is a sibling package, not a schema change.

**Amendment (status: accepted):** integrations are read-only **except** for one narrow write path — terminal-status propagation when a linked agent is archived. The closer in `services/daemon/src/services/ticket-close.ts` reads `ticket_external_links` for the just-closed ticket and dispatches per-`system` to the integration's state-write helper (today: Linear's `setIssueStateByType`). The local Friday ticket remains the authoritative status source; the integration is being told, not asked. This keeps the boot-time reconcile pass and orchestrator-driven import strictly read-side, while preventing the "Friday ticket says done, Linear still says In Progress" drift that prompted this amendment.

## ADR-007 — Attachments dedup by DB row + sha-bucket disk path

**Status:** accepted

`attachments.sha256` is the PK. Upload flow: hash bytes → DB lookup by sha256 → reuse row if hit (re-write file on disk if missing). Storage path is `~/.friday/uploads/<sha-bucket>/<sha>.<ext>` where bucket is the first two hex chars (256 buckets) — content-addressed, time-independent.

## ADR-008 — No public sign-up, ever

**Status:** accepted

Single-user system. `friday setup` is the only path to create the primary account. The dashboard's `/api/auth/sign-up` endpoint is permanently disabled (`disableSignUp: true` in BetterAuth). Recovery via `friday setup --reset-password` on the host. No email-recovery, no SMS — recovery is "you have shell access where Friday lives."

## ADR-009 — Tmux-backed daemon supervision

**Status:** superseded by ADR-028 (2026-05-20). Original tmux design + ADR-023 zero-cache amendment preserved below for context.

`friday start` launches daemon and dashboard inside a tmux session named `friday`. `friday stop` kills the session. `friday attach` opens the panes for live debugging. No launchd or systemd to configure. Restart-on-crash via tmux + a small wrapper.

**Amendment (ADR-023, 2026-05-18):** The tmux session gains a `zero-cache` pane alongside daemon, dashboard, and CFT. Postgres itself is **not** in tmux — it's managed by `brew services` as a host-level service, lifecycle-independent of `friday start/stop`. `friday doctor` checks `pg_isready` and surfaces actionable guidance ("Run `brew services start postgresql@18`") if Postgres is down. The `friday` tmux session lifecycle remains short and bounded: start it, attach to debug, kill it to stop Friday — without taking down a database that other host tools might share.

## ADR-010 — `/scratch` spawns Bare agents, not Helpers

**Status:** accepted

User-spawned ad-hoc sessions use the existing Bare agent type. Bares already exist in the system as interactive-but-headless agents (used for evolve enrichment, etc.). Promoting them to first-class chat citizens avoids duplicating Helper's purpose. Helpers remain orchestrator-spawned for scoped sub-tasks.

## ADR-011 — Daemon binds one port for HTTP + SSE

**Status:** accepted (note: ADR-023 adds zero-cache on a separate localhost port)

The early plan called for two daemon ports (HTTP API + SSE) — a holdover from the old Slack-era event server. SSE is just a long-lived HTTP response; there's no operational reason to split. One port keeps `friday doctor`, port-conflict diagnostics, and the dashboard's reverse proxy simpler. The dashboard's `/api/events` proxies to the same `daemonPort` everything else hits.

**Note (ADR-023, 2026-05-18):** The daemon still binds a single port for its own HTTP + SSE. The new `zero-cache` sidecar process binds its own localhost port (default `4848`). Both are `127.0.0.1`-only; the dashboard's reverse proxy is the sole public surface. CFT continues to expose exactly one port to the internet (the dashboard's).

## ADR-012 — JSONL is boot-recovery only; the daemon writes blocks directly from worker IPC

**Status:** accepted (revised 2026-05-12, FIX_FORWARD 8.1; supersedes the original tail-watcher design)

The Claude Agent SDK still writes session transcripts to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, but those files are **no longer tail-watched for live data**. The daemon receives block-level streaming directly from each worker over its IPC channel — `block-start` / `block-delta` / `block-stop` messages — and writes the `blocks` table itself. SSE consumers read from the same table, so what an in-progress page sees is byte-for-byte what a refresh would see after the turn completes.

JSONL retention purpose:

- **Boot-time recovery.** On daemon restart, `services/daemon/src/agent/jsonl-recovery.ts` walks each session's JSONL once and back-fills any blocks that should exist but don't (worker crashed between `block-stop` and DB write, or the daemon crashed mid-emit). Idempotent on `block_id`.
- **Compaction / off-line analysis.** Tools that want a frozen, append-only audit trail still have one.

The original design tried to surface in-flight text by writing streaming preview rows at `turn_index = 0` in the `turns` table; that was abandoned in favor of SSE deltas. The `turns` table itself was superseded by `blocks` in the WS-1 schema refactor — see the ADR on the block model for the full rationale.

## ADR-013 — `agents.json` and per-channel session files removed; SQLite is the registry

**Status:** accepted (amended by ADR-023, 2026-05-18 — registry storage is Postgres, not SQLite)

The old Friday tracked agents in `~/.friday/agents.json` and per-Slack-channel session metadata in JSON files under `~/.friday/sessions/`. The new system collapses both into the `agents` SQLite table. Single writer (the daemon), atomic updates, queryable, indexed. Boot recovery scans the table; no more JSON-rewrite races.

**Amendment (ADR-023, 2026-05-18):** The `agents` table moves from SQLite to Postgres along with the rest of the schema. The single-writer property is replaced by Postgres MVCC — daemon writes registry transitions for worker lifecycle, dashboard mutators write registry transitions for archive/spawn intents (which the daemon then picks up and acts on). The "atomic updates, queryable, indexed, no JSON-rewrite races" properties all carry forward.

## ADR-014 — Mail bus event names: `mail:to:<agent>` + `mail:any`

**Status:** accepted (amended by ADR-023, 2026-05-18)

The shared `mailBus` EventEmitter (`packages/shared/src/services/mail.ts`) emits two events on every `sendMail()` call: a per-recipient `mail:to:<agentName>` for direct subscription, and a generic `mail:any` for spectator subscribers (the daemon's mail-bridge re-publishes both as SSE `mail_delivered` and IPC `mail-wakeup`). Event-name collisions are prevented by the agent-name regex (`/^[a-z0-9][a-z0-9-]{0,62}$/`).

**Priority mail (amended 2026-05-12, FIX_FORWARD 8.4).** The `mail.priority` field gates _when_ the recipient sees the message:

- `'normal'` (default): mail is queued and re-injected at the **next turn boundary**, matching the original ADR-014 behavior. The receiving worker finishes whatever it's doing, then receives the queued items in its next turn.
- `'critical'`: the daemon emits an IPC `mail-wakeup-critical` on delivery. Workers check for pending critical mail at every SDK iteration boundary inside a turn and break out early, so the next iteration sees the message even mid-turn. Use sparingly — interrupting tool loops costs work in flight.

Mid-turn injection is opt-in per send; the bus event names and the SSE `mail_delivered` shape are unchanged.

**Amendment (ADR-023, 2026-05-18):** Under Postgres + Zero, the in-process `mailBus` EventEmitter remains the **fast path** for daemon-internal callers (a worker's `mail_send` tool call hitting the mail-bridge handler with sub-millisecond latency). The **durable path** is Postgres LISTEN on `new_mail` — the same handler fires whether the mail row was written by daemon-internal code, by a dashboard mutator, or by boot recovery. The SSE `mail_delivered` event is **retired** (settled state is conveyed by the row insert replicating via Zero — clients' reactive query on `mail` updates automatically). The `mail-wakeup-critical` IPC path retains its fast-path-plus-LISTEN-durable-path shape (see ADR-023's fast-path/durable-path pattern).

## ADR-015 — BetterAuth tables in our Drizzle schema, BetterAuth owns its migrations

**Status:** accepted (amended by ADR-023, 2026-05-18 — Postgres adapter replaces SQLite adapter)

`accounts`, `sessions`, `users`, `verification` are declared in `schema.ts` for typed access from the rest of the app, but BetterAuth's CLI (`@better-auth/cli`) handles the actual table creation. Field names match BetterAuth's defaults. If they ever drift, BetterAuth's runtime wins and we update our typed declarations to match.

**Amendment (ADR-023, 2026-05-18):** BetterAuth switches from its SQLite adapter to its Postgres adapter. Field names and the "BetterAuth owns its migrations, we own the typed declarations" contract are unchanged. The dashboard additionally mints short-lived JWTs from BetterAuth sessions for zero-cache auth (server-to-server credential; never exposed to the browser).

## ADR-016 — `blocks` table replaces `turns`; live in-flight state lives in daemon memory

**Status:** accepted (2026-05-12, FIX_FORWARD 8.3; supersedes the granularity portion of ADR-012 / ADR-004)

The `turns` table modeled one row per turn, with the entire content array serialized as JSON inside it. That worked for post-hoc rendering but coupled the two distinct concerns — _what eventually lands in the transcript_ and _what's currently streaming_ — into the same row. Live updates required either rewriting the JSON blob on every delta (expensive, race-prone) or living with the lie that the in-flight UI was extrapolating from SSE events with no DB-side ground truth.

**The new model:**

- **`blocks` table.** One row per content block (kinds: `text`, `thinking`, `tool_use`, `tool_result`, `user`, `mail`). Stable UUID `block_id` is the primary key. Block rows carry their own `seq` cursor, `streaming` flag, and source enum (`worker` for live streaming, `jsonl` for boot recovery). Per-block `last_event_seq` makes SSE cursoring trivial — see ADR-004's amendment.
- **In-memory `liveTurns` registry.** Buffers in-flight block state (deltas, partial JSON, tool-use args being assembled) inside the daemon process, keyed by `turn_id`. Crashes lose only the in-flight buffer; the persisted block rows are unaffected.
- **JSONL is boot-recovery only.** Per ADR-012's revision, the daemon writes block rows directly from worker IPC. JSONL exists so a crashed mid-block can be re-derived on restart and so an audit trail survives outside the DB.
- **FTS5.** `blocks_fts` provides full-text search across the content column. Triggers (`blocks_fts_ai/ad/au`) keep it in sync — see WS-5.1.

What this buys:

- Refresh-during-stream returns identical bytes to what the live view had — there's only one source of truth.
- Per-content-block addressability for `/jump`, deep links, and "scroll-to" affordances.
- Tool-result expansion doesn't require parsing a serialized JSON array.
- FTS5 search across exactly the granularity the user reasons about.

The old `turns` table is retained for read-side compatibility during the migration window but is no longer written; user data is migrated by a one-shot script under `scripts/` that's run once by the operator and discarded.

## ADR-017 — `chat_reply` MCP tool and `/api/chat/reply` removed; mail is the universal delivery primitive

**Status:** accepted (2026-05-12, FIX_FORWARD 8.5; supersedes the original chat-vs-mail split)

The earlier system had two parallel delivery primitives:

- **`chat_reply`** — orchestrator-only MCP tool that wrote a user-visible reply directly to the dashboard chat. Bypassed the mail bus.
- **`mail_send`** — universal inter-agent messaging. Triggered the IPC `mail-wakeup` for the receiving worker.

That split forced every site that wanted to "say something to the user" to pick a side, and the dashboard had to reconcile two streams with subtly different shapes (chat-reply rows were authoritative; mail rows landed via the bridge). It also blocked builders/helpers from speaking to the user except through the orchestrator's `chat_reply`.

**The new model:** `chat_reply` and `/api/chat/reply` are removed. All user-visible deliveries go through `mail_send` with the recipient set to `'friday'` (the orchestrator's mail box). The orchestrator's mail-bridge surfaces those messages as block rows (kind `mail`) in the chat. Builders and helpers can address the user the same way — they `mail_send` to `friday`, and the orchestrator decides whether to forward, summarize, or hold.

Consequences:

- One delivery primitive, one set of semantics, one place to instrument.
- Builders' progress reports land in the chat without orchestrator stitching.
- The `priority` field on mail (per ADR-014's amendment) gives senders mid-turn interruption when it matters.

## ADR-018 — Connectivity-chain widget replaces Bot/Live status dots

**Status:** accepted (amended by ADR-024, 2026-05-18 — SSE stage becomes Sync stage)

The old header had two indicator dots — "Bot" (is the agent alive?) and "Live" (is SSE streaming?) — that turned out to under-communicate the failure mode in the most common outage: the _browser_ lost connectivity. The dots stayed colored based on stale daemon state, and the user spent a minute confused about why nothing was updating.

**The new model:** a connectivity-chain widget with three sequential stages, each rendered as a small dot:

1. **Internet** — is the browser online? (`navigator.onLine` + lightweight ping.)
2. **SSE** — is `/api/events` connected and seen a frame in the last keepalive window?
3. **Daemon** — is the daemon reachable from the dashboard server (via `/api/health`)?

Rules:

- Each stage has its own ok / warn / error state derived from observed signals (no derived "Bot alive" inference).
- **Grey cascade:** if an upstream stage is in error, downstream stages render grey ("unknown because upstream is down") rather than red. We can't probe SSE health while Internet is dead; lying about it would be worse than admitting the cascade.
- **Tooltips are informational only.** Hovering reveals the last error, last successful sample timestamp, and the action the user can take ("check your wifi", "see daemon logs"). No clickable mitigations — this is a status surface, not a control plane.

Implementation: `services/dashboard/src/lib/components/Connectivity/ConnectivityWidget.svelte`. The fetch-based SSE client (WS-3) feeds it the SSE stage; an in-page periodic `/api/health` poll feeds the Daemon stage.

**Amendment (ADR-024, 2026-05-18):** The middle stage becomes **Sync** (Zero WS health) rather than **SSE**. SSE remains in the system as the live-turn delta side-channel (per ADR-024); its health is shown as a sub-indicator on the Sync stage tooltip rather than as its own top-level stage. Rationale: sync health is the dominant signal — if Zero is down, the user has no realtime feed of anything; if SSE is briefly down but Zero is up, the user still sees settled state flowing and only loses live-typing fidelity on the active turn (a smaller failure mode that deserves an inline affordance, not a top-level dot). Grey-cascade rule unchanged.

## ADR-019 — Older-history prepend anchors on a rendered DOM element, with a WebKit overflow-toggle for paint commit

**Status:** accepted (2026-05-13)

When the user scrolls up to the top of the chat, an `IntersectionObserver` on a top-sentinel triggers `chat.loadOlderTurns()`, which fetches and prepends up to 50 older messages. The user should stay looking at the same content rather than jumping to the new top of the list. Getting that right turned out to involve two separate problems with two separate fixes.

**1. Scroll-anchor preservation: capture a rendered DOM element, not `scrollHeight` math.**

The intuitive approach is `scrollTop = beforeTop + (scrollHeight - beforeHeight)` — measure the height growth after prepend, shift `scrollTop` by that delta. We tried it; it's brittle. Layout-flush timing across Svelte's reactive flush, `await tick()`, `requestAnimationFrame`, and `getBoundingClientRect` interacts subtly with browser-specific reflow batching, and small subpixel discrepancies stack up across pagination rounds. Instead:

- Before triggering the load, capture the first currently-rendered bubble's `data-msg-id` and its `getBoundingClientRect().top` relative to the scroll container.
- Pass an `onPrepended` callback into `chat.loadOlderTurns()` so the anchor fix runs synchronously after the messages array is mutated (not after the artificial `MIN_LOADING_MS` spinner-hold delay).
- In the callback, `await tick()` to ensure Svelte's DOM update has flushed, find the same bubble in the new DOM by id, measure its new offset, and shift `scrollTop` by `newOffset - anchorOffset`.

No `scrollHeight` arithmetic, no rAF gap. The math operates on the actual rendered position of a concrete element.

**2. WebKit / Safari / Orion paint-deferral: wrap the `scrollTop` write in a synchronous `overflow-y: hidden` toggle.**

WebKit's scroll thread defers committing a programmatic `scrollTop` change — and painting the newly-revealed region — until either the scroll thread goes idle or the next user-originated scroll event fires. When the user fast-scrolls and pegs at the top before the load completes, the scroll thread is still "hot": our `scrollTop` write lands but the area below the previously-painted region stays blank until the user scrolls 1px to wake the compositor. DOM and layout are correct; only the GPU paint is stale. Chromium's `overflow-anchor` doesn't help — WebKit didn't ship the feature until Safari 18, and even there it's the wrong layer. Layer promotion (`transform: translate3d`, `will-change`) doesn't address the scroll-thread state at all and has its own counter-productive interactions in WebKit (react-virtualized#453).

The fix is a one-tick `overflow-y: hidden` window around the `scrollTop` write:

```ts
const prev = scroller.style.overflowY;
scroller.style.overflowY = "hidden";
scroller.scrollTop += delta;
setTimeout(() => {
  scroller.style.overflowY = prev;
}, 0);
```

Setting `overflow-y: hidden` synchronously detaches the element from WebKit's scroll thread, forcing it to commit the pending scroll position and flush a paint of the now-non-scrollable region. The async restore (`setTimeout 0`) reattaches the scroll thread once the paint has happened. **A synchronous restore reproduces the bug** — the asynchronous tick is load-bearing; this is not a place to "clean up" by inlining. Pattern adopted from `inokawa/virtua` PR #862, originally `prud/ios-overflow-scroll-to-top`. Preserves inertial / momentum scrolling because the toggle window is one task wide and visually invisible.

The CSS rule on `.chat-transcript` keeps `overflow-anchor: none` as Chromium-side belt-and-braces (free on WebKit); layer-promotion hints are deliberately _not_ added. **Amendment (ADR-039):** the chat scroller is now the document, not an element — §1's element-anchor technique stands, but the overflow-toggle in §2 is superseded by ADR-039's double-`requestAnimationFrame` around the `window` scroll write. Because that write is deferred (no longer synchronous before ResizeObserver delivery), the restore moved to a single owner in ChatShell, which performs the element-anchor measurement and queues the one correction — fed by its `.list` ResizeObserver (content growth, prepends) and by an `onWindowSlide` hook from ChatMessages (a virtualization slide swaps equal bubble counts, so the list's net height can be ~0px and the RO never fires). The ChatMessages call sites no longer restore on their own.

## ADR-020 — Invariant auditor is a timer-based safety net, not the primary enforcement

**Status:** accepted (2026-05-14)

Friday hit a class of bugs where the registry's view of an agent diverged from external reality — a builder row claimed status=`working` long after its worktree directory had been deleted, mail recovery happily re-dispatched to it on every restart, the dashboard rendered a green pulsing dot on a corpse. The migration that should have converted `killed`→`archived` missed it (the buggy pre-F1-A exit handler had raced it into `idle`), boot recovery only catches drift at startup, and no inline check at `spawnTurn` validated the worktree existed before forking.

The fix we ultimately want is **inline checks at every state boundary**: validate the agent can run before `spawnTurn` forks; reject `archived → working` transitions in `registry.setStatus`; refuse to dispatch mail to an agent whose worktree is gone. Each is fast, deterministic, and tied to the exact moment the bug would manifest.

What shipped instead is a **periodic invariant auditor** (`services/daemon/src/agent/invariants.ts`) running every 60 s. Two reasons it's a timer and not (yet) inline:

1. **Some drift is external to the daemon.** A user `rm -rf`'s a worktree from a terminal; a worker is SIGKILL'd by an external process and never fires its exit handler; a future code path mutates the SQLite DB directly. For these there's no code-controlled moment to hook into. `fs.watch` on macOS is unreliable for delete events; process death without a SIGCHLD signal can't be detected synchronously. A periodic scan is the right primitive — cheap (one `listAgents()` + one `existsSync()` per builder), idempotent, bounded-latency.
2. **A consistent enforcement boundary doesn't exist yet.** `registry.setStatus` is currently free-form (any status → any status). Turning it into a state-machine gate that rejects impossible transitions is the obviously-better design but it's a larger refactor — many call sites assume permissive `setStatus`. The auditor unblocks shipping the fix without that refactor.

**Trade-offs accepted:**

- Up to 60 s latency between drift and heal. For Class B drift (external) this is fine; for Class A (code-controlled paths that should have validated inline) it's a regression vs the ideal design.
- The auditor as primary enforcement is a coarser net than inline checks. If a new state-mutation path lands without invariant enforcement, the auditor catches it within 60 s rather than at the moment of the bug — and the only signal that something is missing inline is the daemon log consistently archiving/demoting the same agent on every tick.

**Path forward (deferred, not blocked):**

If/when we harden further:

- Promote `registry.setStatus` to a state-machine gate; codify the transition table (`idle ↔ working`, `working → stalled`, `* → archived` is terminal, etc.).
- Add inline checks at `spawnTurn` / `dispatchTurn` / mail-bridge dispatch / the `/api/agents/:name/archive` handler for the agent-row-vs-filesystem invariant.
- Drop the auditor interval to 5–10 min once the inline checks carry the load; keep it as defense-in-depth for Class B.

**Implementation notes (current shape):**

- One sync pass at boot + 60 s interval thereafter.
- Each rule names its source of truth in the code comment (`existsSync(worktreePath)` for rule 1; `lifecycle.live` Map for rule 2). New rules MUST do the same — guessing whose word wins on a conflict is the #1 way these subsystems rot.
- Rule precedence: terminal states (archive) beat transient states (demote). A row that violates both rules 1 and 2 gets archived, not demoted to idle — demoting would let it slip back into mail recovery on the next boot.
- Each healed agent publishes the corresponding SSE event (`agent_lifecycle:archive` or `agent_status:idle`) so the dashboard reflects the fix within the next 30 s `/api/agents` poll.

Adding a new invariant: see the "Adding a new invariant" section in `docs/architecture.md`.

## ADR-021 — Friday Apps: folder-as-app, manifest-driven, hard memory/files split

**Status:** accepted (FRI-78, 2026-05-16)

A Friday App is a named, installable, agent-owning, MCP-extending
folder under the apps data directory. The manifest on disk
(`manifest.json`) is the source of truth; the SQLite `apps` table is
derived state we reconcile against it at boot and on every install,
uninstall, or reload. App ownership flows down to agents and
schedules through nullable `app_id` columns.

**Load-bearing decisions locked in by FRI-75's grilling:**

1. **Hard split: memory = facts, files = operational data.** The
   memory store is untouched by the apps platform. No per-app claim
   tables, no recall ranker, no `family` tag override. Apps that
   need operational state (libraries, routines, generated artifacts,
   structured config) put it in files under their own folder. Apps
   that need cross-cutting facts save memory entries normally.
   Earlier directions explored per-app memory namespacing; profiling
   real meal-app entries showed two distinct data shapes (facts vs.
   operational state) that wanted different homes. Giving apps a
   directory eliminated the namespacing problem at the source
   rather than papering over it with a ranker.

2. **Trust by discipline, not enforcement.** Apps run with daemon
   privileges. No sandboxing, no capability enforcement, no
   `commandAllowlist` in v1. Protection is: collision detection at
   install time, symmetric uninstall, audit-visible state.
   Capability enforcement arrives if/when family-visibility lands.

3. **Manifest on disk is source of truth.** A daemon boot, or any
   tool call that mutates state, reconciles. A folder that
   disappears flips its row to `status='orphaned'` — never
   auto-deleted (Constitution §1: preserve over delete).

4. **Default-safe destructive flags.** Every destructive tool defaults
   to the non-destructive behavior. Opting into folder-delete or any
   other irreversible move requires an explicit flag, with a
   description leading with the irreversibility.

5. **Stdio-only, node-only, hard-coded.** App-shipped MCP servers run
   as stdio child processes, `command: "node"`, no in-process
   loading. Python and bun expansion is post-v1.

6. **Symmetric vocab.** `install` / `uninstall`. Not `register` /
   `deregister`. Not `add` / `remove`. Tool surface, CLI surface, and
   SSE events all use install / uninstall.

7. **No HTTP route mounting (yet).** No route surface under
   `/apps/<id>/*` in v1. The dashboard surface is a single read-only
   Settings card. Mounting per-app routes is a v2 problem once we
   have an app that demands it.

**What this unlocks:** an app folder Friday or the user can author
once, install via one tool call, and Friday self-manages thereafter
— including per-app stdio MCP servers (e.g. a Mealie integration)
scoped only to that app's agents, with secrets in the app's own
`.env`.

**Deferred (not dropped):** HTTP route mounting, dedicated
dashboard routes with per-app drill-down, capability declarations,
sandbox enforcement, declarative migration system, lifecycle hooks,
cross-app explicit sharing, Python/bun MCP commands, in-process
MCP servers. Per-app memory namespacing, soft-quarantine recall
rankers, and `family`-tag overrides are removed from the design
entirely, not deferred — replaced by the hard split.

## ADR-022 — Builders and Helpers may spawn Helpers (with reason); only the orchestrator spawns Builders

**Status:** shipped (FRI-102, 2026-05-21)

Today the Builder prompt reads "Do not create new builders. Do not spawn helpers" (`packages/shared/src/prompts/agents/builder.md:8`) and the `friday-agents` MCP server is hard-gated to `callerType === "orchestrator"` (`services/daemon/src/mcp/builder.ts:84`). A Builder mid-task that needs scoped research — "what does this third-party API actually return?", "summarize this 30-file directory before I edit", "fetch and digest an upstream RFC" — has to package the question, mail the orchestrator, wait for a turn, and resume. The orchestrator then spawns the Helper anyway. The middleman adds latency, drains the orchestrator's context with sub-agent bookkeeping, and discourages sub-agents from asking for help they should be asking for. The same goes for a Helper doing genuinely large comprehensive analysis — there are real tasks (five independent dependency trees, ten files of cross-cutting refactor analysis) where parallel sub-Helpers are the right shape.

In Seth's framing: _"research aids to the agents making shit is super helpful."_ And later: _"If a builder needs to do research and the context of that research isn't important but the results are: Helper. If a helper is tasked with doing really comprehensive analysis of some tricky problem: sub-Helpers. This seems obvious, we just need to codify it so it also seems obvious to the agents WHILE ALSO not creating runaway conditions. An infinite trail of helpers deeply nested helps no one."_ That's the value frame **and** the failure mode the rules below have to navigate.

**Decision.** The spawn matrix is:

| Spawner      | Helper           | Builder |
| ------------ | ---------------- | ------- |
| Orchestrator | ✅               | ✅      |
| Builder      | ✅ _with reason_ | ❌      |
| Helper       | ✅ _with reason_ | ❌      |

The hard structural rule — enforced in code at the API handler — is _only_ the Builder column: **no agent other than the orchestrator can create a Builder.** Helpers spawning Helpers is allowed in code; the discipline against unjustified nesting lives in prompts, telemetry, and the evolve signal, not in a daemon-side count cap.

**Why this shape:**

1. **Containment holds for Helpers under Builders.** Helpers don't have worktrees — `services/daemon/src/api/server.ts:1331` (inside the extracted `createAgent`) only branches on `body.type === "builder"` for `createWorkspace`; every other type starts with `workingDirectory = process.cwd()`. A Builder-spawned Helper therefore lands in the daemon's cwd, **not** in the Builder's worktree. The constitutional rule "Workspace containment for builders" is preserved by construction: the Helper has no path into the worktree, and the Builder's prompt-level "do not read, write, or modify files outside it" rule still binds the _Builder_. If a Builder passes its worktree path to a Helper as data, the Helper could read it; that's a prompt-discipline issue, not a containment break, and it's identical to the surface a Helper has today when the orchestrator hands it the same path.
2. **Helpers spawning Helpers is justified by real workload shapes.** Parallelizing five independent investigations costs roughly 5× the API spend but converges in roughly 1× the wall-clock time _and_ keeps the parent Helper's context clean (each sub-Helper's verbose tool-call traffic stays in its own session). Forcing every helper-of-helper to route through the orchestrator just to be re-spawned by it is theater.
3. **Builders can't be spawned by anyone but the orchestrator.** Each Builder is a worktree + branch + push-rights surface. Letting a Builder or Helper cut another worktree turns the blast radius of a single rogue task into N rogue tasks with N branches and N PRs. The orchestrator's "user approval gate before creating Builders" (Constitution §3) exists precisely because Builders are the irreversible surface; delegating that gate to another agent defeats it. This is the **only** rule the API handler enforces unconditionally.

**Cost runaway is real but not solved with a hard cap.** Each Helper consumes its own context + API spend; a 4-deep nested fanout multiplies fast. We considered (and rejected for v1) a per-agent concurrent-helper count cap. The reason: the right number depends on the task — a Helper doing genuine 10-way parallel analysis should not be blocked by a `>=3` heuristic, and a Helper doing pointless 2-way nesting shouldn't be rewarded just for staying under the line. We instead bound runaway via prompt discipline + visibility + a feedback loop:

- **Required `reason` field on spawn from non-orchestrator agents.** The `agent_create` API handler requires a non-empty `reason: string` when the caller's registry row has `type === "builder"` or `type === "helper"`. The orchestrator's spawn calls don't need it (it spawns from user intent already in the transcript). The reason is persisted on the registry row (new nullable `spawn_reason text` column) and surfaced in the dashboard's per-agent header so a human can audit "why does this helper exist." This is **not** a soft cap — it's a justification field. The point is to make the agent type the sentence "I'm spawning a helper because…" out loud; sub-agents that struggle to produce a non-tautological reason often shouldn't be spawning in the first place.
- **Structured spawn telemetry.** Every successful spawn emits a daemon event `agent.spawn` with shape `{ parent, child, type, depth, parentChain: string[], reason, ts }` to `logs/daemon.jsonl`. `depth` is computed at registration time by walking `parentName` upward through the registry until a null parent (orchestrator). `parentChain` is the full ordered list root→leaf, capped at a sane length (e.g. 16) just to bound log line size.
- **Evolve signal, not a hard block.** If `agent.spawn` events at `depth >= 4` fire more than N times in a rolling window (threshold telemetry-driven, see open questions), the meta-agent in `packages/evolve` emits a proposal that lands in the daily digest. The orchestrator (and user) get a visibility flag — not an interrupt, not a kill. Depth 1–3 is everyday work; depth ≥ 4 is "look at this" without prejudging whether it's good or bad.

**Prompt-level antipattern, named explicitly.** Both `builder.md` and `helper.md` get a "When to spawn a Helper" section with concrete YES / NO examples and the line _"infinite trails of nested helpers help no one"_ verbatim. Giving the agent that exact language makes the failure mode recognizable from inside its own reasoning. Examples:

- **YES — Builder spawning a Helper:** "Five third-party APIs return shapes I haven't seen; I'll spawn a Helper per API to digest its docs and report back a one-paragraph contract each."
- **YES — Helper spawning sub-Helpers:** "Comprehensive analysis of a 12-file refactor; I'll spawn one sub-Helper per file to summarize its surface area in parallel."
- **NO:** "I'll spawn a Helper to answer a one-line factual question I could resolve myself in 5 seconds."
- **NO:** "My sub-Helper just spawned its own sub-Helper which is going to spawn another. None of us actually needs the next layer."

**Observability.** The dashboard sidebar (`services/dashboard/src/lib/components/Sidebar/Sidebar.svelte:102`) renders a flat list with the orchestrator pinned at top; it does **not** today render explicit `parent → child` tree edges or depth indentation. With Helpers-of-Helpers allowed, depth becomes meaningful and the flat list will misrepresent the structure. Verifying the existing component handles arbitrary-depth nesting cleanly (it doesn't, based on the read of lines 102–109) is a tracked follow-up: render the hierarchy with depth indent + a small `depth: N` badge, and a "parent: <name>" affordance on every non-orchestrator row. This is a follow-up ticket, not a blocker for the daemon/prompt changes.

**Mail loop risk.** Builder ↔ Helper or Helper ↔ Helper mail can in principle loop. Mail is the existing primitive and has the usual safety guarantees (turns are queued, workers rate-limit, archive halts delivery). We rely on those plus the evolve depth signal. If real loops materialize, the lever is `agent_archive` plus tightening the depth threshold for the evolve signal.

**Implementation plan (for the follow-up builder, not this PR):**

1. **`builder.md` prompt.** Rewrite the line at `packages/shared/src/prompts/agents/builder.md:8` from `Do not create new builders. Do not spawn helpers.` to `Do not create new builders. You **may** spawn Helpers via agent_create when their results matter to you but their working context shouldn't pollute yours. Every spawn requires a non-empty reason field.` Add a new "When to spawn a Helper" subsection with the YES / NO examples above and the verbatim _"Infinite trails of nested helpers help no one."_ Update the Tools list to include `agent_create` / `agent_list` / `agent_status` / `agent_inspect` / `agent_archive`. Revise the line 40 paragraph (`Do not use the built-in Task tool…`) to clarify `agent_create` is the spawn path.

2. **`helper.md` prompt.** Drop the "leaf" framing entirely. Add a parallel "When to spawn a sub-Helper" section with the same YES / NO examples scoped to Helpers, the verbatim antipattern line, and a sentence: `You may spawn sub-Helpers when a task is genuinely large and parallelizable. Every spawn requires a non-empty reason field. You may not spawn Builders.` Update line 19 (`Do not use the built-in Task tool…`) to read `mail your parent` (parent may now be a Builder or another Helper). Update the Tools list to include `agent_create` / `agent_list` / `agent_status` / `agent_inspect` / `agent_archive`.

3. **MCP allowlist.** In `services/daemon/src/mcp/builder.ts`, change the `if (opts.callerType === "orchestrator")` guard around `buildAgentsServer` (line 84) to `if (opts.callerType === "orchestrator" || opts.callerType === "builder" || opts.callerType === "helper")`. The Builder and Helper get the full `agent_*` surface including `agent_archive` so they can clean up sub-agents they spawned.

4. **`agent_create` MCP tool schema.** In `services/daemon/src/mcp/agents.ts:102-143`, add `reason: z.string().optional().describe("Why you are spawning this agent. Required when caller is a builder or helper; ignored from orchestrator.")` to the zod schema, and pass `reason: args.reason` through to the API body at line 149-157.

5. **Daemon-side guard + reason enforcement + telemetry.** In `services/daemon/src/api/server.ts` at the `POST /api/agents` handler (currently lines 469–534):
   - After parsing `body`, look up the caller's registry row by `body.parentName`. If `caller.type === "builder" || caller.type === "helper"`, require `body.type === "helper"` — reject with HTTP 403 + `{ error: "only the orchestrator can spawn builders", code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY" }` when violated. (`bare`-spawned creates can stay disallowed via the existing type check.)
   - For the same non-orchestrator callers, require `typeof body.reason === "string" && body.reason.trim().length > 0`. Reject with HTTP 400 + `{ error: "reason required when spawner is not the orchestrator", code: "SPAWN_REASON_REQUIRED" }` when violated.
   - Persist `reason` on the registry row. Add a `spawnReason: string | null` field to `RegisterInput` in `services/daemon/src/agent/registry.ts:36` and a nullable `spawn_reason` column to the agents table (drizzle migration via `drizzle-kit generate` — do **not** hand-write the `when` timestamp; see the CLAUDE.md migration rules).
   - Compute `depth` and `parentChain` by walking the registry upward; cap chain length at 16. Emit `logger.log("info", "agent.spawn", { parent: body.parentName, child: body.name, type: body.type, depth, parentChain, reason: body.reason ?? null })` immediately after `registry.registerAgent(...)` succeeds.

6. **Evolve signal.** In `packages/evolve`, add a rule that scans the daily `agent.spawn` events and surfaces a proposal when `depth >= 4` occurs more than `N` times in a rolling window. Threshold value left as an open question; wire the scaffolding with `N = 5 / 24h` as a starting placeholder. No hard block — proposal only.

7. **Dashboard tree-render follow-up.** Open a separate ticket: `services/dashboard/src/lib/components/Sidebar/Sidebar.svelte` to render parent→child indentation + a depth badge for any agent whose parent is not the orchestrator. Not in scope for the FRI-38 implementation builder.

8. **Tests.** Add to `services/daemon/src/agent/` (sibling to `invariants.test.ts`):
   - Builder → Helper spawn with a reason returns 200 and registers a row with `parentName` = builder, `type` = helper, `worktreePath` = null, `spawnReason` = the reason. The corresponding `agent.spawn` log line is emitted with `depth: 2`.
   - Helper → Helper spawn with a reason returns 200 and registers `depth: 3` (orchestrator → helper → helper) on the spawn event.
   - Builder → Helper without a reason returns 400 with code `SPAWN_REASON_REQUIRED`.
   - Helper → Helper without a reason returns 400 with code `SPAWN_REASON_REQUIRED`.
   - Builder → Builder returns 403 with code `BUILDER_SPAWN_ORCHESTRATOR_ONLY`.
   - Helper → Builder returns 403 with the same code.
   - Orchestrator → Builder still succeeds with no reason field (the existing path is unchanged for orchestrator callers).
   - MCP gating: `buildMcpServers({ callerType: "builder" })` and `buildMcpServers({ callerType: "helper" })` both include `AGENTS_SERVER_NAME`.
   - The existing "builder doesn't see `agent_*`" assertion in current tests, if present, is **updated** to reflect that builders and helpers now see the surface — don't silently delete the old assertion.

**Open questions** (deliberately not decided here):

- **Evolve threshold.** What's the right depth + count combination for the evolve signal? `depth >= 4`, more than `5` events / `24h` is a starting guess. Telemetry-driven — let real `agent.spawn` data calibrate this once it's flowing.
- **`reason` format.** Free-form text vs. small enum (`research`, `parallel-analysis`, `digest`, etc.)? Free-form is more honest and harder to game; enum is more queryable. Leaning free-form for the MVP; if dashboards or evolve digests want a structured cut later, we can introduce a `kind` enum alongside the free-form field.
- **Auto-archival lineage.** When a Builder (or Helper) archives, do in-flight sub-Helpers cascade-archive, or persist? Probably cascade for `status === "working"` children and persist for `status === "idle"` already-completed children — but flag it.
- **Mail injection.** The orchestrator can already _read_ Builder ↔ Helper mail via the dashboard. Should it be able to _inject_ into that mailbox (e.g. interrupt a runaway nested-Helper exchange)? Today no agent can inject into another's mailbox out-of-band; the orchestrator's only lever is `agent_archive`. Leaving this open until we see whether read-only visibility plus the evolve signal is enough.

## ADR-023 — Postgres + Zero sync layer; daemon and dashboard as peer writers; row-as-intent for side-effect dispatch

**Status:** proposed (2026-05-18)

Supersedes ADR-001. Reshapes ADR-002, ADR-013, ADR-014, ADR-015. Pairs with ADR-024 (SSE narrowed to live-turn deltas).

The current architecture — daemon-owned SQLite + dashboard-as-proxy + bespoke SSE wire — was designed against a "single-user, single-device" mental model with multi-device as a small additive case. In practice the multi-device case is now load-bearing: Seth uses Friday across personal laptop, phone, and a third device (automated Claude sessions), with a tablet on the horizon. Each surface is "two windows watching the same DB through different keyholes" — cursor state diverges, optimistic bubbles only exist on the originating device, unread badges disagree, "phone shows stale state after wake-from-sleep" is a regular complaint. The bespoke SSE + per-block `last_event_seq` + boot_id cursor + paginated REST reload machinery (ADR-003, ADR-004, FIX_FORWARD 8.x) solves the single-device race-free-render problem honestly, but it cannot make the multi-device convergence problem go away — it's the wrong shape for it.

Local-first architecture (Linear-style: durable client-side cache + reactive sync engine + optimistic mutators with server-side replay) is the industry-settled answer to exactly this problem class. The remaining decision was _which_ sync engine and _what server_ it sits on.

### Decision

1. **Postgres replaces SQLite as the canonical store.** Friday's data layer migrates from `~/.friday/db.sqlite` to a Postgres database hosted by the user's local Postgres install (Homebrew + `brew services`). The "everything in `~/.friday/`" property is preserved with a footnote: the Postgres data dir lives wherever Homebrew puts it; Friday gets a database + role inside that install.
2. **Zero (by Rocicorp) is the sync engine.** `zero-cache` runs as a sidecar process tailing Postgres logical replication and serving clients over WebSocket. Client storage is Zero's reactive cache (IndexedDB-backed). The Apache-2 license, the optimistic-mutator model, the SQL-on-the-client reactive-query story, and the active flagship-product status of Zero within Rocicorp's portfolio were the dominant factors.
3. **Daemon and dashboard are peer writers.** Neither owns the DB. The daemon writes Postgres for runtime state (block rows on close, agent status transitions, mail-bridge rows, scheduler firings, app-lifecycle state). The dashboard writes Postgres for mutator-driven changes (user messages, abort intents, archive intents, ticket/memory/schedule edits, settings, client-device telemetry). The single-writer constraint that drove ADR-001's SQLite choice is dissolved by Postgres.
4. **Single public port preserved via reverse proxy.** Cloudflare Tunnel publishes the dashboard only. The dashboard reverse-proxies `/api/sync` (auth-gated WS upgrade → `127.0.0.1:zero-cache-port`) and continues to proxy `/api/events` (SSE → daemon). Zero, daemon, and Postgres remain on `127.0.0.1`.

### Alternatives considered

- **cr-sqlite (vlcn)** — true SQLite ↔ SQLite CRDT. Preserves ADR-001. Rejected: light maintenance heartbeat, schema constraints (special table declaration, historical FK limitations) that would scrape against the existing 12-table schema, and the conflict-resolution machinery is overkill for our single-writer-canonical model.
- **PowerSync** — full SQLite client + Sync Rules. Excellent mobile-SDK story. Rejected: requires Postgres anyway, mobile-SDK advantage is wasted on a PWA-via-browser shape, the bucket/sync-rules model is heavier than Friday's needs.
- **ElectricSQL (current Shapes)** — Postgres + read-path Shapes. Rejected: writes go through a separately-implemented backend API, so half the integration work is still ours; less complete than Zero on the mutator side.
- **Replicache** — backend-agnostic, would have preserved SQLite. Rejected: in maintenance mode at Rocicorp (Zero is the heir). For a system that ships and lives for years, betting on the maintained product is correct.
- **Custom protocol over SQLite + ws library** — viable, ~1500 LOC total. Rejected: the implementation tax across bootstrap, schema-version negotiation, optimistic-mutator replay, and reconnect/resume far exceeds the marginal complexity of running Postgres and Zero, and lacks the cross-team battle-testing those products have.
- **Postgres as canonical with no sync engine** — i.e., keep SSE everywhere, just move the DB. Rejected: moves the operational cost without buying the local-first UX. The whole point is the engine.

### Topology

```
              Cloudflare Tunnel (public)
                         │
                         ▼
              ┌────────────────────────┐
              │   SvelteKit Dashboard  │ ◄── BetterAuth
              │   /api/sync            │ — WS proxy → zero-cache
              │   /api/events          │ — SSE proxy → daemon
              │   /api/mutators        │ — Zero push-url (mutator host)
              └─────┬───────────┬──────┘
                    │           │
                    │           │ writes Postgres directly
                    │           │ for mutator-driven changes
                    ▼           ▼
              ┌────────────────────────┐
              │       Postgres         │ ◄── zero-cache
              │  (logical replication) │       │
              └────▲───────────────────┘       │ WS over /api/sync
                   │                           ▼
                   │ writes runtime state    Clients (PWA / browser)
                   │
              ┌────┴───────────────────┐
              │    Friday Daemon       │
              │  /api/events  (SSE)    │
              │  /api/internal/*       │ — localhost-only fast-path
              │  Claude SDK + workers  │
              │  LISTEN on Postgres    │ — row-as-intent dispatch
              └────────────────────────┘
```

Reboot independence:

- **Dashboard reboot:** already-connected client WS to zero-cache survive (reverse proxy WS-upgrade pattern; brief blip on the reverse-proxy hop, sockets remain on the upstream zero-cache). Daemon continues writing Postgres → zero-cache → already-connected clients see realtime updates throughout. New WS connections fail until dashboard returns. Mutators fail until dashboard returns; Zero queues them locally on the client; flush on reconnect. **No data loss, no missed events for live clients.**
- **Daemon reboot:** dashboard mutators continue to commit. zero-cache continues to replicate. Already-connected clients see new mutator-written rows in real time. Side effects (Claude turns, worker forks, mail delivery) pause until the daemon comes back; daemon's boot recovery scans for `status='pending'` rows and re-dispatches the missed side effects. **Writes always succeed; side effects are eventually-consistent.**

### Row-as-intent pattern

Mutators do not write to a separate `intents` table. Each mutator writes the row(s) it cares about (user blocks, mail rows, ticket rows, etc.), encoding "side-effect required" as a status field value (`pending`, `abort_requested`, `archive_requested`, etc.). The daemon LISTENs on Postgres NOTIFY channels keyed per status transition. On wake, the daemon processes the row with a handler that:

1. Reads the row's current state to detect duplicate dispatch (idempotency).
2. Runs the side effect (fork worker, fire AbortController, kill agent, etc.).
3. Transitions the row's status to its terminal state (`dispatched`, `aborted`, `archived`, etc.) inside the same logical commit as any downstream rows the side effect produces (e.g. assistant block rows for a dispatched turn).

**Boot recovery scans the same WHERE clauses the LISTEN handlers react to.** If the daemon was down when a mutator wrote a `pending` row, boot recovery picks it up on the next start. The live path and recovery path are the same code.

**Determinism contract:** every side effect has a row-state precondition (the WHERE clause that selects it) and a row-state postcondition (the status transition or downstream row inserts that prove it ran). Mutators are idempotent on Zero's `mutation_id` (Zero's contract) and on row primary key (Friday's contract). No "soft" state exists separately from the data — if you ask "is this dispatched?" the answer is the existence of downstream rows, not a flag.

### Fast-path + durable-path pattern

For mutations where end-to-end latency to the daemon's runtime matters (abort, mail-wakeup-critical, cancel-queued), the row-as-intent path is supplemented by a sideband fast-path:

1. The dashboard mutator writes the durable row (contract). Postgres LISTEN will eventually wake the daemon.
2. The dashboard mutator additionally fires `POST 127.0.0.1:<daemonPort>/api/internal/<op>` (fire-and-forget). The daemon's localhost-only internal endpoint invokes the same handler that LISTEN would invoke.
3. The handler is idempotent: whichever path fires first wins; the other path's invocation is a no-op against the post-state.

The `/api/internal/*` endpoints are localhost-only, unauthenticated, and treated the same as the existing CLI inspection surface — `~/.friday/`'s `0700` permissions are the boundary. Daemon-internal callers (mail-bridge re-emitting a `mail_send` tool call from a worker) bypass both paths and invoke the handler directly in-process. Three call sites, one handler, idempotent against all three.

This pattern stays small: the abort, critical-mail-wakeup, and cancel-queued ops are the entire fast-path catalog as of v1. Archive, ticket-edit, memory-edit, schedule-edit, and similar do not need the fast path — Postgres LISTEN latency (~tens of milliseconds) is invisible.

### Bootstrap policy (two-phase, Linear-inspired)

A fresh device (new install, cleared PWA storage, or `Forget this device`) bootstraps in two phases.

**Phase 1 — foreground, blocks first usable UI, target <2s broadband:**

- Last 50 blocks for the orchestrator.
- All non-archived rows from `agents`, `tickets` (counts + last 20), `schedules`, `apps`, `settings`.
- Mail unread count for orchestrator + last 10 rows.
- Memory entry headers (titles + types, no bodies yet).

**Phase 2 — background, progress-indicated, target <2min:**

- Full block history for all non-archived agents and agents archived within the last 24h.
- Full ticket history with comments + relations + external links.
- Full mail history within the last 30 days.
- Full memory entry bodies.
- Full schedule history.
- Full apps state.
- Full evolve proposals.

**Phase 3 — lazy on demand:**

- Blocks for agents archived >24h ago (fetched when user opens that agent's chat).
- Blocks older than 90 days for any agent (fetched on scroll-back via the existing `/api/agents/:name/blocks?before=...` REST endpoint — kept for this fallback).
- Mail older than 30 days (fetched when search triggers it).

### Client retention budget

- Synced data for any agent archived more than 30 days ago and already fully synced: expunged from the local cache.
- Blocks older than 90 days: expunged from the local cache regardless of agent state.
- Memory, tickets, agents, schedules, apps: never expunged from the local cache (small).

Retention enforcement runs client-side as a periodic task (every 24h while the app is active) and on Phase 2 completion. Server-side data is never deleted by this — retention is a client-cache property only.

### Client telemetry

A `client_devices` table tracks per-device storage and sync state:

| Column                | Notes                                                               |
| --------------------- | ------------------------------------------------------------------- |
| `device_id`           | UUID minted on first bootstrap, persisted in localStorage.          |
| `user_agent`          | Set on registration.                                                |
| `label`               | User-editable display name (defaults to UA-derived guess).          |
| `last_seen_ts`        | Updated by the `reportClientStats` mutator.                         |
| `storage_used_bytes`  | `navigator.storage.estimate().usage` (null if browser unsupported). |
| `storage_quota_bytes` | `navigator.storage.estimate().quota` (null if browser unsupported). |
| `last_sync_ts`        | Updated when Phase 2 completes or after a heavy mutator burst.      |

The `reportClientStats` mutator fires from the client every 5 minutes while active, and on Phase 2 completion. The Settings page renders a per-device table with storage indicators; each row offers a "Forget this device" action that calls `forgetDevice` mutator (deletes the row + revokes Zero credentials for that device, forcing re-bootstrap on its next connect).

### Side-effect-bearing mutators (the catalog)

Initial catalog (subject to refinement during implementation):

| Mutator              | Writes                                                                 | Side effect                                                         | Status transitions                                        |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `sendUserMessage`    | `blocks` (kind=user, status=pending)                                   | Daemon forks/dispatches worker                                      | `pending → queued \| complete` (no `dispatched`; ADR-049) |
| `abortTurn`          | `blocks` UPDATE WHERE turn_id (status=abort_requested)                 | Daemon `AbortController.abort()` (fast path)                        | `abort_requested → aborted` (worker exits)                |
| `cancelQueued`       | `blocks` DELETE WHERE block_id AND status=queued                       | Daemon splices `nextPrompts` (fast path)                            | (row deleted)                                             |
| `archiveAgent`       | `agents` UPDATE (status=archive_requested, reason)                     | Daemon archives worktree, closes linked tickets, kills worker       | `archive_requested → archived`                            |
| `createTicket`       | `tickets` INSERT                                                       | None (pure data)                                                    | —                                                         |
| `updateTicket`       | `tickets` UPDATE                                                       | None                                                                | —                                                         |
| `addTicketComment`   | `ticket_comments` INSERT                                               | None                                                                | —                                                         |
| `addTicketRelation`  | `ticket_relations` INSERT                                              | None                                                                | —                                                         |
| `linkTicketExternal` | `ticket_external_links` INSERT                                         | None (Linear push happens via daemon's ticket-close path only)      | —                                                         |
| `createMemoryEntry`  | `memory_entries` INSERT + filesystem write via daemon                  | Daemon writes `~/.friday/memory/entries/<id>.md`                    | `pending_file → ready`                                    |
| `updateMemoryEntry`  | `memory_entries` UPDATE + filesystem write via daemon                  | Daemon rewrites the file                                            | `pending_file → ready`                                    |
| `deleteMemoryEntry`  | `memory_entries` soft-delete + filesystem move                         | Daemon moves file to trash                                          | —                                                         |
| `createSchedule`     | `schedules` INSERT                                                     | Daemon registers cron tick                                          | `pending_register → active`                               |
| `updateSchedule`     | `schedules` UPDATE                                                     | Daemon re-registers cron                                            | `pending_register → active`                               |
| `deleteSchedule`     | `schedules` DELETE                                                     | Daemon unregisters cron                                             | —                                                         |
| `installApp`         | `apps` INSERT + `agents` INSERT(es) + `schedules` INSERT(es) in one tx | Daemon runs installer (collision matrix already enforced inside tx) | `pending_install → installed`                             |
| `uninstallApp`       | `apps` UPDATE (status=uninstall_requested)                             | Daemon archives owned agents, drops schedules                       | `uninstall_requested → uninstalled`                       |
| `reloadApp`          | `apps` UPDATE (status=reload_requested)                                | Daemon re-reads manifest, reconciles                                | `reload_requested → installed`                            |
| `markRead`           | `read_cursors` UPSERT (agent_id, device_id?, last_seen_block_id)       | None                                                                | —                                                         |
| `reportClientStats`  | `client_devices` UPSERT                                                | None                                                                | —                                                         |
| `forgetDevice`       | `client_devices` DELETE                                                | Daemon revokes Zero credentials (LISTEN-only)                       | —                                                         |
| `updateSettings`     | `settings` UPDATE                                                      | Daemon picks up changes (LISTEN-only, varies by setting)            | —                                                         |

Daemon-internal writes (no mutator, no client-originated) continue to land directly in Postgres from the daemon process: block streaming on close, agent status transitions during worker lifecycle, mail rows from `mail_send` tool calls, scheduler tick firings, app-lifecycle reconcile-on-boot, telemetry/usage rows, BetterAuth tables. These are subject to the same row-as-intent semantics where they trigger side effects (e.g., the daemon writes a mail row, daemon also LISTENs on `new_mail` to fire `mail-wakeup` IPC — same handler whether the mail was written by daemon or by dashboard mutator).

### Auth bridge

Dashboard's `/api/sync` WS-upgrade handler reads the BetterAuth session cookie, validates it, mints a short-lived signed JWT (5-minute TTL, refreshed on activity) containing `{userId, sub, deviceId}`, and passes it as the `Authorization` header on the upstream WS to zero-cache. zero-cache's auth callback verifies the JWT signature against a shared secret. Clients never see the JWT directly — it's a server-to-server credential minted from the user's session.

### Schema migration discipline

Drizzle migrations transfer from SQLite to Postgres. The `Date.now()` rule from the project CLAUDE.md still applies: `when` in `_journal.json` must be a real `Date.now()` captured at generation time, never fabricated, never future-dated. The mechanics differ slightly (Postgres-Drizzle uses `__drizzle_migrations` in the public schema; failure mode of one bad `when` poisoning the chain is identical). Migrations run as part of daemon boot before zero-cache reconnects.

Live-client schema-version negotiation is handled by Zero: a client connecting on a stale schema is rejected with a version-mismatch code; the client's PWA service worker delivers the new build; the page hard-reloads. This is the same flow as any PWA dropping a stale cache.

### Consequences

- **Operational surface grows:** Brewfile gains `postgresql@18`; `friday setup` runs `CREATE DATABASE friday OWNER friday` + migrations; `friday doctor` checks `pg_isready`; tmux gains a `zero-cache` pane (Postgres itself is `brew services`-managed, not in tmux).
- **Code surface shrinks net:** localStorage send-queue retired (Zero subsumes); paginated REST block-fetch becomes a lazy fallback only; per-block `last_event_seq` cursor retired; boot_id cursor reset retired; SSE narrows to live-turn deltas only (ADR-024).
- **`~/.friday/db.sqlite` retires.** Existing-install migration is a one-shot scripted dump → Postgres-import on the upgrade path, with a backup of the old `db.sqlite` kept at `~/.friday/db.sqlite.pre-postgres.bak`.
- **Per-branch worktree dev DB story changes.** Each worktree's daemon previously got its own SQLite file; under Postgres, worktrees share the host's Postgres but use distinct database names (e.g. `friday_dev_<branch-hash>` provisioned by `friday setup --dev-branch`). Acknowledged as a small dev-ergonomics tax.
- **Backup story changes.** `cp ~/.friday/db.sqlite` is replaced by `pg_dump friday > friday.dump.sql`. Documented in setup.md.
- **Multi-device convergence is correct by construction.** Unread badges, cursor positions, queued messages, optimistic state — all become synced state.
- **Dashboard-down-but-daemon-up:** existing live clients keep reading; new clients block on dashboard. Daemon-down-but-dashboard-up: writes succeed, side effects queue, full UX returns when daemon resumes.

### Open questions (deliberately not decided here)

- **Per-device read cursors vs. global read cursors.** Should "mark read" be device-specific (each surface tracks its own read state) or globally shared (read on phone = read on laptop)? Defaulting to **device-specific** for v1 (read state is part of where-you-are, not what-you-know); revisit if behavior is awkward.
- **Mutator-side validation rigor.** The Zero mutator framework supports schema validation; Friday will use zod schemas alongside Drizzle schemas. Catalog of schemas TBD during implementation.
- **Telemetry retention.** `client_devices` rows for never-returning devices — auto-prune at 90d idle? Leaving as user-driven (`Forget this device`) for v1.

## ADR-024 — SSE narrowed to live-turn delta side-channel; settled events flow via Zero

**Status:** proposed (2026-05-18)

Supersedes the all-events-via-SSE portion of ADR-003. Refines ADR-004 (DB-write-before-SSE-emit narrows to in-memory-accumulator-before-SSE-emit). Pairs with ADR-023.

Under the new sync architecture, almost every event today carried on SSE becomes redundant with the reactive query layer: `block_complete`, `agent_lifecycle`, `agent_status`, `mail_delivered`, `schedule_fired`, `evolve_critical`, `system_banner`, and `turn_started` / `turn_done` envelope events all derive from row changes that Zero replicates natively. Carrying them on SSE _and_ sync would create the two-notification-paths anti-pattern; the client would have to dedupe and order them, and would have a stale-channel problem if the two sources disagreed.

But **live token streaming is genuinely the firehose problem sync engines don't want to be.** Postgres logical replication with 5–50 Hz row updates per active block is outside Zero's designed envelope, and per-row replication-lag at that frequency would degrade perceived live-typing fidelity. Token streaming wants a separate transport.

### Decision

**SSE survives only for live-turn deltas.** Its scope narrows to a small, well-defined set of frames:

- `connection_established` — first frame on every (re)connect. Carries the daemon's `boot_id`. (Retained from ADR-003.)
- `turn_started` — `{turn_id, agent, ts}` — informs clients to start a per-block in-memory accumulator. Survives because the live in-memory state machine must know when to begin.
- `block_start` — `{block_id, turn_id, agent, kind, ts}` — open an in-memory accumulator for this block.
- `block_delta` — `{block_id, delta}` — incremental bytes / partial-JSON for tool-use input.
- `block_complete` — `{block_id, status?}` — signal to client that the in-memory accumulator can be discarded; the canonical row will arrive via Zero shortly (and may already have).
- `turn_done` — `{turn_id, status}` — informs clients the turn envelope is closed; clients drop any leftover live state for this turn.
- `error` — `{turn_id?, code, message, recoverable}` — narrow to live-turn errors.
- `:keepalive` — every 20s, unchanged.

**All other event types move to Zero:** `agent_lifecycle`, `agent_status`, `mail_delivered`, `schedule_fired`, `evolve_critical`, `system_banner`, `compaction_start` / `compaction_end`, `block_reload`, `block_meta_update`. These are derived from row inserts/updates/deletes that Zero replicates.

### In-memory accumulator (replaces the partial-bytes-in-DB story)

Today, the daemon writes partial bytes to `blocks` row columns continuously during streaming, so refresh-mid-stream returns the same bytes (ADR-016). Under the new model:

- **Daemon holds partial bytes in memory only.** The `liveTurns` in-memory registry (ADR-016) is the only place mid-stream bytes live on the server.
- **The block row is written to Postgres only on `block_complete`** with `streaming=0`.
- **Zero filters streaming rows from sync.** Clients' reactive queries on `blocks` are scoped to `WHERE streaming = 0` (today's table will gain a `streaming` boolean column for this purpose — already implicit in the model per ADR-016). Streaming rows don't exist in Postgres at all; the filter is structural, not a permission.
- **Refresh-mid-stream:** the client (originating or non-originating) loads closed blocks via Zero, then opens SSE; the daemon's per-turn SSE replay buffer (now small, since it only buffers ~1 turn worth of events at a time) replays from `turn_started` forward; the client rebuilds the in-memory accumulator and joins the live stream. This is the per-turn replay invariant Seth flagged as load-bearing — preserved.
- **Crash recovery:** if the daemon crashes mid-stream, JSONL boot recovery (ADR-012) walks the session's JSONL and writes the canonical closed-block row. The in-memory bytes are gone; the canonical bytes survive on disk. Clients reload via Zero on reconnect.

### Per-agent SSE scope

Today SSE is a single global channel; clients filter events by `agent` field. Under the new model, with sync handling all cross-agent state changes, the SSE channel can be **scoped per-agent**: clients open `GET /api/events?agent=<name>` when focusing an agent's chat, close it on focus switch. The replay buffer per channel is naturally small (~1 turn ≈ tens to hundreds of frames; not the 5000-event ring of today).

Focus switch flow:

1. Click sidebar entry for agent B.
2. Close SSE to agent A (if open).
3. Zero already has agent B's settled blocks (Phase 2 bootstrap or reactive subscription).
4. Open SSE `?agent=B` — daemon replays the current in-flight turn (if any) from `turn_started`.
5. Live stream resumes.

The boot_id cursor pattern from ADR-004 retires: per-turn replay buffer is bounded enough that "always replay the current turn" is the correct default. No cross-restart cursor logic.

### Connectivity widget

ADR-018's three-stage widget becomes:

1. **Internet** — `navigator.onLine` + lightweight ping (unchanged).
2. **Sync** — Zero's connection state (replaces SSE-only). Reports both sync (Zero WS) and live-stream (SSE) health, with a tooltip breakdown.
3. **Daemon** — `/api/health` poll (unchanged).

Grey-cascade rule retained: if Internet is down, Sync and Daemon render grey, not red.

If the live SSE is dropped but Zero is healthy, the Sync indicator stays green (settled state continues to flow); the chat header shows a small inline "live stream reconnecting" affordance during the brief gap. This is the right separation of concerns — sync health is the dominant signal; live-stream health is a per-feature affordance.

### Read-cursor / unread badges

Unread badges move to synced state. A `read_cursors` table (`agent_id, device_id, last_seen_block_id, ts`) is written by the `markRead` mutator. Per-device by default (each surface tracks its own read state); reactive query joins this against `blocks` to produce per-agent unread counts.

The today's per-device localStorage-only badge state is retired; cross-device badge agreement is now correct by construction.

### Consequences

- **SSE wire schema** in `packages/shared/src/wire/events.ts` shrinks to the live-turn subset above.
- **The `lastSeqByAgent` cursor — amended by FRI-125 (2026-05-28).** The original bullet read "the `lastSeqByAgent` cursor … retires; per-turn replay is the default." That was over-broad. The cursor is **RETAINED** in `services/dashboard/src/lib/stores/chat.svelte.ts` and its `acceptEvent` check is load-bearing for the transient-reconnect-on-same-focused-agent dedup case: on SSE reconnect the daemon's `replayForAgent` dumps the full in-flight turn buffer, the `streaming` overlay isn't cleared on transient reconnect (only on terminal events), and `handleBlockDelta` unconditionally appends. Without `acceptEvent` dropping `seq <= cur`, every replayed delta re-appends → user-visible doubled text. What actually retires is the **REST/Zero seeding** of the cursor (the row's `last_event_seq` column + the REST payload's `lastEventSeq` field + the Zero-row max aggregator), now folded into FRI-125. The cursor itself seeds exclusively from SSE event seqs at apply time + the `localStorage` rehydrate on focus switch.
- **`block_reload`, `block_meta_update`, `agent_status`, `agent_lifecycle`, `mail_delivered`** SSE event handlers are removed from the client; their effects are observed via Zero reactive query updates instead.
- **Boot_id cursor invalidation** retires from the SSE layer; Zero handles cross-restart correctness.
- **The ring buffer's 5000-event size** (ADR-003) shrinks to a per-turn buffer (bounded by max turn length; expect ~100–500 frames typical, <2000 worst-case).
- **Dashboard's `/api/events` proxy** narrows; per-agent `?agent=<name>` query parameter is added.

### Open questions

- **Should the in-memory accumulator survive a daemon refork?** Today the worker fork can be relaunched; the parent's `blockStream` accumulator holds enough state to resume. With per-turn SSE replay, the answer might be "no — let the JSONL recovery + Zero sync do the rebuild." Leaving as an implementation discovery.
- **Per-device vs. global read cursors.** Mirrored from ADR-023's open question. Same default (per-device for v1).

### Consequences (FRI-123, 2026-05-28)

The four "Legacy REST" routes enumerated for retirement under this ADR are now all deleted:

- `POST /api/chat/turn` — replaced by the `sendUserMessage` mutator + the daemon's `dispatch-listener`.
- `POST /api/chat/turn/<id>/abort` — replaced by the `abortTurn` mutator + the daemon's `abort-listener` (plus the localhost `/api/internal/abort-turn` fast-path for synchronous worker-side cancel).
- `DELETE /api/chat/turn/<id>/queued` — replaced by the `cancelQueued` mutator + the daemon's `cancel-listener` (plus the localhost `/api/internal/cancel-queued` fast-path for synchronous `nextPrompts` splice).
- `POST /api/chat/turn/<id>/resume` — replaced by the `resumeTurn` mutator + the new daemon `resume-listener` (FRI-123). Mirrors the `abortTurn` row-as-intent pattern: the mutator UPDATEs the user block to `status='resume_requested'`, a Postgres trigger (`0023_block_resume_notify_trigger.sql`) fires `NOTIFY friday_resume_requested`, and the listener rebuilds the dispatch prompt via `buildDispatchPrompt(kind:'user_chat')` and re-dispatches under the same turnId (FRI-12 visual-grouping contract).

After this change there are five LISTEN-handler files (`dispatch-`, `abort-`, `cancel-`, `archive-`, `resume-listener.ts`) sharing near-identical reconnect-loop + boot-scan boilerplate. Candidate 01 of the `/improve-codebase-architecture` review tracks consolidation as a follow-up; explicitly out of scope for FRI-123. The dashboard's `services/dashboard/src/routes/api/chat/turn/` proxy tree is gone entirely.

### Consequences (FRI-125, 2026-05-28)

The `blocks.last_event_seq` column retires via Drizzle migration `0025_drop_blocks_last_event_seq.sql`. The seq-stamping fragility this ADR's Phase 5 amendment narrowed (peek `eventBus.currentSeq()+1` → stamp into the in-memory accumulator → `writeAndPublish` re-captures → emit `block.seq-skew` warning on mismatch) is gone. The narrowed live-turn-delta invariant — "in-memory accumulator updated before SSE emit" — is now enforced at one seam by `services/daemon/src/agent/block-stream.ts`, which absorbed `live-turns.ts`, `writeAndPublish`, `insertErrorBlock`, `finalizeStreamingBlocks`, and `recordUserBlock`. The seven exported write paths (`open` / `append` / `close` / `cancel` / `recordError` / `finalize` / `recordUserBlock`) plus `endTurn` cover every block-row-write path.

The dashboard cursor amendment above is the load-bearing carve-out: a previous reading of this ADR's "lastSeqByAgent cursor retires" bullet concluded the cursor was dead code, but a falsification proof during the FRI-125 paired review showed the transient-reconnect dedup case still depends on it. The cursor stays; only its REST/Zero seeding retires. Any future review must not re-attempt the deletion without first walking the reconnect-while-streaming flow against `handleBlockDelta` at HEAD.

## ADR-025 — Memory full-text search stays REST while Zero lacks generated-column replication

**Status:** Accepted, 2026-05-20.
**Driver:** Item #53/#55 audit of the Postgres + Zero sync layer.

### Context

After ADR-023 / ADR-024 the dashboard's `/memory` list reads come from the Zero replica reactively — open the page, see entries land in real time as the daemon `memory_save` mutator + LISTEN handler write them. The list-and-detail surface is fully local-first.

**Full-text search is not.** The Postgres `memory_entries` table carries a generated `tsvector` column (`content_tsv`) populated from `title + content + tags_json`, with a GIN index. The `/api/memory/search` endpoint executes `content_tsv @@ plainto_tsquery(q)` with `ts_rank` ordering. The dashboard's search box hits this endpoint.

Zero 1.5 does not replicate generated/functional columns. The local replica has the title/content/tags rows but not `content_tsv`, and ZQL has no `@@` operator. We considered three alternatives during the Phase 3.3 design:

1. **Replicate the tsvector**. Would require teaching Zero to materialize the generated column on the client. Not a small feature; not on the Zero roadmap as of 1.5.
2. **Pure-JS substring search over the local snapshot**. Works for trivial corpus sizes but loses Postgres FTS's tokenizer, stemming, and rank ordering. The memory corpus is small now (single-digit hundreds of entries) so JS would be fast — but degrades silently as the corpus grows past a few thousand entries.
3. **Pre-materialize a rank column per query**. Infeasible for arbitrary user queries.

### Decision

Keep the hybrid contract:

- **List + detail reads**: Zero reactive query (status, recency, tags, content). Already shipped.
- **Search (`?q=…`)**: dashboard's `/memory` page calls the existing `/api/memory/search` REST endpoint. The result is a ranked array of `id`s; the dashboard renders by overlaying those ids against the local Zero snapshot so the rendered cards still get reactive updates if a search-result entry is edited from another device.

The user-perceptible difference: search hits pay one network round-trip (~50–150ms on the live deploy); browsing and editing don't.

**Amendment (FRI-24, 2026-06-17): the hybrid contract now also covers vector recall.** `memory_entries` gains an `embedding vector(384)` column (pgvector; all-MiniLM-L6-v2). Like `content_tsv`, that column is **server-side-only — NOT replicated to Zero** (Zero replicates the title/content/tags rows, not the generated FTS column and not the embedding). Vector similarity (`embedding <=> $query::vector`) runs inside `searchMemories` on the daemon, alongside the existing FTS query, behind the **same** `/api/memory/search` REST endpoint. So vector recall inherits this ADR's REST hop and introduces **no new network boundary**: the dashboard search path is unchanged, and the daemon's own recall path (which already runs in-process) just gains a second ranking signal. If the embedding runtime/model is unavailable or a vector query errors, recall **fails open to FTS-only** (see the implementation note in the consequences below).

**The pgvector extension is created via an admin connection, NOT inside a migration.** `CREATE EXTENSION vector` requires SUPERUSER (pgvector 0.8.2 is not a trusted extension), and daemon boot runs migrations as the non-superuser `friday` role — so the extension can't live in migration `0036` (which carries only the drizzle-kit-generated `ADD COLUMN embedding vector(384)`). Provisioning calls `ensureVectorExtension()` over an admin connection (the OS-user Homebrew-Postgres superuser) before migrations run. The extension is a hard schema dependency: `ensureVectorExtension()` throws if it can't be created (fail-loud), in contrast to the embedding runtime, which fails open.

### Revisit trigger

Bring this ADR back to the table if any of these fire:

- Zero ships generated-column replication (would let us drop the REST endpoint entirely).
- The memory corpus crosses ~5000 entries AND search latency tail (`p95(/api/memory/search)`) exceeds 500ms — at which point the JS-on-local fallback becomes attractive vs. the network cost.
- A future "search across all Friday data" surface (memory + tickets + chat history) ships, in which case the answer probably involves an external search index rather than Postgres FTS regardless.

### Consequences

- The /memory page has two distinct data paths (Zero for list, REST for search). The dashboard treats them as orthogonal: search results don't update the Zero snapshot's order, and Zero updates don't re-trigger the active search query.
- No code change from the **original** ADR. Existing implementation is correct; this entry documents _why_ the hybrid lives and _when_ we'd change it, so future architectural audits don't keep re-discovering the gap as a TODO.
- **FRI-24 consequence:** vector recall is purely additive within the existing REST hop — no new endpoint, no new replicated column, no new network boundary. The embedding runtime is **onnxruntime-web (WASM)** — its `.wasm` files ship inside `node_modules` in the release tarball, so there is **no per-platform native binary to fetch** and it runs cross-platform (Intel x64 and Apple Silicon alike). onnxruntime-node ships no macOS x64 binary at ≥1.20 and prod is an Intel x64 box, which is why the runtime is WASM, not native; a pnpm patch lets onnxruntime-node import gracefully when its native `bin/` is absent (it's stripped/unused), so transformers' tokenizer still imports cross-platform. The **only** assets fetched during `friday update`/setup are the quantized ONNX model + tokenizer (~30MB, under `<FRIDAY_DATA_DIR>/models/`); when they're missing, `embedText` returns `null` and `searchMemories` degrades to FTS-only, so the daemon still boots and recall still works (just without the semantic signal). The pgvector extension is the one part that must succeed (`ensureVectorExtension()` fails loud) because the `embedding` column's type depends on it.

## ADR-027 — Path to production: prod-mode-by-default, dev as pnpm wrappers, port surgery

**Status:** accepted (FRI-83, 2026-05-20)

Friday's CLI used to launch dev mode on demand (`friday start --dev`) and prod mode separately, with both pointing at the same `~/.friday/` and the same default ports (daemon 7444, dashboard 5173). The Cloudflare Tunnel terminated wherever adapter-node happened to land (port 3000 in practice, since `cfg.dashboardPort` was dead-weight for prod). This conflated three distinct concerns — supervising the running deployment, hot-reloading developer source, and exposing a stable public surface — into one flag that toggled both at once.

### Decision

1. **`friday start` always launches prod.** The `--dev` flag is gone (breaking change accepted). `friday restart`, `friday stop`, `friday status`, `friday logs` act on the prod install only.
2. **Dev runs via `pnpm dev:daemon` / `pnpm dev:dashboard`** wrappers at the repo root. They set `FRIDAY_DAEMON_PORT=7444` inline so the dev dashboard's SvelteKit server-side fetches reach the dev daemon, not the prod daemon on 7610.
3. **Prod ports are pinned to disjoint values from dev.** Daemon **7610**, dashboard **7615** ("TGIF"). Dev keeps its existing 7444 / 5173. Zero-cache stays at 4848 (Zero's convention; shared between prod and dev by default — full isolation needs a parallel zero-cache on a different `ZERO_PORT` + a separate Postgres database).
4. **`FridayConfig.daemonPort` / `dashboardPort` become optional override fields.** Resolution is `resolveDaemonPort(cfg)` = `process.env.FRIDAY_DAEMON_PORT ?? cfg.daemonPort ?? PROD_DAEMON_PORT` and `resolveDashboardPort(cfg)` = `cfg.dashboardPort ?? PROD_DASHBOARD_PORT`. The daemon helper is symmetric — both the daemon's own bind and the dashboard's daemon-fetch URL read the same chain — so dev wrappers can redirect both sides with one env var.
5. **Adapter-node's `PORT` env is an implementation detail, not a user surface.** `start.ts` resolves the dashboard port from the chain above and passes `PORT=<resolved>` to the dashboard spawn. The user's config field is what they edit; the env var is downstream.
6. **`friday status` displays probed ports, not config-derived ones.** The daemon writes its bound port into `health.json`'s new `port` field on every heartbeat (mtime-based staleness check falls back to config with a "(config — not heartbeating)" indicator). The dashboard is validated by a 1s-timeout `fetch http://localhost:<resolved>/`.
7. **BetterAuth `trustedOrigins` is a static list with both localhost ports.** `http://localhost:7615` and `http://localhost:5173` are always present (plus `cfg.publicUrl` and any `BETTER_AUTH_URL` env). Dev sign-ins (origin `:5173`) and prod sign-ins (origin `:7615` or the tunnel URL) both pass CSRF with no per-environment branching.
8. **The Cloudflare Tunnel terminates at `:7615`.** Repoint is a one-time Cloudflare Zero Trust UI edit by the operator — not a Friday-side code change.

### Why these specific shapes

- **Why optional config fields, not deleted ones.** `~/.friday/config.json` is the user's override surface; deleting the fields would force every operator who'd customized them to discover the new shared constants and edit different code. Optional + `DEFAULT_CONFIG = PROD_*` means a fresh install gets prod defaults and an existing install with a custom port keeps it.
- **Why an env var (`FRIDAY_DAEMON_PORT`) for dev when prod has none.** Prod reads only config and constants. Dev needs to redirect the daemon-fetch URL on a process-by-process basis (the prod dashboard reads the prod config; the dev dashboard reads the same prod config but needs to talk to a different daemon). An env var is the cheapest mechanism that doesn't require dev to carry its own config file.
- **Why prod can't avoid `PORT` env.** `@sveltejs/adapter-node` always reads `process.env.PORT` and has no other knob. The custom `server-entry.mjs` consumes it too. We accept the asymmetry: daemon resolves its port from the chain directly; dashboard's chain is computed in `start.ts` and propagated via `PORT`.
- **Why probing instead of trusting config.** The daemon's IPC consumers (workers, scheduler, mail-bridge) get the port from `workerOpts.daemonPort` already; surfacing the _actually-bound_ port in `friday status` is a hedge against config drift between `cfg.daemonPort` and the running process. Probe-validated dashboard is the same idea — config says one thing, the live process is asked.
- **Why retain breaking `--dev` removal.** A deprecation rejection-shim is ~5 lines of code that exists forever. Citty's unknown-flag error is the user-facing message; muscle-memory recovery happens once, then never again.

### Cross-references

- **Supersedes:** none — Friday's prior mode story was not ADR-codified.
- **Coexists with:** ADR-023 (Postgres canonical store), ADR-024 (Zero sync, narrow SSE). Port surgery is orthogonal to the data layer; zero-cache's WS port (4848) is unaffected.
- **Cross-reference:** ADR-009 (tmux-backed daemon supervision) still stands pending FRI-88 (Friday brew packaging + launchd supervision), which will supersede ADR-009 and make `friday start/stop/restart` thin aliases over `brew services`.
- **Out of scope:** brew packaging + launchd supervision (FRI-88); full dev/prod isolation with a parallel Postgres database + parallel zero-cache (follow-up); a `friday update` combined pull/install/build/restart helper.

### Consequences

- Operators run on `:7610` / `:7615` after a one-time Cloudflare Zero Trust UI repoint. `friday backup` + `friday restore` cover the rollback path; the runbook is in FRI-83.
- Dev contributors invoke `pnpm dev:daemon` / `pnpm dev:dashboard` from the repo root — two terminals, not one CLI command. Prod and dev can co-run without TCP collisions; the residual gotcha is the shared Postgres + zero-cache (document the `FRIDAY_DATA_DIR=~/.friday-dev` + parallel-zero-cache path for contributors who need true isolation).
- The 9 daemon-side `cfg.daemonPort` reads (workers, scheduler, mail-bridge, dispatch listener, watchdog, api/server x4, recovery functions) all funnel through `resolveDaemonPort(cfg)` and the dashboard's daemon-fetch URL reads the same chain — there is one canonical port-resolution path now.

### Post-mortem (2026-05-20 operator flip)

Three issues surfaced during Seth's first prod flip onto `:7610` / `:7615`. All trace to the same shape of bug — port info baked into persisted runtime state files that the FRI-83 audit didn't include. Captured here so the FRI-88 brew packaging work doesn't re-encounter them and so future port migrations have a checklist.

1. **`~/.friday/config.json` carrying stale `daemonPort: 7444` / `dashboardPort: 5173`.** Pre-flip these values matched DEFAULT*CONFIG; post-flip they overrode the new prod constants because the resolution chain is `cfg.<x>Port ?? PROD*<X>\_PORT` and explicit-config-set wins. Fix during flip: removed the four stale fields (`daemonPort`, `dashboardPort`, plus two leftover `\*BaseUrl`fields no longer referenced anywhere in the codebase) from`config.json`. The settings-sync listener doesn't write port fields, so the state stays clean.

2. **`~/.friday/.env` carrying stale `ZERO_MUTATE_URL=http://localhost:5173/api/mutators`.** Zero's push URL is read from env at zero-cache startup; the value was written once at `friday setup` and never updated when ports moved. Fix landed in code (see #3 below); during flip I patched `.env` directly to unblock prod.

3. **Two missed audit-list sites for `cfg.daemonPort`:** `services/dashboard/src/routes/api/events/+server.ts:26` (the SSE proxy — the cause of "Fetch API cannot load /api/events" in Safari) and `packages/cli/src/lib/api.ts:16` (DaemonClient fallback). The original FRI-83 audit pattern looked at `services/dashboard/src/lib/server/` but missed `routes/`. Both migrated to `resolveDaemonPort(cfg)`.

**Resolution decisions:**

- **`ZERO_MUTATE_URL` is now exported by `start.ts`'s zero-cache spawn** from `resolveDashboardPort(cfg)`, after the `.env` source. The dynamic value wins over any stale persisted value; future port changes take effect on the next `friday start zero-cache` with no operator action. `ZERO_MUTATE_URL` was removed from `~/.friday/.env` after the flip — having it static was misleading once the spawn-time override landed.
- **`~/.friday/.env` and `~/.friday/config.json` are not part of the source audit anymore — they're runtime state that should never carry derivable values.** The brew-packaging work (FRI-88) should remove `daemonPort` / `dashboardPort` from the templates `friday setup` writes (they're already optional in the type), and consider not writing `ZERO_MUTATE_URL` at all (let the spawn-time export be the only source).
- **`friday doctor` could grow a "stale runtime-state" check** that warns when `config.json` carries `daemonPort` / `dashboardPort` that match neither the prod constants nor a documented dev value, and when `.env` carries `ZERO_MUTATE_URL` (which is now spawn-time-only). Flagged for FRI-88's doctor surface.
- **Process-supervision gap surfaced during the flip:** `friday stop` doesn't always propagate kill signals to zero-cache's grandchild workers (replicator/syncer). Multiple zombie workers held replica.db locks and ports 4848/4849 across restart cycles, causing `EADDRINUSE` and `SQLITE_BUSY` crash loops. Manual `kill -9` cleared each. This is a known cost of tmux supervision and is owned by FRI-88's launchd plist (process-group semantics handle this correctly).

## ADR-028 — Brew packaging + launchd supervision; tmux retired from prod

**Status:** accepted (FRI-88, 2026-05-20)

**Supersedes ADR-009** (tmux-backed daemon supervision).

Friday's production stack moves from `tmux new-session -d` to a Homebrew formula + launchd plist. The catalyst was the FRI-83 operator flip, which surfaced a concrete failure mode of tmux supervision: `tmux kill-session` signals only the pane shell, not the process group of its descendants. zero-cache's worker pool (`@rocicorp/zero/out/zero-cache/src/server/replicator.js` and `syncer.js`) routinely survived `friday stop`, holding `~/.friday/zero/replica.db` SQLite locks and TCP ports 4848/4849. Each restart cycle required manual `kill -9 <zombie-pid>`. **Zombies are unacceptable in a prod world.** ADR-028 closes that gap.

### Decision

1. **One Homebrew tap, one formula.** Tap: `sethvoltz/homebrew-friday`. Formula: `Friday < Formula`. `brew install sethvoltz/friday/friday` auto-taps, installs `postgresql@18` + `cloudflared` + Node + pnpm if missing, clones the source repo into `libexec`, runs `pnpm install --prod && pnpm -r build`, and registers a launchd plist via brew's `service do` DSL. Source install (not binary tarball) for v1 — binary install is a follow-up that needs a release pipeline.

2. **One launchd plist, one supervisor binary.** The plist target is `bin/friday-supervisor` (a tiny shell wrapper that `exec node` invokes `packages/cli/dist/bin/supervisor.js`). The supervisor forks daemon + dashboard + zero-cache as children with `detached: true` — each becomes its own process-group leader (pid == pgid). Boots in order (daemon → zero-cache → dashboard). KeepAlive on per-child crash with exponential backoff (1s → 8s cap); zero-cache exit code 14 (`AutoResetSignal`) is fast-restart. Crash-loop guard: 5 failures inside 60s causes the supervisor to exit non-zero so launchd surfaces it.

3. **Process-group cascade-stop is the load-bearing semantics.** SIGTERM (or SIGINT) to the supervisor triggers `process.kill(-child.pid, "SIGTERM")` for each child — signaling the child AND every descendant in its tree (the worker pool, the daemon's worker forks, anything grandchildren spawn). 10s deadline, then escalate stragglers to `SIGKILL`. launchd's own job-level process-group cleanup is the safety net under any supervisor failure. The `pgrep -f "rocicorp.+zero"` check returns empty within 5 seconds of `brew services stop friday` — pinned by `supervisor.test.ts`.

4. **No bash respawn wrappers.** The pre-FRI-88 zero-cache `prodCmd` wrapped `pnpm exec zero-cache` in `while true; do …; sleep 1; done` because tmux on its own doesn't respawn. That loop was the zombie nursery — it happily spawned a new instance before the previous one had released its ports / SQLite locks. The supervisor's KeepAlive logic with backoff and a per-child shutdown gate replaces it.

5. **`friday start/stop/restart` are thin aliases over `brew services`.** The CLI surface stays for operator muscle memory and gives a portability seam: when Linux/systemd support lands (out of scope for v1, designed-for), the alias dispatches to `systemctl --user` instead of `brew services` without changing the user-facing command. Single-service operations (`friday restart daemon`) error out — the supervisor owns the whole stack atomically. Per-service IPC via supervisor socket is a v2 follow-up.

6. **`friday attach` tails launchd logs, not tmux panes.** The supervisor pipes each child's stdout + stderr to `~/.friday/logs/<service>.jsonl`. `friday attach <service>` becomes interactive `tail -n 50 -F <log>`. Same operator ergonomic, durable across supervisor restarts, no pane state to recover.

7. **cloudflared runs as its own user launch agent, installed via `cloudflared service install`.** Cloudflared is declared as a `depends_on` of the friday brew formula so the binary is on PATH, but Friday's tunnel does not use brew's auto-generated `homebrew.mxcl.cloudflared.plist`. That plist runs `cloudflared` with no arguments, which only supports config-file-based named tunnels — connector tokens (the shape `friday setup --cloudflare` collects) have no `~/.cloudflared/config.yml` equivalent, so the brew job spins on "permission denied" and exits 1.

   **Correction landed 2026-05-21:** the original §7 text claimed `friday start` kicked off `brew services start cloudflared`; that path was wrong-shape from day one because brew's plist could never see the token. The canonical token-tunnel path is `cloudflared service install <TOKEN>`, which writes its own user launch agent at `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` (label `com.cloudflare.cloudflared`) with the token embedded in ProgramArguments and `RunAtLoad: true` + `KeepAlive`. `friday setup --cloudflare` now invokes it: stops the broken brew job if loaded, runs `cloudflared service uninstall` (idempotent), then `cloudflared service install <TOKEN>`. Token rotation is the same flow — re-run setup. `friday start` no longer touches cloudflared; the launchd job manages itself. `friday status` checks the `com.cloudflare.cloudflared` label. _(Superseded by ADR-042, 2026-06-11: `friday start` now **reconciles** the cloudflared agent against `tunnel.serve` + token presence — it is no longer fire-and-forget.)_

8. **Postgres is host-managed.** Same as today — `brew services start postgresql@18`. Friday's supervisor doesn't supervise Postgres; it depends on it being up (caught by `friday doctor`'s `pg_isready` check).

### Design constraints (non-negotiable; enforced by AC#5 / AC#8)

- **No tmux in prod.** tmux was a dev convenience that ADR-009 promoted to a supervision mechanism. Post-ADR-028, tmux is **not** part of the production supervision tree. Contributors who want it for the dev workflow install it independently.
- **Proper parent → child PID hierarchy with cascade stop.** When the supervised parent dies — for any reason — every descendant dies with it. Verified by `supervisor.test.ts` (3 grandchildren forked from a fixture; killChildGroup sends SIGTERM to the group; all PIDs are dead within 5s).
- **`friday stop` leaves zero descendants alive.** `pgrep -f "rocicorp.+zero"` empty within 5 seconds. Same for daemon and dashboard subtrees.
- **No bash-while-loop respawn wrappers.** The supervisor's KeepAlive policy is the only restart mechanism.

### Alternatives considered

- **Three launchd plists, one per service.** Brew's idiomatic shape, but cross-service ordering (daemon → zero-cache → dashboard) requires plist tricks (`KeepAlive: { OtherJobEnabled: ... }`) that don't compose cleanly. A custom supervisor owning the ordering is simpler. Rejected.
- **Don't write a supervisor — let launchd KeepAlive each process directly.** Doesn't handle zero-cache's `AutoResetSignal` (exit code 14) as a fast-restart case; doesn't handle cross-service ordering; doesn't get us a single log channel for cascade-stop events. Rejected.
- **Keep tmux for prod and use `kill -9 -- -PID` on supervisor stop.** Doesn't compose with `brew services` lifecycle, doesn't handle Mac reboot (no `RunAtLoad`), still has the zombie window between `kill-session` and `kill -9`. Rejected.
- **Use the existing `tmux` toolchain with `systemd-cgls`-style cgroup tracking via macOS's launchd anyway.** Mixes two supervision layers; the zombie failure mode still exists in the tmux layer. Rejected.

### Consequences

- **Code deleted:** `packages/cli/src/lib/tmux.ts` and `packages/cli/src/lib/state.ts` (entire files); the `tmuxSpecs` / `startTmuxService` / `startTunnel` / `buildPackagesOrAbort` / `buildDashboardOrAbort` / `tunnelBlocker` / `cloudflaredOnPath` / `findRepoRoot` helpers in `start.ts`; the per-service tmux-kill loop and legacy-session cleanup in `stop.ts`; `detectMode` and the spawn-into-self gymnastics in `restart.ts`. Net deletion across the FRI-88 work is ~700 LOC.
- **Code added:** `packages/cli/src/bin/supervisor.ts` (~270 LOC), `packages/cli/src/bin/supervisor.test.ts` (~210 LOC, 6 tests).
- **Brewfile loses `tmux`** as a required dep; the README and setup.md both note it's now optional for the dev workflow.
- **`friday status` reshapes** to show one `supervisor` row (launchd job) instead of three per-service tmux rows. The probed per-service ports (FRI-83 helpers) carry forward unchanged.
- **`friday doctor` gains** a `friday-supervisor (launchd: homebrew.mxcl.friday)` check, replacing the obsolete `tmux installed` check. Plus three new stale-runtime-state warnings (FRI-88 Q11): `ZERO_MUTATE_URL` in `.env`, `daemonPort`/`dashboardPort` in `config.json`, orphaned `replica.db-wal` from an unclean previous shutdown.
- **Operator flip is one-shot** per FRI-88 §5 runbook: `friday stop` (old tmux) → `brew install sethvoltz/friday/friday` → `brew services start friday` → smoke-test the cascade-stop assertion. After that, prod survives reboots automatically.
- **Per-service IPC** (`friday restart zero-cache`) is explicitly deferred. The whole-stack restart is the v1 contract.

### Bring this ADR back to the table if any of these fire

- The cascade-stop assertion regresses (zombies survive `brew services stop friday`). That's a hard failure of §0; investigate before shipping any further FRI-88-style change.
- The single-service ops gap becomes operationally painful — the supervisor IPC follow-up is the answer, not abandoning launchd supervision.
- Cross-platform support (Linux/systemd) demands a different supervisor model. The CLI alias layer abstracts the supervision backend; the supervisor binary itself may stay the same (Node + child_process portable) or get replaced with a systemd-native equivalent. ADR-028 doesn't pin one over the other for Linux.

## ADR-029 — Per-agent home dirs, pinned-memory prompt injection, zero-block wedge detector

**Status:** accepted (2026-05-21)

### Context

The orchestrator + non-builder agents ran with the daemon's `process.cwd()`. The Claude SDK keys session transcripts by `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, so a change in daemon launch directory makes every prior `agents.session_id` unreachable to the SDK's resume path. This bit production on 2026-05-20 when ADR-027 / FRI-83's prod rollout moved the daemon from the dev tree to the Homebrew install (`/Users/seth/Development/Seth/Friday/agent-friday/services/daemon` → `/opt/homebrew/Cellar/friday/0.0.1/libexec/services/daemon`). Friday's `mainLoop` looped against an empty SDK response ~290 times in 13 minutes; mail stayed pending; none of the existing runtime guards caught it.

### Decision

1. **Per-agent home dirs.** `workingDirectoryFor(a)` returns `~/.friday/agents/<a.name>/` for any non-builder, non-app-installed agent. Builders keep their git-worktree cwd; app-installed agents keep `~/.friday/apps/<appId>/`. New constant `AGENTS_DIR` from `@friday/shared`; created at boot by `ensureDirs()`.

### 2. Pinned-memory injection in the prompt stack

**Correction landed 2026-05-21 (FRI-101):** the original §2 text proposed a `seedRepoPins()` boot helper, a `friday memory pin-repo` CLI, and a `fridayRepoPath` config field as part of the architecture. All three were deleted as wrong-shape. The actual mechanism is simpler than the original §2 described:

- `listPinnedForAgent(agentName, tag = "pinned")` returns memory entries owned by `agentName` (filter on `created_by`), tagged with `tag` (jsonb `?` operator), `status='ready'`. Ordered by id for byte-stable prompt assembly.
- `composeSystemPrompt(stack, identity?, pinnedFacts?)` accepts an optional `pinnedFacts` string and renders it as a `# Pinned facts` section between Identity and `agents/<type>.md`.
- The daemon's `buildSystemPrompt(agentRow)` (FRI-123, in `services/daemon/src/prompts/`) queries `listPinnedForAgent` internally and renders the section. It is the single chokepoint — `composeSystemPrompt` is no longer called directly from daemon code; it is reached only via `buildSystemPrompt` / `buildDispatchPrompt`.

That's the entire mechanism. No daemon-side seeder per fact-type, no CLI subcommand per fact-type, no config field per fact-type. The agent-friday repo path is a memory owned by `friday` with tag `pinned` (and a secondary `repo` tag for human filtering). Any other always-inject fact uses the same shape — a builder's target-repo URL, a Linear team UUID, a kitchen-app manifest pointer — all are memories tagged `pinned`, owned by the relevant agent.

Builders that need _contextual_ (FTS-recalled) repo awareness use the same memory store, just without the `pinned` tag — auto-recall (`packages/memory/src/auto-recall.ts`) surfaces them when the user message tokens match. Same store. Same query. Same code path.

Architectural rule (checkable in review): any code touching `buildSystemPrompt`, `composeSystemPrompt`, `listPinnedForAgent`, or memory writes that's specific to a single fact-type is a violation.

3. **State-migrations table.** New `_friday_state_migrations` table (`id TEXT PK`, `applied_at TIMESTAMPTZ`, `meta_json JSONB`) tracks imperative one-shot data/filesystem migrations, distinct from Drizzle's schema migrations. Runner uses a Postgres advisory lock; first consumer `agent-cwd-pin-v1` renames SDK JSONLs (and their `<sessionId>/tool-results/` sidecar dirs) from old encoded-cwd locations to the new per-agent-home encoded locations, EXDEV-falling-back to copy + unlink. Boot order: Drizzle migrations → state migrations → everything else. Versioned re-runs ship a new id (`*-v2`).

4. **Zero-block wedge detector.** `LiveWorker` gains `blocksThisTurn` (incremented in `handleBlockStart`, reset on `sendPrompt`/`turn-complete`/`error`) and `zeroBlockTurnStreak` (incremented when a `turn-complete` or `error` arrives with no observed blocks, reset otherwise). When the streak reaches `FRIDAY_WEDGE_THRESHOLD` (default 10), the daemon force-kills via `forceKillStuckWorker(w, { reason: "wedge" })`. Gated on `!w.abortRequested` so user-initiated stops don't trip the counter. Distinct from the heartbeat watchdog (the wedge passes — workers are chatty) and the turn-stall watchdog (the wedge passes — block-stops still fire in other turns, and the threshold is too lax for a tight loop).

### 5. CLI

`packages/cli` adds one subcommand: `friday migrate cwd --dry-run` — previews the JSONL moves the `agent-cwd-pin-v1` state migration will perform on next daemon boot. Applies stay daemon-boot-only so the advisory-locked runner is the single source of truth.

**Correction landed 2026-05-21 (FRI-101):** an earlier draft of §5 also documented `friday memory pin-repo <absolute-path>` as a bespoke CLI seeder for friday's repo memory. Removed as wrong-shape — repo memories (and every other always-inject fact) use the existing memory write paths: `memory_save` MCP from agents, `friday memory add` or the dashboard memory UI from humans, or `curl POST /api/memory` with the `x-friday-caller-name` header for one-shot programmatic seeding.

### Consequences

- **Prior `agents.session_id` rows survive a daemon-cwd change.** The first boot after upgrade runs the migration, renames JSONLs into the new layout, records the row, and never runs again. Subsequent daemon installs that change cwd are no-ops because the agent cwd is now stable in `~/.friday/agents/<name>/`.
- **`process.cwd()` becomes irrelevant to runtime correctness for non-builders.** Pre-existing builder default-repo fallbacks in `api/server.ts` and `scheduler/spawn.ts` still resolve to the daemon's source dir — that's a separate concern (the daemon source dir is a sub-dir of the agent-friday repo, not the repo root), tracked as a follow-up, not a regression introduced here.
- **Pinning is on par across repos.** Friday's repo memory uses the same tag/owner shape any other repo memory would. Down the road, a builder-spawn flow that clones `repo:foo` against a memory-pinned path uses the same primitive — exercises the cloning code path against friday itself.
- **Wedge detection now catches the SDK-can't-find-resume-target failure mode at ~20 seconds** (10 turns × ~2s/turn under the pathological cadence) instead of waiting for the 4-hour stale-turn ceiling. Healthy long-lived workers never hit the threshold because legitimate turns emit ≥1 block-start (even `mail_close`-only responses emit 2 blocks: `tool_use` + `tool_result`).

### Bring this ADR back to the table if

- The detector ever force-kills a worker that _was_ making real progress. Inspect the `worker.zero-block-turn` log streak in `daemon.jsonl` and decide whether the threshold should rise or the signal should refine to "fewer than N tokens emitted" rather than "zero blocks."
- The `~/.friday/agents/<name>/` dir collides with a workflow that wants to put real files there. Today the dir is intentionally empty; if friday or a helper starts writing artifacts into its own home, the implicit "empty home" contract becomes a doc'd contract.
- Cross-volume `~/.claude` setups become common. The EXDEV-fallback path is non-atomic on sidecar-dir moves; if anyone runs into a half-migrated state, a manifest-driven retry replaces the current "skip if dest exists" idempotency.

## ADR-030 — Stop propagates cooperatively; daemon writes are fire-and-forget on cancel

**Status:** accepted (2026-05-21)

### Context

FRI-66: when the user hits Stop, every layer between the dashboard and an in-flight Friday MCP handler needs a path to cancel. Pre-FRI-66 the only guaranteed termination of a destructive tool was the safety-net pgrp SIGTERM at the abort-deadline (originally 2s, now 500ms). FRI-78 wired the worker's `AbortController` into the SDK's `query()` options so the SDK can cancel its own CLI subprocess and built-in tools (Bash, WebFetch, Read/Edit/Write/Glob/Grep, Task subagents) cooperatively. FRI-95 added a T+0 `killPgrpDescendants` so destructive subprocesses die in milliseconds without waiting on the SDK.

That left one gap: Friday's in-process MCP servers (`friday-{mail,memory,tickets,agents,schedule,evolve,integrations,echo,apps}`) ran inside the worker, called the daemon over HTTP via `daemonFetch`, and ignored the `extra.signal` the MCP SDK threads into every tool handler. A long write — `linear_create_issue` issuing a network round-trip, `ticket_create` running a Postgres mutation through the daemon — blocked the worker on its response even after the user hit Stop. The worker only learned the consumer was gone when the safety-net fired and tore down the process.

### Decision

**Two-layer policy:** the worker stops _waiting_ on cancel; the daemon's authoritative write does not necessarily stop _executing_.

1. **Worker side: signal propagation is mandatory.** `daemonFetch` accepts `signal: AbortSignal` and forwards it to the underlying `fetch()`. Every Friday MCP tool handler accepts `(args, extra)` and threads `extra.signal` (extracted via the typed `signalFrom(extra)` helper in `services/daemon/src/mcp/http.ts`) into its `daemonFetch` call. On Stop, the worker's `AbortController` fires; the MCP SDK signals every in-flight handler; `fetch()` raises `AbortError`; the worker's catch arm flushes blocks with `status='aborted'` and emits `turn-complete` cleanly. Cooperative path target: 200ms from Stop click to `turn_done`. The 500ms force-kill deadline becomes the abnormal-case backstop, not the common path.

2. **Daemon side: no cancellation, no compensation.** The HTTP routes the worker hits are _not_ AbortSignal-aware. A write that's already crossed the worker → daemon boundary completes — including the round-trip to Linear, the Postgres `INSERT`, the mail-bus broadcast. The cancel only stops the worker from blocking on the response.
   - **Idempotent reads** (`mail_inbox`, `memory_search`, `memory_get`, `ticket_list`, `ticket_get`, `agent_list`, `agent_status`, `agent_inspect`, `schedule_list`, `schedule_show`, `evolve_list`, `evolve_get`, `linear_reconcile`, `app_list`, `app_inspect`): the daemon may finish or not — neither outcome affects correctness. The worker drops the response.

   - **Writes** (`mail_send`, `mail_read`, `mail_close`, `memory_save`, `memory_update`, `memory_forget`, `ticket_create`, `ticket_update`, `ticket_comment`, `ticket_link_external`, `agent_create`, `agent_archive`, `schedule_*` mutations, `evolve_save`/`update`/`apply`/`dismiss`/`scan`/`enrich`/`cluster`, `linear_import`/`create_issue`/`update_issue`, `app_install`/`uninstall`/`reload`): the daemon completes the operation as if Stop never happened. The next turn sees the canonical state (a new mail row, an updated ticket, a created Linear issue) and the model reconciles from there. Externally-visible side effects (Linear API writes, mail addressed to other agents) are not rolled back.

### Why not propagate cancel into the daemon?

Three reasons.

1. **External writes are already past the safety horizon.** By the time the worker's signal would propagate to the daemon and the daemon would propagate it to Linear/Postgres/the mail bus, the side effect is already on its way. Threading a signal into the daemon's outbound `fetch` to Linear only narrows a window that's measured in tens of milliseconds for the common case; for the rare slow case, partial-write semantics on the third-party side are worse than completion.

2. **Compensation is per-endpoint and adds permanent complexity.** Rolling back a `linear_create_issue` means a `linear_delete_issue` call that itself may fail; rolling back a `mail_send` means deleting a mail row the recipient might already have read. Each endpoint becomes a transaction-or-compensation pair forever. Compared to "let it complete; the next turn sees reality," the maintenance cost is hard to justify.

3. **The worker doesn't need to wait to abort cleanly.** The cancellation contract is "the worker stops blocking and emits `turn_done`," not "no daemon-side bytes are written." With `signal:` on `daemonFetch` the worker no longer needs the daemon's response to abort.

### Consequences

- **A Stop during a `linear_create_issue` may create the Linear issue.** The next turn's `mail_inbox` or `ticket_list` will show it; the model proceeds from observed state. Same applies to `linear_update_issue`, `mail_send` to a third party, `ticket_create`, `schedule_upsert`, `agent_create`, `app_install`.
- **A Stop during a long `memory_search` or `linear_reconcile` is free.** The daemon may finish the work (no harm) or the underlying query may complete past the cancel; either way the worker has moved on.
- **The model's mental model is "Stop interrupts the conversation, not the world."** This matches Claude Code's behavior: hitting Stop while a slash command is reaching out to an external API doesn't undo the API call.
- **Force-kill safety-net stays.** `forceKillStuckWorker` at 500ms remains for the case where the SDK iterator wedges (the original FRI-12 motivation — Anthropic 529s, MCP transports that don't honor cancel). With FRI-66 in place this is rare; the error copy reads "Stop forced — SDK did not honor abort" so dashboard readers know they hit the abnormal case.

### Bring this ADR back to the table if

- A Stop-during-write race produces user-visible damage (a builder spawned twice, a Linear issue created and then a duplicate on retry). Today the failure mode is "the next turn sees one extra row"; if it ever becomes "the next turn writes a destructive correction," tighten by adding idempotency keys to the write paths rather than threading signals into the daemon.
- An MCP handler grows non-`fetch` async work that ignores `extra.signal` (a long in-process loop, a Promise that never resolves on its own). Today every Friday handler funnels through `daemonFetch`; if that changes, audit those handlers for signal-honoring.
- The cooperative-abort path measurably exceeds 200ms in production. Today the descendant-kill at T+0 and the signal on `daemonFetch` should put it well under that; if not, the SDK's CLI subprocess shutdown is the next layer to instrument.

## ADR-031 — Agent state-machine gate; `registry.setStatus` is the only door

**Status:** accepted (FRI-113, 2026-05-22)

**Supersedes the deferred "path forward" section of ADR-020** (the invariants auditor was always intended to be the safety net under inline checks; this ADR makes the inline check real).

### Context

ADR-020 shipped a periodic auditor as a workaround because `registry.setStatus` accepted any → any transitions and the inline-gate refactor was too large to bundle with the existing work. Two production failures since have lived inside that gap:

1. **`archive_reason` always NULL.** The mutator path (Phase 4.8) wrote `archive_requested` + reason to the row, but every direct-archive entry point (`registry.archiveAgent(name)`, REST `/api/agents/:name/archive`, watchdog refork, boot recovery, invariants auditor, apps uninstaller, ticket-close) called the zero-arg `registry.archiveAgent` which dropped the reason. All 68 archived rows in production sit at `archive_reason IS NULL`.
2. **Orchestrator-archived zombie.** Nothing in the code prevented `setStatus("friday", "archived")` from running; if the `/clear` flow or any other path reached for it, the row landed in a state no consumer was prepared to handle — sidebar rendered an archived row that the worker kept heartbeating.

The grill on 2026-05-22 lifted ADR-020's "path forward" into scope as FRI-113.

### Decision

1. **`registry.setStatus` is the only door.** Every status write goes through one function that validates the `(type, current, next)` triple against an explicit FSM matrix. Illegal transitions throw `IllegalTransitionError` carrying a typed `code` (`ORCHESTRATOR_NOT_ARCHIVABLE`, `INVALID_STATUS_TRANSITION`, `MISSING_ARCHIVE_REASON`, `AGENT_NOT_FOUND` reserved).

2. **Transition matrix** (compiled into `services/daemon/src/agent/registry.ts`):

   | from \ to  | idle    | working | stalled | archived                   |
   | ---------- | ------- | ------- | ------- | -------------------------- |
   | `idle`     | (no-op) | ✅      | ✅      | ✅ (non-orchestrator only) |
   | `working`  | ✅      | (no-op) | ✅      | ✅ (non-orchestrator only) |
   | `stalled`  | ✅      | ✅      | (no-op) | ✅ (non-orchestrator only) |
   | `archived` | ❌\*    | ❌      | ❌      | (no-op)                    |

   \* `archived → idle` is reachable only via `unarchiveAgent` (the apps installer's re-adopt path), which uses the privileged unchecked write helper.

   The agent-status `error` value was removed in FRI-145 M5: a worker that exits mid-turn self-heals to `idle` via the Turn-state machine's `hard-exit` Transition rather than parking the row at a sticky `error`, so the matrix no longer carries an `error` row or column. `stalled` gained its producer (the watchdog `stall` Transition) in the same change. (The transient `archive_requested` the Zero mutator path writes — `* → archive_requested → archived` for non-orchestrators — is in the DB CHECK but elided from this table.)

3. **`archive_reason` is a required arg on the archived transition.** `setStatus(name, "archived", {archiveReason})` validates the reason is present and writes both columns atomically. `archiveAgent(name, {reason})` is the thin convenience wrapper.

4. **Per-type restrictions: orchestrator is never archivable.** The single user-facing chat surface has no terminal state; a "retired Friday" is conceptually a fresh install, not an archived row. The gate enforces this structurally.

5. **Auditor rule #3.** The continuous invariant auditor (`services/daemon/src/agent/invariants.ts`) gains a third rule that walks every row and heals illegal `(type, status)` resting states. The canonical case is `(orchestrator, archived)` from pre-FSM history or external psql edits; the heal goes through a privileged unchecked path (`_auditorHealStatusUnchecked`) because the FSM matrix forbids `archived → idle` from anywhere but `unarchiveAgent`.

6. **`ArchiveReason` is canonical in `@friday/shared/agents`.** Three values: `"completed" | "abandoned" | "failed"`. The duplicate in `services/daemon/src/services/ticket-close.ts` is deleted; both `lifecycle.ts` and `archive-listener.ts` import from shared. Watchdog refork and `/clear` go through `forceWorkerRefork`, never the archive write path — that's why the union has no `refork` value.

### Privileged unchecked writes

Two callers legitimately bypass the FSM gate:

- **`unarchiveAgent(name)`** — terminal escape, called by the apps installer when re-adopting an archived agent on reinstall.
- **`registry._auditorHealStatusUnchecked(name, status, {auditorHeal: true, clearArchiveReason?})`** — the only export designed for the auditor; the shape's `auditorHeal: true` key is the grep marker future readers use to find every privileged use site.

No other caller may reach the unchecked path. `_setStatusUnchecked` (lowercase underscore) is module-private.

### What this lands

- New error class `IllegalTransitionError` in `services/daemon/src/agent/registry.ts`.
- Refactored `setStatus`, `archiveAgent`, `unarchiveAgent`.
- Updated three live call sites of `registry.archiveAgent` to pass the reason: `services/daemon/src/index.ts:338` (`"abandoned"` for boot-orphan sweep), `services/daemon/src/agent/lifecycle.ts:995` (forwards the wrapper's `opts.reason`), `services/daemon/src/agent/invariants.ts:99` (`"abandoned"` for orphan-worktree sweep).
- New auditor rule #3 in `services/daemon/src/agent/invariants.ts`.
- Deduped `ArchiveReason`: deleted from `services/daemon/src/services/ticket-close.ts:25`, re-imported from `@friday/shared`.
- New test `services/daemon/src/agent/registry-fsm.test.ts` (7 named tests) plus one new case in `services/daemon/src/agent/invariants.test.ts` for Rule 3.
- Audit `audit()` return shape extended from `{archived, demoted}` to `{archived, demoted, healed}`.

### What this does NOT do (epic constraints)

- **No backfill of historical `archive_reason IS NULL` rows.** The 68 pre-existing NULL rows stay NULL. The gate only enforces the contract for new transitions; historical data is out of scope per the epic's "no backfill" rule.
- **No DB-level NOT NULL constraint on `archive_reason`.** Adding it would require backfilling the 68 rows. Leave as a future tightening once the column is universally populated by all live paths and we are willing to revisit history.
- **No widening of TS `AgentStatus` to include `archive_requested`.** The `archive_requested` value is in the DB check constraint (`schema.ts:97`) but the FSM matrix treats it as a transient state we never observe at rest — the LISTEN handler flips it to `archived` immediately. Widening the TS union is a separate follow-up captured against the epic's "out of scope findings" list.

### Bring this ADR back to the table if

- A new agent type lands (a sixth in the union) and its allowed transitions don't fit the common matrix.
- The privileged escape hatch list grows beyond `unarchiveAgent` + auditor heal. A third site with no orthogonal justification means the gate needs a different shape.
- `archive_requested` becomes a state code paths read at rest (e.g. a UI hover-preview shows "archive pending…" between mutator write and LISTEN handler). At that point the TS union widens and the matrix grows an edge.
- The 60-second auditor interval proves too slow to catch a Class A drift (a code-controlled state boundary that bypassed the inline gate). Today the gate IS the inline check; if a new direct-write path appears, the auditor's healing log lines are the canary.

## ADR-032 — Single-writer Turn-state machine; the worker turn lifecycle is one serialized state machine

**Status:** accepted (FRI-145, 2026-06-01)

**Amends ADR-016** (live in-flight state lives in daemon memory) and **ADR-024** (the agent-status model). **Builds on ADR-031** (`registry.setStatus` is the only DB door — ADR-032 makes the Turn-state machine that gate's only caller) and **ADR-020** (the invariant auditor remains the timer-based safety net, now reaching the column through the machine rather than around it). Vocabulary is defined in `CONTEXT.md` → "Agent turn lifecycle".

### Context

ADR-031 made `registry.setStatus` the only door to the `agents.status` column, but it did not make the _callers_ of that door serialized. A single agent's `agents.status` was still written by four unserialized write-semantics families:

1. the turn lifecycle (`services/daemon/src/agent/lifecycle.ts`),
2. archive (`registry.archiveAgent → registry.setStatus(name, "archived")`),
3. boot recovery (`services/daemon/src/index.ts`),
4. the continuous invariant auditor (`services/daemon/src/agent/invariants.ts`).

They were coordinated only by ad-hoc flags on the `LiveWorker` bag (`suppressIdleReset`, `forceKilled`), a read-before-write recheck in the exit handler, and a **per-worker** promise chain (`ipcChain`) that serialized only the IPC channel of one worker generation. There was no agent-wide serialization across channels or across worker generations. The 28-field `LiveWorker` carried parallel sources of the same truth (`w.status === "working"` ⇔ `w.turnStart !== undefined`), and the `handleEvent` switch (~509 lines) had near-duplicate `error` and `turn-complete` tails.

Two shipped bugs lived in that gap:

1. **`stalled` regression.** ADR-024 retired the `agent_status` SSE event and deleted the watchdog's `eventBus.publish({type:"agent_status", status:"stalled"})`, replacing it with only a comment. No `agents.status="stalled"` write was ever added, so the dashboard's warn-colored stalled dot had consumers but no producer.
2. **Hard-exit silent idle.** A worker dying without a terminal turn-complete (OOM / SIGKILL / crash) was reset to `idle` by the exit handler with **no** `turn_done` published, so the dashboard's `inflightTurnId` stayed pinned to a dead turn (a permanently-spinning bubble).

The most dangerous failure mode in the old design — a superseded worker generation's late IPC, exit, or abort-deadline writing `idle` over a `working`/`archived` row written by a _newer_ generation — was guarded only by the hand-rolled flags, which had to be set and cleared correctly at every teardown path. The unconditional name-keyed `live.delete(input.agentName)` in the exit handler could even drop a replacement generation's live entry.

### Decision

**There is exactly one application-level writer of `agents.status`: the Turn-state machine.** Every mutation is a **Transition** applied through the agent-keyed **Transition queue**, in strict arrival order. `registry.setStatus` stays the only DB door (ADR-031); the machine is its only caller. No failure mode requires `brew services restart` — the system is self-healing.

1. **Two distinct namespaces, by design.**
   - **Turn state** — the machine's authoritative in-memory state set: `idle | working | aborting | force-killed`. Lives in daemon memory; it is the source of truth.
   - **Status projection** — the durable mirror written _only_ inside a Transition: `agents.status` (`idle | working | stalled | archived`) plus the in-memory `w.status` (`idle | working`).

   These are intentionally different vocabularies. `force-killed` and `aborting` are transient Turn states with **no** resting `agents.status` value (`force-killed` projects/heals to `idle` after the kill). `stalled` and `archived` are projections with **no** resting Turn state. `archived` is the terminal sink reached via the `archive` Transition, not a fourth resting Turn-state value. (The DB CHECK additionally carries the transient `archive_requested` the Zero mutator path writes; that value is not pruned by this work and never observed at rest — the LISTEN handler flips it to `archived` immediately.)

2. **The agent-keyed Transition queue** (`services/daemon/src/agent/transition-queue.ts`) replaces the per-worker `ipcChain`. Every Transition for one agent name funnels through one serialized, non-wedging promise chain, so transitions apply in strict arrival order with no interleaving — across the IPC channel, across worker generations, and across the archive / boot / auditor channels. `enqueueTransitionResult<T>` is the variant whose returned promise resolves/rejects with the Transition's real outcome (so an awaiting archive caller still sees the FSM `IllegalTransitionError`).

3. **Generation = object identity.** A worker instance `w` is the _current_ **Generation** of its agent name iff `live.get(name) === w` (`isCurrentGeneration(w)` in `lifecycle.ts`). A Transition arriving from a superseded Generation — a stale worker whose name a replacement already re-`live.set`, or one already `live.delete`d by force-kill / archive / refork — is a **structural no-op**. This single rule replaces both `suppressIdleReset` and `forceKilled` (deleted), and fixes the latent name-keyed-delete clobber: teardown demotes the Generation (`live.delete`) up front, so any racing IPC / exit / abort-deadline Transition sees `live.get(name) !== w` and no-ops. Identity-as-epoch — promoted to a monotonic counter only if cross-gap ordering is ever needed. (`forceKillStuckWorker`'s late abort-deadline idle write is guarded by this rule so it can't write `idle` over a newer generation's `archived`.)

4. **The machine returns intents; the caller schedules side effects after the Transition resolves.** `apply(...)` and `applyAdmin(...)` are pure-ish functions returning `{ state/projection, intents }`. An `executeIntents` runner performs side effects (the `set-status` projection write, `close-ticket`, `archive`, `heal`, `publish-turn-done`, `finalize-blocks`, `send-next`, `force-kill`, etc.) _after_ the Transition resolves. No on-chain handler re-enters the same-key queue mid-Transition — that is the one residual hazard the single-writer invariant depends on holding.

5. **Archive / boot / auditor route through the machine** (replacing direct `registry.setStatus` / `registry.archiveAgent` / `_auditorHealStatusUnchecked` calls). The `AdminTransition` union (`archive` / `heal` / `set-projection`) operates on an agent _name_ (which may have no live worker), carries no turn-boundary bookkeeping, and decides one Status projection. The `archive` Transition emits `close-ticket` **before** `archive`, so the linked ticket closes strictly before the row goes terminal (replacing the old fire-and-forget close that raced the archive write).

6. **The watchdog enqueues `stall` fire-and-forget.** When a working worker blows past its heartbeat budget the watchdog enqueues a `stall` Transition that projects `agents.status="stalled"` — restoring the producer lost when the `agent_status` SSE was retired. The watchdog **never awaits** the Transition inside its tick loop; awaiting would head-of-line-block the watchdog across all agents (the only deadlock / HOL condition). The watchdog never calls `setStatus` directly.

7. **Hard-exit self-heals.** A worker that exits mid-turn with no terminal turn-complete drives a `hard-exit` Transition that finalizes streaming blocks as error, publishes the previously-missing `turn_done{status:"error"}` (so the dashboard's inflight pin unpins), and heals the row to `idle` — dispatchable, no daemon restart. A racing archive's terminal `archived` is preserved.

### The agent-status `error` prune

The agent-status `"error"` value is removed end-to-end (`AgentStatus` union, both FSM matrices, the schema CHECK constraint via drizzle-kit migration `0027`, the Zero sync union, the `mcp/agents.ts` `agent_list` enum, and the two dashboard `statusDot` branches). The `hard-exit` Transition's self-heal to `idle` is what replaces the old sticky `error` resting state — there is no longer any non-archived dead state that requires manual recovery.

**Namespace boundary (do not conflate):** the **turn-wire** `turn_done{status:"error"}` and all **block/tool** `"error"` statuses are a _different_ namespace and **stay**. Only the `AgentStatus` member, the FSM matrix rows/edges, the CHECK literal, the sync union, the MCP enum, and the two dashboard agent-status dot branches were pruned. See the ADR-031 transition matrix above (already updated) — it no longer carries an `error` row or column.

### What this lands

- `services/daemon/src/agent/transition-queue.ts` — the agent-keyed serialized queue (`enqueueTransition` + `enqueueTransitionResult`).
- `services/daemon/src/agent/turn-state-machine.ts` — `TurnState`, `StatusProjection`, the `Transition` and `AdminTransition` unions, the `Intent` union, and the pure `apply` / `applyAdmin` reducers.
- `services/daemon/src/agent/turn-state-ports.ts` — the injected collaborator ports (`setStatus`, `archive`, `heal`, `closeTicket`, publish, finalize-blocks, …) and the `executeIntents` runner.
- `isCurrentGeneration(w)` in `lifecycle.ts` replacing `suppressIdleReset` + `forceKilled` (both deleted; 0 non-test references remain).
- `let ipcChain` removed from `lifecycle.ts`; per-worker chaining replaced by `enqueueTransition(name, …)`.
- The watchdog `stall` producer; the exit handler `hard-exit` self-heal; the `error` prune (migration `0027`).

### What this does NOT do

- **No monotonic Generation counter.** Generation is same-process object identity (`live.get(name) === w`). A counter/UUID is a future tightening only if cross-process or cross-gap ordering is ever needed.
- **No fourth `agents.status` value for the transient Turn states.** `aborting` and `force-killed` are in-memory Turn states only; they project to `idle`/`working`/`archived`, never to their own column value.
- **No removal of `archive_requested`** from the DB CHECK. It stays transient (TS union unchanged, per ADR-031).
- **No change to the turn-wire / block / tool `error` namespace.**

### Bring this ADR back to the table if

- An on-chain intent handler needs to re-enter the same agent's Transition queue mid-Transition (today none does: `send-next` is dispatched off-chain, force-kill only awaits DB writes + `killPgrp`). That would reintroduce a same-key deadlock and force the queue design to change.
- Cross-process or cross-restart ordering of generations is ever needed — promote Generation from object identity to a monotonic counter.
- A fifth write-semantics family for `agents.status` appears that genuinely cannot be modeled as a Transition (none is foreseen).

## ADR-033 — Evolve agency Phase 1: auto-spawn read-only triage helpers on promote-to-critical (FRI-40); auto-fixing Builders deferred to Phase 2

**Status:** accepted (FRI-40, 2026-06-02)

Until now the evolve pipeline was passive: the daily meta-agent scans, enriches, clusters, and mails the orchestrator a digest, but every investigation of a newly-critical proposal waits for a human (or the orchestrator on the next turn) to pick it up. A `critical` proposal is, by definition, the system telling us "this is failing to do its job" — the latency between promote-to-critical and someone actually reading the evidence is pure dead time.

**Decision — Phase 1 (this change).** When `evolve.autoSpawnTriageHelpers` is `true` (config key, **default off**), the daemon's `POST /api/evolve/scan` handler spawns one **read-only triage helper** per proposal that promoted to critical during that scan. The helper is named `triage-<FULL proposal id>` (the full id, not a prefix slice — proposal ids are `<slug>-<4char>` so a 12-char prefix collides across siblings). Its mandate is strictly read-only: call `evolve_get`, follow the evidence pointers, investigate the referenced logs / usage / transcripts, and mail the orchestrator a concise root-cause summary. It applies nothing, dismisses nothing, edits no files.

**Why this shape:**

1. **Both promote surfaces feed it.** A proposal can promote to critical via fresh creation (`proposeFromSignals().promotedToCritical`) or via the end-of-scan rerank (`rerankAll().promoted`). The hook plans against the union of both and dedupes by id, so a proposal appearing in both surfaces spawns exactly one helper.
2. **Idempotent by construction.** The hook calls the in-process `createAgent` (extracted from the `POST /api/agents` route, behavior unchanged), which returns 409 when a `triage-<id>` agent already exists. A second daily scan that re-promotes the same still-critical proposal therefore re-uses the existing helper instead of spawning a duplicate — no fast-spin guard needed for this surface.
3. **Caller identity is `scheduled-meta-daily`.** The hook spawns with `parentName: "scheduled-meta-daily"`, whose registry row resolves `callerType="scheduled"`. That passes the ADR-022 spawn gate as a helper-with-reason without loosening `spawn-permissions.ts` — the gate already permits a non-orchestrator caller to spawn a helper given a non-empty reason.
4. **Default off, strict read.** The flag is read with `cfg.evolve?.autoSpawnTriageHelpers === true`, so the shallow-merge `{ evolve: {} }` user-config case stays disabled rather than silently enabling the feature.
5. **Failure-isolated.** A spawn failure (telemetry error, registry hiccup, gate rejection) is caught per-helper and logged (`evolve.triage.spawn` / `.skip` / `.error`); it never alters the scan's returned summary and never throws out of the handler.

**Phase 2 — auto-spawning Builders to actually fix the issue — is explicitly deferred.** A Builder is a worktree + branch + push-rights surface, and Constitution §3 ("user approval gate before creating Builders") makes the orchestrator the only legitimate spawner of Builders. Auto-spawning a Builder off a machine-promoted signal would route around that gate — exactly the blast-radius multiplier ADR-022 §3 guards against. Triage helpers are safe to auto-spawn precisely because they are read-only: the worst case is wasted API spend on an investigation, not an unreviewed code change. Phase 2 stays a human/orchestrator decision.

The fast-spin loop guard (`isIterationTooFast`) is tracked separately as FRI-147 and is out of scope here; the 409-dedup above already prevents the only loop this surface can create (re-promote → re-spawn).

### Bring this ADR back to the table if

- Triage helpers reliably produce a correct, low-risk fix that the orchestrator rubber-stamps every time — that's the signal that Phase 2 (gated auto-Builder, or a one-click "promote triage → builder" affordance) is worth designing.
- The 409-dedup proves insufficient (e.g. helpers get archived and immediately re-spawned each scan) — promote FRI-147's fast-spin guard ahead of schedule.

## ADR-034 — Curl-install + `friday update`; pre-baked tarballs + fnm-pinned Node; homebrew-friday retired

**Status:** accepted (FRI-146, 2026-06-02)

**Supersedes ADR-028 §1** (the one-tap/one-formula Homebrew distribution model) and the §5 "thin aliases over `brew services`" registration mechanism. **Dissolves FRI-138's entire bug class.** **Subsumes FRI-120** (semver + release-please pipeline, which had kept the brew tap). The supervision _logic_ of ADR-028 (cascade-stop, boot order, KeepAlive/backoff, crash-loop guard — §2/§3/§4) is unchanged; only the registration mechanism and the child-spawn command resolution move.

### Context

Friday shipped via a Homebrew formula in a separate `sethvoltz/homebrew-friday` tap (`brew install …`). That model had a structural defect proven in production (FRI-138, repro 2026-06-01): when `brew autoupdate` swaps the Cellar dir under live processes, the daemon's lazy file reads hit ENOENT, the dashboard crashes, and the supervisor's respawn fails `spawn node ENOENT` because the brew-shipped `node` is in the deleted dir — a half-dead stack that only a manual restart fixes. Nothing in ADR-028 prevents an external package manager from deleting the dir a live process is reading from. On top of that, the brew "source install" ran `pnpm install --prod && pnpm -r build` on-device (5–10 min), and there was no semver pipeline at all (root + 7 workspace `package.json` all pinned `0.0.1`; `friday --version` was a hardcoded `"0.0.1"` literal).

### Decision

Distribution moves to a Claude-Code-style `curl -fsSL <stable-url>/install.sh | bash` + a `friday update` CLI command, backed by a release-please semver CI pipeline that builds pre-baked per-platform tarballs. Friday installs into self-owned **versioned** dirs that only `friday update` ever flips — brew can never swap a dir under a live process again.

1. **Brew is RETAINED for third-party deps.** Retiring Homebrew here means retiring **only** Friday's own formula/tap (`sethvoltz/homebrew-friday`) and `brew services friday` supervision. Brew stays the third-party dependency manager — install + Brewfile-tracked upgrades of `pnpm`, `postgresql@18`, `cloudflared`, `gh`, `claude-code`, and the newly added `fnm`. The Brewfile is retained as the dependency manifest; only `tmux` is dropped (it was already dev-only post-ADR-028). Postgres stays brew-managed and host-supervised, untouched.

2. **cloudflared is unchanged.** It stays brew-installed and runs via its own launch agent `com.cloudflare.cloudflared` (ADR-028 §7), NOT `brew services` — already the shipping pattern. This ADR generalizes that bypass to Friday itself.

3. **Node pinned via `fnm` + `.node-version` (default `22.21.1`).** A new repo-root `.node-version` file is the single Node-pin source of truth (owner-overridable). `fnm` (brew-installed) provisions that exact version under its own store via `fnm install` reading `.node-version`. The launchd supervisor is launched THROUGH `fnm exec` (`fnm exec -- node …`), so `process.execPath` inside the running supervisor IS the fnm-resolved pinned node; the supervisor spawns its children (daemon, dashboard, zero-cache) via `process.execPath` — never bare `node`, `pnpm`, or `.bin` shims. fnm-managed Node is untouched by `brew upgrade node`, so it stays ABI-matched to the pre-baked native addons (`@oxfmt/binding`, `@rocicorp/zero-sqlite3`, `better-sqlite3`, `sharp`). NOT a hand-vendored Node tarball; NO path-baking. The ONLY absolute Node-toolchain path written anywhere is the fnm binary at `$(brew --prefix)/bin/fnm`, a stable public locator resolved at install time; fnm's internal `~/.local/share/fnm/node-versions/.../bin/node` path is never written or baked.

4. **Payload = pre-baked per-platform tarball (FRI-120's "4b").** CI runs `pnpm install --prod` on a runner of each shipped arch — `macos-latest` (Apple Silicon, primary) and `macos-13` (Intel x64, legacy) via a matrix — under the exact pinned Node, and bundles `node_modules` INTO the tarball (`packaging/pack.mjs`). Native prebuilds can't cross-compile, so each arch must build on its own runner. On-device `friday update` = download + sha256-verify + extract + symlink-flip + `launchctl kickstart -k`. NO on-device `pnpm install`, NO build. The pre-baked native addons are therefore ABI-matched to the fnm-provisioned runtime. Both darwin arches ship today; Linux remains a designed-for future matrix row (`uname` dispatch + `friday-<os>-<arch>.tar.gz` asset naming).

5. **The pnpm-`.bin`-shim relocation hazard and the pnpm-is-a-brew-casualty gap are both resolved by the single `process.execPath` mechanism.** pnpm bakes an absolute pack-time `NODE_PATH` into its `.bin` command-shims (regular files, not symlinks — 37/40 in this repo at probe time), pointing at the pack-time `.pnpm` store. After relocation to `~/.local/share/friday/versions/<v>/`, that path does not exist on the user's machine, and the failure would surface at runtime (zero-cache fails to resolve a transitively-required module → daemon-up-but-sync-down half-stack). Because the supervisor spawns zero-cache as `process.execPath` directly against `@rocicorp/zero`'s `out/zero/src/cli.js`, the baked `NODE_PATH` in the shim is never read. The same mechanism eliminates the `spawn pnpm ENOENT` half-stack: pnpm stays build/dev-time-only and is off the runtime critical path. Rejected alternatives: post-extract `sed`-rewrite of `.bin/*` `NODE_PATH` (brittle; re-derives pnpm internals); `--node-linker=hoisted` CI pack (changes tree shape, risks workspace-link collisions); baking a node path into the shims.

6. **Install layout = versioned dirs + a `current` symlink; direct-launchd registration.** Code lives at `~/.local/share/friday/versions/<version>/`, with `~/.local/share/friday/current` symlinked to the active version (atomic upgrade = `ln -sfn` flip; `friday update --rollback` = flip back). The `friday` PATH shim is `~/.local/bin/friday`. The code/install tree is SEPARATE from `~/.friday/` user data (`FRIDAY_DATA_DIR`); `friday uninstall` removes the install tree but preserves `~/.friday/` by default. The launchd plist (`com.sethvoltz.friday`, vendor reverse-DNS convention) is written + bootstrapped DIRECTLY by `install.sh` / the CLI (`launchctl bootstrap`/`bootout`/`kickstart`), generalizing ADR-028 §7's cloudflared bypass. launchd job logs go to `~/.friday/logs/launchd.{out,err}.log` (the plist's `StandardOutPath`/`StandardErrorPath`), not brew's `$(brew --prefix)/var/log`.

7. **FRI-138 dissolution.** Self-owned versioned dirs that only `friday update` flips remove the failure mode structurally: nothing external ever deletes the dir a live process is reading from, and the fnm-managed Node lives outside any swept dir so `spawn node` can't ENOENT mid-run. FRI-138's own "fix direction 3" is exactly this ticket.

8. **"friday version" == cli package version by lockstep.** release-please owns all 8 `package.json` versions: the root via `release-type: node` natively, the 7 workspace packages via `extra-files`, bumped in lockstep. `friday --version` now reads `packages/cli/package.json`'s `version` via a `import pkg from "…/package.json" with { type: "json" }` static import (replacing the `"0.0.1"` literal); `backup.ts`'s `readFridayVersion()` walker — which returned the literal `"unknown"` because no package is named `"friday"` — is deleted. Because all 8 bump together, "friday version" equals the cli package version by construction.

9. **Download trust model: sha256 = integrity, NOT authenticity; the resolved version string is path-validated.** `install.sh` and `friday update` fetch the tarball AND its `.sha256` from the SAME GitHub release origin, so the sha256 guards against accidental corruption / partial download and against a tarball mutated _after_ its sha was written — but NOT against an attacker who can replace both assets (they would re-sha the substitute). There is no detached signature (GPG / cosign / sigstore / GitHub attestation) in v1; authenticity rests on **GitHub release ACLs + HTTPS transport** and the trusted release-please pipeline that authors the assets. Separately, the remote-fetched `VERSION` string is validated against a strict semver regex (`update.ts:assertValidVersion` / `install.sh:resolve_version`) **before** it is ever joined into a filesystem path — `.trim()` strips whitespace but not `/` or `..`, so a payload like `../../../tmp/x` would otherwise escape `versions/` and point the `current` symlink (then the launchd-executed tree) at an arbitrary path. The version validation ships in v1; detached-signature authenticity is tracked as hardening (see "bring back" triggers).

### Semver pipeline (FRI-120 rationale, carried in)

release-please is configured `release-type: node` with `bump-minor-pre-major: true` — load-bearing, because release-please's default is `false`, which would MAJOR-bump pre-1.0 on a `BREAKING CHANGE` footer. Pre-1.0, `feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → minor (not major). The release-please workflow auto-merges its own Release PR (narrowly scoped `gh pr merge --auto --squash`); `release-publish.yml` fires on `release.published`, packs each darwin arch on a runner of that arch (`macos-latest` for arm64, `macos-13` for Intel x64) via a matrix, and uploads each arch's tarball + `.sha256` (plus the shared `VERSION`, once, from the arm64 row) as release assets — the formula-render / clone-homebrew-friday-and-push tail is cut entirely. CI selects the exact pinned Node via `node-version-file: .node-version` (not floating `node-version: [22]`), so the pre-baked native modules match the runtime.

**v1.0.0 cutover playbook (recorded; the flip is a later owner-gated commit).** When the surface stabilizes: land a commit with a `BREAKING CHANGE:` footer (or manually set `1.0.0` in `.release-please-manifest.json`), let release-please cut `1.0.0`; from then on `bump-minor-pre-major` is moot and standard semver applies (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major). The pre-1.0 `bump-minor-pre-major: true` can be removed at that point.

### What this does NOT do

- **No Linux build.** `release-publish.yml` builds both darwin arches — `darwin-arm64` (Apple Silicon, primary) on `macos-latest` and `darwin-x64` (Intel, legacy) on `macos-13`, each on a runner of that arch because native prebuilds can't cross-compile. The asset naming + `uname` dispatch are also shaped for a future Linux row, but Linux is not built. macos-13 is GitHub's last free Intel image; Intel Macs cap out at macOS 26, so no newer Intel runner is coming and none is needed.
- **No change to Postgres or cloudflared packaging.** Both stay brew-managed exactly as before.
- **No change to the supervision LOGIC** (cascade-stop, backoff, crash-loop, boot order). `buildSpecs()` is edited (child-spawn command resolution) but the supervision semantics are untouched — "supervisor binary byte-for-byte unchanged" was never a goal.
- **No self-update auto-trigger / background update checks.** `friday update` is explicit/manual in v1.
- **No v1.0.0 graduation here.** ADR-034 records the playbook; flipping to 1.0.0 is a later owner-gated commit.

### Bring this ADR back to the table if

- A transitive dep's postinstall writes an absolute pack-time path into a _content_ file (not a shim, not a symlink). The `process.execPath` spawn doesn't cover that — the relocation smoke is the canary: extract to a different abs path, then `friday --version` through the bundled fnm shim, `node --check` the daemon entry, a direct `@oxfmt/binding` dlopen (the addon, not a booted SSR server — it needs no DB), and a `process.execPath` zero-cache spawn that resolves its bundled deps from the relocated tree with NODE_PATH scrubbed. It runs in `release-publish.yml` before the upload (only on release — the artifact only exists then), so a broken tarball never ships.
- Linux/systemd support lands — the CLI alias layer already abstracts the supervision backend (ADR-028 §5); the direct-launchd registration becomes a `systemctl --user` branch.
- The fnm dependency itself becomes a liability (e.g. fnm changes its `.node-version` resolution semantics). The pin mechanism, not the distribution model, would be what's reopened.
- Authenticity (not just integrity) becomes a requirement — e.g. the install entrypoint moves to a less-trusted origin, or the threat model adds an attacker who can write release assets. Add detached provenance: GitHub artifact attestations (`actions/attest-build-provenance` in `release-publish.yml`) verified in `friday update`, or a cosign signature over the tarball. v1 deliberately ships sha256-integrity-only (decision point 9).
- The supply-chain blast radius of the publish pipeline grows. `release-publish.yml` runs with `contents: write` and produces the exact assets users `curl | bash` / `friday update` — its third-party actions (`googleapis/release-please-action`, `pnpm/action-setup`) are pinned to full commit SHAs (tag named in a trailing comment) precisely because a retagged/compromised mutable major tag could inject into the published tarball. Keep new third-party actions in the publish/release-please workflows SHA-pinned; Dependabot keeps the pins current.

## ADR-035 — User-facing reminders fire as a chat notification without spawning an agent

**Status:** accepted (FRI-143, 2026-06-02)

> **Numbering note:** drafted as ADR-033; renumbered to **ADR-035** at rebase because FRI-40 (ADR-033) and FRI-146 (ADR-034) landed on `main` first. Back-references (`docs/architecture.md` scheduler paragraph) point at ADR-035.

**Builds on the scheduler** (`schedules` table + 30s tick + LISTEN dispatch) and **ADR-017** (all user-visible deliveries surface as chat blocks via the mail surface, not a `chat_reply` tool). **Reuses ADR-024**'s observation that a `role:'user'` block emits no `agent_message` SSE. **Depends on FRI-98** (cron timezone) for correct recurring fires — unbuilt at time of writing, so recurring reminders inherit the host-TZ `nextRun` path.

### Context

A user wants Friday to nudge them at a time ("thaw the chicken at midday Thursday") without burning a turn or waking an agent to do it. The scheduler already has everything needed to fire at a time — a `schedules` table, a 30s tick, a LISTEN-driven manual-trigger path, and `computeNext` — but every fire today spawns a one-shot worker (`spawnScheduledRun`), which costs a process, a turn, and tokens, and lands its output through the agent lifecycle. A reminder needs none of that: it is a pure notification that should appear in the chat and bump the unread badge, full stop.

### Decision

**A reminder is a schedule that fires into the chat instead of into a worker.** The `schedules` table gains a `kind` discriminator (`'agent-run'` default, `'reminder'`) and a nullable `delivery_json` payload column (migration `0029`). A `kind='reminder'` row fires through the existing tick / LISTEN paths but runs `deliverReminder` instead of `spawnScheduledRun`:

1. **No-spawn fire path.** `deliverReminder` writes a `role:'user'`, `source:'reminder'` chat block into the target (default orchestrator `friday`) chat via `recordUserBlock` and **stops**. It deliberately does NOT call `dispatchTurn`, `spawnScheduledRun`, `wakeAgent`, `wakeAgentCritical`, or `maybeSpawnFromMail` — not waking anything is the entire point. `fireSchedule` branches on `r.kind` to choose `deliverReminder` vs `spawnScheduledRun`.

2. **Chat-block delivery reuses the mail surface.** The reminder lands as a chat block exactly the way a `mail`-kind delivery does (ADR-017), through `recordUserBlock` — but with `source:'reminder'` and **without** going through `maybeSpawnFromMail` (which is the part of the mail path that would spawn/wake a recipient). The reminder is content in the chat, not an instruction to act.

3. **Unread signal via the trigger, not the SSE.** The cross-device unread badge is bumped by extending the existing `friday_blocks_increment_unread()` Postgres trigger's source allowlist to include `'reminder'` (one literal added to the `IN (...)` list; `CREATE OR REPLACE FUNCTION` swaps the body in place, trigger keeps pointing at it by name). We deliberately do **not** route the badge through `maybeEmitAgentMessage`: that helper early-returns for any `role !== 'assistant'`, so a `role:'user'` reminder block emits no `agent_message` SSE — which is correct (there is no live turn to stream), but it means the SSE cannot be the unread producer. The durable DB trigger is the right layer because it fires on the row write regardless of which device/process is connected.

4. **Reuse `schedules` + `kind`, don't fork a table.** A reminder shares the scheduler's tick, manual-trigger, pause/resume, and `computeNext` machinery; only the fire action differs. A separate table would duplicate all of that. `taskPrompt` stays `NOT NULL` (it holds the reminder title as a fallback); the structured payload lives in `delivery_json` (`title`, `body`, `targetAgent`, `deepLink`, `originatingAgent`, and a `channel` field reserved for future channels — see below).

5. **One-shot completion via null `nextRunAt`.** A one-shot reminder (`runAt`, no `cron`) has no busy-guard once delivered — and unlike an agent-run it spawns no worker whose lifecycle would gate re-selection. So `nextRunAfterFire(r)` returns `null` for a one-shot reminder, and the tick's `nextRunAt !== null` filter permanently drops it; without this the tick would re-deliver it every 30s forever. The same helper is used by the listener's `trigger_requested` tail (the manual-trigger path), which previously ran its own `computeNext(row)` and would have overwritten the null back to a past instant → re-fire. That tail now calls `nextRunAfterFire` too — the **listener trigger-tail gap fix**. Everything that is not a one-shot reminder (recurring reminders, all agent-runs) advances via `computeNext` as before. The tick's due-selection predicate is exported as `selectDueSchedules` so the regression test exercises the real filter rather than a hand-rolled copy.

6. **A separate `friday-reminder` MCP server, reachable by every agent type.** Setting a reminder is user-facing and any agent — including app sub-agents like a kitchen agent — must be able to do it, so `friday-reminder` (`reminder_create`, `reminder_list`, `reminder_cancel`) is registered **unconditionally** in `buildMcpServers`. This contrasts `friday-schedule`, which is orchestrator-only because scheduling autonomous agent runs is an orchestrator concern. `reminder_create` posts to the existing `POST /api/schedules` route with `kind:'reminder'`; no new endpoint is needed. The stub-agent registration that `upsertSchedule` does for agent-runs (FRI-76, so mail-recipient validation passes before first fire) is **skipped** for reminders, which have no agent.

7. **FRI-142 push as a future additive channel.** `delivery_json.channel` defaults to `'chat'` and is reserved so a future FRI-142 push-notification channel layers on as an additional delivery target, not a rewrite. `deepLink` is similarly reserved for a future deep-link back into the originating agent's context.

8. **FRI-98 timezone dependency.** Recurring reminders compute their next fire through the existing host-TZ `computeNext` / `nextRun` path. FRI-98 (cron timezone) is unbuilt; **no timezone code is written here.** When FRI-98 lands, recurring reminders inherit it for free.

### What this lands

- `schedules.kind` (`text NOT NULL DEFAULT 'agent-run'`, CHECK `IN ('agent-run','reminder')`) + `schedules.delivery_json` (`jsonb`) — schema + Zero sync slice + migration `0029` (incl. the hand-appended `friday_blocks_increment_unread()` redefinition adding `'reminder'`).
- `services/daemon/src/scheduler/deliver-reminder.ts` — the no-spawn fire action + the `ReminderDelivery` payload type.
- `fireSchedule` kind-branch; `nextRunAfterFire` + exported `selectDueSchedules` helpers; the listener `trigger_requested` tail fix; the `upsertSchedule` stub-agent skip for reminders.
- `services/daemon/src/mcp/reminder.ts` (`friday-reminder` server) wired unconditionally in `buildMcpServers`.

### What this does NOT do

- **No new fire scheduler / no new table.** Reminders ride the existing `schedules` machinery.
- **No `maybeSpawnFromMail` / no agent wake / no turn.** A reminder never causes execution.
- **No `agent_message` SSE for the reminder.** The unread badge comes from the DB trigger only.
- **No timezone code (FRI-98 deferred).** Recurring reminders use the host-TZ path.
- **No push channel yet (FRI-142).** Only the `channel:'chat'` reservation in `delivery_json`.

### FRI-168 — Make reminders first-class (2026-06-17)

FRI-168 extends this ADR along four axes without changing the no-spawn fire model. **No schema migration: `kind`, `delivery_json`, and `app_id` already exist on `schedules`; everything new here is TS/jsonb-only** (`reminders.defaultHour` config, the `reminderName` `content_json` field).

- **Day-scoped (`dueDate`) reminders resolve to a default hour at create time.** When the user names a calendar day with no clock time ("remind me Friday", "thaw the cod Thursday"), `reminder_create` accepts a `dueDate` (`YYYY-MM-DD`) and resolves it to a **concrete `runAt`** at the configured default hour — `reminders.defaultHour` (default **09:00 local**; literal `DEFAULT_REMINDER_HOUR` in `config.ts`, never `.env`, overridable via `config.json`, mirroring the `compaction` precedent). It is resolved as **local** time (`new Date(y, mo-1, d, hour)`, not `new Date("YYYY-MM-DD")` which parses as UTC). Persisting a real `runAt` is load-bearing: the one-shot-drop guard (`nextRunAfterFire`, §5 above) only fires for `r.runAt && !r.cron`; a `dueDate` row left without a concrete `runAt` would re-deliver every 30s forever. The three-way `{runAt, cron, dueDate}` exactly-one guard runs before any `daemonFetch`, so a bad call POSTs nothing.
- **App-derived idempotent reminders.** `appId` is threaded from `appContext` into `buildReminderServer` (mirroring `buildSecretsServer`; the shared `ctx` is deliberately NOT widened, so `appId` never leaks into mail/memory/tickets). An app sub-agent may pass an `idempotencyKey`; the row name becomes the deterministic `app:<appId>:<idempotencyKey>`, so re-emission UPDATEs the same row (PK = `name`) instead of duplicating — **no dedup table**. The **app-namespace guard** (an `idempotencyKey` requires an app context) is enforced in the MCP tool; the `POST /api/schedules` daemon endpoint stays caller-agnostic (it threads `appId` straight into `upsertSchedule`).
- **MCP-only lifecycle.** `reminder_snooze` (name + relative `duration`, e.g. `2h`/`30m`/`1d`) re-arms a fired or pending reminder by re-running `upsertSchedule` with a new `runAt` (so `nextRunAt` recomputes via `computeNext`); it posts to a new `POST /api/schedules/:name/snooze`. The delivered chat block is stamped with `reminderName` in `content_json` (camelCase, via `recordUserBlock`) so the model can ack/snooze by name. No new dashboard chat-block component (owner decision 2).
- **Surfacing on `/schedules`.** The `schedules` Zero slice gains `kind` + `delivery_json`; the page renders a **Kind** column, an All/Reminders view toggle, and an **"Upcoming reminders"** agenda panel (next 7 days, soonest first) over the _existing_ Zero slice — no new query path. Pure filter/window logic lives in `routes/schedules/reminders.ts` (`filterReminders`, `upcomingReminders`) so it unit-tests without a browser. Push stays deferred to FRI-142.

### Bring this ADR back to the table if

- FRI-142 push lands — confirm it slots in as an additive `delivery_json.channel` and `deliverReminder` fans out to it rather than being rewritten.
- FRI-98 cron timezone lands — recurring reminders should inherit it with no reminder-specific change; verify.
- A reminder ever needs to _act_ (not just notify) — that is no longer a reminder; it is an agent-run schedule, and the user should reach for `friday-schedule`, not a new branch in `deliverReminder`.

## ADR-036 — Evolve agency Phase 2: auto-escalate critical+code+high proposals to a Builder; the human-approval gate moves from approve-before-spawn to approve-before-MERGE (FRI-149)

**Status:** accepted (FRI-149, 2026-06-02)

**Amends ADR-022 and ADR-033 by reference.** ADR-022 ("only the orchestrator spawns Builders") and ADR-033 ("Phase 2 — auto-spawning Builders — is explicitly deferred") are NOT revoked: the unconditional "only the orchestrator spawns Builders" rule still stands for every caller except the single, narrow, audited evolve-escalation path defined here. ADR-033's Phase-2-deferred stance is the exact thing this ADR un-defers, on the trigger ADR-033 itself named ("a one-click promote-triage→builder affordance / gated auto-Builder is worth designing").

### Context

ADR-033 (FRI-40) gave evolve a read-only triage helper that investigates a newly-critical proposal and mails the orchestrator. For the narrow class of proposals whose fix is a **code change**, the human-in-the-spawn-loop is pure latency: the system already knows the problem is critical and code-shaped, yet nothing moves toward a fix until a person reads the mail and asks the orchestrator to cut a Builder. ADR-022 makes "only the orchestrator spawns Builders" the single unconditionally-enforced rule precisely because a Builder is the irreversible (worktree + branch + push) surface — and ADR-033 deferred auto-Builders for exactly that reason.

### Decision

When `evolve.autoSpawnBuilders` is `true` (config key in the same `evolve` object as `autoSpawnTriageHelpers`, **default off**, read with a strict `=== true`), the daemon's `POST /api/evolve/scan` handler auto-spawns one **auto-fixing Builder** per proposal that, during that scan, promoted to critical AND is `type === "code"` AND carries at least one high-severity signal. The Builder is named `builder-<FULL proposal id>`, linked to the proposal, iterates in its worktree to implement the smallest fix, drives the work to a **stable, GREEN, review-ready PR — and then STOPS. It never merges.**

**The human-approval gate moves from approve-before-spawn (ADR-022 / ADR-033 / Constitution §3) to approve-before-merge.** The user reviews the green PR and merges it (or asks for minor passes). This is a deliberate, narrow, audited carve-out — not a silent bypass.

**Why this shape:**

1. **Trigger band: critical + code + high-severity signal.** Critical is the only promote surface the hook sees; `type === "code"` is the owner-settled "things that can be solved with code" filter (memory/prompt/config are never escalated); and the "high" reading is a **high-severity signal** — NOT blast radius "high". Blast radius "high" is a SCORE PENALTY in `rank.ts` (it lowers score, selecting less-confident proposals — wrong direction for auto-fix), whereas a high-severity signal is exactly the `isCritical` branch that most decisively trips criticality. Pure planner `builderEscalationPlan` (`packages/evolve/src/builder-escalation.ts`, IO-free, sibling of `triage-spawn.ts`) encodes the band and dedupes by id across both promote surfaces.

2. **The carve-out is one audited door, gated on an un-forgeable marker.** `validateSpawnPermissions(body, callerType, opts?)` permits a builder spawn from a non-orchestrator caller ONLY when `opts.evolveEscalation === true` AND `callerType === "scheduled"` AND a non-empty `reason` is present. The load-bearing security property: **`evolveEscalation` is a SEPARATE function argument — NEVER a field on `CreateAgentInput` / the request body.** `callerType === "scheduled"` is by itself forgeable (a wire client can name `parentName: "scheduled-meta-daily"`, a daemon-seeded row), so it is defense-in-depth only. The un-forgeable boundary is `evolveEscalation`: the public `POST /api/agents` route calls `createAgent(body, cfg)` with **no third arg**, so a client request — even one that puts `evolveEscalation: true` in its JSON body — still hits the unconditional builder→403 `BUILDER_SPAWN_ORCHESTRATOR_ONLY`. Only the in-process scan hook calls `createAgent(builderInput, cfg, { evolveEscalation: true })`.

3. **Safety boundary is now the merge step.** The Builder halts at a green PR and never runs `gh pr merge` (verified: no `gh pr merge` mechanism existed in daemon/shared before this change — "never merges" preserves today's reality). This is made explicit and load-bearing: the escalation Builder's first-turn prompt mandates "Do NOT run `gh pr merge`; stop at a green PR; the human merges," and `builder.md`'s Workflow gains a matching hard rule for every Builder (especially an auto-spawned one with no orchestrator turn behind it).

4. **Two-way linkage, no DB migration.** The proposal gains a single nullable markdown field `builderAgent: string | null` (round-tripped through the file-backed store — proposals are markdown files, so no Drizzle migration). On a successful 201 the hook records `builderAgent: "builder-<id>"` on the proposal; the builder side carries the proposal id verbatim in `spawnReason` + `ticketId`. The branch is derivable as `friday/builder-<id>`; the PR URL arrives via the builder's mail. Recording `builderBranch` / `builderPrUrl` on the proposal is deferred (derivable / discoverable for v1).

5. **Default off, failure-isolated, idempotent.** The flag is read with `cfg.evolve?.autoSpawnBuilders === true` (shallow-merge-safe). Spawn failures are caught per-request AND for the whole block — they never alter the scan's returned summary nor throw out of the handler (logged as `evolve.builder.spawn` / `.skip` / `.error`). The in-process `createAgent` 409 dedups against an already-spawned `builder-<id>`, so a re-promote on a later scan re-uses the existing builder rather than spawning a duplicate (same mechanism ADR-033 relies on; FRI-147's fast-spin guard remains out of scope).

### Rejected alternative — mail-the-orchestrator

Evolve could instead mail the orchestrator "proposal X is critical+code; please spawn a builder," preserving ADR-022's gate verbatim with zero `spawn-permissions.ts` change. It is genuinely safer — it removes the entire forge surface (no carve-out, no `evolveEscalation` argument to mis-thread) — at the cost of one turn of latency and the human-in-the-spawn-loop this work exists to remove. Rejected per owner decision: the audited carve-out is the chosen mechanism, with mail-to-orchestrator as the safe degradation if the "separate argument, route passes nothing" threading could not be guaranteed (it is, and it is unit- and integration-tested, including a forge-resistance case proving the wire cannot reach the carve-out). A second alternative — loosen the gate to let any `scheduled` caller spawn builders — was rejected as too broad (any future scheduled agent would inherit builder-spawn rights) and forgeable.

### What this does NOT do

- **No auto-merge.** The Builder never merges; it stops at a green PR. The human merges.
- **No escalation for non-code proposals** (memory/prompt/config are filtered out).
- **No change to FRI-40 triage-helper behavior.** Both flags can be on; a critical proposal could trigger both a triage helper and an escalation builder.
- **No `builderBranch` / `builderPrUrl` proposal fields, no `PreToolUse gh pr merge` deny rule, no dashboard UI** (linkage data is persisted so a follow-up can render it).

### Bring this ADR back to the table if

- Auto-spawned builders reliably land a clean, human-rubber-stamped PR — that is the signal to consider widening the band (e.g. a score floor) or adding a one-click "open the green PR" affordance.
- The 409-dedup proves insufficient (e.g. builders archived and immediately re-spawned each scan) — promote FRI-147's fast-spin guard.
- A defense-in-depth `gh pr merge` PreToolUse deny rule is wanted for certainty beyond the prompt-level guard.

## ADR-037 — Trust gradient: daemon clean, workers get user shell, MCP children get a restricted allowlist (FRI-150)

**Status:** accepted

### Context

The MCP SDK's `StdioClientTransport` (`@modelcontextprotocol/sdk@1.29.0/dist/esm/client/stdio.js:8-24`) deliberately allowlists env vars at the spawn boundary — only `HOME / LOGNAME / PATH / SHELL / TERM / USER` from `process.env` reach MCP children. On a launchd-spawned daemon, that PATH is launchd's minimal floor, and a clean install (no brew-installed Node coexisting with fnm) can't resolve `node`/`npx` in any spawned MCP child.

Two earlier passes at the fix were either wrong-layer or right-direction-wrong-magnitude:

- **Closed PR #161** baked PATH into the launchd plist. The allowlist filter still strips everything else (FNM_DIR, NVM_DIR, asdf shims), so the fix only worked when the user's PATH happened to overlap with the daemon's hard-coded entries.
- **PR #162's first pass** captured the user's shell env at daemon boot, forwarded a JSON-serialized payload to every worker via `FRIDAY_RESOLVED_SHELL_ENV_JSON`, and threaded the full captured env into every per-stdio MCP `env`. Adversarial review surfaced a real BLOCKER (B1): `ensureFridayEnv()` mutated `process.env` with `BETTER_AUTH_SECRET` / `ZERO_AUTH_SECRET` / `LINEAR_API_KEY` / `ANTHROPIC_API_KEY` / etc., the daemon-side shell capture handed all of `process.env` to the spawned shell, and the captured payload then rode straight into every MCP child's `env` — making the shell-env pipeline a one-way exfiltration channel for daemon secrets.

The second pivot lands a trust gradient inspired by OpenCode's architectural model:

- **Agents** (Claude Code CLI) get the user's full interactive-login shell env, same as a terminal session would.
- **MCP children** get a documented, restricted allowlist of toolchain-relevant vars — not the full shell env.
- **Daemon process.env** holds no secrets. Daemon-private secrets live in an immutable `FridayEnvConfig` object loaded via `loadFridayConfig()`; callers read fields explicitly.

Note: OpenCode's actual `mcp/index.ts` spreads full `process.env` to spawned MCP children — `packages/opencode/src/mcp/index.ts:connectLocal`'s `env: { ...process.env, ...mcp.environment }` shape. They achieve safety by keeping their parent process.env relatively clean; we additionally enforce a per-MCP allowlist as defense-in-depth, since our parent's `process.env` is inherited from the user's launchd / login session and is broader than a single-purpose CLI's would be.

### Decision

**Per-worker capture + restricted MCP allowlist + dotenv refactor.**

The trust gradient, top to bottom:

```
~/.friday/.env         — closed config object, daemon-private secrets
                         loaded via loadFridayConfig() into an immutable object
process.env (daemon)   — NO secrets. Just operational + system vars
                         (PATH, FRIDAY_FNM_BIN, FRIDAY_DATA_DIR, …)
                         ↓ worker fork inherits this clean env tree
worker process         — runs $SHELL -ilc at startup to capture user shell env
                         (per-worker-process singleton, ~50-300ms one-time cost)
                         ↓ SDK's CLI subprocess receives worker's process.env verbatim
Claude Code CLI        — agent sees the captured user shell env (full)
                         ↓ agent's Bash tool inherits CLI's env
agent's Bash calls     — sees user shell env (full)
                         ↓ SDK's StdioClientTransport allowlist + per-server config.env
MCP children           — RESTRICTED: PATH + locale + toolchain hints + FRIDAY_APP_DIR + manifest env
                         (the `MCP_ENV_ALLOWLIST` in services/daemon/src/mcp/builder.ts)
```

### The allowlist

`MCP_ENV_ALLOWLIST` in `services/daemon/src/mcp/builder.ts`:

- **Process basics** (SDK allowlist superset): `PATH`, `HOME`, `USER`, `LOGNAME`, `TERM`, `TMPDIR`.
- **Locale**: `LANG`, `LC_ALL`, `LC_COLLATE`, `LC_CTYPE`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`.
- **Node / JS toolchain hints**: `NVM_DIR`, `FNM_DIR`, `FNM_MULTISHELL_PATH`, `PNPM_HOME`, `BUN_INSTALL`, `DENO_INSTALL`, `VOLTA_HOME`.
- **Python / Ruby / Rust / Go / Java / JVM / conda toolchain hints**: `PYENV_ROOT`, `ASDF_DATA_DIR`, `RBENV_ROOT`, `CARGO_HOME`, `RUSTUP_HOME`, `GOPATH`, `GOROOT`, `JAVA_HOME`, `M2_HOME`, `CONDA_PREFIX`, `SDKMAN_DIR`.
- **Search-path hints used by build tools**: `MANPATH`, `INFOPATH`, `PKG_CONFIG_PATH`.

**Criteria for additions:** the entry must be a documented toolchain or locale hint that a third-party MCP could legitimately need to find user-installed binaries / data, with no plausible secret value. Add to the set in `builder.ts` and document the rationale here. PR review fence: if a proposed addition contains values that are sensitive on any common system (auth tokens, session IDs, cookies, signing keys, URL-form connection strings, paths under `~/.ssh` or `~/.aws`), reject.

### The dotenv refactor

`ensureFridayEnv()` retired. Replaced by `loadFridayConfig(): FridayEnvConfig`:

- Creates `~/.friday/.env` on first call if missing.
- Auto-generates `BETTER_AUTH_SECRET` / `ZERO_AUTH_SECRET` / `ZERO_ADMIN_PASSWORD` if missing, appending each to disk.
- Parses via `dotenv.parse(readFileSync(ENV_PATH))` — does **not** mutate `process.env`.
- Returns a frozen object: `{ betterAuthSecret, zeroAuthSecret, zeroAdminPassword, databaseUrl, zeroUpstreamDb, zeroReplicaFile, linearApiKey, anthropicApiKey, cloudflareTunnelToken, posthogApiKey, posthogHost }`.
- Memoized per-process. `upsertEnvVar` + `clearFridayConfigCache` invalidate the cache when the file changes out-of-band (e.g. after `friday setup` writes new fields, or `friday restore` swaps in a backup).

The supervisor (`packages/cli/src/bin/supervisor.ts`) no longer pollutes its own `process.env` from the .env file. Children's env is constructed explicitly:

- **daemon**: clean `process.env` + `FRIDAY_LOG_STDOUT=off` + `FRIDAY_DAEMON_PORT`. Daemon calls `loadFridayConfig()` at boot for its own secret reads.
- **dashboard**: clean `process.env` + `PORT` + `FRIDAY_LOG_STDOUT=off`. Dashboard server code calls `loadFridayConfig()` for `betterAuthSecret`, `zeroAuthSecret`, `posthogApiKey`.
- **zero-cache**: explicit injection of `ZERO_UPSTREAM_DB`, `ZERO_AUTH_SECRET`, `ZERO_ADMIN_PASSWORD`, `ZERO_REPLICA_FILE` from `fridayEnv`. zero-cache is an external binary that can't call our loader; the supervisor hands it the four secrets it needs.

### Defense-in-depth: secret-shaped key filter at the capture layer

`services/daemon/src/shell-env.ts` still applies the B1 sanitize gate to both the env passed to the spawned shell (input gate) and the parsed JSON before caching (output gate). Even though the worker's `process.env` no longer carries daemon secrets, a user's `.zshrc` could legitimately `export GITHUB_TOKEN=…` or `export AWS_SECRET_ACCESS_KEY=…`, and those shouldn't reach MCP children either. The pattern matches `(SECRET|TOKEN|API_KEY|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|CREDENTIAL[S])$` plus an explicit list (`DATABASE_URL`, `ZERO_UPSTREAM_DB`).

The MCP allowlist filter sits on top of this — even if a user-shell secret somehow matches a denied-but-non-allowlisted key, it can't pass the allowlist gate.

### Performance

Per-worker shell capture adds ~50-300ms to every worker spawn on common zsh setups. Long-lived workers (orchestrator, builders, helpers, kitchen) amortize this over hours of turns. One-shot scheduled agents pay once per fork. 5s timeout with structured fallback (override via `FRIDAY_SHELL_ENV_TIMEOUT_MS`) prevents pathological zsh init from blocking the worker indefinitely.

### Consequences

- 26 production files migrated from `process.env.<SECRET>` to `loadFridayConfig().<field>`.
- 7 test files rewired from `process.env.X = "test"` patterns to mocking `loadFridayConfig` (per-file) or driving `~/.friday/.env` via `upsertEnvVar` + `clearFridayConfigCache` (when the test exercises a code path that itself reads via `loadFridayConfig`).
- `FRIDAY_RESOLVED_SHELL_ENV_JSON` env-var forwarding retired. F5 ARG_MAX guard from PR #162 also retired (no use site).
- The plist regression-fence (no PATH key in EnvironmentVariables) from PR #162 stays — both the TS renderer and `install.sh`'s bash twin.
- The B1 secret filter pattern stays as defense-in-depth.

### Rejected alternatives

- **Daemon-boot capture + worker-fork forwarding** (PR #162 first pass). Right intuition, wrong layer. The full-spread approach made the shell capture pipeline a one-way exfiltration of daemon secrets. Required B1 belt-and-suspenders filter just to be safe.
- **`process.env.PATH` mutation on the daemon for non-MCP subprocesses** (`gh`, `git`, `brew`). Daemon-side subprocesses don't currently need user-installed binaries; deferred to a follow-up if a future feature needs it.
- **Hot-recapture on user re-login.** v1 captures once per worker process. If the user changes their shell profile mid-session and wants Friday to pick it up without daemon restart, that's a separate ticket.

### Bring this ADR back to the table if

- A toolchain widely adopted by MCP authors uses an env hint not on the allowlist (e.g. NEW_HOT_LANG_HOME). Add to the set + update this ADR.
- An empirical case shows that worker-fork latency from shell capture is materially hurting user-visible response time. Consider a daemon-level cache with explicit invalidation, or a longer-lived per-worker cache.
- The dotenv refactor's per-caller migration leaves edge cases where a secret quietly slips back into `process.env`. Add a daemon-boot assertion: scan `process.env` for known-secret-shaped keys + fail loudly if present.

## ADR-038 — Age-encrypted secrets vault (integration vs machine-local split)

**Status:** accepted

### Context

ADR-037 keeps daemon `process.env` secret-free via `loadFridayConfig()`, but integration secrets still lived in plaintext `~/.friday/.env` — unsafe to commit to the operator's `~/.friday` git repo. Operators want ciphertext in git, unattended unlock on a trusted Mac (FileVault + auto-login + `.age-key` chmod 600), and two delivery modes: env injection for MCP/daemon consumers vs audited on-demand fetch for agent turns.

### Decision

**Age vault + reference-only substitution + in-process fetch MCP.**

- **On disk:** `secrets/vault.enc` (committed), `secrets/meta.yaml` (committed, no values), `secrets/recipients.txt`, `.age-key` (gitignored, 0600), `secrets/.generation` (gitignored, bumped on write for cache invalidation).
- **Machine-local tier** (`BETTER_AUTH_SECRET`, `ZERO_*`, `DATABASE_URL`, …) stays in gitignored `.env.local`.
- **Integration tier** lives in the vault (`mode: env`); **agent-fetched tier** is `mode: on-demand`.
- **`loadFridayConfig()`** overlays daemon-flagged vault entries onto typed fields (`LINEAR_API_KEY` → `linearApiKey`, etc.); workers/MCP never read `process.env` for substitution.
- **Reference-only env substitution:** only `${VAR}` references appearing in manifest/config MCP `env` values enter the substitution map — not all global secrets.
- **`friday-secrets` MCP** (`secrets_fetch`, `secrets_list`) runs in-process in the worker; caller identity comes from spawn options, not spoofable HTTP headers. Audit rows land in `secrets_fetch_log`. Rate limit: 10 MCP fetches/caller/hour.
- **PreToolUse denies** (all agent types) on Read/Write/Edit/Glob/Grep targeting `.age-key`, `secrets/vault.enc`, `secrets/meta.yaml`, `.daemon-secret`.
- **Trust model:** OS user account is the security boundary. Agents with filesystem/bash tools on orchestrator/helper/bare can still reach `~/.friday/` — vault security assumes a trusted macOS user, not agent isolation.

### Consequences

- `friday secrets` CLI: init, set/get/list/unset/edit, migrate-from-env, audit, unlock --check, public-key.
- Daemon watches `secrets/.generation` and reloads cache; health surfaces `secretsLocked`.
- Backup includes `secrets/` and `.env.local` by default; `.age-key` excluded unless `--include-age-key`.

### Rejected alternatives

- **HTTP loopback fetch with `x-friday-caller-*` headers** — spoofable; replaced by in-process MCP with trusted spawn identity.
- **Inject all global env-mode secrets at worker spawn** — over-broad; replaced by reference-only map.
- **1Password/exec provider (FRI-32)** — deferred.

## ADR-039 — Chat scrolls the document, not a fixed overlay

**Status:** accepted (FRI-160, 2026-06-09); **superseded for the chat route by ADR-041 (2026-06-10).** The document-scroll model below is correct everywhere it identifies a real hazard — keep reading it for the WebKit landmines (#153852/#240860 overflow-on-root, #238497 smooth-scroll) — but the chat route now uses a hard-body-locked inner scroller again, which is NOT the overlay this ADR fled (see ADR-041's "why this isn't a regression").

**Supersedes the overflow-toggle half of ADR-019 (§2); §1's element-anchor technique stands.**

### Context

The chat route was the one page in the dashboard that did not scroll the document: `ChatShell` rendered the transcript inside a `position: fixed; inset: 0; overflow-y: auto` overlay that was the page's sole scroller. Every other route lets the document/window scroll. On mobile WebKit (worst in the installed iOS PWA) the browser intermittently routed a touch to the **parent** of the fixed overlay and dragged/rubber-banded the whole page as a chunk instead of scrolling the chat — a scroll-routing fight between the overlay and the document that no amount of `touch-action` / `overscroll-behavior` tuning reliably won. Desktop was functionally fine, but Space/PageDown/Home/End never scrolled the chat: document keyboard scrolling doesn't reach a fixed overlay.

### Decision

The document/window is the single scroller on the chat route, exactly like every other route. Header, sidebar, and composer stay `position: fixed` — pinned bars layered over the document scroll, not competing scrollers. The transcript itself is an inert in-flow `.chat-transcript` element (renamed from the old overlay class) that keeps the ChatShell-scoped layout vars and padding but has no overflow of its own. All scroll reads go through `window.scrollY`, all writes through `window.scrollTo` / `window.scrollBy`, and the scroll/cancel listeners (`scroll` / `wheel` / `touchmove` / `keydown`) bind to `window`.

### Consequences

- The fixed-overlay artifact set is deleted: `position: fixed; inset: 0; overflow-y: auto`, `touch-action: pan-y`, and `overscroll-behavior: contain` are gone. Other document-scrolling pages never needed them; re-add only if top-bounce tap-misplacement resurfaces on-device.
- The three `overflow-y: hidden` paint-defer toggles (the ADR-019 §2 pattern) are deleted. The toggle cannot be re-homed onto `<html>`/`<body>` — `overflow: hidden` on the document root is silently ignored on iOS WebKit (WebKit #153852, #240860). Replaced with a double-`requestAnimationFrame` around the `window.scrollTo` / `window.scrollBy` write, which sidesteps overflow entirely. Programmatic follow writes never pass `behavior: "smooth"` (WebKit #238497 — smooth-behavior interplay makes scrollTo fail silently; the overflow half of that bug is gone, but the rule stands so the hazard can't come back).
- Entry scroll is now router territory: SvelteKit scroll-to-tops on navigation, and the chat route lands at the bottom itself via an `afterNavigate` + deferred `window.scrollTo` write that supersedes the router's pass two frames later. Deliberately **without** `disableScrollHandling()`: in kit 2.59 the router's scroll pass runs — and resets its autoscroll flag — _before_ `afterNavigate` callbacks fire, so calling it there can't affect the current navigation and instead disables the _next_ one (chat's deep scrollY leaked into the next page visited).
- Space / PageDown / Home / End now scroll the chat on desktop — the document scroller receives keyboard scrolling for free.

### Rejected alternatives

- **Fold the transcript padding into `.app-main.chat-route` and drop the element.** The six chat layout CSS vars are ChatShell-scoped with zero references elsewhere; folding up would force them global and split chat layout across two files.
- **Keep the fixed overlay and tune `touch-action` / `overscroll-behavior` harder.** That is exactly the artifact set being deleted; it doesn't fix the parent-routing fight.

### Do not "fix" this back

A future pass that notices "chat isn't a self-contained scroller anymore" and restores a nested or fixed overlay scroller **without also hard-locking the body** would reintroduce the mobile scroll-routing bug this ADR exists to kill. ADR-041 reintroduces an inner scroller deliberately and safely: the body is `overflow: hidden` on the chat route, so there is no document scroll left for a touch to fight over — the parent-routing condition this ADR documents cannot arise. The two ADRs are not in conflict; ADR-041's precondition (locked body) is exactly what ADR-039 lacked.

## ADR-040 — Soft-keyboard geometry: fixed chat bars anchor to the visual viewport's edges via one focus-gated tracker

**Status:** accepted (2026-06-10); **largely superseded the same day by ADR-041.** The inner-scroller (ADR-041) sizes a single fixed column to the visual viewport, so the composer is positioned by _layout_ and no longer chases the keyboard per-frame — the fixed-bar anchor machinery this ADR built (`--vv-top-y`, the composer `translateY` anchor, the settle probes, the windowed re-pin) is gone. What SURVIVES into ADR-041: the focus-gated tracker, the `keyboard-open` class, and `--vv-bottom-y = vv.offsetTop + vv.height` (now the column's height, written in every state). **Keep this ADR as the record of the hard-won iOS 26.5 facts below** — they still constrain ADR-041's column sizing.

### Context

ADR-039 made the document the chat scroller, with the header, agent dropdown, composer, and pills as `position: fixed` bars. `position: fixed` anchors to the **layout viewport**, and the iOS soft keyboard's interaction with the layout viewport is both regime-dependent and (on iOS 26.5) partially misreported. Five successive fix commits (#220, #222, #224, #228, #230) each patched one symptom with a different formula or listener set and regressed another; this ADR's model was then itself iterated four times against **on-device telemetry** (geometry snapshots posted through `/api/_diag/client-error`, cross-checked against the composer's measured `getBoundingClientRect` and a `?kbdebug` probe ladder photographed on the device).

Established facts (iOS 26.5 Safari, bottom URL bar):

- Keyboard open in a tab starts as an **overlay** (`innerHeight` full, `vv.height` shrinks, vv pans for the focused-field reveal), then on scroll iOS **shrinks** `innerHeight` to ≈ `vv.height` and parks the layout viewport at the focus-time scroll position; further scrolling pans the vv **beyond the layout viewport's bottom** (`offsetTop + vv.height > innerHeight`). That is real renderable geometry — fixed elements positioned past `innerHeight` paint there.
- **`vv.offsetTop` is the only honest pan source.** `vv.pageTop` mirrors `scrollY` and drops the pan (rect-verified in every captured sample). In the standalone PWA the layout viewport resizes and `offsetTop` stays ≈ 0.
- Platform escape hatches absent: no `interactive-widget` on iOS (WebKit #259770), no VirtualKeyboard API / `env(keyboard-inset-height)` (WebKit #230225), `dvh` is spec-blind to the keyboard, `position: sticky` is layout-viewport-anchored like fixed.

### Decision

One tracker (`$lib/util/keyboard-inset.ts`, dependency-injected, with stateful unit tests that replay the captured device telemetry as fixtures) owns all soft-keyboard geometry. Full model in `docs/mobile-ux.md`; the essence:

- **Presence is focus-derived, geometry is visualViewport-derived.** While a text-entry element is focused: `--vv-top-y = vv.offsetTop` (raw, unclamped) anchors the header and agent dropdown under the vv's top edge; `--vv-bottom-y = vv.offsetTop + vv.height` anchors the composer's bottom on the vv's bottom edge (`top:` + `translateY(-100%)`); `--kb-inset = max(0, innerHeight − vv.height)` (pan-free, scroll-stable) pads the transcript's scroll headroom. No field focused → vars cleared, zero keyboard JS influence.
- Re-measures on `vv.resize` + `vv.scroll` + `window.resize`, rAF-coalesced, change-guarded, with timed post-focus settle probes; no transitions on anchors (they smear corrections into visible sliding). The tracker also owns the `keyboard-open` class (zeroes `--kb-safe-bottom`) and the WebKit #297779 post-dismissal wiggle. ChatShell's bottom re-pin is windowed to 1.6s after focus so regime-flip resize events mid-scroll can't yank the viewport.

### Consequences

- Header, dropdown, and composer stay on-screen and keyboard-adjacent through keyboard-up scrolling in both Safari-tab regimes, the standalone PWA, and Android; the unit suite replays each captured device state.
- **Accepted platform ceiling (Safari tab):** in the parked first-tap state, iOS's claimed `vv.height` under-reports the truly visible area by an unexposed chrome allowance (~100–200px; CSSWG #7475). The composer sits exactly at the claimed boundary, which can leave a visible gap above the keyboard chrome. Photographically verified to be iOS's claim, not our math; no magic-constant compensation (it would rot with every iOS point release). The standalone PWA — the primary mobile mode — is unaffected.
- `?kbdebug` (HUD + probe ladder) is kept as a documented diagnostic; dev builds also post geometry snapshots to the dashboard JSONL. When WebKit ships `interactive-widget` (#259770) or fixes its viewport reporting, the tracker degrades gracefully and becomes deletable.

### Rejected alternatives

- **One-shot measurement on `focusin`** (the #230 state): reads pre-keyboard geometry; structurally wrong in every regime.
- **Pan from `pageTop − scrollY`** ("by definition" equal to offsetTop): pageTop drops the pan on iOS 26.5; froze the anchors. Rect-verification decided this, not spec text.
- **Clamping the pan to `innerHeight − vv.height`:** the shrunk regime's beyond-the-layout pan is real; clamping threw every bar off the top of the screen.
- **Sticky/monotonic padding inset:** held overlay-sized padding into the shrunk regime, rendering as an ever-growing blank band that eventually filled the screen.
- **Dismissing the keyboard on scroll:** rejected outright — scrolling up to read while composing is the core chat gesture.
- **`position: sticky` composer; counter-translate-on-every-frame without focus gating; inner-scroller app shell:** the first two fail as documented above; the app shell (how every major chat product avoids this class entirely) remains the documented fallback if the Safari-tab ceiling proves unacceptable in practice — it would reopen ADR-039 deliberately.

## ADR-041 — Chat route uses a body-locked inner scroller; composer positioned by layout, not keyboard-chasing

**Status:** accepted (2026-06-10). **Supersedes ADR-039 for the chat route and the fixed-bar half of ADR-040.**

### Context

ADR-039's document-scroll model and ADR-040's fixed-bar keyboard tracker hit a platform ceiling: with the chat bars `position: fixed` against the layout viewport and the keyboard moving the _visual_ viewport, the composer could only track the keyboard via per-frame JS, which lags the scroll thread during momentum scroll. The result was a composer that visibly **stuttered** while scrolling with the keyboard up — and no web API lets a fixed element follow the iOS visual viewport without that lag (CSSWG #7475 is open precisely for this). Every major mobile-web chat product (ChatGPT, Claude, Discord) avoids the entire class by NOT scrolling the document: a viewport-height app shell with an inner scroller and the composer in normal flow. ADR-040 named that app shell as the documented fallback "if the Safari-tab ceiling proves unacceptable." It did.

The reason ADR-039 fled the inner/overlay scroller was a mobile-WebKit touch-routing fight: a touch on a `position: fixed; inset: 0` overlay intermittently routed to the **document** behind it and dragged the whole page as a chunk. The crucial detail: that fight requires a scrollable document to fight _over_.

### Decision

The chat route is a `position: fixed` flex-less column (`.chat-viewport`) sized to the visual viewport, **and the document body is hard-locked** (`html.chat-scroll-lock { overflow: hidden; height: 100% }`, toggled by ChatShell on mount). Inside the column:

- `.chat-transcript` is the inner scroller (`position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain`), full-bleed under the translucent header and composer. Its `padding-top`/`padding-bottom` reserve the header and composer bands so content **rests in the clear but scrolls under** them (the glassmorphism design element is preserved).
- The composer and floating pills are absolutely-positioned overlays within the column.
- The column height is `var(--vv-bottom-y)` (= `vv.offsetTop + vv.height`, written by the ADR-040 tracker in **every** state, not just while focused). Keyboard up → the column shrinks and the composer re-lays-out above the keyboard; keyboard down → it sizes above the iOS bottom URL bar. **No per-frame chasing**, so no stutter — the composer moves only when the viewport actually resizes.

The scroll seam is element-based again: `doc-scroll.ts` routes reads/writes through a settable scroller (`setChatScroller`, window fallback); `ChatMessages` takes a `scrollRoot` for its IntersectionObserver roots; the resync chase uses `makeElementChaseTarget`; anchor-restore measures against the scroller top and listens on the element.

### Why this is NOT an ADR-039 regression

ADR-039's bug needs a scrollable document behind the inner scroller. Here the body is `overflow: hidden` and pinned to the viewport — there is **nothing behind the scroller for a touch to route to or rubber-band**. On-device (iPhone, iOS 26.5 Safari) the scroll was confirmed rock-solid with no chunk-drag; the AC6 e2e pins the invariant (`window.scrollY === 0` and `html` overflow hidden while the transcript scrolls). The trade-off the body-lock buys back: the iOS URL bar no longer auto-collapses on the chat route (no document scroll to collapse it) — standard for the app-shell pattern and accepted.

### Consequences

- Keyboard-up composer stutter is eliminated (verified on-device); the composer is correct keyboard-up AND keyboard-down (clears the URL bar) because the column tracks the visual viewport in all states.
- Desktop Space/PageDown/Home/End scroll the transcript when it (or a descendant) has focus — the inner scroller receives keyboard scrolling; this is a minor regression vs ADR-039's free document keyboard scrolling, mitigated because the transcript is focusable via tab/click.
- `?kbdebug` HUD + dev-only geometry telemetry are retained as the diagnostic for post-release PWA verification (the standalone PWA can't be tested over the insecure-HTTP LAN dev origin).
- A secure-context-safe `randomUUID()` helper (`$lib/util/uuid.ts`) replaces direct `crypto.randomUUID()` — the latter is undefined on insecure origins (LAN-IP dev over HTTP), which threw in the send path during on-device testing. Prod (HTTPS) was unaffected.

### Rejected alternatives

- **Stay on document scroll (ADR-039/040) and tune the keyboard tracker further:** the stutter is the structural ceiling of fixed-bars-on-the-layout-viewport; no further tuning removes the scroll-thread lag.
- **Inner scroller WITHOUT body-lock:** reopens the exact ADR-039 touch-routing fight.
- **Dismiss the keyboard on scroll** (an early spike): rejected outright — scrolling up to read while composing is the core chat gesture.

## ADR-042 — `friday start` reconciles the Cloudflare tunnel to a serve-intent flag; restore stages dark (split-brain guard)

**Status:** accepted (2026-06-11). FRI-166.

Before this, the cloudflared launch agent was managed **imperatively**: `friday setup --cloudflare` ran `cloudflared service install <TOKEN>` once and nothing ever reconciled it. Config/vault state and on-disk launchd reality drifted both directions — a `friday restore` of a tunnel-enabled config left the public URL **dead** until the user re-ran setup (DR broken), and a removed/rotated token left a stale agent serving. The cloudflared plist lives outside `~/.friday`, so even a `--full` backup can't carry it.

**Decision.** `friday start` now reconciles the cloudflared agent **declaratively** every launch, keyed on an explicit **serve-intent** (`config.json` `tunnel.serve`) **AND** token presence in the vault — deliberately NOT bare token presence:

- serve-intent on + token → ensure the agent is installed and running (from the vault token, no re-prompt).
- serve-intent off / no token → ensure it's stopped and removed.

The decision is a pure function (`decideTunnelAction`, exhaustively unit-tested); the effectful wrapper (`reconcileTunnel`) wires it to `cloudflared`/`launchctl` (`packages/cli/src/lib/cloudflared.ts`). Idempotent: an already-serving tunnel on the current token is a no-op — the installed token's SHA-256 is fingerprinted under `~/.friday/state/cloudflared-token.sha256` so only a **rotated** token forces a reinstall, never a gratuitous bounce on every `start`.

**Why serve-intent is separate from the token (the split-brain guard).** A `--full` migration restore stages the SOURCE machine's _live_ tunnel token into the TARGET's vault (decryptable via `--include-age-key`). If reconcile keyed on token presence, `friday start` on the staged box would bring up a **second connector on the same public hostname** while prod is still serving — split-brain. So `friday restore` **forces `tunnel.serve` off** and reconciles the agent dark regardless of what the bundle's config said, and prints the cutover instructions. `decideTunnelAction` guarantees serve-intent off can _never_ yield install/reinstall across the entire state space (a dedicated test pins this). Cutover is one deliberate flip after the source tunnel is stopped: `friday tunnel up` (or `friday setup --cloudflare`).

**Operator surface.** `friday tunnel up|down|status` is the explicit serve-intent lever (no token re-prompt); `friday setup --cloudflare` also sets serve-intent on. `friday status` distinguishes `up` / `staged` (token present, intent off — a restored box) / `down`.

**Consequences.** DR works: restore-then-start on the _same_ machine relights the tunnel automatically (serve-intent restored from its own config). The cloudflared plist still lives outside `~/.friday` and is still not in the bundle — but it no longer needs to be, because reconcile rebuilds it from the vault token on the next `start`. The earlier doc claim that "`friday start`/`stop` no longer touch cloudflared" is retired (`stop` still leaves the agent's self-supervising job alone; `start` reconciles it).

**Rejected:** _reconcile on bare token presence_ (auto-serves a staged box → split-brain); _carry the cloudflared plist in the bundle_ (machine-specific paths, still wouldn't gate split-brain); _restore preserves the bundle's `tunnel.serve: true`_ (DR-automatic on a different box, but unsafe — a test restore could relight prod's hostname). Safety won: restore always stages dark, DR is one explicit `friday tunnel up` away.

## ADR-043 — Habits are a core concept, not a Friday App; streak is derived on read, bounded status is reconciled

**Status:** accepted (2026-06-18). FRI-169.

Friday Apps (kitchen, reading-friend) are the established pattern for domain features: a manifest + an app-owned MCP server + a scheduled sustainer + JSON state under `~/.friday/apps/<id>/`, with zero core changes (ADR-021, FRI-72). The habit/streak tracker was the obvious next app — and FRI-72's recommendation literally named "a habit tracker" as the forcing function to revisit whether core primitives are warranted. We grilled app-vs-core and chose **core**.

**Decision.** Habits ship as a **core** feature: two core tables (`habits`, `habit_checkins`), a core `friday-habit` MCP server registered for **all** caller types, and a core dashboard surface (a Today card on `/dashboard` + a `/habits` route over Zero-replicated tables).

**Why core, not an app (two determinants, each verified against the code).**

1. **Cross-app reach.** An app-owned MCP server is wired only to that app's own agents via `appContext.mcpServers` (`builder.ts:250`, gated on `if (opts.appContext)`); the orchestrator never has an `appContext`. Only servers registered **unconditionally** in `builder.ts` reach every caller — exactly how `friday-reminder` does it (`builder.ts:151-156`, no `callerType` gate). The whole point of habits is that _any_ app or agent can check a habit off (kitchen ticks "cooked dinner", a workout app ticks "exercise"), which is unsatisfiable by an app-scoped MCP. `friday-habit` is therefore a core all-caller server.
2. **First-class UI.** There is no app→dashboard-UI exposure mechanism (FRI-72 enumerates external-endpoint, state-ownership, config, and recall gaps — none is "an app injects a dashboard route"). Every dashboard surface reads a Zero-replicated **core** table. A first-class habits UI demands a core table + core route; building app-UI-exposure first would be a far larger, unspecced platform project.

**Streak is a derived projection, not stored state.** A **Streak** is computed on read from the append-only `habit_checkins` log against the habit's Target/Period and the current clock — never a stored column. It is _time-dependent_: a streak breaks at the instant an unsatisfied Period **closes** (a clock boundary, with no write event), so a cached integer would be silently wrong the morning after a Period rolls. The pure engine (`@friday/shared/habits` `computeStreak`) takes `now` as a parameter and is consumed identically by the daemon (injecting `now` at the API boundary) and the browser (a single adapter mapping the snake_case Zero row + epoch-millis → `Date`). This mirrors the **Turn state vs Status projection** relationship already in the glossary: the log is canonical, the streak is a view of it.

**The one place the clock-boundary rule needs a writer: bounded archival.** A **Bounded** habit (fixed window) must _archive_ as `completed` (streak intact at close) or `expired` (broken) when its window closes — but "the window closed" is a clock event with no user action, so nothing would ever persist it. Rather than make the UI read a computed `terminal` (which would split the lifecycle between a stored `status` and a derived flag — the exact split-brain the streak/status distinction warns against), the daemon **reconciles** it: `reconcileBoundedHabits` flips `active` bounded habits whose window has passed to `completed`/`expired` (the verdict taken straight from the engine's `terminal`, not reinvented), run on **boot** (catches windows that closed while down) and on a periodic **interval** (the habits analogue of the scheduler's 30s tick). `status` stays the single canonical lifecycle field, so the existing status-based filters/badges on `/habits` light up with no on-read special-casing.

**Reminders stay decoupled.** A reminder _about_ a habit is a separate `kind='reminder'` schedule (FRI-168) the user/orchestrator creates independently; habits own no `schedules` rows and add no new `schedules.kind`. Habits compose with reminders; they do not embed them.

**Consequences.** The first core feature to deliberately break the apps-are-user-data default (ADR-021) — justified by cross-app reach + first-class UI, neither of which an app can provide today. If an app-UI-exposure and a cross-app-MCP-sharing mechanism are ever built, the determinants weaken and a future domain feature like this could go back to being an app. The compute-on-read streak has a known O(habits × check-ins) read cost (FRI-169 §7) deferred until it measurably bites; the text-uuid PKs on both tables (matching `blocks`/`ticket_comments`) keep the Zero-mutator write path open and leave habit-CRUD-via-mutator reversible without a migration.

**Rejected:** _build it as an app_ (the proven, lean path — but cannot reach other apps' agents nor render a dashboard route); _overload `schedules` with a `habit` kind_ (a habit doesn't fire on a clock and still needs a separate check-in table — pays the overload cost without avoiding the second table); _store the streak as a column_ (a denormalized lie the instant a Period closes without a recompute trigger); _render bounded `terminal` only in the UI_ (splits the lifecycle across a stored status and a derived flag, and leaves non-UI consumers — MCP `habit_list`, future integrations — seeing a closed habit as `active`).

## ADR-044 — Dependency provisioning + preflight live on the boot/start path, not the update path

**Status:** accepted (2026-06-18).

**Context.** FRI-24 added pgvector as a hard runtime dependency: migration `0036` adds an `embedding vector(384)` column, which needs the `vector` extension, which needs the pgvector Homebrew formula. FRI-24 wired provisioning (`ensureBrewDeps` → `brew install pgvector`, `ensureVectorExtension` → `CREATE EXTENSION vector`) into `friday update`. But a production box that updated **1.24.0 → 1.26.0** still crash-looped at boot with `type "vector" does not exist`, and the dashboard couldn't reconnect.

**Root cause — the self-referential update gap.** `friday update` runs the **outgoing** version's update command, then flips `current` to the new version. So provisioning added in release N can **never** run on the hop _into_ N — only on the _next_ hop (N → N+1). The first box crossing into the pgvector-introducing release got the dependent schema with zero provisioning. No change to `update.ts` can fix this class, because the outgoing version's code is what runs.

**The lever.** The launchd plist runs `…/current/bin/friday-supervisor` — the **`current` symlink** — so after any flip the supervisor (and the daemon it spawns) are **always the new version's code**, regardless of which version's `update` initiated the flip. The durable safety net therefore belongs on the **boot/start path**, not the update path.

**Decision — three pieces, one read-only checker.**

1. **`checkDeps()`** (`packages/cli/src/lib/deps.ts`) is a **read-only** dependency report (`{ ok, hard[], soft[] }`) built on `probePostgresHealth` (reachable / role / database / `wal_level=logical`) + `hasVectorExtension` + a single launchd-safe `brew list pgvector`. It NEVER installs anything, so it's safe on the boot path. `friday doctor` and the gates all read from it.
2. **Supervisor preflight gate** (`bin/supervisor.ts`): before spawning **any** child, run `checkDeps()`. On a hard-missing dep, the supervisor refuses to bring up the stack (**whole-stack park** — not a per-child crash-loop + cascade-stop), writes a blocked-state file under `~/.friday/state/` that `friday status` surfaces, and stays alive re-checking every 15 s so the stack self-heals once the dep appears. This is the piece that fixes the introducing-hop and any already-bricked box, because it's always new code. `friday start` runs the same check for a fast interactive remedy before bootstrapping; `friday restart` / launchd `RunAtLoad` are covered by the supervisor gate (they don't pass through `start.ts`).
3. **`friday provision`** (`commands/provision.ts`) is the interactive **actuator** (`ensureBrewDeps` + `ensureVectorExtension` + fail-open model warm). `friday update`, after flipping `current`, **execs the new version's `friday provision`** (`current/.../index.js provision`) rather than provisioning in-process — so every update self-provisions whatever deps that release introduced. On provision failure the update rolls the flip back and does not restart. **Installs never happen on the launchd boot path** — only in `friday provision` / `friday update`.

**Why the extension can't self-heal inside the daemon.** Daemon boot runs migrations as the non-superuser `friday` role; pgvector is untrusted, so `CREATE EXTENSION vector` requires SUPERUSER. The extension must be created out-of-band via an admin (OS-superuser) connection — which is what `ensureVectorExtension` / `friday provision` do, and why it can't live in migration 0036.

**Consequences.** A missing hard dep now produces a clean halt with an exact remedy (`friday provision`), visible in `friday status`, instead of a silent crash-loop. The brew/extension TUI moved out of `update.ts`'s narration into `friday provision`. `checkDeps` deliberately brew-checks only pgvector (the one boot-bricking, here-detectable dep) to keep the start/boot path fast — `friday doctor` still reports the full dependency set.

**Rejected:** _`CREATE EXTENSION` inside migration 0036_ (the migration role isn't superuser); _daemon-boot self-heal as the daemon_ (same superuser problem; also can't `brew install`); _per-child "blocked daemon" state with the other children up_ (a half-up stack whose every mutator 502s is more confusing than a clean whole-stack park); _auto-`brew install` from the supervisor_ (a multi-minute, network-bound, non-interactive step on the launchd boot path).

## ADR-045 — The Zero replication publication is reconciled on daemon boot, not only in `friday setup`

**Status:** accepted (2026-06-19).

**Context.** Zero replicates a **narrow** Postgres publication, `friday_pub` — an explicit `FOR TABLE` list (`SYNC_TABLES` in `pg-provision.ts`), not `FOR ALL TABLES` (ADR-023 narrowed it to keep high-frequency `usage`/`db_meta` churn out of Zero). Whenever a release adds a Zero-replicated table, that table must be (a) added to `SYNC_TABLES`, (b) created by a migration, **and** (c) added to the live `friday_pub` publication. Step (c) only ever ran inside `provisionPostgres()`, which only ever ran from `friday setup`.

**The failure.** FRI-169 (1.28.0) shipped `habits` / `habit_checkins` as the first Zero-replicated tables added **after** the curl-install / `friday update` deploy pivot (FRI-146, 2026-06-02). A box upgraded via `friday update` runs migrations on daemon boot — so the tables existed — but `update` never runs `friday setup`, so `friday_pub` was never reconciled and stayed at the old 17-table set. zero-cache replicated 17 tables; the 1.28.0 client bundle's Zero schema knew 19. `checkClientSchema` rejected every client with `SchemaVersionNotSupported`, and the dashboard's schema-mismatch guard (`+layout.svelte`) reloaded the page on each rejection → an **infinite reload loop** on every client (page + tunnel healthy; only live sync broken). The same class bit once before — `313028c` added `evolve_proposals` to fix the identical loop — but every prior addition predated the pivot and was carried into the publication by a `friday setup` re-run, so it never recurred until an update-only deploy shipped a new replicated table.

**The lever (same as ADR-044).** The launchd plist runs `current/.../friday-supervisor`, so after a flip the daemon is **always the new version's code**. Migrations already run on daemon boot, after the flip, as the durable place for "bring the schema to head regardless of which version's `update` initiated the flip." The publication is part of that schema surface, so its reconcile belongs in the same place.

**Decision.** Factor the publication-reconcile body out of `ensurePublication` into an exported, idempotent `reconcileSyncPublication()` (create-if-missing / narrow-a-legacy-`FOR ALL TABLES` / `ALTER … ADD|DROP` to align). Call it on **daemon boot, immediately after `runMigrations()`** (`services/daemon/src/index.ts`) — the tables exist by then, so the existence filter sees them. `friday setup` still calls the same function via `provisionPostgres()`; the two paths now share one implementation. The daemon runs as the OS user (the Homebrew-PG superuser), so the same admin-in-friday peer-auth connection the function already used is available at boot — no secret, no new credential. The call is **best-effort**: a failure logs `publication.reconcile.error` and continues (degrading to the prior "new table not synced, recover via `friday setup`" behavior), never crashing boot.

**Why this completes the upgrade.** Once the new table lands in `friday_pub`, zero-cache's `autoReset` (Zero default `true`) detects the replicated-table-set change, wipes its replica, and re-COPYs from Postgres — so `friday update` / `restart` / `start` all bring sync fully current with no manual `ALTER PUBLICATION` and no replica wipe. (The live 1.28.0 box was recovered by hand with exactly that `ALTER PUBLICATION friday_pub ADD TABLE habits, habit_checkins` + a zero-replica reset; this ADR makes it automatic.)

**Rejected:** _reconcile in `friday provision` / `friday update`_ (runs **before** the restart, so the migration hasn't created the table yet — the existence filter would skip it; wrong ordering); _reconcile in the supervisor's pre-zero-cache hook_ (the supervisor doesn't wait for daemon-ready, so it races migrations); _keep it setup-only and document "re-run `friday setup` after adding a table"_ (the gap is exactly that a human/`friday update` won't, as FRI-169 proved); _make the daemon role own the publication so it needs no admin connection_ (the OS-superuser peer-auth connection already works at boot and keeps the slot-preserving ownership model from ADR-023).

## ADR-046 — Memory dreaming: nightly transcript→memory consolidation is a sub-pass of `scheduled-meta-daily`, not a new agent

**Status:** accepted (FRI-26, building on FRI-141; 2026-06-21).

**Context.** The orchestrator saves memories opportunistically mid-conversation via `memory_save`, but a great deal of memory-worthy material — corrections that recurred, a stable preference, a fact about a person, a reference Friday looked up twice — never gets written because the moment to write it passed. "Memory dreaming" is the consolidation pass that re-reads the day's orchestrator transcripts and proposes the memories that should have been written, then auto-applies the confident ones and surfaces the rest for review. The evolve pipeline already owns the machinery this needs (scanners → `proposeFromSignals` → `scoreProposal`/`rerankAll` → `applyProposal`, all with signal-hash dedup and a daily meta-agent), so dreaming is built **on** evolve rather than as a parallel system.

**Decision — dreaming is a sub-pass, not a new scheduled agent.** A new Haiku scanner, `scan-dreaming.ts` (mirroring `scan-preferences.ts`), runs inside the existing `/api/evolve/scan` endpoint, gated by an `includeDreaming` flag (default true) that the `scheduled-meta-daily` meta-agent passes in its nightly `evolve_scan` call. It reads the day's orchestrator turns via `collectOrchestratorTurns` (the `blocks` table is canonical — no JSONL walker, ADR-016/ADR-023), is shown the existing memory corpus inline so it can skip already-covered facts, and emits one signal per **candidate memory** across the five Memory-protocol categories (`user`, `feedback`, `project`, `reference`, `person`). **No new `schedules` row, no new scheduled agent** — dreaming is daily-only, riding the agent that already runs the daily meta pass. (Parallels ADR-033: evolve sub-behaviors hang off the daily scan, not off new agents.)

**Only the nightly meta-agent runs full dreaming; the manual dashboard scan is signal-only.** The `includeDreaming` flag defaults to true at the daemon endpoint (the meta-agent's path), but the dashboard's manual "Scan" button (`services/dashboard/src/routes/api/evolve/scan/+server.ts`) defaults it to **false** when the caller omits it. The manual button is a fast, signal-only triage tool; the LLM-backed dreaming sub-pass (which costs tokens and auto-writes memories) should fire only on the scheduled nightly run, never as a surprise side effect of clicking Scan. A caller that explicitly passes `includeDreaming: true` still gets it.

**The scan window advances via a `lastDreamScannedTs` cursor, with dedup as the safety net.** `scheduled-meta-daily`'s existing `state.md` records `lastDreamScannedTs` (agent-written; no code parser, no new cursor file); the meta-agent reads it back and passes it as `sinceTs` on the next `evolve_scan` call. The endpoint computes `dreamSince = body.sinceTs ?? since` and forwards it as `scanDreaming`'s `since`, so each night re-scans only transcript turns newer than the last dream pass (`sinceTs` overrides the `windowHours`-derived window for dreaming only — the friction/preference scanners keep the regular window). The cursor is a cost optimization, not a correctness boundary: a too-wide or overlapping window is harmless because propose-merge signal-hash dedup collapses re-seen candidates into the same proposal family and the apply-time `searchMemories` dedup extends an existing memory rather than duplicating it.

**Decision A — archive by tag, not by status; recall excludes `archived`.** The hygiene pass marks a pruned or absorbed entry by adding an `archived` tag via `updateEntry` — **never** by hard-delete and **never** by a new `status` value (`'archived'` is deliberately NOT added to the `memory_entries_status_check` CHECK, so this ships with **no migration**). Because `searchMemories` has no status awareness and only honors caller-supplied `excludeTags`, the daemon's passive-recall hook is changed to pass `excludeTags: ['person', 'archived']` (merging the new exclusion with FRI-141's `person` passive-recall carve-out — dropping `person` would reintroduce a PII leak). Tag-based archive plus the recall exclude is the complete suppression mechanism; promoting `archived` to a real status is deferred until a trigger demands it. **Rejected:** hard-delete (violates preserve-over-delete, Constitution §1) and a status-column migration (unnecessary for v1; tag suffices).

**Decision B — the proposed-memory payload rides an `EvidencePointer`; the `Signal` type is NOT widened.** Dreaming needs to carry an LLM-authored `{title, content, tags, category}` payload from the scanner to the apply path because dream proposals auto-apply **without** the usual `evolve_enrich` round-trip that normally fills a templated stub. Rather than add fields to `Signal`/`EvidencePointer`, the payload is JSON-encoded into the `path` of the signal's first `EvidencePointer` (`kind: "dream"`, `path: "dream:payload:<json>"`), and `decodeDreamPayload(signal) !== null` is the canonical "is this a dream signal" test. `draftFromSignal` gains a dream branch that decodes the payload and produces the real `type:"memory"` proposal directly. Recall-frequency and friction co-occurrence evidence (e.g. a co-occurring `watchdog.stall.detected`) ride additional human-readable `EvidencePointer.path` notes (capped at 3, after the exempt payload pointer). Friction co-occurrence is matched against the **configured orchestrator name** (`cfg.orchestratorName`, default `"friday"`), not the literal string `"orchestrator"`: `daemon.jsonl` friction signals carry the agent's real name, so the endpoint threads `orchestratorName` into the `DreamEvidence` and a friction note is attached only for daemon signals whose `agent` equals that configured name. Agentless daemon signals (`db.checkpoint.error`, `daemon.fatal`) are deliberately NOT attached, to avoid over-attributing unrelated daemon errors to every candidate. (The dream signal's own attribution stays `"orchestrator"`, matching the scan-preferences convention — only the friction _matching_ uses the real name.) The new value `"dream"` is added to the `SignalSource` union; `EvidencePointer.kind` is typed `SignalSource`, so no shape change is needed. **Rejected:** widening `Signal` with `kind`/`detail`/`notes` (the evidence-pointer array already exists for exactly this).

**Decision C — per-category auto-apply thresholds; `person` is gated highest at 80 (review-gate).** A dream proposal auto-applies only when its reranked `score` clears a per-category bar: `feedback: 60, user: 55, project: 50, reference: 45, person: 80` (`CATEGORY_AUTOAPPLY_THRESHOLD` in `dreaming-thresholds.ts`). These gate **auto-write only** — they do not touch the underlying `scoreProposal`/`isCritical` math (the OpenClaw trio in `rank.ts` is untouched). `person` sits highest because it is PII and feeds FRI-141's passive-recall exclusion semantics: a `person` candidate scoring `< 80` stays an **`open` proposal** that bubbles up for human review via `evolve_list` / the dashboard `/evolve` surface, and is never auto-written. Below-threshold proposals in every category likewise stay `open`. **Rejected:** blind auto-promotion of `person` (the high bar is the whole point).

**Memory hygiene (anti-rot pass).** After promotion, `runHygiene(listEntries())` runs corpus-wide: it merges near-duplicates (reusing `searchMemories` similarity; survivor is the higher-`recallCount` entry, the absorbed entry's content/tags fold in via `updateEntry` and it gains the `archived` tag — survivor's `recallCount`/`lastRecalledAt` are preserved by omitting them from the patch) and flags cold entries (low recall, stale/`null` `lastRecalledAt`, past a grace window) as decay candidates. Hygiene is strictly **preserve-over-delete**: it never calls `forgetEntry` (a static source assertion enforces that `scan-dreaming.ts`, `hygiene.ts`, and `dreaming-pipeline.ts` never reference it). All pruning is `updateEntry` tag additions.

**Dream Diary (flat-file journal).** Each dream run appends one timestamped markdown block — counts (`promoted` / `merged` / `pruned-flagged` / `reinforced`) plus a per-item `action | title | score | evidence` table — to a flat append-only file at `DREAM_DIARY_PATH` (`~/.friday/evolve/dream-diary.md`, a new `@friday/shared` constant under the already-ensured `EVOLVE_DIR`). v1 is a flat file by design; a PG-backed diary table + a dashboard Dream tab are deferred. The diary is the human-readable audit trail of what dreaming did each night.

**Why this completes the loop.** Memory that was previously written only when the orchestrator happened to think of it now also gets consolidated nightly from the transcript itself, with confident facts auto-applied, dedup-extended rather than duplicated on re-runs, PII review-gated, the corpus kept from rotting, and every action journaled — all without a new agent, a new schema migration, or a widened core type.

## ADR-047 — Capture is a stateless classify-and-route intake, not a queue funnelled through the orchestrator

**Status:** accepted (2026-06-21).

**Context.** Seth wants to fire a thought at Friday from anywhere — an Apple Watch Shortcut, a phone quick-add box, eventually voice — and have it _land somewhere sensible_ without opening the chat, waiting for a turn, or burning orchestrator tokens. A Capture is a single piece of raw text plus a Source tag (`watch`, `quick_add`, …). The naïve design routes every Capture into the orchestrator's chat as a message and lets Friday decide what to do with it on her next turn. That couples a 5-second "remind me Friday" to a full Opus turn, serializes captures behind whatever the orchestrator is doing, and makes the cheapest, highest-frequency interaction the most expensive one.

**The lever.** Almost every Capture maps to an action Friday already has a primitive for — set a reminder, check in a habit, save a memory, file a ticket, or hand it to an agent. The decision of _which_ primitive and _whether to act now or stage for approval_ is a single, stateless, model-shaped classification: it needs no conversation history, no tools, and no expensive model. So the routing is its own tier, not a special case of the chat.

**Decision.** Capture is a **stateless intake router**: a single-turn classifier produces an Intake verdict, then a **terminal executor** runs (or stages) the action — the orchestrator is just _one_ Route target reached by mail (ADR-017), never the funnel. Concretely:

- **Public surface.** A new key-gated `POST /api/capture` on the dashboard is the only new public route (the Watch Shortcut / quick-add hits it). It verifies a **Capture key** (no session), then proxies the body to the daemon's loopback `POST /api/intake` with `x-friday-daemon-secret`. The daemon is never exposed through the tunnel; the dashboard stays the sole public process (the topology invariant from `README.md` holds).
- **The classifier** is the EXISTING Claude Agent SDK `query()` — single-turn (`maxTurns: 1`), `tools: []`, no MCP, no resume, thinking off, on the cheap **`claude-haiku-4-5-20251001`**. No new SDK dependency (`@anthropic-ai/sdk` is NOT added). It emits a strict-JSON `IntakeVerdict { cleaned, targetId, payload, disposition, rationale }`; the daemon JSON-parses + zod-validates it.
- **The Intake persona is code-owned**, NOT the ADR-005 SOUL/CONSTITUTION stack: a terse `INTAKE_PERSONA_PROMPT` constant (clean faithfully / route only when confident / fall to Unsorted / strict-JSON contract), appended to the `claude_code` preset. It deliberately carries no SOUL or CONSTITUTION markers — the router is not Friday-the-orchestrator, it's a disposable single-turn judgment.
- **The routing-target registry is assembled at call time**: the four core targets (`core:reminder`, `core:habit`, `core:memory`, `core:ticket`) baked in code with their `guidance` prose + zod `payloadSchema` + executor over the existing primitive, PLUS one `agent:<name>` mail target per installed app's `intakeRoutes[]`, PLUS the orchestrator as the catch-all `agent:<orchestratorName>`. Each target's guidance is injected into the persona prompt.
- **Two gates decide the disposition.** Gate 1: `targetId === null` ⇒ write an **Unsorted** Inbox item, no executor. Gate 2: `disposition === "act"` AND the payload validates against the target's `payloadSchema` AND the executor succeeds ⇒ run it now and write a **Done** item carrying the result reference (undoable flag + inverse label + deep link); otherwise (`propose`, payload-invalid, executor-throws, or unknown target) write a **Proposed** item carrying the payload — **never silently dropped**. A classifier failure / timeout writes a Proposed/null-target row so every Capture always lands in the bell.
- **Triage is Seth's job.** The orchestrator only touches the Inbox via the orchestrator-only `friday-inbox` MCP server (`inbox_list` / `inbox_act` with approve/reject/dismiss/triage/undo), at explicit in-chat direction. There is NO nightly or out-of-band pass.
- **Capture-key auth** is the better-auth **API Key plugin** (`@better-auth/api-key@1.6.9`, matching installed `better-auth@1.6.9` exactly — no core bump), `enableSessionForAPIKeys: false`, scope `{ capture: ["write"] }`. A verified Capture key mints NO session. The `apikey` table is declared in our Drizzle schema and provisioned by **our own migration** — this repo has no `@better-auth/cli` (BetterAuth tables here are all Drizzle-migrated, per the convention `user`/`session`/`account`/`verification` already follow), so the plugin's table joins the migration chain like any other. The Inbox state column is `state` (`open` | `resolved`), never `status` (reserved per the glossary).

**Why a separate tier and not a chat message.** It decouples the cheapest interaction from the most expensive agent, keeps the orchestrator's context clean (a reminder set from the Watch never enters Friday's history), runs on Haiku instead of Opus, and is parallel/stateless so captures never serialize behind a live turn. The Done/Proposed/Unsorted split makes the model's confidence visible and reversible rather than hidden inside a turn.

**Why terminal execution and not deferral.** The router holds the primitives directly, so the high-confidence case (`act`) completes end-to-end in one stateless hop with no agent involvement; only genuinely ambiguous captures wait for Seth. Deferring everything to the orchestrator would reintroduce exactly the coupling this ADR removes.

**Rejected:** _router-as-pre-classifier that still funnels everything to the orchestrator_ (A) (keeps the orchestrator coupling and token cost for the common case — the classifier's value is precisely that it can terminate); _a long-lived intake agent_ (C) (stateful, expensive, and pointless — each Capture is independent and needs no memory); _a deterministic policy layer / ceiling over the classifier_ (act-vs-propose is the model's judgment tuned only by the persona prompt + per-target guidance; a rules engine would ossify and never match natural-language nuance); _a per-app structured `autonomy` field_ (same reason — guidance prose is the single routing/act-vs-propose lever; a typed knob is a config surface with no payoff); _literal reversibility as the Gate-2 axis_ (the gate is the model's confidence, not whether the artifact happens to be undoable — `undoable` is a property of the result reference for the Undo-vs-View CTA, not the decision to act); _exposing the daemon directly through the tunnel_ (breaks the single-public-process invariant; capture goes through the dashboard like every other public surface); _a custom `api_keys` table + bespoke verification_ (the better-auth apiKey plugin already does hashing, scoping, rate-limiting, and revocation — reinventing it is strictly worse); _session-from-API-key_ (`enableSessionForAPIKeys` stays `false` — a Capture key is a write-scoped credential, not a login; minting a session from it would hand the Watch a full dashboard identity). _Plugin-packaging finding:_ the apiKey plugin is NOT in `better-auth` core 1.6.x (neither 1.6.9 nor 1.6.20 export `apiKey` from `better-auth/plugins`); it is the standalone `@better-auth/api-key`, pinned to `1.6.9` to match the installed core peer exactly.

## ADR-048 — Notifications are storageless, daemon-routed, fire-and-forget deliveries; the Inbox stays the only durable bell surface

**Status:** proposed (2026-06-22). Reworks **FRI-142** (push) and folds in the in-app notification-center handoff as one design. Builds on **ADR-047/FRI-171** (the Inbox + `inbox_items`) and **ADR-024** (SSE narrowed to live-turn deltas; settled state flows via Zero).

**Context.** Async machine→human events — a Builder finished/failed, mail arrived, a schedule surfaced a result, an `evolve` critical fired, a low-confidence **Capture** needs a look — must reach Seth on his phone (native PWA Web Push + app-icon badge) and in-app, whether or not the app is foregrounded. FRI-171 already shipped a header **bell** over `inbox_items`. The naïve extension — a second persisted `notifications` feed beside the Inbox — forces a choice between a god-table (one table the bell filters, stranding Intake-only columns or demoting them to JSONB) and a two-table fusion that must stay in sync, be view-fused, and let Intake items _emit_ notifications "cleanly and configurably." That emit path is where the design nearly collapsed under its own weight.

**The lever.** A **Notification** is the mirror of a **Capture**: where a Capture is _human→machine_ messy input needing a cleaning pipeline, a Notification is _machine→human_ pre-authored output needing none. It is inherently **fire-and-forget** — the durable record of "this happened" already lives elsewhere (the `inbox_items` row for a capture; the OS notification tray for a push; the artifact the deep-link points at). So the Notification itself needs **no storage**. Remove the storage and the entire knot — sync, view-fusion, 1:1 mirroring, configurable emit — dissolves: the producer says _what_, a stateless router says _whether/how_.

**Decision.**

- **Three peer systems, shared infrastructure.** **Intake** (human→machine, cleans/classifies/routes), **Chat/mail** (the turn loop), and the new **Notification** system (machine→human surfacing) are separate pipelines that share Postgres/Zero/the daemon. Chat is **not** a Notification channel — mail may _emit_ a toast, but the router never delivers _to_ chat (the mail-bridge owns that).
- **Notifications are storageless in v1.** No `notifications` table. The only new storage is `push_subscriptions`. A Notification is a transient delivery, never a row.
- **The bell stays the Inbox.** `inbox_items` (Zero-replicated) is the sole durable bell surface. The Notification and Inbox systems converge **only at the badge count** — derived reactively from open attention-worthy Inbox items — never at storage. This satisfies the handoff's "one source of truth for unread-count" as a _derivation_, not a shared table.
- **Channels fan out; the set is open.** v1 ships **Toast** (ephemeral in-app, present clients only) and **Push** (Web Push + `navigator.setAppBadge`). A Notification fires any subset. `email`/SMS/webhook can join later additively.
- **Transport split honors ADR-024.** **Zero = persisted/settled** (the bell reads `inbox_items`); **SSE = ephemeral/live** — a new `toast` event joins the live-turn-delta side-channel. This is **not** resurrecting the Phase-5-retired SSE notification events: those had backing rows and moved to Zero precisely _because_ they were settled state on the wrong pipe; a toast has **no row by design**, so the ephemeral pipe is its only correct home.
- **The daemon owns the stateless Notification router.** It is the single server-side point holding the VAPID private key and the push subscriptions. Per Notification it consults **Notification policy** + **DND** + **presence** and fires zero or more channels. It holds no cross-event state.
- **Presence is server-side, in-memory, multi-client, fail-safe.** Clients report `device_id` + visibility via `POST /api/presence` (on `visibilitychange` + a keepalive); the daemon keeps an in-memory `Map<deviceId,…>` (TTL ~45–60s), **OR-aggregated per user** (any fresh+visible device ⇒ present). Stale/unknown ⇒ treat as away ⇒ **Push**. Presence can only ever _downgrade_ a Push to a Toast. It must be server-side because **WebKit requires every push to render a user-visible notification** — a foregrounded device cannot silently receive a push and swap it for a toast, so the daemon must decide whether to push _at all_.
- **Policy is per-event-type × per-channel, presence-based.** Stored as a `notify_policy` JSON map on the `settings` table (Zero-replicated): `{ <eventType>: { <channel>: <rule> } }`, rule ∈ `never | present_only | absent_only | always`. The rule vocabulary is presence-based and **channel-agnostic**, so the open channel set grows by adding a key, never by expanding the enum. The settings UI offers friendly presets (Auto / Always push / Toast only / Off) that are pure sugar writing these rules. A global **DND** window overlays every policy (suppresses Push); one master toggle lets a _critical_ class (`evolve_critical`, mail `priority='critical'`) bypass DND.
- **The Inbox becomes the generic persisted actionable-item store — now, not deferred.** Its action facet (`target_id`/`payload`/`undoable`/`inverse_label`/`deep_link`/`kind`/`state`) is already producer-agnostic; **Intake is merely producer #1**. Two couplings are removed in this work: (1) `inbox_items.raw_text` → **nullable**; (2) the `target_id → executor` resolution (and `approveInbox`/`undoInbox`) decoupled from Intake-specific assumptions, so a future non-Intake producer (an agent's "approve this merge?", a system "renew this cert?") writes a Proposed/Done row that resolves through the same registry with no further refactor.
- **`push_subscriptions` is server-only.** One row per browser registration, keyed by `endpoint`, FK `device_id → client_devices`. **Not** in `SYNC_TABLES` (endpoint+keys are sensitive; the client learns its own state from `pushManager.getSubscription()`) — the `apikey` precedent. Stale endpoints are deleted on `404`/`410`; "Forget this device" (`client_devices.revoked_at`) drops that device's subscription.
- **The VAPID keypair lives in a server-only Postgres table (`web_push_vapid`), not a data-dir file.** Single-row (PK `id = 'singleton'` + a CHECK pinning it), `public_key`/`private_key`/`created_at`, generated once via `ensureVapidKeys()` (`INSERT … ON CONFLICT (id) DO NOTHING` then `SELECT` — atomic, idempotent, concurrency-safe, never overwritten). **Not** in `SYNC_TABLES` and **not** in the Zero sync schema (the `apikey`/`push_subscriptions` precedent) — the **private key must never replicate** to the browser; the dashboard only ever receives the public half via `GET /api/push/vapid-public-key`. It is boot-ensured best-effort (a failure degrades push to unavailable, never crashes boot) and re-ensured defensively on the public-key fetch. **Why Postgres, not a `~/.friday/vapid.json` file (the load-bearing invariant):** rotating the public key invalidates **every** existing `push_subscriptions` row — the browser subscribed against the old `applicationServerKey`, so the push service returns `410`/`404` for all of them and push silently dies. A data-dir `vapid.json` is **not** in the default `friday backup` whitelist, so a restore to a new machine would regenerate the keypair and kill push. Co-locating the keypair with the subscriptions in Postgres makes "subscriptions always match the current public key" a **structural invariant** — they ride the **same `pg_dump`**, restored and migrated together.

**Why storageless and not a feed.** It is a strict _subset_ of the eventual "machine events linger in the bell" design, not a dead end: the day a durable in-app feed is wanted, add a separate `notifications` table and **view-fuse** it into the bell (union two reactive Zero queries; count = sum). Nothing built now is thrown away. Until then, the OS notification tray is the durable record for push, and the deep-link carries the user to the artifact.

**Rejected:** _one unified `notifications` table the bell filters_ (a true superset strands columns — either Intake's `raw_text`/`cleaned_text`/`kind`/`payload` null on every machine event, or demoted to an opaque JSONB blob that loses the relational `kind`/`state` model; either way it fuses two deliberately-separate systems' storage and re-opens a shipped Zero-replicated table); _Notification-as-thin-envelope emitted per Inbox item_ (every bell item needs a mirror envelope ⇒ 1:1 rows splitting one logical thing across two tables — the god-table with extra steps); _always-push + service-worker decides toast-vs-banner_ (fails on iOS — WebKit mandates a visible notification per push, so the foreground toast swap is impossible; this is exactly what forces presence server-side); _toasts on an ephemeral Zero TTL table_ (reintroduces storage + a cleanup sweep for a signal that is fire-and-forget by nature — SSE already carries ephemeral live signals); _persisting presence to Postgres_ (high-churn ephemeral state; replicating heartbeats through Zero is pure waste — in-memory daemon state is canonical and a restart safely over-pushes); _channel-hardcoded mode enum_ (`push_always`/`toast_only` bake the channel set into the enum and churn combinatorially when a 4th channel arrives — replaced by presence-based per-channel rules with the preset names demoted to UX sugar); _Chat as a notification channel_ (it is a peer system with a turn loop and its own constraints; coupling it into the router conflates two pipelines).

**Consequences.** Machine events (builder-done, mail, escalations) are **push/toast-only and do not persist in the bell** in v1 — the OS tray is their durable record; swiping a push away unread loses the in-app trace (desired for mail, an accepted concession for builder-done). A new `toast` SSE event type joins the live side-channel; the ADR-024 invariant ("SSE = ephemeral live, Zero = settled") holds because the toast has no row. The daemon restart empties the presence Map and briefly over-pushes — the safe direction. The on-device assumption that **every push must show a notification** (the load-bearing reason presence is server-side) is verified on Seth's iPhone, as FRI-142 already mandates.

## ADR-049 — The mutator↔listener intent is an explicit typed view in `@friday/shared`, not an implicit row shape — refining ADR-023

**Status:** accepted (2026-06-25). Refines **ADR-023** (row-as-intent). Does **not** reopen it: the seam stays the Postgres row + `NOTIFY`; no `intents` table is introduced (ADR-023 rejected one and that rejection stands).

**Context.** ADR-023's row-as-intent pattern is sound: a side-effect mutator writes a sentinel `status` value onto a real domain row, a Postgres trigger fires a per-channel `NOTIFY`, and the daemon's LISTEN handler re-reads the row and runs the work — with boot-recovery scanning the same `WHERE` clauses. The friction was narrower and real: **the payload crossing the seam was implicit and untyped.** The contract between the `@friday/shared` mutator and the `services/daemon` listener was (a) a bare `status` string literal re-spelled at five sites (mutator body, schema column comment, schema CHECK constraint, the CHECK migration, the Postgres trigger predicate) with nothing binding them, and (b) for the two content-bearing seams (`sendUserMessage`, `resumeTurn`), a **byte-identical hand-rolled `JSON.parse` + `typeof`/regex** block duplicated across both daemon listeners, re-deriving the `{ text, attachments? }` shape the mutator already knew. Nothing — no shared type, no test — forced the two sides to agree; the documented `sendUserMessage` postcondition (`pending → dispatched`) had already drifted from the code (`pending → queued | complete`) precisely because nothing pinned it.

**Decision.**

- **One shared, node-free module names the contract:** `packages/shared/src/sync/intents.ts`, re-exported from both the client-safe `@friday/shared/sync` surface (the mutator imports it) and the root `@friday/shared` barrel (the daemon listeners import it). It is the single place the seam's payload is declared; both implementations straddling the seam import the same symbols.
- **Status tokens are centralized as `INTENT_STATUS`** (a `const` of camelCase keys → the exact literal column strings). The mutators and listeners reference the const instead of re-spelling literals. **Values are frozen** — a token value is also keyed by in-flight rows, the DB CHECK constraint, and the trigger predicate, so changing one is a data-format migration, not a code edit. The const centralizes the _declaration_, not permission to re-spell.
- **The content-bearing payload is a typed view with one parser/constructor pair:** `buildUserMessageContent` (mutator side) and `parseUserMessageContent` (listener side, used by both `dispatch-listener` and `resume-listener`). The parser is a faithful move of the prior hand-rolled logic — it never throws and returns a discriminated `{ ok, content }`: `ok: false` (malformed JSON) lets the dispatch listener fork-empty and the resume listener bail-corrupt **with one parser**, preserving each side's exact prior behavior. This is the depth win — the listener stops re-deriving what the mutator already knew.
- **Status-only seams get the token const but no content-view object.** `abortTurn`, `cancelQueued`, `resumeTurn`'s status flip, `archiveAgent`, `createSchedule`, `createMemoryEntry` carry no parsed payload — their listeners read typed Drizzle columns off the re-fetched row. Manufacturing an empty "intent object" there would be indirection with no duplication removed, so it is deliberately omitted.
- **`updateSettings` is the documented boundary case.** It has no status token: the intent is the _whole_ settings row, reconciled into `config.json` by content-diff. It does not fit the discriminated-token mold and is intentionally left out of `INTENT_STATUS` rather than forced to wear a fake token.
- **Cross-boundary contract tests replace the prose.** `intents.test.ts` pins three agreements the seam previously lacked: build↔parse round-trip (incl. the exact malformed/empty behavior), **token ↔ DB CHECK membership** (read live from the Drizzle schema via `getTableConfig` + `PgDialect`, so a token rename that desyncs from the CHECK fails the test instead of throwing in prod), and **each mutator writes the centralized token** plus the columns the listener's precondition reads (catching the postcondition-drift class).

**Idempotency is untouched.** The determinism contract (precondition status short-circuit + the atomic-claim `UPDATE … WHERE status=token` that wins the single-dispatch race) is unchanged — the typed parse sits _before_ the claim and never weakens it. The boot-scan/reaper/NOTIFY callers still funnel through the same handler.

**Scope of this pass.** All non-app side-effect seams (blocks, agents, schedules, memory_entries) adopt the const; the **apps** seam (`installApp`/`uninstallApp`/`reloadApp`) keeps its literals for now — it is the next incremental adopter (the const is a source of truth more sites can join without a big-bang migration, exactly the rollout ADR-023's determinism contract allows).

**Rejected:** a dedicated `intents` table (ADR-023 rejected it; intent stays a status value on the domain row); tightening `content_json`'s own Zero-replicated column type (deeper, touches the replicated shape — out of scope; the view parses the existing loose column); generating the Postgres CHECK constraints _from_ `INTENT_STATUS` (the CHECK sets include daemon-written durable statuses outside the intent vocabulary, so the test asserts membership rather than the const owning the whole set); folding the `/api/internal/*` fast-path into the typed intent (the fast-path is an alternate _trigger_ for the same handler — the intent describes the _row_, independent of which path woke the daemon).

## ADR-050 — Cloud-first: the container is the sole unit of deployment; local-first demotes to a dev fallback

**Status:** accepted (2026-10-14). Supersedes the local-first premise in **ADR-001**'s preserved rationale ("a separate service that fights the local-first model") and the **Non-goals (v1)** list in `docs/architecture.md`. Narrows **ADR-034** (pre-baked release tarball + `install.sh`) to the enterprise install path only.

**Context.** Friday was built as a headless daemon on the user's own Mac: `install.sh` + a `~/Library/LaunchAgents` plist, `launchctl` for `start`/`stop`/`restart`/`status`, Homebrew for `fnm`/`pnpm`/`postgresql@18`/`pgvector`/`cloudflared`/`gh`, per-arch `darwin-arm64`/`darwin-x64` release tarballs with no cross-compile, and a self-hosted Intel runner gating each release. Three goals break that premise simultaneously: agents must run independently of a laptop, several people must share one Friday, and several interfaces (Slack, SMS, email, Linear, Jira) must reach it. A Linux target does not merely need cleanup — **it has never existed**: `pack.mjs` refuses any non-darwin arch, there is no Linux leg in CI, and `checkDeps()` hard-gates boot on `brew list pgvector`, where `resolveBrew()` falls through to a bare `brew` that is absent on Linux, so the supervisor parks the stack permanently rather than failing loudly.

**Decision.**

- **Cloud is the reference deployment.** Local still runs the stack because development requires it, but it is no longer a supported product configuration. macOS-only machinery (launchd, `launchctl` aliases, the Brewfile, `brew services` Postgres, `cloudflared service install`, the darwin tarballs, the Intel runner) becomes dev scaffolding or retires.
- **There is exactly one image.** Any future local package ships as the same container as the cloud deployment. This is the invariant that kills the dev-vs-prod drift behind most of the upgrade-gotcha list in `CLAUDE.md`, and it is also why the **enterprise self-hosted artifact and the dev container are the same build** — let them diverge and the self-hosted tier becomes a second product.
- **A Deployment is one container; Postgres is external.** The supervisor runs as PID 1 managing daemon + zero-cache + dashboard, mirroring the existing process model. **Not** split per-process, because **loopback is a load-bearing authorization boundary, not a networking convenience**: the daemon binds strictly to `127.0.0.1` and additionally requires a localhost `Host` header plus a constant-time daemon-secret match; `/api/mutators` and `/api/internal/capture-keys` are exempted from the session gate by `isLoopbackOrigin()`; and `/api/mutators` — the endpoint every write passes through — carries no session authorization at all beyond being loopback-only. Separate containers would mean replacing an origin check with real service-to-service auth on the most privileged endpoint in the system, bought for independent scaling of three processes that is worthless at one customer per instance.
- **Postgres stays external** for four specific reasons, not convention: `CREATE EXTENSION vector` needs SUPERUSER (which the `friday` role deliberately lacks, per **ADR-044**), `wal_level=logical` is a server-level setting, it is the only canonical state and so needs real backups and PITR, and the Zero replica can be discarded and rebuilt while the database cannot. Co-locating it would put a container restart in front of the customer's only copy of their data.
- **`friday setup` is converted, not deleted.** The interactive wizard is the natural enterprise self-hosted install path. Likewise `checkDeps`/`ensureVectorExtension` need actionable errors about `wal_level`, pgvector, and the SUPERUSER requirement rather than instructions to run `brew services start postgresql@18`.
- **Persistence to plan for.** `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` holds the SDK session transcripts, lives outside `FRIDAY_DATA_DIR` under the real OS `$HOME`, and is why `backup.ts --full` captures it — without it the SDK silently starts fresh sessions. It needs a real volume. `~/.friday/zero` (the replica) can be ephemeral; it re-COPYs from Postgres.

**Consequences.** `docs/architecture.md`'s "Single user, multi-device" framing and its v1 non-goals, the README's tagline and `"Your Machine"` topology diagram, `docs/setup.md`'s Homebrew + Cloudflare Tunnel walkthrough, and `docs/self-hosted-runner.md` all become wrong rather than stale. The `0600` permission assertion in `getDaemonSecret()` — which **fatally exits** if any group or other bit is set on `~/.friday/.daemon-secret` — must be verified against the real container mount before first deploy; volume and secret mounts do not reliably preserve file modes, and the failure mode is a boot crash-loop with no degraded path.

**Rejected:** retiring local entirely (it would delete the development loop in the same change that introduces an unproven deployment target); two first-class targets (it commits to maintaining `sandbox-exec` _and_ a Linux isolation story, launchd _and_ a container supervisor, the tarball pipeline _and_ an image pipeline, doubling the gotcha surface for no gain against the stated goals).

## ADR-051 — One Deployment per Organization; the Control plane is a separate application and the identity provider

**Status:** accepted (2026-10-14). Builds on **ADR-050**. Supersedes "Multi-tenant / multi-user identity" as a non-goal in `docs/architecture.md`.

**Context.** Friday is single-user by construction and says so in code: `emailAndPassword` is configured `disableSignUp: true` ("Public sign-up is permanently disabled — first account is created via `friday setup`"), `resolveSoleUserId()` deliberately picks the earliest-created `user` row, `friday setup` offers only "keep" or "DELETE the user account" when one exists, and **there is no code path anywhere that adds a second human**. Of 32 tables, six carry any user identity (`users`, `sessions`, `accounts`, `apikeys`, `client_devices`, `push_subscriptions`); every table the product revolves around — `agents`, `blocks`, `mail`, `tickets`, `habits`, `inbox_items`, `memory_entries`, `schedules`, `attachments`, `evolve_proposals` — has none. `settings` and `web_push_vapid` are literal singletons (PK pinned to `'singleton'` by a CHECK). The target is a SaaS product with self-serve signup for companies whose employees collaborate.

**Decision.**

- **One Deployment serves exactly one Organization — instance per customer.** No multi-tenancy inside a Deployment: no `organizations` scope column, no `org_id` on any domain table, no row-level tenant predicate. A second customer gets a second Deployment and a second database.
- **Organization is a stored singleton entity, not a row scope.** One row, created by setup alongside the first **User**, holding what is true of the company rather than of a person: its name, its SSO domain allowlist, the org-owned `SOUL.md`. The BetterAuth organization plugin is the intended vehicle (the same bargain already accepted for `apikey` under **ADR-015**), which brings memberships and roles with migrations.
- **A Control plane is a second application**, not a Friday feature. It owns public marketing, self-serve registration, billing, legal, and support, and it **initializes a Deployment on signup**: create the database, provision the role and the `vector` extension, create `friday_pub`, allocate a replication slot, generate the per-Deployment secrets, allocate a hostname and certificate, boot the stack. It is the only component that spans Organizations.
- **The Control plane is the identity provider.** One login; it authenticates and hands the Deployment a signed assertion, which the Deployment exchanges for a **local** BetterAuth session. `disableSignUp: true` stays true and becomes _correct_ rather than a workaround — a Deployment never signs anyone up. Because the Deployment mints its own session and BetterAuth is configured with 7-day sessions on a 1-day sliding refresh, a Control-plane outage blocks **new** logins only, not active ones. SSO is the model (users auto-provision against the Organization's domain allowlist); invites are the bootstrap and the fallback for people outside the IdP.
- **The Control plane provisions and bills; it stays out of the hot path.** Each centralization adds a runtime dependency, and only one is accepted: **webhook ingress**, because the platforms force it (see **ADR-052**). Secrets are explicitly _not_ served from it — they are read on every integration-touching turn, so a Control-plane outage would stop agents mid-work fleet-wide.
- **Postgres: shared cluster now, dedicated servers as an upgrade.** One cluster with a database per Deployment initially (every Organization treated as a trial), with the shared→dedicated migration added incrementally: dump, restore, swap the connection string, re-COPY the replica. Two things are therefore **not** deferrable: the connection string becomes configuration (`postgresql://${process.env.USER ?? "postgres"}@localhost:5432/${FRIDAY_DB}` is hardcoded in roughly five places in `pg-provision.ts`, and nothing may assume a stable host), and `max_replication_slots` must be raised at cluster provisioning — it defaults to **10** and zero-cache needs one slot per Deployment, so the 11th Deployment cannot start.
- **`CREATE EXTENSION vector` moves off the Deployment boot path.** It needs SUPERUSER, and on a shared cluster one superuser credential covers every Deployment's database — a Deployment holding it could read every Organization's data. Provisioning creates the extension; the Deployment's `checkDeps` only _verifies_ it and fails with an actionable error; the Deployment's own role stays non-superuser and scoped to its database. This is the same hazard class **ADR-044** addresses from the other direction.
- **Ingress: per-Deployment hostname for humans, one central shim for integrations.** Humans reach `<org>.friday.app` directly — SSE and the Zero WebSocket are long-lived and should not take an extra hop, and BetterAuth resolves `baseURL`/`trustedOrigins` from the public URL and **hard-exits via `process.exit(1)`** on a mismatch, so a hostname change is a restart-with-new-config rather than a runtime setting.
- **Secrets: keep the age vault, inject the identity at runtime.** Containerizing would otherwise put `~/.friday/.age-key` on the same volume as the `vault.enc` it decrypts — obfuscation, not encryption at rest. The age identity comes from the platform secret manager into memory or tmpfs; the auto-generated platform secrets (`BETTER_AUTH_SECRET`, `ZERO_AUTH_SECRET`, `ZERO_ADMIN_PASSWORD`, the daemon secret, VAPID) move there too instead of being written into `~/.friday/.env.local` on first boot. **Platform secrets in the platform's manager, customer integration secrets in the customer's vault** — which keeps `secrets_fetch_log` and the rate-limited `friday-secrets` tool working unchanged, both of which matter more with untrusted humans asking agents for credentials than they did on a laptop. The injection mechanism must be pluggable, not bound to one cloud's API, so the self-hosted tier can supply its own.

**Consequences — accepted, not discovered.** Instance-per-customer makes every release **N independent boot-time migrations against N databases**, so: expand/contract migration discipline becomes mandatory (version skew is permanent — the fleet is never updated atomically), schema rollback does not exist (roll forward only), and **ADR-044**'s self-referential update gap means a fix to the rollout mechanism cannot apply to the rollout that delivers it. The Drizzle `when`-timestamp hazard documented in `CLAUDE.md` escalates from "bricks one laptop, silently" to "splits the fleet, silently," and `runMigrations()`'s journal/row-count assertion turns a divergent Deployment into a boot crash-loop. Needs canary cohorts, per-Deployment migration telemetry, and **synthetic per-tenant health probes** — process liveness is insufficient, because the worst failure (a table in the Zero schema but not in `friday_pub`) leaves the page and tunnel looking fine while live sync is dead and the dashboard reload-loops. Measured per-Deployment idle cost at the time of this decision: **~700 MB RSS across ~29 processes** with no agent turns in flight, zero-cache accounting for ~57% of it. Scale-to-zero is largely unavailable because always-on _is_ the product — the scheduler is a 30-second tick, and the daemon holds a Postgres `LISTEN`, the SSE channel, and the mail bridge.

**Rejected:** shared multi-tenancy (`org_id` across ~26 tables, re-keying `agents.name` — a primary key that `mail`, `blocks`, and `read_cursors` all reference by bare string — splitting the `settings` and `web_push_vapid` singletons, partitioning the flat-file memory store, and replacing every `select: ANYONE_CAN` with a predicate where one omission is a cross-company leak); a Friday per employee (same `agents.name` re-keying problem, and it discards the shared organizational knowledge that makes a company assistant worth building); per-Deployment authentication with the Control plane only provisioning (seat counting becomes a fan-out query across the fleet, support cannot see users without entering a customer's instance, and offboarding happens in two places); Control-plane-served secrets (hot path); claim-on-first-contact user provisioning from a Transport (Slack workspace membership would become sufficient to drive an agent, and guests are in a lot of workspaces).

## ADR-052 — Transports are first-class; a Conversation is per (User, agent) and spans every Transport

**Status:** accepted (2026-10-14). Extends **ADR-047** (stateless capture intake) rather than reopening it. Amends **ADR-005**'s prompt stack. Builds on **ADR-051**.

**Context.** Friday has two unrelated inbound paths and one outbound one. Capture is one-shot: `POST /api/capture` → daemon `/api/intake` → `runIntake(source, text)`, where `IntakeSource` is the closed union `"watch" | "quick_add"`. Chat is a Zero mutator — `sendUserMessage` writes a `blocks` row at `status='pending'`, a trigger fires `NOTIFY friday_new_pending_block`, and the daemon's LISTEN handler dispatches the turn. Outbound, the Notification tier is real and complete: `notify()` as a stateless router, Toast via the event bus, Web Push with a VAPID keypair in Postgres, Presence, policy, DND — and its `notify_policy` rule vocabulary (`never | present_only | absent_only | always`) is deliberately presence-based and channel-agnostic so a new **Channel** is a map key. But **there is no webhook receiver anywhere in the repo**: the Linear integration is outbound-only (`reconcile()` polls, `importIssue()` pulls), and only `/api/capture` is reachable without a session. Meanwhile the prompt stack receives no human identity at all — `buildSystemPrompt` and `buildDispatchPrompt` take an agent row and a `DispatchIntent`, nothing more — and `~/.friday/SOUL.md` is one file whose `{{YOUR_NAME}}` was substituted once from `process.env.USER` and never re-derived, instructing the agent to "hold the form" on that single name.

**Decision.**

- **`Transport` is a first-class concept**: a bidirectional, identity-bearing, threaded interface between a human and Friday — Slack, email, SMS, the web dashboard, Linear, Jira. **`Source` is retained as the degenerate case**: a Transport that expects no reply. Stretching **Capture** into a conversation system its own definition rules out was rejected.
- **Each Transport declares a `Transport style`** — the register Friday answers in: brevity, level of detail, cadence, formatting. Declared rather than inferred, because the right answer differs sharply by medium. It is a _modulation_ of the assistant persona, never a replacement: the SOUL is the same Friday in every Transport. The implementation pattern is the one **ADR-047**'s routing-target registry already uses — declarative natural-language `guidance` contributed per entry and merged into the prompt — not a parallel prompt stack like the **Intake persona**.
- **A `Conversation` is keyed by (User, agent) and spans every Transport.** One continuous thread that Slack, email, and the web dashboard are doorways into; one SDK session per pair, so continuity is structural rather than reconstructed. A **Transport is per-turn context**: it decides the reply's **Transport style** and where the reply is delivered, never the identity of the Conversation. An external thread (a Slack `thread_ts`, an email `Message-ID` chain) resolves to a Conversation plus a reply target — a small mapping table, not a Conversation dimension.
- **Per-User Conversations, not per-User agents.** `agents.name` is the primary key that `mail.from_agent`/`to_agent`, `blocks.agent_name`, and `read_cursors` all reference by bare string, so there can only ever be one `orchestrator`. Privacy is therefore modelled as a Conversation dimension on `blocks`, with `read_cursors` re-keyed from `(device_id, agent_name)` to include the User.
- **One org SOUL with dynamic addressing.** The Address rule stops being a baked name and becomes "address the **User** who is speaking, by their name." The **prerequisite is threading the speaking User into prompt assembly**, which `blocks.user_id` already carries on the originating row. `SOUL.md` stops being documented as "your editable identity": in a company Deployment it is shared character, and per **ADR-053** it is admin-owned.
- **Webhooks land centrally and are routed.** A distributed Slack app has exactly **one** Event Subscriptions URL for all installations (likewise one webhook URL for a GitHub App, one redirect URI for an OAuth app), so per-Deployment webhook URLs are not available for a single distributed integration — the alternative would require every customer to create and configure their own Slack app during onboarding. All integration traffic lands on one shared endpoint, is signature-verified once, and is routed by `(provider, external_workspace_id) → Deployment`. Build it as a **separate, minimal service** from the rest of the Control plane — stateless verify-and-route, no billing database — because unlike login it is a _runtime_ dependency for every Transport (see **ADR-051**).
- **A `user_identities` mapping** of `(provider, external_id) → User` resolves inbound identity, where `provider` covers `slack`, `email`, `linear`, `jira`, not only login providers. **A Transport identity match is identification, not authorization**: resolving a Slack ID to a User says who is speaking; whether that User may drive an agent is a separate check.

**What is already transport-agnostic.** The `pending` block + `NOTIFY` seam: anything that can write that row can start a turn. The mail bridge likewise already wakes a live worker or spawns from mail for `bare` agents. This is not a second pipeline.

**Consequences.** `docs/chat-ux.md`'s single-chat UX, the sidebar focus model, and the unread-badge derivation become wrong, and the Conversation dimension is a schema change to the most-written table. Session transcript volume grows per User-agent pair rather than per install.

**Rejected:** widening `IntakeSource` to cover Slack/email/SMS (cheap, and wrong — Capture is defined one-shot with no reply path and no thread); making every interface a full conversational Transport (overkill for a one-shot SMS, and it discards the stateless classify-and-route path); **transport-scoped Conversations** (deferred — memory was the proposed cross-Conversation bridge, but **ADR-046**'s transcript→memory consolidation runs _nightly_, so same-day continuity falls between explicit `memory_save` and the dreaming pass; also multiplies SDK transcripts by every external thread forever); per-User `SOUL.md` overrides (it is the per-individual tailoring deferred in **ADR-053**, arriving through the prompt stack, which is the harder place to retrofit).

## ADR-053 — Roles gate authority; a personal/org Scope boundary replaces blanket read access

**Status:** accepted (2026-10-14). Builds on **ADR-051** and **ADR-052**. Closes the "Phase 4" placeholder in `packages/shared/src/sync/schema.ts`.

**Context.** MCP tools are gated by the _calling agent's type_, never by the human: `friday-agents`, `friday-schedule`, `friday-evolve`, `friday-apps`, and `friday-inbox` are orchestrator-only, `friday-secrets` is available to every type but `scheduled`, and handlers HTTP-loopback carrying `x-friday-caller-name`/`x-friday-caller-type`. With per-User Conversations that means **every employee gets their own orchestrator conversation and the orchestrator can do everything** — install Apps, manage agents and schedules, spawn builders against company repositories, apply evolve proposals, and fetch stored credentials. `secrets_fetch_log` records the _agent_, so the audit trail says "orchestrator fetched the Linear API key," not which human asked. Separately, **every Zero-synced table carries `{ row: { select: ANYONE_CAN } }`** under a comment reading "Friday is single-user … every authenticated client reads every row. Phase 4 layers in cell-level or row-conditional rules if the auth model grows," and the dashboard reinforces it with deliberately global queries in `#bindReadCursors` and `#bindClientDevices`.

**Decision.**

- **`Role` is `admin | member`**, owned by the **Control plane** (where membership and billing already live), carried in the login assertion, and mirrored into the Deployment so the tool gate reads it without a per-turn network call. Admin installs Apps, manages agents and schedules, reads secrets, configures SSO and the org SOUL, and applies evolve proposals; member converses and uses the core tools. **The effective gate is agent type × Role** — Role is orthogonal to agent type, not a replacement for it.
- **The gating seam already exists.** Tools are filtered at registration by caller type; extending that to carry an acting-User header is the natural extension of a pattern already in place, and it is the same plumbing **ADR-052**'s per-turn User identity needs. Doing both at once is one change.
- **`Scope` is `personal | org`.** Conversations, `inbox_items`, **Habit**s and their **Check-in**s, and the per-user half of `settings` (**Theme**, **Notification policy**, **DND**, model picks) are personal; agents, tickets, mail, schedules, Apps, and **memory** are org. The intuition: _conversations and personal records are mine, work artifacts are ours._
- **Memory is org-visible, and that is a deliberate stance rather than an inherited default.** One shared brain is the point of a company assistant, so a sensitive thing said in one User's Conversation can reach another's recall once **ADR-046**'s nightly consolidation has run. This needs to be stated to customers, not discovered by them.
- **`select: ANYONE_CAN` goes on the personal-Scope tables.** The Zero JWT already carries `userId` in its claims, so a row predicate has the input it needs; the work is writing predicates, not plumbing identity. The dashboard's global `read_cursors` and `client_devices` queries must gain a `where`.
- **Mutators need ownership checks.** Zero has **no insert/update/delete row rules at all** — writes are authorized solely by server-side mutator functions, and none of them check ownership today. Every mutator touching a personal-Scope table needs a "may this User write this row" check.
- **Stamp the acting User on the org-Scope tables now, filter on nothing.** `memory_entries.created_by`, `ticket_comments.author`, and `mail` attribute to _agent_ names; `blocks.user_id` exists but is attribution-only. Authorship not captured cannot be backfilled. This is a prerequisite for two obligations, not hygiene: the audit question "who asked Friday for our credentials," and the erasure capability in **ADR-050**'s lifecycle terms — **you cannot delete what you cannot attribute.**
- **Users are revoked, not erased.** A departing User's access is revoked (sessions via `revoke`/`revoke-all`, devices via `client_devices.revoked_at`, Capture keys via the apiKey plugin) and their data preserved, keeping "Preserve over delete" intact and the Organization's record whole. The Organization is the data controller, so an individual's erasure request goes to their employer — **but an admin-initiated per-User erasure action must still exist** to honour that instruction when it arrives.
- **A cancelling Organization enters a retention window**, implemented as Deployment _suspension_ — the same state the Control plane's kill switch already needs for non-payment, abuse, and a blown **Usage cap**. Three in-window actions: **restore the account**, **export the data**, and **delete immediately**. Export-then-delete is the expected path, so export is asynchronous and an immediate delete following one must wait for that export to complete and be confirmed retrieved. Deletion must reach four things outside Postgres — the data-dir volume (`memory/entries/*.md`, `uploads/`), the SDK transcripts under `~/.claude/projects/`, the Zero replica and replication slot, and the Deployment's secret-manager entries — or it deletes an index rather than the data. `attachments` is content-addressed by `sha256` with no owner column, so per-User attachment deletion is ambiguous by construction and needs either an upload-attribution join table or an accepted rule that blobs are org-Scope and only the reference is personal.

**Rejected:** no roles (defensible for a handful of trusted people, indefensible once a member can read production secrets and run code against company repositories by asking politely); per-capability permissions (deferred — the likely first ask is "members may use `friday-secrets` for _these_ secrets"); filtering Conversations only (leaves `inbox_items` as a company-wide inbox and everyone's habits public, which reads as a bug); the full personal/org axis including a `scope` on `memory_entries` (pulls memory scoping in before customer demand is understood, and it is the individual tailoring deliberately deferred).

## ADR-054 — The container is the sandbox; Builders are Friday-hosted and hardened, customer-hosted execution is an upgrade

**Status:** accepted (2026-10-14). Supersedes the M2 and M5 layers of `docs/sandbox.md` on the supported target. Builds on **ADR-050**.

**Context.** `docs/sandbox.md` describes five layers, and the one its own adversarial review calls the real kernel-enforced boundary — **M2, `sandbox-exec` with an SBPL profile** — is macOS-only with no Linux implementation in this repo. `sandboxExecAvailable()` treats a missing `/usr/bin/sandbox-exec` as "disabled", so on Linux builders run with **no kernel isolation at all**, protected only by M1's regex PreToolUse rules and M4's process-group kill, both of which that review calls insufficient. M5's `ulimit -t`/`-n` limits were chosen for their _Darwin_ semantics. And the profile is applied only to `agentType === "builder"`; orchestrator, helper, scheduled, and bare agents are unsandboxed by design, justified in `lifecycle.ts` because "their working directory is the daemon repo and they legitimately need broader filesystem access" — reasoning that largely evaporates when there is no user filesystem to reach. Every worker runs with `permissionMode: "bypassPermissions"`.

**Decision.**

- **Agent execution moves into containers; the container is the isolation boundary.** Builders first, per-turn worker containers as the declared destination. The worker boundary is built as a protocol seam from the start rather than retrofitted, because `wakeAgent`/`wakeAgentCritical` are IPC calls, `peekLiveWorker` inspects an in-process handle, and `killDescendantTree` walks `pgrep -P` — all of which become a network protocol and a container lifecycle. This also _simplifies_ two things: teardown becomes "stop the container" rather than the `setsid`-escape tree walk listed as residual risk #2, and resource limits become cgroups rather than Darwin-honoured `ulimit`s.
- **The granularity is a container per Builder _task_, not per turn.** A Builder's worktree must survive turns — uncommitted changes, `node_modules`, an in-progress branch — and `.git/hooks/*` plus `node_modules` are executable surfaces that survive a reattached volume, so a compromised postinstall can drop a `post-checkout` hook that re-executes in a "fresh" container. The guarantee is therefore stated honestly as **bounded to one assignment**, not to one turn, and `.git/hooks` is added to the M1 deny-list.
- **Builders are Friday-hosted at launch**, with five controls. **(1) Scrubbed environment** — an explicitly constructed env, never `{...process.env}` and never the `$SHELL -ilc` captured login shell. This is the highest-value control and the cheapest: worker env is built today as `{...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "1"}`, and the daemon's `process.env` holds `DATABASE_URL` and the daemon secret — **readable by any postinstall script in any customer's lockfile via `console.log(process.env)`.** The shell capture is also meaningless in a container, where no human-configured login shell exists. **(2) Egress deny-by-default** with an allowlist of the git host and package registries, removing the payoff from most supply-chain compromises; the allowlist must be destination-based and must not permit link-local, because the cloud metadata endpoint (`169.254.169.254`) is an _account_-level compromise rather than a Deployment-level one. **(3)** Container per Builder task, as above. **(4) Per-Organization network isolation**: deny builder→any Postgres (a builder talks to the daemon over the worker protocol and has no business reaching a database), cross-Organization reachability, and builder→Control plane/webhook shim. **(5) A repo allowlist in two layers** — the GitHub App installation is the outer boundary (the customer chooses which repositories), an admin-configured list inside it is the inner one, since an admin installing with "All repositories" must not mean any member can have Friday push anywhere. Today `workspace.ts` takes a `baseRepo` path or URL with **no authorization notion at all**. Tokens are minted **per task, scoped to a single repository**, with `contents: write` + `pull_requests: write` only — so Friday opens branches and pull requests and never pushes to a default branch, and a compromise reaches one repository rather than every repository the customer owns.
- **(1) and (2) are launch gates**, as are the metadata-endpoint denial under (4) and per-task single-repo tokens under (5). (3) and (5)'s allowlist are strongly expected.
- **Customer-hosted execution is an enterprise upgrade, not a requirement.** A customer-installed component is too much friction for initial adoption. Two tiers above the default: a **customer-hosted runner** (Friday orchestrates; execution happens where the customer's code already runs, so "your source never leaves your network" becomes structural rather than a policy statement) and a **fully self-hosted Deployment**. The runner is not a second system — it is the same worker container from this ADR, scheduled onto their infrastructure.
- **Self-hosting needs a second mode for five things**, and keeping two seams pluggable now is cheap where retrofitting them is not: **auth** (standalone BetterAuth plus the customer's own SSO, instead of the Control plane as IdP — the path that exists today) and **webhooks** (the customer creates their own Slack/GitHub/Linear apps, since a distributed app has one event URL). The other three: **capacity** (`byo`, which already exists), **secret-key injection** (pluggable, not one cloud's API), and **licensing** (no usage telemetry reaches us, so seat-based or flat with a license key). Operationally it means version skew we do not control, boot-time migrations running unsupervised on customer data with no canary and no rollback, and no observability.

**The remaining exposure, named.** The orchestrator stays unsandboxed in the first phase while running with `bypassPermissions` as the daemon's OS user — and under **ADR-052** it is now driven by any employee's message over any Transport. The per-turn worker containers are what close this, which is why they are the declared destination rather than an optimization.

**Rejected:** a Linux equivalent of the SBPL profile (the container boundary is stronger and uniform across agent types, where M2 covered builders only); one container for everything with forked workers (trades macOS's partial sandbox for nothing on the only supported target); per-turn containers with a reattached workspace volume as the _first_ step (the ephemerality it advertises is largely illusory while `.git/hooks` and `node_modules` persist); customer-hosted runners as a launch requirement (friction); deferring Builders entirely (it ships without the differentiator — viable, and the stated second choice had hosting untrusted execution been rejected).

## Watch list

Open architectural questions deferred to v1.x or v2. Not yet ADRs because the trigger to decide hasn't fired.

- **Streaming Bash stdout in chat** vs. the current "summary + DB-fetch on expand" model. Watch how it feels in practice; revisit if tool-result expansion becomes a high-frequency action.
- **Memory-pressure auto-action.** Currently alert-only. If runaway workers become a recurring problem, consider auto-pause (not auto-kill) at threshold.
- **Multi-chat / scratch-chat archival.** Single persistent chat was the v1 design; `agent_name` on `turns` already supports multi-chat as a UI addition. Largely superseded by **ADR-052**, which makes a **Conversation** per (User, agent) a first-class entity — the open remainder is _transport-scoped_ Conversations (ADR-052's rejected option), to be promoted if one continuous per-User thread interleaves unrelated work badly enough to hurt relevance or token cost.
- **At-rest encryption for `~/.friday/`.** v1 relies on FileVault/BitLocker on the host — which does not exist on a cloud **Deployment**. **ADR-051** addresses the sharpest case (the age identity moves to a runtime-injected secret rather than sitting on the same volume as `vault.enc`); the rest of the data dir — `memory/entries/*.md`, `uploads/` — still relies on whatever the volume provides. Open: whether that is sufficient, or whether the data dir needs encryption Friday owns.
- **Other ticket integrations.** GH Issues, Jira, Linear-Cycles all slot into `ticket_external_links` cleanly (per ADR-006); no schema change required. Note **ADR-052** gives these a second possible role: a ticket system reached as a **Transport** (threaded, identity-bearing, Friday replies in-comment) is a different integration from one linked via `ticket_external_links`, and a given system may want both.
- **Mail thread/subject metadata.** Old Friday's mail had a `subject` separate from `body`. New schema only has `body` + `type`. If thread-grouping bites, add `subject text` and `thread_id text` columns + a migration.
