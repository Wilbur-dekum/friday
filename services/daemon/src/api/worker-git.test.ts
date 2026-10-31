import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
let workspaceMod: typeof import("../agent/workspace.js");

let server: Server;
let baseUrl: string;
let scratch: string;
let repo: string;

beforeAll(async () => {
  db = await createTestDb({ label: "worker_git" });
  registry = await import("../agent/registry.js");
  tokens = await import("../agent/worker-tokens.js");
  ({ handleWorkerGit, gitVerbFor, WORKER_GIT_PREFIX } = await import("./worker-git.js"));
  workspaceMod = await import("../agent/workspace.js");
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
  // Staging repos live under DATA_DIR, which is shared across this file's
  // tests — leaving one behind makes the "no staging repo" case pass for the
  // wrong reason.
  rmSync(workspaceMod.stagingRoot(), { recursive: true, force: true });
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

describe("when git-http-backend itself fails", () => {
  it("relays its STATUS, and does not leak the server path in the body", async () => {
    // A half-created mirror: `ensureMirror` crashed mid-clone and left a
    // directory that is not a valid repo. `isLocalRepo` sends a remote URL
    // down the mirror path, the directory exists so the pre-flight passes,
    // and `git-http-backend` answers `Status: 404` with the body "Not a git
    // repository: /Users/…" — the wrong HTTP status to drop on the floor,
    // and a piece of the daemon's filesystem layout to hand the container
    // running untrusted code.
    const remote = "https://github.com/acme/half-cloned";
    const mirror = workspaceMod.mirrorPathForRemote(remote);
    mkdirSync(mirror, { recursive: true });
    const token = await builderWithRepo("builder-1", remote);

    const res = await refs(token);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(mirror);
    expect(text).not.toMatch(/Not a git repository/);
    expect(JSON.parse(text)).toEqual({ error: "repository is not available" });
  });
});

describe("what a worker may ask for", () => {
  it("serves exactly three verbs and treats everything else as absent", () => {
    expect(gitVerbFor("/api/worker/git/info/refs")).toBe("info/refs");
    expect(gitVerbFor("/api/worker/git/git-upload-pack")).toBe("git-upload-pack");
    // FRI-2077: push, served from the staging repo rather than the mirror.
    expect(gitVerbFor("/api/worker/git/git-receive-pack")).toBe("git-receive-pack");
    // Traversal has nothing to reach — the repo is not in the URL — but the
    // allowlist refuses the attempt regardless.
    expect(gitVerbFor("/api/worker/git/../../etc/passwd")).toBeNull();
    expect(gitVerbFor("/api/worker/git/objects/info/packs")).toBeNull();
    expect(gitVerbFor("/api/worker/other")).toBeNull();
  });

  it("refuses a service that is neither of git's two", async () => {
    // The verb set is the whole surface: an unknown `service` is answered here
    // rather than handed to the backend to interpret.
    const token = await builderWithRepo("builder-1", repo);
    const res = await refs(token, "git-evil-pack");
    expect(res.status).toBe(403);
  });
});

describe("a Builder pushes its branch back (FRI-2077)", () => {
  /** Clone, commit, and push `ref` — the round trip a Builder actually makes. */
  async function cloneCommitPush(
    token: string,
    name: string,
    ref = `refs/heads/friday/${name}`,
  ): Promise<{ dest: string; sha: string }> {
    const dest = join(scratch, `clone-${name}-${ref.replace(/\W/g, "_")}`);
    await cloneAs(token, dest);
    // Local-only git ops stay sync: nothing is waiting on the event loop.
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dest, stdio: "pipe" });
    g("config", "user.email", "t@t.test");
    g("config", "user.name", "t");
    writeFileSync(join(dest, "new.txt"), "x\n");
    g("add", ".");
    g("commit", "-qm", "work");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dest,
      encoding: "utf8",
    }).trim();
    await run(
      "git",
      [
        "-c",
        `http.extraHeader=Authorization: Bearer ${token}`,
        "push",
        "-q",
        "origin",
        `HEAD:${ref}`,
      ],
      { cwd: dest, timeout: 30_000 },
    );
    return { dest, sha };
  }

  /** What `ref` points at in `gitDir`, or null when it is absent. */
  function refSha(gitDir: string, ref: string): string | null {
    try {
      return execFileSync("git", ["--git-dir", gitDir, "rev-parse", "--verify", ref], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  }

  it("accepts the push, and the ref lands in STAGING — not in the source repo", async () => {
    // The ticket, end to end. Where the ref lands is the whole point: the
    // mirror's `--prune` refresh would eat it, and a local-path repo is the
    // user's own checkout.
    const token = await builderWithRepo("builder-1", repo);
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });

    const { sha } = await cloneCommitPush(token, "builder-1");

    expect(refSha(staging, "refs/heads/friday/builder-1")).toBe(sha);
    // The source repo is untouched — no Builder ref appears in the daily
    // driver's own checkout.
    expect(refSha(join(repo, ".git"), "refs/heads/friday/builder-1")).toBeNull();
  });

  it("answers the push advertisement from staging, so the delta is computed against it", async () => {
    // If the advertisement described the source repo instead, the client would
    // compute its delta against refs the push target does not have.
    const token = await builderWithRepo("builder-1", repo);
    workspaceMod.ensureStagingRepo({ name: "builder-1", repo, branch: "friday/builder-1" });
    expect((await refs(token, "git-receive-pack")).status).toBe(200);
  });

  it("seeds staging from the base ref, so the first push is a delta", async () => {
    // An unseeded staging repo shares no objects with the clone, so the push
    // would carry the whole history back over the loopback.
    const base = refSha(join(repo, ".git"), "refs/heads/main");
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });
    expect(refSha(staging, "refs/heads/friday/builder-1")).toBe(base);
  });

  it("404s a push when the Builder has no staging repo", async () => {
    // Nothing created one, so there is nothing to receive — and the handler
    // must not fall back to the source repo.
    const token = await builderWithRepo("builder-1", repo);
    expect((await refs(token, "git-receive-pack")).status).toBe(404);
  });

  it("refuses a push once the repo falls off the allowlist", async () => {
    // The staging repo is the Builder's own and would be harmless to write,
    // but a revoked repo must stop the write half too, not just the read.
    const token = await builderWithRepo("builder-1", repo);
    workspaceMod.ensureStagingRepo({ name: "builder-1", repo, branch: "friday/builder-1" });
    expect((await refs(token, "git-receive-pack")).status).toBe(200);

    process.env.FRIDAY_REPO_ALLOWLIST = "https://github.com/acme/something-else";
    expect((await refs(token, "git-receive-pack")).status).toBe(404);
  });

  it("forwards the branch on to the source repo after the push (slice 3)", async () => {
    // The whole chain in one test: clone from the daemon, commit, push through
    // the route, and the branch arrives in the real repo — carried by the
    // daemon, with no credential ever in the client.
    const token = await builderWithRepo("builder-1", repo);
    workspaceMod.ensureStagingRepo({ name: "builder-1", repo, branch: "friday/builder-1" });

    const { sha } = await cloneCommitPush(token, "builder-1");

    // The forward runs AFTER the response is sent (see `forwardStagedRef`), so
    // the push returning is not the signal — poll for the ref.
    const deadline = Date.now() + 15_000;
    let landed: string | null = null;
    while (Date.now() < deadline) {
      landed = refSha(join(repo, ".git"), "refs/heads/friday/builder-1");
      if (landed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(landed).toBe(sha);
  });

  it("gives each Builder its own staging repo", async () => {
    // Two Builders off the same source repo must not share a push target,
    // or one could overwrite the other's branch.
    const a = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });
    const b = workspaceMod.ensureStagingRepo({
      name: "builder-2",
      repo,
      branch: "friday/builder-2",
    });
    expect(a).not.toBe(b);
  });
});

