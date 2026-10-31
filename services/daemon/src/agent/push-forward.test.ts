import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * FRI-2077 slice 3. The push landed in staging behind the `update` gate; this
 * is what carries it the rest of the way.
 *
 * The destination is a REAL git repo on disk rather than a mock. What is being
 * tested is whether a ref arrives, and whether a failed forward leaves the
 * work recoverable — neither of which a stubbed `git push` can answer.
 *
 * Local-path destinations throughout, because that is the common case
 * (`worktree.repo` defaults to the daemon's cwd) and it needs no credential.
 * The GitHub path differs only in which env the child gets; the no-credential
 * branch is covered by asserting the refusal rather than by reaching GitHub.
 */

let workspaceMod: typeof import("./workspace.js");
let forwardStagedRef: (typeof import("./push-forward.js"))["forwardStagedRef"];

let scratch: string;

beforeEach(async () => {
  workspaceMod = await import("./workspace.js");
  ({ forwardStagedRef } = await import("./push-forward.js"));
  scratch = mkdtempSync(join(tmpdir(), "friday-forward-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(workspaceMod.stagingRoot(), { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });

/** A repo with one commit on `main` — the Builder's source, and its destination. */
function seedRepo(at: string): string {
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  git(at, "config", "user.email", "t@t.test");
  git(at, "config", "user.name", "t");
  writeFileSync(join(at, "hello.txt"), "hi\n");
  git(at, "add", ".");
  git(at, "commit", "-qm", "init");
  return at;
}

/** Stage a commit on `branch` in the Builder's staging repo, as a push would. */
function stageCommit(name: string, repo: string, branch: string): { staging: string; sha: string } {
  const staging = workspaceMod.ensureStagingRepo({ name, repo, branch });
  // Build the commit in a throwaway clone, then push it into staging — the
  // same direction the real Builder's push travels.
  const work = join(scratch, `work-${name}`);
  git(scratch, "clone", "-q", repo, work);
  git(work, "config", "user.email", "t@t.test");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "new.txt"), "work\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "builder work");
  git(work, "push", "-q", staging, `HEAD:refs/heads/${branch}`);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
  return { staging, sha };
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

describe("forwarding a staged branch", () => {
  it("lands the ref in the destination repo", async () => {
    // The ticket, end to end: work that only existed in staging now exists
    // where the rest of the system can see it.
    const repo = seedRepo(join(scratch, "source"));
    const { sha } = stageCommit("builder-1", repo, "friday/builder-1");

    const out = await forwardStagedRef({
      agentName: "builder-1",
      repo,
      branch: "friday/builder-1",
    });

    expect(out.forwarded).toBe(true);
    expect(refSha(join(repo, ".git"), "refs/heads/friday/builder-1")).toBe(sha);
  });

  it("forwards ONLY the named branch, not everything in staging", async () => {
    // Defence in depth behind the `update` gate: even if some other ref were
    // in staging, the forward names one refspec and carries nothing else.
    const repo = seedRepo(join(scratch, "source"));
    const { staging } = stageCommit("builder-1", repo, "friday/builder-1");
    // Plant a second ref directly, bypassing the hook the way only the daemon
    // itself could. Staging holds only the Builder's branch — the seed fetches
    // the base ref straight into it — so that is what this points at.
    git(
      scratch,
      "--git-dir",
      staging,
      "update-ref",
      "refs/heads/sneaky",
      "refs/heads/friday/builder-1",
    );

    await forwardStagedRef({ agentName: "builder-1", repo, branch: "friday/builder-1" });

    expect(refSha(join(repo, ".git"), "refs/heads/friday/builder-1")).not.toBeNull();
    expect(refSha(join(repo, ".git"), "refs/heads/sneaky")).toBeNull();
  });

  it("leaves the ref in staging when the forward fails, so it is retryable", async () => {
    // The whole reason pushes land in staging rather than the prunable mirror.
    // A destination that does not exist is the simplest real failure.
    const repo = seedRepo(join(scratch, "source"));
    const { staging, sha } = stageCommit("builder-1", repo, "friday/builder-1");
    rmSync(repo, { recursive: true, force: true });

    const out = await forwardStagedRef({
      agentName: "builder-1",
      repo,
      branch: "friday/builder-1",
    });

    expect(out.forwarded).toBe(false);
    expect(out.reason).toBeTruthy();
    // Still there — the work is recoverable on a later push.
    expect(refSha(staging, "refs/heads/friday/builder-1")).toBe(sha);
  });

  it("does not force: a diverged destination branch is refused, not overwritten", async () => {
    // Someone else moved the branch. Silently overwriting that is the one
    // outcome worse than refusing to forward.
    const repo = seedRepo(join(scratch, "source"));
    const { staging, sha } = stageCommit("builder-1", repo, "friday/builder-1");
    // Put an unrelated commit on the destination's copy of the branch.
    const other = join(scratch, "other");
    git(scratch, "clone", "-q", repo, other);
    git(other, "config", "user.email", "t@t.test");
    git(other, "config", "user.name", "t");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "-qm", "someone else");
    git(other, "push", "-q", repo, "HEAD:refs/heads/friday/builder-1");
    const theirs = refSha(join(repo, ".git"), "refs/heads/friday/builder-1");

    const out = await forwardStagedRef({
      agentName: "builder-1",
      repo,
      branch: "friday/builder-1",
    });

    expect(out.forwarded).toBe(false);
    // Their commit survived, and ours is still staged.
    expect(refSha(join(repo, ".git"), "refs/heads/friday/builder-1")).toBe(theirs);
    expect(refSha(staging, "refs/heads/friday/builder-1")).toBe(sha);
  });

  it("refuses a GitHub destination with no credential, without losing the ref", async () => {
    // A GitHub remote needs a token. Absent one, this must not look like
    // success and must not be a hard failure either — the ref waits in staging.
    const repo = seedRepo(join(scratch, "source"));
    const { staging, sha } = stageCommit("builder-1", repo, "friday/builder-1");

    const out = await forwardStagedRef({
      agentName: "builder-1",
      // A GitHub URL, so `needsToken` is true. No GITHUB_TOKEN is configured
      // in the test data dir.
      repo: "https://github.com/acme/widgets",
      branch: "friday/builder-1",
    });

    expect(out.forwarded).toBe(false);
    expect(out.reason).toMatch(/no GitHub credential/);
    expect(refSha(staging, "refs/heads/friday/builder-1")).toBe(sha);
  });

  it("never throws, whatever it is handed", async () => {
    // It runs after the response is sent, so an exception would surface as an
    // unhandled rejection and take the daemon down for a failed `git push`.
    await expect(
      forwardStagedRef({ agentName: "../escape", repo: "/nope", branch: "friday/x" }),
    ).resolves.toEqual(expect.objectContaining({ forwarded: false }));
  });
});
