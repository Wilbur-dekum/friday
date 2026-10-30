import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../log.js";
import type { WorkerIdentity } from "../agent/worker-tokens.js";
import { workerFromRequest } from "./worker-listener.js";

/**
 * The worker command channel (FRI-2038).
 *
 * Node IPC is what `send`/`onMessage` ride today, and a container has none. So
 * the channel inverts: the worker DIALS OUT to the daemon's worker-facing
 * listener and holds one WebSocket for the container's life. Commands go down
 * it, events come up it.
 *
 * ## Why one bidirectional connection rather than SSE-down/POST-up
 *
 * Ordering. IPC gives it structurally, and there is no general sequence number
 * on the wire — only `blockIndex`, on one message type. Splitting the
 * up-channel across separate POSTs would mean inventing sequencing for
 * `block-delta`, the hot path, in a codebase that already watches for
 * `block.seq-skew`. A single connection keeps that property for free, and
 * makes `abort` immediate rather than waiting on a poll in flight — which
 * matters because descendants are SIGTERMed at T+0 and the forced-abort path
 * fires at 500ms.
 *
 * It also reuses the FRI-2072 listener, so there is no new inbound surface and
 * no second auth story: the same per-worker token, checked at upgrade.
 *
 * ## A dropped channel FAILS THE TURN
 *
 * Deliberately, and it is the decision most worth stating. Mid-turn
 * resumption would mean reconciling partially-written blocks against a worker
 * whose own view may have moved on — a half-resumed turn is worse than a clean
 * failure, and the repo already has machinery for the clean one (the wedge
 * detector handles "worker produced nothing", and `block.seq-skew` exists
 * because ordering bugs here are historically subtle).
 *
 * So: no reconnection, no replay buffer, no resume cursor. The channel closing
 * is a terminal event for that worker, and the daemon tears it down.
 */

/** A worker's live command channel. */
export interface WorkerChannel {
  readonly identity: WorkerIdentity;
  /** Push a command down. No-op once closed — teardown is already underway. */
  send(msg: unknown): void;
  /** Register the handler for events coming up. */
  onMessage(cb: (raw: unknown) => void): void;
  /** Fires once, when the channel closes for any reason. */
  onClose(cb: (reason: string) => void): void;
  close(reason: string): void;
}

class WsWorkerChannel implements WorkerChannel {
  private messageCb: ((raw: unknown) => void) | undefined;
  private closeCbs: Array<(reason: string) => void> = [];
  private closed = false;

  constructor(
    readonly identity: WorkerIdentity,
    private readonly ws: WebSocket,
  ) {
    ws.on("message", (data) => {
      // One JSON object per frame. A frame that does not parse is dropped with
      // a log rather than crashing the daemon on a malformed worker — but it
      // is NOT silent, because a worker emitting garbage is a real symptom.
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      } catch {
        logger.log("warn", "worker.channel.unparseable-frame", {
          agent: identity.callerName,
        });
        return;
      }
      this.messageCb?.(parsed);
    });
    ws.on("close", () => this.fire("closed"));
    ws.on("error", (err) => {
      logger.log("warn", "worker.channel.error", {
        agent: identity.callerName,
        message: err instanceof Error ? err.message : String(err),
      });
      // `ws` emits error AND then close, so without the once-guard in `fire`
      // a single failure would run teardown twice.
      this.fire("error");
    });
  }

  send(msg: unknown): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (raw: unknown) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (reason: string) => void): void {
    if (this.closed) {
      cb("closed");
      return;
    }
    this.closeCbs.push(cb);
  }

  close(reason: string): void {
    try {
      this.ws.close(1000, reason.slice(0, 120));
    } catch {
      // Already gone; the socket's own close event is all that is left.
    }
    // A deliberate close is still a close. `onClose` says "for any reason",
    // and a caller that only hears about the unexpected ones has to handle
    // teardown in two places — which is how one of them gets forgotten. The
    // socket's own close event lands a moment later; `fire` is once-only, so
    // it is swallowed.
    this.fire(reason);
  }

  /**
   * Exactly-once terminal notification. Both the flag and consuming the
   * callback list enforce that, and each is load-bearing for its own reason:
   * the flag is what `send` and a late `onClose` read, and splicing stops the
   * channel holding callbacks alive after the worker is gone.
   */
  private fire(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs.splice(0)) cb(reason);
  }
}

/** The path a worker dials. */
export const WORKER_CHANNEL_PATH = "/api/worker/channel";

type OnChannel = (channel: WorkerChannel) => void;

/**
 * Attach the channel to an existing HTTP server — the worker-facing listener,
 * never the loopback one. `noServer` so the upgrade is authorised BEFORE the
 * WebSocket handshake completes: an unauthenticated socket should never exist,
 * not even briefly.
 */
export function attachWorkerChannel(
  server: {
    on(event: "upgrade", cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  },
  onChannel: OnChannel,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://worker-channel");
    if (url.pathname !== WORKER_CHANNEL_PATH) {
      socket.destroy();
      return;
    }
    // Same per-worker token as every other worker-facing request. The shared
    // daemon secret is deliberately not accepted — it is readable by any
    // builder in the Deployment container (FRI-2062), so across a network
    // boundary it identifies nothing.
    const identity = workerFromRequest(req);
    if (!identity) {
      // A bare destroy would look like a network fault. Answer, then close, so
      // a misconfigured worker reports something actionable.
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      logger.log("warn", "worker.channel.unauthorized", { path: url.pathname });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.log("info", "worker.channel.open", {
        agent: identity.callerName,
        type: identity.callerType,
      });
      onChannel(new WsWorkerChannel(identity, ws));
    });
  });

  return wss;
}
