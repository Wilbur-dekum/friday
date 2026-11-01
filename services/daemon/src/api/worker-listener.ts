import type { IncomingMessage } from "node:http";
import { resolveWorkerToken, type WorkerIdentity } from "../agent/worker-tokens.js";

/**
 * The surface a containerised worker may reach (FRI-2072).
 *
 * The daemon binds `127.0.0.1`, and that bind is currently doing the job an
 * auth gate would do: 62 of 84 routes carry no `auth` flag at all, because the
 * router's own comment says they "rely on the 127.0.0.1 binding". Verified —
 * `GET /api/tickets` with `Host: evil.example` and the daemon secret returns
 * 200. The bind is not a weak control, it is a TOTAL one.
 *
 * FRI-2038 needs a worker in its own container to reach the daemon, which
 * means binding beyond loopback. Doing that on the existing listener would
 * expose all 84 routes to the one network the untrusted-code container sits
 * on, and leave 62 of them defended by nothing.
 *
 * So: a SECOND listener, serving only what a worker actually needs. The
 * exposure is limited structurally rather than by policy — a route is
 * unreachable from the worker network because it is not served there, not
 * because a middleware remembered to say no. A route added tomorrow is
 * loopback-only by default, which is the safe direction to fail.
 *
 * ## Why this list is short
 *
 * Measured after FRI-2073/2075 hosted thirteen of fourteen MCP servers: their
 * handlers now run INSIDE the daemon, so their `daemonFetch` calls are
 * self-calls and never cross a network. What remains is what worker-side code
 * itself calls, which is three routes — plus the MCP endpoint the worker's SDK
 * connects to.
 *
 * If `compact-flush`'s memory read and `worker.ts`'s inbox read ever move
 * daemon-side, this collapses to `/api/mcp/*` alone. Worth doing; not required
 * for the boundary to be sound.
 */

/** A worker-reachable route: exact method plus a path predicate. */
interface WorkerRoute {
  method: "GET" | "POST";
  match: (path: string) => boolean;
  /** Why a worker needs it — kept here so additions have to justify themselves. */
  reason: string;
}

export const WORKER_FACING_ROUTES: readonly WorkerRoute[] = [
  {
    method: "POST",
    match: (p) => /^\/api\/mcp\/[a-z0-9-]+$/.test(p),
    reason: "the hosted MCP servers the worker's SDK connects to (FRI-2037)",
  },
  {
    method: "GET",
    match: (p) => p === "/api/memory",
    reason: "compact-flush reads the memory index to bound a flush's tokens",
  },
  {
    method: "GET",
    match: (p) => /^\/api\/mail\/inbox\/[^/]+$/.test(p),
    reason: "worker.ts fetchInboxQuiet drains the agent's mail at turn start",
  },
  {
    method: "GET",
    match: (p) => p === "/api/worker/git/info/refs",
    reason:
      "FRI-2076: the ref advertisement for the clone that fills /workspace — " +
      "a containerised Builder cannot hold a worktree whose gitdir is outside it",
  },
  {
    method: "POST",
    match: (p) => p === "/api/worker/git/git-upload-pack",
    reason: "FRI-2076: the fetch half of that clone",
  },
  {
    method: "POST",
    match: (p) => p === "/api/worker/git/git-receive-pack",
    reason:
      "FRI-2077: the Builder pushes its branch back. Served from the per-task " +
      "staging repo, never the mirror — the mirror's --prune refresh eats un-forwarded refs",
  },
  {
    method: "POST",
    match: (p) => p.startsWith("/api/model/"),
    reason:
      "FRI-2084: brokered model access. A containerised builder holds no Anthropic " +
      "credential — the daemon injects it — so this is how it takes a turn at all",
  },
  {
    method: "GET",
    match: (p) => p.startsWith("/api/model/"),
    reason: "FRI-2084: the model catalog, same brokered path",
  },
  {
    method: "POST",
    match: (p) => p === "/api/elicitation/wait",
    reason:
      "friday-elicitation is the one server that cannot be hosted (FRI-2074): " +
      "its id is extra.toolUseId, which the MCP transport does not carry",
  },
] as const;

/** Whether the worker-facing listener should serve this request at all. */
export function isWorkerFacing(method: string | undefined, path: string): boolean {
  return WORKER_FACING_ROUTES.some((r) => r.method === method && r.match(path));
}

/**
 * Identify the worker behind a request to this listener.
 *
 * The per-worker token ONLY — never the shared daemon secret, and never
 * `x-friday-caller-*` headers. The daemon secret sits on a volume any builder
 * in the Deployment container can read (the residual risk FRI-2062 accepted),
 * so on a network boundary it identifies nothing. The token is minted per
 * worker, cannot be forged by the worker, and is revoked when it exits.
 */
export function workerFromRequest(req: IncomingMessage): WorkerIdentity | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer (.+)$/i.exec(raw.trim());
  return resolveWorkerToken(m?.[1]);
}

/**
 * Where the worker-facing listener binds, or null to not start it.
 *
 * Off unless explicitly configured, so a laptop and a single-container
 * Deployment behave exactly as before — neither has a worker on a network.
 * `FRIDAY_WORKER_LISTEN` is the opt-in, e.g. `0.0.0.0:7611`.
 */
export function resolveWorkerListen(
  env: NodeJS.ProcessEnv = process.env,
): { host: string; port: number } | null {
  const raw = env.FRIDAY_WORKER_LISTEN?.trim();
  if (!raw) return null;
  const m = /^(.+):(\d+)$/.exec(raw);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[1]!, port };
}
