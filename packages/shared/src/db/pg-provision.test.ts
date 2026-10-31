// Integration tests for the Postgres provisioning helper (ADR-023).
//
// Skipped unless `pg_isready` reports a reachable Postgres. To run locally:
//   brew services start postgresql@18
//   pnpm --filter @friday/shared exec vitest run src/db/pg-provision.test.ts
//
// CAUTION: these tests exercise the production provisioning path against
// the real `friday` role + database. Post-condition matches what `friday
// setup` leaves behind, so the tests are observational rather than
// destructive — they don't drop the role/db they create.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { upsertEnvVar } from "../env.js";
import { findPgIsReady, probePostgresHealth, provisionPostgres } from "./pg-provision.js";

// FRI-150 (pivot, ADR-037): production code reads ZERO_AUTH_SECRET via
// loadFridayConfig(). Seed the tmpdir .env file once so each test's
// `provisionPostgres()` call sees the secret. `upsertEnvVar` writes to
// disk AND clears the loader cache.
function ensureTestZeroSecret(): void {
  upsertEnvVar("ZERO_AUTH_SECRET", "test-secret-end-to-end");
}

function pgReachable(): boolean {
  return spawnSync(findPgIsReady(), { encoding: "utf8" }).status === 0;
}

const skip = !pgReachable();

describe.skipIf(skip)("provisionPostgres (end-to-end)", () => {
  it("provisions the friday role + database + migrations + publication", async () => {
    ensureTestZeroSecret();

    const result = await provisionPostgres({
      log: () => {}, // quiet
    });

    expect(result.databaseUrl).toMatch(/^postgresql:\/\//);
    expect(result.databaseUrl).toContain("@localhost:5432/friday");

    const health = await probePostgresHealth();
    expect(health.reachable).toBe(true);
    expect(health.roleExists).toBe(true);
    expect(health.databaseExists).toBe(true);
    expect(health.publicationExists).toBe(true);
    expect(health.migrationsAtHead).toBe(true);
    expect(health.migrationsExpected).toBeGreaterThan(0);
    expect(health.migrationsApplied).toBe(health.migrationsExpected);
    expect(health.zeroAuthSecretPresent).toBe(true);
  });

  it("is idempotent across two consecutive runs", async () => {
    ensureTestZeroSecret();

    const first = await provisionPostgres({ log: () => {} });
    const second = await provisionPostgres({ log: () => {} });

    // Second run applies zero new migrations (already at head).
    expect(second.appliedMigrations).toEqual([]);
    // Both runs converge on the same DATABASE_URL.
    expect(first.databaseUrl).toBe(second.databaseUrl);
    // Second run does NOT re-create the publication.
    expect(second.createdPublication).toBe(false);
  });

  it("populates blocks.content_tsv via the FTS setup", async () => {
    ensureTestZeroSecret();
    // Use the URL `provisionPostgres` RETURNS, not `process.env.DATABASE_URL`.
    // Provisioning writes that var to `~/.friday/.env` (a tmpdir here) and
    // never into `process.env`, so reading it back got `undefined`, `pg` fell
    // through to its own defaults, and the test failed against a database
    // named after the OS user — `database "<user>" does not exist`. The `!`
    // assertion is what let an absent value look like a present one.
    const { databaseUrl } = await provisionPostgres({ log: () => {} });

    // Insert + verify tsvector against the live DB.
    const pgPkg = await import("pg");
    const c = new pgPkg.default.Client({ connectionString: databaseUrl });
    await c.connect();
    try {
      const blockId = `fts-smoke-${Date.now()}`;
      await c.query(
        `INSERT INTO blocks
           (block_id, turn_id, agent_name, session_id, block_index,
            role, kind, content_json, status, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())`,
        [
          blockId,
          "fts-turn",
          "orchestrator",
          "fts-session",
          0,
          "user",
          "text",
          JSON.stringify({ text: "hello world testing tsvector" }),
          "complete",
        ],
      );
      const row = await c.query<{
        content_tsv: string;
      }>(`SELECT content_tsv::text FROM blocks WHERE block_id = $1`, [blockId]);
      expect(row.rows[0]?.content_tsv).toContain("hello");
      expect(row.rows[0]?.content_tsv).toContain("world");
      expect(row.rows[0]?.content_tsv).toContain("tsvector");

      // Verify CHECK constraint fires.
      await expect(
        c.query(
          `INSERT INTO blocks
             (block_id, turn_id, agent_name, session_id, block_index,
              role, kind, content_json, status, ts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())`,
          [
            `bad-${Date.now()}`,
            "bad-turn",
            "orchestrator",
            "fts-session",
            1,
            "user",
            "text",
            "{}",
            "totally-bogus",
          ],
        ),
      ).rejects.toThrow(/blocks_status_check/);

      // Clean up.
      await c.query(`DELETE FROM blocks WHERE block_id = $1`, [blockId]);
    } finally {
      await c.end();
    }
  });
});
