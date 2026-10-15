/**
 * `friday restore <bundle-path> [--force]` — recover Friday state
 * from a backup tarball produced by `friday backup` (Phase 7a).
 *
 * Contract (plan §237):
 *   1. Refuses if the daemon is running (would race the migration).
 *   2. Refuses if the `friday` database has user data, unless `--force`.
 *      Detection: the `users` table has > 0 rows (BetterAuth's
 *      single-user marker; a fresh install has 0).
 *   3. Validates the bundle: tarball extracts cleanly + `manifest.json`
 *      checksum matches `postgres.dump`.
 *   4. Drops + recreates the `friday` database.
 *   5. Restores `pg_dump` output via `pg_restore`.
 *   6. Re-runs Drizzle migrations (idempotent — bundles produced after a
 *      schema bump have the new tables; older bundles get the diff
 *      applied to land at the running daemon's schema).
 *   7. Restores filesystem (copies staged dirs/files back into DATA_DIR,
 *      preserving timestamps).
 *   8. Re-runs `friday doctor` for a final readiness check.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { confirm } from "@clack/prompts";
import pc from "picocolors";
import {
  agentWorkingDir,
  DATA_DIR,
  HEALTH_PATH,
  clearFridayConfigCache,
  clearSecretsCache,
  ensureVectorExtension,
  findPgBin,
  getPool,
  loadConfig,
  loadFridayConfig,
  runMigrations,
  sessionFilePath,
  sessionSidecarDir,
  writeConfig,
} from "@friday/shared";
import { reconcileTunnel } from "../lib/cloudflared.js";

const BACKUP_PATHS = [
  ".env.local",
  "secrets",
  "SOUL.md",
  "config.json",
  "skills",
  "memory/entries",
  "evolve/proposals",
  "apps",
  "schedules",
  "uploads",
] as const;

interface ClaudeSessionEntry {
  agent: string;
  type: string;
  sessionId: string;
  /** Owning app id (ADR-021); re-derives the app-agent cwd on restore. Absent
   *  on bundles from before the app-agent-cwd fix — treated as null (the agent
   *  resolves to `~/.friday/agents/<name>`, the old behavior). */
  appId?: string | null;
  sidecar?: boolean;
}

interface BackupManifest {
  createdAt: string;
  bundleId: string;
  schemaVersion: number;
  /** `pg_dump` for tarballs from `friday backup`; `legacy_sqlite` for
   *  tarballs from `friday export-legacy-sqlite`. Older bundles
   *  (pre-Phase-7c) don't carry this field — default to `pg_dump`. */
  bundleType?: "pg_dump" | "legacy_sqlite";
  /** "full" = whole-dir migration bundle (restore the entire staged tree +
   *  place Claude SDK sessions); "selective"/absent = curated BACKUP_PATHS. */
  mode?: "selective" | "full";
  postgresDumpSha256?: string;
  fridayVersion?: string;
  /** Present on legacy_sqlite bundles only. */
  tables?: Array<{ name: string; rowCount: number; sha256: string }>;
  files: Array<{ path: string; exists: boolean }>;
  /** Captured Claude SDK sessions (full mode only). */
  claudeSessions?: ClaudeSessionEntry[];
}

/** Bundle-meta entries that live at the staged-tree root but must NOT be copied
 *  into ~/.friday during a full-tree restore. */
const FULL_RESTORE_SKIP = new Set<string>([
  "manifest.json",
  "postgres.dump",
  "claude-sessions",
  "rows", // legacy_sqlite NDJSON dir
]);

/** Columns whose runtime value must be re-stringified as JSON before
 *  the parameterized INSERT — `pg` would otherwise pass the JS object
 *  through node-postgres's text encoder which produces `[object Object]`
 *  for jsonb columns. Keyed by `<table>.<column>`. Subset of the export
 *  side's JSON_COLUMNS that survives into the new Postgres schema. */
const JSONB_COLUMNS_AT_IMPORT = new Set<string>([
  "blocks.content_json",
  "mail.meta_json",
  "memory_entries.tags_json",
  "tickets.meta_json",
  "ticket_external_links.meta_json",
  "schedules.meta_json",
  "agents.meta_json",
  "apps.manifest_json",
  "apps.meta_json",
]);

