# Running Friday

## Daily commands

| Command                                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `friday start`                                  | Bootstraps (or kickstarts, if already loaded) the `com.sethvoltz.friday` launchd job via `launchctl` — no `brew services` (ADR-034). The launchd plist runs `friday-supervisor`, which forks daemon + dashboard + zero-cache as children with proper process-group cascade-stop semantics (ADR-028). For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard` — see "Dev mode" below.                                                                                                                                                                          |
| `friday stop`                                   | `launchctl bootout gui/<uid>/com.sethvoltz.friday`. launchd sends SIGTERM to the supervisor, which cascade-kills every child's process group — no zombie zero-cache workers (the FRI-83 failure mode this supervision rework closes).                                                                                                                                                                                                                                                                                                                                  |
| `friday restart`                                | `launchctl kickstart -k gui/<uid>/com.sethvoltz.friday`. Single-service restarts (`friday restart daemon`) are not supported under launchd supervision — the supervisor owns the whole stack atomically. Per-service IPC is an explicit follow-up.                                                                                                                                                                                                                                                                                                                     |
| `friday disable` / `friday enable`              | Toggle **auto-launch** without touching the install or `~/.friday`. `disable` boots the job out AND removes the plist, so it stays down across reboots (unlike `friday stop`, whose plist `RunAtLoad` brings it back at next login) — useful to keep Friday installed for testing `friday update` without it auto-running. `enable` re-writes the plist (does not start now); `friday start` both arms and launches. `friday update` is autostart-aware: a stopped Friday only gets its plist refreshed if one exists, so an update never resurrects a disabled plist. |
| `friday status`                                 | Show pids, ports, uptime. The tunnel line distinguishes `up`, `staged` (token present but serve-intent off — a restored box), and `down`. If the supervisor is **dependency-blocked** (a hard dep like pgvector is missing), status shows a `⚠ blocked` line naming the missing deps and the remedy (`friday provision`) — the stack is parked, not crash-looping (ADR-044).                                                                                                                                                                                           |
| `friday provision`                              | Install/repair Friday's runtime dependencies: `brew install` any missing Brewfile dep (pgvector), `CREATE EXTENSION vector` (via the admin/superuser connection — the `friday` role can't), and warm the embedding model (fail-open). Idempotent. Run it when `friday start` / `friday status` reports a missing hard dep; `friday update` runs it automatically after flipping to the new version (ADR-044).                                                                                                                                                          |
| `friday tunnel <up\|down\|status>`              | Flip the Cloudflare tunnel **serve-intent** (FRI-166). `up` sets `tunnel.serve` on and starts the agent from the vault token (no re-prompt); `down` clears it and tears the agent down (token kept in the vault); `status` reports intent + token + agent + public URL. The explicit cutover lever after a migration `friday restore` (which leaves the tunnel dark).                                                                                                                                                                                                  |
| `friday doctor`                                 | Health check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `friday logs [daemon\|dashboard] [--follow]`    | Tail logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `friday attach <daemon\|dashboard\|zero-cache>` | Interactive `tail -F ~/.friday/logs/<service>.jsonl`. Ctrl-C exits the tail; the underlying service is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Inspection (read-only; daemon doesn't need to be running)

| Command                           | What it does         |
| --------------------------------- | -------------------- |
| `friday agents ls`                | List agents.         |
| `friday sessions ls`              | List sessions.       |
| `friday memory ls` / `show <id>`  | Read memory entries. |
| `friday tickets ls` / `show <id>` | Read tickets.        |
| `friday mail inbox <agent>`       | Read pending mail.   |

## Mutations (require daemon running)

| Command                                                              | What it does                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `friday agents archive <name>`                                       | Archive an agent. For builders this also removes the worktree and force-deletes the `friday/<name>` branch.                                                                                                                                                                                                              |
| `friday tickets create --title ... --body ...`                       | Create a ticket.                                                                                                                                                                                                                                                                                                         |
| `friday tickets update <id> --status ...`                            | Update status.                                                                                                                                                                                                                                                                                                           |
| `friday tickets comment <id> --author --body`                        | Add a comment.                                                                                                                                                                                                                                                                                                           |
| `friday mail send --from --to --type --body`                         | Send mail.                                                                                                                                                                                                                                                                                                               |
| `friday app install <path> [--adopt]`                                | Install a Friday App from a folder (FRI-78, ADR-021).                                                                                                                                                                                                                                                                    |
| `friday app uninstall <id> [--folder=archive\|keep\|delete] [--yes]` | Uninstall. `--folder=delete` is irreversible and prompts unless `--yes`.                                                                                                                                                                                                                                                 |
| `friday app list` / `friday app inspect <id>`                        | Read-only inspection.                                                                                                                                                                                                                                                                                                    |
| `friday app reload <id>`                                             | Re-read the manifest from disk and reconcile.                                                                                                                                                                                                                                                                            |
| `friday capture-key create [--label "X"]`                            | Mint a write-scoped Capture key for the sessionless `POST /api/capture` intake endpoint (ADR-047); the plaintext key is printed **once** and never recoverable. Issued via the dashboard's loopback + daemon-secret-gated `/api/internal/capture-keys` route (the apiKey plugin lives in the dashboard, not the daemon). |
| `friday capture-key list`                                            | List Capture keys — label, prefix, created/last-used, enabled. Never shows the secret.                                                                                                                                                                                                                                   |
| `friday capture-key revoke <id\|label> [--force]`                    | Revoke (disable) a key by id or label; it stops working immediately. Prompts unless `--force`. Rotation = `create` a new one then `revoke` the old.                                                                                                                                                                      |

## Production (launchd-supervised, direct registration)

`friday start` bootstraps the launchd job via `launchctl bootstrap gui/<uid> <plist>` (or kickstarts it if already loaded) — not `brew services` (ADR-034). The launchd plist (`~/Library/LaunchAgents/com.sethvoltz.friday.plist`, written directly by the installer / CLI, not generated by any brew formula) launches `friday-supervisor` through `fnm exec` (so `process.execPath` inside the supervisor is the fnm-resolved pinned Node), which forks three children — each spawned via `process.execPath` (the pinned Node), never bare `node`/`pnpm`/`.bin` shims:

- **daemon** — `process.execPath dist/index.js` (from `services/daemon`), binds **127.0.0.1:7610**.
- **zero-cache** — `process.execPath` against `@rocicorp/zero`'s `out/zero/src/cli.js` (after running `zero-deploy-permissions` once via the same `process.execPath`), binds **127.0.0.1:4848** WebSocket. Internal-only behind the dashboard's `/api/sync` WS proxy. Spawning the cli.js directly bypasses the pnpm `.bin` shim's baked absolute `NODE_PATH`, which doesn't survive relocation into a versioned install dir.
- **dashboard** — `process.execPath server-entry.mjs` (custom adapter-node entry with the WS proxy), binds **127.0.0.1:7615**.

Each child is spawned with `detached: true` so its pid is its own process-group leader. The supervisor traps SIGTERM/SIGINT and signals each child's process group, catching grandchildren (zero-cache's worker pool, the daemon's worker forks) that would otherwise leak. KeepAlive on crash with exponential backoff; zero-cache exit code 14 (`AutoResetSignal`) is fast-restart. 5 crashes inside 60s → supervisor exits non-zero so launchd surfaces the failure.

Ports default to the prod constants. Override either via `~/.friday/config.json`'s `daemonPort` / `dashboardPort` (both optional). Zero-cache's port is fixed at 4848 (Zero's convention; if you need a parallel instance later, override via `ZERO_PORT` env at spawn time).

**RunAtLoad: true** — Friday's stack comes back automatically after Mac reboot/login, no manual `friday start`. Postgres is a separate brew service with its own RunAtLoad. The Cloudflare tunnel is a user launch agent at `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` (`cloudflared service install <TOKEN>`), also with RunAtLoad — it self-starts independently of Friday's supervisor.

**Tunnel reconcile (FRI-166).** `friday start` reconciles that cloudflared agent to desired state every launch: it keys on an explicit **serve-intent** (`config.json` `tunnel.serve`) AND token presence in the vault, not bare token presence. serve-intent on + token → ensure the agent is installed and running (from the vault token, no re-prompt); serve-intent off or no token → ensure it's stopped and removed. This makes restore-then-start bring the tunnel back on the same box automatically (DR), tears the agent down when the token is removed, and — critically — lets `friday restore` stage a second machine's token without auto-serving it (`restore` forces `tunnel.serve` off; the split-brain guard). The installed token's SHA-256 fingerprint is recorded under `~/.friday/state/` so a rotated vault token triggers a reinstall; an unchanged token is a no-op (the tunnel isn't bounced on every `start`). Flip serve-intent with `friday tunnel up` / `friday tunnel down`.

**Logs:**

- Supervisor's own events: `~/.friday/logs/supervisor.jsonl` (spawn/exit/cascade-stop trace).
- Each child's stdout + stderr: `~/.friday/logs/{daemon,dashboard,zero-cache}.jsonl` (replacing what tmux pane scrollback used to carry).
- launchd's own job-level log: `~/.friday/logs/launchd.out.log` and `launchd.err.log` (the plist's `StandardOutPath` / `StandardErrorPath`, written directly by the plist — no longer under the brew prefix since Friday's job isn't brew-generated; ADR-034).

## Dev mode for contributors

Dev is launched directly from the repo with three pnpm scripts, **not** the `friday` CLI (run each in its own terminal):

```bash
pnpm dev:zero         # zero-cache on :4848 (binds 0.0.0.0 for LAN/mobile)
pnpm dev:daemon       # tsx watch src/index.ts — daemon on :7444
pnpm dev:dashboard    # vite dev --port 5173 — dashboard on :5173
```

`dev:daemon` / `dev:dashboard` set `FRIDAY_DAEMON_PORT=7444` so the dev dashboard's SvelteKit server-side fetches reach the dev daemon (`:7444`) rather than a prod daemon (`:7610`) when both run concurrently.

**`dev:zero` is required** unless a prod zero-cache is already running on `:4848`. The launchd supervisor spawns zero-cache in prod; the dev scripts historically borrowed that prod listener, so a box that no longer hosts prod (e.g. after `friday restore` migrates serving elsewhere) had nothing on `:4848` and the dev dashboard spun on "Syncing your data" forever. `dev:zero` (`packages/cli/src/bin/dev-zero.ts`) closes that gap: it reuses the supervisor's exact env + `zero-deploy-permissions` step (`packages/cli/src/lib/zero-cache.ts`, shared with the supervisor so dev and prod can't drift) and points `ZERO_MUTATE_URL` at the vite dashboard (`:5173`, override with `FRIDAY_DASHBOARD_PORT`). In dev the Zero client connects **directly** to `http://<page-host>:4848` (no `/zero` WS proxy — that lives in the prod `server-entry.mjs`), so for phone testing run `pnpm dev:dashboard -- --host` and browse to the Mac's LAN IP; zero-cache binding `0.0.0.0` lets the phone reach both `:5173` and `:4848`.

