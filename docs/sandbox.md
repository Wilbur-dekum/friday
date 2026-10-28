# Sandbox — worker isolation

Builders run with elevated trust — they have a real git worktree, the
SDK, and a shell. Five complementary layers (M1–M5) keep a runaway
worker from destroying the host or escaping its workspace. This doc
captures what shipped, what was deliberately deferred, and the residual
risks the adversarial review surfaced.

> **Read "Linux and containers" below first.** M1–M5 were designed for a
> macOS laptop. The supported target is now a Linux container, where M2 does
> not exist and the container itself is the isolation boundary (FRI-2062).
> The M1–M5 sections below describe the macOS design as built.

The original design grill is preserved in session JSONL
`~/.claude/projects/-Users-seth-Development-Seth-Friday-agent-friday/1b984648-98fe-4f9e-b13b-dfb02e9de42c.jsonl`
(2026-05-13).

## M1 — PreToolUse catastrophe-pattern rules

A pure function (`checkBashForDisaster(command, workspaceReal)`)
tokenizes the worker's `Bash` arg with `shell-quote` and applies nine
deny rules to the resulting argv. Wired in
`services/daemon/src/agent/workspace-guard.ts` as a PreToolUse hook;
runs _before_ the SDK dispatches the tool.

- Rules cover: `rm`, `find -exec`, `cp`/`mv` with destination outside
  the worktree, `tee` / `> redirect` to forbidden paths, the binary
  deny-list (`sudo`, `su`, `chmod 777`, etc.), `git worktree remove`
  of the agent's own worktree, package-manager invocations that
  bypass the workspace marker, and `$(…)` command substitution in any
  catastrophe-position arg.
- The argv check stacks behind the existing realpath / absolute-path
  scan. Defense in depth: both must pass for the tool to dispatch.
- 73 table-driven test cases in
  `services/daemon/src/agent/disaster-patterns.test.ts` pin each rule
  to a literal command string + expected verdict and reason substring.

Rule 7 was narrowed by PF-1 during the rollout: `pnpm install` /
`pnpm add` / `pnpm i` are allowed without `--ignore-scripts` because
pnpm requires explicit `pnpm.onlyBuiltDependencies` allow-listing in
package.json. `npm install` and bare `yarn` / `yarn install` remain
denied unless `--ignore-scripts` is present — both run all postinstalls
by default and that is the honest-mistake hazard the rule addresses.

## M2 — sandbox-exec SBPL kernel backstop

`services/daemon/src/agent/sandbox-profile.ts` renders a per-builder
Apple SBPL (Sandbox Profile Language) profile at
`~/.friday/profiles/<agent>.sb`, mode `0600`, removed when the worker
exits. The worker process is wrapped in `sandbox-exec -f <profile>`
before `exec node …`, so every syscall and Mach lookup the worker
issues is filtered by the macOS sandbox kernel.

Profile shape (`(allow default)` + explicit denies):

