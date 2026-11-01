import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_SECRET_HEADER } from "@friday/shared";
import { MAIL_SERVER_NAME } from "./mail.js";

/**
 * FRI-2087: the shared daemon secret goes ONLY to the loopback listener.
 *
 * Two reasons, and the second is what actually broke a containerised Builder.
 *
 * It does not belong on a network boundary: the secret sits on a volume any
 * builder in the Deployment container can read, so off-loopback it identifies
 * nothing — the per-worker token does that job (`worker-listener.ts`).
 *
 * And **building the header creates one.** `getDaemonSecret()` writes a fresh
 * secret when the file is absent, so in a builder container — which has no
 * `/data` mount — assembling the MCP config MINTED a value the daemon had
 * never seen. Not an error: a silent mismatch. Measured live, the digests
 * differed (builder `7148308e…`, daemon `f143b7ea…`) and the SDK quietly
 * dropped all fourteen hosted servers, leaving the Builder with no Friday
 * tools at all.
 *
 * So this pins the ABSENCE of the call, not just of the header.
 */

const secretSpy = vi.hoisted(() => vi.fn(() => "the-shared-secret"));
vi.mock("@friday/shared", async (importActual) => {
  const actual = await importActual<typeof import("@friday/shared")>();
  return { ...actual, getDaemonSecret: secretSpy };
});

const OPTS = {
  callerType: "builder" as const,
  callerName: "builder-1",
  daemonPort: 7610,
  parentName: "friday",
  userMcpServers: [],
};

async function hostedMailConfig(): Promise<{ url: string; headers: Record<string, string> }> {
  vi.resetModules();
  const { buildMcpServers } = await import("./builder.js");
  const servers = buildMcpServers(OPTS) as Record<
    string,
    { type?: string; url?: string; headers?: Record<string, string> }
  >;
  const mail = servers[MAIL_SERVER_NAME];
  if (!mail?.url) throw new Error(`${MAIL_SERVER_NAME} is not hosted over http`);
  return { url: mail.url, headers: mail.headers ?? {} };
}

beforeEach(() => {
  secretSpy.mockClear();
  delete process.env.FRIDAY_DAEMON_URL;
  process.env.FRIDAY_WORKER_TOKEN = "worker-token-abc";
});

afterEach(() => {
  delete process.env.FRIDAY_DAEMON_URL;
  delete process.env.FRIDAY_WORKER_TOKEN;
});

describe("the daemon secret's reach", () => {
  it("is sent to the loopback listener, where it is the credential", async () => {
    // No FRIDAY_DAEMON_URL → 127.0.0.1, the laptop and single-container paths.
    const { url, headers } = await hostedMailConfig();
    expect(url).toContain("127.0.0.1");
    expect(headers[DAEMON_SECRET_HEADER]).toBe("the-shared-secret");
    expect(headers.authorization).toBe("Bearer worker-token-abc");
  });

  it("is NOT sent off-loopback, and is not even read there", async () => {
    // The builder-container shape. Reading it is what mints a bogus one.
    process.env.FRIDAY_DAEMON_URL = "http://friday:7611";
    const { url, headers } = await hostedMailConfig();
    expect(url).toBe("http://friday:7611/api/mcp/friday-mail");
    expect(headers[DAEMON_SECRET_HEADER]).toBeUndefined();
    expect(secretSpy).not.toHaveBeenCalled();
    // The token is what authorizes there, so it must still be present.
    expect(headers.authorization).toBe("Bearer worker-token-abc");
  });

  it("treats every loopback spelling as loopback", async () => {
    for (const base of ["http://127.0.0.1:7610", "http://localhost:7610", "http://[::1]:7610"]) {
      process.env.FRIDAY_DAEMON_URL = base;
      secretSpy.mockClear();
      const { headers } = await hostedMailConfig();
      expect(headers[DAEMON_SECRET_HEADER], base).toBe("the-shared-secret");
    }
  });

  it("does not mistake a hostname that merely CONTAINS a loopback spelling", async () => {
    // `localhost.evil.example` is not loopback, and a substring check would
    // leak the shared secret to it.
    for (const base of ["http://localhost.evil.example:7611", "http://127.0.0.1.evil.example"]) {
      process.env.FRIDAY_DAEMON_URL = base;
      secretSpy.mockClear();
      const { headers } = await hostedMailConfig();
      expect(headers[DAEMON_SECRET_HEADER], base).toBeUndefined();
      expect(secretSpy, base).not.toHaveBeenCalled();
    }
  });
});
