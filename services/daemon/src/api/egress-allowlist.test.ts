import { describe, expect, it } from "vitest";
import {
  ALLOWED_EGRESS_PORT,
  DEFAULT_EGRESS_ALLOWLIST,
  checkDestination,
  hostAllowed,
  isBlockedAddress,
  resolveEgressAllowlist,
} from "./egress-allowlist.js";

describe("the allowlist in force", () => {
  it("defaults to the built-in list when unset or empty", () => {
    expect(resolveEgressAllowlist({})).toEqual(DEFAULT_EGRESS_ALLOWLIST);
    expect(resolveEgressAllowlist({ FRIDAY_EGRESS_ALLOWLIST: "   " })).toEqual(
      DEFAULT_EGRESS_ALLOWLIST,
    );
  });

  it("REPLACES the default rather than appending to it", () => {
    // Otherwise the set in force is the union of a default and a local
    // override, and no single place shows what a builder can reach.
    const allow = resolveEgressAllowlist({ FRIDAY_EGRESS_ALLOWLIST: "registry.example" });
    expect(allow).toEqual(["registry.example"]);
    expect(allow).not.toContain("api.anthropic.com");
  });

  it("closes egress entirely on the literal `none`", () => {
    // Spelled out, so the safest configuration is distinguishable from a typo
    // that produced an empty value.
    expect(resolveEgressAllowlist({ FRIDAY_EGRESS_ALLOWLIST: "none" })).toEqual([]);
    expect(resolveEgressAllowlist({ FRIDAY_EGRESS_ALLOWLIST: "NONE" })).toEqual([]);
  });

  it("splits on commas and whitespace, and lowercases", () => {
    expect(
      resolveEgressAllowlist({ FRIDAY_EGRESS_ALLOWLIST: "A.example, b.example\nc.example" }),
    ).toEqual(["a.example", "b.example", "c.example"]);
  });

  it("does not ship the git host — the daemon serves git now", () => {
    // FRI-2076/2077 put git behind the daemon's route and FRI-2078 the GitHub
    // API, so the ticket's original "allowlist the git host" is obsolete. If
    // this ever comes back it should come back deliberately.
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain("github.com");
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain("api.github.com");
  });
});

describe("hostname matching", () => {
  it("matches an exact entry", () => {
    expect(hostAllowed("api.anthropic.com", ["api.anthropic.com"])).toBe(true);
  });

  it("does NOT treat a bare entry as a wildcard for its subdomains", () => {
    // An attacker who can create a record under a compromised zone would
    // otherwise reach the proxy with a name that passes the allowlist.
    expect(hostAllowed("evil.api.anthropic.com", ["api.anthropic.com"])).toBe(false);
  });

  it("matches subdomains only for an entry written with a leading dot", () => {
    expect(hostAllowed("a.cdn.example", [".cdn.example"])).toBe(true);
    // ...and the bare parent is not itself a subdomain of the dotted entry.
    expect(hostAllowed("cdn.example", [".cdn.example"])).toBe(false);
  });

  it("is case-insensitive and tolerates the root dot", () => {
    expect(hostAllowed("API.Anthropic.COM.", ["api.anthropic.com"])).toBe(true);
  });

  it("matches nothing against an empty allowlist", () => {
    expect(hostAllowed("api.anthropic.com", [])).toBe(false);
  });

  it("is not fooled by an entry that is a suffix of the host as a STRING", () => {
    // `notanthropic.com` ends with `anthropic.com` textually; it is a
    // different domain. Only a dot-delimited boundary counts.
    expect(hostAllowed("notapi.anthropic.com", ["api.anthropic.com"])).toBe(false);
    expect(hostAllowed("evilanthropic.com", [".anthropic.com"])).toBe(false);
  });
});

describe("blocked addresses — the destination half of destination-based", () => {
  it("denies the cloud metadata endpoint, which the ticket names", () => {
    // An ACCOUNT-level compromise rather than a Deployment-level one.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("denies it through an IPv4-mapped IPv6 literal too", () => {
    // Same destination, unrecognisable spelling.
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::FFFF:169.254.169.254")).toBe(true);
  });

  it("denies every private and special-purpose v4 range", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.1",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public v4 addresses, including near-miss neighbours", () => {
    for (const ip of [
      "1.1.1.1",
      "160.254.169.254", // not 169.
      "169.253.0.1", // not .254
      "169.255.0.1",
      "172.15.0.1", // just below the private block
      "172.32.0.1", // just above it
      "192.167.0.1",
      "192.1.0.1",
      "100.63.0.1",
      "100.128.0.1",
      "223.255.255.255", // just below multicast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("denies v6 loopback, unique-local, link-local, multicast and NAT64", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "64:ff9b::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows an ordinary public v6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("denies anything that is not an address at all", () => {
    // Fail closed: a resolver result this cannot parse is never connected to.
    for (const junk of ["", "not-an-ip", "999.999.999.999", "1.2.3"]) {
      expect(isBlockedAddress(junk), junk).toBe(true);
    }
  });
});

describe("the CONNECT target", () => {
  const allow = ["api.anthropic.com"];

  it("accepts an allowlisted host on 443", () => {
    expect(checkDestination("api.anthropic.com:443", allow)).toEqual({
      ok: true,
      host: "api.anthropic.com",
      port: 443,
    });
  });

  it("refuses every port but 443", () => {
    // Without this, a permitted hostname is also a permitted :22 and :5432 —
    // and plain HTTP would be an unencrypted channel out.
    for (const p of [22, 80, 5432, 7611]) {
      const v = checkDestination(`api.anthropic.com:${p}`, allow);
      expect(v.ok, String(p)).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/only port 443/);
    }
    expect(ALLOWED_EGRESS_PORT).toBe(443);
  });

  it("refuses an IP literal before it ever reaches a resolver", () => {
    for (const t of ["169.254.169.254:443", "1.1.1.1:443", "[::1]:443", "[::ffff:10.0.0.1]:443"]) {
      const v = checkDestination(t, allow);
      expect(v.ok, t).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/hostname, not an IP/);
    }
  });

  it("refuses a host that is not on the list", () => {
    const v = checkDestination("evil.example:443", allow);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/not on the allowlist/);
  });

  it("refuses malformed targets", () => {
    for (const t of ["", "api.anthropic.com", ":443", "api.anthropic.com:", "a:b"]) {
      expect(checkDestination(t, allow).ok, JSON.stringify(t)).toBe(false);
    }
  });

  it("splits on the LAST colon, so a bracketed v6 literal is not read as host:port", () => {
    // `[::1]:443` must be recognised as the literal `::1`, not as a host
    // `[` with a port made of its own hextets — otherwise it slips past the
    // IP-literal refusal into DNS.
    const v = checkDestination("[::1]:443", allow);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/hostname, not an IP/);
  });
});
