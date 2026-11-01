import { isIP } from "node:net";

/**
 * What a builder container is allowed to talk to (FRI-2039).
 *
 * ADR-054 makes egress deny-by-default a launch gate: a malicious postinstall
 * may run, but it must not be able to exfiltrate or phone home. The deny half
 * is structural — the builder sits on an `--internal` Docker network with no
 * route off it — so this module is only the narrow hole punched back through,
 * and the whole security property of that hole is in `checkDestination`.
 *
 * ## Why the list is shorter than the ticket assumed
 *
 * FRI-2039 was written expecting to allowlist "the git host and package
 * registries". It no longer needs the git host: FRI-2076/2077 put git behind
 * the daemon's own route and FRI-2078 did the same for the GitHub API, so a
 * builder reaches neither directly. What is irreducible is the Anthropic API —
 * the Claude SDK runs INSIDE the worker, so the process doing the untrusted
 * work is also the one that must reach the model — plus the package registries
 * a build legitimately installs from.
 *
 * ## Hostnames, and why that is not enough on its own
 *
 * The ticket's requirement is that the allowlist be **destination-based**, and
 * a hostname allowlist alone is not: `evil.example` can simply have an A record
 * pointing at `169.254.169.254`, and the cloud metadata endpoint is an
 * ACCOUNT-level compromise rather than a Deployment-level one. So a hostname
 * match is necessary but never sufficient — every address the name resolves to
 * is checked with `isBlockedAddress`, and the caller connects to a checked
 * ADDRESS rather than re-resolving the name, so there is no window between the
 * check and the connection for the answer to change.
 */

/**
 * The default allowlist.
 *
 * Deliberately not configurable to something wider by accident: an operator
 * who needs another host sets `FRIDAY_EGRESS_ALLOWLIST` and that REPLACES this
 * list rather than appending to it, so the full set is always visible in one
 * place rather than being the union of a default and a local override.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  // NOT `api.anthropic.com`. FRI-2084 made model access `brokered` — the
  // builder sends model traffic to the daemon's own route, which injects the
  // credential — so the model is reachable without the builder being able to
  // reach Anthropic directly. That is the shape ADR-055 rule 2 wants: closing
  // the credential gap SHRANK the permitted destination set instead of
  // growing it.
  //
  // Package registries. `registry.npmjs.org` serves metadata; tarballs come
  // from the same host today, and the CDN is listed because npm has served
  // them from there historically and a build that hits it fails closed.
  "registry.npmjs.org",
  "registry.yarnpkg.com",
] as const;

/** Only 443, unless an operator says otherwise. See `resolveEgressPort`. */
export const DEFAULT_EGRESS_PORT = 443;

/**
 * The one port CONNECT will proxy.
 *
 * Overridable because otherwise the SUCCESS path is untestable: 443 needs root
 * to bind, so a test can only ever observe refusals, and a proxy that refused
 * everything would pass a suite made entirely of refusal cases. The default is
 * pinned by its own test.
 *
 * Widening this is an operator action, like the allowlist itself — the trust
 * boundary here is the builder, not the person configuring the Deployment. It
 * stays ONE port either way, so a permitted host never becomes a permitted
 * `:22` as well.
 */
export function resolveEgressPort(env: NodeJS.ProcessEnv = process.env): number {
  return portFrom(env.FRIDAY_EGRESS_PORT, DEFAULT_EGRESS_PORT);
}

/** Plain HTTP's port. Separate from the CONNECT port; see `resolveEgressPort`. */
export const DEFAULT_HTTP_EGRESS_PORT = 80;

/**
 * The one port plain-HTTP egress will forward to.
 *
 * Overridable for the same reason as the CONNECT port: 80 needs root to bind,
 * so the success path would otherwise be untestable. The default is pinned.
 */
export function resolveHttpEgressPort(env: NodeJS.ProcessEnv = process.env): number {
  return portFrom(env.FRIDAY_EGRESS_HTTP_PORT, DEFAULT_HTTP_EGRESS_PORT);
}

function portFrom(raw: string | undefined, fallback: number): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

