import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentType } from "@friday/shared";
import { daemonFetch, signalFrom } from "./http.js";

/**
 * Friday-github MCP server (FRI-2078).
 *
 * Replaces the `gh` invocations the builder persona used to prescribe:
 * `gh pr create` and `gh pr checks`. Hosting them daemon-side is what lets
 * the credential live in the trusted tier — and in a per-task container
 * (FRI-2038) there is no `gh` login to inherit at all.
 *
 * ## What a Builder does NOT get to choose
 *
 * The repository and the head branch are both resolved daemon-side from the
 * caller's own registry row, so they are absent from these schemas. A Builder
 * can open a PR from its own branch on its own repo, and that is the only
 * thing it can do. Taking either as a parameter would turn the FRI-2041
 * allowlist back into a suggestion.
 *
 * ## There is no merge tool, and that is the point
 *
 * "Halt at a green PR — never merge" is currently a prompt rule, and a prompt
 * rule is a request. Here it is the absence of an operation: there is no tool
 * to call, so an agent that decides to merge anyway has nothing to decide
 * with. That is the asymptote principle applied to authority rather than to
 * cost (ADR-051/ADR-053).
 *
 * ## Why `pr_checks` does not wait
 *
 * `gh pr checks --watch` blocks until CI finishes. A tool that did the same
 * would hold an MCP request open for the length of a CI run, through the
 * worker's abort signal and the daemon's own timeouts. It returns a snapshot
 * with `complete`, and the agent loop — which already knows how to wait and
 * ask again — polls it.
 */

export const GITHUB_SERVER_NAME = "friday-github";

export interface BuildGitHubServerOptions {
  callerName: string;
  callerType: AgentType;
  daemonPort: number;
}

export function buildGitHubServer(opts: BuildGitHubServerOptions) {
  const ctx = {
    port: opts.daemonPort,
    callerName: opts.callerName,
    callerType: opts.callerType,
  };

  return createSdkMcpServer({
    name: GITHUB_SERVER_NAME,
    tools: [
      tool(
        "pr_create",
        "Open a pull request from your own branch. The repository and the head branch come from your assignment — you do not name them. Put `Closes FRI-N` on its own line in the body when the work closes a ticket.",
        {
          title: z.string().describe("PR title. Conventional Commit style, like a commit subject."),
          body: z
            .string()
            .optional()
            .describe(
              "Markdown body. Keep `Closes FRI-N` / `#123` as BARE TEXT — GitHub and Linear parse those keywords from raw text and a markdown link defeats the scan.",
            ),
          base: z
            .string()
            .optional()
            .describe(
              "Branch to merge into. Defaults to the repository's main branch. Another `friday/*` branch is allowed, for a stacked PR.",
            ),
        },
        async (args, extra) => {
          const pr = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            method: "POST",
            path: "/api/github/pr",
            body: args,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(pr, null, 2) }] };
        },
      ),
      tool(
        "pr_checks",
        "Read the CI check runs for a pull request's head commit. Returns a snapshot: `complete` is false while anything is still running, so poll rather than expecting this to wait. `passing` is true only once every run has finished and none failed.",
        {
          number: z.number().int().positive().describe("The PR number."),
        },
        async (args, extra) => {
          const checks = await daemonFetch({
            ...ctx,
            signal: signalFrom(extra),
            method: "GET",
            path: `/api/github/pr-checks?number=${args.number}`,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(checks, null, 2) }] };
        },
      ),
    ],
  });
}