- `file-write*` denied to `~/.ssh`, `~/.aws`, `~/.gcloud`, `~/.kube`,
  `~/.docker`, `~/.gnupg`, `~/.netrc`, `~/.config/{gh,git,fish}`,
  shell rcs (`.bashrc`/`.zshrc`/`.profile`/…), `~/Library/LaunchAgents`,
  `~/Library/LaunchDaemons`, `~/Library/Keychains`, the matching
  `/Library/...` paths, and all of `<DATA_DIR>` _except_ the carve-outs
  for `<DATA_DIR>/logs` (worker logs its own progress) and
  `<this-worktree>` (the Builder's own workspace).
- `process-exec*` denied for `launchctl`, `crontab`, `at`,
  `osascript`, `sudo`, `su`, `defaults`, `pmset`, `tccutil`,
  `sandbox-exec` (forbids re-invocation with a looser profile from
  inside the sandbox).
- Everything else (`mach-lookup`, generic `file-read*`, plain
  `process-exec` of non-deny-listed binaries) is allowed.

Tests live in `services/daemon/src/agent/sandbox-profile.test.ts` (6
renderer unit tests) and `sandbox-profile-kernel.test.ts` (10 kernel-
side integration tests that shell out to real `sandbox-exec` on
Darwin; skip cleanly elsewhere). The kernel tests verify each deny
fires, each carve-out works, `sandbox-exec` re-invocation refusal
holds, and the IPC channel survives the wrap.

The daemon emits a `daemon.sandbox-exec` log line at startup announcing
enabled / disabled with the reason — operators can grep for it to
verify the kernel layer is actually engaged.

## M3 — Lifecycle-script env (after PF-1 narrowing)

Worker spawn env sets:

- `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`
- `CI=1`

The pre-PF-1 settings (`NPM_CONFIG_IGNORE_SCRIPTS=true`,
`npm_config_ignore_scripts=true`,
`PNPM_CONFIG_ENABLE_PRE_POST_SCRIPTS=false`) were dropped because they
broke pnpm's own `onlyBuiltDependencies` allow-list flow and Husky
`prepare` scripts. The M1 rule 7 narrowing now carries that load —
deny `npm install` / bare `yarn` without `--ignore-scripts`; trust
pnpm's explicit allow-list.

## M4 — Process-group containment

Worker spawn passes `detached: true`, making each worker a process-
group leader (`pid === pgid`). Cascade-stop signals the whole pgrp:

- `killPgrp(pgid, signal)` swallows `ESRCH` and `EPERM`; refuses
  `pgid ≤ 1` as a sanity guard. Lives in `lifecycle.ts`.
- Archive's 5-second cooperative deadline escalates to
  `process.kill(-pgid, "SIGTERM")` (catches `(sleep &); disown`
  descendants); a 7-second floor sends `SIGKILL` to the same pgrp.
- `reapAllLiveWorkers()` is wired into `index.ts`'s shutdown handler
  so the supervisor's stop signal doesn't orphan grandchildren to
  launchd.

Tests in `lifecycle-pgrp.test.ts` (3 integration tests with real
subprocess + `disown`'d `sleep` + a `ps` probe) cover the pgrp-kill
path including `ESRCH` swallow and the `pgid ≤ 1` refusal.

## M5 — Resource limits + turn-stall watchdog

The worker wrap is `bash -c 'ulimit -t 3600; ulimit -n 4096; exec node
…'`. The `-t 3600` cap is 1h of CPU time per worker; `-n 4096` is open
file descriptors. Both are Darwin-honored (unlike `RLIMIT_AS` which is
advisory on macOS).

A separate timer-based watchdog in `services/daemon/src/agent/`:

- `checkStalledWorkers(workers, now, threshold, kill)` walks the live
  map, looks for workers whose `lastBlockStop` is older than the
  threshold, calls the supplied kill fn. Pure function for testability.
- Production wires it as `startTurnStallWatchdog()` in `index.ts`'s
  boot, with the threshold defaulting to 30 minutes
  (`FRIDAY_TURN_STALL_MS` env override). `lastBlockStop` resets on
  every `block-stop` IPC; heartbeats deliberately do NOT count (a
  hung SDK still emits them but never lands a block).

## Linux and containers — what actually applies (FRI-2062)

M1–M5 were designed for a macOS laptop. The supported deployment target is now
a Linux container (ADR-050), and the layers do not all survive the move.
Measured in the compose stack:

| Layer                        | In a container                                                  |
| ---------------------------- | --------------------------------------------------------------- |
| M1 PreToolUse rules          | **Active.** Pure JS, no platform gate.                          |
| M2 sandbox-exec SBPL         | **Gone.** `/usr/bin/sandbox-exec` is macOS-only.                |
| M3 Lifecycle-script env      | Active.                                                         |
| M4 Process-group containment | Active — `detached: true` + `kill(-pgid)` are POSIX.            |
| M5 rlimits + stall watchdog  | Active, and `ulimit -t`/`-n` are enforced rather than advisory. |

Four of five hold. The loss is announced at boot, at `warn`:

```
daemon.sandbox-exec  enabled=false  reason=binary-not-found
  note="builders NOT sandboxed; relying on M1 PreToolUse + M4 pgrp only"
```

**The decision (FRI-2062): the Deployment container is the isolation boundary.**
This is E4's stated direction, not a concession — and the trade is better than
it first looks. M2 only ever denied `file-write*`; `file-read*` was always
allowed, so a builder on the laptop could already read the vault and
`.age-key`. M2 bought integrity, never confidentiality. A container, meanwhile,
protects the host far more completely than any SBPL profile did: no access to
the operator's real `~/.ssh`, no host filesystem, and nothing persists across a
rebuild except the declared volumes.

**What that boundary requires, and what broke it.** A boundary only holds if
nothing inside it holds credentials reaching outside. `docker-compose.yml` set
`FRIDAY_ADMIN_DATABASE_URL` — a Postgres **superuser** — on the long-running
service, and the daemon spawns workers with `...process.env`, so every builder
inherited it. On the shared cluster ADR-051 plans, one superuser reaches every
Organization's database. That defeated FRI-2005's explicit decision ("the
Deployment's own role stays non-superuser and scoped to its database") from a
direction FRI-2005 did not cover.

Fixed: the variable is no longer set on the service, and
`probePostgresHealth()` — the supervisor preflight that was the last runtime
consumer — now runs its three read-only probes as the application role
(`pg_roles` and `pg_database` are world-readable; `SHOW wal_level` is visible
to any role). Provisioning and `friday restore` take the credential
per-invocation instead.

**Accepted residual risk, until FRI-2038.** Inside the container a builder can
still write anywhere under `$FRIDAY_DATA_DIR` — the vault, `.env`, memory
entries, other agents' worktrees — and read the secrets there. One Deployment
serves one Organization, so that is the tenant's own data, most of which the
agent can reach through its tools anyway; the cross-tenant seam is the
container, and that holds. Per-task builder containers (FRI-2038) are the fix
for intra-Deployment isolation, and egress deny-by-default (FRI-2039) for the
network, which is currently unrestricted.

The full rewrite of this document around cgroups and container lifetime is
FRI-2043. This section is the interim honest account, not that rewrite.

## Adversarial review — residual risk

The 2026-05-13 review surfaced three classes of weakness that did not
land in v1:

1. **L1 + L5 run inside the worker isolate.** `checkToolCall` and any
   in-process counter execute in the V8 process the attacker is trying
   to escape. A single Bash escape that monkey-patches `require.cache`
   or `process.send` unwinds every downstream decision. The honest fix
   is a **daemon-side enforcement plane** with IPC round-trips for
   every privileged check; that's the deferred architecture for a
   future hardening cycle.

2. **pgrp-kill is not a kernel sandbox.** A worker descendant that
   does `python -c "import os; os.setsid()"` (or equivalent) creates a
   new session and detaches from the pgrp. The pgrp signal misses it
   on archive teardown. The kernel sandbox (M2) constrains _what the
   descendant can do_ but not whether it survives the parent's death.
   Acceptable today because the worktree's denies prevent persistence
   outside the worktree and the host's launchd will eventually reap
   ownerless processes at shutdown.

3. **rlimits via syscall are Darwin-advisory.** Beyond `ulimit -t`
   and `-n` from the shell wrap, the `RLIMIT_AS` (virtual memory),
   `RLIMIT_NPROC` (process count), and similar limits are either
   advisory or self-DoS-prone on macOS. The shell wrap covers the
   useful subset; calling `setrlimit` from a node `posix` addon
   would require native bindings (install friction) for marginal gain.

## Deferred work

- **Daemon-side enforcement plane** for L1 + L5 (per residual #1).
- **`agents.pgid` DB column** for boot-recovery reap. Dropped during
  the original rollout because both `archiveAgent` and the shutdown
  handler iterate the in-memory `live` map; no DB consumer reads the
  column. If/when boot recovery needs to reap from disk state, the
  column comes back — paired with a freshness check (PID reuse is a
  real concern across reboot).
- **Capability declarations** in Friday Apps (network[], filesystem[],
  exec[]) — gated on family-visibility; tracked under
  [docs/roadmap.md](roadmap.md) as Apps v3.

## File references

- `services/daemon/src/agent/disaster-patterns.ts` — M1 rules.
- `services/daemon/src/agent/disaster-patterns.test.ts` — 73 cases.
- `services/daemon/src/agent/workspace-guard.ts` — M1 wiring (PreToolUse).
- `services/daemon/src/agent/sandbox-profile.ts` — M2 SBPL renderer.
- `services/daemon/src/agent/sandbox-profile.test.ts` — M2 unit tests.
- `services/daemon/src/agent/sandbox-profile-kernel.test.ts` — M2 kernel integration.
- `services/daemon/src/agent/lifecycle.ts` — M4 pgrp helpers, M5 stall watchdog hooks, `bash -c 'ulimit ...; exec ...'` wrap.
- `services/daemon/src/agent/lifecycle-pgrp.test.ts` — M4 integration tests.
- `services/daemon/src/agent/lifecycle-stall.test.ts` — M5 unit tests.
- `services/daemon/src/index.ts` — `startTurnStallWatchdog()` boot + `reapAllLiveWorkers()` shutdown wire-up.
- ADR-021 in [docs/decisions.md](decisions.md) — Apps platform trust-by-discipline.
