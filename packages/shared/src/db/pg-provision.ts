// Postgres provisioning helper invoked by `friday setup` (ADR-023).
//
// Idempotent: safe to run any number of times. Each step is guarded by an
// existence check or a CATCH on the duplicate-object error class.
//
// Responsibilities:
//   1. Verify Postgres is reachable (pg_isready).
//   2. Generate `friday` role + database if missing.
//   3. Persist `DATABASE_URL` to ~/.friday/.env.
//   4. Apply Drizzle Postgres migrations from packages/shared/drizzle-pg/.
//   5. Apply FTS_SETUP_SQL (generated tsvector columns + GIN indexes).
//   6. Create publication `friday_pub` for Zero's logical replication.
//
// Phase 0 caveat: this runs side-by-side with the legacy SQLite migration
// chain. The daemon code path still reads/writes SQLite; Postgres exists
// but is unused at runtime until Phase 1.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pgPkg from "pg";
import { ZERO_DIR } from "../config.js";
import { loadFridayConfig, upsertEnvVar } from "../env.js";
import { FTS_SETUP_SQL } from "./schema.js";

const { Client } = pgPkg;

const FRIDAY_DB = "friday";
const FRIDAY_ROLE = "friday";
const FRIDAY_PUBLICATION = "friday_pub";

/**
 * Tables `friday_pub` includes in logical replication for Zero.
 *
 * Narrow on purpose — zero-cache replicates this publication into its
 * own sqlite replica and would otherwise stream every write to every
 * table. With FOR ALL TABLES (the original Phase 2 setup),
 * high-frequency daemon writes against `usage` / `db_meta` and
 * schema-version churn from Drizzle migrations both feed Zero data it
 * doesn't serve, and either trigger `AutoResetSignal` restarts when
 * upstream/replica versions diverge.
 *
 * Inclusion criteria: a table is in `SYNC_TABLES` iff it's declared in
 * the Zero sync schema at `packages/shared/src/sync/schema.ts` OR is
 * planned for a Phase 3 slice. Phase 3 slices add their tables to this
 * list when they land.
 *
 * Exclusions:
 *   - BetterAuth tables (`user`, `session`, `account`, `verification`)
 *     — server-only, gated by the dashboard session middleware.
 *   - `usage` — high-volume append-only telemetry; surfaced via REST.
 *   - `db_meta` — internal kv (rate-limit buckets, schema version).
 */
export const SYNC_TABLES: readonly string[] = [
  // Phase 2 (live)
  "agents",
  // Phase 3 slices (declared up front to avoid touching the
  // publication when each slice lands; tables exist already in the
  // Drizzle schema)
  "tickets",
  "ticket_comments",
  "ticket_relations",
  "ticket_external_links",
  "schedules",
  "schedule_runs",
  "memory_entries",
  "apps",
  "mail",
  "blocks",
  "attachments",
  // Phase 6 surfaces
  "client_devices",
  "read_cursors",
  "system_banners",
  // Phase 4.3
  "settings",
  // Item #54 — evolve proposals as a Zero-replicated table. Missed
  // from this list on first ship; the browser's Zero schema declared
  // it but the publication didn't, so zero-cache served clients a
  // schema fingerprint the daemon's table set couldn't match and
  // every page load fell into a SchemaVersionNotSupported reload
  // loop. Adding a table here is now self-healing: `reconcileSyncPublication`
  // runs on every daemon boot (right after migrations), so a `friday update`
  // deploy lands the new table in `friday_pub` automatically — no
  // `friday setup` re-run, no replication-slot rebuild. (Before that boot-time
  // reconcile, `habits`/`habit_checkins` reproduced this exact loop on the
  // first update-only deploy that shipped them.)
  "evolve_proposals",
  // FRI-169: Habits. The Today card + /habits route read these reactively
  // via Zero; the `habitCheckin` mutator's INSERT replicates to clients
  // the same way an MCP-originated Check-in does (same `friday_pub`).
  "habits",
  "habit_checkins",
  // FRI-171 (ADR-047): Inbox. The bell + Inbox review surface read these
  // reactively via Zero; the daemon writes one row per Capture and the
  // inbox mutators flip `state`. `apikey` is NOT replicated (server-only,
  // like `user`/`session`).
  "inbox_items",
  // FRI-142 (ADR-048): `push_subscriptions` AND `web_push_vapid` are
  // INTENTIONALLY ABSENT here. Both are server-only (the `apikey` precedent).
  // `push_subscriptions` — the endpoint + encryption keys are sensitive and the
  // client learns its own subscription from `pushManager.getSubscription()`.
  // `web_push_vapid` — holds the VAPID PRIVATE key, a secret that must NEVER
  // replicate to the browser; the dashboard only ever sees the PUBLIC half via
  // `GET /api/push/vapid-public-key`. Both are also absent from the Zero sync
  // schema (sync/schema.ts). Do NOT add either here. (`settings` IS replicated
  // and already listed above — its new notify_policy/DND columns ride the
  // existing `settings` entry.)
];

