import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * FRI-2076. A containerised Builder cannot hold a worktree whose gitdir lives
 * outside its volume, so it gets a clone — and the daemon serves it.
 *
 * The headline test actually RUNS `git clone` against the route. Asserting on
 * pkt-line bytes would only prove the handler emits something git-shaped;
 * the CGI header handling is exactly the part most likely to be subtly wrong,
 * and a real client is what proves git accepts it.
 *
 * A real agent row, not a stubbed registry: ESM namespace objects are frozen,
 * so `vi.spyOn(registry, …)` cannot work here — and the row IS the thing under
 * test, since the repository is resolved from it rather than from the request.
 *
 * EVERY git invocation that talks to the server is ASYNC, and that is not a
 * style choice. `execFileSync` blocks Node's event loop, so an in-process
 * server cannot accept the connection the blocked child is waiting on — the
 * child times out, the server logs nothing, and it reads exactly like a
 * handler that hangs. Cost me a full debugging round: `curl` timed out too,
 * which is what finally pointed at the loop rather than at the code.
 */

let db: TestDbHandle;
let registry: typeof import("../agent/registry.js");
let tokens: typeof import("../agent/worker-tokens.js");
let handleWorkerGit: (typeof import("./worker-git.js"))["handleWorkerGit"];
let gitVerbFor: (typeof import("./worker-git.js"))["gitVerbFor"];
let WORKER_GIT_PREFIX: string;

let server: Server;
let baseUrl: string;
let scratch: string;
let repo: string;

beforeAll(async () => {
  db = await createTestDb({ label: "worker_git" });
  registry = await import("../agent/registry.js");
  tokens = await import("../agent/worker-tokens.js");
  ({ handleWorkerGit, gitVerbFor, WORKER_GIT_PREFIX } = await import("./worker-git.js"));
});

afterAll(async () => {
  await db.drop();
});