describe("the ref gate (FRI-2077, slice 2)", () => {
  /** Clone, commit, and attempt a push of `ref`. Resolves/rejects as git does. */
  async function pushRef(token: string, name: string, ref: string): Promise<string> {
    const dest = join(scratch, `gate-${name}-${ref.replace(/\W/g, "_")}`);
    await cloneAs(token, dest);
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dest, stdio: "pipe" });
    g("config", "user.email", "t@t.test");
    g("config", "user.name", "t");
    writeFileSync(join(dest, "new.txt"), "x\n");
    g("add", ".");
    g("commit", "-qm", "work");
    const { stderr } = await run(
      "git",
      ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "push", "origin", `HEAD:${ref}`],
      { cwd: dest, timeout: 30_000 },
    );
    return stderr;
  }

  it("refuses a push to main — the code gate, not a prompt rule", async () => {
    // The Builder persona used to be ASKED not to push to main. This is the
    // same rule as code: rejection, not persuasion.
    const token = await builderWithRepo("builder-1", repo);
    workspaceMod.ensureStagingRepo({ name: "builder-1", repo, branch: "friday/builder-1" });
    await expect(pushRef(token, "builder-1", "refs/heads/main")).rejects.toThrow(
      /hook declined|refusing refs\/heads\/main/,
    );
  });

  it("accepts a push to the Builder's own branch", async () => {
    // The control: the gate must refuse for the right reason, not refuse
    // everything the moment a hook exists.
    const token = await builderWithRepo("builder-1", repo);
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });
    await expect(pushRef(token, "builder-1", "refs/heads/friday/builder-1")).resolves.toBeDefined();
    expect(
      execFileSync("git", ["--git-dir", staging, "rev-parse", "refs/heads/friday/builder-1"], {
        encoding: "utf8",
      }).trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses another Builder's branch, not just main", async () => {
    // Ref-scoped, so a Builder cannot land work under a sibling's name either.
    const token = await builderWithRepo("builder-1", repo);
    workspaceMod.ensureStagingRepo({ name: "builder-1", repo, branch: "friday/builder-1" });
    await expect(pushRef(token, "builder-1", "refs/heads/friday/builder-2")).rejects.toThrow(
      /hook declined|refusing/,
    );
  });

  it("makes the hook executable — git ignores a non-executable hook SILENTLY", async () => {
    // The chmod is the whole gate. Without it the push is simply accepted,
    // with no error anywhere, so this is pinned directly.
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });
    const mode = statSync(join(staging, "hooks", "update")).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  it("rewrites the gate on re-spawn, so an old branch cannot be inherited", () => {
    // `ensureStagingRepo` is idempotent; the gate must not be.
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });
    workspaceMod.ensureStagingRepo({ name: "builder-1", repo, branch: "friday/renamed" });
    const hook = readFileSync(join(staging, "hooks", "update"), "utf8");
    expect(hook).toContain("refs/heads/friday/renamed");
    expect(hook).not.toContain("refs/heads/friday/builder-1");
  });

  it("refuses to bake a branch name it cannot safely quote", () => {
    // The branch reaches here from `body.worktree.branch` and lands inside
    // single quotes in a generated shell script.
    expect(() =>
      workspaceMod.ensureStagingRepo({
        name: "builder-1",
        repo,
        branch: "friday/x'; rm -rf /; echo '",
      }),
    ).toThrow(/unsafe branch name/);
  });
});

