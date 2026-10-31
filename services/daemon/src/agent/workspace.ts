/**
 * Workspace (git worktree) management for Builders.
 *
 * Convention: builders run inside `~/.friday/workspaces/<builder-name>/` —
 * a fresh git worktree off the project's main repo. The orchestrator's
 * `agent_create` tool dispatches here when type=builder.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { DATA_DIR, atomicWriteFile } from "@friday/shared";
import { logger } from "../log.js";

/**
 * Resolve `candidate` through realpath. If the leaf doesn't exist (e.g. a
 * workspace that was already removed), walk up to the nearest existing
 * parent and re-attach the missing tail — that way symlink-following on
 * the parent still gives us the canonical absolute path (notably
 * `/private/var/...` vs `/var/...` on macOS).
 */
function realpathWithMissingTail(candidate: string): string {
  let cur = normalize(candidate).replace(/\/+$/, "");
  let tail = "";
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync(cur);
      return tail ? join(real, tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return tail ? join(cur, tail) : cur;
      const leaf = basename(cur);
      tail = tail ? join(leaf, tail) : leaf;
      cur = parent;
    }
  }
  return tail ? join(cur, tail) : cur;
}

const WORKSPACES_ROOT = join(DATA_DIR, "workspaces");

/**
 * Bare-mirror clones live here. When a builder's `baseRepo` is a remote URL
 * rather than a local checkout, we maintain one `--mirror` clone per repo at
 * `<DATA_DIR>/repos/<name>.git` and worktree the builder's workspace off it.
 * This removes the need for a persistent local dev tree on the machine.
 */
const REPOS_ROOT = join(DATA_DIR, "repos");

export function workspacesRoot(): string {
  return WORKSPACES_ROOT;
}

export function reposRoot(): string {
  return REPOS_ROOT;
}

/**
 * Per-task staging repos live here (FRI-2077).
 *
 * A containerised Builder clones from the daemon (FRI-2076) and has to push its
 * branch back somewhere. Neither end of `resolveRepoGitDir` can be that
 * somewhere:
 *
 *   - The bare `--mirror` under `<DATA_DIR>/repos/` is refreshed with `git
 *     remote update --prune`, and a mirror's refspec is `+refs/*:refs/*`. A
 *     Builder branch sitting there un-forwarded is PRUNED by the next
 *     `createWorkspace` against that mirror. Measured, including for refs
 *     parked outside `refs/heads/*` — nothing under `refs/` survives.
 *   - A local-path repo IS the user's own working repository, so landing
 *     pushes there writes Builder refs into the daily driver's checkout.
 *
 * So each task gets its own bare repo that nothing prunes and nothing else
 * reads. A mirror is BY DEFINITION a copy of upstream, so holding state that
 * exists only locally in one is wrong regardless of ordering; this is the
 * per-task shape FRI-2038 already uses for volumes, applied to refs.
 */
const STAGING_ROOT = join(DATA_DIR, "staging");

export function stagingRoot(): string {
  return STAGING_ROOT;
}

/**
 * The staging repo for one Builder.
 *
 * `name` reaches here from the agent registry rather than from a URL, so it is
 * not attacker-chosen the way a request parameter is. It is still interpolated
 * into a filesystem path, and rejecting separators outright is cheaper than
 * reasoning about every caller: no legitimate agent name contains one.
 */
export function stagingPathForAgent(name: string): string {
  if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new Error(`invalid agent name for a staging repo: ${name}`);
  }
  return join(STAGING_ROOT, `${name}.git`);
}

/**
 * Containment guard for the staging root, in the shape of
 * `assertInsideWorkspacesRoot` and for the same reason: resolve through
 * realpath so a symlink cannot redirect a removal outside the root.
 */
function assertInsideStagingRoot(candidate: string): string {
  const rootReal = realpathSync(STAGING_ROOT).replace(/\/+$/, "");
  const candidateReal = realpathWithMissingTail(candidate);
  if (candidateReal === rootReal) {
    throw new Error(`refusing to delete the staging root itself: ${rootReal}`);
  }
  if (!candidateReal.startsWith(rootReal + "/")) {
    throw new Error(`refusing to operate on path outside ${rootReal}: ${candidateReal}`);
  }
  return candidateReal;
}

