-- Hand every restored object to the Deployment's `friday` role.
--
-- Run this after `pg_restore` during a cutover (docs/running.md §
-- "Migrating the database into a Deployment"). Without it the daemon
-- crash-loops on boot:
--
--   daemon.fatal  permission denied for schema drizzle
--   PostgresError permission denied for schema zero
--
-- Why it is needed. The restore has to connect as a SUPERUSER, because
-- the dump recreates the `vector` extension and `CREATE EXTENSION` is
-- not a privilege the `friday` role holds (ADR-044). But `--no-owner`
-- means "owned by the CONNECTING role" — so every schema, table and
-- sequence lands owned by `postgres`, and the daemon connects as
-- `friday`. The stack comes up, Postgres is healthy, and the daemon
-- cannot read its own migration table.
--
-- Why not `REASSIGN OWNED BY postgres TO friday`: postgres is a
-- bootstrap superuser and the server refuses outright —
-- `cannot reassign ownership of objects owned by role postgres
-- because they are required by the database system`.
--
-- Extension members are skipped (`pg_depend.deptype = 'e'`) for the
-- same class of reason: ALTER ... OWNER on an object that an extension
-- owns is refused. They stay owned by postgres, which is correct —
-- pgvector's types and functions are not application state.
--
-- Idempotent: objects already owned by `friday` are not touched, so a
-- second run is a no-op.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND nspname NOT LIKE 'pg_temp%'
      AND nspname NOT LIKE 'pg_toast_temp%'
      AND pg_get_userbyid(nspowner) <> 'friday'
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO friday', r.nspname);
  END LOOP;

  FOR r IN
    SELECT c.oid, c.relkind, n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND n.nspname NOT LIKE 'pg_toast_temp%'
      -- r/p tables, S sequences, v views, m matviews, f foreign tables.
      -- Indexes and TOAST tables follow their parent's owner.
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND pg_get_userbyid(c.relowner) <> 'friday'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO friday',
      CASE r.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      r.nspname, r.relname);
  END LOOP;
END
$$;

-- Verification: this must return zero rows.
SELECT n.nspname || '.' || c.relname AS still_not_friday,
       pg_get_userbyid(c.relowner) AS owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
   AND pg_get_userbyid(c.relowner) <> 'friday'
   AND NOT EXISTS (
     SELECT 1 FROM pg_depend d
     WHERE d.classid = 'pg_class'::regclass
       AND d.objid = c.oid
       AND d.deptype = 'e'
   );
