import { defineCommand } from "citty";
import pc from "picocolors";
import { refuseInContainer } from "../lib/lifecycle-guard.js";
import * as launchd from "../lib/launchd.js";

/**
 * `friday stop` — thin alias over `launchctl bootout` (FRI-146 / ADR-034).
 *
 * launchd + the supervisor handle cascade-stop (FRI-88 §0 design
 * constraint): booting out the supervisor sends SIGTERM, which signals
 * every child's process group, catching grandchildren. No more zombie
 * zero-cache workers after `friday stop` — that was the FRI-83 failure
 * mode this entire supervision rework exists to close.
 *
 * Single-service stops error out — the supervisor owns the whole stack.
 */

export const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop Friday's prod stack (launchd bootout).",
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
    if (refuseInContainer("stop")) {
      process.exit(1);
    }
    if (args.service) {
      console.error(pc.red(`single-service operations not supported under launchd supervision.`));
      console.error(`  ${pc.cyan("friday stop")} stops the whole stack atomically.`);
      process.exit(1);
    }

    console.log(pc.dim("stopping friday stack via launchd"));
    launchd.bootout();
    // Don't auto-stop cloudflared — it's a separate user launch agent
    // (`com.cloudflare.cloudflared`) installed by `friday setup --cloudflare`.
    // Operators tear it down with `cloudflared service uninstall` when they
    // actually want the tunnel gone, not on every `friday stop`.
  },
});
