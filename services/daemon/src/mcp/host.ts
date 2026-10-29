import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentType } from "@friday/shared";
import { resolveWorkerToken } from "../agent/worker-tokens.js";
import { buildAgentsServer, AGENTS_SERVER_NAME } from "./agents.js";
import { buildAppsServer, APPS_SERVER_NAME } from "./apps.js";
import { buildEchoServer, ECHO_SERVER_NAME } from "./echo.js";
import { buildEvolveServer, EVOLVE_SERVER_NAME } from "./evolve.js";
import { buildHabitServer, HABIT_SERVER_NAME } from "./habit.js";
import { buildInboxServer, INBOX_SERVER_NAME } from "./inbox.js";
import { buildIntegrationsServer, INTEGRATIONS_SERVER_NAME } from "./integrations.js";
import { buildMailServer, MAIL_SERVER_NAME } from "./mail.js";
import { buildMemoryServer, MEMORY_SERVER_NAME } from "./memory.js";
import { buildReminderServer, REMINDER_SERVER_NAME } from "./reminder.js";
import { buildScheduleServer, SCHEDULE_SERVER_NAME } from "./schedule.js";
import { buildSecretsServer, SECRETS_SERVER_NAME } from "./secrets.js";
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

/**
 * Servers this host can serve, by MCP server name.
 *
 * Every entry is built from the identity the daemon MINTED, never from
 * anything the request asserts. That distinction is what let the last three
 * join: `friday-agents` needs `parentName`, and `friday-reminder` /
 * `friday-habit` need `appId` — scoping values that decide which App's
 * reminders and secrets a caller reaches, and who it may spawn and mail. As
 * self-asserted headers they would have been a privilege escalation; carried
 * on the token they are simply derived.
 *
 * `friday-elicitation` CANNOT be hosted as written (FRI-2074, measured). Its
 * elicitation id is `extra.toolUseId`, which `createSdkMcpServer` injects
 * in-process; the standard MCP transport's `extra` carries `requestId` and
 * `signal` but no `toolUseId`, because tool_use_id is an Anthropic-API concept
 * rather than an MCP one. Hosted, every `ask_user` fails with "invoked without
 * a tool_use_id". It needs a different correlation id, not a port.
 *
 * (Its long-poll is NOT the blocker, contrary to the original guess: Node's
 * `requestTimeout` governs request RECEIPT, not response latency — a probe
 * held a fully-received request open past a 2s `requestTimeout` and was never
 * closed.)
 *
 * `friday-secrets` is hosted (FRI-2075), and hosting it STRENGTHENS it. Its
 * authorization decision — `canFetchOnDemand`, `isSecretsLocked` — used to run
 * inside the worker, i.e. inside the process running untrusted repository
 * code, which is `docs/sandbox.md` residual risk #1 applied to the one tool
 * surface where it matters most. Daemon-side, a compromised worker can ask but
 * cannot rewrite the answer.
 *
 * Its old header claimed safety came from "trusted worker spawn options, not
 * HTTP headers". Hosted, identity comes from the per-worker token instead,
 * which is stronger: the daemon mints it, the worker cannot forge it, and it
 * is revoked on exit. `appId` — which scopes WHICH App's secrets are reachable
 * — is derived from that token rather than asserted, which is the whole reason
 * FRI-2037 put it on the mint.
 */
const HOSTED = {
  [AGENTS_SERVER_NAME]: buildAgentsServer,
  [APPS_SERVER_NAME]: buildAppsServer,
  [HABIT_SERVER_NAME]: buildHabitServer,
  [REMINDER_SERVER_NAME]: buildReminderServer,
  [ECHO_SERVER_NAME]: () => buildEchoServer(),
  [EVOLVE_SERVER_NAME]: buildEvolveServer,
  [INBOX_SERVER_NAME]: buildInboxServer,
  [INTEGRATIONS_SERVER_NAME]: buildIntegrationsServer,
  [MAIL_SERVER_NAME]: buildMailServer,
  [MEMORY_SERVER_NAME]: buildMemoryServer,
  [SCHEDULE_SERVER_NAME]: buildScheduleServer,
  [SECRETS_SERVER_NAME]: buildSecretsServer,
  [TICKETS_SERVER_NAME]: buildTicketsServer,
} as const;

export type HostedServerName = keyof typeof HOSTED;

export function isHostedServer(name: string): name is HostedServerName {
  return Object.prototype.hasOwnProperty.call(HOSTED, name);
}

/**
 * Every server this host serves.
 *
 * Exported so the guard tests DERIVE their coverage instead of hardcoding it.
 * A hardcoded list only catches a name that is listed but not hosted; it
 * silently misses the dangerous direction — a server newly added to HOSTED
 * that nothing checks. FRI-2075 hit exactly that.
 */
export function hostedServerNames(): HostedServerName[] {
  return Object.keys(HOSTED) as HostedServerName[];
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
  /** Derived from the mint, never from a header — see callerFromRequest. */
  parentName?: string;
  appId?: string;
}

const AGENT_TYPES: readonly string[] = [
  "orchestrator",
  "builder",
  "helper",
  "scheduled",
  "bare",
  "planner",
];

/** Extract a bearer token from an Authorization header. */
function bearer(headers: IncomingMessage["headers"]): string | undefined {
  const raw = headers.authorization;
  if (typeof raw !== "string") return undefined;
  const m = /^Bearer (.+)$/i.exec(raw.trim());
  return m?.[1];
}

/**
 * Identify the caller for a hosted request.
 *
 * DERIVED from the per-worker token, never read from client-supplied
 * `x-friday-caller-*` headers. That is the whole point of FRI-2037's token
 * slice: those headers were self-asserted, so any worker holding the shared
 * daemon secret could claim to be any agent. Deriving the caller from a
 * credential the daemon minted for one specific worker is what makes it safe
 * to host servers whose scoping values (`parentName`, `appId`) must not be
 * claimed by the caller.
 *
 * Returns null when no valid token is presented — the route 401s rather than
 * falling back to headers. A fallback would reintroduce exactly the weakness
 * this removes, so there deliberately is not one.
 */
export function callerFromRequest(
  headers: IncomingMessage["headers"],
  daemonPort: number,
): HostedCaller | null {
  const identity = resolveWorkerToken(bearer(headers));
  if (!identity) return null;
  if (!AGENT_TYPES.includes(identity.callerType)) return null;
  return {
    callerName: identity.callerName,
    callerType: identity.callerType,
    daemonPort,
    parentName: identity.parentName,
    appId: identity.appId,
  };
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
    // Only friday-agents / friday-reminder / friday-habit read these, and
    // they come from the token the daemon minted — not from the request.
    parentName: opts.caller.parentName,
    appId: opts.caller.appId,
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