By default, dev shares `~/.friday/` with prod — including the Postgres `friday` database. This is intentional: testing against live data is sometimes the point. **Co-running prod + dev daemons against the same Postgres DB will produce inconsistent writes** — either `friday stop` first, or use full isolation:

```bash
FRIDAY_DATA_DIR=$HOME/.friday-dev pnpm dev:daemon
FRIDAY_DATA_DIR=$HOME/.friday-dev pnpm dev:dashboard
```

For full DB-level isolation (separate Postgres database and a parallel zero-cache), additionally `CREATE DATABASE friday_dev` and point a parallel `~/.friday-dev/.env`'s `DATABASE_URL` at it; spawn a second zero-cache on a different `ZERO_PORT`. Not currently scripted — flagged for a follow-up ticket.

The `--dev` CLI flag was retired with FRI-83. `friday start --dev` now exits with citty's unknown-flag error.

## Container dev stack

Brings up a Deployment the way ADR-050 shapes the cloud one: the app as **one container** (supervisor as PID 1 over daemon + zero-cache + dashboard) against an **external** Postgres. Same image the cloud will run, which is what keeps the one-image invariant honest rather than aspirational.

```bash
docker compose up --build
docker compose exec -e FRIDAY_DEV_SEED=1 friday \
  node packages/cli/scripts/dev-seed.mjs
```

