import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFridayConfigCache, createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * FRI-2078. Hosting the GitHub tools moves the credential into the trusted
 * tier, but that alone is not the win — a route that took `owner/repo` and a
 * head branch from the request would turn FRI-2041's allowlist back into a
 * suggestion.
 *
 * What is tested here is therefore what a Builder CANNOT do: name another
 * repository, push a PR from a branch that is not its own, target an
 * arbitrary base, or merge anything.
 */

let db: TestDbHandle;
let registry: typeof import("../agent/registry.js");
let ROUTES: (typeof import("./server.js"))["ROUTES"];
let fetchCalls: Array<{ url: string; method: string; body: unknown }>;

beforeAll(async () => {
  db = await createTestDb({ label: "github_routes" });
  registry = await import("../agent/registry.js");
  ({ ROUTES } = await import("./server.js"));
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.truncate();
  fetchCalls = [];
  // `loadFridayConfig` caches, which is why setting a secret in production
  // needs `POST /api/secrets/reload` to take effect. Here it means the env
  // has to be cleared between cases or the previous token leaks forward.
  delete process.env.GITHUB_TOKEN;
  clearFridayConfigCache();
  // The GitHub API itself is stubbed: these cases are about the gate in front
  // of it, and every one of them should be answerable without a network.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const u = String(url);
      if (/\/pulls$/.test(u)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 7,
              html_url: "https://github.com/acme/web/pull/7",
              state: "open",
            }),
            { status: 200 },
          ),
        );
      }
      if (/\/pulls\/\d+$/.test(u)) {
        return Promise.resolve(
          new Response(JSON.stringify({ head: { sha: "s1" } }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
  clearFridayConfigCache();
});

/** Invoke a route the way the router would, with the caller header set. */
async function call(
  method: "GET" | "POST",
  path: string,
  opts: { caller: string; body?: unknown; search?: string } = { caller: "builder-1" },
) {
  const row = ROUTES.find((r) => r.method === method && r.match === path);
  expect(row, `route ${method} ${path} not found`).toBeDefined();
  const url = new URL(`http://d${path}${opts.search ?? ""}`);
  const res = await row!.handler!({
    req: { headers: { "x-friday-caller-name": opts.caller } },
    url,
    path,
    body: opts.body,
    method,
  } as never);
  return res as { status: number; body: Record<string, unknown> };
}

async function seedBuilder(name: string, repo: string | null, branch?: string) {
  await registry.registerAgent({
    name,
    type: "builder",
    parentName: "orchestrator",
    branch: branch ?? `friday/${name}`,
    ...(repo ? { metaJson: { repo } } : {}),
  });
}

const GH = "https://github.com/acme/web";

describe("pr_create's gate", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "t0ken";
    clearFridayConfigCache();
  });

  it("opens the PR from the caller's OWN branch and repo", async () => {
    await seedBuilder("builder-1", GH, "friday/builder-1");
    const res = await call("POST", "/api/github/pr", {
      caller: "builder-1",
      body: { title: "Do the thing", body: "Closes FRI-1" },
    });
    expect(res.status).toBe(200);
    expect(fetchCalls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls");
    // head is the row's branch, which the request never mentioned.
    expect(fetchCalls[0]!.body).toMatchObject({
      head: "friday/builder-1",
      base: "main",
      title: "Do the thing",
    });
  });

  it("ignores a repo or head the caller tries to supply", async () => {
    // Not an error — those fields simply do not exist in the contract, so a
    // model that invents them gets its own branch and repo anyway. That is
    // stronger than validating them, because there is nothing to validate.
    await seedBuilder("builder-1", GH, "friday/builder-1");
    const res = await call("POST", "/api/github/pr", {
      caller: "builder-1",
      body: { title: "x", head: "main", repo: "acme/secrets", owner: "someone-else" },
    });
    expect(res.status).toBe(200);
    expect(fetchCalls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls");
    expect(fetchCalls[0]!.body).toMatchObject({ head: "friday/builder-1" });
  });

  it("refuses a base branch outside main/master/friday-*", async () => {
    await seedBuilder("builder-1", GH, "friday/builder-1");
    for (const base of ["release/1.0", "production", "../main", "refs/heads/main"]) {
      const res = await call("POST", "/api/github/pr", {
        caller: "builder-1",
        body: { title: "x", base },
      });
      expect(res.status, base).toBe(403);
    }
    // A stacked PR onto another Builder's branch stays allowed.
    const ok = await call("POST", "/api/github/pr", {
      caller: "builder-1",
      body: { title: "x", base: "friday/other" },
    });
    expect(ok.status).toBe(200);
  });

  it("refuses a caller that is not a Builder", async () => {
    // An orchestrator holds a valid token but has no branch or repo; without
    // this it would reach the API with whatever the row happened to contain.
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const res = await call("POST", "/api/github/pr", { caller: "friday", body: { title: "x" } });
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it("says so plainly when the repo has no GitHub remote", async () => {
    // `worktree.repo` defaults to a local path, which is the COMMON case and
    // is not a GitHub repo. A confident 404 from the API would be worse.
    await seedBuilder("builder-1", "/Users/me/repos/friday", "friday/builder-1");
    const res = await call("POST", "/api/github/pr", { caller: "builder-1", body: { title: "x" } });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/not a GitHub remote/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("requires a title", async () => {
    await seedBuilder("builder-1", GH, "friday/builder-1");
    const res = await call("POST", "/api/github/pr", {
      caller: "builder-1",
      body: { title: "  " },
    });
    expect(res.status).toBe(400);
  });
});

describe("without a credential", () => {
  it("fails with the command that fixes it, rather than a bare 500", async () => {
    // The flag day: until GITHUB_TOKEN is in the vault, Builders cannot open
    // PRs. The error has to say what to do about that.
    await seedBuilder("builder-1", GH, "friday/builder-1");
    const res = await call("POST", "/api/github/pr", { caller: "builder-1", body: { title: "x" } });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/friday secrets set GITHUB_TOKEN/);
  });
});

describe("pr_checks", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "t0ken";
    clearFridayConfigCache();
  });

  it("reads checks for the caller's own repo", async () => {
    await seedBuilder("builder-1", GH, "friday/builder-1");
    const res = await call("GET", "/api/github/pr-checks", {
      caller: "builder-1",
      search: "?number=7",
    });
    expect(res.status).toBe(200);
    expect(fetchCalls[0]!.url).toBe("https://api.github.com/repos/acme/web/pulls/7");
  });

  it("rejects a missing or nonsense PR number before calling GitHub", async () => {
    await seedBuilder("builder-1", GH, "friday/builder-1");
    for (const search of ["", "?number=0", "?number=-3", "?number=abc"]) {
      const res = await call("GET", "/api/github/pr-checks", { caller: "builder-1", search });
      expect(res.status, search).toBe(400);
    }
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("the merge surface", () => {
  it("does not exist, which is how the rule stops being a prompt rule", () => {
    // "Halt at a green PR — never merge" is currently a request in
    // builder.md. An agent cannot call a tool that was never built.
    const paths = ROUTES.map((r) => `${r.method} ${String(r.match)}`);
    expect(paths.filter((p) => /merge/i.test(p))).toEqual([]);
  });
});
