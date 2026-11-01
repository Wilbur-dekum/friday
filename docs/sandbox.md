# Sandbox — worker isolation

Builders run untrusted code. Not "code a careless agent might write" —
untrusted in the ordinary sense: a repository's `postinstall`, a dependency's
build script, anything the agent is asked to check out and run. This document
says what contains that, measured rather than intended.

**The model in one line: the container is the isolation boundary.** Everything
else is defence in depth behind it, and is described here as what it does
_given_ that boundary rather than as a substitute for it (ADR-050, ADR-054;
decided in FRI-2062).

That is a change of frame from how this document used to read. It was
originally organised around five layers (M1–M5) designed for a macOS laptop,
with the container model bolted on in front as a correction. The layers still
exist and are still described below — but a laptop is no longer the supported
target, and leading with a macOS kernel sandbox that does not exist on the
deployment platform mis-stated what protects a Deployment.

## Two shapes of worker, and they are not protected the same way

This is the distinction the rest of the document turns on, so it comes first.

A **forked worker** is the daemon's own child process: `fork` + `detached`,
wrapped in `bash -c 'ulimit …; exec node …'`, and on macOS additionally
wrapped in `sandbox-exec`. This is the laptop, and a single-container
Deployment that has not enabled container mode.

A **containerised builder** is a separate container per Builder _task_, created
by the broker (FRI-2038). The daemon does not fork it, so none of the spawn
wrapping applies; it is constrained by the container spec instead.

| Layer                         | Forked worker                        | Containerised builder                               |
| ----------------------------- | ------------------------------------ | --------------------------------------------------- |
| M1 PreToolUse regex rules     | Active                               | Active — pure JS, runs daemon-side of the tool call |
| M2 `sandbox-exec` SBPL        | macOS only; **absent on Linux**      | **Absent.** Not applicable, and not the plan        |
| M3 Lifecycle-script env       | Active                               | Active                                              |
| M4 Process-group containment  | Active                               | Superseded — teardown is `docker stop`              |
| M5 rlimits (`ulimit -t`/`-n`) | Active, enforced on Darwin AND Linux | **Absent — see below**                              |
| M5 turn-stall watchdog        | Active                               | Active — it watches the registry, not the process   |
| cgroup limits                 | None                                 | Memory 2 GiB, 2 CPUs, 512 pids                      |
| Egress allowlist (FRI-2039)   | None — it is the operator's own box  | Active, deny-by-default                             |
| Filesystem reach              | The operator's home directory        | One volume at `/workspace`                          |

**M5's rlimits do not reach a containerised builder, and that is measured, not
assumed.** `container-runtime.ts` never references the `limits` it is handed,
and the broker's container spec sets no `Ulimits` field — so neither
`ulimit -t 3600` nor `ulimit -n 4096` is in that path. (The rlimits themselves
are real on Linux: setting `ulimit -t 5; ulimit -n 64` inside the builder image
holds, and children inherit it. Darwin-vs-Linux was never the problem here; the
spawn path is.)

What the container has instead is cgroups, which cover different ground:
`Memory` and `PidsLimit` are hard caps, but `NanoCpus` throttles CPU _rate_,
not total, so there is **no CPU-time ceiling** on a containerised builder and
**no file-descriptor cap**. An honest infinite loop that `ulimit -t` would have
killed at one hour instead runs until the turn-stall watchdog notices no block
has landed for 30 minutes. That is wall-clock cover for the same failure, from
a different layer — not a replacement for the limit. Closing the gap properly
is FRI-2083.

## What the container boundary is, and what it requires

**Per Builder _task_, not per turn** (FRI-2038, ADR-054). A Builder's worktree
has to survive turns: uncommitted changes, `node_modules`, an in-progress
branch. So the volume is reattached, and the guarantee is stated as **bounded
to one assignment**. Claiming per-turn ephemerality would be false —
`.git/hooks/*` and `node_modules` are executable surfaces that survive a
reattach, which is exactly the mechanism FRI-2042 exists to deny.

