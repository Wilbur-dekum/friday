import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FRI-2079: the image a per-task builder container runs.
 *
 * Three facts about the Dockerfile are load-bearing and none of them is
 * checked by building it, which is why they are checked here. Docker's
 * default target is the LAST stage, and that has already silently rebuilt the
 * Deployment as the dev image once — `gh` present and FRIDAY_DEV_CONTAINER=1
 * on the service customers run. A stage appended in the wrong place
 * reintroduces exactly that, and nothing fails until someone notices.
 */

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");

/** Stage names in file order. */
const stages = [...dockerfile.matchAll(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/gm)]
  .map((m) => m[1])
  .filter((n): n is string => Boolean(n));

/**
 * The DIRECTIVES of one stage, comments stripped.
 *
 * Stripping matters: this file's own comments discuss `gh` at length, and a
 * naive text search found those instead of an install. The question is always
 * what the image contains, never what the Dockerfile says about it.
 */
function stageBody(name: string): string {
  const start = dockerfile.search(new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, "m"));
  expect(start, `stage ${name} not found`).toBeGreaterThanOrEqual(0);
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM\s/m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return body
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

describe("the builder worker image", () => {
  it("keeps `dev` as the last stage, so the default target does not move", () => {
    // The banner in the Dockerfile says every build site pins its target
    // because `dev` is the default. That claim is only true while `dev` is
    // last. If this fails, either move the new stage above `dev` or re-check
    // every build site and rewrite the banner — do not just update this.
    expect(stages.at(-1)).toBe("dev");
    expect(stages).toContain("worker");
    expect(stages.indexOf("worker")).toBeLessThan(stages.indexOf("dev"));
  });

  it("builds the worker FROM runtime, not FROM dev — no `gh` in a builder", () => {
    // Under FRI-2078 a Builder reaches GitHub through a daemon-hosted MCP
    // server with the token on the daemon side. A builder container has
    // nothing to authenticate `gh` with, and shipping it invites someone to
    // put a credential where FRI-2038 exists to keep credentials out of.
    expect(dockerfile).toMatch(/^FROM runtime AS worker$/m);
    expect(stageBody("worker")).not.toMatch(/\bgh\b/);
  });

  it("entrypoints the worker itself, and at a path the build actually emits", () => {
    // A typo here is a container that starts, fails to find its entry module,
    // and exits — which the daemon sees as a worker that died before dialling,
    // with nothing pointing at the real cause.
    const entry = /^ENTRYPOINT \["node", "(.+?)"\]$/m.exec(stageBody("worker"));
    expect(entry, "worker stage has no ENTRYPOINT").not.toBeNull();
    const rel = entry![1]!;
    expect(rel).toBe("services/daemon/dist/agent/worker.js");
    // `dist` is gitignored, so assert against the SOURCE the build compiles
    // from rather than the artifact, which is absent in a fresh worktree.
    const src = rel.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
    expect(() => readFileSync(join(REPO_ROOT, src), "utf8")).not.toThrow();
  });

  it("owns /workspace, the path the broker mounts and the daemon names", () => {
    // Two spellings of this path would be a bug nothing catches until a
    // Builder cannot find its own repo.
    expect(stageBody("worker")).toMatch(/mkdir -p \/workspace/);
  });
});