export interface ProvisionResult {
  /** True when this run created a brand-new role/database/migration chain. */
  freshInstall: boolean;
  /** DATABASE_URL written to ~/.friday/.env. */
  databaseUrl: string;
  /** Migrations applied this run. Empty when already at head. */
  appliedMigrations: string[];
  /** True when the publication was created this run. */
  createdPublication: boolean;
  /** True when this run changed `wal_level` to logical — Postgres must be
   *  restarted for it to take effect (ALTER SYSTEM is postmaster-level). False
   *  when it was already logical (no restart needed). Lets `friday setup`
   *  restart Postgres ONLY when the level actually changed, so re-runs on a
   *  live prod box don't bounce a Postgres that's already configured. */
  walLevelChanged: boolean;
}

/**
 * Run the full provisioning pipeline. Idempotent. Throws on unrecoverable
 * errors (Postgres unreachable, permission denied at the admin layer, etc.)
 * with an actionable message.
 */
export async function provisionPostgres(opts: {
  /** Override the migration directory (defaults to the shared package's). */
  migrationsDir?: string;
  /** Caller for logging — `setup` prints, tests stay quiet. */
  log?: (msg: string) => void;
}): Promise<ProvisionResult> {
  const log = opts.log ?? (() => {});
  const migrationsDir = opts.migrationsDir ?? defaultMigrationsDir();

  await assertPgReady(adminConnectionUrl());
  log("  postgres is reachable");

  const adminUrl = adminConnectionUrl();
  const password = generateOrReuseFridayPassword();
  const created = await ensureRoleAndDatabase(adminUrl, password, log);

  // FRI-2004: host:port comes from the admin connection we just provisioned
  // against, not a hardcoded `localhost`. On a Homebrew Mac that resolves to
  // localhost:5432 exactly as before; for a self-hosted Deployment pointed at
  // a managed Postgres via FRIDAY_ADMIN_DATABASE_URL, the written DATABASE_URL
  // now follows it instead of silently naming a database that is not there.
  const adminHost = (() => {
    try {
      const u = new URL(adminUrl);
      return `${u.hostname}:${u.port || "5432"}`;
    } catch {
      return "localhost:5432";
    }
  })();
  const databaseUrl = `postgresql://${FRIDAY_ROLE}:${encodeURIComponent(
    password,
  )}@${adminHost}/${FRIDAY_DB}`;
  upsertEnvVar("DATABASE_URL", databaseUrl);
  log(`  DATABASE_URL → ~/.friday/.env`);

  // Phase 2 / ADR-024: zero-cache reads ZERO_UPSTREAM_DB (the Postgres URL
  // it replicates from) and ZERO_REPLICA_FILE (its internal sqlite cache).
  // Mirror the Postgres URL here so a single `friday setup` flow puts
  // both DATABASE_URL and ZERO_UPSTREAM_DB in `.env` — keeping them in sync
  // when the password is rotated.
  upsertEnvVar("ZERO_UPSTREAM_DB", databaseUrl);
  const zeroReplicaFile = join(ZERO_DIR, "replica.db");
  if (!existsSync(ZERO_DIR)) mkdirSync(ZERO_DIR, { recursive: true });
  upsertEnvVar("ZERO_REPLICA_FILE", zeroReplicaFile);
  // ZERO_APP_PUBLICATIONS is NOT written here. The publication name is now
  // supplied as a code default by the supervisor
  // (`packages/cli/src/bin/supervisor.ts`), placed before the process.env
  // spread so ~/.friday/.env can still override it. The publication itself
  // (`friday_pub`) is still created below in `ensurePublication` via an admin
  // connection — the friday role lacks superuser, so zero-cache can't CREATE
  // PUBLICATION on its own. Setup just no longer persists the name.
  // ZERO_MUTATE_URL is NOT written here. Post-FRI-88, the supervisor
  // (`packages/cli/src/bin/supervisor.ts`) exports it dynamically at
  // zero-cache spawn time, derived from `resolveDashboardPort(cfg)`.
  // Writing a static `.env` value caused the FRI-83 flip failure mode:
  // the persisted port string drifted from the runtime config every
  // time the prod dashboard port changed, and the dynamic export
  // shadowed it but `friday doctor` warned about the stale value
  // forever. The right move is to never persist the URL.
  log(`  ZERO_UPSTREAM_DB + ZERO_REPLICA_FILE → ~/.friday/.env`);

  // FRI-150 (pivot, ADR-037): ZERO_AUTH_SECRET is generated by
  // loadFridayConfig() (called from `friday setup` before
  // provisionPostgres). Verify it's present so we fail loudly if a
  // future caller skips that step.
  if (!loadFridayConfig().zeroAuthSecret) {
    throw new Error(
      "ZERO_AUTH_SECRET not set. Call loadFridayConfig() before provisionPostgres().",
    );
  }

  // FRI-24: the `vector` extension MUST exist before migrations run —
  // 0036's `ADD COLUMN embedding vector(384)` depends on the type. pgvector
  // 0.8.2 is NOT a trusted extension, so the non-superuser `friday` role
  // (which daemon boot runs migrations as) cannot CREATE EXTENSION itself.
  // We create it here via the admin (OS-superuser) connection. Unlike the
  // embedding runtime/model (fail-open), the extension is a hard schema
  // dependency: ensureVectorExtension throws if it can't be created.
  await ensureVectorExtension(log);

  const appliedMigrations = await applyMigrations(databaseUrl, migrationsDir, log);

  const createdPublication = await ensurePublication(databaseUrl, log);

  // Phase 2 (ADR-024): Zero needs logical replication enabled. The
  // default `wal_level = replica` leaves zero-cache in a boot loop —
  // surface the fix here so `friday setup` is idempotent end-to-end.
  const walLevelChanged = await ensureWalLevelLogical(log);

  return {
    freshInstall: created.role || created.database,
    databaseUrl,
    appliedMigrations,
    createdPublication,
    walLevelChanged,
  };
}

