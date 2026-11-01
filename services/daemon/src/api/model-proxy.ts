import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadFridayConfig } from "@friday/shared";
import { logger } from "../log.js";
import { workerFromRequest } from "./worker-listener.js";

/**
 * Brokered access to the model API (FRI-2084, ADR-055 rule 2).
 *
 * A containerised builder could not take a turn at all. The broker allows five
 * env keys and none is an Anthropic credential, the image carries none, and
 * `claudeCodeChildEnv()` can only pass through what the worker already holds —
 * so the SDK had nothing to authenticate with. FRI-2039 put
 * `api.anthropic.com` on the egress allowlist, which made the destination
 * reachable and said nothing about authenticating to it. That distinction is
 * what ADR-055 exists to make.
 *
 * ## Why `brokered` rather than passing the key in
 *
 * Passing the three Anthropic keys through `ALLOWED_ENV` is about one line and
 * would have unblocked this immediately. It also puts the model credential in
 * the untrusted container, readable by the agent's own Bash tool — in the one
 * place untrusted repository code is most expected to run. ADR-055 rule 2
 * settles the default the other way: external egress consolidates on the
 * trusted tier, so this is the direction the system is going regardless.
 *
 * The side benefit is immediate: `api.anthropic.com` comes off the egress
 * allowlist entirely, so the builder's permitted destinations shrink rather
 * than grow to accommodate the model.
 *
 * ## What the builder holds instead
 *
 * `ANTHROPIC_BASE_URL` pointed here, and `ANTHROPIC_AUTH_TOKEN` set to its own
 * per-worker token. The SDK sends that as `Authorization: Bearer …`, which is
 * exactly the header `workerFromRequest` already reads on every other
 * worker-facing route — so the builder authenticates to the model path with
 * the credential it already has, and gaining nothing new is the point.
 *
 * The inbound token is then **stripped**, never forwarded: Anthropic has no
 * use for it and a worker token leaving the Deployment is a credential leak.
 *
 * ## The upstream host is not negotiable
 *
 * The caller chooses the PATH; it never chooses the host. Everything is
 * forwarded to one fixed upstream, and the path is validated against a
 * deny-by-default pattern rather than concatenated — otherwise this route is
 * an SSRF primitive with Friday's own model credential attached, which is
 * strictly worse than the gap it closes.
 */

/** Where a worker's model traffic arrives. Trailing slash matters: see `upstreamPathFor`. */
export const MODEL_PROXY_PREFIX = "/api/model/";

/** The real API. Overridable so tests can stand up a fake; the default is pinned by a test. */
export const DEFAULT_MODEL_UPSTREAM = "https://api.anthropic.com";

export function resolveModelUpstream(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FRIDAY_MODEL_UPSTREAM?.trim();
  return raw && /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, "") : DEFAULT_MODEL_UPSTREAM;
}

/**
 * The paths a worker's SDK legitimately calls.
 *
 * An allowlist, not a sanitizer. `/v1/messages` and its `count_tokens`
 * sibling are what a turn uses; `/v1/models` is the catalog. Anything else —
 * including anything containing a `..` segment, which is why this is a
 * pattern rather than a prefix check — is refused.
 */
const ALLOWED_UPSTREAM_PATHS = [
  /^\/v1\/messages$/,
  /^\/v1\/messages\/count_tokens$/,
  /^\/v1\/models$/,
  /^\/v1\/models\/[A-Za-z0-9._-]+$/,
];

/**
 * Map an inbound request path to the upstream path, or null to refuse.
 *
 * Built from the decoded pathname, so a percent-encoded traversal cannot
 * smuggle a segment past the patterns above.
 */
export function upstreamPathFor(pathname: string): string | null {
  if (!pathname.startsWith(MODEL_PROXY_PREFIX)) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(pathname.slice(MODEL_PROXY_PREFIX.length));
  } catch {
    return null; // malformed percent-encoding
  }
  const candidate = `/${rest}`;
  if (candidate.includes("..")) return null;
  return ALLOWED_UPSTREAM_PATHS.some((re) => re.test(candidate)) ? candidate : null;
}

/** Headers belonging to this hop, plus every way a caller could pin its own credential. */
const DROP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // The worker's own token authenticated this hop and must not travel on.
  "authorization",
  // A caller must not be able to choose the upstream credential.
  "x-api-key",
]);

const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

export interface UpstreamCredential {
  header: string;
  value: string;
}

/**
 * The credential the daemon presents upstream.
 *
 * `ANTHROPIC_API_KEY` is the common case and goes in `x-api-key`. The two
 * token shapes are bearers — `CLAUDE_CODE_OAUTH_TOKEN` is what a
 * `claude login` install has instead of a key, and a Deployment configured
 * that way must not silently fall back to unauthenticated.
 */
export function upstreamCredential(
  env: NodeJS.ProcessEnv = process.env,
): UpstreamCredential | null {
  const key = loadFridayConfig().anthropicApiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  if (key) return { header: "x-api-key", value: key };
  const bearer = env.ANTHROPIC_AUTH_TOKEN?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (bearer) return { header: "authorization", value: `Bearer ${bearer}` };
  return null;
}

/**
 * Forward one model request, credential swapped.
 *
 * Streamed in both directions. A turn is a long SSE response, so buffering it
 * would delay every block to the end of the turn and hold a whole response in
 * the daemon's heap per active worker.
 */
export function handleModelProxy(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const identity = workerFromRequest(req);
  if (!identity) {
    logger.log("warn", "model.proxy.deny", { reason: "unauthenticated" });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "a per-worker token is required" }));
    return;
  }

  const url = new URL(req.url ?? "/", "http://model-proxy");
  const upstreamPath = upstreamPathFor(url.pathname);
  if (!upstreamPath) {
    logger.log("warn", "model.proxy.deny", {
      agent: identity.callerName,
      path: url.pathname,
      reason: "path is not an allowed model endpoint",
    });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not a model endpoint" }));
    return;
  }

  const credential = upstreamCredential(env);
  if (!credential) {
    // Fail loudly rather than forwarding unauthenticated and surfacing as a
    // 401 the agent would read as its own problem.
    logger.log("error", "model.proxy.no-credential", {
      agent: identity.callerName,
      note: "set ANTHROPIC_API_KEY (or a token) on the Deployment",
    });
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no model credential is configured on this Deployment" }));
    return;
  }

  const upstream = new URL(resolveModelUpstream(env));
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers.host = upstream.host;
  headers[credential.header] = credential.value;

  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const proxied = send(
    {
      protocol: upstream.protocol,
      host: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: `${upstream.pathname === "/" ? "" : upstream.pathname}${upstreamPath}${url.search}`,
      headers,
    },
    (upRes) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        out[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, out);
      // No `flushHeaders` dance needed — `writeHead` plus a piped body streams
      // SSE through as it arrives, which a turn depends on.
      upRes.pipe(res);
    },
  );
  proxied.on("error", (err) => {
    logger.log("error", "model.proxy.upstream-error", {
      agent: identity.callerName,
      path: upstreamPath,
      message: err.message,
    });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model upstream is unreachable" }));
    } else {
      res.end();
    }
  });
  req.pipe(proxied);
}