/**
 * Create a Builder's staging repo, seeded so its first push is a delta.
 *
 * `git init --bare` alone is correct but wasteful: an empty repo shares no
 * objects with the clone the Builder pushes from, so the push would carry the
 * project's entire history back over the loopback. Seeding the base ref costs
 * one local fetch and turns that into a fast-forward of a few commits.
 *
 * A seed failure is deliberately NOT fatal. The staging repo still accepts the
 * push, it just carries more objects — refusing to create a Builder because an
 * optimization failed would be the wrong trade. Same fail-soft shape as
 * `ensureMirror`'s stale-fetch path.
 */
export function ensureStagingRepo(opts: {
  name: string;
  repo: string;
  branch: string;
  fromRef?: string;
}): string {
  const stagingPath = stagingPathForAgent(opts.name);
  if (!existsSync(STAGING_ROOT)) {
    mkdirSync(STAGING_ROOT, { recursive: true });
  }
  if (!existsSync(stagingPath)) {
    execFileSync("git", ["init", "--bare", "--quiet", stagingPath], { stdio: "pipe" });
    logger.log("info", "workspace.staging.init", { name: opts.name, path: stagingPath });
  }

  // Candidate seed refs, best first. The mode split is the same one
  // `createWorkspace`'s start-point makes: a `--mirror` clone maps remote heads
  // into `refs/heads/*`, while a local checkout keeps upstream main at
  // `refs/remotes/origin/main`. The local path then falls back to the repo's
  // OWN `main`, because a checkout with no `origin` is ordinary — a fresh repo,
  // or one that only ever existed locally — and the seed is an optimization, so
  // giving up on it there would silently cost a full-history push.
  const gitDir = resolveRepoGitDir(opts.repo);
  const candidates = opts.fromRef
    ? [opts.fromRef]
    : isLocalRepo(opts.repo)
      ? ["refs/remotes/origin/main", "refs/heads/main"]
      : ["refs/heads/main"];

  const failures: string[] = [];
  for (const srcRef of candidates) {
    try {
      execFileSync(
        "git",
        [
          "-C",
          stagingPath,
          ...GIT_TRANSPORT_HARDENING,
          "fetch",
          "--no-tags",
          gitDir,
          `${srcRef}:refs/heads/${opts.branch}`,
        ],
        { stdio: "pipe" },
      );
      return stagingPath;
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string };
      failures.push(`${srcRef}: ${e.stderr ? String(e.stderr).trim() : (e.message ?? err)}`);
    }
  }
  logger.log("warn", "workspace.staging.seed.fail", {
    name: opts.name,
    stagingPath,
    tried: candidates,
    failures,
    note: "push will carry full history instead of a delta",
  });
  return stagingPath;
}

/**
 * Remove a Builder's staging repo.
 *
 * SLICE 3 WILL NEED TO GATE THIS. Once `post-receive` forwards pushes onward,
 * removing staging while it still holds a ref that was never forwarded throws
 * away the Builder's work — which is the entire reason pushes land here rather
 * than in the prunable mirror. Today nothing forwards, so there is nothing to
 * retain and unconditional removal is what keeps the directory from leaking.
 */
