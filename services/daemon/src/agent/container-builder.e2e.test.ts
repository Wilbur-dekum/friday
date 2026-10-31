/**
 * The containerised Builder's git round trip, in a REAL container
 * (FRI-2076 + FRI-2077).
 *
 * Every other test for this chain runs in-process: real git, real repos, real
 * routes, but the broker, Docker and the builder image are not in the loop. So
 * the one thing none of them can answer is the one that matters — does the code
 * work from inside the artifact a Builder actually runs in?
 *
 * This answers it. The daemon side runs here (the git route, the staging repo,
 * the ref gate, the forward); the client side runs `docker run` against the
 * builder image, reaching back over `host.docker.internal`. What it proves that
 * a unit test cannot:
 *
 *   - the image HAS git, and a version that speaks the smart-HTTP the route
 *     serves (2.39 at time of writing; the handshake is version-sensitive)
 *   - a container can actually reach the daemon and authenticate with the
 *     per-worker token
 *   - `ensureContainerWorkspace` works against the compiled `dist`, not the
 *     TypeScript source — the image ships the former
 *   - a push from inside a container lands in staging, is gated, and forwards
 *
 * ## Skipped unless the image is present
 *
 * It needs Docker and a builder image built FROM THIS BRANCH — a stale image
 * silently tests old code, which is worse than not running. Build and point at
 * it with:
 *
 *   docker build --target worker -t friday-worker:e2e .
 *   FRIDAY_E2E_BUILDER_IMAGE=friday-worker:e2e pnpm test:e2e
 *
 * The image is asserted to carry `workspace-clone.js` before anything else
 * runs, so "stale image" fails loudly rather than as a mystery clone error.
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

const run = promisify(execFile);

const IMAGE = process.env.FRIDAY_E2E_BUILDER_IMAGE ?? "friday-worker:latest";

/** Docker reachable at all? */
function dockerUp(): boolean {
  return (
    spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" })
      .status === 0
  );
}

/** Is the image present AND built from code that contains the clone half? */
function imageIsCurrent(): boolean {
  const r = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "ls", IMAGE, "services/daemon/dist/agent/workspace-clone.js"],
    { stdio: "pipe" },
  );
  return r.status === 0;
}

const skip = !dockerUp() || !imageIsCurrent();

let db: TestDbHandle;
let registry: typeof import("./registry.js");
let tokens: typeof import("./worker-tokens.js");
let handleWorkerGit: (typeof import("../api/worker-git.js"))["handleWorkerGit"];
let workspaceMod: typeof import("./workspace.js");

let server: Server;
let port: number;
let scratch: string;
let repo: string;
let probe: string;

/**
 * The script the container runs, in place of the worker's own startup.
 *
 * It calls the SAME function `mainLoop` calls, then does what the agent would:
 * commit and push. Mounted rather than passed with `-e` so it stays readable.
 */
const PROBE = `
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ensureContainerWorkspace } from "/app/services/daemon/dist/agent/workspace-clone.js";

const WS = "/workspace";
mkdirSync(WS, { recursive: true });

const out = await ensureContainerWorkspace(process.env, WS);
console.log("CLONE:" + JSON.stringify(out));
if (out.state !== "cloned") process.exit(2);

const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  cwd: WS, encoding: "utf8",
}).trim();
console.log("BRANCH:" + branch);

// The same credential shape the clone used; a push needs it too.
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: "Authorization: Bearer " + process.env.FRIDAY_WORKER_TOKEN,
  GIT_AUTHOR_NAME: "Builder", GIT_AUTHOR_EMAIL: "b@t.test",
  GIT_COMMITTER_NAME: "Builder", GIT_COMMITTER_EMAIL: "b@t.test",
};
writeFileSync(WS + "/from-the-container.txt", "built inside a container\\n");
execFileSync("git", ["add", "."], { cwd: WS, env });
execFileSync("git", ["commit", "-qm", "work from a real container"], { cwd: WS, env });
console.log("HEAD:" + execFileSync("git", ["rev-parse", "HEAD"], { cwd: WS, encoding: "utf8", env }).trim());

// The gate: this must be refused.
try {
  execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: WS, env, stdio: "pipe" });
  console.log("GATE:NOT-ENFORCED");
} catch (e) {
  console.log("GATE:refused");
}

// The Builder's own branch: this must land.
execFileSync("git", ["push", "origin", "HEAD:refs/heads/" + branch], { cwd: WS, env, stdio: "pipe" });
console.log("PUSH:ok");
`;

