import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.js";

/**
 * Per-installation shared secret used to authenticate same-host callers of
 * the daemon's HTTP API. The daemon binds to 127.0.0.1, but that alone does
 * not protect against:
 *
 *   - DNS rebinding: a hostile page can resolve an attacker-controlled
 *     hostname to 127.0.0.1 and `fetch()` the daemon under that origin.
 *   - Other local processes on a shared machine.
 *
 * The dashboard (running as the same OS user) reads this file on startup
 * and injects `x-friday-daemon-secret` on requests to the daemon. The
 * daemon rejects requests that don't match.
 *
 * The file is created on first read with mode 0600 so other users on the
 * machine can't read it.
 */
export const DAEMON_SECRET_PATH = join(DATA_DIR, ".daemon-secret");

let cached: string | null = null;

export function getDaemonSecret(): string {
  if (cached) return cached;
  // Race-safe creation. If daemon and dashboard cold-start concurrently and
  // both observe the file missing, naive existsSync+write lets both win
  // the existsSync but then fight at write — last-write wins on disk while
  // the loser caches its own value forever. Use `wx` (exclusive create)
  // and fall through to a read on EEXIST.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = readFileSync(DAEMON_SECRET_PATH, "utf8").trim();
      if (value) {
        verifyDaemonSecretPermissions();
        cached = value;
        return cached;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const dir = dirname(DAEMON_SECRET_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(DAEMON_SECRET_PATH, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lost the race — loop back and read what the winner wrote.
    }
  }
  throw new Error(`failed to read or create daemon secret at ${DAEMON_SECRET_PATH}`);
}

/** What to do about a daemon-secret file whose mode is too permissive. */
export type SecretModeVerdict = "ok" | "warn" | "fatal";

/**
 * FRI-2009: decide how to react to the file's permissions.
 *
 * FIX_FORWARD 5.9 made any group/other bit a fatal exit, which is right on a
 * shared machine: another OS user who can read the secret can impersonate the
 * daemon's clients. It is wrong for a *provided* secret. ADR-051 moves the
 * daemon secret into the platform secret manager, and those arrive read-only
 * at 0644 (Kubernetes) or 0444 (Docker secrets) — so the same check becomes a
 * boot crash-loop whose remedy ("run chmod") cannot be followed on a read-only
 * mount. The loose bits also mean something different there: they expose the
 * file to other processes *inside this container*, which are all Friday's own,
 * not to other tenants.
 *
 * So: repair it when we can, and only refuse to start when the exposure is
 * real and unfixable.
 *
 * Pure, so every branch is testable without a real file or a real container.
 */
export function classifySecretMode(opts: {
  /** The file's permission bits (`st.mode & 0o777`). */
  perm: number;
  /** Whether a chmod back to 0600 succeeded. */
  repaired: boolean;
  /** Whether we are PID 1 — i.e. a container, where the file is not shared
   *  with other users, only with our own processes. */
  containerized: boolean;
}): SecretModeVerdict {
  if ((opts.perm & 0o077) === 0) return "ok";
  if (opts.repaired) return "ok";
  // Could not fix it. On a shared host the original reasoning stands.
  // In a container, refusing to boot is worse than the exposure it prevents.
  return opts.containerized ? "warn" : "fatal";
}

function verifyDaemonSecretPermissions(): void {
  // Windows reports mode bits as 0666; the check is meaningful only on
  // unix-y filesystems where chmod 0600 is enforced.
  if (process.platform === "win32") return;
  const perm = statSync(DAEMON_SECRET_PATH).mode & 0o777;

  let repaired = false;
  if ((perm & 0o077) !== 0) {
    // Self-heal first. A file we own on a writable volume just gets fixed;
    // only a read-only or foreign-owned mount reaches the verdict below.
    try {
      chmodSync(DAEMON_SECRET_PATH, 0o600);
      repaired = (statSync(DAEMON_SECRET_PATH).mode & 0o077) === 0;
    } catch {
      repaired = false;
    }
  }

  const verdict = classifySecretMode({
    perm,
    repaired,
    containerized: process.pid === 1,
  });
  if (verdict === "ok") return;

  const octal = perm.toString(8).padStart(3, "0");
  if (verdict === "warn") {
    console.warn(
      `WARN: daemon-secret file ${DAEMON_SECRET_PATH} has mode ${octal} (group/other bits set) and could not be chmod'd — it is probably a read-only secret mount. Continuing: inside a container those bits expose it only to this container's own processes. Set the mount's mode to 0600 to silence this.`,
    );
    return;
  }

  console.error(
    `FATAL: daemon-secret file ${DAEMON_SECRET_PATH} has mode ${octal} (group/other bits set) and could not be repaired automatically. On a shared machine any other user can read it and impersonate the daemon's clients. Run: chmod 0600 ${DAEMON_SECRET_PATH}`,
  );
  process.exit(1);
}

export const DAEMON_SECRET_HEADER = "x-friday-daemon-secret";

/** Hostnames that are acceptable on the `Host` header for daemon requests.
 *  Used as a DNS-rebind defense alongside the shared-secret check. */
export function isLocalHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