|           |                                                                    |
| --------- | ------------------------------------------------------------------ |
| Dashboard | <http://localhost:7615>                                            |
| Postgres  | `localhost:5433` (5433 so it cannot collide with a local Postgres) |
| Account   | `dev@friday.test` / `friday-dev-password`                          |

Override the account with `FRIDAY_SEED_EMAIL` / `FRIDAY_SEED_PASSWORD` / `FRIDAY_SEED_NAME`. The seed is idempotent — a second run reports the existing account and exits 0.

**The seed is not run on boot, on purpose.** It requires `FRIDAY_DEV_SEED=1` every time. An image that seeds a known account at startup is a backdoor the moment it leaves a laptop.

### Why not the host's `friday` database

zero-cache needs a logical replication slot, and a host zero-cache already holds one against the same publication — two would fight over it. The compose stack therefore runs its own Postgres with its own volume. `max_replication_slots` is raised to 20 because each Deployment's zero-cache consumes one and the server default is 10 (the ceiling ADR-051 flags for the shared-cluster arrangement).

### The provisioning split

`packaging/dev-initdb/` stands in for what the Control plane does in the cloud: a **superuser** creates the `friday` role and the `vector` extension _before_ the Deployment starts, and the Deployment's own role never holds the privilege to do either (ADR-044, ADR-051). `FRIDAY_ADMIN_DATABASE_URL` carries that superuser connection; `DATABASE_URL` carries the application one. They are deliberately different — pointing `CREATE EXTENSION` at `DATABASE_URL` fails on permissions rather than working.

### Migrating the database into a Deployment

The cutover is a database migration whose failure mode is silent: point a Deployment at a fresh Postgres and boot-time migrations create every table, the stack comes up healthy, and it is empty. You find out by noticing the tickets and chat history are gone.

**Stop the source first.** This is not optional. Measured on the first real migration: the source read 34175 blocks, the restored copy held 34176, and the source was at 34178 twenty seconds later — the daemon was running and writing throughout. A census of a live database can never match, and worse, every write between the dump and the cutover is silently lost.

```bash
friday stop                                   # source must be quiet
pg_dump -Fc -d friday -f friday.dump
pg_restore -h localhost -p 5433 -U postgres -d friday \
  --clean --if-exists --no-owner --no-privileges friday.dump
psql -h localhost -p 5433 -U postgres -d friday \
  -v ON_ERROR_STOP=1 -f packaging/pg-reassign-owner.sql
```

**The last step is not optional either.** The restore has to connect as a superuser, because the dump recreates the `vector` extension and `CREATE EXTENSION` is not a privilege the `friday` role holds. But `--no-owner` means "owned by the _connecting_ role" — so every schema, table and sequence lands owned by `postgres`, while the daemon connects as `friday`. Postgres reports a clean restore, and the daemon then crash-loops on boot:

```
daemon.fatal   permission denied for schema drizzle
PostgresError  permission denied for schema zero
```

`packaging/pg-reassign-owner.sql` hands those objects back to `friday`. It is idempotent, and it ends with a verification query that must return zero rows. (`REASSIGN OWNED BY postgres TO friday` does not work here — postgres is a bootstrap superuser and the server refuses it outright.)

