import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  getDaemonSecret,
  DAEMON_SECRET_HEADER,
  type TestDbHandle,
} from "@friday/shared";

/**
 * FRI-2087: a worker-facing route declaring `auth: true` must be satisfied by
 * the per-worker TOKEN, not the shared daemon secret.
 *
 * This is the test whose absence let the bug ship. `/api/mcp/<server>` is the
 * one worker-facing route with `auth: true`, and nothing drove it THROUGH the
 * worker listener — so its `authorizeSameHost` gate rejected every request a
 * real containerised Builder made and the SDK silently dropped all fourteen
 * hosted servers. Measured live before the fix: the agent itself reported
 * "`mail_send` is not in my available tool list" and the daemon logged zero MCP
 * events. It could write code and could not mail the orchestrator, read
 * tickets, use memory, or open a PR.
 *
 * Two things made it unsatisfiable rather than one: `authorizeSameHost` wants a
 * loopback `Host` (a builder's is `friday:7611`) AND the daemon secret, which a
 * builder has no `/data` mount to read — and `getDaemonSecret()` mints a fresh
 * one rather than failing, so the failure was a silent mismatch rather than an
 * error.
 *
 * Driven as real HTTP against the real listener on purpose. The defect was in
 * the WIRING — which dep set `handleWorkerFacing` passed to `handle` — so a
 * test that called the authorize predicate directly would have passed while
 * the daemon stayed broken.
 */

vi.mock("@friday/shared", async (importActual) => {
  const actual = await importActual<typeof import("@friday/shared")>();
  return {
    ...actual,
    loadFridayConfig: () => ({
      betterAuthSecret: "test-better-auth",
      zeroAuthSecret: "test-zero-auth",
      zeroAdminPassword: "test-zero-admin",
      databaseUrl: process.env.DATABASE_URL,
      zeroUpstreamDb: undefined,
      zeroReplicaFile: undefined,
      linearApiKey: undefined,
      anthropicApiKey: undefined,
      cloudflareTunnelToken: undefined,
      posthogApiKey: undefined,
      posthogHost: undefined,
    }),
  };
});

let handle: TestDbHandle;
let server: Server;
let loopbackPort: number;
let workerPort: number;
let mintWorkerToken: (typeof import("../agent/worker-tokens.js"))["mintWorkerToken"];
let resetTokens: (typeof import("../agent/worker-tokens.js"))["__resetWorkerTokensForTest"];

/** A port nothing holds, taken and released so the listener can bind it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const p = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return p;
}

beforeAll(async () => {
  handle = await createTestDb({ label: "worker_facing_auth" });
  workerPort = await freePort();
  // The worker-facing listener is off unless configured (FRI-2072), so the
  // test has to opt in — and bind a port it can address afterwards.
  process.env.FRIDAY_WORKER_LISTEN = `127.0.0.1:${workerPort}`;
  const tokens = await import("../agent/worker-tokens.js");
  mintWorkerToken = tokens.mintWorkerToken;
  resetTokens = tokens.__resetWorkerTokensForTest;
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  loopbackPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.FRIDAY_WORKER_LISTEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  resetTokens();
});

/** `friday-echo` is hosted and side-effect free, so it is the honest probe. */
const MCP_PATH = "/api/mcp/friday-echo";
const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

async function callWorkerListener(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${workerPort}${MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: RPC,
  });
  return res.status;
}

function token(): string {
  return mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
}

describe("the worker listener's auth gate", () => {
  it("accepts a per-worker token with NO daemon secret", async () => {
    // Exactly the shape a containerised Builder sends. Before the fix this was
    // 401 {"error":"unauthorized"} from the route's own gate.
    expect(await callWorkerListener({ authorization: `Bearer ${token()}` })).not.toBe(401);
  });

  it("accepts it with a non-loopback Host, which is what a builder has", async () => {
    // `authorizeSameHost` required a loopback Host, so a builder reaching
    // `friday:7611` failed this check even holding a correct secret.
    expect(
      await callWorkerListener({ authorization: `Bearer ${token()}`, host: "friday:7611" }),
    ).not.toBe(401);
  });

  it("still refuses a request with no token", async () => {
    expect(await callWorkerListener({})).toBe(401);
  });

  it("still refuses a forged token", async () => {
    expect(await callWorkerListener({ authorization: "Bearer not-a-real-token" })).toBe(401);
  });

  it("does NOT accept the daemon secret in place of a token", async () => {
    // The premise of the whole listener: the secret sits on a volume any
    // builder in the Deployment container can read, so on a network boundary
    // it identifies nothing.
    expect(await callWorkerListener({ [DAEMON_SECRET_HEADER]: getDaemonSecret() })).toBe(401);
  });

  it("serves only worker-facing routes, token or not", async () => {
    // The structural half of FRI-2072 — a token is not a key to the other ~80
    // routes. 404 rather than 403: a route not served here looks absent.
    const res = await fetch(`http://127.0.0.1:${workerPort}/api/agents`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("the loopback listener is unchanged", () => {
  it("does not accept a worker token in place of the daemon secret", async () => {
    // The fix must not widen the primary listener. A worker token is
    // sufficient on the worker surface because that surface serves nine
    // routes, not because the daemon now takes tokens everywhere.
    const res = await fetch(`http://127.0.0.1:${loopbackPort}${MCP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
      body: RPC,
    });
    expect(res.status).toBe(401);
  });

  it("still accepts the daemon secret", async () => {
    const res = await fetch(`http://127.0.0.1:${loopbackPort}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [DAEMON_SECRET_HEADER]: getDaemonSecret(),
        authorization: `Bearer ${token()}`,
      },
      body: RPC,
    });
    expect(res.status).not.toBe(401);
  });
});
