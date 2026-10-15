/**
 * Dev-only account seed for the compose stack (FRI-2004).
 *
 *   docker compose exec friday node packages/cli/scripts/dev-seed.mjs
 *
 * `friday setup` is the real path for creating the first account, but it is an
 * interactive clack wizard — no use inside a container. This does the same
 * thing non-interactively so a local Deployment is actually loggable-into.
 *
 * It creates the account exactly the way setup does: a TEMPORARY BetterAuth
 * instance with `disableSignUp: false`, then `auth.api.signUpEmail`. Going
 * through BetterAuth rather than inserting rows is the whole point — the
 * password hashing format has to match what the dashboard's instance verifies
 * against, and that is not something to reimplement in SQL.
 *
 * Deliberately NOT wired into container startup. An image that seeds a known
 * account on boot is a backdoor the moment it escapes a laptop; this requires
 * someone to run it, with FRIDAY_DEV_SEED=1 set, on purpose.
 *
 * NOTE: there is no Organization to seed yet. ADR-051 makes it a stored
 * singleton created by setup alongside the first User, but that entity does not
 * exist — see FRI-2016. When it lands, this script should create both so local
 * dev matches the real shape.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, loadFridayConfig, schema } from "@friday/shared";

if (process.env.FRIDAY_DEV_SEED !== "1") {
  console.error(
    "refusing to seed: set FRIDAY_DEV_SEED=1 to confirm this is a development database.\n" +
      "  docker compose exec -e FRIDAY_DEV_SEED=1 friday node packages/cli/scripts/dev-seed.mjs",
  );
  process.exit(1);
}

// `.test` is reserved for testing by RFC 2606, and unlike `dev@localhost`
// it passes BetterAuth's email validation, which requires a TLD.
const email = process.env.FRIDAY_SEED_EMAIL ?? "dev@friday.test";
const name = process.env.FRIDAY_SEED_NAME ?? "Dev";
const password = process.env.FRIDAY_SEED_PASSWORD ?? "friday-dev-password";

if (password.length < 8) {
  console.error("refusing to seed: FRIDAY_SEED_PASSWORD must be at least 8 characters");
  process.exit(1);
}

const db = getDb();

// Idempotent: re-running must not fail or mint a second account. Sign-up is
// permanently disabled on the dashboard's instance, so the first row is the
// only one that matters (`resolveSoleUserId()` picks the earliest-created).
const existing = await db.select().from(schema.users).limit(1);
if (existing.length > 0) {
  console.log(`account already exists: ${existing[0].email} — nothing to do`);
  process.exit(0);
}

const auth = betterAuth({
  // The schema exports plural symbols (`users`, `sessions`, …) while the
  // physical tables are singular — same `usePlural` the dashboard and setup use.
  database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:7615",
  emailAndPassword: { enabled: true, disableSignUp: false },
  secret: loadFridayConfig().betterAuthSecret,
});

try {
  await auth.api.signUpEmail({ body: { email, password, name } });
  console.log(`created account: ${email}`);
  console.log(`password: ${password}`);
} catch (err) {
  console.error(`signup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

process.exit(0);