/* -------------------- helpers -------------------- */

function defaultMigrationsDir(): string {
  // Resolve relative to this file's location. Post-build path is
  // `dist/db/pg-provision.js`; source-tree path is `src/db/pg-provision.ts`.
  // In both cases, going up two levels reaches the package root where
  // `drizzle/` lives (the canonical Postgres migration dir after the
  // Phase 1 swap).
  const here = new URL("..", import.meta.url).pathname;
  const pkgRoot = join(here, "..");
  return join(pkgRoot, "drizzle");
}

/**
 * Resolve a Postgres client binary (`pg_isready`, `pg_dump`, `psql`,
 * `pg_restore`, …) to an executable. On Homebrew versioned installs
 * (`postgresql@18` is keg-only) only `<name>-18` may be on PATH, not the bare
 * name. Tries bare first, then versioned suffixes 18→16, then scans Homebrew
 * opt paths directly. Used by provisioning AND backup/restore so they run on a
 * stock Postgres box where the bare binaries aren't on PATH.
 */
export function findPgBin(name: string): string {
  const candidates = [name, `${name}-18`, `${name}-17`, `${name}-16`];
  for (const c of candidates) {
    const probe = spawnSync("which", [c], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) return c;
  }
  const homebrewPrefix = process.arch === "arm64" ? "/opt/homebrew" : "/usr/local";
  for (const ver of [18, 17, 16]) {
    const fullPath = `${homebrewPrefix}/opt/postgresql@${ver}/bin/${name}`;
    if (existsSync(fullPath)) return fullPath;
  }
  return name;
}

export function findPgIsReady(): string {
  return findPgBin("pg_isready");
}

/**
 * FRI-2004: reachability is a CONNECTION, not a local binary.
 *
 * This used to `spawnSync(pg_isready)` with no arguments, which fails twice
 * over off a Homebrew Mac: the binary is not installed in a container at all,
 * and with no arguments it probes `localhost:5432` — so it ignored
 * DATABASE_URL and answered a question nobody asked. Connecting with the
 * resolved URL instead needs no client package and actually tests the
 * configured target: host, port, credentials and database in one go.
 *
 * Takes the URL explicitly because the two callers mean different things by
 * "reachable": provisioning needs the ADMIN connection it is about to create
 * the role and database with, while the boot-path health probe needs the
 * APPLICATION connection the daemon will really use.
 */
async function assertPgReady(connectionString: string): Promise<void> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const remedy = process.env.FRIDAY_ADMIN_DATABASE_URL
      ? "check the configured host, port and credentials"
      : "run `brew services start postgresql@18` and re-run setup";
    throw new Error(`Postgres is not reachable — ${remedy}.\n  ${detail}`, { cause: err });
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The legacy Homebrew-local shape: connect as the current OS user, who is the
 * superuser by default under `brew install postgresql@18`. Retained as the
 * fallback so a macOS install keeps working with no configuration, but it is
 * only ever correct on that one topology — see the two resolvers below.
 */
function localHomebrewUrl(database: string): string {
  const user = process.env.USER ?? "postgres";
  return `postgresql://${user}@localhost:5432/${database}`;
}

