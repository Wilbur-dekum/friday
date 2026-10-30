import { logger } from "../log.js";

/**
 * Friday's GitHub client (FRI-2078).
 *
 * Narrow on purpose: open a pull request, read its checks. That is the whole
 * of what a Builder needs from the GitHub API, and the whole of what the
 * builder persona previously shelled out to `gh` for.
 *
 * ## Why this exists at all
 *
 * Until now Friday had no GitHub credential. `prompts/loader.ts` says so
 * outright — "no `GH_TOKEN`/`GITHUB_TOKEN` is read anywhere" — so a Builder's
 * `gh pr create` ran on whatever `gh` login happened to exist on the daemon's
 * machine, reaching the worker through the FRI-150 shell-env capture. Friday
 * could not scope it, revoke it, or attribute an action to a User; and in a
 * per-task container (FRI-2038) it does not exist at all.
 *
 * `fetch` rather than Octokit: two endpoints do not justify a dependency, and
 * this runs in the daemon, which is the process whose dependency tree matters
 * most.
 */

const API_ROOT = "https://api.github.com";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Parse `owner/repo` out of a git remote.
 *
 * Shares no code with `repo-allowlist.ts` deliberately: that answers "are
 * these two references the same repository", and getting it wrong there
 * widens an allowlist. This answers "which GitHub repo is this", and the
 * failure mode is a 404. Same-looking strings, different questions.
 */
export function parseGitHubRemote(remote: string): GitHubRepoRef | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  // scp-style SSH: git@github.com:owner/repo.git
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  const path = scp
    ? scp[2]!
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? (() => {
          try {
            return new URL(trimmed).pathname;
          } catch {
            return "";
          }
        })()
      : "";
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export class GitHubNotConfiguredError extends Error {
  constructor() {
    super(
      "no GitHub credential is configured — set one with `friday secrets set GITHUB_TOKEN --daemon`",
    );
    this.name = "GitHubNotConfiguredError";
  }
}

interface GitHubCallOptions {
  token: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function callGitHub<T>(opts: GitHubCallOptions): Promise<T> {
  const res = await fetch(`${API_ROOT}${opts.path}`, {
    method: opts.method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "friday",
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // The message is surfaced to the agent, so it has to be actionable — a
    // bare status tells it nothing about whether to retry, fix, or stop.
    const detail = text.slice(0, 400);
    logger.log("warn", "github.api.error", {
      method: opts.method,
      path: opts.path,
      status: res.status,
      detail,
    });
    throw new Error(`GitHub ${opts.method} ${opts.path} failed (${res.status}): ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CreatePullRequestInput {
  token: string;
  repo: GitHubRepoRef;
  /** The Builder's branch. Head, not base. */
  head: string;
  base: string;
  title: string;
  body?: string;
  signal?: AbortSignal;
}

export interface PullRequestSummary {
  number: number;
  url: string;
  state: string;
  head: string;
  base: string;
}

export async function createPullRequest(
  input: CreatePullRequestInput,
): Promise<PullRequestSummary> {
  const created = await callGitHub<{
    number: number;
    html_url: string;
    state: string;
    head?: { ref?: string };
    base?: { ref?: string };
  }>({
    token: input.token,
    method: "POST",
    path: `/repos/${input.repo.owner}/${input.repo.repo}/pulls`,
    body: {
      title: input.title,
      head: input.head,
      base: input.base,
      ...(input.body === undefined ? {} : { body: input.body }),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    number: created.number,
    url: created.html_url,
    state: created.state,
    head: created.head?.ref ?? input.head,
    base: created.base?.ref ?? input.base,
  };
}

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | null;

export interface CheckRun {
  name: string;
  status: string;
  conclusion: CheckConclusion;
  url: string | null;
}

export interface PullRequestChecks {
  number: number;
  headSha: string;
  /** True once no run is still queued or in progress. */
  complete: boolean;
  /** True when every completed run concluded success, neutral or skipped. */
  passing: boolean;
  runs: CheckRun[];
}

/**
 * Read the check runs for a PR's head commit.
 *
 * Replaces `gh pr checks <n>` — but NOT `--watch`. Polling belongs to the
 * caller: a tool that blocks until CI finishes would hold an MCP request open
 * for the length of a CI run, and the agent loop already has a way to wait and
 * ask again. `complete` is what it polls on.
 */
export async function pullRequestChecks(input: {
  token: string;
  repo: GitHubRepoRef;
  number: number;
  signal?: AbortSignal;
}): Promise<PullRequestChecks> {
  const pr = await callGitHub<{ head?: { sha?: string } }>({
    token: input.token,
    method: "GET",
    path: `/repos/${input.repo.owner}/${input.repo.repo}/pulls/${input.number}`,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const headSha = pr.head?.sha;
  if (!headSha) throw new Error(`PR #${input.number} has no head sha`);

  const result = await callGitHub<{
    check_runs?: Array<{
      name?: string;
      status?: string;
      conclusion?: string | null;
      html_url?: string | null;
    }>;
  }>({
    token: input.token,
    method: "GET",
    path: `/repos/${input.repo.owner}/${input.repo.repo}/commits/${headSha}/check-runs?per_page=100`,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const runs: CheckRun[] = (result.check_runs ?? []).map((r) => ({
    name: r.name ?? "(unnamed)",
    status: r.status ?? "unknown",
    conclusion: (r.conclusion ?? null) as CheckConclusion,
    url: r.html_url ?? null,
  }));
  const complete = runs.every((r) => r.status === "completed");
  // `neutral` and `skipped` are not failures — a required check that skipped
  // on an unrelated path would otherwise read as a red build forever.
  const passing =
    complete &&
    runs.every(
      (r) => r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped",
    );
  return { number: input.number, headSha, complete, passing, runs };
}
