import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * FRI-2080. A container-owned workspace is a volume at `/workspace` inside a
 * builder container. The daemon cannot see it, and three daemon-side
 * consumers previously assumed every Builder's workspace was a worktree on
 * their own filesystem.
 *
 * The distinction these tests defend: "I cannot see it" and "it is gone" are
 * different facts, and only the second one means the Builder is broken.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friday-ws-owner-"));
  process.env.FRIDAY_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.FRIDAY_DATA_DIR;
});

describe("isDaemonOwnedWorkspace", () => {
  it("treats an absent owner as the daemon's, so old rows keep their meaning", async () => {
    // Every builder row written before FRI-2080 has no `workspaceOwner`, and
    // every one of them is a worktree the daemon made. Defaulting the other
    // way would silently stop archiving genuinely orphaned Builders.
    const { isDaemonOwnedWorkspace } = await import("./workspace.js");
    expect(isDaemonOwnedWorkspace(undefined)).toBe(true);
    expect(isDaemonOwnedWorkspace(null)).toBe(true);
    expect(isDaemonOwnedWorkspace("daemon")).toBe(true);
    expect(isDaemonOwnedWorkspace("container")).toBe(false);
  });

  it("pins the mount path the broker and the daemon both have to agree on", async () => {
    const { CONTAINER_WORKSPACE_PATH } = await import("./workspace.js");
    // Matches the broker's container spec Target. Two spellings of this would
    // be a bug nothing catches until a Builder cannot find its own repo.
    expect(CONTAINER_WORKSPACE_PATH).toBe("/workspace");
    const broker = await import("../../../builder-broker/broker.mjs");
    const spec = (
      broker as unknown as {
        buildContainerSpec: (
          t: string,
          e: Record<string, string>,
        ) => { HostConfig: { Mounts: Array<{ Target: string }> } };
      }
    ).buildContainerSpec("task-1", {});
    expect(spec.HostConfig.Mounts[0]!.Target).toBe(CONTAINER_WORKSPACE_PATH);
  });
});

describe("archiveWorkspace with a container-owned workspace", () => {
  /** A real git repo with a real worktree, so teardown has something to get wrong. */
  function seedRepoAndWorktree(name: string) {
    const repo = join(dataDir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.test");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "x\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return { repo, git, name };
  }

  it("does NOT delete a daemon directory that happens to share the agent's name", async () => {
    // The hazard worth a test. `archiveWorkspace` derives the path from the
    // NAME, not from the stored path, so a container Builder reusing the name
    // of an earlier daemon-owned one would `rm -rf` a worktree that was never
    // its own.
    const { archiveWorkspace, workspacePath } = await import("./workspace.js");
    const { repo, git } = seedRepoAndWorktree("reused-name");
    const stale = workspacePath("reused-name");
    mkdirSync(stale, { recursive: true });
    git("worktree", "add", "-q", "-b", "friday/reused-name", stale, "main");
    expect(existsSync(stale)).toBe(true);

    archiveWorkspace("reused-name", repo, {
      branch: "friday/reused-name",
      repo,
      owner: "container",
    });

    // Untouched: the volume was the broker's to tear down, and this directory
    // belongs to something else entirely.
    expect(existsSync(stale)).toBe(true);
  });

  it("still deletes the branch, because that really is the daemon's", async () => {
    // Once FRI-2077 forwards pushes the branch lives in the daemon's git dir,
    // so "destroy means destroy" is unchanged for it.
    const { archiveWorkspace } = await import("./workspace.js");
    const { repo, git } = seedRepoAndWorktree("b1");
    git("branch", "friday/b1", "main");
    expect(
      execFileSync("git", ["branch", "--list", "friday/b1"], { cwd: repo }).toString(),
    ).toMatch(/friday\/b1/);

    archiveWorkspace("b1", repo, { branch: "friday/b1", repo, owner: "container" });

    expect(
      execFileSync("git", ["branch", "--list", "friday/b1"], { cwd: repo }).toString().trim(),
    ).toBe("");
  });

  it("removes the worktree when the workspace IS the daemon's", async () => {
    // The control. Without it the two cases above could pass on a function
    // that simply never does anything.
    const { archiveWorkspace, workspacePath } = await import("./workspace.js");
    const { repo, git } = seedRepoAndWorktree("d1");
    const path = workspacePath("d1");
    mkdirSync(path, { recursive: true });
    git("worktree", "add", "-q", "-b", "friday/d1", path, "main");
    expect(existsSync(path)).toBe(true);

    archiveWorkspace("d1", repo, { branch: "friday/d1", repo, owner: "daemon" });

    expect(existsSync(path)).toBe(false);
  });
});
