import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * FRI-2037: does abort reach a DAEMON-HOSTED tool handler?
 *
 * In-process, the Agent SDK handed its own AbortSignal straight to the tool
 * handler, and `signalFrom(extra)` forwarded it into `daemonFetch` so a user
 * pressing Stop cancelled the in-flight HTTP call (FRI-66). Hosting the server
 * puts a network hop in the middle, and `host.ts` runs the transport in
 * STATELESS mode — a fresh transport per request, no session id. A
 * `notifications/cancelled` would arrive as a separate POST with no session to
 * correlate against, so protocol-level cancellation cannot work there by
 * construction.
 *
 * What should still work is connection close: the client aborting its HTTP
 * request closes the response, which must abort the handler's signal. That is
 * the property this file pins, because every hosted tool depends on it and it
 * is invisible until a user hits Stop on a long tool call.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

interface Probe {
  started: Promise<void>;
  aborted: Promise<boolean>;
}

/** Start a hosted MCP endpoint whose one tool reports whether it was aborted. */
async function startHost(): Promise<{ url: string; probe: Probe }> {
  let markStarted: () => void;
  const started = new Promise<void>((r) => (markStarted = r));
  let settleAborted: (v: boolean) => void;
  const aborted = new Promise<boolean>((r) => (settleAborted = r));

  const build = () => {
    const mcp = new McpServer({ name: "probe", version: "0" });
    mcp.registerTool(
      "slow",
      { description: "blocks until aborted", inputSchema: {} as Record<string, z.ZodTypeAny> },
      async (_args, extra) => {
        markStarted();
        const sig = (extra as { signal?: AbortSignal }).signal;
        await new Promise<void>((resolve) => {
          // Resolve on abort, or give up after a bound well under the test
          // timeout so a non-propagating signal fails loudly rather than hangs.
          const t = setTimeout(() => {
            settleAborted(false);
            resolve();
          }, 3000);
          sig?.addEventListener("abort", () => {
            clearTimeout(t);
            settleAborted(true);
            resolve();
          });
        });
        return { content: [{ type: "text" as const, text: "done" }] };
      },
    );
    return mcp;
  };

  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const mcp = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });

  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, probe: { started, aborted } };
}

describe("daemon-hosted MCP abort propagation", () => {
  it("aborts the tool handler when the client drops the HTTP request", async () => {
    const { url, probe } = await startHost();
    const ac = new AbortController();

    const call = fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "slow", arguments: {} },
      }),
    }).catch(() => undefined); // the abort rejects the fetch; that is expected

    // Only abort once the handler is genuinely running — otherwise we would be
    // testing that an unstarted request never starts.
    await probe.started;
    ac.abort();

    await expect(probe.aborted).resolves.toBe(true);
    await call;
  }, 10_000);
});
