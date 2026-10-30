import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachWorkerChannel, WORKER_CHANNEL_PATH, type WorkerChannel } from "./worker-channel.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "../agent/worker-tokens.js";

/**
 * FRI-2038, slice 2. The worker command channel replaces node IPC for a
 * worker that has no parent process to talk to.
 *
 * These exercise the channel over a REAL HTTP upgrade and a real `ws` client,
 * not a mocked socket, because every property worth testing here lives in the
 * handshake: that an unauthenticated socket never becomes a WebSocket, that
 * the shared daemon secret is not accepted across a network boundary, and that
 * a dropped channel surfaces exactly once so the turn can be failed.
 */

let server: Server;
let channels: WorkerChannel[];
let url: string;

beforeEach(async () => {
  __resetWorkerTokensForTest();
  channels = [];
  server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  attachWorkerChannel(server, (c) => channels.push(c));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of channels) c.close("test over");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetWorkerTokensForTest();
});

function dial(path: string, headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(`${url}${path}`, { headers });
}

/** Resolves on open, rejects with the HTTP status when the upgrade is refused. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", (err) => reject(err));
  });
}

function nextMessage(target: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    target.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
  });
}

function nextChannelMessage(c: WorkerChannel): Promise<unknown> {
  return new Promise((resolve) => c.onMessage(resolve));
}

describe("worker channel upgrade", () => {
  it("admits a worker holding its own minted token", async () => {
    const token = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
    const ws = dial(WORKER_CHANNEL_PATH, { authorization: `Bearer ${token}` });
    await opened(ws);
    expect(channels).toHaveLength(1);
    // The identity comes from the token, not from anything the worker claimed.
    expect(channels[0]!.identity.callerName).toBe("builder-1");
    ws.close();
  });

  it("refuses the SHARED DAEMON SECRET, which identifies nothing here", async () => {
    // The point of the per-worker token. The daemon secret sits on a volume
    // any builder in the Deployment container can read (FRI-2062), so across
    // a network boundary presenting it proves only that you are on the
    // network. A 401 rather than an upgrade is the whole boundary.
    process.env.FRIDAY_DAEMON_SECRET = "shared-secret";
    await expect(
      opened(dial(WORKER_CHANNEL_PATH, { authorization: "Bearer shared-secret" })),
    ).rejects.toThrow("status 401");
    expect(channels).toHaveLength(0);
  });

  it("refuses an absent, malformed, or revoked token", async () => {
    const token = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
    for (const headers of [
      {},
      { authorization: token }, // no Bearer scheme
      { authorization: "Bearer " }, // empty
      { authorization: `Bearer ${token}x` }, // near-miss
    ]) {
      await expect(opened(dial(WORKER_CHANNEL_PATH, headers))).rejects.toThrow("status 401");
    }
    expect(channels).toHaveLength(0);
  });

  it("never upgrades a path other than the channel's", async () => {
    // Nothing else on this listener speaks WebSocket; an upgrade elsewhere is
    // a misconfiguration or a probe, and gets no socket either way.
    const token = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
    await expect(
      opened(dial("/api/mcp/friday-tickets", { authorization: `Bearer ${token}` })),
    ).rejects.toThrow();
    expect(channels).toHaveLength(0);
  });
});

describe("worker channel traffic", () => {
  async function connected() {
    const token = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
    const ws = dial(WORKER_CHANNEL_PATH, { authorization: `Bearer ${token}` });
    await opened(ws);
    return { ws, channel: channels.at(-1)! };
  }

  it("carries commands down and events up as JSON objects", async () => {
    const { ws, channel } = await connected();

    const down = nextMessage(ws);
    channel.send({ type: "prompt", text: "go" });
    expect(await down).toEqual({ type: "prompt", text: "go" });

    const up = nextChannelMessage(channel);
    ws.send(JSON.stringify({ type: "block-delta", blockIndex: 0, text: "hi" }));
    expect(await up).toEqual({ type: "block-delta", blockIndex: 0, text: "hi" });

    ws.close();
  });

  it("survives an unparseable frame rather than taking the daemon down", async () => {
    // A worker emitting garbage is a real symptom, but it must not be able to
    // crash the process that supervises it. The frame is dropped; the channel
    // keeps working.
    const { ws, channel } = await connected();
    ws.send("not json");
    const up = nextChannelMessage(channel);
    ws.send(JSON.stringify({ type: "turn-end" }));
    expect(await up).toEqual({ type: "turn-end" });
    ws.close();
  });

  it("fires onClose exactly once when the worker's side drops", async () => {
    // The fail-the-turn decision rests on this: one terminal event, so the
    // teardown path cannot run twice and cannot be missed.
    const { ws, channel } = await connected();
    let closes = 0;
    channel.onClose(() => closes++);
    ws.terminate();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (closes > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    // Give any second close/error event time to arrive and be swallowed.
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toBe(1);
  });

  it("reports closed to a handler registered after the fact", async () => {
    // Registration races the drop — a channel that closed before the caller
    // wired its handler must still tell it, or the turn hangs.
    const { ws, channel } = await connected();
    const dropped = new Promise<void>((resolve) => channel.onClose(() => resolve()));
    ws.terminate();
    await dropped;

    let late: string | undefined;
    channel.onClose((reason) => (late = reason));
    expect(late).toBeDefined();
  });

  it("drops a send on a closed channel instead of throwing", async () => {
    const { ws, channel } = await connected();
    ws.close();
    channel.close("done");
    expect(() => channel.send({ type: "abort" })).not.toThrow();
  });
});

describe("worker channel teardown", () => {
  async function connected() {
    const token = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
    const ws = dial(WORKER_CHANNEL_PATH, { authorization: `Bearer ${token}` });
    await opened(ws);
    return { ws, channel: channels.at(-1)! };
  }

  it("fires onClose for a DELIBERATE close too, and only once", async () => {
    // The contract is "closes for any reason". A caller that hears only about
    // unexpected closes has to run teardown from two places, which is how one
    // of them gets forgotten. The socket's own close event lands a moment
    // later, so this is also what the once-guard is for.
    const { ws, channel } = await connected();
    const reasons: string[] = [];
    channel.onClose((r) => reasons.push(r));

    channel.close("worker exited");
    expect(reasons).toEqual(["worker exited"]);

    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    expect(reasons).toEqual(["worker exited"]);
  });
});
