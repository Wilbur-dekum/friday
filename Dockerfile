# Friday stack image — FRI-2002, ADR-050.
#
# One container per Deployment: supervisor as PID 1 managing daemon +
# zero-cache + dashboard, against an EXTERNAL Postgres. Postgres is
# deliberately not in here (ADR-050: `CREATE EXTENSION vector` needs SUPERUSER,
# `wal_level=logical` is server-level, and it is the only canonical state — a
# container restart must never sit in front of the customer's only copy).
#
# Scope of this file is "the image builds and starts the supervisor". It is NOT
# expected to come up healthy yet:
#   - FRI-2003 replaces `checkDeps`' Homebrew gating, which currently hard-fails
#     here (`resolveBrew()` falls through to a bare `brew` that does not exist)
#     and makes the supervisor PARK the stack rather than fail loudly.
#   - FRI-2004 makes the Postgres connection configuration.
#   - FRI-2006 settles PID-1 signal handling and child reaping.
#   - The `claude` CLI is absent on purpose: agent auth is ADR-051's Capacity
#     source decision, not a packaging one.
#
# No cross-compile — native addons (`better-sqlite3`, `@rocicorp/zero-sqlite3`,
# `esbuild`, `sharp`) resolve prebuilds by process.arch, so build on the target
# arch or via `buildx --platform`.

ARG NODE_VERSION=22.21.1

# ---- builder ---------------------------------------------------------------
# Full (non-prod) install so turbo can build, then the whole tree is carried
# forward. Mirrors the tarball's "bundle the entire prod node_modules" model
# rather than pruning: same shape the release artifact already ships, so the
# runtime layout matches what `friday start` expects.
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Toolchain for native addons that have no prebuild for this platform/arch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Manifests first so dependency layers cache independently of source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .node-version ./
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/memory/package.json packages/memory/
COPY packages/evolve/package.json packages/evolve/
COPY packages/integrations/linear/package.json packages/integrations/linear/
COPY services/daemon/package.json services/daemon/
COPY services/dashboard/package.json services/dashboard/
# `pnpm.patchedDependencies` in package.json points at patches/, and pnpm hashes
# the patch file during resolution — so it must be present for the install, not
# just for the build.
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# FRI-2060: drop the musl build of the Agent SDK's bundled Claude Code binary.
#
# The SDK ships the CLI itself as eight platform-specific optionalDependencies,
# so no separate install is needed. pnpm installs BOTH linux variants for this
# arch, and the SDK then picks musl on a glibc image: executing it fails with
# ENOENT because the musl loader is absent, which the SDK reports as the
# misleading "Claude Code native binary not found" even though the file is
# there. Removing it leaves the glibc binary as the only candidate.
#
# Also ~235MB — on an image this size that is not a rounding error (FRI-2054).
# Pruned in the BUILDER, not the runtime stage: a first attempt deleted it
# after `WORKDIR /app` but BEFORE `COPY --from=builder`, so it removed nothing
# and the copy brought it straight back.
RUN rm -rf /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-*-musl@* \
  && test ! -d /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-arm64-musl@0.2.132

# ---- runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# git  — builder worktrees and the bare mirrors under $FRIDAY_DATA_DIR/repos
# procps — `pgrep -P` / `pgrep -g`; the supervisor and worker teardown shell out
#          to it, and it is NOT in node:*-slim
# bash  — lifecycle.ts spawns `/bin/bash -c '<ulimit prelude>; exec "$@"'`
# postgresql-client-18 comes from PGDG, not Debian: bookworm ships client 15,
# and pg_dump/pg_restore refuse a server newer than themselves — the compose
# and cloud servers are pg18. Without these, `friday restore` cannot run inside
# a Deployment at all, which is what FRI-2013 needs for the cutover and what
# ADR-051's shared→dedicated move and FRI-2050's export both rely on.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git procps bash ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Propagating container signal — see packages/shared/src/container.ts.
# Only the supervisor is PID 1, so a pid check is false in the daemon,
# the dashboard and every worker; env inheritance reaches all of them.
ENV FRIDAY_CONTAINER=1
# Never the image filesystem: this is the Deployment's persistent volume.
ENV FRIDAY_DATA_DIR=/data
# The SDK writes session transcripts to $HOME/.claude/projects/<cwd>/<id>.jsonl,
# OUTSIDE FRIDAY_DATA_DIR. Without them every Conversation silently starts fresh
# after a deploy, so HOME must be on a volume too (FRI-2007).
ENV HOME=/home/friday

WORKDIR /app
# --chown on the COPY, not a `RUN chown -R` afterwards: changing ownership
# rewrites every file, so the RUN form duplicated the whole tree into a second
# layer (measured 1.86GB COPY + 1.96GB chown). Same result, half the image.
COPY --from=builder --chown=node:node /app /app

RUN mkdir -p /data "$HOME" && chown node:node /data "$HOME"
USER node
VOLUME ["/data", "/home/friday"]

# Dashboard is the only public-facing process (ADR-002). The daemon stays bound
# to 127.0.0.1 inside the container, which is what keeps `isLoopbackOrigin()`
# and the daemon-secret `Host` check meaningful — see ADR-050 on why the stack
# is one container and not three.
EXPOSE 7615

ENTRYPOINT ["node", "packages/cli/dist/bin/supervisor.js"]
