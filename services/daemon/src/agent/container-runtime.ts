import { logger } from "../log.js";
import { resolveWorkerToken, type WorkerIdentity } from "./worker-tokens.js";
import type { WorkerChannel } from "../api/worker-channel.js";
import {
  localProcessRuntime,
  type WorkerHandle,
  type WorkerRuntime,
  type WorkerSpawnRequest,
} from "./worker-runtime.js";

/**
 * A worker that runs in its own container (FRI-2038).
 *
 * The same five capabilities the local runtime implements with a detached
 * process group, implemented instead with two things the Deployment already
 * has: the builder broker (create, inspect, stop) and the worker command
 * channel (talk, listen, hear it die). Nothing here knows about Docker — the
 * broker owns the privileged seam, and that is the point of it.
 *
 * ## Correlation: the token already answers it
 *
 * The daemon creates a container and then, moments later, a WebSocket arrives.
 * Pairing them needs a key, and the obvious candidates are bad: a container id
 * the worker does not know, a task id that is not secret, a new nonce that
 * means a second credential to mint and plumb.
 *
 * The per-worker token already does it. It is minted before the env is
 * assembled (lifecycle.ts), ships to the container, and is what authorises the
 * channel upgrade — so `channel.identity.callerName` is derived from the same
 * mint the spawn request carries, and `resolveWorkerToken(env.FRIDAY_WORKER_TOKEN)`
 * recovers it daemon-side with no extra wire field. A worker cannot present
 * another worker's identity without its token, and one live worker per agent
 * name is already a registry invariant.
 *
 * ## `spawn` stays synchronous
 *
 * The seam is sync and creating a container is not, so the handle is returned
 * before the container exists: commands queue in `outbox` and flush when the
 * channel attaches. The alternative — making the seam async — would have put
 * `await` in front of the whole fork path for the benefit of a runtime that
 * still could not promise the worker was *ready* (that is the first-message
 * handshake, which is async in both runtimes anyway).
 */

/** Where the broker lives, and the secret for it. */
interface BrokerConfig {
  url: string;
  token: string;
  /** The daemon URL the CONTAINER should dial — its view, not the daemon's. */
  daemonUrl: string;
}

export function resolveBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig | null {
  const url = env.FRIDAY_BUILDER_BROKER_URL?.trim();
  const token = env.FRIDAY_BUILDER_BROKER_TOKEN?.trim();
  const daemonUrl = env.FRIDAY_DAEMON_URL?.trim();
  if (!url || !token || !daemonUrl) return null;
  return { url: url.replace(/\/+$/, ""), token, daemonUrl };
}

/**
 * A container and volume name derived from the agent name.
 *
 * Deterministic, because the volume holds the worktree and FRI-2038 bounds it
 * to one assignment — a restarted worker must reattach the same `/workspace`,
 * not start from an empty one. The broker's own `validTaskId` is the authority
 * on the shape; this only has to produce something inside it.
 */
export function taskIdForAgent(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
  return slug || "worker";
}

/** Synthetic pids. Nothing downstream reads them except logs and equality. */
let pidSeq = 0;

class ContainerWorkerHandle implements WorkerHandle {
  readonly pid: number;
  private channel: WorkerChannel | null = null;
  /** Commands sent before the worker dialled back. */
  private outbox: unknown[] = [];
  private messageCbs: Array<(raw: unknown) => void> = [];
  private onceMessageCbs: Array<() => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private onceExitCbs: Array<() => void> = [];
  private sawFirstMessage = false;
  private exited = false;
  private created = false;

  constructor(
    readonly identity: WorkerIdentity,
    readonly taskId: string,
    private readonly broker: BrokerConfig,
  ) {
    this.pid = ++pidSeq;
  }

  /** Create the container. Called once, fire-and-forget, right after spawn. */
  async start(req: WorkerSpawnRequest): Promise<void> {
    try {
      await this.create(req);
      this.created = true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.log("error", "worker.container.create.fail", {
        agent: this.identity.callerName,
        taskId: this.taskId,
        message: e.message,
      });
      // Both, deliberately. `onError` is how the daemon logs the cause;
      // `onExit` is what actually unwinds the fork — a failed create that only
      // reported an error would leave a LiveWorker nothing ever reaps.
      for (const cb of this.errorCbs) cb(e);
      this.fireExit(null, null);
    }
  }

