import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * FRI-2076, the clone half. The serve side shipped without a client; this is
 * the client, tested against the REAL route rather than a stub, because the
 * thing worth proving is that the two agree — the token header, the URL shape
 * and the CGI handshake all have to line up for a `git clone` to succeed.
 *
 * Async git throughout, for the reason `worker-git.test.ts` records at length:
 * `execFileSync` blocks the event loop, so an in-process server cannot accept
 * the connection its own blocked child is waiting on.
 */

let db: TestDbHandle;
let registry: typeof import("./registry.js");
let tokens: typeof import("./worker-tokens.js");
let handleWorkerGit: (typeof import("../api/worker-git.js"))["handleWorkerGit"];
let ensureContainerWorkspace: (typeof import("./workspace-clone.js"))["ensureContainerWorkspace"];

let server: Server;
let baseUrl: string;
let scratch: string;
let repo: string;

beforeAll(async () => {
  db = await createTestDb({ label: "workspace_clone" });
  registry = await import("./registry.js");
  tokens = await import("./worker-tokens.js");
  ({ handleWorkerGit } = await import("../api/worker-git.js"));
  ({ ensureContainerWorkspace } = await import("./workspace-clone.js"));
});

afterAll(async () => {
  await db.drop();
});

function seedRepo(at: string): string {
  mkdirSync(at, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: at, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.test");
  g("config", "user.name", "t");
  writeFileSync(join(at, "hello.txt"), "served\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return at;
}

beforeEach(async () => {
  await db.truncate();
  tokens.__resetWorkerTokensForTest();
  scratch = mkdtempSync(join(tmpdir(), "friday-ws-clone-"));
  repo = seedRepo(join(scratch, "source"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://worker-git");
    void handleWorkerGit({ req, res, url, path: url.pathname });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
  tokens.__resetWorkerTokensForTest();
});

/** Register a container Builder and mint the token its clone will use. */
async function containerBuilder(name: string, branch = `friday/${name}`): Promise<string> {
  await registry.registerAgent({
    name,
    type: "builder",
    parentName: "orchestrator",
    worktreePath: "/workspace",
    branch,
    metaJson: { repo, workspaceOwner: "container" },
  });
  return tokens.mintWorkerToken({ callerName: name, callerType: "builder" });
}

/** The env the broker hands a builder container. */
function containerEnv(token: string, branch = "friday/builder-1"): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    FRIDAY_TASK_ID: "task-1",
    FRIDAY_AGENT_NAME: "builder-1",
    FRIDAY_WORKER_TOKEN: token,
    FRIDAY_DAEMON_URL: baseUrl,
    FRIDAY_WORKSPACE_BRANCH: branch,
  };
}

/** An empty volume directory, the way the broker leaves it. */
function emptyVolume(): string {
  const at = join(scratch, "workspace");
  mkdirSync(at, { recursive: true });
  return at;
}

describe("filling a containerised Builder's workspace", () => {
  it("clones the daemon-served repo and lands on the Builder's branch", async () => {
    // The ticket: an empty volume becomes a working checkout, with no repo
    // credential anywhere in the container — only the per-worker token.
    const token = await containerBuilder("builder-1");
    const ws = emptyVolume();

    const out = await ensureContainerWorkspace(containerEnv(token), ws);

    expect(out.state).toBe("cloned");
    expect(readFileSync(join(ws, "hello.txt"), "utf8")).toBe("served\n");
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: ws,
        encoding: "utf8",
      }).trim(),
    ).toBe("friday/builder-1");
  });

  it("leaves an existing clone alone — a reattached volume keeps its work", async () => {
    // Builder volumes survive container restarts (stall kill, wedge respawn).
    // Re-cloning would discard uncommitted work every time.
    const token = await containerBuilder("builder-1");
    const ws = emptyVolume();
    await ensureContainerWorkspace(containerEnv(token), ws);
    writeFileSync(join(ws, "in-progress.txt"), "not committed\n");

    const out = await ensureContainerWorkspace(containerEnv(token), ws);

    expect(out.state).toBe("present");
    expect(existsSync(join(ws, "in-progress.txt"))).toBe(true);
  });

  it("does nothing for a forked worker, which has a real worktree", async () => {
    // `FRIDAY_TASK_ID` is set only by the container runtime. Without it this
    // must not touch the directory — a forked Builder's worktree is already
    // there and is not ours to re-clone.
    const token = await containerBuilder("builder-1");
    const ws = emptyVolume();
    const env = containerEnv(token);
    delete env.FRIDAY_TASK_ID;

    const out = await ensureContainerWorkspace(env, ws);

    expect(out.state).toBe("skipped");
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("reports failure rather than throwing when the token is not valid", async () => {
    // It runs before the turn starts, so an exception would kill the worker
    // with no visible reason. The daemon needs a reason to surface.
    await containerBuilder("builder-1");
    const ws = emptyVolume();

    const out = await ensureContainerWorkspace(containerEnv("never-minted"), ws);

    expect(out.state).toBe("failed");
    expect(out.reason).toBeTruthy();
  });

  it("reports failure when there is nothing to clone with", async () => {
    const ws = emptyVolume();
    const out = await ensureContainerWorkspace(
      { FRIDAY_TASK_ID: "task-1", PATH: process.env.PATH },
      ws,
    );
    expect(out.state).toBe("failed");
    expect(out.reason).toMatch(/FRIDAY_WORKER_TOKEN/);
  });

  it("still clones when the row carries no branch", async () => {
    // `FRIDAY_WORKSPACE_BRANCH` is empty when the registry lookup found none.
    // The clone is the valuable half and must not depend on it.
    const token = await containerBuilder("builder-1");
    const ws = emptyVolume();
    const env = containerEnv(token);
    env.FRIDAY_WORKSPACE_BRANCH = "";

    const out = await ensureContainerWorkspace(env, ws);

    expect(out.state).toBe("cloned");
    expect(readFileSync(join(ws, "hello.txt"), "utf8")).toBe("served\n");
  });
});
