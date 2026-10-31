# Cloud Tickets

The canonical, verbose plan: every ticket in the initial cloud/SaaS plan, with
the constraint each one has to respect. **This file is the record of truth.**
The same tickets are loaded into Friday's own `tickets` table so Friday can work
them functionally, but that copy is operational — it lives in one Postgres
database, while this one is in git. If the two ever disagree, this wins.

Ids run from `FRI-2001`. The first 51 (`FRI-2001`–`FRI-2051`) were the initial
plan; later ids are work uncovered while executing it, filed under the epic they
belong to — or under **E6**, the cleanup/backlog epic, when they block no epic
at all. The counter was seeded past the
external tracker's range (~200 `FRI-nnn` identifiers are already referenced
throughout these docs) so locally-created ids cannot collide; see the
short-UUID entry in [decisions.md](decisions.md) § Watch list for the durable
fix.

**Where this sits.** [decisions.md](decisions.md) (ADR-050 — ADR-054) owns _why_
and what was rejected. [cloud-plan.md](cloud-plan.md) owns the _epics, their
order, and what runs in parallel_ — read that first for the shape. This file
owns _the work_, one entry per ticket. Vocabulary is in
[CONTEXT.md](../CONTEXT.md).

**Working channel.** Claude Code remains the primary channel. The original
expectation was to switch to Friday itself during or shortly after E1; the
cutover showed that is further out than it looked. Friday in the Deployment
container cannot do development work at all — no repo mirrors, no `.git`, no
`gh`, no git identity, no credentials — and giving it those is explicitly the
wrong move (FRI-2071). Workers are processes, so Friday cannot spawn a
toolchain container either until FRI-2037 makes the worker boundary a container
lifecycle and FRI-2038 lands per-task builders.

What works today is the split: **Friday coordinates** — it owns these tickets,
the planning and the memory — while edits happen in Claude Code or the
development container (FRI-2071). The dogfood gate did what it was for; it just
bought parity of _runtime_, not of _toolchain_.

Parents are named per ticket rather than written as `ticket_relations` rows —
there is no service or CLI helper that writes that table (see the watch list).

---

## FRI-2001 — E1: Dev–cloud parity: the container

`epic` · ADR-050, ADR-051 · 18 tasks

Goal: the stack runs as one container (supervisor as PID 1) against external
Postgres, from the same image the cloud will use.

Done when the daily driver runs that image rather than a `launchctl`-managed
local install, with row counts verified against the pre-cutover database.

**The only hard gate in the project.** `checkDeps()` reports a hard failure
forever on a box without Homebrew and the supervisor _parks_ the stack, so
there is no Linux target to verify anything against until this lands.
Order within the epic: get it booting early, even imperfectly, then harden —
doing all thirteen tasks before the first boot attempt front-loads every
unknown at once.

### FRI-2002 — Linux container build for the Friday stack

`task` · parent FRI-2001 · ADR-050

CORRECTION (2026-10-14): an earlier version of this ticket said
`pack.mjs`'s `platformTag()` "refuses any non-darwin arch". It does not — its
`osMap` is `{ darwin, linux }` and it fails only on an unrecognised _arch_. The
real gap is narrower: there is no Linux leg in the release matrix
(`.github/workflows/release-publish.yml` ships darwin arm64 + x64 only).

That reframes the work. ADR-050 makes the **container** the unit of deployment,
so Friday does not need a Linux _tarball_ at all — `pack.mjs` and the tarball
stay as the darwin enterprise/self-hosted install path, untouched. This ticket
is a Dockerfile and an image build.

Chosen approach: the Dockerfile runs `pnpm install --frozen-lockfile` and
`pnpm run build` inside a builder stage, rather than staging a tree with
`pack.mjs` and COPYing it in. Self-contained and standard, and it sidesteps
upgrade gotcha #5 entirely — nothing is relocated, so there are no absolute
symlinks to rewrite.

Constraints that hold either way:

- **No cross-compile.** `better-sqlite3`, `@rocicorp/zero-sqlite3`, `esbuild`
  and `sharp` resolve prebuilds by `process.arch`, so build on the target arch
  or via `buildx --platform`.
- **Postgres stays out of the image** (ADR-050): `CREATE EXTENSION vector`
  needs SUPERUSER, `wal_level=logical` is server-level, and it is the only
  canonical state — a container restart must never sit in front of the
  customer's only copy of their data.
- **Runtime packages `node:*-slim` omits.** `procps` is required because the
  supervisor and worker teardown shell out to `pgrep -P` / `pgrep -g`; `git`
  for builder worktrees and the bare mirrors under `$FRIDAY_DATA_DIR/repos`;
  `bash` because `lifecycle.ts` spawns `/bin/bash -c '<ulimit prelude>; exec
"$@"'`.
- **`HOME` needs a volume, not just `FRIDAY_DATA_DIR`.** The SDK writes session
  transcripts to `$HOME/.claude/projects/<cwd>/<id>.jsonl`, outside the data
  dir; without them every Conversation silently starts fresh after a deploy
  (FRI-2007).

Definition of done is "the image builds and starts the supervisor" — not "comes
up healthy". It cannot yet: FRI-2003 still has to replace the Homebrew gating in
`checkDeps`, which hard-fails in a container and makes the supervisor _park_ the
stack rather than fail loudly. The `claude` CLI is also deliberately absent —
agent auth is ADR-051's Capacity source decision, not a packaging one.

### FRI-2003 — Replace Homebrew preflight with a container-appropriate `checkDeps`

`task` · parent FRI-2001 · ADR-050

`resolveBrew()` probes `/opt/homebrew/bin/brew`, then `/usr/local/bin/brew`,
then a bare `brew` that does not exist on Linux — so `brewListHas('pgvector')`
fails permanently and the supervisor **parks the stack rather than failing
loudly**. Verify pgvector and `wal_level=logical` by SQL against the database
instead of by `brew list`, and make the failure message actionable for someone
who has never used Homebrew.

### FRI-2004 — Make the Postgres connection fully configuration

`task` · parent FRI-2001 · ADR-051

`FRIDAY_DB` and the default
`postgresql://${process.env.USER ?? "postgres"}@localhost:5432/…` are hardcoded
in roughly five places in `pg-provision.ts`, and `adminConnectionUrl()` assumes
the OS user is superuser (true under Homebrew, false everywhere else). Host,
port, database, user and password all become configuration, and **nothing may
assume a stable host** — that assumption is precisely what would make the later
shared→dedicated server move expensive.

### FRI-2005 — Move `CREATE EXTENSION vector` off the boot path

`task` · parent FRI-2001 · ADR-051, ADR-044

`ensureVectorExtension()` needs SUPERUSER, and on a shared cluster one
superuser credential covers every Deployment's database — so a Deployment
holding it could read every Organization's data. Provisioning creates the
extension; `checkDeps` only _verifies_ it is present and fails with an
actionable error; the Deployment's own role stays non-superuser and scoped to
its database. Same hazard class ADR-044 describes from the other direction.

### FRI-2006 — Supervisor as PID 1

`task` · parent FRI-2001 · ADR-050

launchd `KeepAlive` semantics become the container restart policy. Needs
signal handling as init (reaping, SIGTERM propagation to the three children),
and a review of `pgrepDirectChildren()`/`killDescendantTree()` which shell out
to `pgrep -P`. `friday start`/`stop`/`restart`/`status` lose their `launchctl`
backing and need a container-appropriate meaning or a deprecation.

### FRI-2007 — Persistent volumes: data dir and `~/.claude/projects`

`task` · parent FRI-2001 · ADR-050

The SDK session transcripts live at
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — **outside**
`FRIDAY_DATA_DIR`, under the real OS `$HOME` — which is why `backup --full`
captures them explicitly. Without them the SDK silently starts a fresh session,
so every **Conversation** loses its continuity on each deploy. They need a real
volume. `~/.friday/zero` may be ephemeral: it re-COPYs from Postgres, and
`FULL_EXCLUDE` already treats it as regenerable.

### FRI-2008 — Drop the `$SHELL -ilc` environment capture

`task` · parent FRI-2001 · ADR-050, ADR-054

`captureShellEnv` spawns the user's interactive login shell to learn PATH and
toolchain locations, assuming a human has configured `~/.zshrc` on the box. A
container has no such shell. Replace with an explicitly constructed environment
for workers and for stdio MCP servers (`resolveStdioCommand` rewrites bare
`node`/`npx` to the pinned Node's sibling). This is also a prerequisite for
scrubbing the worker env, since `shellEnv` is one of the two sources that
leaks.

### FRI-2009 — Verify `.daemon-secret`'s `0600` check against the real mount

`task` · parent FRI-2001 · ADR-050

`getDaemonSecret()` reads `~/.friday/.daemon-secret` and **fatally exits if
any group or other permission bit is set**. Container volume and secret mounts
do not reliably preserve file modes, so this either keeps working or
crash-loops every Deployment at boot, with no degraded path and a confusing
error. Verify against the actual mount implementation before first deploy; if
the mode cannot be guaranteed, the check becomes "present and well-formed" with
the confidentiality guarantee coming from the mount rather than from `stat`.

### FRI-2010 — Inject the age identity at runtime

`task` · parent FRI-2001 · ADR-051, ADR-054

Otherwise `~/.friday/.age-key` sits on the same persistent volume as the
`vault.enc` it decrypts — obfuscation, not encryption at rest, and the first
thing a security questionnaire catches. The identity comes from the platform
secret manager into memory or tmpfs. The source must be **pluggable**, not bound
to one cloud's API, so a self-hosted Deployment can supply its own (their Vault,
their KMS, or a mounted file). The five auto-generated platform secrets move
there too instead of being written into `.env.local` on first boot.

### FRI-2011 — Local reverse proxy and hostname for BetterAuth parity

`task` · parent FRI-2001 · ADR-050, ADR-051

BetterAuth resolves `baseURL`/`trustedOrigins` from the configured public URL
and **hard-exits via `process.exit(1)`** when they disagree, so dev has to
exercise a real hostname or the cloud path is untested. Retires `cloudflared`
from the dev path — it is installed via `cloudflared service install` into
`~/Library/LaunchAgents` and driven by `launchctl`, neither of which exists on
the supported target.

### FRI-2012 — Scrub the worker environment

`task` · parent FRI-2001 · ADR-054

Pulled forward from the isolation epic: the worker env has to be constructed
explicitly for a container anyway, since there is no login shell to capture.

