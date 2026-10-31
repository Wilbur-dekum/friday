import { lookup } from "node:dns/promises";
import { connect, type Socket } from "node:net";
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { logger } from "../log.js";
import { writeJson } from "./router.js";
import { workerFromRequest } from "./worker-listener.js";
import { resolveWorkerToken as resolveWorkerTokenValue } from "../agent/worker-tokens.js";
import {
  checkDestination,
  isBlockedAddress,
  resolveEgressAllowlist,
  resolveEgressPort,
  resolveHttpEgressPort,
} from "./egress-allowlist.js";

/**
 * The one way out of a builder container (FRI-2039, slice 2).
 *
 * Slice 3 puts the builder on an `--internal` Docker network, which has no
 * route off itself — so deny-by-default is structural rather than a rule, and
 * `169.254.169.254` is unreachable because there is no path to it, not because
 * something remembered to say no. This is the single allowlisted hole: an HTTP
 * CONNECT proxy on the worker-facing listener, which is already the only
 * daemon surface that network can see (FRI-2072).
 *
 * ## Why CONNECT, and why the daemon
 *
 * The container runs untrusted code with `CapDrop: ALL`, so enforcement cannot
 * live inside it — in-container firewall rules would be both unavailable and,
 * if available, removable by the code they constrain. It has to be enforced by
 * something the builder cannot reach the inside of.
 *
 * The daemon already is that thing: it sits on the builder network, already
 * authenticates workers with per-worker bearer tokens, and already holds the
 * repo and GitHub routes the builder lost direct access to. A sidecar proxy
 * would need its own auth story and its own supervision for no extra property.
 *
 * CONNECT tunnels bytes, so **TLS stays end-to-end**: the builder validates
 * the destination's certificate itself and the daemon never sees plaintext or
 * needs a CA. The daemon decides WHERE a connection may go, not what crosses
 * it, which is the smallest authority that implements the control.
 *
 * ## The hazard this creates, and how it is closed
 *
 * Putting the proxy in the trusted tier means the daemon's own reachability
 * becomes the builder's ceiling: a builder that can name a destination can
 * reach anything the DAEMON can, including the Deployment's own Postgres. Two
 * things close that, and both matter:
 *
 *  1. The allowlist is a list, not a filter — everything not on it is denied,
 *     Postgres included.
 *  2. **The connection is made to an address that was checked, not to the name
 *     that was allowed.** Resolving inside `net.connect` would leave a window
 *     between "this name resolves somewhere public" and "connect to this
 *     name", and DNS is the attacker's to change inside it. So the name is
 *     resolved once, every answer is checked, and the socket is opened to a
 *     literal.
 *
 * A name resolving to a MIX of allowed and blocked addresses is refused
 * outright rather than filtered down to the allowed ones: that shape is what a
 * rebinding attempt looks like, and no legitimate destination needs it.
 */

/**
 * Headers that belong to THIS hop and must never be forwarded upstream.
 *
 * RFC 9110's hop-by-hop set, plus `proxy-authorization` — which is the
 * builder's credential for the proxy, not for the destination, and forwarding
 * it would hand a worker token to whatever it was talking to.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Who is asking, and which header said so.
 *
 * `Proxy-Authorization` is the correct header for a proxy and the one real
 * tools send when the proxy URL carries credentials, which is how the broker
 * configures it. `Authorization` is also accepted because CONNECT has used it
 * since slice 2 — but for a forwarded request WHICH header authenticated
 * matters: `Authorization` belongs to the destination, so if that is what
 * authenticated the hop it has to be stripped rather than passed on, and if it
 * is not, it is the builder's own upstream credential and must be left alone.
 */
function proxyIdentity(req: IncomingMessage): {
  identity: ReturnType<typeof workerFromRequest>;
  consumedAuthorization: boolean;
} {
  const viaProxyHeader = req.headers["proxy-authorization"];
  if (typeof viaProxyHeader === "string") {
    const m = /^(?:Bearer|Basic) (.+)$/i.exec(viaProxyHeader.trim());
    const raw = m?.[1];
    if (raw) {
      // Bearer carries the token directly; Basic carries it as the password,
      // which is the shape a proxy URL with credentials produces.
      const asBearer = resolveWorkerTokenValue(raw);
      if (asBearer) return { identity: asBearer, consumedAuthorization: false };
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      const asBasic = resolveWorkerTokenValue(pass);
      if (asBasic) return { identity: asBasic, consumedAuthorization: false };
    }
    return { identity: null, consumedAuthorization: false };
  }
  return { identity: workerFromRequest(req), consumedAuthorization: true };
}