/** Timestamptz columns in the new Postgres schema. The legacy SQLite
 *  source sometimes wrote these as integer milliseconds and sometimes
 *  as ISO strings (BetterAuth tables especially are inconsistent),
 *  so at import we normalize any number to `new Date(n).toISOString()`.
 *  Keyed by `<table>.<column>` to cover both BetterAuth's camelCase
 *  schema and Drizzle's snake_case. */
const TIMESTAMP_COLUMNS_AT_IMPORT = new Set<string>([
  // BetterAuth tables (camelCase per `auth-schema.ts`).
  "user.createdAt",
  "user.updatedAt",
  // user.emailVerified is a boolean in the new Postgres schema —
  // NOT a timestamp. SQLite stored it as integer 0/1; the values
  // pass through unchanged (Postgres treats `0`/`1` as boolean OK).
  "session.expiresAt",
  "session.createdAt",
  "session.updatedAt",
  "account.accessTokenExpiresAt",
  "account.refreshTokenExpiresAt",
  "account.createdAt",
  "account.updatedAt",
  "verification.expiresAt",
  "verification.createdAt",
  "verification.updatedAt",
  // Friday tables (snake_case per Drizzle).
  "agents.created_at",
  "agents.updated_at",
  "tickets.created_at",
  "tickets.updated_at",
  "ticket_comments.ts",
  "ticket_external_links.linked_at",
  "blocks.ts",
  "mail.ts",
  "mail.read_at",
  "mail.closed_at",
  "memory_entries.created_at",
  "memory_entries.updated_at",
  "memory_entries.file_mtime",
  "memory_entries.last_recalled_at",
  "schedules.next_run_at",
  "schedules.last_run_at",
  "schedules.created_at",
  "schedules.updated_at",
  "apps.installed_at",
  "apps.upgraded_at",
  "attachments.uploaded_at",
]);

/** Tables we INSERT into during a legacy_sqlite import, in FK-aware
 *  order (parents before children). Matches the export side. */
const LEGACY_TABLES_IN_ORDER = [
  "user",
  "account",
  "session",
  "verification",
  "agents",
  "tickets",
  "ticket_comments",
  "ticket_relations",
  "ticket_external_links",
  "blocks",
  "mail",
  "memory_entries",
  "schedules",
  "apps",
  "attachments",
  "usage",
  "db_meta",
] as const;