CORRECTION (2026-10-14): an earlier version of this ticket claimed the daemon's
`process.env` carries `DATABASE_URL` and the daemon secret into every worker. It
does not. `getDaemonSecret()` reads `~/.friday/.daemon-secret` and
`DATABASE_URL` comes from `loadFridayConfig()` reading `.env.local`, so ADR-037
already keeps `process.env` clean of both. Measured on the dev box: the daemon
has 20 environment variables and none of them is a secret.

What this control actually addresses — both real, both narrower:

1. **`SSH_AUTH_SOCK` is forwarded into every worker**, sandboxed builders
   included. No credential is readable, but the capability is delegated:
   anything in the worker, a postinstall script included, can authenticate as
   the operator over SSH to any host or repository their keys reach.

2. **The `$SHELL -ilc` capture makes the worker env a function of the
   operator's dotfiles.** `captureShellEnv()` at worker.ts:84 is applied at
   worker.ts:521 as `{ ...process.env, ...shellEnv }` — measured, 20 variables
   becomes 65. Unbounded and machine-dependent: a developer who exports
   `GITHUB_TOKEN` or `ANTHROPIC_API_KEY` from `.zshrc` forwards it into every
   worker. Untenable once the worker runs untrusted customer code.

Fix: construct the worker env from a known allowlist (PATH, HOME, LANG, TMPDIR,
the COREPACK/CI overrides, plus whatever the toolchain genuinely needs) instead
of spreading `process.env`, and drop `SSH_AUTH_SOCK` unless a task explicitly
needs git over SSH. Pairs with FRI-2008, which removes the shell capture — do
them together, since the capture is the larger half of the surface.

Not the emergency the original framing implied; an ordinary E1 item.

### FRI-2013 — Data migration path to external Postgres

`task` · parent FRI-2001 · ADR-050, ADR-051

The cutover is a database migration, and the failure mode is silent: point a
container at a fresh external Postgres and **migrations run on boot and create
empty tables, which looks perfectly healthy.** You would discover it by noticing
the tickets and chat history were gone.

Note the asymmetry in what is at risk. Memory entries are canonical as
`memory/entries/*.md` with the database as a searchable mirror, so memory
survives a database loss. `tickets`, `blocks`, `mail`, `habits`, `schedules` and
`inbox_items` exist **only** in Postgres — one copy.

Covers: the one-time move (`pg_dump` → restore → verify row counts), the
shared→dedicated server move ADR-051 defers, and the `wal_level`/pgvector/
replication-slot prerequisites on the destination. `friday backup` already runs
`pg_dump` into `postgres.dump` as step 1 of every bundle (sha256 in the manifest
as `postgresDumpSha256`), and `friday restore` deliberately leaves the tunnel
dark to avoid split-brain — so there is precedent for restore being a staged,
careful operation rather than an automatic one.

### FRI-2060 — Agent auth: the `claude` CLI and credentials in the image

`task` · parent FRI-2001 · ADR-050, ADR-051

Agents cannot run in a Deployment: the `claude` CLI is absent from the image
by design, and nothing supplies agent credentials. The dashboard serves, sync
works and data is intact, but no turn can complete — so FRI-2014's cutover
would hand over a Friday that cannot do the one thing it exists for.

Split out of FRI-2014 deliberately. The container must be proven to run a real
turn BEFORE data moves into it; folded together, auth problems surface while
the daily driver is down and the migration is half-finished. This half is
safe and iterable — build, run a turn against the compose stack with the
throwaway dev account, repeat — at no risk to real data.

TWO PIECES.

1. The CLI binary. `@anthropic-ai/claude-agent-sdk` ships no executable: it
   resolves one through `pathToClaudeCodeExecutable` and errors "Claude Code
   executable not found" when absent (verified in node_modules 0.2.132 —
   `bin` is null). `doctor` checks `which claude` and suggests a curl|bash
   installer or `brew install --cask`, neither of which suits an image.
   Prefer a pinned npm install of the CLI package over curl|bash: ADR-034
   pins GitHub Actions by full SHA precisely because an unpinned third-party
   fetch is a supply-chain injection point, and the same reasoning applies to
   an installer piped into a Dockerfile.

2. Credentials, and this is the decision. The SDK's child gets its
   authentication from the environment. Two mechanisms exist:
   - **API key** — headless, no interactive step, and it is what BOTH arms of
     ADR-051's Capacity source reduce to (`friday` = our org key, `byo` = the
     customer's). `ANTHROPIC_API_KEY` is already a supported vault secret, so
     the plumbing is mostly there.
   - **Subscription OAuth** — the `claude` CLI's logged-in session. Needs an
     interactive login and a persisted credential directory, and cannot work
     for an unattended Deployment.

   RECOMMENDATION: API key. Subscription auth stays the local-dev convenience
   it already is. Baking a laptop-shaped login into the image would be a dead
   end for E5.

WATCH FOR: FRI-2059 is about to put a denylist on the Claude Code child's env.
The credential this ticket adds must NOT be on it — that is exactly the
conflict FRI-2059's note about "the CLI needs its own Anthropic credentials"
anticipates. Land them in either order, but test a real turn after both.

DONE WHEN a turn completes end to end in the compose stack: send a message
through the dashboard as the dev account and get a reply, with the worker
spawning and exiting cleanly. Not "the binary is present" — the binary being
present is the easy half.

### FRI-2014 — Cut the daily driver over to the container image

`task` · parent FRI-2001 · ADR-050

The dogfood gate. Makes ADR-050's one-image invariant self-enforcing rather
than aspirational, and turns this install into the first self-hosted Deployment
— so the standalone-mode seams the enterprise tier needs get exercised
continuously instead of built blind at the end.

**Gated on verified row counts against the pre-cutover database, not on the
stack booting.** Booting proves nothing here: empty tables boot fine. Take a
`friday backup` immediately before and confirm the bundle restores.

---

### FRI-2053 — Log to stdout in a container, not only to files

`task` · parent FRI-2001 · ADR-050, ADR-051

Discovered running the FRI-2002 image: `docker logs` is **empty**. The
supervisor writes only to `$FRIDAY_DATA_DIR/logs/supervisor.jsonl`, and the
daemon, dashboard and zero-cache each write their own files alongside it.

Container platforms collect stdout/stderr. File-only logging means no log
aggregation for any **Deployment**, which is the concrete form of the "no
observability" risk ADR-051 names — and ADR-051 also needs per-Deployment
migration telemetry and synthetic health probes, none of which can reach us
through a file inside a container.

Two aggravating details: the log files sit on the Deployment's volume and grow
unbounded, and `backup.ts`'s `FULL_EXCLUDE` deliberately drops `logs/` — so
they are neither collected nor backed up.

Fix: emit JSONL on stdout (the format is already right for collectors) when
running in a container, either by switching destination on an env flag or by
dual-writing. Covers all four processes, not just the supervisor.

### FRI-2052 — CLI hangs 30s after every command — pg pool never closed

`task` · parent FRI-2001 · ADR-050

Every `friday <subcommand>` except `doctor` finished its work in well under a
second and then sat idle for ~30s. `getDbAndPool()` builds a pg `Pool` with
`idleTimeoutMillis: 30_000`; `closeDb()` existed but only `doctor` called it,
and the CLI entry point had no teardown. The idle client kept a live socket on
the event loop, so Node refused to exit until the timer fired.

Measured: `time friday tickets ls` → 30.48s wall, 0.49s user, 1% CPU. Blocked,
not computing. Fixed with a root `cleanup()` that calls `closeDb()`.

### FRI-2058 — Does BetterAuth enforce trustedOrigins on sign-in?

`task` · parent FRI-2001 · ADR-051

Filed as an observation, not a confirmed vulnerability, so it would get a
proper look rather than be asserted either way from inference. A sign-in POST
carrying `Origin: http://evil.example` — an origin never in `trustedOrigins` —
returned 200 with a valid session cookie.

Pre-existing, and NOT introduced by FRI-2011, which only added
`PUBLIC_BASE_URL` to the trusted list. Resolved: closed after review.

### FRI-2065 — Claude SDK transcripts are never captured, so migrated agents wedge-loop

`bug` · parent FRI-2001 · ADR-050

`friday backup --full` reported **0 claude session(s)** on an install whose
agents all had live sessions. Backup derives the project dir from
`agentWorkingDir` (`~/.friday/agents/<name>`); the daemon actually ran those
agents from the install directory, so the encoded-cwd never matches and the
capture finds nothing.

`agents.session_id` IS restored while the transcripts are not, so after a
migration every agent points at a session the SDK cannot resume, produces zero
content blocks, and the wedge detector restarts the worker — measured at ~2.6
error blocks/sec with no backoff and no ceiling. The cutover currently needs a
manual `UPDATE agents SET session_id = NULL` (documented in `running.md`).

Stays on E1 rather than moving to the backlog: FRI-2050's export and ADR-051's
shared→dedicated move both inherit this backup-fidelity gap.

---

## FRI-2015 — E2: Multi-user in one Deployment

`epic` · ADR-051, ADR-052, ADR-053 · 14 tasks

Goal: several Users share one Friday — identity, **Role**, **Scope**, and
per-User **Conversation**s.

Done when a second account can be added, holds its own Conversation, and cannot
read the first's personal-Scope rows.

Depends on E1. **Does not depend on E5** — the standalone auth mode is what
ships today, so multi-user lands without a Control plane.

### FRI-2016 — Thread the acting User through the turn

`task` · parent FRI-2015 · ADR-052, ADR-053

**Do this first; it is the only cross-epic chokepoint.**
`buildSystemPrompt` and `buildDispatchPrompt` take only an agent row and a
`DispatchIntent` — no user id reaches prompt assembly at all, even though
`blocks.user_id` is sitting on the originating row. The MCP loopback handlers
already carry `x-friday-caller-name`/`x-friday-caller-type`, so an acting-User
header is the natural extension of a pattern already in place.

One change serving three obligations: ADR-052's prompt identity (so Friday can
address whoever is speaking), ADR-053's role gate, and the audit/erasure stamp.
Unblocks E2 and E3 together.

### FRI-2017 — Organization entity; setup creates the org and the first User

`task` · parent FRI-2015 · ADR-051

One row holding what is true of the company rather than of a person: name, SSO
domain allowlist, the org-owned SOUL. The BetterAuth organization plugin is the
intended vehicle — it brings memberships and roles with migrations, the same
bargain already accepted for `apikey` under ADR-015. **No `org_id` on any domain
table**: one Deployment is one Organization by construction.

### FRI-2018 — Allow Users beyond the first

`task` · parent FRI-2015 · ADR-051

