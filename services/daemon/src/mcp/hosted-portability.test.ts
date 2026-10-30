import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostedServerNames, hostedServerPath, isHostedServer } from "./host.js";
import { ELICITATION_SERVER_NAME } from "./elicitation.js";
import { isWorkerFacing } from "../api/worker-listener.js";

/**
 * FRI-2074: a hosted server must only read `extra` fields the MCP transport
 * actually carries.
 *
 * `friday-elicitation` was hosted, shipped green through 1332 tests, and
 * failed on the FIRST live turn: every `ask_user` returned "invoked without a
 * tool_use_id". Its elicitation id is `extra.toolUseId`, which
 * `createSdkMcpServer` injects because it runs IN-PROCESS inside the Agent
 * SDK. Over the standard transport, `extra` is the MCP SDK's
 * `RequestHandlerExtra` — `requestId` and `signal`, no `toolUseId`, because
 * tool_use_id is an Anthropic-API concept rather than an MCP one.
 *
 * Nothing in the suite could catch it, because nothing exercised a hosted
 * server's handler over a real transport. This closes that: it is a source
 * assertion, so it costs nothing and runs everywhere, and it would have failed
 * the moment elicitation joined HOSTED.
 *
 * `signal` is the one portable field: `RequestHandlerExtra` carries it, which
 * is exactly why abort propagation works (see host-abort.test.ts).
 */

const MCP_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Server name → the module that builds it, DERIVED from HOSTED rather than
 * hardcoded. `friday-tickets` lives in `tickets.ts`, and every server follows
 * that convention — so a newly hosted server is covered automatically instead
 * of silently escaping the check.
 */
function moduleFor(name: string): string {
  return `${name.replace(/^friday-/, "")}.ts`;
}

/**
 * Fields the Agent SDK supplies in-process but the MCP transport does not.
 * Reading one of these makes a server un-hostable.
 */
const SDK_ONLY_EXTRA_FIELDS = ["toolUseId"];

function sourceOf(file: string): string {
  return readFileSync(join(MCP_DIR, file), "utf8");
}

describe("hosted MCP servers are transport-portable", () => {
  it("covers every server host.ts actually hosts", () => {
    // Guards the guard: a server added to HOSTED without a line here would
    // otherwise be silently unchecked.
    const names = hostedServerNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(isHostedServer(name), `${name} should be hosted`).toBe(true);
      expect(hostedServerPath(name)).toBe(`/api/mcp/${name}`);
      // The module must exist, or the convention below is quietly checking
      // nothing for this server.
      expect(() => sourceOf(moduleFor(name)), `${moduleFor(name)} must exist`).not.toThrow();
    }
  });

  it("reads no SDK-only field off `extra`", () => {
    for (const name of hostedServerNames()) {
      const file = moduleFor(name);
      const src = sourceOf(file);
      for (const field of SDK_ONLY_EXTRA_FIELDS) {
        expect(
          src.includes(field),
          `${name} (${file}) reads \`${field}\`, which the MCP transport does not carry — ` +
            `it cannot be hosted. This is the FRI-2074 failure: green suite, broken on the ` +
            `first live turn.`,
        ).toBe(false);
      }
    }
  });

  it("documents why elicitation is excluded, so the exclusion is not mistaken for an oversight", () => {
    // The negative case. If someone adds it to HOSTED, the assertion above
    // fires; this one keeps the REASON discoverable from the test file.
    expect(isHostedServer("friday-elicitation")).toBe(false);
    expect(sourceOf("elicitation.ts")).toContain("toolUseId");
  });
});

describe("friday-elicitation stays in-process, deliberately (FRI-2074)", () => {
  /**
   * The one server that is NOT hosted, recorded as a decision so it does not
   * read as an oversight — and so a future "let's finish the migration" pass
   * has to delete this test rather than discover the reason by breaking it.
   *
   * MEASURED, in FRI-2074: hosted, every `ask_user` fails with `ask_user
   * invoked without a tool_use_id`. The elicitation id IS `extra.toolUseId` —
   * the value the dashboard SSE event, the submit POST and the canonical
   * `tool_use` block all key on. `createSdkMcpServer` injects it because it
   * runs in-process; the standard MCP transport's `extra` carries
   * `requestId` and `signal` and no `toolUseId`, because tool_use_id is an
   * Anthropic-API concept rather than an MCP one.
   *
   * Hosting it would buy none of what hosting is FOR. The other thirteen
   * moved to get a privileged tool surface out of the process running
   * untrusted repository code (docs/sandbox.md residual risk #1). `ask_user`
   * holds no credential, reads no state and does nothing privileged — it
   * blocks on a human. Leaving it in-process leaks nothing.
   *
   * Container reachability, the other objection, is already handled:
   * `POST /api/elicitation/wait` is in `WORKER_FACING_ROUTES` (FRI-2072), so
   * a worker in its own container reaches the long-poll over the same
   * token-gated listener as everything else.
   */
  it("is not in the hosted registry", () => {
    expect(isHostedServer(ELICITATION_SERVER_NAME)).toBe(false);
    expect(hostedServerNames()).not.toContain(ELICITATION_SERVER_NAME);
  });

  it("is reachable from a container, which is why it can stay in-process", () => {
    // The decision rests on this. If the long-poll ever stops being
    // worker-facing, a containerised agent silently loses `ask_user` and the
    // reasoning above expires with it.
    expect(isWorkerFacing("POST", "/api/elicitation/wait")).toBe(true);
  });
});