/** How long to wait for the upstream TCP connection before giving up. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

function refuse(socket: Socket, status: number, reason: string): void {
  // A CONNECT refusal is an HTTP response on the raw socket, which is all the
  // client has agreed to speak at this point. The reason is a short token, not
  // the detail — the client is the untrusted side.
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

/**
 * Resolve `host` and return an address safe to connect to.
 *
 * Returns null when the name does not resolve or when ANY answer is blocked.
 */
async function safeAddressFor(
  host: string,
): Promise<{ address: string; family: number } | { blocked: string } | null> {
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(host, { all: true });
  } catch {
    return null;
  }
  if (answers.length === 0) return null;
  const blocked = answers.find((a) => isBlockedAddress(a.address));
  if (blocked) return { blocked: blocked.address };
  return { address: answers[0]!.address, family: answers[0]!.family };
}

/**
 * Serve CONNECT on the worker-facing listener.
 *
 * On the worker listener ONLY. The loopback listener has no business proxying
 * for anyone, and a daemon reachable at `127.0.0.1` that will open arbitrary
 * outbound connections is an SSRF primitive for anything else on the host.
 */
export function attachEgressProxy(server: Server, env: NodeJS.ProcessEnv = process.env): void {
  const allow = resolveEgressAllowlist(env);
  const allowedPort = resolveEgressPort(env);
  logger.log("warn", "egress.proxy.attached", {
    allowlist: allow,
    port: allowedPort,
    note:
      allow.length === 0
        ? "egress is fully closed for builders"
        : `builders may reach these hosts on ${allowedPort} and nothing else`,
  });

  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());

    const { identity } = proxyIdentity(req);
    if (!identity) {
      // Same rule the routes follow: the per-worker token only, never the
      // shared daemon secret, which sits on a volume any builder can read.
      logger.log("warn", "egress.deny", { reason: "unauthenticated", target: req.url });
      refuse(socket, 407, "Proxy Authentication Required");
      return;
    }

    const verdict = checkDestination(req.url ?? "", allow, allowedPort);
    if (!verdict.ok) {
      logger.log("warn", "egress.deny", {
        agent: identity.callerName,
        target: req.url,
        reason: verdict.reason,
      });
      refuse(socket, 403, "Forbidden");
      return;
    }

    void (async () => {
      const resolved = await safeAddressFor(verdict.host);
      if (resolved === null) {
        logger.log("warn", "egress.deny", {
          agent: identity.callerName,
          host: verdict.host,
          reason: "does not resolve",
        });
        refuse(socket, 502, "Bad Gateway");
        return;
      }
      if ("blocked" in resolved) {
        // The case the ticket is really about: an allowlisted NAME pointing at
        // an address a builder must never reach.
        logger.log("error", "egress.deny", {
          agent: identity.callerName,
          host: verdict.host,
          address: resolved.blocked,
          reason: "allowlisted host resolved to a blocked address",
        });
        refuse(socket, 403, "Forbidden");
        return;
      }

      // To the ADDRESS, never the name. See this module's header.
      const upstream = connect({ host: resolved.address, port: verdict.port });
      upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy());
      upstream.on("error", () => {
        refuse(socket, 502, "Bad Gateway");
        upstream.destroy();
      });
      upstream.on("connect", () => {
        upstream.setTimeout(0);
        logger.log("info", "egress.allow", {
          agent: identity.callerName,
          host: verdict.host,
          address: resolved.address,
          port: verdict.port,
        });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Bytes the client already sent after the CONNECT line belong to the
        // tunnel, not to the request — without this the TLS ClientHello is
        // silently dropped and the handshake hangs.
        if (head?.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    })();
  });
}

