#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { clearFridayConfigCache, closeDb, warmVaultCache } from "@friday/shared";
import pkg from "../package.json" with { type: "json" };
import { setupCommand } from "./commands/setup.js";
import { doctorCommand } from "./commands/doctor.js";
import { provisionCommand } from "./commands/provision.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { attachCommand } from "./commands/attach.js";
import { agentsCommand } from "./commands/agents.js";
import { sessionsCommand } from "./commands/sessions.js";
import { mailCommand } from "./commands/mail.js";
import { ticketsCommand } from "./commands/tickets.js";
import { memoryCommand } from "./commands/memory.js";
import { evolveCommand } from "./commands/evolve.js";
import { migrateCommand } from "./commands/migrate.js";
import { schedulesCommand } from "./commands/schedules.js";
import { appsCommand } from "./commands/apps.js";
import { backupCommand } from "./commands/backup.js";
import { restoreCommand } from "./commands/restore.js";
import { exportLegacySqliteCommand } from "./commands/export-legacy-sqlite.js";
import { updateCommand } from "./commands/update.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { secretsCommand } from "./commands/secrets.js";
import { tunnelCommand } from "./commands/tunnel.js";
import { captureKeyCommand } from "./commands/capture-key.js";
import { disableCommand, enableCommand } from "./commands/autostart.js";
import { maybePrintVersion } from "./lib/version.js";

const main = defineCommand({
  meta: {
    name: "friday",
    version: pkg.version,
    description: "Friday — local-first AI orchestrator",
  },
  // FRI-166: warm the age vault ONCE for the whole CLI process before any
  // subcommand runs. Integration secrets (e.g. CLOUDFLARE_TUNNEL_TOKEN) live in
  // the vault and `loadFridayConfig()` resolves them from the in-memory cache
  // that `warmVaultCache()` populates. The daemon warms at boot; the CLI must
  // too, or every command reads vault secrets as absent. citty invokes this
  // root `setup` before subcommand dispatch, so doing it here means no command
  // has to remember to warm — eliminating the whole missing-warm bug class
  // rather than patching it per read site. Non-interactive (uses
  // ~/.friday/.age-key) and a safe no-op when there's no vault; cost is one
  // age-decrypt, then generation-gated cache hits. `clearFridayConfigCache()`
  // drops any config cached from a not-yet-warm vault (e.g. a module-load read).
  async setup() {
    await warmVaultCache();
    clearFridayConfigCache();
  },
  // FRI-2052: close the pg pool once the subcommand resolves. `getDbAndPool()`
  // builds a Pool with `idleTimeoutMillis: 30_000`; without an explicit
  // `pool.end()` the idle client keeps a live socket on the event loop and Node
  // refuses to exit until that timer fires — so every DB-touching command did
  // its work in well under a second and then sat for a further 30. Same
  // reasoning as `setup()` above: doing it once at the root means no subcommand
  // has to remember, which eliminates the bug class instead of patching each
  // site (`doctor` was the only command that had remembered). `closeDb()` is a
  // no-op when no pool was ever created, so launchctl-only commands like
  // `start`/`stop` are unaffected.
  async cleanup() {
    await closeDb();
  },
  subCommands: {
    setup: setupCommand,
    doctor: doctorCommand,
    provision: provisionCommand,
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    disable: disableCommand,
    enable: enableCommand,
    status: statusCommand,
    logs: logsCommand,
    attach: attachCommand,
    agents: agentsCommand,
    sessions: sessionsCommand,
    mail: mailCommand,
    tickets: ticketsCommand,
    memory: memoryCommand,
    migrate: migrateCommand,
    evolve: evolveCommand,
    schedules: schedulesCommand,
    app: appsCommand,
    backup: backupCommand,
    restore: restoreCommand,
    "export-legacy-sqlite": exportLegacySqliteCommand,
    update: updateCommand,
    uninstall: uninstallCommand,
    secrets: secretsCommand,
    tunnel: tunnelCommand,
    "capture-key": captureKeyCommand,
  },
});

// `friday --version` must print a clean, parseable version on stdout; citty's
// own version path routes through consola, which prefixes `[log] ` in CI/pipes.
if (maybePrintVersion(process.argv.slice(2), pkg.version)) {
  process.exit(0);
}

void runMain(main);
