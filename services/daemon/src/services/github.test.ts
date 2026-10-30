import { afterEach, describe, expect, it, vi } from "vitest";
import { createPullRequest, parseGitHubRemote, pullRequestChecks } from "./github.js";

/**
 * FRI-2078. Friday had no GitHub credential at all — a Builder's `gh pr
 * create` ran on whatever `gh` login the daemon's machine happened to have.
 * These cover the client that replaces it.
 *
 * `fetch` is stubbed rather than hitting GitHub: the questions worth asking
 * are what request goes out and how a response is interpreted, and both are
 * answerable offline. Anything needing the real API belongs in a manual check,
 * not a suite that must run on every commit.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const r = responses[Math.min(i++, responses.length - 1)]!;
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init.headers as HeadersInit),
      });
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
    }),
  );
  return calls;
}

describe("parseGitHubRemote", () => {
  it("reads owner/repo from the spellings a git remote actually takes", () => {
    for (const remote of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "https://github.com/acme/web/",
      "git@github.com:acme/web.git",
      "ssh://git@github.com/acme/web",
    ]) {
      expect(parseGitHubRemote(remote), remote).toEqual({ owner: "acme", repo: "web" });
    }
  });

  it("refuses a path that is not exactly owner/repo", () => {
    // A mutation to `parts.length < 2` survived the cases above, because each
    // of them has too FEW segments. The dangerous direction is too many: a
    // GitLab subgroup URL would silently become `{group, subgroup}` and every
    // call would then target a repository nobody named.
    expect(parseGitHubRemote("https://gitlab.com/group/subgroup/repo")).toBeNull();
    expect(parseGitHubRemote("https://github.com/acme/web/tree/main")).toBeNull();
  });

  it("returns null rather than guessing", () => {
    // A local path is the common `worktree.repo` value and is NOT a GitHub
    // repo. Guessing an owner from it would produce a confident 404 instead
    // of an honest "this has no GitHub remote".
    for (const bad of [
      "",
      "   ",
      "/Users/me/repos/friday",
      "https://github.com/acme",
      "nonsense",
    ]) {
      expect(parseGitHubRemote(bad), bad).toBeNull();
    }
  });
});

describe("createPullRequest", () => {
  it("posts head/base/title to the repo's pulls endpoint, authenticated", async () => {
    const calls = stubFetch([
      { body: { number: 42, html_url: "https://github.com/acme/web/pull/42", state: "open" } },
    ]);
    const pr = await createPullRequest({
      token: "t0ken",
      repo: { owner: "acme", repo: "web" },
      head: "friday/builder-1",
      base: "main",
      title: "Do the thing",
      body: "Closes FRI-1",
    });
    expect(pr).toEqual({
      number: 42,
      url: "https://github.com/acme/web/pull/42",
      state: "open",
      head: "friday/builder-1",
      base: "main",
    });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      title: "Do the thing",
      head: "friday/builder-1",
      base: "main",
      body: "Closes FRI-1",
    });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer t0ken");
  });

  it("surfaces GitHub's own message, because the agent has to act on it", async () => {
    // "A pull request already exists" and "base is invalid" want different
    // responses from the Builder, and a bare status code distinguishes
    // neither.
    stubFetch([
      { status: 422, body: { message: "A pull request already exists for acme:friday/b." } },
    ]);
    await expect(
      createPullRequest({
        token: "t",
        repo: { owner: "acme", repo: "web" },
        head: "friday/b",
        base: "main",
        title: "x",
      }),
    ).rejects.toThrow(/422.*already exists/s);
  });
});

describe("pullRequestChecks", () => {
  const repo = { owner: "acme", repo: "web" };

  it("reports incomplete while any run is still going", async () => {
    const checks = await runChecks([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "test", status: "in_progress", conclusion: null },
    ]);
    expect(checks.complete).toBe(false);
    // Not passing: "not finished" must never read as "green", or the Builder
    // reports done on a build that had not run yet.
    expect(checks.passing).toBe(false);
  });

  it("never reports passing while a run is unfinished, even if it claims success", async () => {
    // Belt-and-braces, and it earned its place: removing the completeness
    // check from `passing` survived the test above, because an unfinished run
    // normally carries a null conclusion and fails the check anyway. This is
    // the shape that gets through — a run reporting a conclusion before it is
    // completed. The persona gates "done" on green, so "not finished" reading
    // as "green" is the one error that ships a broken PR as a finished one.
    const checks = await runChecks([
      { name: "test", status: "in_progress", conclusion: "success" },
    ]);
    expect(checks.complete).toBe(false);
    expect(checks.passing).toBe(false);
  });

  it("is passing only when every completed run succeeded", async () => {
    expect(
      (await runChecks([{ name: "test", status: "completed", conclusion: "success" }])).passing,
    ).toBe(true);
    expect(
      (
        await runChecks([
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "failure" },
        ])
      ).passing,
    ).toBe(false);
  });

  it("treats neutral and skipped as not-a-failure", async () => {
    // A required check that skipped on an unrelated path would otherwise read
    // as a red build forever, and the persona gates "done" on green.
    const checks = await runChecks([
      { name: "a", status: "completed", conclusion: "neutral" },
      { name: "b", status: "completed", conclusion: "skipped" },
      { name: "c", status: "completed", conclusion: "success" },
    ]);
    expect(checks.passing).toBe(true);
  });

  it("treats a PR with NO checks as complete and passing", async () => {
    // A repo with no CI configured. Blocking forever on checks that will
    // never arrive would strand every Builder on such a repo.
    const checks = await runChecks([]);
    expect({ complete: checks.complete, passing: checks.passing }).toEqual({
      complete: true,
      passing: true,
    });
  });

  it("reads checks for the PR's HEAD sha, not for the base branch", async () => {
    const calls = stubFetch([
      { body: { head: { sha: "deadbeef" } } },
      { body: { check_runs: [] } },
    ]);
    await pullRequestChecks({ token: "t", repo, number: 7 });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls/7");
    expect(calls[1]!.url).toContain("/commits/deadbeef/check-runs");
  });

  async function runChecks(
    runs: Array<{ name: string; status: string; conclusion: string | null }>,
  ) {
    stubFetch([{ body: { head: { sha: "sha1" } } }, { body: { check_runs: runs } }]);
    return pullRequestChecks({ token: "t", repo, number: 1 });
  }
});
