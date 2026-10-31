import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../log.js";
import { writeJson } from "./router.js";
import { workerFromRequest } from "./worker-listener.js";
import { resolveRepoGitDir, stagingPathForAgent } from "../agent/workspace.js";
import { forwardStagedRef } from "../agent/push-forward.js";
import { isRepoAllowed, resolveRepoAllowlist } from "../agent/repo-allowlist.js";
import * as registry from "../agent/registry.js";

/**
 * Serve a Builder's repository to its container (FRI-2076).
 *
 * `createWorkspace` cuts a `git worktree` against a git dir on the daemon's
 * filesystem. A container cannot hold a worktree whose gitdir lives outside
 * its volume, so a containerised Builder gets a CLONE — and something has to
 * serve it.
 *
 * ## Why the daemon serves it rather than the container cloning the origin
 *
 * Three reasons, in order of how much they decide it:
 *
 * 1. **A local-path repo has no origin to clone.** `worktree.repo` defaults to
 *    the daemon's cwd, so this is the common case and not an edge one. There
 *    is no URL a container could fetch a path on another host from.
 * 2. **No repo credential enters the container.** The process running
 *    untrusted repository code never holds one, which is the boundary
 *    FRI-2038 exists to draw.
 * 3. **The allowlist becomes reachability.** FRI-2041 decides which repo may
 *    back a Builder; here that decision is enforced by what is *servable*
 *    rather than by what a clone command happens to name.
 *
 * ## What the worker can influence, and what it cannot
 *
 * It supplies the git verb, and nothing else. The repository is resolved
 * daemon-side from the per-worker token — token → agent name → the `repo` on
 * that agent's row → `resolveRepoGitDir`, the same derivation create and
 * teardown use. No repo path, name or id appears in the URL, so there is no
 * parameter to traverse out of: `GIT_PROJECT_ROOT` and `PATH_INFO` are built
 * from the resolved path, and the URL contributes only which of two verbs runs.
 *
 * ## Fetch and push do not read the same repository (FRI-2077)
 *
 * A fetch is served from `resolveRepoGitDir` — the mirror, or the user's own
 * checkout. A push is served from the Builder's per-task STAGING repo, because
 * neither of those can safely receive one: the mirror's `--prune` refresh eats
 * un-forwarded Builder refs, and a local-path repo is the daily driver's own
 * `.git`. See `ensureStagingRepo`.
 *
 * Which means allowing `git-receive-pack` here does NOT reintroduce the window
 * FRI-2076 refused it over. A Builder can write arbitrary refs into its own
 * staging repo, which nothing prunes and nothing else reads. What may then
 * LEAVE staging is decided twice over: the generated `update` hook refuses
 * every ref but the Builder's own branch, and `forwardStagedRef` only ever
 * forwards that one ref by name.
 */

/** Everything a worker's git client talks to lives under here. */
export const WORKER_GIT_PREFIX = "/api/worker/git/";

/** The verbs a fetch needs. Served from the repo the Builder was cut from. */
const READ_VERBS = new Set(["info/refs", "git-upload-pack"]);

/** The verb a push needs. Served from the Builder's staging repo, never the mirror. */
const WRITE_VERBS = new Set(["git-receive-pack"]);

/** The verb a request names, or null when it is not one we serve. */
export function gitVerbFor(path: string): string | null {
  if (!path.startsWith(WORKER_GIT_PREFIX)) return null;
  const verb = path.slice(WORKER_GIT_PREFIX.length);
  return READ_VERBS.has(verb) || WRITE_VERBS.has(verb) ? verb : null;
}

/**
 * Whether this request is the push side.
 *
 * Two spellings reach the same answer: the `git-receive-pack` verb itself, and
 * `info/refs?service=git-receive-pack`, which is the advertisement a push
 * fetches first. Both have to resolve to the staging repo or the advertisement
 * would describe the mirror and the push would then send the wrong delta.
 */
function isPushRequest(verb: string, service: string | null): boolean {
  return WRITE_VERBS.has(verb) || (verb === "info/refs" && service === "git-receive-pack");
}

/**
 * `git-http-backend`'s absolute path.
 *
 * Resolved via `git --exec-path` rather than hardcoded: it lives in git's
 * libexec dir, which differs across the platforms Friday runs on (Homebrew,
 * Xcode's git on a laptop, Debian in the container).
 */
