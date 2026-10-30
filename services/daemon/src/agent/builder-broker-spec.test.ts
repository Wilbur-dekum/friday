import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FRI-2038: the builder broker's container spec.
 *
 * Why these assertions exist. Per-task builder containers need something
 * privileged to create them, and the easy implementation — mounting
 * `/var/run/docker.sock` into the Deployment container — is host-root
 * equivalent on the container that also runs the unsandboxed orchestrator.
 * That would gut the boundary FRI-2062 decided and FRI-2072 reinforced.
 *
 * The broker holds the socket instead. But a broker that forwards
 * caller-supplied specs is just the socket with extra steps, so what makes it
 * narrow is precisely what the caller CANNOT choose. That is a security
 * property, and a security property with no test is a comment.
 *
 * The broker is dependency-free `.mjs` on purpose (a privileged process is
 * the last place to inherit a dependency tree), so the spec builder is
 * imported directly rather than exercised through HTTP.
 */

async function loadBroker(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // Fresh module per case: the broker reads its config at import time, which
  // is deliberate — a privileged process should not re-read policy at runtime.
  // A literal specifier, because a variable one defeats the bundler's
  // resolution (same trap as packages/shared's env-layering test).
  vi.resetModules();
  return (await import("../../../builder-broker/broker.mjs")) as {
    buildContainerSpec: (taskId: string, env?: Record<string, string>) => Record<string, never>;
    clampGrace: (raw: unknown) => number;
  };
}

async function loadSpecBuilder(env: Record<string, string> = {}) {
  return (await loadBroker(env)).buildContainerSpec;
}

beforeEach(() => {
  process.env.BROKER_TOKEN = "t";
  process.env.BROKER_BUILDER_IMAGE = "friday-builder:test";
});

describe("builder container spec", () => {
  it("pins the image from broker config, never from the caller", async () => {
    const build = await loadSpecBuilder();
    const spec = build("task-1", { Image: "evil:latest" } as never);
    expect(spec.Image).toBe("friday-builder:test");
  });

  it("drops every env key outside the allowlist", async () => {
    // NODE_OPTIONS is the one that matters: a caller able to set it could
    // execute its own code at container start, which would make pinning the
    // image pointless.
    const build = await loadSpecBuilder();
    const spec = build("task-1", {
      FRIDAY_WORKER_TOKEN: "tok",
      NODE_OPTIONS: "--require /tmp/evil.js",
      LD_PRELOAD: "/tmp/evil.so",
      PATH: "/tmp/evil",
    });
    expect(spec.Env).toEqual(["FRIDAY_WORKER_TOKEN=tok"]);
  });

  it("mounts only a per-task named volume — nothing from the host", async () => {
    // A host bind mount would let a builder read or write the Deployment's
    // data dir, or the host filesystem, which is the whole thing containers
    // are here to prevent.
    const build = await loadSpecBuilder();
    const spec = build("task-1", {});
    const mounts = (spec as unknown as { HostConfig: { Mounts: Array<Record<string, string>> } })
      .HostConfig.Mounts;
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      Type: "volume",
      Source: "friday-builder-task-1",
      Target: "/workspace",
    });
    expect(mounts.some((m) => m.Type === "bind")).toBe(false);
  });

  it("never grants privilege, and says so explicitly", async () => {
    // Stated rather than omitted so a future edit has to delete a line.
    const build = await loadSpecBuilder();
    const hc = (
      build("task-1", {}) as unknown as {
        HostConfig: Record<string, unknown>;
      }
    ).HostConfig;
    expect(hc.Privileged).toBe(false);
    expect(hc.CapAdd).toEqual([]);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(hc.PidMode).toBeUndefined();
  });

  it("applies cgroup limits rather than relying on ulimits", async () => {
    // One of the upsides FRI-2038 names: resource limits become cgroups
    // instead of Darwin-honoured `ulimit`s.
    const build = await loadSpecBuilder();
    const hc = (build("task-1", {}) as unknown as { HostConfig: Record<string, number> })
      .HostConfig;
    expect(hc.Memory).toBeGreaterThan(0);
    expect(hc.NanoCpus).toBeGreaterThan(0);
    expect(hc.PidsLimit).toBeGreaterThan(0);
  });

  it("labels the container so the broker can recognise its own", async () => {
    const build = await loadSpecBuilder();
    expect(
      (build("task-1", {}) as unknown as { Labels: Record<string, string> }).Labels,
    ).toMatchObject({ "friday.builder": "1", "friday.task": "task-1" });
  });
});

describe("teardown grace period", () => {
  /**
   * FRI-2038. A container has no process group an outside caller can signal,
   * so the daemon's SIGTERM/SIGKILL distinction reaches the broker as "the
   * default stop timeout" versus "none". That mapping is load-bearing: the
   * abort path's forced kill fires at 500ms, and a fixed 10s stop would have
   * made the deadline meaningless for a containerised worker.
   */
  it("honours an urgent teardown and clamps a hostile one", async () => {
    const { clampGrace } = await loadBroker();
    expect(clampGrace("0")).toBe(0); // SIGKILL: no grace at all
    expect(clampGrace("5")).toBe(5);
    expect(clampGrace(null)).toBe(10); // SIGTERM: the broker's default
    expect(clampGrace("")).toBe(10);
    expect(clampGrace("nonsense")).toBe(10);
    // Caller-supplied, so bounded rather than trusted — an unbounded value
    // would let one request hold a privileged process for as long as it likes.
    expect(clampGrace("99999")).toBe(30);
    expect(clampGrace("-5")).toBe(0);
  });
});