  private async create(req: WorkerSpawnRequest): Promise<void> {
    const body = {
      taskId: this.taskId,
      // The broker filters this through its own allowlist; passing more would
      // be filtered out, not honoured. Only what the worker needs to reach
      // home and name itself.
      env: {
        FRIDAY_WORKER_TOKEN: req.env.FRIDAY_WORKER_TOKEN ?? "",
        FRIDAY_DAEMON_URL: this.broker.daemonUrl,
        FRIDAY_AGENT_NAME: this.identity.callerName,
        FRIDAY_TASK_ID: this.taskId,
      },
    };
    let res = await this.brokerFetch("POST", "/builders", body);
    if (res.status === 409) {
      // A previous container for this assignment outlived its daemon (a crash,
      // not a teardown). Reclaiming it is wrong — its filesystem state is
      // unknown and its channel is gone — so remove and recreate. The volume
      // survives, which is the part that had to.
      logger.log("warn", "worker.container.stale-reclaim", {
        agent: this.identity.callerName,
        taskId: this.taskId,
      });
      await this.brokerFetch("DELETE", `/builders/${this.taskId}`);
      res = await this.brokerFetch("POST", "/builders", body);
    }
    if (!res.ok) throw new Error(`broker create -> ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { containerId?: string };
    logger.log("info", "worker.container.created", {
      agent: this.identity.callerName,
      taskId: this.taskId,
      containerId: json.containerId?.slice(0, 12),
      pid: this.pid,
    });
  }

  private brokerFetch(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.broker.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.broker.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Called when the worker dials back. Exactly one channel per handle. */
  attach(channel: WorkerChannel): void {
    if (this.channel) {
      // Not a replacement. A second channel for a live handle is either a
      // stale container or something using a token it should not have, and
      // either way the one already carrying the turn is the one to keep.
      logger.log("warn", "worker.container.duplicate-channel", {
        agent: this.identity.callerName,
        taskId: this.taskId,
      });
      channel.close("already attached");
      return;
    }
    this.channel = channel;
    channel.onMessage((raw) => {
      if (!this.sawFirstMessage) {
        this.sawFirstMessage = true;
        for (const cb of this.onceMessageCbs.splice(0)) cb();
      }
      for (const cb of this.messageCbs) cb(raw);
    });
    channel.onClose((reason) => {
      logger.log("info", "worker.container.channel-closed", {
        agent: this.identity.callerName,
        taskId: this.taskId,
        reason,
      });
      // The fail-the-turn decision from the channel's own design: a dropped
      // channel is terminal, so it reaches the daemon as an exit rather than
      // as something to reconnect through.
      this.fireExit(null, null);
    });
    for (const msg of this.outbox.splice(0)) channel.send(msg);
  }

  private fireExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    pending.delete(this.identity.callerName);
    for (const cb of this.exitCbs) cb(code, signal);
    for (const cb of this.onceExitCbs.splice(0)) cb();
  }

  send(msg: unknown): void {
    if (this.exited) return;
    if (this.channel) this.channel.send(msg);
    else this.outbox.push(msg);
  }

  onMessage(cb: (raw: unknown) => void): void {
    this.messageCbs.push(cb);
  }

  onceMessage(cb: () => void): void {
    if (this.sawFirstMessage) {
      cb();
      return;
    }
    this.onceMessageCbs.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCbs.push(cb);
  }

  onceExit(cb: () => void): void {
    if (this.exited) {
      cb();
      return;
    }
    this.onceExitCbs.push(cb);
  }

  async isAlive(): Promise<boolean> {
    if (this.exited) return false;
    // Still being created: alive, because it is on its way up and the
    // force-kill path must not conclude otherwise from a race it caused.
    if (!this.created) return true;
    try {
      const res = await this.brokerFetch("GET", `/builders/${this.taskId}`);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`broker inspect -> ${res.status}`);
      return Boolean(((await res.json()) as { running?: boolean }).running);
    } catch (err) {
      // Unknown, not dead. Reporting dead on a transient broker failure would
      // hand the force-kill path a false positive, which is the one direction
      // where being wrong costs a running turn.
      logger.log("warn", "worker.container.inspect.fail", {
        agent: this.identity.callerName,
        taskId: this.taskId,
        message: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  async terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    // The broker's grace period is the signal's only expression here: SIGTERM
    // gets the default stop timeout, SIGKILL gets none. A container has no
    // process group to signal from outside, and pretending otherwise would be
    // a mapping that reads precise and is not.
    const grace = signal === "SIGKILL" ? 0 : undefined;
    const q = grace === undefined ? "" : `?grace=${grace}`;
    try {
      const res = await this.brokerFetch("DELETE", `/builders/${this.taskId}${q}`);
      if (!res.ok) {
        logger.log("warn", "worker.container.terminate.fail", {
          agent: this.identity.callerName,
          taskId: this.taskId,
          status: res.status,
        });
      }
    } finally {
      this.channel?.close(`terminate ${signal}`);
      this.fireExit(null, signal);
    }
  }

  terminateDescendants(signal: "SIGTERM" | "SIGKILL"): Promise<number | null> {
    // Inside the container, so the daemon cannot do it: no shared pid
    // namespace, no `pgrep -g` reaching in. The worker can — it is in the
    // group it needs to signal — so this becomes a command rather than a
    // syscall, which also keeps the T+0 abort fire-and-forget instead of
    // waiting on a broker round-trip.
    //
    // `null`, not 0: the count is not observable from here, and 0 would read
    // in `worker.abort.descendants-killed` as "nothing was running".
    this.send({ type: "kill-descendants", signal });
    return Promise.resolve(null);
  }
}

/**
 * Handles waiting for, or holding, a channel — keyed by agent name.
 *
 * Module scope because the HTTP upgrade has no path to the runtime instance;
 * `acceptChannel` is what `startServer` hands the channel to. An entry is
 * removed when the worker exits, so a name is never ambiguous for long.
 */
const pending = new Map<string, ContainerWorkerHandle>();

/**
 * Pair an arriving channel with the handle that is expecting it.
 *
 * A channel with no handle is closed rather than kept: the daemon that created
 * that container is gone (restarted), so there is nothing to attach it to and
 * leaving it open would hold a worker that no one is driving.
 */
export function acceptChannel(channel: WorkerChannel): void {
  const handle = pending.get(channel.identity.callerName);
  if (!handle) {
    logger.log("warn", "worker.container.channel-unexpected", {
      agent: channel.identity.callerName,
    });
    channel.close("no worker expecting a channel");
    return;
  }
  handle.attach(channel);
}

/** Test seam: the module map is deliberately not exported. */
export function __resetContainerRuntimeForTest(): void {
  pending.clear();
}

export function makeContainerRuntime(broker: BrokerConfig): WorkerRuntime {
  return {
    spawn(req: WorkerSpawnRequest): WorkerHandle {
      const identity = resolveWorkerToken(req.env.FRIDAY_WORKER_TOKEN);
      if (!identity) {
        // Unreachable through lifecycle.ts, which mints before assembling env.
        // Loud rather than defensive: without the token there is no identity,
        // so there is no way to recognise the worker when it dials back.
        throw new Error("container runtime requires FRIDAY_WORKER_TOKEN in the spawn env");
      }
      const handle = new ContainerWorkerHandle(
        identity,
        taskIdForAgent(identity.callerName),
        broker,
      );
      // Registered BEFORE the create, because the container can dial back
      // faster than the create's own response arrives.
      pending.set(identity.callerName, handle);
      void handle.start(req);
      return handle;
    },
  };
}

/**
 * Whether workers run as containers.
 *
 * The same answer `resolveWorkerRuntime` acts on, exported because the spawn
 * route needs it too — it decides who owns a Builder's workspace. One
 * predicate rather than two readings of the environment, so the runtime and
 * the workspace can never disagree about which world they are in.
 */
export function containerModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBrokerConfig(env) !== null;
}

/**
 * Which runtime this daemon uses.
 *
 * Container mode is opt-in by configuration, not by platform: a laptop and a
 * single-container Deployment both keep the local runtime, and neither has a
 * broker to talk to. The same shape as `FRIDAY_WORKER_LISTEN` (FRI-2072),
 * which container mode also requires — a worker that cannot reach the daemon
 * has nothing to dial.
 */
export function resolveWorkerRuntime(env: NodeJS.ProcessEnv = process.env): WorkerRuntime {
  const broker = resolveBrokerConfig(env);
  if (!broker) return localProcessRuntime;
  logger.log("warn", "worker.runtime.container", {
    broker: broker.url,
    daemonUrl: broker.daemonUrl,
  });
  return makeContainerRuntime(broker);
}
