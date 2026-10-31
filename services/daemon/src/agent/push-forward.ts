import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadFridayConfig } from "@friday/shared";
import { logger } from "../log.js";
import { parseGitHubRemote } from "../services/github.js";
import { isLocalRepo, stagingPathForAgent } from "./workspace.js";

/**
 * Carry a Builder's staged branch the rest of the way (FRI-2077, slice 3).
 *
 * FRI-2076 made the daemon the Builder's `origin`, and slices 1–2 land its
 * push in a per-task staging repo behind an `update` ref gate. Something then
 * has to forward it. The upside of that indirection is the point of the whole
 * arrangement: **the GitHub credential lives in the trusted tier and never
 * enters the process running untrusted repository code.**
 *
 * ## Why in-process rather than in a `post-receive` hook
 *
 * The ticket reasons that the forward belongs in `post-receive` because it is
 * the only hook where the objects are permanent — in `pre-receive` they are
 * still quarantined. That constraint is about hook TIMING, and it is satisfied
 * here too: this runs after `git-http-backend` has exited cleanly, by which
 * point the refs are updated and the objects are permanent.
 *
 * Running in-process keeps the token out of a file on disk entirely. A hook
 * that pushes would need the credential in its own environment or embedded in
 * its text, and a generated file holding a GitHub token is a worse artifact
 * than the indirection it saves.
 *
 * The cost, stated plainly: `post-receive`'s stderr reaches the client as
 * `remote:` text, and this does not. The response has already been sent, so a
 * Builder sees `* [new branch]` and learns nothing about whether the branch
 * reached GitHub. It finds out when `friday-github` (FRI-2078) tries to open
 * the PR. Accepted deliberately — durability is handled below, and visibility
 * is not the same problem.
 *
 * ## A failed forward is not lost work
 *
 * Nothing prunes the staging repo, so a ref that could not be forwarded is
 * still there to retry. That is the entire reason pushes land in staging
 * rather than in the `--prune`-refreshed mirror, and it is why this never
 * throws: a forward failure is logged and the ref is left in place.
 */

const run = promisify(execFile);

export interface ForwardOutcome {
  forwarded: boolean;
  /** Why not, when `forwarded` is false. Safe to log — never carries the token. */
  reason?: string;
}

/**
 * Where a forwarded branch is supposed to end up.
 *
 * A local-path repo is the common `worktree.repo` value, and its destination
 * is the user's own checkout. That is the faithful analogue of a daemon-owned
 * Builder, whose worktree shares the daemon's origin and whose branch
 * therefore already appears there.
 */
function destinationFor(repo: string): { url: string; needsToken: boolean } {
  if (isLocalRepo(repo)) return { url: repo, needsToken: false };
  return { url: repo, needsToken: parseGitHubRemote(repo) !== null };
}

/**
 * Credentials for the push, as ENVIRONMENT rather than argv.
 *
 * `-c http.extraHeader=…` would work identically but puts the token in the
 * child's command line, and `/proc/<pid>/cmdline` is world-readable while
 * `/proc/<pid>/environ` is owner-only. Same `GIT_CONFIG_COUNT` idiom the
 * receive-pack route already uses to inject `http.receivepack`.
 */
function credentialEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/**
 * Forward `refs/heads/<branch>` from the Builder's staging repo to its real
 * destination. Never throws; the outcome is the return value.
 */
export async function forwardStagedRef(opts: {
  agentName: string;
  repo: string;
  branch: string;
}): Promise<ForwardOutcome> {
  let stagingPath: string;
  try {
    stagingPath = stagingPathForAgent(opts.agentName);
  } catch (err) {
    return { forwarded: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const dest = destinationFor(opts.repo);
  let env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  if (dest.needsToken) {
    const token = loadFridayConfig().githubToken;
    if (!token) {
      // Not an error worth failing anything over: the ref is safe in staging
      // and forwards on the next push once a credential exists.
      const reason =
        "no GitHub credential is configured — set one with `friday secrets set GITHUB_TOKEN --daemon`";
      logger.log("warn", "worker.git.forward.no-credential", {
        agent: opts.agentName,
        branch: opts.branch,
        note: "ref left in staging; nothing prunes it, so a later push retries",
      });
      return { forwarded: false, reason };
    }
    env = { ...env, ...credentialEnv(token) };
  }

  const refspec = `refs/heads/${opts.branch}:refs/heads/${opts.branch}`;
  try {
    // Not forced. A non-fast-forward at the destination means someone else
    // moved the branch, and silently overwriting that is the one outcome worse
    // than refusing to forward.
    await run("git", ["--git-dir", stagingPath, "push", dest.url, refspec], {
      env,
      timeout: 120_000,
    });
    logger.log("info", "worker.git.forward.ok", {
      agent: opts.agentName,
      branch: opts.branch,
      // `dest.url` is a repo path or a plain remote URL — the token rides in
      // the environment, so this never logs a credential.
      destination: dest.url,
    });
    return { forwarded: true };
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    const reason = (e.stderr ?? e.message ?? String(err)).trim();
    logger.log("warn", "worker.git.forward.fail", {
      agent: opts.agentName,
      branch: opts.branch,
      destination: dest.url,
      reason: reason.slice(0, 500),
      note: "ref left in staging; nothing prunes it, so a later push retries",
    });
    return { forwarded: false, reason };
  }
}