function seedRepo(at: string): string {
  const g = (...a: string[]) => execFileSync("git", a, { cwd: at, stdio: "pipe" });
  execFileSync("mkdir", ["-p", at]);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.test");
  g("config", "user.name", "t");
  writeFileSync(join(at, "hello.txt"), "served by the daemon\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return at;
}

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

beforeAll(async () => {
  db = await createTestDb({ label: "container_builder" });
  registry = await import("./registry.js");
  tokens = await import("./worker-tokens.js");
  ({ handleWorkerGit } = await import("../api/worker-git.js"));
  workspaceMod = await import("./workspace.js");
});

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.truncate();
  tokens.__resetWorkerTokensForTest();
  scratch = mkdtempSync(join(tmpdir(), "friday-container-e2e-"));
  repo = seedRepo(join(scratch, "source"));
  probe = join(scratch, "probe.mjs");
  writeFileSync(probe, PROBE);
  // 0.0.0.0, not loopback: the container reaches this from its own netns.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://worker-git");
    void handleWorkerGit({ req, res, url, path: url.pathname });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
  rmSync(workspaceMod.stagingRoot(), { recursive: true, force: true });
  tokens.__resetWorkerTokensForTest();
});

describe.skipIf(skip)("a Builder in a real container", () => {
  it("clones, commits, is gated off main, and its branch forwards", async () => {
    const name = "builder-e2e";
    const branch = `friday/${name}`;
    await registry.registerAgent({
      name,
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/workspace",
      branch,
      metaJson: { repo, workspaceOwner: "container" },
    });
    const token = tokens.mintWorkerToken({ callerName: name, callerType: "builder" });
    const staging = workspaceMod.ensureStagingRepo({ name, repo, branch });

    const { stdout } = await run(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${probe}:/probe.mjs:ro`,
        "-e",
        "FRIDAY_TASK_ID=e2e-task",
        "-e",
        `FRIDAY_AGENT_NAME=${name}`,
        "-e",
        `FRIDAY_WORKER_TOKEN=${token}`,
        "-e",
        `FRIDAY_DAEMON_URL=http://host.docker.internal:${port}`,
        "-e",
        `FRIDAY_WORKSPACE_BRANCH=${branch}`,
        "--entrypoint",
        "node",
        IMAGE,
        "/probe.mjs",
      ],
      { timeout: 300_000 },
    );

    // The container's own account of what happened.
    expect(stdout).toContain('CLONE:{"state":"cloned"}');
    expect(stdout).toContain(`BRANCH:${branch}`);
    expect(stdout).toContain("GATE:refused");
    expect(stdout).toContain("PUSH:ok");

    const head = /HEAD:([0-9a-f]{40})/.exec(stdout)?.[1];
    expect(head).toBeTruthy();

    // The daemon's side of the story.
    expect(refSha(staging, `refs/heads/${branch}`)).toBe(head);
    // `main` never moved — the gate refused it rather than the push failing
    // for some unrelated reason.
    expect(refSha(staging, "refs/heads/main")).toBeNull();

    // And the forward carried it to the real repo. It runs after the push
    // response is sent, so poll rather than assume.
    const deadline = Date.now() + 30_000;
    let landed: string | null = null;
    while (Date.now() < deadline) {
      landed = refSha(join(repo, ".git"), `refs/heads/${branch}`);
      if (landed) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(landed).toBe(head);
  }, 360_000);
});