Then compare row counts on both sides. `CENSUS_TABLES` in `packages/shared/src/db/row-census.ts` lists the tables whose **only** copy is Postgres — `tickets`, `blocks`, `mail`, `habits`, `schedules`, `inbox_items` and friends. A mismatch there is data loss. `memory_entries` is deliberately excluded: memory is canonical as `memory/entries/*.md` with the database as a searchable mirror, so its count can legitimately differ after a reindex.

A surplus counts as a mismatch too — a restore should reproduce the source exactly, and extra rows mean the target was not empty.

### The development container

Work that needs a git toolchain in the production runtime runs in a separate
container type, behind a compose profile so it can never start alongside the
Deployment:

```bash
docker compose --profile dev run --rm dev            # a shell
docker compose --profile dev run --rm \
  -e GH_TOKEN -e GIT_AUTHOR_NAME -e GIT_AUTHOR_EMAIL dev gh pr list
```

It is the `dev` stage of the same Dockerfile — `FROM runtime` plus `gh` — so
the Deployment image is a literal prefix of it and the two cannot drift. The
repo is bind-mounted at `/workspace`, with an anonymous volume masking
`node_modules` so the host's **darwin** native addons never leak into a linux
container.

**The Deployment does not get this toolchain, and must not.** A Deployment has
no business holding git credentials; FRI-2062 removed a cluster superuser from
it for the same reason, and a builder inside it can read the vault. Credentials
here are passed per-invocation — nothing is baked into the image, nothing sits
on a long-running service.

**`target:` is load-bearing.** `dev` is the last stage in the Dockerfile (it has
to be, being `FROM runtime`), and Docker's default target is the last stage —
so the `friday` service pins `target: runtime`. Without it the Deployment
silently builds as the dev image, `gh` and all. Any new build site for this
image must name its target.

Friday cannot spawn this container itself: workers are processes, and the
worker boundary becomes a container lifecycle in FRI-2037. This is the proving
ground for FRI-2038's per-task builder containers, operated by a human until
then.

### Cutting a real install over (the whole-machine migration)

Moving an existing Friday onto a Deployment is a superset of the database move above, and the database is the part that goes right on its own. Measured end to end on the first real cutover:

```bash
friday stop                                    # and confirm it is actually quiet
friday backup --full --include-age-key         # BOTH flags — see below
docker compose up -d postgres                  # initdb creates the role + vector
docker compose run --rm -v "$BUNDLE:/bundle.tar.gz:ro" \
  -e FRIDAY_ADMIN_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/postgres \
  --entrypoint node friday packages/cli/dist/index.js restore /bundle.tar.gz --yes
# compare the census HERE, before anything starts
docker compose up -d
friday disable                                 # stop the host job reclaiming port 7615
```

**`--full --include-age-key`, not either alone.** The default bundle is _selective_: it carries the curated `BACKUP_PATHS` and nothing else. `--include-age-key` puts `.age-key` in the tarball but selective restore never places it, and `.env` is not in the list at all — so a selective bundle silently arrives without the age identity (the vault cannot be decrypted) and without any key the operator kept in `.env`.

**Restore in a one-off container**, not the running one. `docker compose run --rm` gives you the same volumes and environment with no daemon writing underneath the restore.

**`FRIDAY_ADMIN_DATABASE_URL` is passed per-invocation, not set on the service.** Restore needs a superuser to `DROP`/`CREATE DATABASE` and clean up replication slots. The long-running `friday` service deliberately does not carry it, because the daemon spawns workers with `...process.env` and would hand a cluster superuser to every builder — see `docs/sandbox.md` § "Linux and containers" (FRI-2062).

**Compare the census before you start the stack.** Once the daemon is up it does real work — a mail sweep, an overdue schedule — and the counts legitimately diverge within seconds. Comparing afterwards cannot distinguish that from data loss.

**Clear stale agent session pointers.** `agents.session_id` is restored, but the Claude SDK transcripts it points at live under `$HOME/.claude/projects/<encoded-cwd>/` and do not migrate — `friday backup` looks for them under the agent's working directory while the daemon actually ran them from the install dir, so the capture comes back empty. The SDK then cannot resume, produces zero content, and the wedge detector restarts the worker on a loop — about 2.6 error blocks per second written into the database you just migrated. Until that is fixed, reset them as part of the cutover:

```sql
UPDATE agents SET session_id = NULL, status = 'idle';
```

Chat history is unaffected (it lives in `blocks`); only in-SDK conversational context is lost.

**Absolute host paths in the migrated `.env` are the general hazard.** `DATABASE_URL` is special-cased so the environment outranks the bundle, and compose now pins `ZERO_REPLICA_FILE` for the same reason — the bundle's value points at the source machine's home directory, and zero-cache exits on it, taking the supervised stack down with it. Anything else in `.env` holding an absolute path will behave the same way.

**Restoring inside a Deployment** works now that the image carries `postgresql-client-18`; bookworm's default client is 15 and refuses a pg18 server. Restore takes `DATABASE_URL` from the environment in preference to the bundle's, because the bundle carries the source machine's `localhost:5432` and a Deployment reaches its database as a sibling service. The superuser steps (`DROP`/`CREATE DATABASE`, the replication-slot cleanup) use `FRIDAY_ADMIN_DATABASE_URL` when set and the local socket otherwise.