There is no code path that adds a second human. `emailAndPassword` is
configured `disableSignUp: true` ("Public sign-up is permanently disabled"),
`resolveSoleUserId()` deliberately returns the earliest-created `user` row, and
`friday setup` offers only "keep" or "DELETE the user account" when one exists.
Invites are the bootstrap; SSO through the Control plane becomes the model once
E5 exists, at which point `disableSignUp: true` stays true and becomes
_correct_ — a Deployment never signs anyone up, it accepts assertions.

### FRI-2019 — `Role` (`admin | member`) at the MCP tool gate

`task` · parent FRI-2015 · ADR-053

Tools are filtered at registration by _calling agent type_ only —
`friday-agents`, `friday-schedule`, `friday-evolve`, `friday-apps` and
`friday-inbox` are orchestrator-only, `friday-secrets` is open to every type but
`scheduled`. With per-User Conversations that means every employee can install
Apps, manage agents, spawn builders against company repos, and fetch stored
credentials. Extend the gate to **agent type × Role**, carrying the acting-User
header. Role is orthogonal to agent type, not a replacement.

### FRI-2020 — `Conversation` entity

`task` · parent FRI-2015 · ADR-052

Keyed by (**User**, agent) and spanning every **Transport** — one continuous
thread that Slack, email and the web dashboard are doorways into, with one SDK
session per pair. `blocks` gains a conversation dimension.

Deliberately **not** per-User agents: `agents.name` is the primary key that
`mail.from_agent`/`to_agent`, `blocks.agent_name` and `read_cursors` all
reference by bare string, so there can only ever be one `orchestrator`. This is
a schema change to the most-written table.

### FRI-2021 — Re-key `read_cursors` to include the User

`task` · parent FRI-2015 · ADR-052

Currently keyed `(device_id, agent_name)` — per device, not per human — and
the dashboard reads it with a deliberately global Zero query whose comment says
"Friday is single-user." Unread state has to become per-User, not per-browser.

### FRI-2022 — Split the `settings` singleton

`task` · parent FRI-2015 · ADR-053

`settings` has its primary key pinned to the literal `'singleton'` by a CHECK
constraint, yet it holds **Theme**, `notify_policy`, the DND window and model
picks — all personal-**Scope** under ADR-053. Needs an install-global half and a
per-User half. (`web_push_vapid`'s singleton is correct — one push identity per
Deployment — leave it alone.)

### FRI-2023 — Per-User predicates on Zero reads

`task` · parent FRI-2015 · ADR-053

Every Zero-synced table carries `{ row: { select: ANYONE_CAN } }` under a
comment reading "Friday is single-user … every authenticated client reads every
row. Phase 4 layers in cell-level or row-conditional rules if the auth model
grows." This is Phase 4. Without it, one employee's browser **replicates
another's private conversation blocks** — the rows reach the client, so it is not
a rendering problem. The Zero JWT already carries `userId` in its claims, so this
is writing predicates, not plumbing identity. Also fix the dashboard's global
`#bindReadCursors` and `#bindClientDevices` queries.

### FRI-2024 — Ownership checks in mutators

`task` · parent FRI-2015 · ADR-053

Zero has **no insert/update/delete row rules at all** — writes are authorized
exclusively by server-side mutator functions (Zero 1.5+ deprecates row-level
write permissions in favour of mutator-defined authz), and none of them check
ownership today. Every mutator touching a personal-Scope table needs a "may this
User write this row" check.

### FRI-2025 — Stamp the acting User on org-Scope tables

`task` · parent FRI-2015 · ADR-051, ADR-053

`memory_entries.created_by`, `ticket_comments.author` and `mail` attribute to
_agent_ names (`"friday"`, `"kitchen"`); `blocks.user_id` exists but is
attribution-only. Record the acting human even while these tables stay
org-visible — authorship not captured **cannot be backfilled**.

Prerequisite for two obligations, not hygiene: the audit question "who asked
Friday for our credentials" (`secrets_fetch_log` records only the agent), and
erasure — you cannot delete what you cannot attribute.

### FRI-2026 — One org SOUL with dynamic addressing

`task` · parent FRI-2015 · ADR-052

`~/.friday/SOUL.md` is a single file whose `{{YOUR_NAME}}` was substituted once
from `process.env.USER` at first boot and never re-derived, and the prompt
instructs the agent to "Hold the form — don't drift between '<name>', 'Sir', and
no-address mid-conversation." So a ten-person company gets an assistant that
calls everyone by the installing user's shell username. The Address rule becomes
"address the User who is speaking, by their name," and the file stops being
documented as "your editable identity" — it is shared character, so it becomes
admin-owned.

### FRI-2027 — Narrow the evolve pipeline to what a Deployment can act on

`task` · parent FRI-2015 · ADR-053

`evolve_proposals` carries five types — memory, docs, code, prompts, tooling —
and **four of them propose changes to the product, not the customer's data**.
Code ships as an immutable image, so patching it in place breaks the one-image
invariant and every fleet update. `CONSTITUTION.md` and `agents/<type>.md` are
code-owned, read from the bundled package directory and never copied into
`~/.friday/`. docs and tooling are the repo. Only **memory** is unambiguously
the customer's own.

Evolve works beautifully for an audience of one who is also the maintainer, and
mostly does not translate. Ship: memory hygiene, consolidation, the Dream Diary,
and org-level prompt tuning through the admin-owned `SOUL.md`. Remove the
code/docs/tooling paths from the product surface, and consider dropping
`evolve_proposals` from `SYNC_TABLES` if the surface shrinks enough (it is the
table that caused the `SchemaVersionNotSupported` reload-loop once already).

Two consequences: applying a proposal becomes **admin**-only under the Role
split, and `evolve_critical`'s DND bypass needs rethinking — "Friday wants to
change itself" is a reasonable 3am interrupt for a maintainer and an odd one for
an employee.

### FRI-2028 — Revocation, and an admin-initiated per-User erasure action

`task` · parent FRI-2015 · ADR-053

Departure is **revoke, not erase** — sessions (`revoke`/`revoke-all` exist),
devices (`client_devices.revoked_at`), and **Capture key**s (the BetterAuth
apiKey plugin has revocation built in), with data preserved so the
Organization's record stays whole. The Organization is the data controller, so an
individual's erasure request goes to their employer.

**But the capability must exist**: an admin needs an explicit per-User erasure
action to honour a controller instruction when it arrives. Depends on the
acting-User stamp.

### FRI-2070 — No account recovery path exists

`task` · parent FRI-2015 · ADR-053

After the FRI-2014 cutover the Deployment holds exactly one account, with a
password set during `friday setup`. There is no way to change or reset it: no
`friday` command touches passwords, nothing implements
`forgetPassword`/`setPassword`, and the dashboard sets `disableSignUp: true`,
so a second account cannot be created as a way around it. A forgotten password
locks the owner out of their own install, data intact and unreachable.

Arguably "use your password manager" for a single-user laptop. It stops being
that in E2: once an admin adds and revokes Users (FRI-2018, FRI-2028), an admin
must be able to reset a member and a member must recover without the admin
holding their password. Same surface as ADR-053's revocation.

Constraint to respect: any reset must go THROUGH BetterAuth so the hash format
matches what the dashboard verifies — never hand-written SQL into
`account.password`. Self-service recovery needs email delivery, which a
Deployment does not have, so it may belong to the Control plane as identity
provider (FRI-2046); settle that before building a per-Deployment mail path.

---

## FRI-2029 — E3: Transports

`epic` · ADR-052 · 7 tasks

Goal: **Transport** as a first-class concept with per-Transport **Transport
style**; Slack first.

Done when a Slack thread drives a turn and Friday replies into that thread, as
the right **User**, in Slack's register.

Depends on E1 and on threading the acting User through the turn. **Does not
depend on E5**: for dogfooding, point one Slack app straight at the Deployment —
the central verify-and-route shim is an E5 refactor, which is what keeps this
epic off the Control plane's critical path.

Coarse by design — refine when reached.

### FRI-2030 — Transport registry and Transport style

`task` · parent FRI-2029 · ADR-052

Each Transport declares its own register — brevity, level of detail, cadence,
formatting — because the right answer differs sharply by medium. Follow ADR-047's
routing-target registry pattern (declarative natural-language `guidance`
contributed per entry and merged into the prompt), **not** a parallel prompt stack
like the Intake persona. A Transport style modulates the assistant persona; it
never replaces the SOUL.

### FRI-2031 — Webhook receiver with per-provider signature verification

`task` · parent FRI-2029 · ADR-052

**No webhook receiver exists anywhere in the repo** — a grep for webhook
handlers returns zero hits, and Linear today is outbound-only (`reconcile()`
polls the API, `importIssue()` pulls on demand). Only `/api/capture` is reachable
without a session, gated by its own `x-api-key` check. Each provider has its own
signature scheme.

### FRI-2032 — `user_identities` mapping

`task` · parent FRI-2029 · ADR-052, ADR-051

`(provider, external_id) → User`, where `provider` covers `slack`, `email`,
`linear`, `jira` — not only login providers. The BetterAuth `accounts` table
exists for OAuth links but has no provider configured.

**A Transport identity match is identification, not authorization.** Resolving a
Slack ID to a User says who is speaking; whether that User may drive an agent is
a separate check. Keeping these distinct is what prevents Slack workspace
membership from becoming sufficient to run an agent.

### FRI-2033 — External thread to Conversation and reply target

`task` · parent FRI-2029 · ADR-052

A Slack `thread_ts` or an email `Message-ID` chain resolves to a Conversation
plus where the reply goes. A small mapping table, **not** a conversation
dimension — a User starting two Slack threads feeds one Conversation but replies
route to two different targets. The Transport is per-turn context: it decides the
reply's style and destination, never the Conversation's identity.

### FRI-2034 — Slack Transport end-to-end

`task` · parent FRI-2029 · ADR-052

The dogfood target and the first real Transport. Rides the seam that already
exists: `sendUserMessage` writes a `blocks` row at `status='pending'`, a trigger
fires `NOTIFY friday_new_pending_block`, and the daemon's LISTEN handler
dispatches the turn — so anything that can write that row can start a turn. This
is not a second pipeline.

### FRI-2035 — Web dashboard as a Transport

`task` · parent FRI-2029 · ADR-052

Unify so the durable-thread case is not a special case: the web UI becomes a
Transport whose external thread happens to be long-lived. Keeps the rule uniform
— every turn arrives on a Transport — and avoids a branch in reply routing.

### FRI-2067 — CLI Transport: a local terminal client against a remote Deployment

`task` · parent FRI-2029 · ADR-052, ADR-050, ADR-053