/**
 * Plain-HTTP egress (FRI-2039).
 *
 * CONNECT covers TLS, which is nearly everything — but a build that fetches
 * `http://` got nothing at all, and "fails closed" is only the right answer
 * while nobody needs the thing. This forwards absolute-form requests
 * (`GET http://host/path HTTP/1.1`, which is how a client addresses a proxy
 * for cleartext) to the same allowlist.
 *
 * ## This is a bigger authority than CONNECT, and worth naming
 *
 * CONNECT only ever had the daemon open a TCP socket and shovel bytes it could
 * not read. Here the daemon ISSUES an HTTP request on behalf of untrusted code
 * — an SSRF primitive whose only bounds are the allowlist and the address
 * check. Three consequences handled explicitly:
 *
 *  1. **Redirects are not followed.** `http.request` does not follow them and
 *     this does not add it. A 302 to `http://169.254.169.254/` would otherwise
 *     be a checked request turning into an unchecked one. The response is
 *     relayed as-is and the client's own retry comes back through here and is
 *     re-checked from scratch.
 *  2. **The proxy credential is never forwarded.** `Proxy-Authorization` is
 *     hop-by-hop, and if `Authorization` is what authenticated this hop it is
 *     consumed rather than passed on — otherwise a builder's worker token
 *     would be handed to whatever host it named.
 *  3. **The upstream connection goes to a checked address**, exactly as in
 *     CONNECT, with `Host` preserved so the destination still routes and
 *     name-based virtual hosts still work.
 */
export function createHttpEgressHandler(
  env: NodeJS.ProcessEnv = process.env,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const allow = resolveEgressAllowlist(env);
  const httpPort = resolveHttpEgressPort(env);

  return (req, res) => {
    // Absolute-form is the ONLY shape a proxy request takes, which is what
    // keeps this from shadowing the worker-facing routes: those arrive in
    // origin-form (`/api/...`) and are not ours.
    if (!req.url || !/^http:\/\//i.test(req.url)) return false;

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      writeJson(res, 400, { error: "malformed absolute-form request" });
      return true;
    }

    const { identity, consumedAuthorization } = proxyIdentity(req);
    if (!identity) {
      logger.log("warn", "egress.deny", { reason: "unauthenticated", target: req.url });
      res.writeHead(407, { "proxy-authenticate": "Bearer" }).end();
      return true;
    }

    const port = url.port ? Number(url.port) : httpPort;
    const verdict = checkDestination(`${url.hostname}:${port}`, allow, httpPort);
    if (!verdict.ok) {
      logger.log("warn", "egress.deny", {
        agent: identity.callerName,
        target: `${url.hostname}:${port}`,
        scheme: "http",
        reason: verdict.reason,
      });
      writeJson(res, 403, { error: "destination is not permitted" });
      return true;
    }

    void (async () => {
      const resolved = await safeAddressFor(verdict.host);
      if (resolved === null) {
        logger.log("warn", "egress.deny", {
          agent: identity.callerName,
          host: verdict.host,
          reason: "does not resolve",
        });
        writeJson(res, 502, { error: "destination did not resolve" });
        return;
      }
      if ("blocked" in resolved) {
        logger.log("error", "egress.deny", {
          agent: identity.callerName,
          host: verdict.host,
          address: resolved.blocked,
          reason: "allowlisted host resolved to a blocked address",
        });
        writeJson(res, 403, { error: "destination is not permitted" });
        return;
      }

      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        if (consumedAuthorization && k.toLowerCase() === "authorization") continue;
        headers[k] = v;
      }
      // The name, not the address it resolved to: the destination still has to
      // route this, and a name-based virtual host would otherwise 404.
      headers.host = url.port ? `${verdict.host}:${url.port}` : verdict.host;

      const upstream = httpRequest(
        {
          host: resolved.address,
          port: verdict.port,
          method: req.method,
          // Origin-form for the destination; absolute-form is for us.
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (upRes) => {
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            if (HOP_BY_HOP.has(k.toLowerCase())) continue;
            out[k] = v;
          }
          logger.log("info", "egress.allow", {
            agent: identity.callerName,
            host: verdict.host,
            address: resolved.address,
            port: verdict.port,
            scheme: "http",
            status: upRes.statusCode,
          });
          res.writeHead(upRes.statusCode ?? 502, out);
          upRes.pipe(res);
        },
      );
      upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) writeJson(res, 502, { error: "destination is unreachable" });
        else res.end();
      });
      req.pipe(upstream);
    })();
    return true;
  };
}
