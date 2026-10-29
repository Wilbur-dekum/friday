import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostedServerNames, hostedServerPath, isHostedServer } from "./host.js";

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