A local command-line client that talks to a REMOTE Friday and feels like the
original Claude Code. This is a **Transport** in ADR-052's sense, not a second
application: it gets its own **Transport style** (terse, streaming, no markdown
a terminal cannot render) and joins the SAME Conversation the web dashboard and
Slack see — a good forcing function for that decision, because a terminal user
notices missing context immediately.

Distinct from today's `friday` CLI, which is local administration over a
loopback daemon. This authenticates to a Deployment's public surface as a User
and holds no local state.

Constraint to respect: do not start before FRI-2030's Transport registry, or it
becomes a bespoke integration instead of a Transport. The sizing question is
whether it executes tools LOCALLY — a view onto a remote agent is small; a
local tool-execution bridge is a much larger design and should be split out.

---

## FRI-2036 — E4: Agent isolation

`epic` · ADR-054 · 19 tasks

Goal: agent execution moves into containers; the container is the sandbox.

Done when builders run in per-task containers with egress deny-by-default and
ADR-054's remaining controls are in place.

Depends on E1, where control 1 (the scrubbed environment) already landed.

**The exposure this epic closes, stated plainly:** the orchestrator runs
unsandboxed with `permissionMode: "bypassPermissions"` as the daemon's OS user,
and once E3 lands it is driven by any User over any Transport. E3 before E4 is a
deliberate, time-boxed exposure, not an oversight.

Coarse by design — refine when reached.

### FRI-2037 — Worker boundary as a protocol seam

`task` · parent FRI-2036 · ADR-054

`wakeAgent`/`wakeAgentCritical` are IPC calls, `peekLiveWorker` inspects an
in-process handle, and `killDescendantTree` walks `pgrep -P`. All three become a
network protocol and a container lifecycle. Build the seam from the start rather
than retrofitting it — the per-worker env, the stdio-only MCP transport, and the
`~/.claude/projects` transcript path all have to be handled per-worker anyway,
and doing that twice is the expensive version.

### FRI-2038 — Per-task builder containers

`task` · parent FRI-2036 · ADR-054

Per **task**, not per turn: a Builder's worktree must survive turns
(uncommitted changes, `node_modules`, an in-progress branch). State the guarantee
honestly as **bounded to one assignment** — `.git/hooks/*` and `node_modules` are
executable surfaces that survive a reattached volume, so per-turn ephemerality
would be largely illusory. Upside: teardown becomes "stop the container" instead
of the `setsid`-escape tree walk listed as residual risk #2, and resource limits
become cgroups instead of Darwin-honoured `ulimit`s.

### FRI-2039 — Egress deny-by-default

`task` · parent FRI-2036 · ADR-054 · **done**

Allowlist the git host and package registries, nothing else — this removes the
payoff from most supply-chain compromises: a malicious postinstall can run, but
cannot exfiltrate or phone home. **Verify the allowlist is destination-based and
denies link-local**, because the cloud metadata endpoint (`169.254.169.254`) is an
_account_-level compromise rather than a Deployment-level one: steal the host's
IAM credentials and the blast radius is the whole cloud account. Launch gate.

**The allowlist came out smaller than this ticket assumed.** The git host is
not on it: FRI-2076/2077 put git behind the daemon's own route and FRI-2078 did
the same for the GitHub API, so a builder reaches neither directly. What is
irreducible is `api.anthropic.com` — the Claude SDK runs INSIDE the worker, so
the process doing the untrusted work is also the one that must reach the model
— plus the package registries a build installs from. A test pins the absence of
`github.com` so it cannot drift back in.

**The deny half is topology, not policy.** The builder joins a Docker network
declared `internal: true`, which Docker gives no gateway. Measured from inside
one: a public address and `169.254.169.254` both answer `ENETUNREACH`, and
external names do not resolve (`EAI_AGAIN`). The metadata endpoint is therefore
unreachable because no path to it exists — the strongest form the ticket's
requirement can take. Container names still resolve, which is what lets the
worker reach the daemon at all; and the builder does not need external DNS
because the proxy resolves on its behalf, which is ordinary CONNECT semantics.

Dropping `BROKER_BUILDER_NETWORK: friday_default` is most of the fix: on the
default compose network a builder had full internet access **and** could reach
Postgres and zero-cache directly. Putting builders on their own internal
network also delivers most of FRI-2040 as a side effect.

**The allowed hole is a CONNECT proxy on the worker-facing listener**, not a
sidecar. Enforcement cannot live in the container — it runs `CapDrop: ALL`, so
in-container firewall rules are unavailable and would anyway be removable by
the code they constrain. The daemon is already on the builder network, already
authenticates workers per-token, and already holds the routes the builder lost;
a sidecar needs its own auth and supervision for no extra property. CONNECT
tunnels bytes, so TLS stays end to end and the daemon never sees plaintext or
needs a CA.

**The hazard that creates, and the two things that close it.** The daemon's own
reachability becomes the builder's ceiling, so a builder that can name a
destination could otherwise reach the Deployment's Postgres. First, the
allowlist denies everything not on it. Second — and this is the part a
hostname allowlist alone gets wrong — **the socket is opened to an address that
was checked, not to the name that was allowed.** `evil.example` can hold an A
record pointing at the metadata endpoint, and resolving inside `connect` would
leave a window for DNS to change the answer between the check and the
connection. A name resolving to a MIX of allowed and blocked addresses is
refused outright rather than filtered, because that shape is what rebinding
looks like and filtering turns it into a retry loop.

Proxy variables are injected by the BROKER from operator config, never taken
from the caller and not in `ALLOWED_ENV` — a builder pointed at a proxy of its
own choosing has no control at all. `NO_PROXY` is derived from the proxy URL
rather than configured separately, because they are the same process and two
settings that must agree are a way for them to disagree.

**Plain HTTP is proxied too**, as a forwarded absolute-form request rather
than a tunnel. "Fails closed" was the right answer only while nothing needed
it. This is a larger authority than CONNECT and is bounded accordingly: CONNECT
only opens a socket and shovels bytes the daemon cannot read, while forwarding
has the daemon ISSUE a request for untrusted code — an SSRF primitive whose
only bounds are the allowlist and the address check. Hence **redirects are not
followed**: a `302` to `http://169.254.169.254/` would otherwise turn a checked
request into an unchecked one, so the response is relayed as-is and the
client's own retry re-enters the check from scratch.

Which header authenticated the hop decides what travels on.
`Proxy-Authorization` is hop-by-hop and always stripped; `Authorization` is
stripped only when it was what authenticated the proxy, because otherwise it is
the builder's own upstream credential and private registries need it. The
broker puts the worker token in the proxy URL as userinfo, since `npm` and
`git` will not set a proxy header by hand but every client honouring
`HTTPS_PROXY` turns userinfo into a Basic credential.

Still one port per scheme: 443 for CONNECT, 80 for HTTP. `FRIDAY_EGRESS_PORT`
and `FRIDAY_EGRESS_HTTP_PORT` exist because the success paths are otherwise
untestable (both need root to bind) and both defaults are pinned by tests.

### FRI-2040 — Per-Organization network isolation

`task` · parent FRI-2036 · ADR-054

Deny builder→any Postgres (a builder talks to the daemon over the worker
protocol and has no business reaching a database), cross-Organization
reachability, and builder→Control plane/webhook shim. Under the shared-cluster
arrangement this denial is the **only** barrier between a compromised build and
every other Organization's database, since isolation there is credential-only at
the network layer.

### FRI-2041 — Repo allowlist and per-task single-repo tokens

`task` · parent FRI-2036 · ADR-054

Two layers: the GitHub App installation is the outer boundary (the customer
chooses which repositories), and an admin-configured list is the inner one —
because an admin installing with "All repositories" must not mean any **member**
can have Friday push anywhere. Today `workspace.ts` takes a `baseRepo` that is a
local path or a remote URL with **no authorization notion at all**;
`assertInsideWorkspacesRoot()` is filesystem containment, not repo authorization.

Mint tokens **per task, scoped to a single repository**, with `contents: write`
plus `pull_requests: write` only — so Friday opens branches and PRs and never
pushes to a default branch, and a compromise reaches one repo rather than every
repo the customer owns. This matters more than restricting tooling, since `gh` is
in the Brewfile and available to agents. Launch gate (the per-task tokens).

### FRI-2042 — `.git/hooks` on the M1 deny-list

`task` · parent FRI-2036 · ADR-054

A compromised postinstall can drop a `post-checkout` hook that re-executes on
the next turn in an otherwise "fresh" container, because the hook survives on the
reattached worktree volume. This is the specific mechanism that makes per-turn
container ephemerality illusory, so the regex layer should deny it explicitly.

### FRI-2043 — Retire M2/M5 and rewrite `docs/sandbox.md`

`task` · parent FRI-2036 · ADR-054 · **done**

`sandbox-exec` is macOS-only and **fails open** on Linux:
`sandboxExecAvailable()` treats a missing `/usr/bin/sandbox-exec` as "disabled",
so builders silently run with no kernel isolation and no error. M2's deny-list
targets macOS surfaces with no Linux analog (`~/Library/Keychains`, `launchctl`,
`osascript`, `tccutil`), and M5's `ulimit -t`/`-n` were chosen for _Darwin_
semantics. Containment becomes cgroups plus container lifetime; the doc needed
rewriting around that rather than patching.

The document now leads with the container as the boundary and the distinction
that actually determines what protects a given worker: a **forked worker** (the
daemon's own child, wrapped in `bash -c 'ulimit …'` and on macOS in
`sandbox-exec`) versus a **containerised builder** (a separate container per
task, created by the broker, which the daemon does not fork). A per-layer table
answers both columns, because a single "does this layer apply" answer was the
thing making the old structure wrong.

**M5's rlimits turned out NOT to reach a containerised builder** — the note in
this ticket said to record that they are enforced on Linux, which is true but
not the live question. Measured: `container-runtime.ts` never references the
`limits` it is handed, and the broker spec sets no `Ulimits`, so neither
`ulimit -t` nor `ulimit -n` is in that path. The rlimits themselves are real on
Linux (`ulimit -t 5; ulimit -n 64` holds inside the builder image and children
inherit it) — the spawn path is what drops them, not the platform.

Consequence, now recorded as residual risk: a containerised builder has **no
CPU-time ceiling** (`NanoCpus` throttles rate, not total) and **no
file-descriptor cap**. An infinite loop that `ulimit -t 3600` would have killed
at an hour instead runs until the turn-stall watchdog fires on 30 minutes of no
`block-stop`. Wall-clock cover for the same failure from a different layer, not
a replacement for the limit. Filed as FRI-2083.

M2 stays in the tree and stays tested rather than being deleted: the laptop is
still how Friday is developed. What changed is that it is no longer presented as
a layer of the deployment model.

