import { afterEach, describe, expect, it } from "vitest";
import { buildMcpServers } from "./builder.js";

/**
 * FRI-2037: the hosted path's own contract.
 *
 * `builder.test.ts` pins FRIDAY_MCP_HOSTED=0 so it can inspect constructed
 * tool sets. This file covers the default — that Friday's own servers are
 * `http` configs pointing at the daemon, carrying the worker's bearer token
 * and NOT naming the caller.
 */
afterEach(() => delete process.env.FRIDAY_WORKER_TOKEN);

function build(callerType: "orchestrator" | "builder" = "orchestrator") {
  return buildMcpServers({ callerName: "friday", callerType, daemonPort: 7610 });
}

describe("buildMcpServers: hosted path (default)", () => {
  it("serves Friday's own servers over http, not in-process", () => {
    const servers = build();
    for (const name of [
      "friday-echo",
      "friday-mail",
      "friday-tickets",
      "friday-agents",
      "friday-reminder",
      "friday-habit",
      "friday-memory",
    ]) {
      expect(servers[name], `${name} should be present`).toBeDefined();
      expect(servers[name], `${name} should be hosted`).toMatchObject({
        type: "http",
        url: expect.stringContaining(`/api/mcp/${name}`),
      });
    }
  });

  it("sends the worker's bearer token and does NOT name the caller", () => {
    process.env.FRIDAY_WORKER_TOKEN = "tok-abc";
    const entry = build()["friday-tickets"] as { headers: Record<string, string> };
    expect(entry.headers.authorization).toBe("Bearer tok-abc");
    // The weakness FRI-2037 closed: self-asserted identity. The daemon
    // derives callerName/callerType from the token, so these must not be sent.
    expect(entry.headers["x-friday-caller-name"]).toBeUndefined();
    expect(entry.headers["x-friday-caller-type"]).toBeUndefined();
  });

  it("omits the authorization header when no token is present", () => {
    // Rather than sending `Bearer undefined`, which would read as a forged
    // credential in the daemon's logs instead of an absent one.
    const entry = build()["friday-tickets"] as { headers: Record<string, string> };
    expect(entry.headers.authorization).toBeUndefined();
  });

  it("leaves user-configured and App servers on stdio", () => {
    // This work moves FRIDAY's servers only. A user's own MCP server is still
    // a subprocess and must not be rewritten to http.
    const servers = buildMcpServers({
      callerName: "friday",
      callerType: "orchestrator",
      daemonPort: 7610,
      userMcpServers: [{ name: "demo-echo", command: "node", args: ["x.js"] }],
    });
    expect(servers["demo-echo"]).toMatchObject({ type: "stdio" });
  });
});
