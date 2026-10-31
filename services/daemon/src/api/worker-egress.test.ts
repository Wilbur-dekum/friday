import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer, connect, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachEgressProxy } from "./worker-egress.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "../agent/worker-tokens.js";

// The proxy resolves hostnames before connecting, and the whole point of the
// control is what it does with the ANSWER. So DNS is the seam: a real resolver
// cannot be asked to return 169.254.169.254 for a name on the allowlist, which
// is precisely the case that matters.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

/**
 * Lets ONE test suspend the blocked-address policy.
 *
 * Every address a test can actually bind is one the control denies on purpose
 * — loopback and the RFC1918 ranges are the whole local address space — so the
 * tunnel cannot be exercised end to end while that policy is in force. The
 * policy itself is tested exhaustively in `egress-allowlist.test.ts`; what is
 * left for this file is the proxy's PLUMBING, and a suite with no success case
 * would pass against a proxy that refused everything.
 */
const allowAnyAddress = vi.hoisted(() => ({ value: false }));
vi.mock("./egress-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./egress-allowlist.js")>();
  return {
    ...actual,
    isBlockedAddress: (ip: string) => (allowAnyAddress.value ? false : actual.isBlockedAddress(ip)),
  };
});

let proxy: Server;
let proxyPort: number;
let upstream: TcpServer;
let upstreamPort: number;
/** What the upstream received, so a tunnel can be proven to carry bytes. */
let received: string[];

beforeEach(async () => {
  __resetWorkerTokensForTest();
  allowAnyAddress.value = false;
  received = [];
  upstream = createTcpServer((sock) => {
    sock.on("data", (d) => {
      received.push(d.toString("utf8"));
      sock.write("PONG");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  proxy = createHttpServer((_req, res) => res.writeHead(404).end());
  attachEgressProxy(proxy, { FRIDAY_EGRESS_ALLOWLIST: "allowed.example" });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterEach(async () => {
  proxy.closeAllConnections();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  __resetWorkerTokensForTest();
  lookupMock.mockReset();
  __resetWorkerTokensForTest();
});

/**
 * Speak CONNECT at the proxy and return its status line.
 *
 * Raw sockets rather than a client library: CONNECT is the thing under test,
 * and a library that abstracts it would also abstract the refusals.
 */
function doConnect(
  target: string,
  opts: { token?: string | null; body?: string } = {},
): Promise<{ status: string; tunnelled: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port: proxyPort });
    let buf = "";
    let status = "";
    sock.on("error", reject);
    sock.setTimeout(10_000, () => {
      sock.destroy();
      reject(new Error("client timed out"));
    });
    sock.on("connect", () => {
      const auth = opts.token === null ? "" : `Authorization: Bearer ${opts.token}\r\n`;
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
      if (opts.body) sock.write(opts.body);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (!status && buf.includes("\r\n")) status = buf.split("\r\n")[0]!;
      // Established + a tunnelled reply, or a refusal — either way we are done.
      if (status.includes("200") ? buf.includes("PONG") : true) {
        const idx = buf.indexOf("\r\n\r\n");
        const tunnelled = idx >= 0 ? buf.slice(idx + 4) : "";
        sock.destroy();
        resolve({ status, tunnelled });
      }
    });
    sock.on("close", () => resolve({ status, tunnelled: "" }));
  });
}

function token(): string {
  return mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
}

describe("the allowlisted hole", () => {
  it("TUNNELS bytes to an allowlisted host, connecting to the resolved address", async () => {
    // Without this case the suite is made entirely of refusals, and a proxy
    // that refused everything would pass all of them. `FRIDAY_EGRESS_PORT`
    // exists so this path is reachable at all: 443 needs root to bind.
    const open = createHttpServer((_req, res) => res.writeHead(404).end());
    attachEgressProxy(open, {
      FRIDAY_EGRESS_ALLOWLIST: "allowed.example",
      FRIDAY_EGRESS_PORT: String(upstreamPort),
    });
    await new Promise<void>((r) => open.listen(0, "127.0.0.1", r));
    const saved = proxyPort;
    proxyPort = (open.address() as AddressInfo).port;
    // The name is allowlisted; DNS points it at the loopback upstream. The
    // proxy must connect to the ADDRESS this returns, not re-resolve the name.
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    allowAnyAddress.value = true;
    try {
      const res = await doConnect(`allowed.example:${upstreamPort}`, {
        token: token(),
        body: "HELLO",
      });
      expect(res.status).toContain("200");
      // The bytes sent straight after the CONNECT line are the `head` buffer;
      // dropping them is how a tunnel silently hangs the TLS handshake.
      expect(received.join("")).toContain("HELLO");
      // And the reply came back through the tunnel.
      expect(res.tunnelled).toContain("PONG");
    } finally {
      proxyPort = saved;
      open.closeAllConnections();
      await new Promise<void>((r) => open.close(() => r()));
    }
  });

  it("refuses an unauthenticated CONNECT", async () => {
    // The per-worker token only. The shared daemon secret sits on a volume any
    // builder can read, so on a network boundary it identifies nothing.
    lookupMock.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    const res = await doConnect("allowed.example:443", { token: null });
    expect(res.status).toContain("407");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a forged token", async () => {
    const res = await doConnect("allowed.example:443", { token: "not-a-real-token" });
    expect(res.status).toContain("407");
  });

  it("refuses a host that is not on the allowlist, before resolving it", async () => {
    // Order matters: a denied name must not even be looked up, or the proxy is
    // a DNS oracle for the untrusted side.
    const res = await doConnect("evil.example:443", { token: token() });
    expect(res.status).toContain("403");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted host that resolves to the metadata endpoint", async () => {
    // THE case the ticket is about. The name passes the allowlist; the answer
    // is an account-level compromise.
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const res = await doConnect("allowed.example:443", { token: token() });
    expect(res.status).toContain("403");
  });

  it("refuses when ANY answer is blocked, not just when all of them are", async () => {
    // A mix of public and blocked answers is what a rebinding attempt looks
    // like; no legitimate destination needs it. Filtering down to the allowed
    // ones would make the attack a retry loop.
    lookupMock.mockResolvedValue([
      { address: "1.2.3.4", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const res = await doConnect("allowed.example:443", { token: token() });
    expect(res.status).toContain("403");
  });

  it("refuses a name that does not resolve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    const res = await doConnect("allowed.example:443", { token: token() });
    expect(res.status).toContain("502");
  });

  it("refuses an empty answer rather than connecting to nothing", async () => {
    lookupMock.mockResolvedValue([]);
    const res = await doConnect("allowed.example:443", { token: token() });
    expect(res.status).toContain("502");
  });

  it("refuses a port other than 443 even for an allowlisted host", async () => {
    lookupMock.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    for (const port of [22, 80, 5432]) {
      const res = await doConnect(`allowed.example:${port}`, { token: token() });
      expect(res.status, String(port)).toContain("403");
    }
  });

  it("refuses an IP literal, so the allowlist cannot be sidestepped", async () => {
    const res = await doConnect("169.254.169.254:443", { token: token() });
    expect(res.status).toContain("403");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("closes egress entirely when the allowlist is `none`", async () => {
    const closed = createHttpServer((_req, res) => res.writeHead(404).end());
    attachEgressProxy(closed, { FRIDAY_EGRESS_ALLOWLIST: "none" });
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    const saved = proxyPort;
    proxyPort = port;
    try {
      const res = await doConnect("allowed.example:443", { token: token() });
      expect(res.status).toContain("403");
    } finally {
      proxyPort = saved;
      closed.closeAllConnections();
      await new Promise<void>((r) => closed.close(() => r()));
    }
  });
});