### FRI-2059 — Scrub the Claude Code child's env — the real untrusted-code boundary

`task` · parent FRI-2036 · ADR-054

FRI-2012 established that the boundary worth defending is one level deeper than
the worker: the env handed to the Claude Code child in `worker.ts`, which the
agent's Bash tool and everything it spawns inherit. That is where untrusted
repository code actually runs.

Not a blanket strip — the CLI needs its own Anthropic credentials to function,
so this is a deny-list that must not remove them. Moved from E1 to E4: it is
ADR-054's boundary, and E1 only ever pulled control 1 forward.

### FRI-2062 — Worker sandbox is silently off in the container

`bug` · parent FRI-2036 · ADR-054

Every worker fork in the compose stack logs
`"sandboxed":false,"sandboxReason":"binary-not-found"` — `sandbox-exec` is
macOS-only and absent from the Linux image.

**Settled: the Deployment container is the isolation boundary**, which is E4's
stated direction rather than a concession. Investigating it corrected most of
this ticket's own framing. The loss is NOT silent — the daemon announces it at
boot at `warn`. Only M2 is lost, not "the sandbox": M1 is pure JS, M3 is
unchanged, M4's `detached` + `kill(-pgid)` are POSIX, and M5's `ulimit`s are
enforced on Linux rather than advisory. And M2 denied `file-write*` only, so a
builder could always read the vault — it bought integrity, never
confidentiality.

**The real hole was not M2.** A boundary holds only if nothing inside it holds
credentials reaching outside it. Compose set `FRIDAY_ADMIN_DATABASE_URL` — a
Postgres superuser — on the long-running service, and the daemon spawns workers
with `...process.env`, so every builder inherited a credential that reaches
every Organization's database on the shared cluster ADR-051 plans. That defeated
FRI-2005 from a direction it did not cover.

Fixed: the variable is passed per-invocation to provisioning and `friday
restore` instead, and `probePostgresHealth()` — the last runtime consumer — now
probes as the application role (`pg_roles`/`pg_database` are world-readable,
`SHOW wal_level` is visible to any role).

Accepted residual risk until FRI-2038: inside the container a builder can write
anywhere under `$FRIDAY_DATA_DIR` and read the secrets there. One Deployment
serves one Organization, so that is the tenant's own data and the cross-tenant
seam — the container — holds.

### FRI-2071 — Development container type

`task` · parent FRI-2036 · ADR-050, ADR-054

A second container type for work that needs a git toolchain, kept out of the
image a Deployment runs. Friday in the Deployment cannot do development work at
all: no `/data/repos` mirrors, no `/data/workspaces`, `/app` has source but no
`.git`, no `gh`, no `~/.ssh`, no SSH agent, no git identity, and the vault holds
only `CLOUDFLARE_TUNNEL_TOKEN`.

The wrong fix is adding the toolchain to the Deployment image — a Deployment has
no business holding git credentials, which is the same reasoning that removed a
cluster superuser from it in FRI-2062.

Shape: a `dev` stage, `FROM runtime` plus `gh`, so the Deployment image is a
literal PREFIX of the dev image and the two cannot drift. Behind a compose
profile. Repo bind-mounted at `/workspace`, with an anonymous volume masking
`node_modules` so the host's darwin native addons never leak into a linux
container. Credentials are pass-through nulls, supplied per invocation.

Constraint to respect: `dev` must be the last stage (it is `FROM runtime`), and
**Docker's default target is the last stage**. Adding it silently rebuilt the
Deployment as the dev image — `gh` present, `FRIDAY_DEV_CONTAINER=1`, on the
service customers run. The `friday` service pins `target: runtime`; any new
build site must name its target.

It deliberately does NOT let Friday develop — workers are processes, so Friday
cannot spawn it until FRI-2037 makes the worker boundary a container lifecycle.
It is the proving ground for FRI-2038.

Rejected: running the daily driver on the dev image. That would let builder
processes inherit the toolchain today, and would end ADR-050's one-image
invariant as a self-enforcing property — the invariant holds precisely because
the daily driver runs the shipped artifact.

### FRI-2072 — The daemon binds loopback; 62 of 84 routes rely on that alone

`bug` · parent FRI-2036 · ADR-050, ADR-054, ADR-002

**Blocks FRI-2038.** Measured while checking what breaks for a containerised
worker:

- From a second container, `friday:7610` is **ECONNREFUSED** — the daemon binds
  `127.0.0.1` inside its own container, so nothing outside can reach it.
  `friday:7615` answers and 401s, so the network path is fine; the daemon is
  simply not listening on it.
- Of 84 routes, **22** carry `auth: true`. The router's own comment says the
  rest "rely on the 127.0.0.1 binding + injected daemon secret instead".
  Verified: `GET /api/tickets` with `Host: evil.example` and the daemon secret
  returns **200**. The bind is the control, not a Host check.

A worker in its own container has to reach the daemon, so the daemon must bind
wider — and the moment it does, 62 ungated routes become reachable by whatever
shares that network.

This corrects an assumption recorded in FRI-2037's PR #24, which framed
`authorizeSameHost`'s loopback-`Host` layer as the wall a containerised worker
hits. True for the 22 gated routes; for the other 62 there is no wall, because
there is no check. Sharper, not milder.

**RESOLVED, but not by the audit this entry described.** Measuring first
changed the answer: the worker needs FOUR route patterns, not sixty-two.
Hosting thirteen of fourteen MCP servers daemon-side collapsed the surface —
those handlers now self-call and never cross a network. What remains is
`POST /api/mcp/<server>`, `GET /api/memory`, `GET /api/mail/inbox/<agent>` and
`POST /api/elicitation/wait`.

So: a **second listener**, off unless `FRIDAY_WORKER_LISTEN` is set, serving
only those four behind a per-worker token. The primary listener keeps all 84
routes on loopback, unchanged. The limit is structural rather than policy — a
route is unreachable from the worker network because it is not served there,
and a route added tomorrow is loopback-only by default. Non-allowlisted paths
return 404, not 403.

The shared daemon secret is refused on that listener: it sits on a volume any
builder can read (FRI-2062), so across a network boundary it identifies
nothing.

**What this does not do:** it does not gate the other 62. They remain
loopback-only, which is sound while nothing else is on that interface — this
removed the REASON to bind the primary listener wider, not the underlying
exposure. Whoever picks up FRI-2038 should keep that distinction.

See `docs/running.md` § "The worker-facing listener" for the measured
behaviour from a second container.

### FRI-2073 — Host `friday-memory` daemon-side

`task` · parent FRI-2036 · ADR-054

First of the three servers FRI-2037 left in the worker. Unlike the eleven
already hosted, this one does local work beyond `daemonFetch`, so it is a port
rather than a registry entry — take it first, lowest stakes, and it establishes
the pattern for a server whose handlers are not pure daemon clients.

Constraint: the hosted form runs in the daemon, so the local work must be
correct there or move. The memory store is file-backed under
`$FRIDAY_DATA_DIR` with Postgres as a searchable mirror and the daemon has the
same data dir, so this is likely straightforward — verify rather than assume.

### FRI-2074 — Host `friday-elicitation` daemon-side

`task` · parent FRI-2036 · ADR-054

Second, and the hard one: `ask_user` is a round trip to a human, not
request/response. The daemon exposes a long-poll (`POST /api/elicitation/wait`)
plus a submit route, and the tool blocks until the user answers.

**MEASURED: it cannot be hosted as written.** Hosted, every `ask_user` fails
with `ask_user invoked without a tool_use_id`. The elicitation id IS
`extra.toolUseId` — the value the dashboard SSE event, the submit POST and the
canonical `tool_use` block all key on. `createSdkMcpServer` injects it because
it runs in-process; the standard MCP transport's `extra` carries `requestId`
and `signal` but no `toolUseId`, because tool_use_id is an Anthropic-API
concept rather than an MCP one. Not a port — it needs a different correlation
identity, and whatever replaces it has to reach all three consumers.

The long-poll was NOT the blocker, contrary to this ticket's original guess.
Node's `requestTimeout` governs request RECEIPT, not response latency: a probe
held a fully-received request open past a 2s `requestTimeout` and was never
closed. The 300s default reads like a ceiling and is not one.

Three options, none obviously right: thread the tool_use_id over the wire
(does the Agent SDK populate anything correlatable on a remote call?); mint the
id daemon-side and re-key the dashboard, submit route and chat store; or leave
this server in-process permanently and handle its container reachability under
FRI-2072. The last is cheap and may simply be correct — elicitation is the one
tool whose whole purpose is a round trip to a human.

### FRI-2075 — Host `friday-secrets` daemon-side

`task` · parent FRI-2036 · ADR-037, ADR-051, ADR-054

Last, deliberately — the one where being wrong matters most should land on a
pattern already proven by FRI-2073 and FRI-2074.