/**
 * FRI-2004: the Friday application database, as CONFIGURATION.
 *
 * Previously three call sites each inlined
 * `postgresql://${process.env.USER}@localhost:5432/friday` as their fallback,
 * which is wrong anywhere that is not a Homebrew Mac — in a container
 * `localhost` is the container itself, and `$USER` is `node`. ADR-050 puts
 * Postgres outside the container entirely, so the connection has to be a
 * setting, not a constant, and nothing may assume a stable host (which is also
 * what keeps ADR-051's later shared→dedicated server move cheap).
 *
 * Same precedence `getDbAndPool()` uses: explicit env first (the test
 * convention), then the resolved config, then the legacy local default.
 */
function resolveFridayDbUrl(): string {
  return process.env.DATABASE_URL ?? loadFridayConfig().databaseUrl ?? localHomebrewUrl(FRIDAY_DB);
}

/**
 * A SUPERUSER connection, for the operations the `friday` role deliberately
 * cannot perform: CREATE ROLE / CREATE DATABASE, and `CREATE EXTENSION vector`
 * (ADR-044). Distinct from `resolveFridayDbUrl()` on purpose — pointing these
 * at DATABASE_URL would fail with a permissions error rather than work.
 *
 * `FRIDAY_ADMIN_DATABASE_URL` supplies it where the OS user is not a superuser
 * (any container, any managed Postgres). The target database is swapped in
 * because the same credentials are used against both `postgres` (to create the
 * role and database) and the Friday database itself (to create the extension).
 *
 * FRI-2005 removes the boot-path use of this entirely: on a shared cluster one
 * superuser credential reaches every Deployment's database, so a Deployment
 * must never hold one. Until then it is at least configurable rather than
 * assumed.
 */
export function resolveAdminUrl(database: string): string {
  const configured = process.env.FRIDAY_ADMIN_DATABASE_URL;
  if (!configured) return localHomebrewUrl(database);
  try {
    const u = new URL(configured);
    u.pathname = `/${database}`;
    return u.toString();
  } catch {
    // Not parseable as a URL — hand it back untouched rather than silently
    // substituting a local default the operator did not ask for. The caller's
    // connect() will fail with the real reason.
    return configured;
  }
}

function adminConnectionUrl(): string {
  return resolveAdminUrl("postgres");
}

function generateOrReuseFridayPassword(): string {
  // FRI-150 (pivot, ADR-037): prefer process.env.DATABASE_URL (test
  // fixture path) then fall through to loadFridayConfig().databaseUrl.
  const existing = process.env.DATABASE_URL ?? loadFridayConfig().databaseUrl;
  if (existing) {
    try {
      const url = new URL(existing);
      if (url.password) return decodeURIComponent(url.password);
    } catch {
      // Malformed URL — fall through to generation.
    }
  }
  return randomBytes(24).toString("base64url");
}

async function ensureRoleAndDatabase(
  adminUrl: string,
  password: string,
  log: (msg: string) => void,
): Promise<{ role: boolean; database: boolean }> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    let createdRole = false;
    let createdDatabase = false;

    const roleExists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [
      FRIDAY_ROLE,
    ]);
    if (roleExists.rows.length === 0) {
      // Password is parameterized via crypto-safe escape (single-quote
      // escaping); Postgres doesn't accept bind parameters in CREATE ROLE.
      // REPLICATION grants the role permission to use logical replication
      // (required by zero-cache); LOGIN lets the role authenticate normally.
      const escapedPwd = password.replace(/'/g, "''");
      await client.query(`CREATE ROLE ${FRIDAY_ROLE} LOGIN REPLICATION PASSWORD '${escapedPwd}'`);
      createdRole = true;
      log(`  created role ${FRIDAY_ROLE} (LOGIN REPLICATION)`);
    } else {
      // Update the password + ensure REPLICATION attribute. Idempotent.
      const escapedPwd = password.replace(/'/g, "''");
      await client.query(
        `ALTER ROLE ${FRIDAY_ROLE} WITH LOGIN REPLICATION PASSWORD '${escapedPwd}'`,
      );
      log(`  role ${FRIDAY_ROLE} already exists (password + REPLICATION synced)`);
    }

    const dbExists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      FRIDAY_DB,
    ]);
    if (dbExists.rows.length === 0) {
      await client.query(`CREATE DATABASE ${FRIDAY_DB} OWNER ${FRIDAY_ROLE}`);
      createdDatabase = true;
      log(`  created database ${FRIDAY_DB}`);
    } else {
      log(`  database ${FRIDAY_DB} already exists`);
    }

    return { role: createdRole, database: createdDatabase };
  } finally {
    await client.end();
  }
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

