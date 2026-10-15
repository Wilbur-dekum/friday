import { defineCommand } from "citty";
import pc from "picocolors";
import { refuseInContainer } from "../lib/lifecycle-guard.js";
import * as launchd from "../lib/launchd.js";

/**
 * `friday restart` — thin alias over `launchctl kickstart -k` (FRI-146 /
 * ADR-034).
 *
 * `kickstart -k` kills the running supervisor instance (which cascade-stops
 * every child's process group — FRI-88 §0), waits for the process tree to
 * settle, then restarts the supervisor. The supervisor re-forks its three
 * children in order (daemon → zero-cache → dashboard) with the same
 * KeepAlive semantics as a cold boot.
 *
 * Single-service restarts error out — the whole-stack restart is the
 * v1 contract.
 */

export const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description: "Restart Friday's prod stack (launchd kickstart -k).",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "(unused — single-service ops not supported under launchd supervision)",
    },
  },
  async run({ args }) {
    // FRI-2006: no launchctl in a container — refuse rather than no-op.
    if (refuseInContainer("restart")) {
      process.exit(1);
    }
    if (args.service) {
      console.error(pc.red(`single-service operations not supported under launchd supervision.`));
      console.error(`  ${pc.cyan("friday restart")} restarts the whole stack atomically.`);
      console.error(
        `  per-service IPC (e.g. ${pc.cyan("friday restart zero-cache")}) is an explicit follow-up ticket.`,
      );
      process.exit(1);
    }

    console.log(pc.dim("restarting friday stack via launchd"));
    const r = launchd.kickstart();
    if (r.status !== 0) {
      console.error(
        pc.red(`launchctl kickstart failed (${r.status}): ${r.stderr.trim() || r.stdout.trim()}`),
      );
      console.error(`  is the supervisor loaded? try ${pc.cyan("friday start")} first.`);
      process.exit(r.status);
    }
  },
});