The privilege surface is fixed by the broker, not by its caller
(`services/builder-broker/broker.mjs`): `Privileged: false`, `CapAdd: []`,
`CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges:true"]`, one named volume
at `/workspace`, and the image pinned by broker config. The daemon supplies a
task id and a short allowlist of env keys — it cannot hand over a spec. A
broker that forwarded caller-supplied specs would be the Docker socket with
extra steps.

**The socket is the privilege, and it lives in one place.** Creating containers
needs `/var/run/docker.sock`, which is host-root equivalent. Mounting it into
the Deployment container would hand that to the same container that runs the
unsandboxed orchestrator, so it lives in a dependency-free sidecar whose entire
API is "start a builder".

**A boundary only holds if nothing inside it holds credentials reaching
outside.** That is the invariant, and it has been broken twice in ways worth
remembering:

- `docker-compose.yml` set `FRIDAY_ADMIN_DATABASE_URL` — a Postgres
  **superuser** — on the long-running service, and the daemon spawned workers
  with `...process.env`, so every builder inherited it. On the shared cluster
  ADR-051 plans, one superuser reaches every Organization's database. Fixed in
  FRI-2062: the variable is gone from the service, and `probePostgresHealth()`
  runs its three read-only probes as the application role. Provisioning and
  `friday restore` take the credential per-invocation.
- The Claude Code child was receiving raw `process.env`. See FRI-2059 below.

## Egress is deny-by-default (FRI-2039)

A builder's network is a Docker network declared `internal: true`, which
Docker gives no gateway. Measured from inside one:

```
metadata 169.254.169.254: denied ENETUNREACH
public 1.1.1.1:443:       denied ENETUNREACH
dns api.anthropic.com:    denied EAI_AGAIN
```

The cloud metadata endpoint is unreachable because **no path to it exists** —
not because a rule remembered to say no. That matters more than the usual
defence-in-depth argument: metadata is an _account_-level compromise, since the
host's IAM credentials reach the whole cloud account.

Before this, `BROKER_BUILDER_NETWORK` was `friday_default` — the default
compose network — so a builder had full internet access and could reach
Postgres and zero-cache directly.

The single allowed hole is a proxy on the daemon's worker-facing listener:
CONNECT for TLS, and forwarded absolute-form requests for cleartext. The
default allowlist is `api.anthropic.com` plus the npm/yarn registries, one port
per scheme. Notably **not** a git host — FRI-2076/2077 put git behind the
daemon's own route and FRI-2078 did the same for the GitHub API, so a builder
reaches neither directly and does not need to.

Two properties are what make it destination-based rather than merely
name-based, which is what ADR-054 requires: every resolved address is checked
against the private, loopback, link-local, CGNAT and multicast ranges, and the
socket is opened to **an address that was checked rather than the name that was
allowed**. Redirects are not followed, since a `302` inward would turn a
checked request into an unchecked one. Full detail in
[docs/running.md](running.md) § Egress, and every surface's credential and
pattern in [docs/network-surfaces.md](network-surfaces.md) (ADR-055).

## What the daemon stopped handing out (FRI-2059)

FRI-2012 established that the boundary worth defending is **one level deeper
than the worker**. The worker is Friday's own code: it reaches the database and
deliberately carries the full daemon environment. The Claude Code child it
spawns is a different matter — the agent's Bash tool, and everything that tool
spawns, inherit that child's environment, and that is where untrusted
repository code actually runs.

That child now receives `claudeCodeChildEnv()`, which applies the same
deny-list the shell capture uses (`isSecretKey`). Stopping at the boundary:
`DATABASE_URL`, `ZERO_UPSTREAM_DB`, `FRIDAY_ADMIN_DATABASE_URL`, the age
identity that decrypts the whole vault, `SSH_AUTH_SOCK`, and `GITHUB_TOKEN`.

