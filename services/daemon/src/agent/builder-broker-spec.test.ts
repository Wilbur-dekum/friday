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
    egressNoProxy: (proxyUrl: string) => string;
    egressProxyUrl: (base: string, token?: string) => string;
    egressModelBaseUrl: (proxyUrl: string) => string | null;
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

describe("egress (FRI-2039)", () => {
  /** The Env array the spec carries, as a lookup. */
  function envOf(spec: Record<string, never>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of (spec as unknown as { Env: string[] }).Env) {
      const i = entry.indexOf("=");
      out[entry.slice(0, i)] = entry.slice(i + 1);
    }
    return out;
  }

  it("joins the network broker config names, never one the caller picks", async () => {
    // The internal network IS the deny half of deny-by-default. A caller able
    // to choose it could ask for one with a route to the internet.
    const build = await loadSpecBuilder({ BROKER_BUILDER_NETWORK: "friday_builders" });
    const spec = build("task-1", { NetworkMode: "bridge" } as never);
    expect(
      (spec as unknown as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode,
    ).toBe("friday_builders");
  });

  it("injects the proxy the OPERATOR configured", async () => {
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(build("task-1", {}));
    // Both spellings: tools disagree on case.
    expect(env.HTTPS_PROXY).toBe("http://friday:7611");
    expect(env.https_proxy).toBe("http://friday:7611");
    expect(env.HTTP_PROXY).toBe("http://friday:7611");
    expect(env.http_proxy).toBe("http://friday:7611");
  });

  it("a caller cannot supply its own proxy", async () => {
    // The whole control is that the daemon decides destinations. A builder
    // pointed at a proxy of its own choosing has no control at all.
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(
      build("task-1", {
        HTTPS_PROXY: "http://evil.example:8080",
        https_proxy: "http://evil.example:8080",
        NO_PROXY: "*",
      } as never),
    );
    expect(env.HTTPS_PROXY).toBe("http://friday:7611");
    expect(env.NO_PROXY).not.toBe("*");
  });

  it("a caller cannot UNSET the proxy to try its luck directly", async () => {
    // Belt and braces: on an internal network there is nowhere to go without
    // the proxy, but the env must not be the caller's to clear either.
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(build("task-1", { HTTPS_PROXY: "" } as never));
    expect(env.HTTPS_PROXY).toBe("http://friday:7611");
  });

  it("offers no proxy at all when the operator configured none", async () => {
    // On an internal network that is egress fully closed, which is a valid
    // and safe configuration — not a broken one.
    //
    // Deleted rather than passed empty: `loadBroker` writes its argument into
    // `process.env` and does not clear it afterwards, so a value set by an
    // earlier case is still there and "unset" has to be made unset.
    delete process.env.BROKER_EGRESS_PROXY;
    const build = await loadSpecBuilder({});
    const env = envOf(build("task-1", {}));
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("exempts the daemon's own host from the proxy", async () => {
    // The proxy host IS the daemon: the worker's API calls, git route and
    // command channel all go there. Routing them through CONNECT would refuse
    // them — not on the allowlist, and not port 443.
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(build("task-1", {}));
    expect(env.NO_PROXY.split(",")).toContain("friday");
    expect(env.no_proxy.split(",")).toContain("friday");
  });

  it("puts the worker's own token in the proxy URL, so ordinary tools authenticate", async () => {
    // `npm` and `git` will not set `Proxy-Authorization` by hand, but every
    // client that honours HTTPS_PROXY turns userinfo into a Basic credential.
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(build("task-1", { FRIDAY_WORKER_TOKEN: "tok-123" }));
    expect(env.HTTPS_PROXY).toBe("http://x-friday:tok-123@friday:7611/");
    expect(env.http_proxy).toBe("http://x-friday:tok-123@friday:7611/");
  });

  it("offers the bare proxy URL when there is no token to put in it", async () => {
    // A builder with no token cannot authenticate anyway, and an empty
    // password looks configured when it is not.
    const { egressProxyUrl } = await loadBroker({});
    expect(egressProxyUrl("http://friday:7611", undefined)).toBe("http://friday:7611");
    expect(egressProxyUrl("not-a-url", "tok")).toBe("not-a-url");
  });

  it("points the SDK at the daemon's model route and hands it the worker token", async () => {
    // FRI-2084: the builder gets no Anthropic key. It gets the daemon's route
    // plus its OWN worker token, which the daemon swaps for the real
    // credential. `ANTHROPIC_AUTH_TOKEN` is how the SDK sends a bearer rather
    // than an `x-api-key`, and that bearer is the header the daemon already
    // authenticates workers with.
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(build("task-1", { FRIDAY_WORKER_TOKEN: "tok-123" }));
    expect(env.ANTHROPIC_BASE_URL).toBe("http://friday:7611/api/model");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-123");
  });

  it("never hands a builder a real Anthropic credential", async () => {
    // The whole point of brokering. If any of these appear, the credential is
    // in the untrusted container and the boundary is decoration.
    const build = await loadSpecBuilder({ BROKER_EGRESS_PROXY: "http://friday:7611" });
    const env = envOf(build("task-1", { FRIDAY_WORKER_TOKEN: "tok-123" }));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // And a caller cannot smuggle one in through the env it supplies.
    const smuggled = envOf(
      build("task-2", {
        FRIDAY_WORKER_TOKEN: "tok-123",
        ANTHROPIC_API_KEY: "sk-smuggled",
        ANTHROPIC_BASE_URL: "http://evil.example",
        ANTHROPIC_AUTH_TOKEN: "attacker-token",
      } as never),
    );
    expect(smuggled.ANTHROPIC_API_KEY).toBeUndefined();
    // Broker-set values win: a caller that could choose the base URL could
    // point the worker token at a host of its own.
    expect(smuggled.ANTHROPIC_BASE_URL).toBe("http://friday:7611/api/model");
    expect(smuggled.ANTHROPIC_AUTH_TOKEN).toBe("tok-123");
  });

  it("strips credentials from the proxy URL when deriving the model base", async () => {
    // The proxy URL carries userinfo so ordinary tools authenticate; the model
    // route authenticates by bearer instead, so the base must not leak a
    // second copy of the token into another variable.
    const { egressModelBaseUrl } = await loadBroker({});
    expect(egressModelBaseUrl("http://x-friday:tok@friday:7611")).toBe(
      "http://friday:7611/api/model",
    );
    expect(egressModelBaseUrl("not-a-url")).toBeNull();
  });

  it("offers no model route when the operator configured no proxy base", async () => {
    delete process.env.BROKER_EGRESS_PROXY;
    const build = await loadSpecBuilder({});
    const env = envOf(build("task-1", { FRIDAY_WORKER_TOKEN: "tok-123" }));
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("derives NO_PROXY from the proxy URL rather than a second setting", async () => {
    const { egressNoProxy } = await loadBroker({});
    expect(egressNoProxy("http://daemon.internal:7611").split(",")).toContain("daemon.internal");
    // A malformed URL still yields something safe rather than throwing out of
    // container creation.
    expect(egressNoProxy("not-a-url")).toBe("localhost,127.0.0.1");
  });
});
