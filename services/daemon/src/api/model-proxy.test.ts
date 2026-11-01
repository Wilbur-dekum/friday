import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_UPSTREAM,
  handleModelProxy,
  resolveModelUpstream,
  upstreamCredential,
  upstreamPathFor,
} from "./model-proxy.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "../agent/worker-tokens.js";

let proxy: Server;
let proxyPort: number;
let upstream: Server;
let upstreamPort: number;
/** Everything the fake Anthropic saw, so header handling can be inspected. */
let seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[];
let reply: { status: number; headers: Record<string, string>; chunks: string[] };

beforeEach(async () => {
  __resetWorkerTokensForTest();
  seen = [];
  reply = { status: 200, headers: { "content-type": "application/json" }, chunks: ['{"ok":true}'] };

  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(reply.status, reply.headers);
      // Written as separate chunks with a gap, so a buffering proxy is
      // distinguishable from a streaming one.
      for (const c of reply.chunks) {
        res.write(c);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const env = {
    FRIDAY_MODEL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    ANTHROPIC_API_KEY: "sk-real-deployment-key",
  } as NodeJS.ProcessEnv;
  proxy = createServer((req, res) => handleModelProxy(req, res, env));
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterEach(async () => {
  proxy.closeAllConnections();
  await new Promise<void>((r) => proxy.close(() => r()));
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
  __resetWorkerTokensForTest();
});

function token(): string {
  return mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
}

async function call(
  path: string,
  opts: {
    token?: string | null;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? token()}`;
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body,
  });
  return { status: res.status, body: await res.text() };
}

describe("the brokered model path", () => {
  it("swaps the worker's token for the Deployment's credential", async () => {
    // The whole point: the builder presents a worker token, Anthropic sees the
    // real key, and the worker token does not leave the Deployment.
    const res = await call("/api/model/v1/messages", { body: '{"model":"x"}' });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-real-deployment-key");
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body).toBe('{"model":"x"}');
  });

  it("refuses a request with no worker token", async () => {
    const res = await call("/api/model/v1/messages", { token: null });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses a forged worker token", async () => {
    const res = await call("/api/model/v1/messages", { token: "not-a-token" });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("does not let a caller pin its own upstream credential", async () => {
    // A builder that could set `x-api-key` would choose which account pays,
    // and could use the route as a generic Anthropic proxy for a stolen key.
    const res = await call("/api/model/v1/messages", {
      headers: { "x-api-key": "sk-attacker-key" },
    });
    expect(res.status).toBe(200);
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-real-deployment-key");
  });

  it("strips a caller's x-api-key even when the Deployment authenticates by TOKEN", async () => {
    // The case the test above cannot see. With an API-key Deployment the
    // injected header happens to overwrite the caller's, so dropping it looks
    // redundant. With a bearer-token Deployment the injected header is
    // `authorization`, nothing overwrites `x-api-key`, and a caller-supplied
    // one would ride along to Anthropic. Mutation-confirmed: removing the drop
    // entry fails only this case.
    const tokenProxy = createServer((req, res) =>
      handleModelProxy(req, res, {
        FRIDAY_MODEL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        ANTHROPIC_AUTH_TOKEN: "deployment-bearer",
      } as NodeJS.ProcessEnv),
    );
    await new Promise<void>((r) => tokenProxy.listen(0, "127.0.0.1", r));
    const port = (tokenProxy.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/model/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token()}`,
          "x-api-key": "sk-attacker-key",
        },
      });
      expect(res.status).toBe(200);
      expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
      expect(seen[0]!.headers.authorization).toBe("Bearer deployment-bearer");
    } finally {
      tokenProxy.closeAllConnections();
      await new Promise<void>((r) => tokenProxy.close(() => r()));
    }
  });

  it("passes the SDK's own headers through", async () => {
    // `anthropic-version` and `anthropic-beta` are the SDK's to choose; the
    // proxy has no business editing them.
    await call("/api/model/v1/messages", {
      headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "some-beta" },
    });
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.headers["anthropic-beta"]).toBe("some-beta");
  });

  it("streams the response instead of buffering it", async () => {
    // A turn is a long SSE response; buffering would delay every block to the
    // end of the turn and hold a whole response per active worker.
    //
    // Gated rather than timed. A threshold is a guess about machine speed, and
    // a buffering proxy passed the timed version. Here the upstream sends one
    // event and then WAITS: if the first event reaches the client the proxy is
    // streaming, and if the proxy buffers it cannot arrive at all, because the
    // response has not ended. The race turns that into a failed assertion
    // instead of a hung test.
    let openGate = () => {};
    const gate = new Promise<void>((r) => (openGate = r));
    const gated = createServer((req, res) => {
      req.resume();
      req.on("end", async () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: first\n\n");
        await gate;
        res.end("event: last\n\n");
      });
    });
    await new Promise<void>((r) => gated.listen(0, "127.0.0.1", r));
    const gatedPort = (gated.address() as AddressInfo).port;
    const proxyToGated = createServer((req, res) =>
      handleModelProxy(req, res, {
        FRIDAY_MODEL_UPSTREAM: `http://127.0.0.1:${gatedPort}`,
        ANTHROPIC_API_KEY: "k",
      } as NodeJS.ProcessEnv),
    );
    await new Promise<void>((r) => proxyToGated.listen(0, "127.0.0.1", r));
    const port = (proxyToGated.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/model/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token()}` },
      });
      const reader = res.body!.getReader();
      const first = await Promise.race([
        reader.read().then((r) => new TextDecoder().decode(r.value)),
        new Promise<string>((r) => setTimeout(() => r("__NOTHING_ARRIVED__"), 2_000)),
      ]);
      expect(first).toContain("event: first");
      openGate();
      await reader.cancel();
    } finally {
      openGate();
      proxyToGated.closeAllConnections();
      await new Promise<void>((r) => proxyToGated.close(() => r()));
      gated.closeAllConnections();
      await new Promise<void>((r) => gated.close(() => r()));
    }
  });

  it("refuses a path that is not a model endpoint", async () => {
    for (const p of [
      "/api/model/v1/organizations/me",
      "/api/model/internal/admin",
      "/api/model/",
      "/api/model/v2/messages",
    ]) {
      const res = await call(p);
      expect(res.status, p).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses percent-encoded traversal over the wire", async () => {
    // Without this the route is an SSRF primitive with Friday's own model
    // credential attached — strictly worse than the gap it closes. Encoded
    // segments survive the client's URL normalisation, so these reach the
    // handler as sent.
    for (const p of ["/api/model/..%2F..%2Fv1%2Fmessages", "/api/model/%2e%2e/v1/messages"]) {
      const res = await call(p);
      expect(res.status, p).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a literal `..` segment, which only a raw client can send", () => {
    // Asserted at the function rather than over the wire: an HTTP client
    // collapses dot segments while building the URL, so `fetch` turns
    // `/api/model/v1/../v1/messages` into the legitimate `/api/model/v1/messages`
    // before it leaves. The guard is for a client that does not normalise.
    expect(upstreamPathFor("/api/model/v1/../v1/messages")).toBeNull();
    expect(upstreamPathFor("/api/model/../../etc/passwd")).toBeNull();
    expect(upstreamPathFor("/api/model/v1/messages/../../v1/models")).toBeNull();
    // The one the allowlist alone would NOT catch: `[A-Za-z0-9._-]+` matches
    // `..`, so without the explicit check `/v1/models/..` is a permitted path
    // that the upstream may resolve as `/v1/`. Mutation-confirmed.
    expect(upstreamPathFor("/api/model/v1/models/..")).toBeNull();
  });

  it("allows the endpoints a turn actually uses", async () => {
    expect(upstreamPathFor("/api/model/v1/messages")).toBe("/v1/messages");
    expect(upstreamPathFor("/api/model/v1/messages/count_tokens")).toBe(
      "/v1/messages/count_tokens",
    );
    expect(upstreamPathFor("/api/model/v1/models")).toBe("/v1/models");
    expect(upstreamPathFor("/api/model/v1/models/claude-opus-5")).toBe("/v1/models/claude-opus-5");
  });

  it("preserves the query string", async () => {
    await call("/api/model/v1/models?limit=2", { method: "GET" });
    expect(seen[0]!.url).toBe("/v1/models?limit=2");
  });

  it("answers 503 when the Deployment has no model credential", async () => {
    // Loudly, rather than forwarding unauthenticated and surfacing as a 401
    // the agent would read as its own problem.
    const bare = createServer((req, res) =>
      handleModelProxy(req, res, {
        FRIDAY_MODEL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      } as NodeJS.ProcessEnv),
    );
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const port = (bare.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/model/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token()}` },
      });
      expect(res.status).toBe(503);
      expect(seen).toHaveLength(0);
    } finally {
      bare.closeAllConnections();
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});