**The exception, and its residual risk.** The CLI cannot authenticate without
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`, so
those three pass through — and because a process inherits what its parent
holds, they reach the Bash tool too. We cannot scrub a process we do not spawn.
Narrowing further means a credential proxy the CLI talks to rather than a
longer list, which is why a test caps the exception set at four entries and
requires every entry to be secret-shaped: an exception that excepts nothing
makes the list look like it is doing more than it is.

## M1 — the regex layer

A pure function (`checkBashForDisaster(command, workspaceReal)`) tokenizes the
worker's `Bash` argument with `shell-quote` and applies deny rules to the
resulting argv. Wired in `services/daemon/src/agent/workspace-guard.ts` as a
PreToolUse hook, so it runs _before_ the SDK dispatches the tool.

Rules cover `rm`, `find -exec`, `cp`/`mv` with a destination outside the
worktree, `tee` / `>` redirect to forbidden paths, a binary deny-list (`sudo`,
`su`, `chmod 777`, …), `git worktree remove` of the agent's own worktree,
package-manager invocations that bypass the workspace marker, and `$(…)`
command substitution in any catastrophe-position argument. The argv check
stacks behind the realpath / absolute-path scan: both must pass.

Rule 7 was narrowed during the original rollout (PF-1): `pnpm install` / `add`
/ `i` are allowed without `--ignore-scripts`, because pnpm requires explicit
`pnpm.onlyBuiltDependencies` allow-listing in `package.json`. `npm install` and
bare `yarn` / `yarn install` remain denied unless `--ignore-scripts` is
present — both run all postinstalls by default, which is the honest-mistake
hazard the rule addresses.

### `.git/hooks` is denied inside the worktree (FRI-2042)

Every other entry on the write deny-list is an absolute path **outside** the
workspace. `.git/hooks` inverts that: a path the Builder otherwise owns, denied
because of what git does with it.

A `post-checkout` or `pre-commit` dropped there re-executes on the next turn in
an otherwise "fresh" container, because it survives on the reattached worktree
volume. `git config core.hooksPath` is denied for the same reason — the same
persistence by a different route, which no path check can catch, because the
dangerous value is an ordinary-looking directory the repository already
contains.

The match is a path _segment_ (`(^|/)\.git/hooks(/|$)`), not a substring, so
`.github/hooks/` and `src/git/hooks/` are untouched. The rest of `.git` is
untouched as well: Builders commit, branch and push.

**What M1 does not cover, by construction.** A compromised `postinstall` writes
hooks from inside `npm install` and never goes through the Bash tool at all.
This is the regex layer; it raises the cost of an honest mistake and of a lazy
attack. The container is what answers the real case, which is why the model
leads with it.

## M3 — lifecycle-script env

Worker spawn env sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` and `CI=1`.

The pre-PF-1 settings (`NPM_CONFIG_IGNORE_SCRIPTS`,
`npm_config_ignore_scripts`, `PNPM_CONFIG_ENABLE_PRE_POST_SCRIPTS`) were
dropped because they broke pnpm's own `onlyBuiltDependencies` flow and Husky
`prepare` scripts. The M1 rule-7 narrowing carries that load instead.

## M4 — process-group containment, and what replaces it

For a forked worker, spawn passes `detached: true`, making it a process-group
leader (`pid === pgid`), and cascade-stop signals the whole group:
`killPgrp(pgid, signal)` swallows `ESRCH` and `EPERM` and refuses `pgid ≤ 1`.
Archive gives the worker a 5-second cooperative deadline, then SIGTERMs the
whole group — which catches `(sleep &); disown` descendants — and SIGKILLs it
2 seconds after that. The same pgrp SIGTERM fires even on a clean exit, to reap
anything the child leaked behind it.
`reapAllLiveWorkers()` is wired into the shutdown handler so a supervisor stop
does not orphan grandchildren to launchd.

For a containerised builder this is superseded: teardown is `docker stop`, and
the kernel reaps everything in the container's pid namespace. That is one of
the upsides ADR-054 names — teardown stops being a `setsid`-escape tree walk
and becomes a container lifecycle event.

## M5 — resource limits and the turn-stall watchdog

