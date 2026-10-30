import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetContainerRuntimeForTest,
  acceptChannel,
  makeContainerRuntime,
  resolveBrokerConfig,
  resolveWorkerRuntime,
  taskIdForAgent,
} from "./container-runtime.js";
import { localProcessRuntime, type WorkerSpawnRequest } from "./worker-runtime.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "./worker-tokens.js";
import type { WorkerChannel } from "../api/worker-channel.js";

/**
 * FRI-2038. A worker in its own container has no parent process, so the
 * runtime seam's five capabilities are implemented against the broker (create,
 * inspect, stop) and the command channel (talk, listen, hear it die).
 *
 * The broker is a stub HTTP server rather than a mocked `fetch`, because the
 * things worth testing here are the requests actually put on the wire: that
 * the daemon never hands the broker a container spec, that a stale container
 * is reclaimed, and that urgency reaches it as a grace period.
 */

interface BrokerCall {
  method: string;
  path: string;
  body: unknown;
}

let broker: Server;
let calls: BrokerCall[];
/** Per-path queue of status codes, so a test can make one call 409. */
let statusQueue: number[];
let running: boolean;

beforeEach(async () => {
  __resetWorkerTokensForTest();
  __resetContainerRuntimeForTest();
  calls = [];
  statusQueue = [];
  running = true;
  broker = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      });
      const forced = statusQueue.shift();
      if (forced) {
        res.writeHead(forced, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forced" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ containerId: "c".repeat(64), running, exitCode: null }));
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  __resetWorkerTokensForTest();
  __resetContainerRuntimeForTest();
});

function cfg() {
  return {
    url: `http://127.0.0.1:${(broker.address() as AddressInfo).port}`,
    token: "broker-token",
    daemonUrl: "http://friday:7611",
  };
}

function spawnRequest(token: string): WorkerSpawnRequest {
  return {
    workerPath: "/opt/friday/worker.js",
    execArgv: [],
    env: { FRIDAY_WORKER_TOKEN: token, DATABASE_URL: "postgres://secret", HOME: "/root" },
    limits: { cpuSeconds: "3600", openFiles: "4096" },
  };
}

/** A channel double — the real one is covered by worker-channel.test.ts. */
function fakeChannel(callerName: string) {
  const sent: unknown[] = [];
  let onMessage: ((raw: unknown) => void) | undefined;
  let onClose: ((reason: string) => void) | undefined;
  const closed: string[] = [];
  const channel: WorkerChannel = {
    identity: { callerName, callerType: "builder" },
    send: (m) => sent.push(m),
    onMessage: (cb) => (onMessage = cb),
    onClose: (cb) => (onClose = cb),
    close: (reason) => {
      closed.push(reason);
      onClose?.(reason);
    },
  };
  return {
    channel,
    sent,
    closed,
    emit: (raw: unknown) => onMessage?.(raw),
    drop: () => onClose?.("closed"),
  };
}