### Lifecycle in a container

The container runs `tini` as PID 1 (`init: true`) with the supervisor beneath it. Node does not reap orphaned grandchildren — measured, four orphans left four `Z` entries parented to PID 1 — and agent workers spawn detached and run build tools that fork, so over a long-lived Deployment the process table fills. Signal handling was already fine (`docker stop` completes in ~0.6s, well inside the grace period); only reaping needed fixing.

`friday start` / `stop` / `restart` are aliases over `launchctl`, which does not exist here. They now **refuse with an explanation** rather than silently doing nothing, and exit 1. Lifecycle belongs to the container runtime: `docker compose stop`, or whatever restarts the Deployment in your orchestrator.

`friday status` still works and is the way to ask "is this running?" — it probes the stack instead of asking launchd, and reports `supervisor up … (container-managed)`.

### The worker-facing listener

The daemon binds `127.0.0.1`, and that bind is doing more work than it looks:
**62 of its 84 routes carry no auth flag at all**, because the router's own
comment says they "rely on the 127.0.0.1 binding + injected daemon secret
instead". Verified — `GET /api/tickets` with `Host: evil.example` and the
daemon secret returns 200. The bind is not a weak control, it is a total one.

FRI-2038 needs a worker in its own container to reach the daemon, which means
binding beyond loopback. Doing that on the existing listener would expose all
84 routes to the one network the untrusted-code container sits on.

So there is a **second listener**, off unless `FRIDAY_WORKER_LISTEN` is set
(e.g. `0.0.0.0:7611`). It serves only `WORKER_FACING_ROUTES` — four patterns —
and every request needs a per-worker bearer token:

| Route                         | Why a worker needs it                            |
| ----------------------------- | ------------------------------------------------ |
| `POST /api/mcp/<server>`      | the hosted MCP servers its SDK connects to       |
| `GET /api/memory`             | `compact-flush` reads the index to bound a flush |
| `GET /api/mail/inbox/<agent>` | `fetchInboxQuiet` drains mail at turn start      |
| `POST /api/elicitation/wait`  | the one MCP server that cannot be hosted         |

The list is short because hosting thirteen of fourteen MCP servers daemon-side
collapsed the worker→daemon surface: those handlers now self-call and never
cross a network.

**The limit is structural, not policy.** A route is unreachable from the worker
network because it is not served there — not because a check said no. A route
added tomorrow is loopback-only by default, which is the safe direction. From
a second container, measured:

```
friday:7610  (daemon)            ECONNREFUSED
friday:7611  (worker listener)   401        ← reachable, token required
GET /api/memory                  401        ← allowlisted, needs a token
GET /api/tickets                 404        ← not served here
GET /api/memory/secret           404        ← no prefix matching
POST /api/memory                 404        ← method-specific
```

Non-allowlisted routes return **404, not 403**: a route that is not served
should look absent rather than forbidden, with no confirmation of what else
the daemon runs.

The token is the per-worker credential from FRI-2037 — minted at spawn,
revoked on exit, impossible for the worker to forge. The shared daemon secret
is deliberately NOT accepted here: it sits on a volume any builder in the
Deployment container can read, so across a network boundary it identifies
nothing.

### Containerised workers

A worker normally runs as a detached child process reached over node IPC.
Under FRI-2038 it can instead run as its own container — one per Builder
assignment — which turns teardown into "stop the container" instead of a
process-tree walk, and resource limits into cgroups instead of `ulimit`s macOS
does not honour.

Both are the same five capabilities behind one seam
(`agent/worker-runtime.ts`): start it, talk to it, hear from it, ask if it is
alive, stop it. Container mode is **opt-in by configuration, not by platform** —
a laptop and a single-container Deployment both keep the process runtime:

| Variable                      | Purpose                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `FRIDAY_BUILDER_BROKER_URL`   | where the broker listens, e.g. `http://builder-broker:7612`                  |
| `FRIDAY_BUILDER_BROKER_TOKEN` | shared secret the daemon presents to it                                      |
| `FRIDAY_DAEMON_URL`           | the daemon as the **container** sees it, e.g. `http://friday:7611`           |
| `FRIDAY_WORKER_LISTEN`        | the worker-facing listener above — a worker with no way home cannot dial out |

All four are required; three of them are useless alone. The broker runs under
the `builders` compose profile (`docker compose --profile builders up`).

**The broker is the privileged seam.** Creating containers needs the Docker
socket, and mounting it into the Deployment container would be host-root
equivalent on the container that also runs the unsandboxed orchestrator. So the
socket lives in a dependency-free sidecar that does one thing, and the daemon
does **not** hand it a container spec — it supplies a task id and four env
values. The image, mounts, capabilities and limits are the broker's to decide
(`services/builder-broker/broker.mjs`), which is what keeps the privilege
proportionate.

**The channel.** A container has no parent process, so commands and events ride
one WebSocket the worker dials out to the worker-facing listener
(`/api/worker/channel`), authorised at upgrade with the same per-worker token.
One bidirectional connection rather than SSE-down/POST-up, because node IPC
gives ordering structurally and there is no general sequence number on the wire
to rebuild it from.