The forked-worker wrap is `bash -c 'ulimit -t 3600; ulimit -n 4096; exec node
…'` — 1h of CPU time, 4096 file descriptors, applied before `exec` so they are
in force from `worker.js` line 0. Both are honoured on Darwin (unlike
`RLIMIT_AS`, which is advisory there) and on Linux. Overridable via
`FRIDAY_WORKER_CPU_LIMIT` / `FRIDAY_WORKER_NOFILE_LIMIT`.

**These do not apply to a containerised builder.** See the table above and
FRI-2083.

The turn-stall watchdog is independent of the spawn path and therefore covers
both shapes: `checkStalledWorkers(workers, now, threshold, kill)` walks the
live map for workers whose `lastBlockStop` is older than the threshold and
calls the supplied kill function. Wired as `startTurnStallWatchdog()` at boot,
threshold 30 minutes (`FRIDAY_TURN_STALL_MS`). `lastBlockStop` resets on every
`block-stop`; heartbeats deliberately do **not** count, because a hung SDK
still emits them but never lands a block.

## M2 — `sandbox-exec`, and why it is not the plan

On macOS, `services/daemon/src/agent/sandbox-profile.ts` renders a per-builder
Apple SBPL profile at `~/.friday/profiles/<agent>.sb`, mode `0600`, removed on
worker exit, and the worker is wrapped in `sandbox-exec -f <profile>`. The
profile is `(allow default)` plus explicit denies: `file-write*` to `~/.ssh`,
`~/.aws`, `~/.gcloud`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.netrc`,
`~/.config/{gh,git,fish}`, shell rcs, `~/Library/Launch{Agents,Daemons}`,
`~/Library/Keychains`, the matching `/Library/…` paths, and all of `<DATA_DIR>`
except carve-outs for `<DATA_DIR>/logs` and the Builder's own worktree; and
`process-exec*` denied for `launchctl`, `crontab`, `at`, `osascript`, `sudo`,
`su`, `defaults`, `pmset`, `tccutil`, and `sandbox-exec` itself (so a looser
profile cannot be re-applied from inside).

**It is macOS-only and it fails open.** `sandboxExecAvailable()` treats a
missing `/usr/bin/sandbox-exec` as "disabled", so on Linux a forked worker runs
with no kernel isolation. The loss is announced at boot, at `warn`:

```
daemon.sandbox-exec  enabled=false  reason=binary-not-found
  note="builders NOT sandboxed; relying on M1 PreToolUse + M4 pgrp only"