/** Let the fire-and-forget create settle. */
async function settle() {
  for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

function spawned(agentName = "builder-fri-1") {
  const token = mintWorkerToken({ callerName: agentName, callerType: "builder" });
  const runtime = makeContainerRuntime(cfg());
  return { token, handle: runtime.spawn(spawnRequest(token)) };
}

describe("creating the container", () => {
  it("asks for a task id and a FOUR-KEY env, never a container spec", async () => {
    // What keeps the broker a narrow seam rather than the Docker socket with
    // extra steps is that the caller does not describe the container. If this
    // request ever grows an Image, Mounts or HostConfig, that property is gone.
    spawned();
    await settle();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/builders");
    const body = calls[0]!.body as { taskId: string; env: Record<string, string> };
    expect(body.taskId).toBe("builder-fri-1");
    expect(Object.keys(body.env).sort()).toEqual([
      "FRIDAY_AGENT_NAME",
      "FRIDAY_DAEMON_URL",
      "FRIDAY_TASK_ID",
      "FRIDAY_WORKER_TOKEN",
    ]);
    expect(Object.keys(body)).toEqual(["taskId", "env"]);
  });

  it("does not leak the daemon's own environment into the request", async () => {
    // The spawn request carries the FULL daemon process.env (deliberately —
    // FRI-2012), which includes DATABASE_URL. The broker's allowlist would
    // drop it, but the daemon should not be sending it to be dropped.
    spawned();
    await settle();
    expect(JSON.stringify(calls[0]!.body)).not.toContain("postgres://secret");
  });

  it("reclaims a container the broker still owns from a dead daemon", async () => {
    // 409 means a previous container for this assignment outlived its daemon.
    // Reattaching is wrong — its filesystem state is unknown and its channel
    // is gone — so it is removed and recreated. The volume survives.
    statusQueue = [409];
    spawned();
    for (let i = 0; i < 40 && calls.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /builders",
      "DELETE /builders/builder-fri-1",
      "POST /builders",
    ]);
  });

  it("reports a failed create as BOTH an error and an exit", async () => {
    // An error alone would leave lifecycle.ts holding a LiveWorker nothing
    // ever reaps — the fork path unwinds on exit, not on error.
    statusQueue = [500, 500];
    const { handle } = spawned();
    const onError = vi.fn();
    const onExit = vi.fn();
    handle.onError(onError);
    handle.onExit(onExit);
    for (let i = 0; i < 40 && onExit.mock.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(onError).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    await expect(handle.isAlive()).resolves.toBe(false);
  });

  it("refuses to spawn without a token, because nothing could recognise it", () => {
    const runtime = makeContainerRuntime(cfg());
    expect(() => runtime.spawn(spawnRequest("not-a-minted-token"))).toThrow(
      /requires FRIDAY_WORKER_TOKEN/,
    );
  });
});

describe("pairing the channel with the handle", () => {
  it("queues commands sent before the worker dials back, then flushes in order", async () => {
    // `spawn` is synchronous and creating a container is not, so the daemon
    // can send `start` before the container exists. Dropping it would lose
    // the turn that caused the fork.
    const { handle } = spawned();
    handle.send({ type: "start" });
    handle.send({ type: "prompt" });
    const ch = fakeChannel("builder-fri-1");
    expect(ch.sent).toHaveLength(0);
    acceptChannel(ch.channel);
    expect(ch.sent).toEqual([{ type: "start" }, { type: "prompt" }]);
    handle.send({ type: "abort" });
    expect(ch.sent).toHaveLength(3);
  });

  it("identifies the worker by its TOKEN-derived name, not anything it claims", async () => {
    // The correlation key. A channel is authorised by the per-worker token and
    // its identity is resolved from that token, so a container cannot dial in
    // as another agent without holding that agent's token.
    spawned("builder-fri-1");
    const wrong = fakeChannel("builder-fri-2");
    acceptChannel(wrong.channel);
    expect(wrong.closed).toEqual(["no worker expecting a channel"]);
  });

  it("keeps the first channel when a second arrives for the same worker", async () => {
    const { handle } = spawned();
    const first = fakeChannel("builder-fri-1");
    const second = fakeChannel("builder-fri-1");
    acceptChannel(first.channel);
    acceptChannel(second.channel);
    expect(second.closed).toEqual(["already attached"]);
    // The turn in flight is on the first one, so that is where traffic goes.
    handle.send({ type: "abort" });
    expect(first.sent).toEqual([{ type: "abort" }]);
    expect(second.sent).toEqual([]);
  });

  it("fires onceMessage on the first event, which is the ready handshake", async () => {
    const { handle } = spawned();
    const ready = vi.fn();
    handle.onceMessage(ready);
    const ch = fakeChannel("builder-fri-1");
    acceptChannel(ch.channel);
    ch.emit({ type: "ready" });
    ch.emit({ type: "block-delta" });
    expect(ready).toHaveBeenCalledOnce();
  });

  it("delivers every event to onMessage listeners", async () => {
    const { handle } = spawned();
    const seen: unknown[] = [];
    handle.onMessage((m) => seen.push(m));
    const ch = fakeChannel("builder-fri-1");
    acceptChannel(ch.channel);
    ch.emit({ type: "ready" });
    ch.emit({ type: "turn-complete" });
    expect(seen).toEqual([{ type: "ready" }, { type: "turn-complete" }]);
  });

  it("surfaces a DROPPED channel as an exit — the fail-the-turn decision", async () => {
    // The channel's own design says a drop is terminal: no replay, no resume.
    // Reaching the daemon as an exit is what makes that true, because the exit
    // path is what fails the turn and reaps the worker.
    const { handle } = spawned();
    const onExit = vi.fn();
    handle.onExit(onExit);
    const ch = fakeChannel("builder-fri-1");
    acceptChannel(ch.channel);
    ch.drop();
    expect(onExit).toHaveBeenCalledOnce();
    await expect(handle.isAlive()).resolves.toBe(false);
    // ...and the name is free again, so a respawn can claim its own channel.
    const after = fakeChannel("builder-fri-1");
    acceptChannel(after.channel);
    expect(after.closed).toEqual(["no worker expecting a channel"]);
  });
});

describe("stopping and inspecting", () => {
  it("maps SIGKILL to no grace period and SIGTERM to the broker's default", async () => {
    // The abort path's forced kill fires at 500ms. A fixed 10s container stop
    // would make that deadline meaningless, so urgency has to cross the
    // boundary somehow — and a grace period is the only honest form it takes.
    const a = spawned("agent-a");
    await settle();
    await a.handle.terminate("SIGKILL");
    expect(calls.at(-1)!.path).toBe("/builders/agent-a?grace=0");

    calls.length = 0;
    __resetContainerRuntimeForTest();
    const b = spawned("agent-b");
    await settle();
    await b.handle.terminate("SIGTERM");
    expect(calls.at(-1)!.path).toBe("/builders/agent-b");
  });

  it("exits even when the broker refuses the teardown", async () => {
    // Otherwise a broker hiccup leaves a worker the daemon believes is alive
    // and will never hear from again.
    const { handle } = spawned();
    await settle();
    statusQueue = [500];
    const onExit = vi.fn();
    handle.onExit(onExit);
    await handle.terminate("SIGTERM");
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("reads liveness from the broker once the container exists", async () => {
    const { handle } = spawned();
    await settle();
    await expect(handle.isAlive()).resolves.toBe(true);
    running = false;
    await expect(handle.isAlive()).resolves.toBe(false);
  });

  it("calls a container alive while it is still being created", async () => {
    // A race the daemon itself caused; concluding "dead" would let the
    // force-kill path reap a worker that is only slow to start.
    const { handle } = spawned();
    await expect(handle.isAlive()).resolves.toBe(true);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("treats an unreachable broker as UNKNOWN rather than dead", async () => {
    const { handle } = spawned();
    await settle();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    // Wrong in the safe direction: a transient broker failure must not be the
    // reason a live turn is force-killed.
    await expect(handle.isAlive()).resolves.toBe(true);
    broker = createServer(() => {});
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  });

  it("asks the WORKER to reap descendants, and admits it cannot count them", async () => {
    // No shared pid namespace, so `pgrep -g` cannot reach in. The worker is
    // inside the group it needs to signal, so this is a command rather than a
    // syscall — which also keeps the T+0 abort off a broker round-trip.
    const { handle } = spawned();
    const ch = fakeChannel("builder-fri-1");
    acceptChannel(ch.channel);
    await expect(handle.terminateDescendants("SIGTERM")).resolves.toBeNull();
    expect(ch.sent).toEqual([{ type: "kill-descendants", signal: "SIGTERM" }]);
  });
});

describe("configuration", () => {
  it("needs all three values, because two of them are useless alone", () => {
    const full = {
      FRIDAY_BUILDER_BROKER_URL: "http://broker:7612/",
      FRIDAY_BUILDER_BROKER_TOKEN: "t",
      FRIDAY_DAEMON_URL: "http://friday:7611",
    };
    expect(resolveBrokerConfig(full)).toEqual({
      url: "http://broker:7612",
      token: "t",
      daemonUrl: "http://friday:7611",
    });
    for (const k of Object.keys(full)) {
      const partial = { ...full, [k]: "" };
      expect(resolveBrokerConfig(partial), k).toBeNull();
    }
  });

  it("stays on the local runtime unless the broker is configured", () => {
    // Container mode is opt-in by configuration, not by platform — a laptop
    // and a single-container Deployment both keep the process runtime.
    expect(resolveWorkerRuntime({})).toBe(localProcessRuntime);
    expect(
      resolveWorkerRuntime({
        FRIDAY_BUILDER_BROKER_URL: "http://broker:7612",
        FRIDAY_BUILDER_BROKER_TOKEN: "t",
        FRIDAY_DAEMON_URL: "http://friday:7611",
      }),
    ).not.toBe(localProcessRuntime);
  });

  it("derives a task id the broker will accept", () => {
    // The broker validates /^[a-z0-9][a-z0-9_.-]{0,62}$/ and rejects anything
    // else, so an agent name with a capital or a space must not become a
    // container that cannot be created.
    const shapes = ["Builder FRI-2038", "---weird---", "x".repeat(200), "agent.1_2-3"];
    for (const name of shapes) {
      expect(taskIdForAgent(name), name).toMatch(/^[a-z0-9][a-z0-9_.-]{0,62}$/);
    }
    // Deterministic: the volume holds the worktree, and a restarted worker has
    // to reattach the same /workspace rather than start from an empty one.
    expect(taskIdForAgent("builder-fri-1")).toBe(taskIdForAgent("builder-fri-1"));
  });
});
