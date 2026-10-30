import { describe, expect, it } from "vitest";
import { checkBashForDisaster } from "./disaster-patterns.js";

/**
 * FRI-2042: `.git/hooks` on the deny-list.
 *
 * Every other deny path is absolute and OUTSIDE the workspace. This one
 * inverts that — it is a path the Builder otherwise owns, denied because of
 * what git does with it. A `post-checkout` dropped there re-executes on the
 * next turn in an otherwise "fresh" container, because it survives on the
 * reattached worktree volume. That is the specific mechanism that makes
 * per-turn ephemerality illusory, which is why FRI-2038 states its guarantee
 * as "bounded to one assignment".
 */

const WS = "/tmp/ws";
const denied = (cmd: string) => checkBashForDisaster(cmd, WS);

describe("writing a git hook", () => {
  it("blocks the forms a persistence attempt actually takes", () => {
    // Relative, because the worker's cwd IS the worktree.
    expect(denied("echo evil > .git/hooks/post-checkout")).toMatch(/protected path/);
    expect(denied("echo evil >> .git/hooks/pre-commit")).toMatch(/protected path/);
    expect(denied("cp /tmp/evil .git/hooks/post-merge")).toBeTruthy();
    expect(denied("mv /tmp/evil .git/hooks/post-commit")).toBeTruthy();
    expect(denied("tee .git/hooks/pre-push")).toBeTruthy();
  });

  it("blocks it by absolute path too, inside the workspace", () => {
    // Inside the workspace, so the containment check passes it — this rule
    // is the only thing standing in the way.
    expect(denied(`cp /tmp/evil ${WS}/.git/hooks/post-checkout`)).toBeTruthy();
    expect(denied(`echo x > ${WS}/.git/hooks/post-checkout`)).toMatch(/protected path/);
  });

  it("blocks a nested worktree's hooks, not just the top-level one", () => {
    expect(denied("cp /tmp/evil vendor/sub/.git/hooks/post-checkout")).toBeTruthy();
  });

  it("blocks the hooks directory itself, not only files under it", () => {
    expect(denied("cp -r /tmp/evil .git/hooks")).toBeTruthy();
  });
});

describe("relocating the hooks directory", () => {
  it("blocks `git config core.hooksPath`, which no path check could catch", () => {
    // The same persistence with a different path: the dangerous value is an
    // ordinary-looking directory the repo already contains, so there is
    // nothing path-shaped to deny.
    expect(denied("git config core.hooksPath .ci")).toMatch(/hooksPath/);
    expect(denied("git config --local core.hooksPath ./scripts")).toMatch(/hooksPath/);
    expect(denied("git config core.HooksPath .ci")).toMatch(/hooksPath/);
  });

  it("leaves ordinary git config alone", () => {
    expect(denied("git config user.email me@example.com")).toBeNull();
    expect(denied("git config --get remote.origin.url")).toBeNull();
  });
});

describe("what it must NOT break", () => {
  it("leaves the rest of .git alone — Builders commit, branch and push", () => {
    expect(denied("cat .git/HEAD")).toBeNull();
    expect(denied("echo ref > .git/MERGE_MSG")).toBeNull();
    expect(denied("git add .")).toBeNull();
    expect(denied("git commit -m x")).toBeNull();
  });

  it("does not match a path that merely CONTAINS the words", () => {
    // `.github/hooks` and `src/git/hooks` are ordinary repository paths; a
    // sloppy substring match would deny real work in any repo with CI config.
    expect(denied("cp /tmp/a .github/hooks/x")).toBeNull();
    expect(denied("cp /tmp/a src/git/hooks/x")).toBeNull();
    expect(denied("cp /tmp/a docs/.git-hooks/x")).toBeNull();
  });
});
