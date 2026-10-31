import { lookup } from "node:dns/promises";
import { connect, type Socket } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import { logger } from "../log.js";
import { workerFromRequest } from "./worker-listener.js";
import {
  checkDestination,
  isBlockedAddress,
  resolveEgressAllowlist,
  resolveEgressPort,
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

    const identity = workerFromRequest(req);
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
