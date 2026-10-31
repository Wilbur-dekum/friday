import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../log.js";

/**
 * Fill a containerised Builder's `/workspace` (FRI-2076, the clone half).
 *
 * FRI-2076 landed the SERVE side — `git-http-backend` behind two worker-facing
 * routes — and nothing ever cloned from it. The broker mounts an empty named
 * volume at `/workspace` and no code filled it, so a container Builder started
 * with an empty working directory and discovered it mid-turn. This is the
 * client of that route.
 *
 * ## Why the worker does it, and not the broker or an image entrypoint
 *
 * The clone needs the per-worker bearer token, and the worker is the only thing
 * that holds one: the broker is deliberately dependency-free and holds no
 * Friday credential, and the image is built once for every Builder. The worker
 * is also the container's entrypoint (FRI-2079), so "before the Claude Code
 * child starts" and "at worker startup" are the same moment.
 *
 * ## Idempotent, because the volume outlives the container
 *
 * A builder volume is per-assignment and is reattached across container
 * restarts (a stall kill, a daemon crash, a wedge respawn). Re-cloning would
 * throw away uncommitted work on every restart, so a `/workspace` that already
 * has a `.git` is left exactly as it is.
 *
 * ## The branch
 *
 * The clone lands on the source repo's default branch, because the repo being
 * served is the user's own and its `HEAD` is not per-Builder. A Builder expects
 * to be ON its own branch, so this creates it locally afterwards. The push then
 * travels the FRI-2077 path: staging repo → `update` ref gate → forward.
 */

const run = promisify(execFile);

/** Non-secret git env. Deliberately tiny, like the serve side's CGI env. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    // A clone into an empty dir needs an identity for nothing, but the branch
    // creation below can touch the reflog, and git refuses without one.
    GIT_AUTHOR_NAME: "Friday",
    GIT_AUTHOR_EMAIL: "friday@localhost",
    GIT_COMMITTER_NAME: "Friday",
    GIT_COMMITTER_EMAIL: "friday@localhost",
    // The clone is over plain HTTP to the daemon on a container network.
    // `protocol.ext/fd` are the transports that let a URL execute a command;
    // same hardening `ensureMirror` applies.
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "protocol.ext.allow",
    GIT_CONFIG_VALUE_0: "never",
    GIT_CONFIG_KEY_1: "protocol.fd.allow",
    GIT_CONFIG_VALUE_1: "never",
    // The bearer token rides a header, and a header set via `-c` would land in
    // `/proc/<pid>/cmdline`, which is world-readable. Key 2's value is filled
    // in by the caller below.
    GIT_CONFIG_KEY_2: "http.extraHeader",
  };
}

export interface CloneOutcome {
  /** `"cloned"` did the work; `"present"` found a repo already there. */
  state: "cloned" | "present" | "skipped" | "failed";
  reason?: string;
}

/**
 * Clone the Builder's repo into `workingDirectory` if it is not already there.
 *
 * Reads its inputs from the environment the container was created with, so
 * there is no new IPC field and every dispatch path gets the same behaviour.
 * Never throws: a failure is reported so the caller can decide, because an
 * exception here would take down a worker that has not started its turn yet.
 */
export async function ensureContainerWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = "/workspace",
): Promise<CloneOutcome> {
  // `FRIDAY_TASK_ID` is set only by the container runtime, so its presence is
  // what distinguishes a containerised Builder from a forked one. A forked
  // worker has a real worktree and must never be touched here.
  if (!env.FRIDAY_TASK_ID) return { state: "skipped", reason: "not a containerised worker" };

  const token = env.FRIDAY_WORKER_TOKEN?.trim();
  const daemonUrl = env.FRIDAY_DAEMON_URL?.trim();
  const branch = env.FRIDAY_WORKSPACE_BRANCH?.trim();
  if (!token || !daemonUrl) {
    return { state: "failed", reason: "no FRIDAY_WORKER_TOKEN + FRIDAY_DAEMON_URL to clone with" };
  }

  if (existsSync(join(workingDirectory, ".git"))) {
    // The reattached-volume case. Leaving it alone is not an optimization —
    // re-cloning would discard work in progress.
    logger.log("info", "worker.workspace.clone.present", {
      agent: env.FRIDAY_AGENT_NAME,
      workingDirectory,
    });
    return { state: "present" };
  }

  const childEnv = {
    ...gitEnv(),
    GIT_CONFIG_VALUE_2: `Authorization: Bearer ${token}`,
  };
  const url = `${daemonUrl.replace(/\/+$/, "")}/api/worker/git`;
  try {
    // `.` so an existing-but-empty volume directory is used rather than git
    // insisting on creating one.
    await run("git", ["clone", "--quiet", url, "."], {
      cwd: workingDirectory,
      env: childEnv,
      timeout: 300_000,
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const reason = (e.stderr ?? e.message ?? String(err)).trim();
    logger.log("error", "worker.workspace.clone.fail", {
      agent: env.FRIDAY_AGENT_NAME,
      url,
      // The token is in the environment, never in `url`.
      reason: reason.slice(0, 500),
    });
    return { state: "failed", reason };
  }

  if (branch) {
    try {
      // `checkout -B`, not `-b`: a reattached volume whose clone succeeded but
      // whose branch creation did not should converge rather than fail.
      await run("git", ["checkout", "-B", branch], {
        cwd: workingDirectory,
        env: childEnv,
        timeout: 60_000,
      });
    } catch (err) {
      const e = err as Error & { stderr?: string };
      // The clone is the valuable half and it succeeded. A Builder on the
      // default branch can still work; its push would be refused by the
      // FRI-2077 ref gate, which is a loud failure rather than a silent one.
      logger.log("warn", "worker.workspace.branch.fail", {
        agent: env.FRIDAY_AGENT_NAME,
        branch,
        reason: (e.stderr ?? e.message ?? String(err)).trim().slice(0, 300),
      });
    }
  }

  logger.log("info", "worker.workspace.clone.ok", {
    agent: env.FRIDAY_AGENT_NAME,
    workingDirectory,
    branch,
  });
  return { state: "cloned" };
}