**A dropped channel fails the turn.** No reconnection, no replay buffer, no
resume cursor: mid-turn resumption would mean reconciling partially-written
blocks against a worker whose own view may have moved on. It reaches the daemon
as a worker exit, which is the path that already fails a turn cleanly.

Two places the container boundary is lossy, stated rather than papered over:

- **Urgency becomes a grace period.** There is no process group an outside
  caller can signal, so `SIGKILL` arrives at the broker as `?grace=0` and
  `SIGTERM` as its default stop timeout. The abort path's forced kill fires at
  500 ms; a fixed 10 s container stop would have made that deadline meaningless.
- **Descendant kills are not counted.** `abortTurn` reaps a cancelled turn's
  tool subprocesses without taking down the agent. The daemon cannot `pgrep -g`
  into another pid namespace, so it asks the worker to do it and
  `worker.abort.descendants-killed` logs `null` — not `0`, which would read as
  "nothing was running".

**The worktree is the remaining gap.** Everything above is the transport and
lifecycle — a worker can be created, driven and stopped as a container. A
_Builder_ additionally needs its worktree, and `createWorkspace` cuts a
`git worktree` against a git dir on the daemon's filesystem, which a builder
container's `/workspace` volume is not. Mounting the daemon's data dir into
the container is the wrong fix: it hands the process running untrusted
repository code a path straight past the boundary FRI-2062 drew.

