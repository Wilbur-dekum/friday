import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleHostedMcp,
  hostedServerNames,
  isHostedServer,
  type HostedServerName,
} from "./host.js";

/**
 * FRI-2074: exercise every hosted server over a REAL MCP transport.
 *
 * The companion to hosted-portability.test.ts. That one is a source assertion
 * and catches the specific `extra.toolUseId` class. This one actually stands
 * the server up and speaks MCP to it, so a server that fails to construct, or
 * registers no tools, or cannot be serialised over the transport at all, is
 * caught in-suite rather than on a live turn.
 *
 * `tools/list` deliberately, not `tools/call`: listing exercises construction,
 * registration and the transport round trip without needing a database or
 * plausible arguments for thirty-odd tools. The expensive half — does the tool
 * DO the right thing — is already covered per-server elsewhere, and did not
 * change when the servers moved.
 */

// Derived from HOSTED, so a newly hosted server is exercised automatically.
const SERVERS: HostedServerName[] = hostedServerNames();

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

/** Serve one hosted server, bypassing the daemon's auth gate (tested apart). */
async function serve(name: HostedServerName): Promise<string> {
  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      await handleHostedMcp({
        server: name,
        caller: { callerName: "t", callerType: "orchestrator", daemonPort: 7610 },
        req,
        res,
        body,
      });
    })();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

async function listTools(url: string): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  return [...text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("every hosted server answers over a real MCP transport", () => {
  for (const name of SERVERS) {
    it(`${name} constructs and lists its tools`, async () => {
      expect(isHostedServer(name)).toBe(true);
      const tools = await listTools(await serve(name));
      // A server that constructs but registers nothing is broken in a way
      // `tools/list` returning 200 would otherwise hide.
      expect(tools.length, `${name} registered no tools`).toBeGreaterThan(0);
    });
  }
});
