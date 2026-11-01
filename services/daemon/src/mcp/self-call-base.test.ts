import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetDaemonSelfCallsForTest, daemonFetchBase, markDaemonSelfCalls } from "./http.js";

/**
 * FRI-2087: a hosted MCP server's `daemonFetch` is a SELF-call and must go to
 * loopback, never to `FRIDAY_DAEMON_URL`.
 *
 * `FRIDAY_DAEMON_URL` exists so a worker in a container can find the daemon,
 * and `resolveDaemonBaseUrl` preferred it unconditionally. So in any container
 * Deployment — which must set it, or no worker can reach the daemon — the
 * daemon's own calls to itself were addressed to the WORKER-FACING listener,
 * which serves nine routes.
 *
 * The effect was worse than a plain failure, because the tools CONNECTED.
 * Measured live: `mail_send` was present in the Builder's tool list and
 * returned `daemonFetch POST /api/mail/send -> 404: {"error":"not found"}` —
 * the worker gate's own 404. So a Builder appeared to have its tools and every
 * one of them failed on use.
 */

beforeEach(() => {
  __resetDaemonSelfCallsForTest();
  delete process.env.FRIDAY_DAEMON_URL;
});

afterEach(() => {
  __resetDaemonSelfCallsForTest();
  delete process.env.FRIDAY_DAEMON_URL;
});

describe("where a daemonFetch goes", () => {
  it("from a WORKER: to FRIDAY_DAEMON_URL, which may be across a network", () => {
    // The worker path, unchanged. A containerised worker has no loopback route
    // to the daemon, so this is the only address that works for it.
    expect(daemonFetchBase(7610, { FRIDAY_DAEMON_URL: "http://friday:7611" })).toBe(
      "http://friday:7611",
    );
  });

  it("from the DAEMON: to loopback, even when FRIDAY_DAEMON_URL is set", () => {
    // The bug, pinned. Before the fix this returned `http://friday:7611`, and
    // every hosted tool 404ed against the nine-route worker listener.
    markDaemonSelfCalls();
    expect(daemonFetchBase(7610, { FRIDAY_DAEMON_URL: "http://friday:7611" })).toBe(
      "http://127.0.0.1:7610",
    );
  });

  it("from the daemon: honours the port it was given", () => {
    // A non-default daemon port must not silently become 7610.
    markDaemonSelfCalls();
    expect(daemonFetchBase(7444, { FRIDAY_DAEMON_URL: "http://friday:7611" })).toBe(
      "http://127.0.0.1:7444",
    );
  });

  it("from a worker with nothing configured: loopback, as before", () => {
    // The laptop path: no FRIDAY_DAEMON_URL, worker and daemon on one host.
    expect(daemonFetchBase(7610, {})).toBe("http://127.0.0.1:7610");
  });

  it("is not sticky across processes — the flag has to be set deliberately", () => {
    // A worker must never inherit "I am the daemon". The default is the worker
    // answer, so forgetting to mark degrades to the pre-FRI-2087 behaviour
    // rather than silently redirecting a worker to its own loopback.
    expect(daemonFetchBase(7610, { FRIDAY_DAEMON_URL: "http://friday:7611" })).toBe(
      "http://friday:7611",
    );
  });
});