function httpBackendPath(): string | null {
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const candidate = `${execPath}/git-http-backend`;
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Which repo this worker may fetch, or null when it may fetch nothing. */
async function repoForWorker(agentName: string): Promise<string | null> {
  const repo = await registry.getWorkspaceRepo(agentName);
  if (!repo) return null;
  // Re-checked at serve time, not just at spawn (FRI-2041). The row was
  // validated when the Builder was created, but an allowlist narrowed since
  // then should take effect for workers already running — otherwise revoking
  // a repo leaves every in-flight Builder still able to read it.
  if (!isRepoAllowed(repo, resolveRepoAllowlist())) {
    logger.log("warn", "worker.git.repo-no-longer-allowed", { agent: agentName, repo });
    return null;
  }
  return repo;
}

/**
 * Split CGI output into its header block and body.
 *
 * `git-http-backend` speaks CGI: CRLF headers, a blank line, then a body that
 * is binary pkt-line. Returns null while the terminator has not arrived yet.
 */
function splitCgi(buf: Buffer): { headers: string; body: Buffer } | null {
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    return { headers: buf.subarray(0, crlf).toString("utf8"), body: buf.subarray(crlf + 4) };
  }
  // Tolerated because a CGI program is allowed to use bare LF, and a stricter
  // parser would hang waiting for CRLF that never comes.
  const lf = buf.indexOf("\n\n");
  if (lf !== -1) {
    return { headers: buf.subarray(0, lf).toString("utf8"), body: buf.subarray(lf + 2) };
  }
  return null;
}

/**
 * Serve one git request for the worker behind it.
 *
 * A `raw` route: git's smart HTTP is a binary protocol, so the handler owns
 * `req`/`res` and nothing JSON-serializes the response.
 */