A security improvement, not just plumbing: today the secrets tool runs in the
worker process, the same process running untrusted repository code
(`docs/sandbox.md` residual risk #1). Hosted, a compromised worker can call the
tool but cannot reach the vault machinery.

Constraints: `appId` scopes which App's secrets a caller reaches and must be
DERIVED from the per-worker token, never asserted — `WorkerIdentity.appId` and
`callerFromRequest` already carry it, and this server is the main reason that
plumbing exists. The age vault does not move; FRI-2010's runtime-injected
identity is unchanged. And hosting does NOT close FRI-2062's accepted risk that
a builder can read `$FRIDAY_DATA_DIR` inside the Deployment container — only
per-task containers (FRI-2038) do. Do not claim otherwise.

All three are required for FRI-2038 regardless of their individual merits: per
FRI-2072, a server still built in the worker fails with ECONNREFUSED the moment
the worker is containerised.

### FRI-2076 — The daemon serves the repo into a builder container

`task` · parent FRI-2036 · ADR-054

FRI-2038 landed the transport and lifecycle; this is the part that makes a
_Builder_ possible. Both of `createWorkspace`'s modes end in `git worktree add`
against a `gitDir` on the daemon's filesystem — a local checkout, or the bare
`--mirror` under `<DATA_DIR>/repos/`. A container cannot hold a worktree whose
gitdir lives outside its volume, and the obvious shortcut is worse than the
problem: mounting the daemon's data dir into the builder container hands the
process running untrusted repository code a path straight past the boundary
FRI-2062 accepted and FRI-2038 exists to draw.

So the daemon serves the repo — `git http-backend` behind a worker-facing route
— and the container clones from it. Three reasons this and not a clone from the
real origin:

1. It works for a **local-path** repo, which is the common case rather than an
   edge one: `worktree.repo` defaults to the daemon's cwd, and a container has
   no way to clone a path on another host's filesystem.
2. No repo credential enters the container, for reads or writes.
3. The authorization decision stays where FRI-2041 put it: the route serves
   **only** the repo authorized for that task, so the allowlist is enforced by
   what is reachable rather than by what the clone command happens to say.

Scope the route per task and derive the repo from the per-worker token, not from
a parameter — the same reasoning as `callerFromRequest` (FRI-2037). It is a new
worker-facing route, so it belongs in `WORKER_FACING_ROUTES` with its reason.

### FRI-2077 — Forward a builder's pushes through the daemon

`task` · parent FRI-2036 · ADR-054

With FRI-2076 the clone's `origin` is the daemon, so `git push` lands on the
daemon and something has to carry it the rest of the way. The upside is the
point of the whole arrangement: the GitHub credential lives in the trusted tier
and never enters the process running untrusted repository code.

**Where the push lands was the decision, not how to serve `receive-pack`.**
Neither end of `resolveRepoGitDir` can receive one. `ensureMirror` refreshes
with `git remote update --prune` and a `--mirror` clone's refspec is
`+refs/*:refs/*`, so a Builder branch sitting there un-forwarded is pruned by
the next `createWorkspace` against that mirror. The obvious escape does not
work — measured: refs parked in `refs/friday-pending/*` were pruned exactly
like ones in `refs/heads/*`, because that refspec covers every namespace.
Nothing under `refs/` survives. And a local-path repo **is** the user's own
checkout, which `worktree.repo` defaults to, so landing pushes there writes
Builder refs into the daily driver.

So each task gets a bare repo nothing prunes and nothing else reads:
`<DATA_DIR>/staging/<name>.git`, the per-task shape FRI-2038 already uses for
volumes, applied to refs. A mirror is by definition a copy of upstream, so
holding state that exists only locally in one is wrong regardless of ordering.

**A `post-receive` hook cannot reject a push — measured.** Its stderr reaches
the client as `remote:` text, but the push still reports `* [new branch]` and
the ref lands; only `update` / `pre-receive` can refuse (verified:
`! [remote rejected] (hook declined)`). So the gate goes in `update`, the only
place rejection exists: a generated hook allowing exactly the Builder's own
`refs/heads/friday/<agent>` and refusing everything else. That is a code gate —
testable, logged, attributable to a User per ADR-051/ADR-053 — replacing a
prompt rule that merely asked a Builder not to push to `main`. It is
daemon-side code Friday authors, unrelated to FRI-2042's deny-list, which is
about hooks inside the container's clone.

Two details carry the gate. The allowed ref is **baked in at spawn**, not read
from `REMOTE_USER`, which is set from the request — a gate that trusts its
caller is not a gate. And the hook is **chmod 0755**: git ignores a
non-executable hook _silently_, so without it the push is simply accepted with
no error anywhere.

**The forward runs in-process after `git-http-backend` exits cleanly, not in a
`post-receive` hook.** The ticket originally reasoned for `post-receive` because
it is the only hook where the objects are permanent rather than quarantined.
That constraint is about hook timing and is satisfied in-process too, and
running there keeps the token out of a file on disk: a hook that pushed would
need the credential in its own environment or embedded in its text. The cost,
stated plainly — `post-receive`'s stderr reaches the client and this does not,
so a Builder sees `* [new branch]` and learns nothing about whether the branch
reached GitHub. It finds out when `friday-github` (FRI-2078) opens the PR.

**A clean backend exit does not mean a ref landed — measured.** The `update`
hook's rejection travels in the response body, not the exit status, so
`code === 0` is true for a push where every ref was refused. Since
`ensureStagingRepo` seeds `refs/heads/<branch>` from the base ref (so the first
push is a delta rather than the whole history over loopback), staging holds the
Builder's branch at the base commit from the moment it exists — and forwarding
on exit status alone made that seed appear at the destination as the Builder's
branch, carrying none of its work, on the first push a Builder made including
one the gate refused. The forward is therefore gated on the staged heads
actually having moved, snapshotted before the backend runs.

**`http.receivepack=true` is required or `git-http-backend` answers 403** — but
it does not need writing into the served repo: `GIT_CONFIG_COUNT=1`
`GIT_CONFIG_KEY_0=http.receivepack` `GIT_CONFIG_VALUE_0=true` injects it
per-request, verified, leaving the repo's own config untouched. It is absent on
the read path, so a fetch cannot accidentally advertise a writable repo.

A failed forward is not lost work: nothing prunes staging, so a ref that could
not be forwarded is still there to retry, which is the entire reason pushes land
there rather than in the `--prune`-refreshed mirror.

**Test trap, inherited from FRI-2076:** every git invocation that talks to an
in-process server must be async. `execFileSync` blocks the event loop and the
resulting deadlock reads exactly like a hung handler.

### FRI-2078 — Host PR creation and CI checks daemon-side

`task` · parent FRI-2036 · ADR-054

The builder persona has Builders run `gh pr create` and then gate "done" on
`gh pr checks <n> --watch`. Those are GitHub **API** calls, not git, so
FRI-2076's git route cannot serve them and FRI-2077's forwarder does not reach
them. Without this, a containerised Builder can write code and push it and
still cannot finish.

A daemon-hosted MCP server — the fourteenth, alongside the thirteen FRI-2073
and FRI-2075 moved — with the token daemon-side and the Builder calling tools
instead of shelling out. Two things that buys beyond credential placement: the
daemon can gate which repo and which base branch a PR may target, and the
"halt at a green PR, never merge" rule stops being a prompt instruction a model
may reinterpret and becomes a tool that has no merge operation.

This is the asymptote principle applied to a recurring shape rather than a
one-off: every Builder does exactly this, every time.

Supersedes the need for a container-side GitHub token, so it also keeps
`api.github.com` off the egress allowlist FRI-2039 has to write.

### FRI-2079 — A builder image whose entrypoint is the worker

`task` · parent FRI-2036 · ADR-054

`BROKER_BUILDER_IMAGE` currently names the dev image, whose `CMD` is `bash` —
so a builder container today starts, runs a shell, and never dials the command
channel. Needs a stage whose entrypoint is `worker.js`, carrying git and the
Agent SDK's bundled `claude` binary.

Two traps already paid for elsewhere apply here. The **musl build must stay
out** (the SDK picks musl on a glibc image and fails with `ENOENT` for the
missing loader, which it reports as the misleading "native binary not found" —
see the Dockerfile's existing prune and assertion). And the stage **must name
its target explicitly** at every build site: Docker defaults to the last stage,
which is how the Deployment silently became the dev image once already.

### FRI-2080 — Split the workspace path: a clone at `/workspace`, not a worktree

`task` · parent FRI-2036 · ADR-054

The container path produces a **clone**, not a worktree, and three daemon-side
consumers assume otherwise. This is the ticket that keeps FRI-2076 from
breaking things that currently work.

- `archiveWorkspace` unregisters a worktree in `gitDir` and would have nothing
  to unregister; the volume is the broker's to tear down.
- The continuous invariant auditor (`agent/invariants.ts`) and the boot check
  in `index.ts` both do `existsSync(a.worktreePath)` for every Builder.
  `/workspace` never exists on the daemon's filesystem, so **every**
  containerised Builder would trip the auditor, continuously, forever — a
  false alarm loud enough to train people to ignore a real one.
- The workspace guard reads the path as the containment root, and there it is
  correct: the guard runs in the worker, where `/workspace` is real. Keep that
  distinction explicit, because it is the one place the container-relative path
  is the right value.

Prefer recording which runtime owns the path over sprinkling `existsSync`
guards — a path the daemon cannot see is not an error to tolerate, it is a
different kind of path.

---

## FRI-2044 — E5: Control plane

`epic` · ADR-051, ADR-052, ADR-053 · 8 tasks

Goal: the second application — marketing, registration, billing, legal,
support, provisioning, fleet upgrade, the central webhook shim, **Usage cap**
ceilings and the kill switch.

Done when a company can sign up and get a working Deployment unattended.

Depends on E1 only (there must be an image to provision). **Blocks nothing above
it** — separate codebase, no consumers until customer #2, so it is the natural
second-person workstream and can start whenever there are hands for it.

Its hard parts are operational rather than architectural.

Coarse by design — refine when reached.

### FRI-2045 — Unattended Deployment provisioning

`task` · parent FRI-2044 · ADR-051

On signup: create the database, provision the role and the `vector` extension,
create `friday_pub`, allocate a replication slot, generate the five
per-Deployment secrets, allocate a hostname and certificate, boot the stack.
Today this work is `friday setup` — an interactive clack wizard. Nothing in the
repo does any of it unattended.

Capacity constraint to track from week one: `max_replication_slots` defaults to
**10** and zero-cache needs one slot per Deployment, so the 11th Deployment on a
shared cluster cannot start. Raising it is a server config change requiring a
restart.

### FRI-2046 — Control plane as identity provider

`task` · parent FRI-2044 · ADR-051

One login; the Control plane authenticates and hands the Deployment a signed
assertion, which the Deployment exchanges for a **local** BetterAuth session.
Because the session is minted locally and BetterAuth runs 7-day sessions on a
1-day sliding refresh, a Control-plane outage blocks **new** logins only, not
active ones. Keep the auth source a pluggable seam so a self-hosted Deployment
can run standalone against the customer's own SSO.

### FRI-2047 — Central webhook shim

`task` · parent FRI-2044 · ADR-052

A **separate, minimal service** from the rest of the Control plane — stateless
verify-and-route, no billing database — because unlike login it is a _runtime_
dependency for every Transport. Required because a distributed Slack app has
exactly **one** Event Subscriptions URL for all installations (likewise one
webhook URL per GitHub App, one redirect URI per OAuth app), so per-Deployment
webhook URLs are not available. Routes by
`(provider, external_workspace_id) → Deployment`. Keep the webhook source
pluggable so self-hosted customers can use their own apps.

### FRI-2048 — Capacity source and Usage cap enforcement

`task` · parent FRI-2044 · ADR-051

`Capacity source` is `friday` (our org keys, billed through the Control plane)
or `byo` (the customer's own key in their vault — the `ANTHROPIC_API_KEY` vault
plumbing partly exists). A **Usage cap** applies in **both** modes: under
`friday` it protects the margin, under `byo` it protects the customer from their
own autonomous agents.

**Enforcement must sit in the dispatch path**, against a running counter, and
refuse loudly rather than queue. The scheduler is a 30-second tick with nobody
watching, `usage`/`usage_request` are written _after_ a turn, and the
`worker.turn.stalled` watchdog detects liveness not spend — so a looping agent
can burn a month's budget in an hour unnoticed. **Can land before the rest of
E5.**

### FRI-2049 — Fleet upgrade orchestration

`task` · parent FRI-2044 · ADR-051

Each release is N independent boot-time migrations against N databases. Needs
canary cohorts, per-Deployment migration telemetry, and **synthetic per-tenant
health probes** — process liveness is insufficient, because the worst failure (a
table in the Zero schema but not in `friday_pub`) leaves the page and tunnel
looking fine while live sync is dead and the dashboard reload-loops every ~2s.

Accepted consequences to design around: expand/contract migration discipline
becomes a permanent contract (version skew is never atomic), schema rollback does
not exist (roll forward only), the Drizzle `when`-timestamp hazard escalates from
bricking one laptop to splitting the fleet silently, and ADR-044's
self-referential update gap means a fix to the rollout mechanism cannot apply to
the rollout that delivers it.

### FRI-2050 — Suspension, retention window, export and delete

`task` · parent FRI-2044 · ADR-053

A cancelling Organization enters a retention window implemented as Deployment
_suspension_ — the same state the kill switch needs for non-payment, abuse and a
blown Usage cap. Three in-window actions: **restore**, **export**, **delete
now**. Export-then-delete is the expected path, so export is asynchronous and a
delete following one must wait for it to complete and be confirmed retrieved.

Deletion must reach four things outside Postgres or it deletes an index rather
than the data: the data-dir volume (`memory/entries/*.md`, `uploads/`), the SDK
transcripts under `~/.claude/projects/`, the Zero replica and replication slot,
and the Deployment's secret-manager entries. Note `attachments` is
content-addressed by `sha256` with no owner column, so per-User attachment
deletion is ambiguous by construction.

### FRI-2051 — Registration, billing, legal and support surfaces

`task` · parent FRI-2044 · ADR-051

The public application a prospective customer meets before they have a
Deployment. Trials need a **token ceiling, not just an expiry** — the exposure is
two separate costs, and only one of them is capped by a date. Measured idle
infrastructure cost at decision time was ~700 MB RSS across ~29 processes per
Deployment doing nothing, with zero-cache about 57% of it, and scale-to-zero is
largely unavailable because always-on is the product.

### FRI-2056 — Configure a GitHub App so releases work on this fork

`task` · parent FRI-2044 · ADR-034

release-please needs credentials this fork does not have; the workflow now
carries a guard step that skips the release job when they are absent, so CI is
green but nothing ships.

Parented to E5 rather than the backlog because FRI-2049 (fleet upgrade
orchestration) cannot be built or tested without a working release pipeline —
there is nothing to orchestrate the upgrade of.

---

## FRI-2068 — E6: Cleanup and backlog

`epic` · 11 tasks

The holding epic for work that is real but blocks no other epic.

E1–E5 each carry a goal and a done-when. This one deliberately does not. Its
purpose is to keep those five honest: a ticket parked here can be picked up
whenever there is slack, and leaving it inside a goal-bearing epic would
misreport that epic's completeness.

**Admission rule.** A ticket belongs here when no task in E1–E5 can be blocked
by it. A ticket that is merely LOW PRIORITY but does block an epic task stays
with that epic — priority and blocking are different axes, and only blocking
decides placement.

### FRI-2083 — A containerised builder has no CPU-time or fd limit

`bug` · parent FRI-2068

Found while rewriting `docs/sandbox.md` for FRI-2043. M5 wraps a forked worker
in `bash -c 'ulimit -t 3600; ulimit -n 4096; exec node …'`, and
`lifecycle.ts` duly passes `limits: { cpuSeconds, openFiles }` into the runtime
seam — but **`container-runtime.ts` never reads it**, and the broker's container
spec sets no `Ulimits` field. So a containerised builder runs with neither cap.

What it does have is cgroups: `Memory` 2 GiB and `PidsLimit` 512 are hard caps,
but `NanoCpus` throttles CPU **rate**, not total. So there is no CPU-time
ceiling at all. An honest infinite loop that `ulimit -t` would have killed at
one hour instead runs until the turn-stall watchdog notices no `block-stop` for
30 minutes — the same failure covered at wall-clock by a different layer, which
is not the same as the limit being present.

Not a platform problem: the rlimits are real on Linux. Measured inside the
builder image, `ulimit -t 5; ulimit -n 64` holds and children inherit it. It is
the spawn path that drops them.

Fix: set `Ulimits` in `buildContainerSpec` from broker config, defaulting to
the same values the forked path uses, so the two shapes of worker get the same
ceiling. Broker config rather than caller-supplied, like every other limit
there.

### FRI-2082 — `sync harness` e2e dies on EADDRINUSE from a leaked zero-cache worker

`bug` · parent FRI-2068

`daemon-down.e2e.test.ts` fails in `beforeAll` with
`zero subprocess exited (code=0) before binding :<base>`, while zero-cache's
own log shows its change-streamer worker exiting on
`EADDRINUSE :::<base+1>`. Intermittent — red on `main`, green on the #41
branch in the same window.

The mechanism is already named in `spawnZeroCacheForTest`'s own comment, which
is why `detached: true` is set there: _"workers leak between tests and the next
harness boot hits EADDRINUSE on the previously-allocated port."_ The group
SIGTERM is supposed to reap them and usually does; `sigtermThenSigkill` can
still return on its `ms + 8_000` hard deadline with the child alive, and a
worker that re-forks during teardown binds `base+1` after the reservation
probe has already released it.

**Two tempting explanations are wrong — measured, so they do not get
re-litigated.** (1) The reservation probes `127.0.0.1` while zero-cache binds
`::`; on darwin a loopback probe is indeed blind to a wildcard bind, but **on
Linux it correctly refuses**, and CI is Linux. (2) `listen(0)` draws from the
ephemeral range (32768–60999 on the runner, and the observed ports sit inside
it), so a released port could be stolen as an outbound connection's local
port — but on Linux an outbound socket holding a port **does not** block a
later wildcard `listen` on it.

So this is process lifetime, not port arithmetic. `freeSyncPorts` already
closed the self-collision hole and cannot close this one: no probe can see a
socket that does not exist yet.

Fix direction: treat "exited before binding" as retryable at the env level —
respawn zero-cache on fresh ports a bounded number of times — rather than
throwing out of `beforeAll`. Note the existing retry in `waitForBoot` does not
cover it: that branch handles a TCP _timeout_, while this child exits outright,
which throws immediately. Verify against CI, not locally; it has not been
reproduced on a developer machine.

### FRI-2081 — Playwright round-trip fails

`bug` · parent FRI-2068

`live-typing.spec.ts` fails the user-visible round-trip: a sent message lands
0 rows in `blocks` where it expects 1. It was parked in CI on 2026-10-30
(`if: ${{ false && … }}` on the `playwright` job) because CI had not run at
all since 2026-10-15 and nobody had diagnosed it — a permanently-red required
check trains people to ignore the board. **The job is live again and still
failing**, so the park is history, not current state.

**DIAGNOSED (2026-10-30), and it is not the write path.** The test's own
diagnostics had the answer: the bubble rendered, and the only recorded network
call was `/api/sync/refresh` — no `/api/mutators` call at all. So the
OPTIMISTIC local write happened and the mutation was never pushed. Zero holds
a mutation client-side until it has a live connection, and nothing in the test
waited for one: `toBeEnabled()` is DOM hydration, not sync readiness. The
test's own comment names the hazard two lines further down ("a fresh client
group can take a few seconds on first send").

Asserting against Postgres first turned that into "expected 1, received 0",
which reads like a broken canonical write and is not — which is why this
looked alarming enough to park a required check over.

Fixed by waiting for the `/api/mutators` push before polling Postgres: it
gives a slow first client group time to connect and flush, and when the push
genuinely never happens it fails naming that fact. Job unparked.

### FRI-2054 — Prune the container image (currently 1149 MB)

`task` · parent FRI-2068 · ADR-050, ADR-051

The FRI-2002 image is **1149 MB**. The builder stage runs a full
(non-prod) `pnpm install` so turbo can build, and the runtime stage then
`COPY --from=builder /app /app` wholesale — so dev dependencies, TypeScript
sources and build caches all ship.

Options, roughly in order of payoff: a prod-only dependency tree in the runtime
stage (`pnpm prune --prod`, or a separate prod install); drop sources,
`tsconfig`s and test files; copy only each package's `dist`/`build` plus the
prod `node_modules`.

Constraint to respect: the supervisor's `findRepoRoot()` walks up looking for
`pnpm-workspace.yaml`, so whatever the runtime layout becomes must still contain
that file at the tree root.

Worth folding in while here: the ~23 MB embedding model (quantized ONNX,
all-MiniLM-L6-v2) is fetched at setup/update into `$FRIDAY_DATA_DIR/models/`.
Baking it into the image instead means Deployments do not each download it, and
semantic recall works on first boot rather than degrading fail-open to FTS.

### FRI-2055 — Playwright e2e suite is flaky

`bug` · parent FRI-2068

Red CI is currently indistinguishable from a real failure, so every failing PR
costs a manual investigation — directly undermining the signal CI exists to
give. Three distinct specs failed across three branches including `main`
(`memory-redesign`, `chat-inner-scroll`, `chat-send-target`), and one PR went
green on a re-run with no code change. All three are scroll/visibility
assertions.

### FRI-2057 — Evaluate Retrofit (retrofit.sh) for schema migrations

`task` · parent FRI-2068 · ADR-023, ADR-051

Retrofit is a PostgreSQL-only CLI that records each schema change as one line in
a git-tracked operation log (the "oplog"), reports the change's risks before any
SQL exists, and renders both the forward and the reverse migration from that
line. Evaluate it as a **front end to** our Drizzle migrator — not a
replacement for it.

**Not publicly shipped, but we can get it.** As of 2026-10-30 the site's own
status says _"Not shipped yet"_ (pre-release): no public install path, no
version, no stated distribution channel, and nothing on the source being open.
Seth has access to the Retrofit repo and can pull it down when we build this, so
acquisition is not the blocker and the first step is not a mail asking for one.
What that access does NOT settle is the terms: whether we may vendor it into CI,
and what a pre-release tool's version skew does to a check other people's builds
depend on. Confirm those before any pipeline depends on it — see the first exit
criterion below.

**Two premises in the original entry were wrong; correcting them shrinks the
case rather than killing it.**

First, Retrofit does not order changes by "sequential identity numbers." A
change id is a 12-character random value carrying a `prev=` pointer to the line
before it — a content chain, whose purpose is to make a git merge that branches
the log _detectable_ (`retrofit reconcile` resolves it). The 48-bit ElementID is
the immutable identity of a schema _object_ (table, column, index, constraint),
which is what makes a rename or a type change not disturb anything pointing at
it. Both are better than a timestamp for our purposes; neither is a sequence
number.

Second — and this is the load-bearing correction — **our worst silent
upgrade-bricker is already not silent on the boot path.** CLAUDE.md and this
ticket both describe Drizzle's own migrator, which filters journal entries by
`when` against `__drizzle_migrations.created_at` and skips anything below the
max. `packages/shared/src/db/migrate.ts` is a hand-rolled runner that does not
do that: it sorts entries by `when` and skips an entry only when its exact
`when` is already present in `created_at`, then asserts journal count equals row
count. Read against that code, a fabricated `when` now produces a _loud_
failure, in one of two shapes — a duplicate `when` makes the second entry look
applied, which the count assertion catches as `drizzle journal/db mismatch`; a
back-dated `when` is still applied, but sorts ahead of migrations it logically
follows, so a **fresh** install applies it in a different order than an upgraded
box did and fails there while the upgraded box stays fine. Derived from reading
the runner, not from a reproduction: a test that poisons a journal and runs
`runMigrations()` both ways is the cheap way to confirm it, and is worth writing
regardless of what happens to Retrofit.

The genuinely silent form survives on one path: the `drizzle:migrate` package
script, which shells out to `drizzle-kit migrate` and therefore gets Drizzle's
filter-by-`when` behaviour. Nothing on the boot path uses it.

**What would actually be worth buying,** then, in order:

1. **Reverse migrations, generated rather than hand-written.** ADR-051's
   fleet-upgrade story has Deployments running boot-time migrations unsupervised
   against customer data with no canary and no rollback. We have no `down` SQL
   anywhere today. This is the one capability we cannot cheaply replicate.
2. **Position inferred from the schema, not from a metadata table.** Retrofit
   keeps no tracking table: `pg_dump --schema-only | retrofit identify` reports
   where a database sits in the oplog by reading the schema itself. Our
   `drizzle journal/db mismatch` failure _is_ a diverged metadata table, and the
   documented recovery for it is to diagnose a `when` by hand. "Ask the schema"
   is a strictly better answer for a fleet we do not sit in front of.
3. **Advisories at authoring time.** `retrofit op add` reports table scans,
   dependent-code breakage and data loss before any SQL exists, and `migrate`
   refuses an unrecoverable reverse unless overridden.

**The integration shape, if it ships: Retrofit generates, Drizzle applies.**
This is the documented adoption path (the Flyway and Rails walkthroughs are
both "Retrofit writes the migration, the existing tool remains the deployer"),
and it is the only shape that keeps our boot path — and the ADR-045 publication
reconcile that runs right after it — untouched:

- **Baseline.** `pg_dump --schema-only | retrofit import - --seal='<version>
baseline'`, which reads the current schema without replaying our 42
  migrations. `__drizzle_migrations` is left alone; the oplog starts from the
  imported point forward.
- **Per change.** `retrofit op add <Op> …` → review the advisory →
  `retrofit migrate --from seal~1 --to seal --envelope caller` into the `.sql`
  file for a migration whose journal entry `drizzle-kit` still writes, so the
  `when` stays a real `Date.now()` by construction.
- **Verification.** `retrofit identify` in CI against a freshly migrated scratch
  DB, asserting the oplog and `schema.ts` agree. That check is the deliverable
  that would make adoption worth it — it is also writable without Retrofit, as a
  dump diff.

**Constraints any adoption must respect:**

- **`schema.ts` stays the source of truth for types.** It is consumed as
  `dist/` across every package, and the Zero sync schema
  (`packages/shared/src/sync/schema.ts`) is maintained beside it. An oplog that
  becomes a second schema source is a drift generator, so the evaluation has to
  answer which artifact is canonical before any oplog is committed. A plausible
  answer is "oplog for DDL, `schema.ts` for types, CI asserts they agree."
- **Three things mutate our schema from outside migrations,** and all three will
  read as drift to `identify`: `FTS_SETUP_SQL` (generated `content_tsv` columns
  plus GIN and HNSW indexes, re-run after every migration pass),
  `ensureVectorExtension()` (`CREATE EXTENSION vector`, admin connection, needs
  SUPERUSER), and `reconcileSyncPublication()` (`friday_pub`, ADR-045). They are
  deliberately not in migrations. Either the baseline seal swallows them or the
  evaluation establishes that `drift` can be told to ignore them.
- **A pre-release, closed-source tool must not land on the boot path.** Under
  the generate-only shape it is a developer-and-CI dependency that no Deployment
  ever runs, which is the only exposure acceptable here. If adoption ever
  requires Retrofit at runtime, this ticket becomes a rejection.

**Exit criteria** — decided when answered, not left open:

1. Under what license and terms, and may we vendor it into CI? Access to the
   repo is not permission to redistribute it in a build artifact.
2. Does `import` round-trip our schema? Baseline a scratch DB, then
   `migrate --from-dump` back onto an empty one and diff the two
   `pg_dump --schema-only` outputs byte for byte.
3. Does `identify` survive the three out-of-migration mutators above?
4. Is a generated `down` correct for the three riskiest migrations in our
   history (the SQLite-era import, the `bigserial` → `text` PK flip in
   `ticket_comments`, and the `vector(384)` column)?

Reject on any of 1–3. A yes to all four, and FRI-2057 closes by filing the
adoption work as its own ticket; the evaluation itself changes no runtime code.

**What this does not do.** It does not harden `migrate.ts`. The back-dated-order
and `drizzle-kit migrate` hazards above are ours whatever Retrofit turns out to
be, they are cheap to close, and they should not wait behind a tool that has not
shipped.

### FRI-2061 — Stale policy-limits cache on the HOME volume blocks all turns

`bug` · parent FRI-2068

A Deployment can cache a transient authorization failure and keep refusing every
turn after the cause is fixed, with nothing in the error pointing at the cache.

Observed: turns failed with "Credit balance is too low" while the key was
unfunded — correct at the time. After funding, the same error persisted across
container restarts, while a direct `curl` with that exact key succeeded.
`$HOME/.claude/policy-limits.json` held `"allowed": false` and was preferred
over a live check; deleting it fixed it immediately.

Matters more in a Deployment than on a laptop: `$HOME` is a persistent volume,
so the stale denial outlives the restart an operator would reach for first.

### FRI-2063 — Client-side sync has no diagnosable failure signal

`task` · parent FRI-2068

The dashboard sat on "Syncing your data" for ~10 minutes against a freshly
booted stack. It resolved on its own and a deliberate cold-replica reload would
not reproduce it, so the stall itself is not actionable — but nothing recorded
why. The client emitted zero console output, the only server-side signal was the
presence or absence of a `zero-proxy.upgrade.accepted` line, and `SyncOverlay`
renders the same spinner for "connecting", "connected but nothing materialized"
and "backing off".

Want: log Zero `connection.state` transitions, and after N seconds in `pending`
surface the actual state and last error instead of an indefinite spinner.

### FRI-2064 — Parameterize the compose stack so two Deployments can run side by side

`task` · parent FRI-2068 · ADR-050, ADR-051

Goal: run the daily driver and a throwaway test Deployment at once, so features
can be exercised against a copy of real data without risking it.

`docker-compose.yml` hardcodes `80:80`, `7615:7615`, `5433:5432` and
`BETTER_AUTH_URL`. Ports and volumes are otherwise isolated by project name for
free; the hostname is the one that bites quietly, because a mismatch with
`BETTER_AUTH_URL` is a BetterAuth hard-exit.

**Separate DATABASE per Deployment is non-negotiable**, not merely separate
volumes: a test Deployment running newer code runs migrations at boot and would
poison production's chain, and both would reconcile `friday_pub` and hold
replication slots against the same publication.

The half worth designing is the **inert-clone posture**. A clone of production
is not inert — it comes up with active schedules, the agent registry, and (if
the vault is copied) live integration tokens, and will fire scheduled turns and
write to production credentials. Needs schedules paused on restore into a
non-primary Deployment, a distinct key or usage cap, and integrations scrubbed
or sandboxed. That is ADR-051's Capacity source / Usage cap question arriving
early.

### FRI-2066 — A worker with no credentials writes junk blocks forever

`bug` · parent FRI-2068 · ADR-051

With no usable credential the SDK returns `Not logged in · Please run /login`
as ordinary assistant output. The daemon persists it as an assistant block,
notices the turn produced nothing useful, and restarts the worker — measured at
~2.6 blocks/sec indefinitely, stopping only when the container was stopped by
hand.

FRI-2014 fixed the proximate cause. This is the robustness gap behind it, which
is independent of WHY auth failed: an expired key, a revoked key, a Capacity
source misconfiguration, or a BYO key hitting its cap all land here.

Wanted: treat the not-authenticated result as a terminal turn failure rather
than content (it should never reach the user as a message), surface it as a
Deployment health problem, and bound the wedge-restart loop generally so no
failure mode can write unbounded rows into a tenant's database.

### FRI-2069 — An orphaned daemon survives `friday stop`

`bug` · parent FRI-2068 · ADR-028

Found while quieting the source for the FRI-2014 cutover. `friday stop`
reported success and `launchctl print` confirmed the job was gone, yet a daemon
still held 127.0.0.1:7610:

```
PID   PPID   ELAPSED       COMMAND
5601     1   20-01:53:54   node dist/index.js
```

Parented to PID 1, **elapsed 20 days**, and actively working — a worker child
spawned 10 seconds earlier, 33 blocks written in the preceding 10 minutes.
`friday status` had reported a _different_ daemon (pid 28252) under supervisor
27657, so two daemons were running against the same Postgres. `kill -TERM`
shut it down cleanly.

Two daemons on one database is not a benign duplicate: both LISTEN on
`friday_new_pending_block` and race to claim pending blocks, both run the
scheduler so a cron schedule can fire twice, both run boot recovery. Past
"mystery" symptoms — duplicate turns, blocks with no apparent trigger — are
consistent with this and should be re-examined against it. It also silently
defeats `friday stop` as the safety step the migration procedure depends on.

Establish the mechanism before fixing. ADR-028's supervision rework exists to
give cascade-stop via process groups, so this is a regression, a pre-rework
process that outlived its supervisor, or a path that detaches from the group.
Twenty days spans several `friday update` runs, which flip the `current`
symlink and restart the stack — a strong hint.

Then: `friday stop` should verify the port is free and the daemon actually
gone rather than trusting `launchctl bootout`, and `friday status` should
notice a daemon it does not own.
