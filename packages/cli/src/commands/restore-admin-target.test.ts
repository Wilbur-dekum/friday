import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdminPsqlTarget } from "./restore.js";

/**
 * FRI-2014. `friday restore`'s superuser steps (DROP/CREATE DATABASE, the
 * replication-slot cleanup, the role-password sync) used a hardcoded
 * `psql -d postgres`, which assumes a local Postgres reachable over the Unix
 * socket. Inside a Deployment there is none, and restore died on the first
 * admin step with "No such file or directory".
 */
describe("resolveAdminPsqlTarget", () => {
  const saved = process.env.FRIDAY_ADMIN_DATABASE_URL;

  beforeEach(() => {
    delete process.env.FRIDAY_ADMIN_DATABASE_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.FRIDAY_ADMIN_DATABASE_URL;
    else process.env.FRIDAY_ADMIN_DATABASE_URL = saved;
  });

  it("falls back to the bare database name so the laptop keeps using the socket", () => {
    // NOT `resolveAdminUrl`'s `postgresql://$USER@localhost:5432/postgres`.
    // That is a different connection: on a machine with another Postgres on
    // 5432 (a second project's container) it would silently point the admin
    // connection — and therefore DROP DATABASE — at the wrong server.
    expect(resolveAdminPsqlTarget()).toBe("postgres");
  });

  it("uses the configured admin URL when one is set, with the database swapped to postgres", () => {
    process.env.FRIDAY_ADMIN_DATABASE_URL = "postgresql://postgres:pw@db.internal:5432/friday";
    const target = resolveAdminPsqlTarget();
    expect(target).toContain("db.internal:5432");
    expect(new URL(target).pathname).toBe("/postgres");
  });
});
