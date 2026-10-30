import type { AgentTypeName } from "../config.js";

export type SecretMode = "env" | "on-demand";

export interface SecretMeta {
  name: string;
  mode: SecretMode;
  app?: string;
  daemon?: boolean;
  agents?: AgentTypeName[];
}

export interface SecretsMetaFile {
  secrets: SecretMeta[];
}

export interface VaultSecretEntry {
  value: string;
}

export interface VaultPayload {
  version: 1;
  secrets: Record<string, VaultSecretEntry>;
}

export interface VaultCache {
  payload: VaultPayload;
  meta: SecretsMetaFile;
  generation: string;
}

export type UnlockResult =
  | { ok: true; cache: VaultCache }
  | { ok: false; reason: "no_vault" | "no_key" | "decrypt_failed" | "invalid_payload" };

export const MACHINE_ENV_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "ZERO_AUTH_SECRET",
  "ZERO_ADMIN_PASSWORD",
  "DATABASE_URL",
  "ZERO_UPSTREAM_DB",
  "ZERO_REPLICA_FILE",
]);

export type DaemonConfigField =
  | "linearApiKey"
  | "anthropicApiKey"
  | "cloudflareTunnelToken"
  | "posthogApiKey"
  | "posthogHost"
  | "githubToken";

export const DAEMON_FIELD_ALIASES: Record<string, DaemonConfigField> = {
  LINEAR_API_KEY: "linearApiKey",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  CLOUDFLARE_TUNNEL_TOKEN: "cloudflareTunnelToken",
  POSTHOG_API_KEY: "posthogApiKey",
  POSTHOG_HOST: "posthogHost",
  // FRI-2078: Friday's own GitHub credential. Until now there was none — a
  // Builder's `gh pr create` ran on whatever `gh` login happened to exist on
  // the daemon's machine, reaching the worker through the FRI-150 shell-env
  // capture. Friday could not scope, revoke or attribute it, and in a
  // container it does not exist at all.
  GITHUB_TOKEN: "githubToken",
};