```

M2 is **not** being ported, and the trade is better than it first looks. M2
only ever denied `file-write*` — `file-read*` was always allowed, so a builder
on the laptop could already read the vault and `.age-key`. M2 bought integrity,
never confidentiality. A container protects the host far more completely than
any SBPL profile did: no access to the operator's real `~/.ssh`, no host
filesystem, and nothing persists across a rebuild except declared volumes. Its
deny-list also targets macOS surfaces with no Linux analogue, so porting it
would mean inventing a different control and calling it the same name.

It stays in the tree, and stays tested, because the laptop is still how Friday
is developed.

## Residual risk

1. **M1 runs inside the worker isolate.** `checkToolCall` executes in the V8
   process an attacker is trying to escape; a single Bash escape that
   monkey-patches `require.cache` or `process.send` unwinds every downstream
   decision. The honest fix is a daemon-side enforcement plane with an IPC
   round-trip per privileged check. Unchanged by containers — it is why M1 is
   described as the regex layer rather than a boundary.

2. **A containerised builder has no CPU-time or fd ceiling.** Covered at
   wall-clock by the stall watchdog only. FRI-2083.

3. **Intra-Deployment reach, for a forked worker.** Inside the Deployment
   container a forked worker can write anywhere under `$FRIDAY_DATA_DIR` — the
   vault, `.env`, memory entries, other agents' worktrees — and read the
   secrets there. One Deployment serves one Organization, so this is the
   tenant's own data, most of which the agent can reach through its tools
   anyway; the cross-tenant seam is the container, and that holds. Per-task
   builder containers are the fix, and are why FRI-2038 exists.

4. **`setsid` escape, for a forked worker.** A descendant doing
   `python -c "import os; os.setsid()"` detaches from the process group and
   survives teardown. Acceptable on a laptop, and structurally absent in a
   container: the pid namespace goes when the container does.

5. **The proxy is in the trusted tier.** The daemon's own reachability is the
   builder's ceiling, bounded by the allowlist and the address check rather
   than by topology. A dedicated egress container is ADR-055's declared
   destination for this.

6. **The proxy only reaches clients that honour `HTTPS_PROXY`.** Measured:
   Node 22's global `fetch` ignores it, so `WebFetch` and any Node-based tool
   or MCP server using `fetch` have no egress at all — failing as
   `ENETUNREACH`, which does not name the cause. FRI-2085.

7. **A containerised builder cannot authenticate to the model.** Nothing
   supplies an Anthropic credential, so it clones its workspace and then
   cannot take a turn. FRI-2084. This is the gap that prompted ADR-055:
   allowlisting a destination is not the same as being able to authenticate to
   it.

8. **User-configured MCP servers hold their own credentials inside the
   container**, and call hosts no allowlist enumerates. FRI-2086.

## Deferred work

- **Daemon-side enforcement plane** for M1 (residual #1).
- **`Ulimits` in the broker spec** (residual #2) — FRI-2083.
- **`agents.pgid` DB column** for boot-recovery reap. Dropped during the
  original rollout because both `archiveAgent` and the shutdown handler iterate
  the in-memory `live` map and no DB consumer reads the column. If boot
  recovery ever needs to reap from disk state it comes back, paired with a
  freshness check — PID reuse across a reboot is real.
- **Capability declarations** in Friday Apps (`network[]`, `filesystem[]`,
  `exec[]`) — gated on family visibility; tracked in
  [docs/roadmap.md](roadmap.md) as Apps v3.
- **Per-Organization network isolation** (FRI-2040) — mostly delivered as a
  side effect of FRI-2039's internal network, which is why it wants re-scoping
  rather than building.

## File references

- `services/daemon/src/agent/disaster-patterns.ts` — M1 rules.
- `services/daemon/src/agent/disaster-patterns.test.ts` — table-driven rule cases.
- `services/daemon/src/agent/workspace-guard.ts` — M1 wiring (PreToolUse).
- `services/daemon/src/agent/worker-runtime.ts` — the spawn seam; the `ulimit` prelude lives here.
- `services/daemon/src/agent/container-runtime.ts` — the container spawn path (FRI-2038).
- `services/builder-broker/broker.mjs` — the container spec: privileges, limits, network, proxy env.
- `services/daemon/src/api/egress-allowlist.ts` — FRI-2039 allowlist + address checks.
- `services/daemon/src/api/worker-egress.ts` — the CONNECT and plain-HTTP proxy.
- `services/daemon/src/shell-env.ts` — `claudeCodeChildEnv()` (FRI-2059).
- `services/daemon/src/agent/sandbox-profile.ts` — M2 SBPL renderer (macOS).
- `services/daemon/src/agent/sandbox-profile-kernel.test.ts` — M2 kernel integration, skips off Darwin.
- `services/daemon/src/agent/lifecycle.ts` — M4 pgrp helpers, M5 watchdog hooks.
- `services/daemon/src/agent/lifecycle-pgrp.test.ts` — M4 integration tests.
- `services/daemon/src/agent/lifecycle-stall.test.ts` — M5 watchdog unit tests.
- `services/daemon/src/index.ts` — `startTurnStallWatchdog()` boot + `reapAllLiveWorkers()` shutdown.
- ADR-050, ADR-054 in [docs/decisions.md](decisions.md) — the container-as-boundary decision.

The original design grill is preserved in session JSONL
`~/.claude/projects/-Users-seth-Development-Seth-Friday-agent-friday/1b984648-98fe-4f9e-b13b-dfb02e9de42c.jsonl`
(2026-05-13), which is where the M1–M5 numbering comes from.
