/**
 * checkDeps() — the read-only dependency preflight that gates the boot/start
 * path — plus the blocked-state file the supervisor writes and `friday status`
 * reads, and the launchd-safe absolute-brew resolver.
 *
 * FRIDAY_DATA_DIR is repointed to a scratch dir BEFORE importing @friday/shared
 * (the data-dir binding rule) so the blocked-state file lands under tmp.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "friday-deps-"));
process.env.FRIDAY_DATA_DIR = DATA;

const {
  checkDeps,
  readBlockedState,
  writeBlockedState,
  clearBlockedState,
  PROVISION_REMEDY,
  formatRemedies,
} = await import("./deps.js");
const { resolveBrew } = await import("./brew-deps.js");

/** A probe set where everything is healthy; tests override one field at a time. */
function healthyOpts() {
  return {
    brewHas: () => true,
    brewPresent: () => true,
    pgHealth: async () => ({
      reachable: true,
      roleExists: true,
      databaseExists: true,
      walLevelLogical: true,
      walLevelActual: "logical",
    }),
    vectorExtension: async () => true,
  };
}

describe("checkDeps — read-only dependency preflight", () => {
  it("reports ok with no hard/soft issues when everything is present", async () => {
    const r = await checkDeps(healthyOpts());
    expect(r.ok).toBe(true);
    expect(r.hard).toEqual([]);
    expect(r.soft).toEqual([]);
  });

  it("flags a missing pgvector binary as HARD with the provision remedy", async () => {
    const r = await checkDeps({ ...healthyOpts(), brewHas: (dep) => dep !== "pgvector" });
    expect(r.ok).toBe(false);
    const issue = r.hard.find((i) => i.name === "brew:pgvector");
    expect(issue).toMatchObject({
      name: "brew:pgvector",
      present: false,
      remedy: PROVISION_REMEDY,
    });
  });

  it("flags a missing vector extension as HARD when Postgres + db are present", async () => {
    const r = await checkDeps({ ...healthyOpts(), vectorExtension: async () => false });
    expect(r.ok).toBe(false);
    expect(r.hard.find((i) => i.name === "pgvector:extension")).toMatchObject({
      present: false,
      remedy: PROVISION_REMEDY,
    });
  });

  it("reports Postgres unreachable as HARD and does NOT also report a missing extension", async () => {
    const r = await checkDeps({
      ...healthyOpts(),
      pgHealth: async () => ({
        reachable: false,
        roleExists: false,
        databaseExists: false,
        walLevelLogical: false,
        walLevelActual: null,
      }),
      vectorExtension: async () => {
        throw new Error("vectorExtension must not be probed when Postgres is unreachable");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.hard.find((i) => i.name === "postgres")).toMatchObject({
      present: false,
      remedy: expect.stringContaining("postgresql@18"),
    });
    // The extension probe is skipped (no double-report of the same root cause).
    expect(r.hard.find((i) => i.name === "pgvector:extension")).toBeUndefined();
  });

  it("flags wal_level != logical as HARD and names the actual level", async () => {
    const r = await checkDeps({
      ...healthyOpts(),
      pgHealth: async () => ({
        reachable: true,
        roleExists: true,
        databaseExists: true,
        walLevelLogical: false,
        walLevelActual: "replica",
      }),
    });
    expect(r.ok).toBe(false);
    const wal = r.hard.find((i) => i.name === "postgres:wal_level");
    expect(wal?.remedy).toContain("replica");
  });
});

describe("blocked-state file (supervisor ↔ status handshake)", () => {
  beforeEach(() => clearBlockedState());
  afterEach(() => clearBlockedState());

  it("round-trips written hard issues and clears them", () => {
    expect(readBlockedState()).toBeNull();
    const hard = [{ name: "pgvector:extension", present: false, remedy: PROVISION_REMEDY }];
    writeBlockedState({ ts: "2026-06-19T00:00:00.000Z", hard });
    const read = readBlockedState();
    expect(read?.ts).toBe("2026-06-19T00:00:00.000Z");
    expect(read?.hard).toEqual(hard);
    clearBlockedState();
    expect(readBlockedState()).toBeNull();
  });

  it("formatRemedies renders one line per issue with its remedy", () => {
    const out = formatRemedies([
      { name: "brew:pgvector", present: false, remedy: "run X" },
      { name: "postgres", present: false, remedy: "start PG" },
    ]);
    expect(out).toContain("brew:pgvector — run X");
    expect(out).toContain("postgres — start PG");
  });
});

describe("resolveBrew — launchd-safe absolute brew path", () => {
  it("prefers the arm64 Homebrew prefix when it exists", () => {
    expect(resolveBrew(() => true)).toBe("/opt/homebrew/bin/brew");
  });

  it("falls back to the Intel prefix when only it exists (launchd PATH lacks brew)", () => {
    expect(resolveBrew((p) => p === "/usr/local/bin/brew")).toBe("/usr/local/bin/brew");
  });

  it("falls back to a bare `brew` PATH lookup when neither prefix exists", () => {
    expect(resolveBrew(() => false)).toBe("brew");
  });
});

process.on("exit", () => rmSync(DATA, { recursive: true, force: true }));

describe("checkDeps — off-Homebrew (container) behaviour, FRI-2003", () => {
  it("does not gate boot on brew:pgvector when Homebrew is absent", async () => {
    // The whole bug: in a container `brew list` can only fail, so an ungated
    // check parks the stack permanently. The direct extension check covers it.
    const r = await checkDeps({ ...healthyOpts(), brewPresent: () => false, brewHas: () => false });
    expect(r.ok).toBe(true);
    expect(r.hard).toEqual([]);
  });

  it("still gates boot on brew:pgvector when Homebrew IS present", async () => {
    const r = await checkDeps({ ...healthyOpts(), brewPresent: () => true, brewHas: () => false });
    expect(r.hard.map((i) => i.name)).toContain("brew:pgvector");
  });

  it("never consults brew at all when Homebrew is absent", async () => {
    let consulted = false;
    await checkDeps({
      ...healthyOpts(),
      brewPresent: () => false,
      brewHas: () => {
        consulted = true;
        return false;
      },
    });
    expect(consulted).toBe(false);
  });

  it("reports the missing extension directly rather than via the brew proxy", async () => {
    const r = await checkDeps({
      ...healthyOpts(),
      brewPresent: () => false,
      brewHas: () => false,
      vectorExtension: async () => false,
    });
    const names = r.hard.map((i) => i.name);
    expect(names).toContain("pgvector:extension");
    expect(names).not.toContain("brew:pgvector");
  });

  it("does not tell a container to run `brew services`", async () => {
    const r = await checkDeps({
      ...healthyOpts(),
      brewPresent: () => false,
      pgHealth: async () => ({
        reachable: false,
        roleExists: false,
        databaseExists: false,
        walLevelLogical: false,
        walLevelActual: null,
      }),
    });
    const pg = r.hard.find((i) => i.name === "postgres");
    expect(pg?.remedy).not.toContain("brew services");
    expect(pg?.remedy).toContain("DATABASE_URL");
  });

  it("does not tell a container to run `friday provision` for the extension", async () => {
    const r = await checkDeps({
      ...healthyOpts(),
      brewPresent: () => false,
      vectorExtension: async () => false,
    });
    const ext = r.hard.find((i) => i.name === "pgvector:extension");
    expect(ext?.remedy).not.toContain("friday provision");
    expect(ext?.remedy).toContain("superuser");
  });

  it("keeps the Homebrew remedies on a Homebrew box", async () => {
    const r = await checkDeps({
      ...healthyOpts(),
      brewPresent: () => true,
      pgHealth: async () => ({
        reachable: false,
        roleExists: false,
        databaseExists: false,
        walLevelLogical: false,
        walLevelActual: null,
      }),
    });
    expect(r.hard.find((i) => i.name === "postgres")?.remedy).toContain("brew services");
  });
});
