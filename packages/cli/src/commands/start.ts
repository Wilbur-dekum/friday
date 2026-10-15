import { defineCommand } from "citty";
import pc from "picocolors";
import { refuseInContainer } from "../lib/lifecycle-guard.js";
import {
  loadConfig,
  loadFridayConfig,
  resolveDaemonPort,
  resolveDashboardPort,
  SERVICES,
} from "@friday/shared";
import * as launchd from "../lib/launchd.js";
import { reconcileTunnel } from "../lib/cloudflared.js";
import { currentLink } from "../lib/install-paths.js";
import { checkDeps, formatRemedies } from "../lib/deps.js";

/**
 * `friday start` — thin alias over `launchctl bootstrap` (FRI-146 /
 * ADR-034).
 *
 * Supervision lives in launchd via a plist Friday writes directly
 * (label `com.sethvoltz.friday`), bootstrapped via `launchctl bootstrap`.
 * The plist runs `friday-supervisor` through `fnm exec`, which forks
 * daemon + dashboard + zero-cache as children with proper process-group
 * cascade-stop semantics. The tmux era is over.
 *
 * Single-service starts (`friday start daemon`) error out — the
 * supervisor owns the whole stack atomically. Operators bounce
 * individual services via `friday restart` (also whole-stack); the
 * per-service IPC story is an explicit follow-up ticket.
 *
 * cloudflared is its own user launch agent
 * (`com.cloudflare.cloudflared`). FRI-166: `friday start` now *reconciles*
 * that agent to desired state — explicit serve-intent (`config.json`
 * `tunnel.serve`) AND a token in the vault — rather than assuming setup
 * already installed it. serve+token → install+run from the vault token (no
 * re-prompt); otherwise → ensure it's torn down. A staged/restored box stays
 * dark because `friday restore` forces `tunnel.serve` off (split-brain guard).
 */

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Start Friday's prod stack (launchd-supervised). For dev hot-reload, use `pnpm dev:daemon` / `pnpm dev:dashboard`.",
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
    if (refuseInContainer("start")) {
      process.exit(1);
    }
    if (args.service) {
      console.error(pc.red(`single-service operations not supported under launchd supervision.`));
      console.error(`  the supervisor owns the whole stack atomically; bounce it with:`);
      console.error(`    ${pc.cyan("friday restart")}    # whole stack`);
      console.error(`  per-service IPC is an explicit follow-up ticket — see ADR-028.`);
      process.exit(1);
    }

    // FRI-150 (pivot, ADR-037): trigger file-creation + autogen via the
    // new loader (no process.env mutation).
    loadFridayConfig();

    // Dependency preflight (read-only): refuse to start into a known-bad state
    // rather than bootstrap a supervisor that would park (or, pre-gate,
    // crash-loop the daemon) on a missing hard dep. The supervisor runs the
    // SAME check at boot and covers `friday restart` / launchd RunAtLoad (which
    // don't pass through here); this is the fast, interactive "tell me what to
    // run" surface. Installs never happen here — the remedy points at
    // `friday provision`.
    const deps = await checkDeps();
    if (!deps.ok) {
      console.error(pc.red("Friday can't start — missing dependencies:"));
      console.error(formatRemedies(deps.hard));
      console.error(
        `\n  run ${pc.cyan("friday provision")} to install them, then ${pc.cyan("friday start")} again.`,
      );
      process.exit(1);
    }

    // Always go through `launchd.bootstrap`: it rewrites the plist from the
    // current installDir (picking up shape changes between releases — e.g.
    // ProgramArguments / EnvironmentVariables tweaks) and then bootstraps or
    // kickstarts depending on whether the job is already loaded.
    console.log(pc.green("starting friday stack via launchd"));
    try {
      launchd.bootstrap(currentLink());
    } catch (err) {
      console.error(pc.red(`failed to start friday: ${err instanceof Error ? err.message : err}`));
      console.error(
        `  not installed? ${pc.cyan("curl -fsSL https://raw.githubusercontent.com/sethvoltz/friday/main/install.sh | bash")}`,
      );
      process.exit(1);
    }

    // FRI-166: reconcile the cloudflared launch agent to (serve-intent, token).
    // Declarative + idempotent: an already-serving tunnel is a no-op, a
    // removed token tears the agent down, and a restored tunnel-enabled config
    // (serve-intent on, same machine) brings it back — DR works without a
    // re-run of `friday setup --cloudflare`. The vault holding
    // CLOUDFLARE_TUNNEL_TOKEN is warmed once at CLI entry (see index.ts
    // `setup`), so loadFridayConfig() resolves it here.
    const fridayEnv = loadFridayConfig();
    const serve = loadConfig().tunnel?.serve === true;
    const tunnel = reconcileTunnel({ serve, token: fridayEnv.cloudflareTunnelToken });
    if (!tunnel.ok) {
      // install/reinstall couldn't complete (cloudflared missing or errored).
      console.log(pc.yellow(`  · ${tunnel.detail}`));
    } else if (tunnel.action === "install" || tunnel.action === "reinstall") {
      console.log(pc.green(`  · ${tunnel.detail}`));
    } else if (tunnel.action === "uninstall") {
      console.log(pc.dim(`  · ${tunnel.detail}`));
    } else if (!fridayEnv.cloudflareTunnelToken) {
      console.log(
        pc.dim(`  · no public tunnel — ${pc.cyan("friday setup --cloudflare")} to enable`),
      );
    } else if (!serve) {
      // Token is staged in the vault but serve-intent is off — the
      // split-brain-safe state after a `friday restore`.
      console.log(
        pc.dim(`  · tunnel staged, not serving — ${pc.cyan("friday tunnel up")} to serve`),
      );
    }

    const cfg = loadConfig();
    console.log();
    console.log(pc.dim(`  daemon API     http://localhost:${resolveDaemonPort(cfg)}`));
    console.log(pc.dim(`  dashboard      http://localhost:${resolveDashboardPort(cfg)}`));
    console.log(pc.dim(`  zero-cache     ws://localhost:4848`));
    if (cfg.publicUrl) {
      console.log(pc.dim(`  public URL     ${cfg.publicUrl}`));
    }
    console.log(pc.dim(`  attach with:   friday attach <${SERVICES.join("|")}>`));
  },
});