/** A git repo with one real commit, so a clone has something to carry. */
function seedRepo(at: string, content = "from the daemon\n"): string {
  mkdirSync(at, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: at, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.test");
  g("config", "user.name", "t");
  writeFileSync(join(at, "hello.txt"), content);
  g("add", ".");
  g("commit", "-qm", "init");
  return at;
}

beforeEach(async () => {
  await db.truncate();
  tokens.__resetWorkerTokensForTest();
  scratch = mkdtempSync(join(tmpdir(), "friday-worker-git-"));
  repo = seedRepo(join(scratch, "source-repo"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://worker-git");
    void handleWorkerGit({ req, res, url, path: url.pathname });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // `git clone` leaves keep-alive sockets behind, and `server.close` waits for
  // them — without this the hook times out instead of the test failing.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
  tokens.__resetWorkerTokensForTest();
  delete process.env.FRIDAY_REPO_ALLOWLIST;
});

/** Register a Builder whose row names `repoPath`, and mint its token. */
async function builderWithRepo(name: string, repoPath?: string): Promise<string> {
  await registry.registerAgent({
    name,
    type: "builder",
    parentName: "orchestrator",
    worktreePath: "/workspace",
    branch: `friday/${name}`,
    ...(repoPath ? { metaJson: { repo: repoPath, workspaceOwner: "container" } } : {}),
  });
  return tokens.mintWorkerToken({ callerName: name, callerType: "builder" });
}

const run = promisify(execFile);

/** Clone through the route the way the container will. Async — see the header. */
function cloneAs(token: string, dest: string): Promise<unknown> {
  return run(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: Bearer ${token}`,
      "clone",
      "-q",
      `${baseUrl}/api/worker/git`,
      dest,
    ],
    { timeout: 30_000 },
  );
}

function refs(token: string, service = "git-upload-pack"): Promise<Response> {
  return fetch(`${baseUrl}${WORKER_GIT_PREFIX}info/refs?service=${service}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("serving a Builder its repo", () => {
  it("clones, with contents, and the result owns its own .git", async () => {
    // The ticket, end to end: a real git client against the real route, with
    // the repository never named in the URL. A clone rather than a worktree is
    // the point — a worktree's gitdir would live outside the volume.
    const token = await builderWithRepo("builder-1", repo);
    const dest = join(scratch, "clone-1");
    await cloneAs(token, dest);
    expect(readFileSync(join(dest, "hello.txt"), "utf8")).toBe("from the daemon\n");
    expect(
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dest, encoding: "utf8" }).trim(),
    ).toBe(".git");
  });

  it("refuses with no token, and with a token that was never minted", async () => {
    await builderWithRepo("builder-1", repo);
    await expect(
      run("git", ["clone", "-q", `${baseUrl}/api/worker/git`, join(scratch, "d1")], {
        timeout: 30_000,
      }),
    ).rejects.toThrow();
    await expect(cloneAs("never-minted", join(scratch, "d2"))).rejects.toThrow();
  });

  it("serves nothing to a holder of a valid token whose row names no repo", async () => {
    // A Helper or the orchestrator holds a token too. Only a Builder with a
    // repo on its row has anything served to it.
    const token = await builderWithRepo("helper-1");
    expect((await refs(token)).status).toBe(404);
  });

  it("gives a worker ITS OWN repo, not another worker's", async () => {
    // The repository comes from the token, so there is no parameter pointing
    // anywhere. `builder-2`'s repo is servable — just not to this caller.
    await builderWithRepo("builder-2", seedRepo(join(scratch, "other-repo"), "not yours\n"));
    const token = await builderWithRepo("builder-1", repo);
    const dest = join(scratch, "clone-own");
    await cloneAs(token, dest);
    expect(readFileSync(join(dest, "hello.txt"), "utf8")).toBe("from the daemon\n");
  });
});

describe("what a worker may ask for", () => {
  it("serves exactly two verbs and treats everything else as absent", () => {
    expect(gitVerbFor("/api/worker/git/info/refs")).toBe("info/refs");
    expect(gitVerbFor("/api/worker/git/git-upload-pack")).toBe("git-upload-pack");
    // Push, which FRI-2077 adds together with the ref gate that makes it safe.
    expect(gitVerbFor("/api/worker/git/git-receive-pack")).toBeNull();
    // Traversal has nothing to reach — the repo is not in the URL — but the
    // allowlist refuses the attempt regardless.
    expect(gitVerbFor("/api/worker/git/../../etc/passwd")).toBeNull();
    expect(gitVerbFor("/api/worker/git/objects/info/packs")).toBeNull();
    expect(gitVerbFor("/api/worker/other")).toBeNull();
  });

  it("refuses the PUSH advertisement even though the verb is allowed", async () => {
    // `info/refs?service=git-receive-pack` is a client asking "what may I push
    // to". Answering it would advertise a capability that does not exist yet.
    const token = await builderWithRepo("builder-1", repo);
    const res = await refs(token, "git-receive-pack");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/push is not enabled/);
  });

  it("refuses an actual push", async () => {
    const token = await builderWithRepo("builder-1", repo);
    const dest = join(scratch, "clone-push");
    await cloneAs(token, dest);
    // Local-only git ops stay sync: nothing is waiting on the event loop.
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dest, stdio: "pipe" });
    g("config", "user.email", "t@t.test");
    g("config", "user.name", "t");
    writeFileSync(join(dest, "new.txt"), "x\n");
    g("add", ".");
    g("commit", "-qm", "work");
    await expect(
      run(
        "git",
        [
          "-c",
          `http.extraHeader=Authorization: Bearer ${token}`,
          "push",
          "-q",
          "origin",
          "HEAD:refs/heads/friday/builder-1",
        ],
        { cwd: dest, timeout: 30_000 },
      ),
    ).rejects.toThrow();
  });
});

describe("the allowlist is re-checked while a worker runs", () => {
  it("stops serving a repo removed from the allowlist after spawn", async () => {
    // FRI-2041 validated the row at spawn. Narrowing the allowlist afterwards
    // must reach workers already running, or revoking a repo leaves every
    // in-flight Builder still able to read it.
    const token = await builderWithRepo("builder-1", repo);
    expect((await refs(token)).status).toBe(200);

    process.env.FRIDAY_REPO_ALLOWLIST = "https://github.com/acme/something-else";
    expect((await refs(token)).status).toBe(404);
  });

  it("keeps serving while the repo is still on the allowlist", async () => {
    // The control: the re-check must deny for the right reason, not deny
    // everything the moment an allowlist exists.
    const token = await builderWithRepo("builder-1", repo);
    process.env.FRIDAY_REPO_ALLOWLIST = repo;
    expect((await refs(token)).status).toBe(200);
  });
});