export const restoreCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore Friday state from a backup tarball.",
  },
  args: {
    bundle: {
      type: "positional",
      description: "Path to a .tar.gz backup bundle (from `friday backup`).",
      required: true,
    },
    force: {
      type: "boolean",
      description:
        "Overwrite a non-empty friday database without prompting. Required when the existing database has user data.",
      default: false,
    },
  },
  async run({ args }) {
    const bundlePath = String(args.bundle);
    if (!existsSync(bundlePath)) {
      console.error(pc.red(`✗ bundle not found: ${bundlePath}`));
      process.exit(1);
    }

    console.log(pc.bold(`Friday restore ← ${bundlePath}`));

    // 1. Refuse if the daemon or zero-cache is running. Both hold
    //    connections to the friday database / replication slot.
    if (daemonAppearsRunning()) {
      console.error(pc.red("✗ daemon appears to be running. Stop it first: `friday stop daemon`."));
      process.exit(1);
    }
    if (zeroCacheAppearsRunning()) {
      console.error(
        pc.red(
          "✗ zero-cache is running and holds the friday replication slot. Stop it first: `friday stop zero-cache`.",
        ),
      );
      process.exit(1);
    }

    // Stage extracted bundle in a tempdir so we can validate before
    // touching the live database or filesystem.
    const stageDir = await mkdtemp(join(tmpdir(), "friday-restore-"));
    try {
      const tar = spawnSync("tar", ["-xzf", bundlePath, "-C", stageDir], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (tar.status !== 0) {
        throw new Error(`tar extraction failed with status ${tar.status}.`);
      }

      // 2. Validate the bundle. Manifest must exist; schema version >1
      //    means a newer Friday — refuse. Bundle-type-specific
      //    validation (postgres.dump checksum / NDJSON SHA-256) runs
      //    in the dispatched handler below.
      const manifestPath = join(stageDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error("Bundle is missing manifest.json — not a Friday backup tarball.");
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
      if (manifest.schemaVersion !== 1) {
        throw new Error(
          `Bundle schema version ${manifest.schemaVersion} is not supported by this CLI (expected 1).`,
        );
      }
      const bundleType = manifest.bundleType ?? "pg_dump";
      console.log(
        pc.dim(
          `  bundle ${manifest.bundleId} · type=${bundleType} · created ${manifest.createdAt}`,
        ),
      );

      // 3. Refuse if the destination database has user data unless --force.
      const hasUserData = checkDatabaseHasUsers();
      if (hasUserData && !args.force) {
        const ok = await confirm({
          message:
            "Existing friday database has user data. Overwrite? (Re-run with --force to skip this prompt.)",
          initialValue: false,
        });
        if (typeof ok !== "boolean" || !ok) {
          console.log(pc.yellow("Aborted."));
          process.exit(1);
        }
      }

      // 4. Drop + recreate the friday database. Zero-cache holds a
      //    logical-replication slot; drop it first (terminating any
      //    still-active backend) so DROP DATABASE doesn't fail.
      console.log(pc.dim("  dropping zero-cache replication slots (if any)…"));
      runPsqlAdmin([
        "-c",
        `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE database = 'friday' AND active_pid IS NOT NULL;`,
        "-c",
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = 'friday';`,
      ]);
      console.log(pc.dim("  dropping + recreating friday database…"));
      runPsqlAdmin([
        "-c",
        "DROP DATABASE IF EXISTS friday;",
        "-c",
        "CREATE DATABASE friday OWNER friday;",
      ]);

      // FRI-24: DROP DATABASE destroyed the database-scoped pgvector `vector`
      // extension. Recreate it via an admin/superuser connection (the friday
      // role lacks superuser) BEFORE pg_restore / runMigrations apply migration
      // 0036 (`embedding vector(384)`) — otherwise every restore path throws
      // `type "vector" does not exist`. Mirrors provisionPostgres / friday update.
      console.log(pc.dim("  creating pgvector extension…"));
      await ensureVectorExtension((m) => console.log(pc.dim(`  ${m}`)));

      // 5. Restore filesystem FIRST — so the bundle's `.env.local` is on disk
      //    before we read DATABASE_URL. For a cross-machine restore the bundle
      //    carries the SOURCE's friday password; we adopt it (and sync the role
      //    to it below) so the daemon can connect afterward.
      const full = manifest.mode === "full";
      console.log(pc.dim(`  restoring filesystem${full ? " (full tree)" : ""}…`));
      mkdirSync(DATA_DIR, { recursive: true });
      if (full) {
        // Restore the entire staged tree (incl. .git, agents/, .env.local),
        // skipping bundle-meta. Replace each target to avoid merged state.
        for (const entry of readdirSync(stageDir)) {
          if (FULL_RESTORE_SKIP.has(entry)) continue;
          const src = join(stageDir, entry);
          const dest = join(DATA_DIR, entry);
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
          mkdirSync(dirname(dest), { recursive: true });
          await cp(src, dest, { recursive: true, preserveTimestamps: true });
        }
        const ageKey = join(DATA_DIR, ".age-key");
        if (existsSync(ageKey)) chmodSync(ageKey, 0o600);
      } else {
        for (const rel of BACKUP_PATHS) {
          const src = join(stageDir, rel);
          if (!existsSync(src)) continue;
          const dest = join(DATA_DIR, rel);
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
          mkdirSync(dirname(dest), { recursive: true });
          await cp(src, dest, { recursive: true, preserveTimestamps: true });
        }
      }

      // FRI-150 (pivot, ADR-037): the restored .env is now on disk — invalidate
      // the cache so loadFridayConfig() reads the BUNDLE's DATABASE_URL.
      clearSecretsCache();
      clearFridayConfigCache();
      // FRI-2013: an explicitly-configured DATABASE_URL outranks the bundle's.
      //
      // The bundle carries the SOURCE machine's `.env`, so its DATABASE_URL
      // names that machine's database — `localhost:5432` for a laptop. Restore
      // into a Deployment and that is simply wrong: the database is a sibling
      // service, reached through the environment, and there is no `.env.local`
      // to correct it afterwards. Taking the bundle's value would point the
      // Deployment at a database that does not exist, or at the operator's own.
      //
      // Same precedence `getDbAndPool()` already uses, so a restore targets the
      // database the Deployment will actually boot against.
      const dbUrl = process.env.DATABASE_URL ?? loadFridayConfig().databaseUrl;
      if (process.env.DATABASE_URL) {
        console.log(pc.dim(`  using DATABASE_URL from the environment (not the bundle's)`));
      }
      if (!dbUrl) {
        throw new Error(
          "DATABASE_URL missing from the restored ~/.friday/.env. The bundle carried none — run `friday setup` to provision Postgres, then re-restore.",
        );
      }

      // Sync the local `friday` role's password to the restored DATABASE_URL.
      // Cross-machine: the target's role was minted with a DIFFERENT password by
      // its own `friday setup`; without this, pg_restore (and then the daemon)
      // auth as friday:<bundle-pw> against a role holding <target-pw> and fail
      // unless pg_hba happens to be `trust`. Idempotent.
      syncFridayRolePassword(dbUrl);

      // 5b. Split-brain guard (FRI-166). The restored config.json carries the
      //     SOURCE machine's tunnel state — including `tunnel.serve: true` and
      //     its live connector token (back in this machine's vault via
      //     --include-age-key). If `friday start` honored that, the staged box
      //     would race the source machine on the SAME public hostname — the
      //     split-brain we cut over deliberately to avoid. So force serve-intent
      //     OFF here and actively reconcile the agent dark, regardless of what
      //     the bundle said. Cutover relights it with one explicit flip
      //     (`friday tunnel up`) AFTER the source machine's tunnel is stopped.
      const restored = loadConfig();
      const sourceServed = restored.tunnel?.serve === true;
      if (sourceServed) {
        restored.tunnel = { ...restored.tunnel, serve: false };
        writeConfig(restored);
      }
      // Ensure no cloudflared agent is left serving on this box (defensive: the
      // target may have served previously). serve:false → tear down if loaded.
      reconcileTunnel({ serve: false, token: undefined });
      if (sourceServed) {
        console.log(
          pc.yellow("  ⚠ tunnel serve-intent disabled on this machine (split-brain guard)."),
        );
        console.log(
          pc.dim(
            `    the bundle's tunnel token is restored but kept DARK. To serve ${
              restored.publicUrl ?? "the public URL"
            } from here, stop the tunnel on the source machine, then run ${pc.cyan(
              "friday tunnel up",
            )}.`,
          ),
        );
      }

      // 6. Bundle-type-specific data restore.
      if (bundleType === "pg_dump") {
        await restorePgDumpBundle(stageDir, manifest, dbUrl);
      } else if (bundleType === "legacy_sqlite") {
        await restoreLegacySqliteBundle(stageDir, manifest);
      } else {
        throw new Error(
          `Unsupported bundle type: ${String(bundleType)}. Expected pg_dump or legacy_sqlite.`,
        );
      }

      // 7. Re-apply pending migrations on the pg_dump path (schema is
      //    captured in the dump but newer migrations may need to land).
      //    Legacy SQLite import already ran migrations to create the
      //    schema before INSERTing rows, so skip here.
      if (bundleType === "pg_dump") {
        console.log(pc.dim("  re-running drizzle migrations…"));
        await runMigrations();
      }

      // 7b. Place captured Claude SDK session transcripts (full bundle only) so
      //     each agent's NEXT turn resumes its conversation instead of starting a
      //     cold session. The target path is RE-DERIVED from this machine's cwd.
      if (full) {
        await placeClaudeSessions(stageDir, manifest);
      }

      // 8. Final readiness check. Spawn `friday doctor` so the user
      //    sees the same exit status they'd get on a fresh install.
      console.log(pc.dim("  friday doctor…"));
      const doctor = spawnSync(process.argv[0]!, [process.argv[1]!, "doctor"], {
        stdio: "inherit",
      });
      const doctorStatus = doctor.status ?? 1;

      console.log();
      console.log(
        doctorStatus === 0
          ? pc.green("✓ restore complete")
          : pc.yellow(
              `✓ restore complete · friday doctor exited ${doctorStatus} (investigate before starting the daemon)`,
            ),
      );
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

function daemonAppearsRunning(): boolean {
  // The right signal is "is there a process answering on the daemon
  // port" — health.json's mtime stays fresh even after `friday stop`
  // (the file isn't cleaned up on shutdown). Probe the port directly.
  if (!existsSync(HEALTH_PATH)) return false;
  let health: { port?: unknown; pid?: unknown };
  try {
    health = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as {
      port?: unknown;
      pid?: unknown;
    };
  } catch {
    return false;
  }
  const port = typeof health?.port === "number" ? (health.port as number) : null;
  if (port === null) return false;
  // lsof tells us whether the port is being LISTENed on right now.
  const probe = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

/**
 * Pg_dump bundle handler: validates the dump SHA-256 against the
 * manifest, then pg_restore as the `friday` role so all restored
 * objects end up with the right owner.
 */
async function restorePgDumpBundle(
  stageDir: string,
  manifest: BackupManifest,
  dbUrl: string,
): Promise<void> {
  const dumpPath = join(stageDir, "postgres.dump");
  if (!existsSync(dumpPath)) {
    throw new Error("pg_dump bundle is missing postgres.dump.");
  }
  if (!manifest.postgresDumpSha256) {
    throw new Error("pg_dump bundle manifest is missing postgresDumpSha256.");
  }
  const dumpSha = sha256File(dumpPath);
  if (dumpSha !== manifest.postgresDumpSha256) {
    throw new Error(
      `postgres.dump checksum mismatch: bundle has ${manifest.postgresDumpSha256}, computed ${dumpSha}. Bundle is corrupt.`,
    );
  }
  console.log(pc.dim("  pg_restore…"));
  const pgRestore = spawnSync(
    findPgBin("pg_restore"),
    ["--no-owner", "--no-privileges", "-d", dbUrl, dumpPath],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (pgRestore.status !== 0) {
    throw new Error(`pg_restore exited with status ${pgRestore.status}.`);
  }
}

/**
 * Legacy SQLite bundle handler (Phase 7d). Sequence:
 *   1. runMigrations() creates the schema in the empty database.
 *   2. For each NDJSON file in dependency order:
 *        - Verify SHA-256 against the manifest.
 *        - Parse rows, re-stringify JSONB columns, build parameterized
 *          INSERTs, send them in batches over a single pg connection.
 *   3. Skip schedule_runs / read_cursors / client_devices / settings —
 *      none of these exist in the legacy SQLite schema; they're
 *      populated organically by the running daemon and dashboard.
 *
 * Idempotency: this handler runs after DROP+CREATE database, so the
 * table is empty when we start; INSERTs can't collide. If a row has
 * a column the new schema doesn't recognize, the INSERT fails loudly
 * (preferred over silently dropping data).
 */
async function restoreLegacySqliteBundle(
  stageDir: string,
  manifest: BackupManifest,
): Promise<void> {
  // First create the schema in the empty `friday` database. The
  // legacy bundle has no DDL — just data — so we need migrations to
  // run before any INSERTs.
  console.log(pc.dim("  running drizzle migrations to create schema…"));
  await runMigrations();

  const rowsDir = join(stageDir, "rows");
  if (!existsSync(rowsDir)) {
    throw new Error("legacy_sqlite bundle is missing rows/ directory.");
  }
  const tableMeta = new Map<string, { rowCount: number; sha256: string }>();
  for (const t of manifest.tables ?? []) {
    tableMeta.set(t.name, { rowCount: t.rowCount, sha256: t.sha256 });
  }

  const pool = getPool();
  const client = (await pool.connect()) as unknown as DbClient;
  try {
    for (const table of LEGACY_TABLES_IN_ORDER) {
      const filePath = join(rowsDir, `${table}.ndjson`);
      if (!existsSync(filePath)) {
        // Bundles from older Friday versions may not have every table
        // we care about. Skip silently.
        continue;
      }
      const buf = readFileSync(filePath, "utf8");
      const meta = tableMeta.get(table);
      if (meta) {
        const sha = createHash("sha256").update(buf.replace(/\n$/, "")).digest("hex");
        if (sha !== meta.sha256) {
          throw new Error(
            `legacy NDJSON SHA-256 mismatch for ${table}: bundle ${meta.sha256}, computed ${sha}. Bundle is corrupt.`,
          );
        }
      }
      const rows = buf
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      if (rows.length === 0) {
        console.log(pc.dim(`  ${table.padEnd(24)} empty`));
        continue;
      }
      await importTable(client, table, rows);
      console.log(pc.dim(`  ${table.padEnd(24)} ${String(rows.length).padStart(6)} rows`));
    }
    // Legacy bundles INSERT raw row values, which never touches the
    // bigserial sequences — they stay at 1 even after restoring rows
    // with `id=150`. The very next post-restore INSERT then hits a
    // duplicate-key violation. (pg_dump bundles emit explicit `setval`
    // calls, so they don't have this problem.) Catch up every sequence
    // attached to an `id` column in the public schema to MAX(id).
    await syncBigserialSequences(client);
  } finally {
    client.release();
  }
}

/**
 * Advance every `<table>_id_seq` sequence in the public schema to the
 * current MAX(id) of its owning table. Called after the legacy_sqlite
 * INSERT loop so post-restore inserts don't collide with restored IDs.
 *
 * Discovers sequences via the catalog (rather than a hard-coded list)
 * so adding a new bigserial column to the schema doesn't silently
 * leave that sequence un-synced after a restore.
 */
export async function syncBigserialSequences(client: DbClient): Promise<void> {
  const seqRows = await client.query(
    `SELECT s.relname AS seq_name,
            t.relname AS table_name,
            a.attname AS column_name
       FROM pg_class s
       JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       JOIN pg_namespace n ON n.oid = s.relnamespace
      WHERE s.relkind = 'S'
        AND n.nspname = 'public'`,
  );
  // node-pg returns `{ rows: ... }` on SELECT; the structural DbClient
  // type only declared `rowCount`. Re-narrow locally.
  const rows = (
    seqRows as unknown as {
      rows: Array<{ seq_name: string; table_name: string; column_name: string }>;
    }
  ).rows;
  let synced = 0;
  for (const r of rows) {
    // pg_get_serial_sequence's argument quoting is fiddly; use setval
    // directly with computed MAX. is_called=true when MAX>0 (next call
    // returns MAX+1); is_called=false when the table is empty (next
    // call returns 1, leaves sequence at 1).
    await client.query(
      `SELECT setval(
        '"${r.seq_name}"'::regclass,
        COALESCE((SELECT MAX("${r.column_name}") FROM "${r.table_name}"), 0) + 1,
        false
      )`,
    );
    synced += 1;
  }
  if (synced > 0) {
    console.log(pc.dim(`  synced ${synced} bigserial sequence(s)`));
  }
}

/**
 * Generic per-table importer. Uses the first row's keys as the column
 * list (NDJSON rows from `friday export-legacy-sqlite` all share the
 * same shape per table), builds a parameterized INSERT, and batches
 * via multi-row VALUES for throughput. JSONB columns get re-stringified
 * because node-postgres's text encoder produces `[object Object]` for
 * object values destined for `jsonb`.
 */
/** Structural type for `pg.PoolClient` — only the `query` and `release`
 *  methods we use. Sidesteps the missing `pg` types in @friday/cli's
 *  dep graph (the runtime client object is `pg.PoolClient` from
 *  @friday/shared's pool). */
interface DbClient {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
  release(): void;
}

async function importTable(
  client: DbClient,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  if (cols.length === 0) return;
  // Quote every column name to handle reserved words ("user" → "user").
  const colList = cols.map((c) => `"${c}"`).join(", ");
  // Batch rows so we don't hit the 65k-parameter Postgres limit.
  const PARAMS_PER_ROW = cols.length;
  const MAX_PARAMS = 60_000;
  const BATCH = Math.max(1, Math.floor(MAX_PARAMS / PARAMS_PER_ROW));
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const row of chunk) {
      const rowPlaceholders: string[] = [];
      for (const col of cols) {
        const key = `${table}.${col}`;
        let v = row[col];
        if (JSONB_COLUMNS_AT_IMPORT.has(key) && v !== null && v !== undefined) {
          v = JSON.stringify(v);
        }
        if (TIMESTAMP_COLUMNS_AT_IMPORT.has(key) && typeof v === "number" && Number.isFinite(v)) {
          v = new Date(v).toISOString();
        }
        values.push(v);
        rowPlaceholders.push(`$${values.length}`);
      }
      placeholders.push(`(${rowPlaceholders.join(", ")})`);
    }
    // Quote table name so reserved words like "user" work. The legacy
    // schema may not have every column the new Postgres schema does
    // (NEW columns get NULL/default from the table definition); we
    // INSERT only the columns the bundle has.
    const sql = `INSERT INTO "${table}" (${colList}) VALUES ${placeholders.join(", ")} ON CONFLICT DO NOTHING`;
    try {
      await client.query(sql, values);
    } catch (err) {
      throw new Error(
        `INSERT into ${table} failed at batch starting row ${i}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

function zeroCacheAppearsRunning(): boolean {
  // zero-cache binds 127.0.0.1:4848 (configurable via ZERO_PORT but the
  // default ships unchanged in our deployment). lsof tells us whether
  // anything is LISTENing there.
  const port = process.env.ZERO_PORT ? Number(process.env.ZERO_PORT) : 4848;
  if (!Number.isFinite(port)) return false;
  const probe = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function checkDatabaseHasUsers(): boolean {
  // Probe via `psql -At` for an exit-quiet integer. `friday` may not
  // exist yet (first-time restore), which we treat as "no user data."
  const res = spawnSync("psql", ["-At", "-d", "friday", "-c", 'SELECT count(*) FROM "user";'], {
    encoding: "utf8",
  });
  if (res.status !== 0) return false;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) && n > 0;
}

function runPsqlAdmin(extraArgs: string[]): void {
  // Connect to the default `postgres` database so we can DROP friday
  // while no one else is connected. Local Postgres trust auth means we
  // don't need credentials here.
  const res = spawnSync(findPgBin("psql"), ["-d", "postgres", ...extraArgs], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) {
    throw new Error(
      `psql admin command failed with status ${res.status}. Manual cleanup may be required.`,
    );
  }
}

/** ALTER the local `friday` role's password to match a DATABASE_URL, so a
 *  cross-machine restore's pg_restore + the daemon can auth against it. No-op
 *  when the URL carries no password (socket/trust auth). Idempotent. */
function syncFridayRolePassword(dbUrl: string): void {
  let rawPw: string;
  try {
    rawPw = new URL(dbUrl).password;
  } catch {
    return;
  }
  if (!rawPw) return;
  const escaped = decodeURIComponent(rawPw).replace(/'/g, "''");
  runPsqlAdmin(["-c", `ALTER ROLE friday WITH LOGIN REPLICATION PASSWORD '${escaped}'`]);
  console.log(pc.dim("  synced friday role password to the restored .env.local"));
}

/** Place captured Claude SDK sessions back under `~/.claude/projects`,
 *  RE-DERIVING the project-dir hash from THIS machine's agent cwd (not the
 *  source's) so resume finds them even if `$HOME`/user differs. Builders are
 *  skipped — their worktree cwd isn't migrated. */
async function placeClaudeSessions(stageDir: string, manifest: BackupManifest): Promise<void> {
  let placed = 0;
  for (const s of manifest.claudeSessions ?? []) {
    if (s.type === "builder") continue;
    const srcDir = join(stageDir, "claude-sessions", s.agent);
    const srcJsonl = join(srcDir, `${s.sessionId}.jsonl`);
    if (!existsSync(srcJsonl)) continue;
    // RE-DERIVE the cwd from THIS machine's agent layout — app agents live at
    // `~/.friday/apps/<appId>`, everyone else at `~/.friday/agents/<name>`. Must
    // match what `friday backup` captured under, or resume can't find it.
    const cwd = agentWorkingDir({ name: s.agent, appId: s.appId });
    const destJsonl = sessionFilePath(cwd, s.sessionId);
    mkdirSync(dirname(destJsonl), { recursive: true });
    await cp(srcJsonl, destJsonl, { preserveTimestamps: true });
    const srcSidecar = join(srcDir, s.sessionId);
    if (s.sidecar && existsSync(srcSidecar)) {
      await cp(srcSidecar, sessionSidecarDir(cwd, s.sessionId), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    placed++;
  }
  if (placed > 0) console.log(pc.dim(`  placed ${placed} claude session(s)`));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// FRI-150 (pivot, ADR-037): `sourceEnvFromFile` retired — the restore
// path now invalidates the loadFridayConfig cache via
// `clearFridayConfigCache()` and re-reads via `loadFridayConfig()`.
// Callers no longer rely on process.env for restored secrets.
