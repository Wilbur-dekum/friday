import { describe, expect, it } from "vitest";
import { isRepoAllowed, normalizeRepoRef, resolveRepoAllowlist } from "./repo-allowlist.js";

/**
 * FRI-2041. `POST /api/agents` handed `worktree.repo` to `createWorkspace`
 * with no authorization — `assertInsideWorkspacesRoot` answers where a
 * worktree may live, not which repo it may be cut from.
 *
 * The cases below are the ways an allowlist actually leaks. Each is a string
 * an attacker would try, not a shape the happy path produces.
 */

const LIST = ["https://github.com/acme/web"];

describe("isRepoAllowed", () => {
  it("admits the same repo written the other common ways", () => {
    for (const spelling of [
      "https://github.com/acme/web",
      "https://github.com/acme/web.git",
      "https://github.com/acme/web/",
      "https://GitHub.com/acme/web", // host is case-insensitive
      "git@github.com:acme/web.git", // scp-style SSH
      "ssh://git@github.com/acme/web",
    ]) {
      expect(isRepoAllowed(spelling, LIST), spelling).toBe(true);
    }
  });

  it("refuses a repo whose name merely EXTENDS an allowed one", () => {
    // The classic allowlist leak. `web-internal` is a different repository.
    expect(isRepoAllowed("https://github.com/acme/web-internal", LIST)).toBe(false);
    expect(isRepoAllowed("https://github.com/acme/web/../secrets", LIST)).toBe(false);
    expect(isRepoAllowed("https://github.com/acme/webb", LIST)).toBe(false);
  });

  it("ignores credentials rather than letting them change the match", () => {
    // Same repo: must still be allowed, and the userinfo must not be the
    // reason it matched or failed.
    expect(isRepoAllowed("https://user:token@github.com/acme/web", LIST)).toBe(true);
    // Different repo with credentials that LOOK like the allowed host.
    expect(isRepoAllowed("https://github.com@evil.example/acme/web", LIST)).toBe(false);
  });

  it("does not let a different host borrow an allowed path", () => {
    expect(isRepoAllowed("https://evil.example/acme/web", LIST)).toBe(false);
    expect(isRepoAllowed("git@evil.example:acme/web.git", LIST)).toBe(false);
  });

  it("keeps paths case-SENSITIVE while hosts are not", () => {
    // DNS is case-insensitive; repository paths are not, and treating them
    // as such would admit a repo the admin did not list.
    expect(isRepoAllowed("https://github.com/acme/Web", LIST)).toBe(false);
    expect(isRepoAllowed("https://github.com/Acme/web", LIST)).toBe(false);
  });

  it("refuses an unparseable repo rather than falling open", () => {
    expect(isRepoAllowed("", LIST)).toBe(false);
    expect(isRepoAllowed("   ", LIST)).toBe(false);
    expect(isRepoAllowed("http://[not-a-url", LIST)).toBe(false);
  });

  it("refuses everything when an allowlist entry is itself unparseable", () => {
    // A malformed entry must not widen the list — it simply matches nothing.
    expect(isRepoAllowed("https://github.com/acme/web", ["http://[bad"])).toBe(false);
  });

  it("is permissive only when NO allowlist is configured", () => {
    // Matches today's behaviour so the upgrade does not break every builder
    // spawn; the caller logs that the boundary is absent.
    expect(isRepoAllowed("https://github.com/anything/at-all", undefined)).toBe(true);
    expect(isRepoAllowed("https://github.com/anything/at-all", [])).toBe(true);
    // ...and strict the moment one exists.
    expect(isRepoAllowed("https://github.com/anything/at-all", LIST)).toBe(false);
  });

  it("matches local paths, which is how the daily driver spawns builders", () => {
    // `worktree.repo` defaults to process.cwd(), so local paths are the
    // common case, not an edge one.
    expect(isRepoAllowed(process.cwd(), [process.cwd()])).toBe(true);
    expect(isRepoAllowed(process.cwd(), ["/some/other/repo"])).toBe(false);
  });
});

describe("normalizeRepoRef", () => {
  it("drops port and userinfo but keeps host and path", () => {
    expect(normalizeRepoRef("https://u:p@Example.COM:8443/a/b.git")).toEqual({
      host: "example.com",
      path: "a/b",
    });
  });

  it("returns null for input it cannot understand", () => {
    expect(normalizeRepoRef("")).toBeNull();
    expect(normalizeRepoRef("http://[bad")).toBeNull();
  });
});

describe("resolveRepoAllowlist", () => {
  it("is undefined unless configured", () => {
    expect(resolveRepoAllowlist({})).toBeUndefined();
    expect(resolveRepoAllowlist({ FRIDAY_REPO_ALLOWLIST: "" })).toBeUndefined();
    expect(resolveRepoAllowlist({ FRIDAY_REPO_ALLOWLIST: " , , " })).toBeUndefined();
  });

  it("splits and trims a comma-separated list", () => {
    expect(resolveRepoAllowlist({ FRIDAY_REPO_ALLOWLIST: " a/b , c/d ,, e/f " })).toEqual([
      "a/b",
      "c/d",
      "e/f",
    ]);
  });
});
