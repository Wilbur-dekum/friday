import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { WORKER_CHANNEL_PATH } from "../api/worker-channel.js";
import { killPgrpDescendants } from "./worker-runtime.js";
import type { WorkerCommand, WorkerEvent } from "./worker-protocol.js";

/**
 * How a worker talks to the daemon (FRI-2038).
 *
 * `process.send` when there is a parent process, a WebSocket to the
 * worker-facing listener when there is not. The worker should not know which —
 * `emit` and the command handler are the same code either way — so the two
 * live behind this, chosen by what the environment actually offers.
 *
 * The worker DIALS OUT. It has no listener of its own and should not grow one:
 * a container running untrusted repository code with an inbound port is a
 * surface, and the daemon already has the listener (FRI-2072) plus the only
 * credential that can authorise the connection.
 *
 * ## A lost channel ends the process
 *
 * Nothing can hear the worker any more. Events would pile into an outbox that
 * never drains, the turn's blocks would stop at whatever reached Postgres, and
 * the daemon has already decided to treat the drop as terminal rather than
 * resume through it. Exiting is both halves of that: the daemon sees the
 * channel close and fails the turn, and the container stops instead of
 * lingering with a worker nobody is driving.
 *
 * Logging here goes to stderr, not `logger` — a container worker's stderr is
 * its container log, and a transport that is broken cannot report that it is
 * broken over the transport.
 */

/**
 * The channel URL for a daemon base URL.
 *
 * `FRIDAY_DAEMON_URL` is http(s) because every other thing the worker asks the
 * daemon for is an HTTP request to the same listener; only this one is a
 * WebSocket, so the scheme is mapped here rather than configured twice.
 */
