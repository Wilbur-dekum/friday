import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Which repositories a Builder may be given (FRI-2041, ADR-054).
 *
 * `POST /api/agents` takes `worktree.repo` and hands it to `createWorkspace`
 * with **no authorization notion at all** — `assertInsideWorkspacesRoot` is
 * filesystem containment (where the worktree may live), not repo
 * authorization (which repo it may be cut from). Those are different
 * questions and only the first was being asked.
 *
 * This is the INNER of the two boundaries the ticket describes. The outer one
 * is a GitHub App installation, where the customer picks which repositories
 * Friday can see at all; that needs an App, which this fork does not have yet
 * (FRI-2056). The inner one exists because an admin installing with "All
 * repositories" must not thereby mean any member can have Friday push
 * anywhere.
 *
 * ## Matching is deliberately strict
 *
 * An allowlist leaks through sloppy comparison far more often than through a
 * missing entry, so every normalisation here is one that a real attacker
 * string exercises:
 *
 *  - **No prefix matching.** `github.com/acme/web` must not admit
 *    `github.com/acme/web-internal`. Entries match whole, or not at all.
 *  - **Credentials stripped.** `https://user:token@github.com/acme/web` is the
 *    same repo as `https://github.com/acme/web`, and letting the userinfo
 *    change the comparison would let a caller dodge the list by inventing one.
 *  - **scp-style SSH understood.** `git@github.com:acme/web.git` and
 *    `https://github.com/acme/web` are the same repository written two ways.
 *  - **`.git` and trailing slashes ignored**, and host compared
 *    case-insensitively — DNS is case-insensitive, paths are not, so `acme/Web`
 *    stays distinct from `acme/web`.
 *  - **Local paths realpathed**, so a symlink cannot point an allowed path at
 *    something else.
 *
 * ## Unset means permissive, and says so
 *
 * With no allowlist configured every repo is allowed, matching today's
 * behaviour — a deny-by-default upgrade would break every existing builder
 * spawn on the hop into the release. The caller is expected to log that the
 * boundary is absent, the same shape as the worker-facing listener
 * (FRI-2072) being opt-in. Configured, it is enforced strictly.
 */

export interface RepoIdentity {
  /** Lowercased host for remotes; empty for local paths. */
  host: string;
  /** Case-sensitive path: `acme/web` for remotes, a realpath for local. */
  path: string;
}

/**
 * Reduce a repo reference to the identity two spellings of the same repo
 * share. Returns null when it cannot be parsed, which callers treat as "not
 * allowed" rather than "allow" — an unparseable entry must never widen the
 * list.
 */
export function normalizeRepoRef(ref: string): RepoIdentity | null {
  const raw = ref.trim();
  if (!raw) return null;

  // scp-style SSH: `git@host:org/repo.git`. Not a URL, so `new URL` would
  // either throw or (worse) parse `git@host` as a scheme.
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);
  if (scp) {
    return { host: scp[1]!.toLowerCase(), path: stripRepoPath(scp[2]!) };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      // `u.hostname` deliberately, not `u.host`: userinfo and port must not
      // participate in the comparison.
      return { host: u.hostname.toLowerCase(), path: stripRepoPath(u.pathname) };
    } catch {
      return null;
    }
  }

  // Local path. realpath so a symlink cannot alias an allowed location;
  // fall back to an absolute resolve when it does not exist yet.
  try {
    return { host: "", path: realpathSync(raw) };
  } catch {
    return { host: "", path: resolve(raw) };
  }
}

/** `/acme/web.git/` → `acme/web`. */
function stripRepoPath(p: string): string {
  return p
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

function sameRepo(a: RepoIdentity, b: RepoIdentity): boolean {
  return a.host === b.host && a.path === b.path;
}

/**
 * Whether `repo` may back a Builder worktree.
 *
 * An empty or absent allowlist is permissive — see the module doc. A
 * configured list is exhaustive: anything not on it is refused, including an
 * entry that fails to parse.
 */
export function isRepoAllowed(repo: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const want = normalizeRepoRef(repo);
  if (!want) return false;
  return allowlist.some((entry) => {
    const got = normalizeRepoRef(entry);
    return got !== null && sameRepo(got, want);
  });
}

/**
 * The configured allowlist, or undefined when none is set.
 *
 * `FRIDAY_REPO_ALLOWLIST` is a comma-separated list. Env rather than
 * config.json because a Deployment's repo scope is provisioning's to set
 * (ADR-051) — the same reasoning that made the Postgres connection
 * configuration in FRI-2004 — and because an operator editing config.json
 * inside a container is not the shape the cloud will use.
 */
export function resolveRepoAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.FRIDAY_REPO_ALLOWLIST?.trim();
  if (!raw) return undefined;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}
