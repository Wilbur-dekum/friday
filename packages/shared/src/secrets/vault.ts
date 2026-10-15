import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { decryptPayload, encryptPayload, identityToRecipient, resolveAgeIdentity } from "./age.js";
import { emptyMeta, readMetaFile, validateBijection, writeMetaFile } from "./meta.js";
import {
  AGE_KEY_PATH,
  GENERATION_PATH,
  RECIPIENTS_PATH,
  SECRETS_DIR,
  VAULT_ENC_PATH,
  vaultKeyForMeta,
} from "./paths.js";
import type { SecretMeta, UnlockResult, VaultCache, VaultPayload } from "./types.js";

let cached: VaultCache | undefined;
let secretsLocked = false;
let cachedGeneration: string | undefined;

export function isSecretsLocked(): boolean {
  return secretsLocked;
}

export function setSecretsLocked(locked: boolean): void {
  secretsLocked = locked;
}

export function getVaultCache(): VaultCache | undefined {
  return cached;
}

export function clearSecretsCache(): void {
  cached = undefined;
  cachedGeneration = undefined;
}

export function readGeneration(): string | undefined {
  try {
    return readFileSync(GENERATION_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function bumpGeneration(): string {
  const gen = String(Date.now());
  writeFileSync(GENERATION_PATH, `${gen}\n`, "utf8");
  return gen;
}

function parseVaultPayload(raw: string): VaultPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as VaultPayload;
    if (parsed?.version !== 1 || typeof parsed.secrets !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function unlockVault(force = false): Promise<UnlockResult> {
  if (!existsSync(VAULT_ENC_PATH)) {
    secretsLocked = false;
    cached = undefined;
    return { ok: false, reason: "no_vault" };
  }

  const generation = readGeneration() ?? "0";
  if (!force && cached && cachedGeneration === generation) {
    return { ok: true, cache: cached };
  }

  const identity = resolveAgeIdentity();
  if (!identity) {
    secretsLocked = true;
    cached = undefined;
    return { ok: false, reason: "no_key" };
  }

  try {
    const ciphertext = readFileSync(VAULT_ENC_PATH);
    const plaintext = await decryptPayload(ciphertext, identity);
    const payload = parseVaultPayload(plaintext);
    if (!payload) {
      secretsLocked = true;
      cached = undefined;
      return { ok: false, reason: "invalid_payload" };
    }
    const meta = readMetaFile();
    cached = { payload, meta, generation };
    cachedGeneration = generation;
    secretsLocked = false;
    return { ok: true, cache: cached };
  } catch {
    secretsLocked = true;
    cached = undefined;
    return { ok: false, reason: "decrypt_failed" };
  }
}

export function ensureSecretsDir(): void {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });
}

export async function initVault(identity: string, recipient: string): Promise<void> {
  ensureSecretsDir();
  writeFileSync(AGE_KEY_PATH, `${identity}\n`, "utf8");
  chmodSync(AGE_KEY_PATH, 0o600);
  writeFileSync(RECIPIENTS_PATH, `${recipient}\n`, "utf8");
  const payload: VaultPayload = { version: 1, secrets: {} };
  await writeVaultAndMeta(payload, emptyMeta());
}

export async function writeVaultAndMeta(
  payload: VaultPayload,
  meta: import("./types.js").SecretsMetaFile,
): Promise<void> {
  ensureSecretsDir();
  const bijection = validateBijection(meta, new Set(Object.keys(payload.secrets)));
  if (!bijection.ok) {
    throw new Error(
      `meta/vault bijection mismatch: orphanMeta=${bijection.orphanMeta.join(",")} orphanVault=${bijection.orphanVault.join(",")}`,
    );
  }

  const identity = resolveAgeIdentity();
  if (!identity) throw new Error("missing .age-key");

  let recipient: string;
  if (existsSync(RECIPIENTS_PATH)) {
    recipient = readFileSync(RECIPIENTS_PATH, "utf8").trim();
  } else {
    recipient = await identityToRecipient(identity);
  }

  const plaintext = JSON.stringify(payload);
  const ciphertext = await encryptPayload(plaintext, recipient);

  const vaultTmp = `${VAULT_ENC_PATH}.tmp`;
  writeFileSync(vaultTmp, ciphertext);
  renameSync(vaultTmp, VAULT_ENC_PATH);
  writeMetaFile(meta);

  const generation = bumpGeneration();
  cached = { payload, meta, generation };
  cachedGeneration = generation;
  secretsLocked = false;
}

export function getSecretValue(vaultKey: string): string | undefined {
  return cached?.payload.secrets[vaultKey]?.value;
}

export async function upsertSecret(meta: SecretMeta, value: string): Promise<void> {
  const unlock = await unlockVault(true);
  const payload: VaultPayload =
    unlock.ok === true ? structuredClone(unlock.cache.payload) : { version: 1, secrets: {} };
  const fileMeta = unlock.ok === true ? structuredClone(unlock.cache.meta) : emptyMeta();

  const key = vaultKeyForMeta(meta);
  payload.secrets[key] = { value };

  const idx = fileMeta.secrets.findIndex(
    (s) => s.name === meta.name && (s.app ?? undefined) === (meta.app ?? undefined),
  );
  if (idx >= 0) fileMeta.secrets[idx] = meta;
  else fileMeta.secrets.push(meta);

  await writeVaultAndMeta(payload, fileMeta);
}

export async function removeSecret(name: string, app?: string): Promise<void> {
  const unlock = await unlockVault(true);
  if (!unlock.ok) throw new Error("vault not unlocked");
  const payload = structuredClone(unlock.cache.payload);
  const fileMeta = structuredClone(unlock.cache.meta);
  const key = vaultKeyForMeta({ name, app });
  delete payload.secrets[key];
  fileMeta.secrets = fileMeta.secrets.filter(
    (s) => !(s.name === name && (s.app ?? undefined) === (app ?? undefined)),
  );
  await writeVaultAndMeta(payload, fileMeta);
}
