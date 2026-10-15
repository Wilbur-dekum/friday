/**
 * Homebrew dependency reconciliation for `friday update` (FRI-24).
 *
 * The TS twin of install.sh's `ensure_brew_deps`: install any Brewfile-tracked
 * dep that `brew list <dep>` reports absent, skipping ones already present
 * (idempotent). `friday update` calls this so an existing install picks up a
 * newly-added dep (e.g. `pgvector`, which supplies the `vector` extension the
 * post-update daemon boot requires for migration 0036) without the user having
 * to re-run the curl installer.
 *
 * BREW_DEPS MUST stay byte-for-byte in sync with install.sh's `BREW_DEPS`
 * (same set, same order) — they are the same provisioning contract expressed
 * twice (bash for the curl install, TS for in-place `friday update`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Brewfile-tracked third-party deps Friday relies on. MUST match install.sh's
 * `BREW_DEPS`. pgvector supplies the `vector` extension (FRI-24); the others
 * are the long-standing runtime/build deps.
 */
export const BREW_DEPS = ["fnm", "pnpm", "postgresql@18", "pgvector", "cloudflared", "gh"] as const;

/**
 * Resolve an ABSOLUTE path to the `brew` binary.
 *
 * `friday update` runs interactively, where the operator's PATH has brew. But
 * the supervisor (and any boot-path preflight) runs under launchd, whose PATH
 * is the stripped `/usr/bin:/bin:/usr/sbin:/sbin` — `/usr/local/bin` and
 * `/opt/homebrew/bin` are NOT on it (the friday plist sets no PATH). A bare
 * `brew` therefore resolves only in the interactive path and silently fails
 * under launchd. Probe the two canonical Homebrew prefixes (arm64 first, then
 * Intel) and fall back to bare `brew` (PATH lookup) when neither exists, so the
 * same `brewHas` / `brewInstall` / `checkDeps` code works from both contexts.
 */
export function resolveBrew(exists: (p: string) => boolean = existsSync): string {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (exists(p)) return p;
  }
  return "brew";
}

/**
 * Whether Homebrew exists on this box at all.
 *
 * Reuses `resolveBrew`'s prefix list so there is one definition of "where brew
 * lives": an absolute hit means Homebrew is installed, the bare-`brew` fallback
 * means it is not. The boot preflight needs this to tell a Homebrew-managed
 * local install apart from a container, where `brew list` can only ever fail
 * and gating boot on it would park the stack forever (FRI-2003).
 */
export function brewAvailable(exists: (p: string) => boolean = existsSync): boolean {
  return resolveBrew(exists) !== "brew";
}

/** Whether `brew list <dep>` reports the dep installed. */
export function brewHas(dep: string): boolean {
  const r = spawnSync(resolveBrew(), ["list", dep], { stdio: "ignore" });
  return r.status === 0;
}

/** Install a single brew dep. Returns true on success. */
function brewInstall(dep: string): boolean {
  const r = spawnSync(resolveBrew(), ["install", dep], { stdio: "inherit" });
  return r.status === 0;
}

export interface EnsureBrewDepsResult {
  /** Deps found already installed (skipped — the idempotent path). */
  alreadyPresent: string[];
  /** Deps that were missing and installed successfully this run. */
  installed: string[];
  /** Deps that were missing and whose `brew install` failed. */
  failed: string[];
}

/**
 * Reconcile {@link BREW_DEPS}: install each missing one, skip present ones.
 * Best-effort — a failed `brew install` is recorded in `failed` (the caller
 * decides whether that's fatal) rather than thrown, mirroring install.sh's
 * `|| warn` behavior. Returns the partition of deps by outcome.
 *
 * The `has`/`install` probes are injectable so the unit suite asserts the
 * idempotent-skip + install-missing logic without shelling out to brew.
 */
export function ensureBrewDeps(opts?: {
  log?: (m: string) => void;
  has?: (dep: string) => boolean;
  install?: (dep: string) => boolean;
}): EnsureBrewDepsResult {
  const log = opts?.log ?? (() => {});
  const has = opts?.has ?? brewHas;
  const install = opts?.install ?? brewInstall;

  const alreadyPresent: string[] = [];
  const installed: string[] = [];
  const failed: string[] = [];

  for (const dep of BREW_DEPS) {
    if (has(dep)) {
      alreadyPresent.push(dep);
      continue;
    }
    log(`installing missing brew dep: ${dep}`);
    if (install(dep)) {
      installed.push(dep);
    } else {
      log(`brew install ${dep} failed — install it manually`);
      failed.push(dep);
    }
  }

  return { alreadyPresent, installed, failed };
}
