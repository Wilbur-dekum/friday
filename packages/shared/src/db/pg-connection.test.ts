/**
 * FRI-2004 — the Postgres connection is configuration, not a constant.
 *
 * Three call sites used to inline
 * `postgresql://${process.env.USER}@localhost:5432/friday` as their fallback,
 * which is only ever correct on a Homebrew Mac: in a container `localhost` is
 * the container itself and `$USER` is `node`. These pin the resolution rules,
 * including the one that is easy to get wrong — that the ADMIN url and the
 * APPLICATION url are deliberately different, because `CREATE EXTENSION
 * vector` needs a superuser the `friday` role is not (ADR-044).
 *
 * Resolution is exercised through the exported functions rather than directly:
 * the resolvers are private, and what matters is the URL each public entry
 * point ends up connecting with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "friday-pgconn-"));

const connectSpy = vi.fn();
vi.mock("pg", () => {
  class Client {
    connectionString: string;
    constructor(cfg: { connectionString: string }) {
      this.connectionString = cfg.connectionString;
      connectSpy(cfg.connectionString);
    }
    async connect() {}
    async query() {
      return { rows: [] as unknown[] };
    }
    async end() {}
  }
  return { default: { Client }, Client };
});

const { hasVectorExtension, ensureVectorExtension } = await import("./pg-provision.js");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  connectSpy.mockClear();
  delete process.env.DATABASE_URL;
  delete process.env.FRIDAY_ADMIN_DATABASE_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("application connection (FRI-2004)", () => {
  it("uses DATABASE_URL when set, rather than a hardcoded localhost", async () => {
    process.env.DATABASE_URL = "postgresql://friday:pw@db.internal:6000/friday";
    await hasVectorExtension();
    expect(connectSpy).toHaveBeenCalledWith("postgresql://friday:pw@db.internal:6000/friday");
  });

  it("never assumes localhost when a host is configured", async () => {
    process.env.DATABASE_URL = "postgresql://friday:pw@postgres:5432/friday";
    await hasVectorExtension();
    expect(connectSpy.mock.calls[0][0]).not.toContain("localhost");
  });

  it("still honours an explicit connectionString argument", async () => {
    process.env.DATABASE_URL = "postgresql://friday:pw@db.internal:6000/friday";
    await hasVectorExtension("postgresql://other@elsewhere:5432/scratch");
    expect(connectSpy).toHaveBeenCalledWith("postgresql://other@elsewhere:5432/scratch");
  });
});

describe("admin connection is distinct from the application one (FRI-2004)", () => {
  it("uses FRIDAY_ADMIN_DATABASE_URL for CREATE EXTENSION, not DATABASE_URL", async () => {
    // The whole point: DATABASE_URL is the `friday` role, which cannot
    // CREATE EXTENSION. Using it here would fail on permissions.
    process.env.DATABASE_URL = "postgresql://friday:pw@postgres:5432/friday";
    process.env.FRIDAY_ADMIN_DATABASE_URL = "postgresql://postgres:su@postgres:5432/postgres";
    await ensureVectorExtension();
    const used = connectSpy.mock.calls[0][0] as string;
    expect(used).toContain("postgres:su@");
    expect(used).not.toContain("friday:pw@");
  });

  it("retargets the admin credentials at the friday database", async () => {
    // Same credentials are used against `postgres` (create role/db) and the
    // Friday database (create extension), so the path has to be swapped.
    process.env.FRIDAY_ADMIN_DATABASE_URL = "postgresql://postgres:su@postgres:5432/postgres";
    await ensureVectorExtension();
    expect(connectSpy.mock.calls[0][0]).toMatch(/\/friday$/);
  });

  it("passes an unparseable admin url through untouched rather than guessing", async () => {
    process.env.FRIDAY_ADMIN_DATABASE_URL = "not-a-url";
    await ensureVectorExtension();
    expect(connectSpy).toHaveBeenCalledWith("not-a-url");
  });
});