export function channelUrlFor(daemonUrl: string): string {
  const url = new URL(WORKER_CHANNEL_PATH, daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export interface WorkerTransport {
  /** How the worker reaches the daemon, for the boot log line. */
  readonly kind: "ipc" | "channel";
  send(e: WorkerEvent): void;
  onCommand(cb: (msg: WorkerCommand) => void): void;
}

class IpcTransport implements WorkerTransport {
  readonly kind = "ipc";

  send(e: WorkerEvent): void {
    if (process.send) process.send(e);
  }

  onCommand(cb: (msg: WorkerCommand) => void): void {
    process.on("message", (msg) => cb(msg as WorkerCommand));
  }
}

class ChannelTransport implements WorkerTransport {
  readonly kind = "channel";
  private ws: WebSocket;
  private open = false;
  /** Events produced before the socket finished connecting. */
  private outbox: WorkerEvent[] = [];
  private commandCb: ((msg: WorkerCommand) => void) | undefined;
  /** Commands that arrived before the worker registered its handler. */
  private inbox: WorkerCommand[] = [];

  constructor(daemonUrl: string, token: string) {
    this.ws = new WebSocket(channelUrlFor(daemonUrl), {
      headers: { authorization: `Bearer ${token}` },
    });

    this.ws.on("open", () => {
      this.open = true;
      for (const e of this.outbox.splice(0)) this.rawSend(e);
    });
    this.ws.on("message", (data) => {
      let parsed: WorkerCommand;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      } catch {
        process.stderr.write("worker-transport: unparseable command frame\n");
        return;
      }
      // The one command the daemon cannot execute itself: it has no pid
      // namespace in common with this worker's tool subprocesses, so it asks.
      if ((parsed as { type?: string }).type === "kill-descendants") {
        killOwnDescendants((parsed as { signal?: "SIGTERM" | "SIGKILL" }).signal ?? "SIGTERM");
        return;
      }
      if (this.commandCb) this.commandCb(parsed);
      else this.inbox.push(parsed);
    });
    this.ws.on("close", () => this.die("closed"));
    this.ws.on("error", (err) => this.die(err instanceof Error ? err.message : String(err)));
  }

  private die(reason: string): never | void {
    process.stderr.write(`worker-transport: channel ${reason}; exiting\n`);
    process.exit(1);
  }

  /**
   * Drop the socket WITHOUT the exit that losing the channel means.
   *
   * Test-only, and the production path has no equivalent on purpose: a worker
   * that loses its channel must exit, so there is nothing for a deliberate
   * shutdown to do. Tests need it because a transport dialed and discarded is
   * still mid-handshake, and the pending upgrade errors once the test's server
   * closes — which is `die` doing exactly its job, into a runner that is not
   * a worker. Muting `process.exit` for the window instead is what this file
   * used to do, and it lost the race: the error can arrive after `afterEach`
   * has restored the real one, and then the exit takes the whole suite down
   * with 1493 tests passing.
   */
  __disposeForTest(): void {
    this.ws.removeAllListeners();
    // `terminate` on a socket that never finished connecting emits
    // "WebSocket was closed before the connection was established" — and with
    // no listener left, `ws` raises that as an uncaught exception, which is
    // the same failure wearing a different hat. Swallow it deliberately.
    this.ws.on("error", () => {});
    this.ws.terminate();
  }

  private rawSend(e: WorkerEvent): void {
    try {
      this.ws.send(JSON.stringify(e));
    } catch (err) {
      process.stderr.write(
        `worker-transport: send failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  send(e: WorkerEvent): void {
    // `ready` is emitted at module load, before the socket can possibly be
    // open, so queueing is the normal path rather than an edge case.
    if (this.open) this.rawSend(e);
    else this.outbox.push(e);
  }

  onCommand(cb: (msg: WorkerCommand) => void): void {
    this.commandCb = cb;
    for (const msg of this.inbox.splice(0)) cb(msg);
  }
}

/**
 * SIGTERM this worker's tool subprocesses, leaving the worker running.
 *
 * The container-side half of `terminateDescendants`. `killPgrpDescendants` is
 * the same primitive the local runtime uses — it just runs here, inside the
 * namespace where the pids mean something.
 *
 * `ps -o pgid=` rather than assuming `pid === pgid`: the worker leads its own
 * group when the daemon spawns it detached, but inside a container it is
 * started by an entrypoint and inherits one.
 */
function killOwnDescendants(signal: "SIGTERM" | "SIGKILL"): void {
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
  const pgid = Number.parseInt((out.stdout ?? "").trim(), 10);
  if (!Number.isFinite(pgid) || pgid <= 1) {
    process.stderr.write("worker-transport: cannot resolve own pgid; no descendants killed\n");
    return;
  }
  const killed = killPgrpDescendants(pgid, process.pid, signal);
  process.stderr.write(`worker-transport: killed ${killed} descendants with ${signal}\n`);
}

/**
 * Pick the transport.
 *
 * IPC first and unconditionally when it exists: a forked worker always has a
 * parent, and preferring the channel there would move the daily-driver path
 * onto a network hop for nothing. The channel needs both the daemon's URL and
 * this worker's token, because either alone cannot connect.
 */
export function resolveWorkerTransport(env: NodeJS.ProcessEnv = process.env): WorkerTransport {
  if (process.send) return new IpcTransport();
  const daemonUrl = env.FRIDAY_DAEMON_URL?.trim();
  const token = env.FRIDAY_WORKER_TOKEN?.trim();
  if (!daemonUrl || !token) {
    // Neither a parent nor a way home. Continuing would run a whole turn whose
    // every event goes nowhere, which is worse than failing at startup.
    throw new Error(
      "worker has no IPC channel and no FRIDAY_DAEMON_URL + FRIDAY_WORKER_TOKEN to dial",
    );
  }
  return new ChannelTransport(daemonUrl, token);
}

/**
 * Tear down a transport a test dialed. No-op for the IPC transport, which
 * holds no socket.
 */
export function __disposeTransportForTest(t: WorkerTransport): void {
  if ("__disposeForTest" in t && typeof t.__disposeForTest === "function") {
    (t as { __disposeForTest: () => void }).__disposeForTest();
  }
}
