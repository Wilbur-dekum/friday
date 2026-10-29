import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentType } from "@friday/shared";
import { buildTicketsServer, TICKETS_SERVER_NAME } from "./tickets.js";

/**
 * Daemon-side host for Friday's own MCP servers (FRI-2037).
 *
 * Today each Friday MCP server is built with `createSdkMcpServer` and handed
 * to the Agent SDK **inside the worker process**, where its handlers then call
 * the daemon over HTTP. Two consequences, both bad:
 *
 *  - A worker in its own container (FRI-2038) cannot reach `127.0.0.1` — the
 *    constant PR #24 turned into configuration — so every Friday tool breaks.
 *  - The tool surface runs in the same process as untrusted repository code.
 *    `docs/sandbox.md` residual risk #1 names this exactly: "L1 + L5 run
 *    inside the worker isolate … a single Bash escape that monkey-patches
 *    `require.cache` or `process.send` unwinds every downstream decision. The
 *    honest fix is a daemon-side enforcement plane." This is that plane.
 *
 * Hosting them here moves the handlers out of the untrusted process while
 * changing NOTHING about what they do: `createSdkMcpServer` returns the live
 * `McpServer` instance, so the very same construction is reused and connected
 * to an HTTP transport instead of handed to the worker. No tool definition is
 * duplicated, which is what keeps the two forms from drifting.
 *
 * Deliberately NOT changed here:
 *  - The handlers still reach the daemon through `daemonFetch` over loopback.
 *    Inside the daemon that is a self-call, and it looks redundant — but it
 *    keeps this change to ONE variable (where the code runs), preserving the
 *    route's own validation and error shapes exactly. Collapsing those 83 call
 *    sites into direct service calls is a separate, mechanical pass.
 *  - The auth model. These routes sit behind the same `authorizeSameHost`
 *    gate: daemon secret plus a loopback `Host`. Per-worker credentials and a
 *    non-loopback bind are the next slice, and are what FRI-2038 actually
 *    needs. Moving transport and auth in one step doubles the risk.
 *
 * Statelessness is deliberate: a fresh transport and a fresh server per
 * request, with no session id. The caller identity arrives on every request as
 * headers, so there is no per-connection state worth keeping, and nothing to
 * leak between two workers that happen to hit the same daemon.
 */

/** Servers this host can serve, by MCP server name. */
const HOSTED = {
  [TICKETS_SERVER_NAME]: buildTicketsServer,
} as const;

export type HostedServerName = keyof typeof HOSTED;

export function isHostedServer(name: string): name is HostedServerName {
  return Object.prototype.hasOwnProperty.call(HOSTED, name);
}

/** The MCP path a worker should be pointed at for a hosted server. */
export function hostedServerPath(name: HostedServerName): string {
  return `/api/mcp/${name}`;
}

/**
 * The caller a hosted request is acting as.
 *
 * In-worker, this was baked in at construction because the server belonged to
 * exactly one agent. Hosted, one daemon serves every worker, so it has to
 * arrive per request — and it must come from headers the worker cannot be
 * trusted to be honest about on its own. That is tolerable only while the
 * daemon-secret gate still means "same host"; when the gate becomes a
 * per-worker credential, the caller must be derived from the credential
 * instead of asserted by the client. Noted here because it is the exact
 * place that assumption will need revisiting.
 */
export interface HostedCaller {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

const AGENT_TYPES: readonly string[] = [
  "orchestrator",
  "builder",
  "helper",
  "scheduled",
  "bare",
  "planner",
];

export function callerFromHeaders(
  headers: IncomingMessage["headers"],
  daemonPort: number,
): HostedCaller | null {
  const name = headers["x-friday-caller-name"];
  const type = headers["x-friday-caller-type"];
  if (typeof name !== "string" || !name) return null;
  if (typeof type !== "string" || !AGENT_TYPES.includes(type)) return null;
  return { callerName: name, callerType: type as AgentType, daemonPort };
}

/**
 * Serve one MCP request for a hosted server.
 *
 * The caller owns auth (the route's `authorizeSameHost` gate) and has already
 * matched the server name out of the path.
 */
export async function handleHostedMcp(opts: {
  server: HostedServerName;
  caller: HostedCaller;
  req: IncomingMessage;
  res: ServerResponse;
  /** Pre-read JSON body; the daemon's router drains the stream before us. */
  body: unknown;
}): Promise<void> {
  const { instance } = HOSTED[opts.server]({
    callerName: opts.caller.callerName,
    callerType: opts.caller.callerType,
    daemonPort: opts.caller.daemonPort,
  });

  // `sessionIdGenerator: undefined` is the SDK's stateless mode: no session is
  // created or looked up, so each request stands alone.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Close the transport (and with it the server) when the response ends, so a
  // dropped connection cannot leak either. Both are per-request.
  opts.res.on("close", () => {
    void transport.close();
    void instance.close();
  });

  await instance.connect(transport);
  await transport.handleRequest(opts.req, opts.res, opts.body);
}