describe("the staging repo's own lifecycle", () => {
  it("refuses a name that would escape the staging root", () => {
    // `name` comes from the registry rather than a URL, but it is interpolated
    // into a filesystem path, so separators are refused outright.
    expect(() => workspaceMod.stagingPathForAgent("../../etc/passwd")).toThrow(
      /invalid agent name/,
    );
    expect(() => workspaceMod.stagingPathForAgent("..")).toThrow(/invalid agent name/);
    expect(() => workspaceMod.stagingPathForAgent("")).toThrow(/invalid agent name/);
  });

  it("removes the staging repo, and is a no-op when there is none", () => {
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-1",
      repo,
      branch: "friday/builder-1",
    });
    expect(existsSync(staging)).toBe(true);
    workspaceMod.removeStagingRepo("builder-1");
    expect(existsSync(staging)).toBe(false);
    // Idempotent: archive can run twice, and a daemon-owned Builder never had one.
    expect(() => workspaceMod.removeStagingRepo("builder-1")).not.toThrow();
  });

  it("survives a source repo with no upstream main, without failing the spawn", () => {
    // The seed is an optimization. A repo whose `origin/main` does not exist
    // must still get a usable push target.
    const bare = seedRepo(join(scratch, "no-origin"));
    const staging = workspaceMod.ensureStagingRepo({
      name: "builder-3",
      repo: bare,
      branch: "friday/builder-3",
    });
    expect(existsSync(staging)).toBe(true);
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