async function applyMigrations(
  databaseUrl: string,
  migrationsDir: string,
  log: (msg: string) => void,
): Promise<string[]> {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(
      `Migration journal not found at ${journalPath}. ` +
        `Did you run \`pnpm --filter @friday/shared exec drizzle-kit generate --config=drizzle.config.pg.ts\`?`,
    );
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Drizzle's Postgres migrator tracks applied migrations in
    // drizzle.__drizzle_migrations (separate schema to avoid colliding
    // with app tables). Create it if missing and use it as the cursor.
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )
    `);

    const appliedRows = await client.query<{ created_at: string }>(
      `SELECT created_at FROM drizzle.__drizzle_migrations`,
    );
    const appliedWhens = new Set(appliedRows.rows.map((r) => Number(r.created_at)));

    // Acquire advisory lock so concurrent setup invocations (or daemon
    // boot vs. setup) can't race the migration application. The lock
    // key 0x4652494441590001 is "FRIDAY\x00\x01" as bigint — distinct,
    // namespaced, no collision risk.
    const LOCK_KEY = BigInt("0x4652494441590001");
    await client.query(`SELECT pg_advisory_lock($1)`, [LOCK_KEY.toString()]);
    try {
      const sortedEntries = [...journal.entries].sort((a, b) => a.when - b.when);
      for (const entry of sortedEntries) {
        if (appliedWhens.has(entry.when)) continue;
        const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
        if (!existsSync(sqlPath)) {
          throw new Error(`Migration file missing: ${sqlPath} (referenced by journal)`);
        }
        const rawSql = readFileSync(sqlPath, "utf8");
        // Split on the drizzle statement-breakpoint comment to apply
        // statements one at a time. (PG can run multi-statement strings
        // in a single query call, but explicit per-statement gives us
        // better error reporting.)
        const statements = rawSql
          .split(/-->\s*statement-breakpoint/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        await client.query("BEGIN");
        try {
          for (const stmt of statements) {
            await client.query(stmt);
          }
          await client.query(
            `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
            [entry.tag, entry.when],
          );
          await client.query("COMMIT");
          applied.push(entry.tag);
          log(`  applied migration ${entry.tag}`);
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }

      // FTS setup is idempotent (uses IF NOT EXISTS / generated-column
      // pattern); run it once per provisioning so post-migration schema
      // changes that add tsvector columns flow through.
      await client.query(FTS_SETUP_SQL);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY.toString()]);
    }

    if (applied.length === 0) {
      log(`  migrations at head (${journal.entries.length} total)`);
    }

    // Self-check: journal count vs. applied row count (matches CLAUDE.md
    // runMigrations() contract).
    const finalCount = await client.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM drizzle.__drizzle_migrations`,
    );
    const dbCount = Number(finalCount.rows[0]?.c ?? "0");
    if (dbCount !== journal.entries.length) {
      throw new Error(
        `Drizzle journal/db mismatch after migration: journal=${journal.entries.length} db=${dbCount}. ` +
          `Diagnose which when value is wrong; do NOT delete rows.`,
      );
    }
  } finally {
    await client.end();
  }
  return applied;
}

/**
 * Ensure the pgvector `vector` extension exists in the friday DB (FRI-24).
 *
 * pgvector 0.8.2 is NOT a trusted extension (empirically confirmed against
 * the live system): `CREATE EXTENSION vector` requires SUPERUSER. The
 * `friday` role is not superuser and daemon boot runs migrations as
 * `friday`, so the extension can't live inside a migration. We create it
 * here via the same admin-connected-to-friday-DB pattern `ensurePublication`
 * uses (OS user = Homebrew-PG superuser, connected to the friday DB).
 *
 * Returns true when this run created the extension, false when it already
 * existed. Throws (does NOT fail-open) if creation fails — the extension is
 * a hard schema dependency for the 0036 `embedding vector(384)` column.
 *
 * `connectionString` overrides the connection target (tests point it at a
 * scratch DB, where the OS user is the superuser). Production omits it and
 * gets the admin-in-friday URL — the same pattern `ensurePublication` uses.
 */
export async function ensureVectorExtension(
  log: (msg: string) => void = () => {},
  connectionString?: string,
): Promise<boolean> {
  // SUPERUSER: `CREATE EXTENSION vector` is exactly what the `friday` role
  // cannot do, so this resolves the admin URL rather than DATABASE_URL.
  const adminInFriday = connectionString ?? resolveAdminUrl(FRIDAY_DB);
  const client = new Client({ connectionString: adminInFriday });
  await client.connect();
  try {
    const before = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    if (before.rows.length > 0) {
      log(`  pgvector extension already present`);
      return false;
    }
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    log(`  created pgvector extension (as admin)`);
    return true;
  } finally {
    await client.end();
  }
}

/**
 * Read-only check: is the pgvector `vector` extension installed in the friday
 * DB? The inverse-free twin of {@link ensureVectorExtension} — it NEVER
 * creates anything, so it is safe to call from boot-path preflights (the
 * supervisor gate, `friday start`, `friday doctor`) that must only DETECT a
 * missing dependency, never install one.
 *
 * Connects via the same admin-in-friday URL `ensureVectorExtension` uses (OS
 * user = Homebrew-PG superuser) so the check and the create agree on the
 * target DB; `pg_extension` is readable by any role, so the connection role is
 * immaterial to the result. Returns `false` (never throws) on any connection
 * failure — an unreachable Postgres is a separate hard dep that
 * {@link probePostgresHealth} reports; this probe answers only "is the
 * extension present" and a connection failure is reported as "not present"
 * rather than crashing the preflight.
 *
 * `connectionString` overrides the target (tests point it at a scratch DB).
 */
export async function hasVectorExtension(connectionString?: string): Promise<boolean> {
  // Read-only (`SELECT 1 FROM pg_extension`), so the application role suffices
  // and this must work on the boot path where no superuser is available.
  const target = connectionString ?? resolveFridayDbUrl();
  const client = new Client({ connectionString: target });
  try {
    await client.connect();
  } catch {
    return false;
  }
  try {
    const r = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    return r.rows.length > 0;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

/** Outcome of a {@link reconcileSyncPublication} run. */
export interface PublicationReconcileResult {
  /** Publication did not exist (or was a legacy FOR ALL TABLES form) and was
   *  built/rebuilt from scratch this run. */
  created: boolean;
  /** Tables added to the publication this run (incl. the full set on create). */
  added: string[];
  /** Tables dropped from the publication this run. */
  dropped: string[];
  /** True when not one desired sync table exists in the DB yet — nothing to
   *  reconcile (e.g. called before migrations on a fresh DB). */
  noTables: boolean;
}

/**
 * Reconcile the `friday_pub` logical-replication publication so it matches
 * exactly the desired sync tables that currently exist in the DB. The single
 * source of truth for "which tables Zero replicates"; idempotent:
 *   - publication missing        → CREATE PUBLICATION FOR TABLE <list>
 *   - legacy FOR ALL TABLES form → DROP + recreate as the narrow list
 *   - otherwise                  → ALTER PUBLICATION ADD/DROP to align
 *
 * Connects as the OS-level Postgres superuser (peer auth into the friday DB —
 * no secret involved). CREATE PUBLICATION FOR TABLE requires ownership of the
 * tables (which `friday` has); we keep the publication owned by the admin user
 * so the replication slot survives reconciliation.
 *
 * Called from BOTH `friday setup` (via {@link provisionPostgres}) AND daemon
 * boot right after migrations. The daemon-boot call is what makes a `friday
 * update` deploy "fully complete an upgrade": migrations create a new
 * replicated table (e.g. FRI-169 `habits`) but, historically, ONLY setup added
 * it to `friday_pub`. A box upgraded via `friday update` never re-ran setup, so
 * the new table was absent from the publication and every client whose bundled
 * Zero schema knew the table fell into a `SchemaVersionNotSupported` reload
 * loop. Running it on every boot closes that gap for update/restart/start.
 *
 * `opts.connectionString` overrides the target (tests point it at a scratch
 * DB); `opts.tables` overrides the desired set (tests use arbitrary names).
 */
export async function reconcileSyncPublication(
  log: (msg: string) => void = () => {},
  opts: { connectionString?: string; tables?: readonly string[] } = {},
): Promise<PublicationReconcileResult> {
  // Runs on every daemon boot (ADR-045) and alters a publication the Friday
  // role owns, so it uses the application connection — a boot path cannot
  // depend on a superuser credential being present.
  const target = opts.connectionString ?? resolveFridayDbUrl();
  const desired = opts.tables ?? SYNC_TABLES;
  const client = new Client({ connectionString: target });
  await client.connect();
  try {
    // Find which of the desired tables actually exist in the DB right now.
    // Boot/setup run this after migrations, so all should exist; this guard
    // keeps the call safe if a future schema change drops a table before the
    // desired list is updated.
    const existingTables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [Array.from(desired)],
    );
    const wanted = new Set(existingTables.rows.map((r) => r.tablename));
    if (wanted.size === 0) {
      log(`  publication ${FRIDAY_PUBLICATION} skipped (no sync tables exist yet)`);
      return { created: false, added: [], dropped: [], noTables: true };
    }

    const exists = await client.query<{ puballtables: boolean }>(
      `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
      [FRIDAY_PUBLICATION],
    );
    if (exists.rows.length === 0) {
      const tableList = Array.from(wanted)
        .map((t) => `"${t}"`)
        .join(", ");
      await client.query(`CREATE PUBLICATION ${FRIDAY_PUBLICATION} FOR TABLE ${tableList}`);
      log(`  created publication ${FRIDAY_PUBLICATION} for ${wanted.size} table(s) (as admin)`);
      return { created: true, added: Array.from(wanted), dropped: [], noTables: false };
    }

    // Reconcile an existing publication to match the desired set exactly.
    // If the existing one is FOR ALL TABLES, we drop + recreate (the
    // narrow form is incompatible). Otherwise we ALTER to ADD/DROP
    // specific tables so the replication slot survives.
    const wasAllTables = exists.rows[0]?.puballtables === true;
    if (wasAllTables) {
      await client.query(`DROP PUBLICATION ${FRIDAY_PUBLICATION}`);
      const tableList = Array.from(wanted)
        .map((t) => `"${t}"`)
        .join(", ");
      await client.query(`CREATE PUBLICATION ${FRIDAY_PUBLICATION} FOR TABLE ${tableList}`);
      log(
        `  rebuilt publication ${FRIDAY_PUBLICATION} (was FOR ALL TABLES → FOR TABLE list of ${wanted.size}; admin)`,
      );
      return { created: true, added: Array.from(wanted), dropped: [], noTables: false };
    }

    const have = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_publication_tables WHERE pubname = $1`,
      [FRIDAY_PUBLICATION],
    );
    const present = new Set(have.rows.map((r) => r.tablename));
    const toAdd = [...wanted].filter((t) => !present.has(t));
    const toDrop = [...present].filter((t) => !wanted.has(t));

    for (const t of toAdd) {
      await client.query(`ALTER PUBLICATION ${FRIDAY_PUBLICATION} ADD TABLE "${t}"`);
    }
    for (const t of toDrop) {
      await client.query(`ALTER PUBLICATION ${FRIDAY_PUBLICATION} DROP TABLE "${t}"`);
    }
    if (toAdd.length === 0 && toDrop.length === 0) {
      log(`  publication ${FRIDAY_PUBLICATION} already aligned (${wanted.size} table(s))`);
      return { created: false, added: [], dropped: [], noTables: false };
    }
    log(`  reconciled publication ${FRIDAY_PUBLICATION}: +${toAdd.length} -${toDrop.length}`);
    return { created: false, added: toAdd, dropped: toDrop, noTables: false };
  } finally {
    await client.end();
  }
}

/**
 * Thin wrapper kept for {@link provisionPostgres}. Returns the legacy
 * "publication changed this run" boolean (true on create, rebuild, or any
 * ADD/DROP) that flows into {@link ProvisionResult.createdPublication}.
 * `databaseUrl` is unused — {@link reconcileSyncPublication} derives its own
 * admin-in-friday connection.
 */
async function ensurePublication(
  _databaseUrl: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const r = await reconcileSyncPublication(log);
  return r.created || r.added.length > 0 || r.dropped.length > 0;
}

/** Ensure `wal_level = logical` (Zero needs it for logical replication).
 *  Returns true when it changed the setting this run — ALTER SYSTEM is a
 *  postmaster-level setting that requires a full Postgres restart (NOT
 *  `pg_reload_conf()`), so the caller must restart Postgres when this returns
 *  true. Returns false when it was already logical (no restart needed). */
async function ensureWalLevelLogical(log: (msg: string) => void): Promise<boolean> {
  // ALTER SYSTEM requires superuser; use the same admin connection
  // pattern as ensurePublication.
  const admin = new Client({ connectionString: adminConnectionUrl() });
  await admin.connect();
  try {
    const cur = await admin.query<{ wal_level: string }>(`SHOW wal_level`);
    const lvl = cur.rows[0]?.wal_level;
    if (lvl === "logical") {
      log(`  wal_level already logical`);
      return false;
    }
    // Persist the change so it survives the restart.
    await admin.query(`ALTER SYSTEM SET wal_level = 'logical'`);
    log(
      `  ALTER SYSTEM SET wal_level = 'logical' (was: ${lvl ?? "unknown"}) — Postgres restart required`,
    );
    return true;
  } finally {
    await admin.end();
  }
}

/* -------------------- read-only health probes -------------------- */
// Exposed for friday doctor.

export interface PgHealth {
  reachable: boolean;
  reachableReason?: string;
  roleExists: boolean;
  databaseExists: boolean;
  migrationsAtHead: boolean;
  migrationsApplied: number;
  migrationsExpected: number;
  publicationExists: boolean;
  zeroAuthSecretPresent: boolean;
  /** Zero requires Postgres `wal_level = logical` for logical replication
   *  (ADR-024). `replica` (the default) leaves Zero in a boot loop with
   *  `Postgres must be configured with "wal_level = logical"`. */
  walLevelLogical: boolean;
  walLevelActual: string | null;
}

export async function probePostgresHealth(opts?: { migrationsDir?: string }): Promise<PgHealth> {
  const result: PgHealth = {
    reachable: false,
    roleExists: false,
    databaseExists: false,
    migrationsAtHead: false,
    migrationsApplied: 0,
    migrationsExpected: 0,
    publicationExists: false,
    zeroAuthSecretPresent: !!loadFridayConfig().zeroAuthSecret,
    walLevelLogical: false,
    walLevelActual: null,
  };

  try {
    await assertPgReady(resolveFridayDbUrl());
    result.reachable = true;
  } catch (err) {
    result.reachableReason = err instanceof Error ? err.message : String(err);
    return result;
  }

  // FRI-2062: these three probes run as the APPLICATION role, not a superuser.
  //
  // They used an admin connection, which made the supervisor's boot preflight
  // the last thing requiring `FRIDAY_ADMIN_DATABASE_URL` at runtime — and
  // because the daemon spawns workers with `...process.env`, a superuser URL
  // present for the preflight is inherited by every builder, i.e. by the
  // process running untrusted repository code. On the shared cluster ADR-051
  // plans, that one credential reaches every Organization's database, which
  // defeats the container boundary FRI-2062 accepts as the isolation seam.
  //
  // No superuser is needed: `pg_roles` and `pg_database` are world-readable
  // catalogs, and `SHOW wal_level` is a server-wide setting visible to any
  // role (as the original comment here already noted). Verified against the
  // `friday` role directly. Reuses the connection proven reachable above.
  try {
    const probe = new Client({ connectionString: resolveFridayDbUrl() });
    await probe.connect();
    try {
      const role = await probe.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [FRIDAY_ROLE]);
      result.roleExists = role.rows.length > 0;
      const db = await probe.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [FRIDAY_DB]);
      result.databaseExists = db.rows.length > 0;
      const wal = await probe.query<{ wal_level: string }>(`SHOW wal_level`);
      const lvl = wal.rows[0]?.wal_level ?? null;
      result.walLevelActual = lvl;
      result.walLevelLogical = lvl === "logical";
    } finally {
      await probe.end();
    }
  } catch {
    // Probe failed; leave the role/db/wal_level booleans false.
  }

  // FRI-150 (pivot, ADR-037): process.env.DATABASE_URL is the test
  // fixture override path; production reads via loadFridayConfig().
  const databaseUrl = process.env.DATABASE_URL ?? loadFridayConfig().databaseUrl;
  if (databaseUrl && result.databaseExists) {
    try {
      const c = new Client({ connectionString: databaseUrl });
      await c.connect();
      try {
        const pub = await c.query(`SELECT 1 FROM pg_publication WHERE pubname = $1`, [
          FRIDAY_PUBLICATION,
        ]);
        result.publicationExists = pub.rows.length > 0;

        const journalPath = join(
          opts?.migrationsDir ?? defaultMigrationsDir(),
          "meta",
          "_journal.json",
        );
        if (existsSync(journalPath)) {
          const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
          result.migrationsExpected = journal.entries.length;

          const exists = await c.query<{ c: string }>(
            `SELECT COUNT(*) AS c
               FROM information_schema.tables
              WHERE table_schema = 'drizzle'
                AND table_name = '__drizzle_migrations'`,
          );
          if (Number(exists.rows[0]?.c ?? "0") > 0) {
            const applied = await c.query<{ c: string }>(
              `SELECT COUNT(*) AS c FROM drizzle.__drizzle_migrations`,
            );
            result.migrationsApplied = Number(applied.rows[0]?.c ?? "0");
            result.migrationsAtHead = result.migrationsApplied === result.migrationsExpected;
          }
        }
      } finally {
        await c.end();
      }
    } catch {
      // Connection to friday db failed — leave migration/publication false.
    }
  }

  return result;
}

/** Used by tests / tooling that wants a clean drop. NOT exposed to setup. */
export async function dropFridayDatabaseForTest(): Promise<void> {
  const admin = new Client({ connectionString: adminConnectionUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${FRIDAY_DB}`);
    await admin.query(`DROP ROLE IF EXISTS ${FRIDAY_ROLE}`);
  } finally {
    await admin.end();
  }
}

/** Read-only helpers used by friday doctor. */
export const FRIDAY_PG_CONSTANTS = {
  FRIDAY_DB,
  FRIDAY_ROLE,
  FRIDAY_PUBLICATION,
} as const;
