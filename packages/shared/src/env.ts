/**
 * Friday config loader (FRI-150 pivot, ADR-037; vault overlay ADR-038).
 *
 * Machine-local secrets live in `~/.friday/.env.local`. Integration secrets
 * live in the age-encrypted vault (`secrets/vault.enc`) and are read via
 * `unlockVault()` into an in-memory cache — not from plaintext `.env`.
 */

import { parse as dotenvParse } from "dotenv";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV_LOCAL_PATH, ENV_PATH } from "./config.js";
import { MACHINE_ENV_KEYS } from "./secrets/types.js";
import { resolveDaemonFields } from "./secrets/resolve.js";
import {
  clearSecretsCache,
  getVaultCache,
  isSecretsLocked,
  unlockVault,
  upsertSecret,
} from "./secrets/vault.js";
import type { SecretMeta } from "./secrets/types.js";

export interface FridayEnvConfig {
  readonly betterAuthSecret: string;
  readonly zeroAuthSecret: string;
  readonly zeroAdminPassword: string;
  readonly databaseUrl: string | undefined;
  readonly zeroUpstreamDb: string | undefined;
  readonly zeroReplicaFile: string | undefined;
  readonly linearApiKey: string | undefined;
  readonly anthropicApiKey: string | undefined;
  readonly cloudflareTunnelToken: string | undefined;
  readonly posthogApiKey: string | undefined;
  readonly posthogHost: string | undefined;
  /**
   * FRI-2078: the credential the hosted GitHub tools use to open PRs and read
   * CI. Absent means Builders cannot open PRs — deliberately, because the
   * alternative was the ambient `gh` login the daemon's machine happened to
   * have, which Friday could neither scope nor attribute.
   */
  readonly githubToken: string | undefined;
}

let cached: FridayEnvConfig | undefined;

export function clearFridayConfigCache(): void {
  cached = undefined;
}

export function __resetFridayEnvConfigForTests(): void {
  cached = undefined;
  clearSecretsCache();
}

function localEnvPath(): string {
  if (existsSync(ENV_LOCAL_PATH)) return ENV_LOCAL_PATH;
  if (existsSync(ENV_PATH)) return ENV_PATH;
  return ENV_LOCAL_PATH;
}

/**
 * Read BOTH env files, `.env` as the base and `.env.local` overlaying it.
 *
 * FRI-2014: this used to read only `localEnvPath()`, which is `.env.local`
 * when that file exists and `.env` otherwise — an either/or, not a layering.
 * That is invisible on a laptop, where `.env.local` usually does not exist and
 * `.env` is therefore read. It breaks on migration: `friday restore` WRITES
 * `.env.local` (to persist the synced `friday` role password), which flips the
 * choice to `.env.local` and silently orphans every key the operator had in
 * `.env` — ANTHROPIC_API_KEY, LINEAR_API_KEY, the Slack tokens, PostHog.
 *
 * The symptom is not a missing-config error. The Deployment boots healthy and
 * the agent answers every turn with `Not logged in · Please run /login`.
 *
 * `.env.local` still wins on conflict, which is what it is for (machine-local
 * overrides) and is exactly the behaviour when both files already existed.
 * Keys present only in `.env` simply stop being dropped.
 */
function ensureLocalEnvFile(): Record<string, string> {
  const path = localEnvPath();
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (!existsSync(path)) {
    writeFileSync(path, "# Friday machine-local env vars\n");
  }
  const base = existsSync(ENV_PATH) ? dotenvParse(readFileSync(ENV_PATH)) : {};
  const local = existsSync(ENV_LOCAL_PATH) ? dotenvParse(readFileSync(ENV_LOCAL_PATH)) : {};
  return { ...base, ...local };
}

/**
 * Warm the vault cache. Call at daemon boot before serving traffic.
 */
export async function warmVaultCache(): Promise<void> {
  await unlockVault();
}

