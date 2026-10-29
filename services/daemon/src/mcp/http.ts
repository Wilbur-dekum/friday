/**
 * HTTP helper for MCP tool handlers running inside worker forks.
 *
 * Workers reconstruct MCP servers locally after fork; handlers reach the
 * daemon's authoritative state by hitting 127.0.0.1:<daemonPort>. This keeps
 * the daemon as the sole writer of SQLite (per docs/architecture.md) and
 * routes tool invocations through the same endpoints the dashboard uses.
 *
 * Requests inject the same-host shared secret on every call so endpoints
 * gated by `authorizeSameHost` (e.g. `/api/apps/*`, `/api/uploads`) accept
 * them. Non-gated endpoints ignore the header, so injecting unconditionally
 * is safe and keeps the helper uniform.
 */

import { DAEMON_SECRET_HEADER, getDaemonSecret, resolveDaemonBaseUrl } from "@friday/shared";

/**
 * Extract the AbortSignal from the SDK's `extra` argument passed to MCP tool
 * handlers. The Anthropic SDK types it `unknown` (it's the MCP SDK's
 * `RequestHandlerExtra`, which carries `signal: AbortSignal`). When the user
 * hits Stop or the worker's `abortController` fires, the SDK signals every
 * in-flight handler via this signal — pass it into `daemonFetch` and the
 * worker stops blocking on the daemon's response immediately. See FRI-66 and
 * ADR-030 for the daemon-side semantics (writes still complete server-side;
 * only the worker's wait is cancelled).
 */
export function signalFrom(extra: unknown): AbortSignal | undefined {
  const s = (extra as { signal?: unknown } | null | undefined)?.signal;
  return s instanceof AbortSignal ? s : undefined;
}

export interface DaemonFetchOptions {
  port: number;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  callerName?: string;
  callerType?: string;
  /**
   * FRI-66: optional AbortSignal forwarded to the underlying `fetch()`. MCP
   * tool handlers receive `extra.signal` from the SDK whenever the user hits
   * Stop or the worker's `abortController` fires; threading it here aborts
   * the daemon-bound HTTP request at the worker → daemon boundary so an
   * in-flight `linear_create_issue` / `mail_send` / `ticket_create` stops
   * blocking the worker on the response. Idempotent reads are safe to drop
   * mid-flight; write semantics are documented in ADR-030 (the daemon-side
   * handler completes; only the worker's wait on the response is cancelled).
   */
  signal?: AbortSignal;
}

export async function daemonFetch<T = unknown>(opts: DaemonFetchOptions): Promise<T> {
  // FRI-2037: the host is configuration, not a constant — see
  // `resolveDaemonBaseUrl`. Default is byte-identical to the old literal.
  const url = `${resolveDaemonBaseUrl(opts.port)}${opts.path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [DAEMON_SECRET_HEADER]: getDaemonSecret(),
  };
  if (opts.callerName) headers["x-friday-caller-name"] = opts.callerName;
  if (opts.callerType) headers["x-friday-caller-type"] = opts.callerType;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`daemonFetch ${opts.method ?? "GET"} ${opts.path} -> ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}