So the worktree is created _inside_ the container, from a repo the **daemon
serves** over the worker-facing listener rather than one the container clones
from the real origin — the only option that works for a local-path repo (the
common case, since `worktree.repo` defaults to the daemon's cwd), and the one
that keeps any repo credential out of the container entirely. `gh pr create`
and `gh pr checks` are GitHub API calls a git route cannot serve, so those
move daemon-side as an MCP server instead of a token in the container.
FRI-2076–2080 carry the work, sequenced as 2080 → 2076 → 2077 with 2078 and
2079 independent.

**Landed (FRI-2080): the daemon knows a workspace may not be its own.** A
Builder's row records `meta_json.workspaceOwner` — `daemon` for a
`git worktree` under `<DATA_DIR>/workspaces/<name>`, `container` for a volume
at `/workspace`. An absent value reads as `daemon`, so every row written
before this keeps its meaning. Three consumers honour it:

- The invariant auditor and the boot recovery scan skip their
  `existsSync(worktreePath)` rule for container-owned workspaces. Without
  that, `/workspace` is invisible to the daemon and **every** containerised
  Builder is archived as an orphan on the first audit tick, and every tick
  after — a false alarm loud enough to train people to ignore a real one.
- `archiveWorkspace` skips the worktree removal and the directory wipe (the
  volume is the broker's to tear down) and still deletes the branch, which
  really is the daemon's once FRI-2077 forwards pushes. It derives the path
  from the agent _name_, so skipping also stops a container Builder from
  `rm -rf`-ing a leftover daemon worktree that reused the same name.
- The workspace guard keeps reading the path as its containment root, which
  is correct: the guard runs in the worker, where `/workspace` is real.

**Still missing:** the repo in `/workspace` (FRI-2076) and an image whose
entrypoint is the worker (FRI-2079) — `BROKER_BUILDER_IMAGE` currently names
the dev image, whose `CMD` is `bash`. Spawning a Builder with container mode
on logs `builder.workspace.container-not-provisioned` and gives it an empty
workspace rather than failing, so the gap shows up in the log instead of being
discovered mid-turn.

### Hostname and the reverse proxy

The stack runs behind a Caddy reverse proxy on **<http://friday.localhost>**, not bare `localhost:7615`. That is deliberate: BetterAuth derives absolute URLs, the CSRF origin list and the session cookie's `Secure`/`__Secure-` prefix from its `baseURL`, and **hard-exits** when a configured public URL is not among `trustedOrigins`. Exercising a real hostname in dev is the only way to meet that before a Deployment does.

`*.localhost` resolves to 127.0.0.1 in browsers (RFC 6761, implemented client-side), so the URL just works in Chrome, Firefox and Safari. The **macOS system resolver does not**, so curl and scripts need an explicit mapping:

```bash
curl --resolve friday.localhost:80:127.0.0.1 http://friday.localhost/login
```

`BETTER_AUTH_URL` is set to the same origin in compose. Three env vars can name the public origin — `BETTER_AUTH_URL`, `PUBLIC_BASE_URL`, and `config.publicUrl` — and all three are both trusted and asserted. Port 7615 is still published directly, so `http://localhost:7615` keeps working for anything that would rather skip the proxy.

Not covered yet: **TLS**. The cloud serves HTTPS, and BetterAuth switches the cookie to the `__Secure-` prefix on an `https://` baseURL — a difference this proxy does not exercise. Caddy can issue a local certificate from its internal CA if that path needs testing.

### Agent credentials

Agents need the Claude Code CLI **and** a credential. The CLI ships with the Agent SDK itself (eight platform-specific `optionalDependencies`, each carrying a `claude` binary) — nothing extra to install.

Set `ANTHROPIC_API_KEY`. An API key rather than the CLI's subscription OAuth, because OAuth needs an interactive login and a persisted credential directory, which an unattended Deployment cannot do — and an API key is what both arms of ADR-051's **Capacity source** reduce to.

Three places it is read, in order: `process.env`, the vault, then `~/.friday/.env`. For the compose stack, export it in the shell you run `docker compose` from; compose passes it through.

Two traps worth knowing:

- **Both env files are read, `.env.local` winning on conflict.** It used to be either/or — `.env.local` when it existed, `.env` otherwise — which was invisible on a laptop and broke on migration, because `friday restore` _writes_ `.env.local` and thereby silently orphaned every key in `.env`. The symptom was not a config error: the Deployment booted healthy and every turn answered `Not logged in · Please run /login`.
- **The musl build must stay out of the image.** pnpm installs both linux variants of the SDK's bundled binary; the SDK picks musl on a glibc image, and executing it fails with `ENOENT` for the missing loader — which the SDK reports as the misleading _"Claude Code native binary not found"_ even though the file is present. The Dockerfile prunes it in the builder stage, with an assertion so a silent re-add fails the build.

### Secrets

Integration secrets live in an age-encrypted vault at `$FRIDAY_DATA_DIR/secrets/vault.enc`. The identity that decrypts it resolves in order:

| source                      | use                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `FRIDAY_AGE_IDENTITY`       | the identity itself, for anything that can set env (Kubernetes `secretKeyRef`, ECS, Fly)             |
| `FRIDAY_AGE_IDENTITY_FILE`  | a path, for mounted secrets (Kubernetes secret volumes, Docker secrets at `/run/secrets/...`, tmpfs) |
| `$FRIDAY_DATA_DIR/.age-key` | the laptop default — unchanged when neither env var is set                                           |

**Do not let a Deployment fall through to the third row.** The key would sit on the same volume as the ciphertext it decrypts, which is obfuscation rather than encryption at rest (ADR-051). Running as PID 1 with the identity read from disk logs a warning saying so.

Nothing is configured in the compose stack because dev has no integration secrets; add one of the two env vars when you need the vault.

### Volumes

`/data` is `FRIDAY_DATA_DIR`. `/home/friday` is volumed separately because the SDK writes session transcripts to `$HOME/.claude/projects/<cwd>/<id>.jsonl`, **outside** the data dir — without it every Conversation silently starts fresh after a deploy.

To start completely clean: `docker compose down -v` (drops the Postgres data, the data dir, and the transcripts).

### What doesn't work yet

Agents can't run — the `claude` CLI is absent from the image by design, because agent auth is the Capacity source decision in ADR-051, not a packaging one. You can log in, browse, and exercise the sync path, but a turn will fail.

## Data location

Everything lives at `~/.friday/`:

```
~/.friday/
├── .env.local                 Machine-local secrets (DATABASE_URL, ZERO_AUTH_SECRET, …) — gitignored
├── .age-key                   Age identity for vault unlock — gitignored, chmod 600
├── secrets/
│   ├── vault.enc              Age-encrypted integration secrets — safe to commit
│   ├── meta.yaml              Secret names, modes, scopes — no values
│   └── recipients.txt         Age pubkey for vault.enc
├── .daemon-secret             HMAC secret for daemon-internal auth (0600 — packages/shared/src/daemon-secret.ts)
├── config.json                Settings + MCP server config
├── SOUL.md                    Your editable identity layer
├── skills/*.md                User-additive slash skills
├── agents/<name>/             Per-agent home — orchestrator/helper/scheduled cwd (ADR-029)
├── uploads/<bucket>/          Content-addressed attachments
├── memory/entries/*.md        Memory entries (mirrored to memory_entries Postgres table)
├── evolve/proposals/*.md      Evolve proposals
├── evolve/dream-diary.md      Nightly memory-dreaming journal (one block per dream run; ADR-046)
├── apps/<id>/                 Installed Friday Apps (ADR-021)
├── schedules/<name>/          Scheduled-agent state continuity (state.md + last-run.md)
├── workspaces/<name>/         Builder git worktrees
├── profiles/<name>.sb         Per-builder sandbox-exec SBPL profiles (0600 — see docs/sandbox.md, ADR-021)
├── backups/<ts>.tar.gz        Output of `friday backup` (gitignored)
├── state/                     Daemon runtime state (per-service start markers ADR-028; cloudflared-token.sha256 tunnel fingerprint FRI-166)
├── zero/replica.db            zero-cache's local replica (rebuilt from PG logical replication)
├── logs/{daemon,dashboard,zero-cache}.jsonl   Structured logs (rotated at 1 MiB)
├── usage.jsonl                Per-turn usage records
└── health.json                Daemon heartbeat (refreshed every 30s)
```

Friday's own repo is a memory like any other. Add it via the dashboard memory UI, via `friday memory add` (writes as `createdBy=user`), or by `curl POST /api/memory` with the `x-friday-caller-name` header set to the owning agent. Friday writes its own memories via the `memory_save` MCP tool. Same mechanism for any other repo or always-inject fact a builder/helper needs.

Canonical persistence lives in the **`friday` Postgres database** (host-managed via `brew services start postgresql@18`), not `~/.friday/`. The directory above carries config, secrets, and content-addressed file blobs; everything else (agents, blocks, tickets, mail, memory, schedules, apps, settings, read-cursors, client-devices) is in Postgres. See `docs/architecture.md` and ADR-023 for the topology.

Override the location with `FRIDAY_DATA_DIR=$HOME/.friday-v2 friday start`.

## Runtime env vars

Knobs that don't live in `config.toml`:

| Variable                         | Default                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRIDAY_DATA_DIR`                | `~/.friday`                | Override the data directory root.                                                                                                                                                                                                                                                                                                                                                                                    |
| `FRIDAY_TURN_STALL_MS`           | `1800000` (30 min)         | Stall watchdog threshold — a working worker with no `block-stop` for longer than this gets pgrp-SIGTERMed.                                                                                                                                                                                                                                                                                                           |
| `FRIDAY_TURN_STALE_CEILING_MS`   | `14400000` (4 h)           | Hard ceiling on a single turn (FRI-33). Any inbound IPC from a worker whose `turnStart` is older than this triggers a force-kill via `forceKillStuckWorker(reason: "stale")`. Defense against turns that stay alive past any plausible runtime (12.5h has been observed).                                                                                                                                            |
| `FRIDAY_RESPAWN_MAX_ATTEMPTS`    | `3`                        | Anti-loop cap for FRI-154 force-kill respawn: after this many consecutive respawn-then-die cycles inside `FRIDAY_RESPAWN_WINDOW_MS`, the daemon dead-letters (emits `worker.force-kill.dead-letter`, marks pending mail rows with `meta_json.dead_letter`, stops respawning).                                                                                                                                        |
| `FRIDAY_RESPAWN_WINDOW_MS`       | `600000` (10 min)          | Rolling window for the anti-loop counter above. A streak that doesn't trip the cap inside this window resets — a long-lived agent that survived 2 respawns months ago won't dead-letter on the next unrelated death.                                                                                                                                                                                                 |
| `FRIDAY_RESPAWN_BACKOFF_BASE_MS` | `1000` (1 s)               | Initial delay for the FRI-154 respawn schedule. Subsequent attempts grow as `min(2^attempts * base, cap)`.                                                                                                                                                                                                                                                                                                           |
| `FRIDAY_RESPAWN_BACKOFF_CAP_MS`  | `30000` (30 s)             | Upper bound on the exponential backoff above.                                                                                                                                                                                                                                                                                                                                                                        |
| `POSTHOG_API_KEY`                | _(unset → off)_            | PostHog project API key (the public `phc_…` token). When unset, both the daemon's `posthog-node` client and the dashboard's `posthog-js` client construct with an empty key and silently no-op — analytics are strictly opt-in. The daemon emits business + exception events; the dashboard server passes the same key to the browser for product analytics, autocapture, session replay, and client error tracking. |
| `POSTHOG_HOST`                   | `https://us.i.posthog.com` | PostHog ingestion host. Override for EU cloud (`https://eu.i.posthog.com`) or a self-hosted instance. Read by both the daemon and the dashboard (server + browser).                                                                                                                                                                                                                                                  |

> PostHog vars live in the secrets vault (`friday secrets set POSTHOG_API_KEY --daemon`). Setting the key enables analytics across the whole stack on the next `friday start`; the dashboard server reads it via `loadFridayConfig()` and forwards it to the browser through the root layout load.

## Config-file knobs (`~/.friday/config.json`)

Most behavior tunes itself; the defaults below live **in code** (never written to `.env`, and `config.json` is an _override-only_ surface — omit a key to keep the default). Optional overrides:

| Key                                               | Default              | Purpose                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemonPort` / `dashboardPort`                    | prod constants       | Bind ports (see above).                                                                                                                                                                                                                                                                                             |
| `watchdog.refork`                                 | `false`              | Re-fork a stalled worker instead of just flagging it.                                                                                                                                                                                                                                                               |
| `compaction.sweepHour` / `compaction.sweepMinute` | `3` / `30`           | Local wall-clock time the nightly compaction sweep runs (default 03:30 local). Not cron — a single daily hour:minute check.                                                                                                                                                                                         |
| `compaction.sweepThresholdTokens`                 | `100000`             | The sweep only `/compact`s a live, idle orchestrator, helper, or bare agent whose estimated live context exceeds this.                                                                                                                                                                                              |
| `compaction.autoCompactWindow`                    | `200000` (all types) | Per-agent-type SDK auto-compact ceiling (`settings.autoCompactWindow`). `Partial<Record<agentType, number>>` — a partial override keeps siblings at the code default.                                                                                                                                               |
| `tunnel.serve`                                    | `false` (absent)     | Cloudflare tunnel serve-intent (FRI-166). `friday start` installs/runs the cloudflared agent only when this is `true` AND a token is in the vault. Set by `friday setup --cloudflare` / `friday tunnel up`; forced off by `friday restore` (split-brain guard). Edit via the `friday tunnel` commands, not by hand. |

The two compaction numbers form a deliberate scheme: the sweep threshold (100K) keeps each wake's cache-creation cost low; the auto-compact window (200K) is the runaway-day backstop. See `docs/architecture.md` → _Agent lifecycle → Context compaction_.

## Cutover from old Friday

If you're running the old Slack-based Friday alongside this:

```bash
# 1. Stop the old daemon (in its own repo)
# 2. Move its data aside
mv ~/.friday ~/.friday-old

# 3. Run new setup against a fresh ~/.friday
friday setup
friday start
```

The old `~/.friday-old/` is untouched and grep-friendly.
