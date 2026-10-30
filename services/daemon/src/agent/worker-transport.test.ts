import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelUrlFor, resolveWorkerTransport, type WorkerTransport } from "./worker-transport.js";
import { attachWorkerChannel, type WorkerChannel } from "../api/worker-channel.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "./worker-tokens.js";
import type { WorkerCommand, WorkerEvent } from "./worker-protocol.js";
import { killPgrpDescendants } from "./worker-runtime.js";

/**
 * The kill primitive is STUBBED, and that is not squeamishness. Running it for
 * real signalled vitest's own process group and took the runner down with
 * SIGTERM — which is precisely the behaviour under test, just pointed at the
 * wrong namespace. In a container it has only the worker's tool subprocesses
 * to reach; here it has everything.
 */
vi.mock("./worker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-runtime.js")>()),
  killPgrpDescendants: vi.fn(() => 3),
}));

/**
 * FRI-2038, the worker's half. A containerised worker has no parent process,
 * so `emit` and the command handler ride a WebSocket it dials to the daemon.
 *
 * These run the REAL daemon-side `attachWorkerChannel` against the real
 * client, because the things worth checking are the ones a double would
 * paper over: that `ready` — emitted at module load, before any socket can be
 * open — still arrives, and that the two ends agree on framing.
 */

let server: Server;
let channels: WorkerChannel[];
let daemonUrl: string;
/** `process.send` presence is what picks the transport, so it is controlled. */
let origSend: typeof process.send;
/**
 * `process.exit` is stubbed for every case, not just the ones that assert on
 * it: a transport opened by an earlier test outlives its server, and when
 * `afterEach` closes that server the transport correctly tries to exit. That
 * is the behaviour under test — it just must not take the runner with it.
 */
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  __resetWorkerTokensForTest();
  channels = [];
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  origSend = process.send;
  delete (process as { send?: unknown }).send;
  server = createServer((_req, res) => res.writeHead(404).end());
  attachWorkerChannel(server, (c) => channels.push(c));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  daemonUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  process.send = origSend;
  // `server.close` waits for live connections, and the worker's channel is one
  // — without this the hook times out rather than the test failing.
  for (const c of channels) c.close("test over");
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetWorkerTokensForTest();
  vi.restoreAllMocks();
});

function dial(): WorkerTransport {
  const token = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
  return resolveWorkerTransport({ FRIDAY_DAEMON_URL: daemonUrl, FRIDAY_WORKER_TOKEN: token });
}

async function connected(): Promise<WorkerChannel> {
  for (let i = 0; i < 100 && channels.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(channels, "worker never connected").toHaveLength(1);
  return channels[0]!;
}

describe("choosing a transport", () => {
  it("prefers node IPC whenever there is a parent process", () => {
    // The daily driver. Preferring the channel here would put the forked-worker
    // path on a network hop for nothing.
    process.send = (() => true) as typeof process.send;
    expect(
      resolveWorkerTransport({ FRIDAY_DAEMON_URL: daemonUrl, FRIDAY_WORKER_TOKEN: "t" }).kind,
    ).toBe("ipc");
  });

  it("dials the daemon when there is no parent but there is a way home", () => {
    expect(dial().kind).toBe("channel");
  });

  it("refuses to start with neither — a turn whose events go nowhere is worse", () => {
    for (const env of [
      {},
      { FRIDAY_DAEMON_URL: daemonUrl },
      { FRIDAY_WORKER_TOKEN: "t" },
      { FRIDAY_DAEMON_URL: "", FRIDAY_WORKER_TOKEN: "" },
    ]) {
      expect(() => resolveWorkerTransport(env)).toThrow(/no IPC channel/);
    }
  });

  it("maps the daemon's http URL onto the channel's ws scheme", () => {
    expect(channelUrlFor("http://friday:7611")).toBe("ws://friday:7611/api/worker/channel");
    expect(channelUrlFor("https://friday.example")).toBe("wss://friday.example/api/worker/channel");
    // A base URL with a path should not swallow the channel path.
    expect(channelUrlFor("http://friday:7611/")).toBe("ws://friday:7611/api/worker/channel");
  });
});

describe("the channel transport, end to end", () => {
  it("delivers an event emitted BEFORE the socket opened", async () => {
    // `ready` is emitted at worker module load, which is always before the
    // socket can be open — so queueing is the normal path, not an edge case.
    const transport = dial();
    transport.send({ type: "ready" } as WorkerEvent);
    const channel = await connected();
    // Bounded rather than an open promise: when this regresses the event never
    // arrives, and an unbounded wait turns a clear failure into a 20s hook
    // timeout pointing at the wrong line.
    const got = await Promise.race([
      new Promise<unknown>((resolve) => channel.onMessage(resolve)),
      new Promise((resolve) => setTimeout(() => resolve("never arrived"), 1000)),
    ]);
    expect(got).toEqual({ type: "ready" });
  });

  it("carries commands down to the worker's handler", async () => {
    const transport = dial();
    const channel = await connected();
    const seen: WorkerCommand[] = [];
    transport.onCommand((m) => seen.push(m));
    channel.send({ type: "abort" });
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([{ type: "abort" }]);
  });

  it("queues a command that arrives before the worker registers a handler", async () => {
    // The daemon flushes its own outbox the instant the channel attaches, so
    // `start` can land before the worker's module body gets that far.
    const transport = dial();
    const channel = await connected();
    channel.send({ type: "stop" });
    await new Promise((r) => setTimeout(r, 30));
    const seen: WorkerCommand[] = [];
    transport.onCommand((m) => seen.push(m));
    expect(seen).toEqual([{ type: "stop" }]);
  });

  it("handles kill-descendants ITSELF and never shows it to the worker", async () => {
    // It is a transport-level command: the daemon cannot reach into this pid
    // namespace, and the worker's protocol handler has no case for it. Passing
    // it through would land in the `else` of a chain that silently ignores it.
    const transport = dial();
    const channel = await connected();
    const seen: WorkerCommand[] = [];
    transport.onCommand((m) => seen.push(m));
    channel.send({ type: "kill-descendants", signal: "SIGTERM" });
    const killed = vi.mocked(killPgrpDescendants);
    for (let i = 0; i < 100 && killed.mock.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([]);
    // Its OWN group, excluding itself — the worker must survive the abort to
    // emit `turn-complete` cleanly.
    expect(killed).toHaveBeenCalledWith(expect.any(Number), process.pid, "SIGTERM");
  });

  it("EXITS when the channel closes, because nothing can hear it any more", async () => {
    // The other half of the daemon's fail-the-turn decision. A worker that
    // keeps running would pile events into an outbox that never drains, and
    // the container would linger with nobody driving it.
    dial();
    const channel = await connected();
    channel.close("daemon tearing down");
    for (let i = 0; i < 100 && exitSpy.mock.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when the daemon refuses the token rather than retrying forever", async () => {
    resolveWorkerTransport({ FRIDAY_DAEMON_URL: daemonUrl, FRIDAY_WORKER_TOKEN: "never-minted" });
    for (let i = 0; i < 100 && exitSpy.mock.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(channels).toHaveLength(0);
  });
});