export function loadFridayConfig(): FridayEnvConfig {
  if (cached) return cached;

  const path = localEnvPath();
  const parsed = ensureLocalEnvFile();

  if (!parsed.BETTER_AUTH_SECRET) {
    const secret = randomBytes(32).toString("base64");
    appendFileSync(path, `BETTER_AUTH_SECRET=${secret}\n`);
    parsed.BETTER_AUTH_SECRET = secret;
  }
  if (!parsed.ZERO_AUTH_SECRET) {
    const secret = randomBytes(32).toString("hex");
    appendFileSync(path, `ZERO_AUTH_SECRET=${secret}\n`);
    parsed.ZERO_AUTH_SECRET = secret;
  }
  if (!parsed.ZERO_ADMIN_PASSWORD) {
    const secret = randomBytes(24).toString("base64url");
    appendFileSync(path, `ZERO_ADMIN_PASSWORD=${secret}\n`);
    parsed.ZERO_ADMIN_PASSWORD = secret;
  }

  const readLocal = (key: string): string | undefined => process.env[key] || parsed[key];
  const vaultCache = getVaultCache();
  const daemonOverlay = resolveDaemonFields(vaultCache, (key) => process.env[key]);

  /**
   * FRI-2060: integration secrets now fall back to `~/.friday/.env`, the way
   * every other secret already does.
   *
   * Platform secrets read `readLocal(…) ?? parsed.X` — process.env, then
   * `.env.local`, then `.env`. Integration secrets uniquely stopped at the
   * vault, so a key an operator plainly wrote into `~/.friday/.env` was
   * parsed out of the file and then dropped, with no warning and no way to
   * tell from the outside. ADR-037 moved these into the vault for encryption
   * at rest, which is a production concern; it is not a reason to make a dev
   * machine unusable without `friday secrets set` ceremony for every key.
   *
   * The vault still outranks the file, so nothing about the production story
   * changes — this only stops a present key being silently ignored.
   */
  const readIntegration = (key: string, field?: string): string | undefined => {
    const fromEnv = process.env[key];
    if (fromEnv) return fromEnv;
    if (field && daemonOverlay[field as keyof typeof daemonOverlay]) {
      return daemonOverlay[field as keyof typeof daemonOverlay];
    }
    const fromFile = parsed[key];
    if (fromFile) {
      // Visible, not silent: if the vault is live, say which source won so the
      // precedence is observable rather than guessed at.
      if (vaultCache) {
        console.warn(
          `WARN: ${key} read from ${ENV_PATH} — the vault is initialised but does not hold it. ` +
            `Prefer \`friday secrets set ${key} --daemon\`; the vault takes precedence if both are set.`,
        );
      }
      return fromFile;
    }
    return undefined;
  };

  cached = Object.freeze({
    betterAuthSecret: (readLocal("BETTER_AUTH_SECRET") ?? parsed.BETTER_AUTH_SECRET) as string,
    zeroAuthSecret: (readLocal("ZERO_AUTH_SECRET") ?? parsed.ZERO_AUTH_SECRET) as string,
    zeroAdminPassword: (readLocal("ZERO_ADMIN_PASSWORD") ?? parsed.ZERO_ADMIN_PASSWORD) as string,
    databaseUrl: readLocal("DATABASE_URL"),
    zeroUpstreamDb: readLocal("ZERO_UPSTREAM_DB"),
    zeroReplicaFile: readLocal("ZERO_REPLICA_FILE"),
    linearApiKey: readIntegration("LINEAR_API_KEY", "linearApiKey"),
    anthropicApiKey: readIntegration("ANTHROPIC_API_KEY", "anthropicApiKey"),
    cloudflareTunnelToken: readIntegration("CLOUDFLARE_TUNNEL_TOKEN", "cloudflareTunnelToken"),
    posthogApiKey: readIntegration("POSTHOG_API_KEY", "posthogApiKey"),
    posthogHost: readIntegration("POSTHOG_HOST", "posthogHost"),
    githubToken: readIntegration("GITHUB_TOKEN", "githubToken"),
  });
  return cached;
}

export function secretsHealthLocked(): boolean {
  return isSecretsLocked();
}

export function upsertEnvVar(key: string, value: string): void {
  if (MACHINE_ENV_KEYS.has(key)) {
    upsertLocalEnvVar(key, value);
    return;
  }
  throw new Error(
    `upsertEnvVar: integration key ${key} must use friday secrets set (vault), not plaintext .env`,
  );
}

export async function upsertIntegrationSecret(meta: SecretMeta, value: string): Promise<void> {
  await upsertSecret(meta, value);
  clearFridayConfigCache();
}

function upsertLocalEnvVar(key: string, value: string): void {
  const path = localEnvPath();
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const existing = existsSync(path)
    ? readFileSync(path, "utf8")
    : "# Friday machine-local env vars\n";
  const line = `${key}=${formatEnvValue(value)}`;
  const lines = existing.split("\n");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  writeFileSync(path, lines.join("\n"));
  cached = undefined;
}

function formatEnvValue(value: string): string {
  if (/[\s#="]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