/**
 * The allowlist in force, newline/comma separated from the environment.
 *
 * An empty or unset value means the default. An operator who wants egress
 * fully closed sets `FRIDAY_EGRESS_ALLOWLIST=none`, which is spelled out
 * rather than being the same as "unset" — otherwise the safest configuration
 * and a typo would be indistinguishable.
 */
export function resolveEgressAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.FRIDAY_EGRESS_ALLOWLIST?.trim();
  if (!raw) return DEFAULT_EGRESS_ALLOWLIST;
  if (raw.toLowerCase() === "none") return [];
  return raw
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Does `host` match the allowlist?
 *
 * Exact match, or a subdomain of an entry written with a leading dot. A bare
 * entry does NOT match its own subdomains: `api.anthropic.com` must not also
 * admit `evil.api.anthropic.com`, which an attacker who can create a record
 * under a compromised zone would otherwise reach.
 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) =>
    entry.startsWith(".") ? h.endsWith(entry) && h.length > entry.length : h === entry,
  );
}

/** Parse an IPv4 dotted quad into its four octets, or null. */
function v4Octets(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map((p) => Number(p));
}

/**
 * Addresses a builder may never reach, whatever name resolved to them.
 *
 * `169.254.0.0/16` is the one the ticket calls out by name, but every private
 * and special-purpose range is denied: the builder's network has no route to
 * them anyway, so the only way one arrives here is a name chosen to reach back
 * into the Deployment's own network through the proxy — the daemon's
 * reachability becoming the builder's, which is the hazard of putting the
 * proxy in the trusted tier at all.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return true; // not an address at all → never connect to it

  if (kind === 4) {
    const o = v4Octets(ip)!;
    const [a, b] = [o[0]!, o[1]!];
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // LINK-LOCAL — cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  const v6 = ip.toLowerCase().replace(/%.*$/, "");
  // An IPv4-mapped or -embedded address carries a v4 destination inside a v6
  // literal: `::ffff:169.254.169.254` reaches the metadata endpoint while
  // looking nothing like it. Check what it actually targets.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (embedded) return isBlockedAddress(embedded[1]!);
  if (v6 === "::" || v6 === "::1") return true; // unspecified, loopback
  if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link-local
  if (/^ff/.test(v6)) return true; // ff00::/8 multicast
  if (/^64:ff9b:/.test(v6)) return true; // NAT64 — a v4 destination in disguise
  return false;
}

export type DestinationVerdict =
  | { ok: true; host: string; port: number }
  | { ok: false; reason: string };

/**
 * Validate a CONNECT target.
 *
 * Three refusals, each closing a different way round the hostname allowlist:
 *
 * - **A port other than `allowedPort`.** Deny-by-default means the hole is one protocol
 *   wide. Plain HTTP is not proxied at all, so a build that needs it fails
 *   closed rather than getting an unencrypted channel out; and without this a
 *   permitted hostname would also be a permitted `:22` or `:5432`.
 * - **An IP literal.** The allowlist is by name, so a literal can never match
 *   it — but refusing explicitly says why, and means the literal never reaches
 *   DNS resolution at all.
 * - **A name not on the list.** The default.
 */
export function checkDestination(
  raw: string,
  allow: readonly string[],
  allowedPort: number = DEFAULT_EGRESS_PORT,
): DestinationVerdict {
  const target = raw.trim();
  // Split on the LAST colon so a bracketed IPv6 literal does not parse as a
  // host with a port made of its own hextets.
  const idx = target.lastIndexOf(":");
  if (idx <= 0) return { ok: false, reason: "destination must be host:port" };
  const rawHost = target.slice(0, idx);
  const port = Number(target.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: "destination port is not a port" };
  }
  if (port !== allowedPort) {
    return { ok: false, reason: `only port ${allowedPort} is proxied` };
  }
  // `[::1]:443` — strip the brackets before asking whether it is a literal.
  const host = rawHost.replace(/^\[(.+)\]$/, "$1").toLowerCase();
  if (host.length === 0) return { ok: false, reason: "destination has no host" };
  if (isIP(host) !== 0) return { ok: false, reason: "destination must be a hostname, not an IP" };
  if (!hostAllowed(host, allow))
    return { ok: false, reason: "destination is not on the allowlist" };
  return { ok: true, host, port };
}