export function removeStagingRepo(name: string): void {
  let stagingPath: string;
  try {
    stagingPath = stagingPathForAgent(name);
  } catch (err) {
    logger.log("warn", "workspace.staging.remove.skip", {
      name,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!existsSync(stagingPath)) return;
  try {
    assertInsideStagingRoot(stagingPath);
    rmSync(stagingPath, { recursive: true, force: true });
    logger.log("info", "workspace.staging.removed", { name, path: stagingPath });
  } catch (err) {
    logger.log("warn", "workspace.staging.remove.fail", {
      name,
      stagingPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Marker file dropped inside every workspace so the worker can verify it and
 * the archive path can recover the git dir the workspace was created from. */
const WORKSPACE_MARKER = ".friday-workspace.json";

interface WorkspaceMarker {
  name: string;
  branch: string;
  createdAt: string;
  /** Absolute path to the git dir the worktree is registered with: the local
   * `baseRepo` for the local path, or the bare mirror for the remote path.
   * Older markers (pre-mirror) omit this — archive falls back to `baseRepo`. */
  gitDir?: string;
}

/**
 * Decide whether `baseRepo` is a usable local git checkout. The orchestrator
 * may pass either:
 *   - a local filesystem path to an existing git working tree, OR
 *   - a remote URL (https / ssh / scp-style / file://) when there is no
 *     local checkout on the machine.
 *
 * A bare URL is the contract for the remote case — the `name` is derived from
 * the URL basename minus `.git`. The orchestrator owns the name→URL mapping;
 * the daemon only needs to accept the resolved URL here.
 */
export function isLocalRepo(baseRepo: string): boolean {
  // A `.git` entry (dir or file for worktrees/submodules) is the cheap, robust
  // signal. Remote URLs (`https://…`, `git@…:…`, `ssh://…`) never satisfy this.
  if (existsSync(join(baseRepo, ".git"))) return true;
  // Unusual layouts: fall back to asking git. Note a BARE repo answers
  // `false` here (exit 0) — that's intentional: a bare repo has no working
  // tree to `git worktree add` an in-tree builder from, so we treat it as
  // remote and mirror it. Git throws (non-zero exit) when the dir isn't a repo
  // at all, which also lands us on the remote path.
  try {
    const out = execFileSync("git", ["-C", baseRepo, "rev-parse", "--is-inside-work-tree"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Derive a stable, COLLISION-RESISTANT mirror name from a remote URL.
 *
 * The basename alone is ambiguous: `github.com/orgA/shared.git` and
 * `github.com/orgB/shared.git` both end in `shared`, so a basename-only name
 * would map two distinct codebases onto the same mirror — the second create
 * would `remote update` against the first origin and worktree the WRONG repo
 * (MEDIUM 3 in the PR-271 review). To keep mirrors distinct we append a short
 * hash of the *full normalized* URL to the readable basename:
 *   `git@github.com:org/agent-friday.git` → `agent-friday-1a2b3c4d`.
 *
 * Normalization folds only cosmetic differences (trailing slashes, a trailing
 * `.git`, the scp-style `host:org/repo` ↔ `host/org/repo` form) so the same
 * remote always hashes identically; everything that actually identifies the
 * remote (host, org, path) feeds the hash. The hash is the load-bearing part —
 * the basename prefix is purely for human-readable directory names.
 */
function normalizeRemoteForHash(remote: string): string {
  let s = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  // Fold scp-style `host:org/repo` into `host/org/repo` so it hashes the same
  // as its ssh:// equivalent. Only rewrite the FIRST colon after the host and
  // only when it isn't a scheme (`://`) or a port (`:1234/`).
  const scp = /^([^/:]+@[^/:]+|[^/:]+):(?![/0-9])(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  return s;
}

export function mirrorNameFromRemote(remote: string): string {
  const stripped = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  // Handle both `/`-separated URLs and scp-style `host:org/repo`.
  const lastSlash = stripped.lastIndexOf("/");
  const lastColon = stripped.lastIndexOf(":");
  const cut = Math.max(lastSlash, lastColon);
  const rawBase = cut >= 0 ? stripped.slice(cut + 1) : stripped;
  // Sanitize the human-readable prefix to a safe directory token.
  const base = (rawBase || "repo").replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
  const hash = createHash("sha256")
    .update(normalizeRemoteForHash(remote))
    .digest("hex")
    .slice(0, 8);
  return `${base}-${hash}`;
}

export function mirrorPathForRemote(remote: string): string {
  return join(REPOS_ROOT, `${mirrorNameFromRemote(remote)}.git`);
}

/**
 * Reject a remote that could be interpreted as a git option or a transport
 * helper invocation (LOW/MEDIUM 4). A leading `-` would be parsed as an option
 * even after `--` in some git versions, and `ext::`/`fd::`/`-c` style values
 * are remote-helper transports that can execute arbitrary commands. Not
 * remotely exploitable here (loopback + trusted orchestrator) but cheap to
 * harden. The `protocol.ext/fd.allow=never` config on the clone (see
 * GIT_TRANSPORT_HARDENING) is the second layer, blocking those transports
 * regardless of this check while leaving `file`/`http`/`ssh` working.
 */
function assertSafeRemote(remote: string): void {
  if (remote.startsWith("-")) {
    throw new Error(`refusing remote that begins with '-' (option injection): ${remote}`);
  }
  if (/^(ext|fd)::/i.test(remote)) {
    throw new Error(`refusing remote with transport-helper scheme: ${remote}`);
  }
}

/**
 * Config flags that disable the dangerous remote-helper transports on the
 * clone. `ext` runs an arbitrary shell command; `fd` reads from caller fds.
 * We block exactly those (and NOT `file`/`http`/`ssh`, which legitimate local
 * and remote mirrors use — a blanket `GIT_PROTOCOL_FROM_USER=0` would break a
 * `file://`/bare-path remote). These are passed as leading `-c` options BEFORE
 * the subcommand so they bind regardless of the remote value.
 */
const GIT_TRANSPORT_HARDENING = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"];

/**
 * LOW 5 — concurrent-create TOCTOU on the mirror: documented, not guarded.
 *
 * Two builders created against the same remote could in principle race the
 * clone-if-missing/else-fetch below, and a concurrent `git clone --mirror`
 * into a half-populated dir would corrupt the mirror. In practice this cannot
 * happen within the daemon: the entire create path uses `execFileSync`, which
 * blocks the Node event loop for the duration of each git op, so two
 * `createWorkspace` calls in this single-threaded process run strictly
 * sequentially — there is no interleaving window to race. A cross-process race
 * would require a second daemon on the same DATA_DIR, which the deployment
 * model forbids (exactly one daemon per machine). If the create path is ever
 * made async (e.g. switched to `execFile`/spawn), add a per-`mirrorPath`
 * promise-chain mutex here to restore serialization.
 */

/**
 * Ensure a bare `--mirror` clone of `remote` exists at `mirrorPath` and is
 * up to date. Returns nothing; throws on a hard clone failure (workspace
 * creation cannot proceed without it). A stale-fetch failure is non-fatal —
 * we warn and proceed against the cached mirror, mirroring the local
 * `workspace.fetch.fail` semantics.
 */
function ensureMirror(remote: string, mirrorPath: string, name: string): void {
  assertSafeRemote(remote);
  if (!existsSync(REPOS_ROOT)) {
    mkdirSync(REPOS_ROOT, { recursive: true });
  }
  if (!existsSync(mirrorPath)) {
    logger.log("info", "workspace.mirror.clone", { name, remote, mirrorPath });
    try {
      // `--` separates the remote/path positionals from options; the
      // assertSafeRemote guard + `protocol.ext/fd.allow=never` harden against a
      // hostile `remote` value (LOW/MEDIUM 4).
      execFileSync(
        "git",
        [...GIT_TRANSPORT_HARDENING, "clone", "--mirror", "--", remote, mirrorPath],
        {
          stdio: "pipe",
        },
      );
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      logger.log("error", "workspace.mirror.clone.fail", {
        name,
        remote,
        mirrorPath,
        message: e.message ?? String(err),
        stderr: e.stderr ? String(e.stderr).trim() : undefined,
        stdout: e.stdout ? String(e.stdout).trim() : undefined,
      });
      throw err;
    }
    return;
  }
  // Mirror already present: refresh it so the new worktree roots on the latest
  // upstream. `remote update --prune` updates all configured remotes (a
  // --mirror clone has exactly one: `origin`) and prunes deleted refs.
  logger.log("info", "workspace.mirror.fetch", { name, mirrorPath });
  try {
    execFileSync("git", ["-C", mirrorPath, "remote", "update", "--prune"], { stdio: "pipe" });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    logger.log("warn", "workspace.mirror.fetch.fail", {
      name,
      mirrorPath,
      message: e.message ?? String(err),
      stderr: e.stderr ? String(e.stderr).trim() : undefined,
      stdout: e.stdout ? String(e.stdout).trim() : undefined,
    });
  }
}

/**
 * FIX_FORWARD 6.4: defense-in-depth containment guard. Resolves both the
 * workspaces root and the candidate path through `realpathSync` so a
 * symlink pointing at `/etc` can't trick a deletion into nuking system
 * files. Returns the canonical absolute path on success; throws otherwise.
 *
 * `existsRequired` lets callers (delete flow) reject "no such workspace"
 * with a clear error before any destructive op runs. When false (used by
 * tests), only the parent root must exist.
 */
export function assertInsideWorkspacesRoot(
  candidate: string,
  { existsRequired = true }: { existsRequired?: boolean } = {},
): string {
  if (existsRequired && !existsSync(candidate)) {
    throw new Error(`workspace path not found: ${candidate}`);
  }
  // realpath both sides (or walk up to the nearest existing parent) so a
  // symlink can't dodge the containment check, and so macOS's /var ↔
  // /private/var indirection doesn't false-positive a "path outside" error.
  const rootReal = realpathSync(WORKSPACES_ROOT).replace(/\/+$/, "");
  const candidateReal = realpathWithMissingTail(candidate);
  if (candidateReal === rootReal) {
    throw new Error(`refusing to delete workspaces root itself: ${rootReal}`);
  }
  if (!candidateReal.startsWith(rootReal + "/")) {
    throw new Error(`refusing to operate on path outside ${rootReal}: ${candidateReal}`);
  }
  return candidateReal;
}

export interface CreateWorkspaceOptions {
  name: string;
  baseRepo: string;
  branch: string;
  /**
   * Explicit base ref for "stacked PR" workflows. When provided, the
   * worktree is rooted here and the origin/main fetch is skipped.
   * When omitted (the default), `git fetch origin main` runs first and
   * `origin/main` is used as the start-point so the new branch is always
   * rooted on the latest upstream commit.
   */
  fromRef?: string;
}

export interface Workspace {
  path: string;
  branch: string;
  baseRepo: string;
}

export function ensureWorkspacesRoot(): void {
  if (!existsSync(WORKSPACES_ROOT)) {
    mkdirSync(WORKSPACES_ROOT, { recursive: true });
  }
}

export function workspacePath(name: string): string {
  return join(WORKSPACES_ROOT, name);
}

export function createWorkspace(opts: CreateWorkspaceOptions): Workspace {
  ensureWorkspacesRoot();
  const path = workspacePath(opts.name);
  if (existsSync(path)) {
    throw new Error(`workspace ${opts.name} already exists at ${path}`);
  }

  // Two modes, decided by `baseRepo`:
  //   - LOCAL: `baseRepo` is an existing git working tree on disk →
  //     `git worktree add` directly off it (the original behavior).
  //   - REMOTE: `baseRepo` is a remote URL (no local checkout exists) →
  //     maintain a bare `--mirror` at `<DATA_DIR>/repos/<name>.git` and
  //     `git worktree add` off that mirror. The orchestrator resolves a repo
  //     NAME to this URL before calling us (out of scope here): `worktree.repo`
  //     simply arrives as a bare remote URL in that case.
  const local = isLocalRepo(opts.baseRepo);
  // `gitDir` is the cwd we run every git op against (fetch/refresh, branch
  // delete, worktree add) and the value we persist for archive.
  const gitDir = local ? opts.baseRepo : mirrorPathForRemote(opts.baseRepo);

  // Stacked PR exception: if caller supplied an explicit base ref, use it
  // as-is and skip the upstream refresh. Otherwise refresh `main` first so the
  // new branch is always rooted on the latest upstream commit, not whatever
  // the cached ref currently points at.
  //
  // The default start-point differs by mode. A `--mirror` clone maps remote
  // heads directly into `refs/heads/*` (no `refs/remotes/origin/*`), so its
  // upstream main is the local ref `main`. The local-checkout path keeps using
  // `origin/main` (a normal remote-tracking ref there).
  const refreshUpstream = opts.fromRef === undefined;
  const startPoint = opts.fromRef ?? (local ? "origin/main" : "main");

  if (local) {
    if (refreshUpstream) {
      try {
        execFileSync("git", ["fetch", "origin", "main"], {
          cwd: gitDir,
          stdio: "pipe",
        });
      } catch (err) {
        // Non-fatal: proceed with the cached origin/main. Warn so it's visible
        // in the logs, but don't abort workspace creation.
        const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
        logger.log("warn", "workspace.fetch.fail", {
          name: opts.name,
          message: e.message ?? String(err),
          stderr: e.stderr ? String(e.stderr).trim() : undefined,
          stdout: e.stdout ? String(e.stdout).trim() : undefined,
        });
      }
    }
  } else {
    // Remote: clone-or-refresh the bare mirror before worktree-ing off it.
    // A clone failure is fatal (handled inside ensureMirror via throw); a
    // refresh failure is non-fatal and proceeds against the cached mirror.
    ensureMirror(opts.baseRepo, gitDir, opts.name);
    // BLOCKER 2: prune stale worktree registrations in the mirror before the
    // `git worktree add` below. If a prior workspace dir of the same name was
    // removed out-of-band (the SDK auto-removes a no-op builder's worktree, or
    // a botched archive left the mirror with a dangling registration), the dir
    // is gone but the mirror still lists `.../workspaces/<name>` as a worktree.
    // Without this prune the add fails with
    //   fatal: '.../workspaces/<name>' is a missing but already registered worktree
    // and the re-create wedges permanently. Prune is a no-op when there's
    // nothing stale, so it's safe to run unconditionally on the remote path.
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: gitDir, stdio: "pipe" });
    } catch (err) {
      logger.log("warn", "workspace.create.prune.fail", {
        name: opts.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Pre-flight: if the branch already exists (stale from a prior failed
  // cleanup), delete it before git worktree add, which would otherwise fail
  // with "branch already exists".
  try {
    execFileSync("git", ["branch", "-D", opts.branch], {
      cwd: gitDir,
      stdio: "pipe",
    });
    logger.log("info", "workspace.branch.stale-delete", {
      name: opts.name,
      branch: opts.branch,
    });
  } catch {
    // Branch didn't exist — the expected path.
  }

  try {
    execFileSync("git", ["worktree", "add", "-b", opts.branch, path, startPoint], {
      cwd: gitDir,
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    logger.log("error", "workspace.create.fail", {
      name: opts.name,
      message: e.message ?? String(err),
      stderr: e.stderr ? String(e.stderr).trim() : undefined,
      stdout: e.stdout ? String(e.stdout).trim() : undefined,
    });
    throw err;
  }
  // Stamp a marker file inside the workspace so the worker can verify it and
  // so archiveWorkspace can recover the git dir this worktree is registered
  // with (the mirror, for the remote path — the local checkout no longer
  // exists in that mode).
  atomicWriteFile(
    join(path, WORKSPACE_MARKER),
    JSON.stringify({
      name: opts.name,
      branch: opts.branch,
      createdAt: new Date().toISOString(),
      gitDir,
    } satisfies WorkspaceMarker),
  );
  return { path, branch: opts.branch, baseRepo: gitDir };
}

export interface ArchiveWorkspaceOptions {
  /** Branch to delete from the parent repo after the worktree is removed.
   * Optional for backward compat — older callers without branch metadata
   * skip the branch delete. New code should always pass it. */
  branch?: string;
  /**
   * BLOCKER 1: the ORIGINAL source repo the workspace was created from — i.e.
   * `worktree.repo` at create time, persisted on the agent registry row and
   * read back here by the route. When present this is the AUTHORITATIVE input
   * for resolving the git dir to tear down: the same `isLocalRepo(repo) ?
   * repo : mirrorPathForRemote(repo)` derivation `createWorkspace` used, so
   * teardown deterministically targets the mirror in remote mode and the local
   * checkout in local mode. This must be preferred over the in-workspace marker
   * because the Claude Agent SDK frequently removes a no-op builder's worktree
   * (and thus the marker) BEFORE archive runs — so the marker is usually gone.
   * Critically, in remote mode resolution NEVER falls back to `process.cwd()`
   * (the daemon's own repo), which previously caused `git branch -D` /
   * `git worktree prune` to run against the wrong repo.
   */
  repo?: string;
  /**
   * Who owns the workspace directory (FRI-2080). Absent reads as `"daemon"`,
   * so every caller written before this keeps its behaviour.
   *
   * For a `"container"` workspace the directory is a volume the broker tears
   * down, and the daemon has no worktree registration to remove. Skipping
   * that work is not just tidiness: `workspacePath(name)` would resolve to the
   * daemon's own `workspaces/<name>`, so a container Builder reusing the name
   * of an earlier daemon-owned one would `rm -rf` a directory that was never
   * its own. The branch delete still runs — once FRI-2077 forwards pushes the
   * branch really does live in the daemon's git dir, and "destroy means
   * destroy" is unchanged.
   */
  owner?: WorkspaceOwner;
}

/**
 * Deterministically resolve the git dir for a source `repo`.
 *
 * Mirrors `createWorkspace`'s `gitDir` derivation exactly so create, teardown
 * and — since FRI-2076 — SERVING all agree on the target:
 *   - LOCAL repo (an on-disk working tree) → the repo path itself.
 *   - REMOTE (a URL / bare repo / missing path) → the bare mirror under
 *     `<DATA_DIR>/repos/`. It does NOT matter whether the local checkout the
 *     URL might point at exists; remote mode ALWAYS targets the mirror.
 */
export function resolveRepoGitDir(repo: string): string {
  return isLocalRepo(repo) ? repo : mirrorPathForRemote(repo);
}

/**
 * Recognize stderr from `git worktree remove` / `git branch -D` that indicates
 * the target was already gone — a fully anticipated race because the Claude
 * Agent SDK auto-removes worktrees + branches when a builder makes no file
 * changes, before Friday's own archive cleanup runs.
 *
 * Locale matters: git localizes these messages, so callers must force
 * `LC_ALL=C` on the subprocess for substring matching to be stable. Any
 * unrecognized stderr (or empty / missing stderr) returns null so the caller
 * stays on the warn path and a genuine failure isn't masked.
 */
export function classifyGitArchiveStderr(
  stderr: string | undefined | null,
): "worktree-gone" | "branch-gone" | null {
  if (!stderr) return null;
  if (stderr.includes("is not a working tree")) return "worktree-gone";
  if (stderr.includes("not found")) return "branch-gone";
  return null;
}

const C_LOCALE_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

/**
 * Recover the git dir a workspace was created from by reading its marker. For
 * mirror-based workspaces (remote mode) this is the bare mirror under
 * `<DATA_DIR>/repos/` — the local checkout that `baseRepo` would point at does
 * not exist. Returns `undefined` when there is no usable marker (older
 * pre-mirror workspaces, or the dir is already gone), so the caller falls back
 * to the `baseRepo` it was handed. Must be read BEFORE the worktree is removed.
 */
function readWorkspaceGitDir(workspaceDir: string): string | undefined {
  const markerPath = join(workspaceDir, WORKSPACE_MARKER);
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<WorkspaceMarker>;
    return typeof marker.gitDir === "string" && marker.gitDir.length > 0
      ? marker.gitDir
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who owns a Builder's workspace directory (FRI-2080).
 *
 * `"daemon"` is every workspace today: a `git worktree` under
 * `<DATA_DIR>/workspaces/<name>`, on the daemon's own filesystem, which the
 * daemon created and tears down.
 *
 * `"container"` is a per-task volume mounted at `/workspace` inside a builder
 * container (FRI-2038). The daemon cannot see it, and that is not a fault to
 * tolerate — it is a different kind of path. Recording which one it is beats
 * sprinkling `existsSync` guards, because the guards cannot distinguish "the
 * worktree was deleted and this Builder is broken" from "this path was never
 * mine to look at", and those two want opposite responses.
 */
export type WorkspaceOwner = "daemon" | "container";

/**
 * Where a builder container's volume is mounted.
 *
 * Fixed by the broker's container spec, not configurable: the daemon and the
 * broker would otherwise have to agree about it twice.
 */
export const CONTAINER_WORKSPACE_PATH = "/workspace";

/**
 * Whether the daemon may read, write, or delete this workspace.
 *
 * The single question every daemon-side consumer actually has. An absent owner
 * reads as `"daemon"` so every row written before FRI-2080 keeps its meaning.
 */
export function isDaemonOwnedWorkspace(owner: WorkspaceOwner | null | undefined): boolean {
  return (owner ?? "daemon") === "daemon";
}

export function archiveWorkspace(
  name: string,
  baseRepo: string,
  opts: ArchiveWorkspaceOptions = {},
): void {
  const path = workspacePath(name);
  // Resolve the git dir to operate against, in priority order:
  //   1. `opts.repo` (the original source repo, persisted on the agent row and
  //      passed by the route) → DETERMINISTIC derivation that matches create.
  //      This is authoritative: it does not depend on any state living inside
  //      the workspace dir, which the SDK may have already deleted (BLOCKER 1).
  //   2. The in-workspace marker's recorded gitDir → best-effort fallback for
  //      in-flight rows created before `repo` was persisted, AND only readable
  //      while the dir still exists. Read before any removal.
  //   3. `baseRepo` as handed in → last-resort backward-compat fallback.
  // In remote mode (1) always targets the bare mirror and NEVER `process.cwd()`.
  const daemonOwned = isDaemonOwnedWorkspace(opts.owner);
  const gitDir = opts.repo
    ? resolveRepoGitDir(opts.repo)
    : // The in-workspace marker is only readable when the daemon can see the
      // directory, which for a container workspace it cannot.
      ((daemonOwned ? readWorkspaceGitDir(path) : null) ?? baseRepo);
  // The worktree directory might already be gone (manual cleanup, prior
  // failed run); the branch may still exist independently, so we don't
  // early-return when the dir is missing.
  if (!daemonOwned) {
    logger.log("info", "workspace.destroy.container-owned", {
      name,
      note: "volume teardown is the broker's; the branch and staging repo are deleted here",
    });
    // FRI-2077: the staging repo is the daemon's, not the broker's, so it is
    // not covered by the volume teardown above. Only container workspaces have
    // one — a daemon-owned Builder pushes through its worktree.
    removeStagingRepo(name);
  } else if (existsSync(path)) {
    // FIX_FORWARD 6.4: containment check before any rm-equivalent op.
    // Resolves symlinks so we never delete outside ~/.friday/workspaces/.
    assertInsideWorkspacesRoot(path);
    try {
      execFileSync("git", ["worktree", "remove", "--force", path], {
        cwd: gitDir,
        stdio: "pipe",
        env: C_LOCALE_ENV,
      });
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = e.stderr ? String(e.stderr).trim() : undefined;
      const race = classifyGitArchiveStderr(stderr);
      if (race === "worktree-gone") {
        logger.log("debug", "workspace.destroy.skip", {
          name,
          reason: race,
          stderr,
        });
      } else {
        logger.log("warn", "workspace.destroy.fail", {
          name,
          message: e.message ?? String(err),
          stderr,
          stdout: e.stdout ? String(e.stdout).trim() : undefined,
        });
      }
    }
    // The worktree-remove leaves the parent directory in place if anything
    // non-tracked accumulated there (logs, build artifacts). Wipe whatever
    // remains so the next `agent_create` with the same name can succeed.
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        logger.log("warn", "workspace.rmdir.fail", {
          name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    // Directory is already gone (manual cleanup, partial prior run). The git
    // worktree registration may still be present, which prevents branch
    // deletion. Prune removes all stale entries whose directories no longer
    // exist.
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: gitDir,
        stdio: "pipe",
      });
    } catch (err) {
      logger.log("warn", "workspace.prune.fail", {
        name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Delete the branch from the git dir (local checkout or bare mirror).
  // "Destroy means destroy" — by the
  // time the user (or orchestrator) destroys a workspace the work has either
  // been merged via PR or been explicitly thrown away. Leaving the branch
  // behind accumulates dead refs, and re-creating a builder of the same
  // name would fail at `git worktree add -b <branch>`.
  //
  // `branch -D` is force-delete; works even on unmerged branches. We tolerate
  // failure (branch already gone, never existed, etc.) — that's not a
  // destroy-blocker.
  if (opts.branch) {
    try {
      execFileSync("git", ["branch", "-D", opts.branch], {
        cwd: gitDir,
        stdio: "pipe",
        env: C_LOCALE_ENV,
      });
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = e.stderr ? String(e.stderr).trim() : undefined;
      const race = classifyGitArchiveStderr(stderr);
      if (race === "branch-gone") {
        logger.log("debug", "workspace.branch.delete.skip", {
          name,
          branch: opts.branch,
          reason: race,
          stderr,
        });
      } else {
        logger.log("warn", "workspace.branch.delete.fail", {
          name,
          branch: opts.branch,
          message: e.message ?? String(err),
          stderr,
        });
      }
    }
  }
}
