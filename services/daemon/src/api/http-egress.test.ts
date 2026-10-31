import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpEgressHandler } from "./worker-egress.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "../agent/worker-tokens.js";

// Same seam as the CONNECT suite: a real resolver cannot be asked to return
// 169.254.169.254 for an allowlisted name, which is the case that matters.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

/** Lets the success cases reach a loopback upstream, which the policy denies. */
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
let origin: Server;
let originPort: number;
/** Every request the destination saw, so forwarding can be inspected. */
let seen: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
/** What the destination will answer with. */
let reply: { status: number; headers: Record<string, string>; body: string };

beforeEach(async () => {
  __resetWorkerTokensForTest();
  allowAnyAddress.value = false;
  seen = [];
  reply = { status: 200, headers: { "content-type": "text/plain" }, body: "UPSTREAM-BODY" };

  origin = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;

  const handler = createHttpEgressHandler({
    FRIDAY_EGRESS_ALLOWLIST: "allowed.example",
    FRIDAY_EGRESS_HTTP_PORT: String(originPort),
  });
  proxy = createHttpServer((req, res) => {
    if (handler(req, res)) return;
    res.writeHead(418, { "content-type": "text/plain" }).end("NOT-PROXY");
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterEach(async () => {
  proxy.closeAllConnections();
  await new Promise<void>((r) => proxy.close(() => r()));
  origin.closeAllConnections();
  await new Promise<void>((r) => origin.close(() => r()));
  __resetWorkerTokensForTest();
  lookupMock.mockReset();
});

function token(): string {
  return mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
}

/** Speak absolute-form at the proxy, the way a client addresses one. */
async function proxied(
  target: string,
  opts: {
    proxyAuth?: string;
    auth?: string;
    method?: string;
    body?: string;
  } = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (opts.proxyAuth) headers["proxy-authorization"] = opts.proxyAuth;
  if (opts.auth) headers.authorization = opts.auth;
  // `fetch` will not emit absolute-form, so the request line is written by
  // hand over a raw socket in `rawRequest` below.
  return rawRequest(opts.method ?? "GET", target, headers, opts.body);
}

function rawRequest(
  method: string,
  target: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string; headers: Headers }> {
  return new Promise((resolve, reject) => {
    void import("node:net").then(({ connect }) => {
      const sock = connect({ host: "127.0.0.1", port: proxyPort });
      let buf = "";
      sock.setTimeout(10_000, () => {
        sock.destroy();
        reject(new Error("timed out"));
      });
      sock.on("error", reject);
      sock.on("connect", () => {
        const lines = [`${method} ${target} HTTP/1.1`, "Host: proxy"];
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
        lines.push("Connection: close", "", body ?? "");
        sock.write(lines.join("\r\n"));
      });
      sock.on("data", (d) => (buf += d.toString("utf8")));
      sock.on("close", () => {
        const idx = buf.indexOf("\r\n\r\n");
        const head = idx >= 0 ? buf.slice(0, idx) : buf;
        const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0);
        const h = new Headers();
        for (const line of head.split("\r\n").slice(1)) {
          const i = line.indexOf(":");
          if (i > 0) {
            try {
              h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
            } catch {
              /* a header fetch's Headers refuses is not what is under test */
            }
          }
        }
        resolve({ status, body: idx >= 0 ? buf.slice(idx + 4) : "", headers: h });
      });
    });
  });
}

describe("plain-HTTP egress", () => {
  it("forwards an allowlisted request and relays the response", async () => {
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const res = await proxied(`http://allowed.example:${originPort}/pkg/thing.tgz?v=1`, {
      proxyAuth: `Bearer ${token()}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("UPSTREAM-BODY");
    // Origin-form reached the destination; absolute-form is for the proxy.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/pkg/thing.tgz?v=1");
  });

  it("preserves Host so name-based virtual hosts still route", async () => {
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await proxied(`http://allowed.example:${originPort}/x`, { proxyAuth: `Bearer ${token()}` });
    expect(seen[0]!.headers.host).toBe(`allowed.example:${originPort}`);
  });

  it("forwards a request body", async () => {
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await proxied(`http://allowed.example:${originPort}/submit`, {
      proxyAuth: `Bearer ${token()}`,
      method: "POST",
      body: "payload=1",
    });
    expect(seen[0]!.body).toBe("payload=1");
  });

  it("authenticates from a Basic proxy credential, which is what a proxy URL produces", async () => {
    // The broker puts the worker token in the proxy URL as userinfo, so every
    // tool that honours HTTPS_PROXY sends exactly this.
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const basic = Buffer.from(`x-friday:${token()}`).toString("base64");
    const res = await proxied(`http://allowed.example:${originPort}/x`, {
      proxyAuth: `Basic ${basic}`,
    });
    expect(res.status).toBe(200);
  });

  it("NEVER forwards the proxy credential upstream", async () => {
    // It is this hop's credential. Passing it on hands a worker token to
    // whatever host the builder named.
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await proxied(`http://allowed.example:${originPort}/x`, {
      proxyAuth: `Bearer ${token()}`,
    });
    expect(seen[0]!.headers["proxy-authorization"]).toBeUndefined();
  });

  it("consumes Authorization when that is what authenticated the hop", async () => {
    // CONNECT has accepted `Authorization` since slice 2, so it is accepted
    // here too — but then it is OURS, and must not travel on.
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await proxied(`http://allowed.example:${originPort}/x`, { auth: `Bearer ${token()}` });
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("passes Authorization THROUGH when the proxy was authenticated separately", async () => {
    // Then it is the builder's own credential for the destination — a registry
    // auth token — and stripping it would break private registries.
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await proxied(`http://allowed.example:${originPort}/x`, {
      proxyAuth: `Bearer ${token()}`,
      auth: "Bearer upstream-registry-token",
    });
    expect(seen[0]!.headers.authorization).toBe("Bearer upstream-registry-token");
  });

  it("does NOT follow redirects — a 302 inward would bypass the address check", async () => {
    allowAnyAddress.value = true;
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    reply = {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
      body: "",
    };
    const res = await proxied(`http://allowed.example:${originPort}/x`, {
      proxyAuth: `Bearer ${token()}`,
    });
    // Relayed to the client, not acted on. One upstream request, not two.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
    expect(seen).toHaveLength(1);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await proxied("http://allowed.example/x");
    expect(res.status).toBe(407);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a host that is not on the allowlist, before resolving it", async () => {
    const res = await proxied("http://evil.example/x", { proxyAuth: `Bearer ${token()}` });
    expect(res.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted host resolving to the metadata endpoint", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const res = await proxied(`http://allowed.example:${originPort}/x`, {
      proxyAuth: `Bearer ${token()}`,
    });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses the metadata endpoint named directly as an IP", async () => {
    const res = await proxied("http://169.254.169.254/latest/meta-data/", {
      proxyAuth: `Bearer ${token()}`,
    });
    expect(res.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a port other than the configured HTTP port", async () => {
    const res = await proxied("http://allowed.example:5432/x", {
      proxyAuth: `Bearer ${token()}`,
    });
    expect(res.status).toBe(403);
  });

  it("leaves the worker-facing routes alone", async () => {
    // Origin-form is not a proxy request. If this ever returns anything but
    // the fall-through, the proxy is shadowing the real routes.
    const res = await rawRequest("GET", "/api/memory", {});
    expect(res.status).toBe(418);
    expect(res.body).toContain("NOT-PROXY");
  });

  it("refuses an https absolute-form request — that is CONNECT's job", async () => {
    const res = await rawRequest("GET", "https://allowed.example/x", {
      "proxy-authorization": `Bearer ${token()}`,
    });
    // Falls through rather than being forwarded in cleartext.
    expect(res.status).toBe(418);
  });
});
