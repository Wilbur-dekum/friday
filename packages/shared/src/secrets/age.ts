import { readFileSync } from "node:fs";
import * as age from "age-encryption";
import { isContainer } from "../container.js";
import { AGE_KEY_PATH } from "./paths.js";

export async function generateAgeKeypair(): Promise<{ identity: string; recipient: string }> {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

/** Where the age identity came from. `disk` is the laptop default. */
export type AgeIdentitySource = "env" | "file" | "disk";

/**
 * FRI-2010: choose the age identity from the available sources, in order.
 *
 * Containerising `~/.friday/.age-key` would put the decryption key on the same
 * persistent volume as the `vault.enc` it decrypts — obfuscation, not
 * encryption at rest, and the first thing a security questionnaire catches
 * (ADR-051). So the identity has to be able to arrive at runtime instead.
 *
 * Two injection points rather than one, because secret managers differ: an
 * env var covers anything that can set environment (Kubernetes `secretKeyRef`,
 * ECS, Fly, Docker secrets exported into env), and a file path covers mounted
 * secrets (Kubernetes secret volumes, Docker secrets at `/run/secrets/...`,
 * tmpfs). Neither binds us to one cloud's API, which is what ADR-051 requires
 * for the self-hosted tier to supply its own.
 *
 * Pure, so precedence is testable without env or a filesystem.
 */
export function selectAgeIdentity(opts: {
  /** `FRIDAY_AGE_IDENTITY` — the identity itself. */
  envIdentity?: string;
  /** Contents of the path named by `FRIDAY_AGE_IDENTITY_FILE`, if readable. */
  fileContents?: string;
  /** Contents of `~/.friday/.age-key`, if readable. */
  diskContents?: string;
}): { identity: string; source: AgeIdentitySource } | undefined {
  const env = opts.envIdentity?.trim();
  if (env) return { identity: env, source: "env" };
  const file = opts.fileContents?.trim();
  if (file) return { identity: file, source: "file" };
  const disk = opts.diskContents?.trim();
  if (disk) return { identity: disk, source: "disk" };
  return undefined;
}

function readIfPresent(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

let warnedAboutDiskIdentity = false;

/**
 * Resolve the age identity: runtime injection first, then disk.
 *
 * Replaces `readAgeIdentityFromDisk`, which could only ever see the laptop
 * case. Behaviour on a laptop is unchanged — with neither env var set this
 * reads exactly the same file as before.
 */
export function resolveAgeIdentity(): string | undefined {
  const picked = selectAgeIdentity({
    envIdentity: process.env.FRIDAY_AGE_IDENTITY,
    fileContents: readIfPresent(process.env.FRIDAY_AGE_IDENTITY_FILE),
    diskContents: readIfPresent(AGE_KEY_PATH),
  });
  if (!picked) return undefined;
  // Flag the configuration ADR-051 calls out, once per process: in a container
  // (PID 1) the key sitting beside its own ciphertext defeats the vault.
  // FRI-2008: `process.pid === 1` was wrong — only the supervisor is PID 1,
  // and the vault is read by the daemon and the secrets CLI too, where the
  // warning would never have fired. isContainer() propagates via env.
  if (picked.source === "disk" && isContainer() && !warnedAboutDiskIdentity) {
    warnedAboutDiskIdentity = true;
    console.warn(
      `WARN: age identity read from ${AGE_KEY_PATH}, which is on the same volume as the vault it decrypts — that is obfuscation, not encryption at rest. Inject it at runtime instead via FRIDAY_AGE_IDENTITY or FRIDAY_AGE_IDENTITY_FILE (ADR-051, FRI-2010).`,
    );
  }
  return picked.identity;
}

export async function encryptPayload(plaintext: string, recipient: string): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(plaintext);
}

export async function decryptPayload(ciphertext: Uint8Array, identity: string): Promise<string> {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  const out = await d.decrypt(ciphertext, "text");
  if (typeof out !== "string") {
    throw new Error("age decrypt returned non-text");
  }
  return out;
}

export async function identityToRecipient(identity: string): Promise<string> {
  return age.identityToRecipient(identity);
}
