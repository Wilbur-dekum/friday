/**
 * Friday-secrets MCP server (ADR-038).
 *
 * FRI-2075: hosted daemon-side. The previous header said "In-process; caller
 * identity comes from trusted worker spawn options, not HTTP headers" — that
 * was accurate and is now obsolete in both halves.
 *
 * Identity comes from the per-worker bearer token the daemon minted, not from
 * headers the caller sets for itself, so it is stronger than the spawn-options
 * story it replaces. `appId` — which decides WHICH App's secrets are reachable
 * — rides that same token (FRI-2037), so a worker cannot name another App's
 * scope.
 *
 * And the authorization decision below (`canFetchOnDemand`, `isSecretsLocked`)
 * now runs in the DAEMON rather than inside the worker. In-process, those
 * checks executed in the same V8 isolate as untrusted repository code — the
 * deferred "daemon-side enforcement plane" of docs/sandbox.md residual risk #1,
 * on the tool surface where it matters most. A compromised worker can still
 * ASK for a secret; it can no longer rewrite the code that decides.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { canFetchOnDemand, isSecretsLocked, listOnDemandForCaller } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

export const SECRETS_SERVER_NAME = "friday-secrets";

export interface BuildSecretsServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
  appId?: string;
}

export function buildSecretsServer(opts: BuildSecretsServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
    appId: opts.appId,
  };

  return createSdkMcpServer({
    name: SECRETS_SERVER_NAME,
    tools: [
      tool(
        "secrets_fetch",
        "Fetch an on-demand secret by name. Only secrets declared as on-demand in meta.yaml and in your scope are returned. Env-mode and daemon secrets are never disclosed via this tool.",
        {
          name: z.string().describe("Secret name (e.g. GITHUB_PASSWORD)."),
          reason: z
            .string()
            .max(512)
            .describe("Why you need this secret (audited, max 512 chars)."),
        },
        async (args, extra) => {
          if (isSecretsLocked()) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Vault is locked — operator must run `friday secrets unlock --check`.",
                },
              ],
              isError: true,
            };
          }
          const result = canFetchOnDemand({
            name: args.name,
            agentType: opts.callerType,
            appId: opts.appId,
          });
          if (!result.ok) {
            return {
              content: [{ type: "text" as const, text: `Denied: ${result.reason}` }],
              isError: true,
            };
          }

          try {
            await daemonFetch({
              ...ctx,
              signal: signalFrom(extra),
              path: "/api/secrets/audit",
              method: "POST",
              body: {
                secretName: args.name,
                callerName: ctx.callerName,
                callerType: opts.callerType,
                appId: opts.appId ?? null,
                reason: args.reason,
                source: "mcp",
              },
            });
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true,
            };
          }

          return {
            content: [{ type: "text" as const, text: result.value }],
          };
        },
      ),
      tool(
        "secrets_list",
        "List on-demand secret names available in your scope (names only, no values).",
        {},
        async (_args, _extra) => {
          if (isSecretsLocked()) {
            return {
              content: [{ type: "text" as const, text: "Vault is locked." }],
              isError: true,
            };
          }
          const names = listOnDemandForCaller({
            agentType: opts.callerType,
            appId: opts.appId,
          });
          return {
            content: [{ type: "text" as const, text: names.length ? names.join("\n") : "(none)" }],
          };
        },
      ),
    ],
  });
}