describe("configuration", () => {
  it("defaults to the real API", () => {
    expect(resolveModelUpstream({})).toBe("https://api.anthropic.com");
    expect(DEFAULT_MODEL_UPSTREAM).toBe("https://api.anthropic.com");
  });

  it("ignores a non-http override rather than trusting it", () => {
    // The override exists so a test can stand up a fake upstream; it must not
    // become a way to point model traffic at an arbitrary scheme.
    expect(resolveModelUpstream({ FRIDAY_MODEL_UPSTREAM: "file:///etc/passwd" })).toBe(
      DEFAULT_MODEL_UPSTREAM,
    );
    expect(resolveModelUpstream({ FRIDAY_MODEL_UPSTREAM: "  " })).toBe(DEFAULT_MODEL_UPSTREAM);
  });

  it("prefers the API key, and falls back to either token shape", () => {
    // A `claude login` install has a token and no key; it must not silently
    // become unauthenticated.
    expect(upstreamCredential({ ANTHROPIC_API_KEY: "k" })).toEqual({
      header: "x-api-key",
      value: "k",
    });
    expect(upstreamCredential({ ANTHROPIC_AUTH_TOKEN: "t" })).toEqual({
      header: "authorization",
      value: "Bearer t",
    });
    expect(upstreamCredential({ CLAUDE_CODE_OAUTH_TOKEN: "o" })).toEqual({
      header: "authorization",
      value: "Bearer o",
    });
    expect(upstreamCredential({})).toBeNull();
  });
});