export async function handleWorkerGit(ctx: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
}): Promise<void> {
  const { req, res, url, path } = ctx;
  const verb = gitVerbFor(path);
  if (!verb) {
    // 404 rather than 403, matching the worker listener: a verb we do not
    // serve should look absent.
    writeJson(res, 404, { error: "not found" });
    return;
  }
  const identity = workerFromRequest(req);
  if (!identity) {
    writeJson(res, 401, { error: "a valid per-worker bearer token is required" });
    return;
  }
  // `info/refs` names the service it wants in the query string. Only git's own
  // two services exist; anything else is refused rather than passed through to
  // the backend, so the verb set here stays the whole surface.
  const service = url.searchParams.get("service");
  if (verb === "info/refs" && service !== "git-upload-pack" && service !== "git-receive-pack") {
    writeJson(res, 403, { error: "only git-upload-pack and git-receive-pack are served" });
    return;
  }
  const push = isPushRequest(verb, service);

  const repo = await repoForWorker(identity.callerName);
  if (!repo) {
    writeJson(res, 404, { error: "no repository is served for this worker" });
    return;
  }
  // The allowlist re-check above still governs a push: a Builder whose repo was
  // revoked mid-flight cannot push either, even though its staging repo is its
  // own and would otherwise be harmless to write.
  const gitDir = push ? stagingPathForAgent(identity.callerName) : resolveRepoGitDir(repo);
  if (!existsSync(gitDir)) {
    logger.log("warn", "worker.git.gitdir-missing", {
      agent: identity.callerName,
      repo,
      gitDir,
      push,
    });
    writeJson(res, 404, { error: "no repository is served for this worker" });
    return;
  }
  const backend = httpBackendPath();
  if (!backend) {
    logger.log("error", "worker.git.backend-missing", { agent: identity.callerName });
    writeJson(res, 500, { error: "git-http-backend is not available" });
    return;
  }

  // PATH_INFO is built from the RESOLVED git dir, never from the URL. That is
  // what makes the repository unguessable rather than merely unauthorized:
  // there is no path component a caller could traverse, because the caller
  // never names one.
  const env: NodeJS.ProcessEnv = {
    // A deliberately tiny environment. The daemon's own env carries
    // DATABASE_URL and ANTHROPIC_API_KEY, and this subprocess is driven by a
    // request from the container running untrusted code — it gets the CGI
    // variables and a PATH, and nothing else.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_PROJECT_ROOT: dirname(gitDir),
    PATH_INFO: `/${basename(gitDir)}/${verb}`,
    REQUEST_METHOD: req.method ?? "GET",
    QUERY_STRING: url.searchParams.toString(),
    // Serves the one repo named above without needing a
    // `git-daemon-export-ok` marker inside the user's own checkout.
    GIT_HTTP_EXPORT_ALL: "1",
    // Attributes the fetch in git's own logs/hooks to the agent, not to the
    // daemon's OS user. The `update` hook reads it to decide which refs this
    // Builder may write (FRI-2077 slice 2).
    REMOTE_USER: identity.callerName,
    // `git-http-backend` answers 403 to a push unless the served repo has
    // `http.receivepack=true`. Injected per-request rather than written into
    // the repo's own config: verified to work, and it leaves the staging repo
    // holding no state that outlives the request. Absent for a fetch, so the
    // read path cannot accidentally advertise a writable repo.
    ...(push
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.receivepack",
          GIT_CONFIG_VALUE_0: "true",
        }
      : {}),
    ...(req.headers["content-type"] ? { CONTENT_TYPE: req.headers["content-type"] } : {}),
    ...(req.headers["content-encoding"]
      ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] }
      : {}),
  };

  logger.log("info", "worker.git.serve", {
    agent: identity.callerName,
    verb,
    repo,
    gitDir,
    push,
  });

  const child = spawn(backend, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  let pending = Buffer.alloc(0);
  let headersSent = false;
  let stderr = "";
  /**
   * A non-200 from the CGI, whose body is swallowed rather than relayed.
   *
   * `git-http-backend` reports its own failures as a `Status:` header, and its
   * message names the server-side path — `Not a git repository:
   * /Users/…/repos/acme.git`. Reachable: a row whose `repo` points at a
   * directory that exists but is not a repo. Relaying it would hand the
   * container running untrusted code a piece of the daemon's filesystem
   * layout, so the real message goes to the log and the worker gets a
   * generic one.
   */
  let cgiError: { status: number; detail: string } | null = null;

  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  child.stdout.on("data", (chunk: Buffer) => {
    if (cgiError) {
      if (cgiError.detail.length < 2000) cgiError.detail += chunk.toString("utf8");
      return;
    }
    if (headersSent) {
      res.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const split = splitCgi(pending);
    if (!split) return;

    // `Status: 404 Not Found` is CGI's way of setting the HTTP status. Left
    // in the header loop it became a response HEADER named "Status" and the
    // reply went out 200 — an error reported as success, which is the shape
    // of bug that costs an afternoon.
    let status = 200;
    const headers: Array<[string, string]> = [];
    for (const line of split.headers.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (name.toLowerCase() === "status") {
        status = Number.parseInt(value, 10) || 500;
        continue;
      }
      headers.push([name, value]);
    }
    if (status !== 200) {
      cgiError = { status, detail: split.body.toString("utf8") };
      return;
    }
    headersSent = true;
    for (const [name, value] of headers) res.setHeader(name, value);
    res.writeHead(status);
    if (split.body.length > 0) res.write(split.body);
  });
  child.on("error", (err) => {
    logger.log("error", "worker.git.spawn.fail", {
      agent: identity.callerName,
      message: err.message,
    });
    if (!headersSent) writeJson(res, 500, { error: "git-http-backend failed to start" });
    else res.end();
  });
  child.on("close", async (code) => {
    if (cgiError) {
      logger.log("warn", "worker.git.backend.status", {
        agent: identity.callerName,
        verb,
        gitDir,
        status: cgiError.status,
        // The real message, which names server paths — logged, never relayed.
        detail: cgiError.detail.trim().slice(0, 300),
      });
      writeJson(res, cgiError.status, { error: "repository is not available" });
      return;
    }
    if (!headersSent) {
      // No headers means it failed before producing any CGI output at all, so
      // the stderr is the only explanation there will be.
      logger.log("error", "worker.git.backend.failed", {
        agent: identity.callerName,
        verb,
        code,
        stderr: stderr.trim().slice(0, 500),
      });
      writeJson(res, 500, { error: "git-http-backend produced no response" });
      return;
    }
    if (stderr.trim()) {
      logger.log("warn", "worker.git.backend.stderr", {
        agent: identity.callerName,
        verb,
        stderr: stderr.trim().slice(0, 500),
      });
    }
    res.end();

    // FRI-2077 slice 3: the push landed in staging behind the `update` gate;
    // carry it the rest of the way. Only for the receive-pack verb — the
    // advertisement changes nothing — and only after a clean exit, which is
    // when the refs are updated and the objects are permanent.
    //
    // Deliberately AFTER `res.end()`: the response is git's, not the
    // forward's, and `post-receive` (which could have spoken to the client)
    // cannot hold the credential. See `forwardStagedRef`'s header. It never
    // throws, so the `void` is safe — but catch anyway, because an unhandled
    // rejection here would take the daemon down for a failed `git push`.
    if (verb === "git-receive-pack" && code === 0) {
      // Same derivation `githubContextFor` uses, rather than a new registry
      // accessor for one caller.
      const agent = await registry.getAgent(identity.callerName);
      const branch = agent && "branch" in agent ? agent.branch : undefined;
      if (!branch) {
        logger.log("warn", "worker.git.forward.no-branch", { agent: identity.callerName });
        return;
      }
      void forwardStagedRef({ agentName: identity.callerName, repo, branch }).catch((err) => {
        logger.log("error", "worker.git.forward.unexpected", {
          agent: identity.callerName,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  // Streamed, not buffered, and with no CONTENT_LENGTH. CGI normally passes
  // the body size that way, but `git-http-backend` reads stdin to EOF — and
  // closing the pipe when the request ends supplies it. Verified by removing
  // CONTENT_LENGTH and watching a real clone still succeed, which is the only
  // reason this file does not carry a buffer and a size cap it never needed.
  req.pipe(child.stdin);
}
