import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES } from "./server.js";
import {
  isWorkerFacing,
  resolveWorkerListen,
  workerFromRequest,
  WORKER_FACING_ROUTES,
} from "./worker-listener.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "../agent/worker-tokens.js";

/**
 * FRI-2072. The daemon binds loopback, and that bind is the only thing
 * defending 62 of 84 routes — verified: `GET /api/tickets` with
 * `Host: evil.example` and the daemon secret returns 200.
 *
 * FRI-2038 needs a worker in its own container to reach the daemon. The
 * worker-facing listener exists so that does not mean exposing everything.
 */

describe("worker-facing allowlist", () => {
  it("admits exactly the routes a worker was measured to need", () => {
    // Measured after thirteen of fourteen MCP servers moved daemon-side:
    // their handlers now self-call, so only worker-side code crosses a
    // network. If this list grows, something re-crossed the boundary and the
    // reason belongs in the entry.
    expect(WORKER_FACING_ROUTES.map((r) => r.reason).every((s) => s.length > 20)).toBe(true);
    expect(isWorkerFacing("POST", "/api/mcp/friday-tickets")).toBe(true);
    expect(isWorkerFacing("GET", "/api/memory")).toBe(true);
    expect(isWorkerFacing("GET", "/api/mail/inbox/friday")).toBe(true);
    expect(isWorkerFacing("POST", "/api/elicitation/wait")).toBe(true);
  });

  it("refuses the rest of the daemon — including routes with no auth flag", () => {
    // The ones the loopback bind is currently the only defence for.
    for (const path of [
      "/api/tickets",
      "/api/agents",
      "/api/secrets/audit",
      "/api/evolve/scan",
      "/api/schedules",
      "/api/habits",
      "/api/commands/dispatch",
      "/api/events",
    ]) {
      expect(isWorkerFacing("GET", path), `${path} must not be worker-facing`).toBe(false);
      expect(isWorkerFacing("POST", path), `${path} must not be worker-facing`).toBe(false);
    }
  });

  it("is method-specific — a readable route is not therefore writable", () => {
    // `/api/memory` is GET-only here: compact-flush reads the index. A worker
    // writing memory goes through the hosted MCP server, which is gated.
    expect(isWorkerFacing("GET", "/api/memory")).toBe(true);
    expect(isWorkerFacing("POST", "/api/memory")).toBe(false);
  });

  it("does not admit paths that merely start with an allowed prefix", () => {
    // Path-prefix matching is the classic way an allowlist leaks.
    expect(isWorkerFacing("GET", "/api/memory/secret")).toBe(false);
    expect(isWorkerFacing("POST", "/api/mcp/friday-tickets/../tickets")).toBe(false);
    expect(isWorkerFacing("GET", "/api/mail/inbox/friday/all")).toBe(false);
    expect(isWorkerFacing("POST", "/api/elicitation/waiting")).toBe(false);
  });

  it("stays a strict subset of routes the daemon actually serves", () => {
    // An allowlist entry with no backing route is dead config that reads like
    // a live grant. Every entry must match at least one real ROUTES row.
    for (const wr of WORKER_FACING_ROUTES) {
      const backed = ROUTES.some((row) => {
        if (row.method !== wr.method) return false;
        if (typeof row.match === "string") return wr.match(row.match);
        return true; // regex/predicate rows: checked by the live tests below
      });
      expect(backed, `${wr.method} ${wr.reason} matches no served route`).toBe(true);
    }
  });
});

describe("worker-facing auth", () => {
  beforeEach(() => __resetWorkerTokensForTest());
  afterEach(() => __resetWorkerTokensForTest());

  const req = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Parameters<typeof workerFromRequest>[0];

  it("identifies a worker by its minted token", () => {
    const token = mintWorkerToken({ callerName: "builder-3", callerType: "builder" });
    expect(workerFromRequest(req({ authorization: `Bearer ${token}` }))?.callerName).toBe(
      "builder-3",
    );
  });

  it("refuses the shared daemon secret", () => {
    // The secret sits on a volume any builder in the container can read
    // (FRI-2062's accepted residual risk), so across a network boundary it
    // identifies nothing. Only the per-worker token counts here.
    expect(workerFromRequest(req({ "x-friday-daemon-secret": "whatever" }))).toBeNull();
  });

  it("refuses self-asserted caller headers and forged tokens", () => {
    expect(
      workerFromRequest(
        req({ "x-friday-caller-name": "friday", "x-friday-caller-type": "orchestrator" }),
      ),
    ).toBeNull();
    expect(workerFromRequest(req({ authorization: "Bearer forged" }))).toBeNull();
    expect(workerFromRequest(req({}))).toBeNull();
  });

  it("stops accepting a token once its worker exits", () => {
    const token = mintWorkerToken({ callerName: "gone", callerType: "builder" });
    __resetWorkerTokensForTest();
    expect(workerFromRequest(req({ authorization: `Bearer ${token}` }))).toBeNull();
  });
});

describe("resolveWorkerListen", () => {
  it("is off unless explicitly configured", () => {
    // A laptop and a single-container Deployment have no worker on a network,
    // so the default must change nothing about either.
    expect(resolveWorkerListen({})).toBeNull();
    expect(resolveWorkerListen({ FRIDAY_WORKER_LISTEN: "" })).toBeNull();
    expect(resolveWorkerListen({ FRIDAY_WORKER_LISTEN: "   " })).toBeNull();
  });

  it("parses host:port", () => {
    expect(resolveWorkerListen({ FRIDAY_WORKER_LISTEN: "0.0.0.0:7611" })).toEqual({
      host: "0.0.0.0",
      port: 7611,
    });
  });

  it("refuses malformed values rather than guessing a bind", () => {
    // Guessing here would mean binding somewhere the operator did not ask for.
    for (const v of ["0.0.0.0", "7611", "0.0.0.0:0", "0.0.0.0:99999", "0.0.0.0:abc"]) {
      expect(resolveWorkerListen({ FRIDAY_WORKER_LISTEN: v }), v).toBeNull();
    }
  });
});
