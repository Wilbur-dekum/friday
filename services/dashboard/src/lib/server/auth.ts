import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "@better-auth/api-key";
import { dev } from "$app/environment";
import {
  getDb,
  loadConfig,
  loadFridayConfig,
  PROD_DASHBOARD_PORT,
  resolveDashboardPort,
  schema,
} from "@friday/shared";

const fridayEnv = loadFridayConfig();
const cfg = loadConfig();

const resolvedPort = resolveDashboardPort(cfg);
// `localUrl` is the canonical localhost origin for THIS process — used
// as the BetterAuth baseURL fallback when no public URL is configured.
const localUrl = `http://localhost:${resolvedPort}`;

// trustedOrigins gates BetterAuth's CSRF check (Origin header must match).
// The list is intentionally permissive on localhost:
// - http://localhost:7615 (prod dashboard, PROD_DASHBOARD_PORT)
// - http://localhost:5173 (vite dev, the contributor wrapper)
// - http://localhost:<resolvedPort> if the user overrode `cfg.dashboardPort`
//   to something other than the two well-known values
// - cfg.publicUrl (the Cloudflare Tunnel hostname, for phone / remote access)
// - process.env.BETTER_AUTH_URL (explicit override for unusual setups)
//
// Both localhost ports are listed unconditionally so a developer can
// sign in on the dev origin (`:5173`) without the prod dashboard having
// to know about dev's port — same shape from the operator's view, no
// per-environment branching.
const DEV_DASHBOARD_LOCAL = "http://localhost:5173";
const PROD_DASHBOARD_LOCAL = `http://localhost:${PROD_DASHBOARD_PORT}`;
const trustedOrigins: string[] = [PROD_DASHBOARD_LOCAL, DEV_DASHBOARD_LOCAL];
if (resolvedPort !== PROD_DASHBOARD_PORT && localUrl !== DEV_DASHBOARD_LOCAL) {
  trustedOrigins.push(localUrl);
}
if (cfg.publicUrl) trustedOrigins.push(cfg.publicUrl);
if (process.env.BETTER_AUTH_URL) trustedOrigins.push(process.env.BETTER_AUTH_URL);
// FRI-2011: PUBLIC_BASE_URL was asserted against this list below but never
// added to it, so setting it — the obvious name to reach for when putting the
// dashboard behind a proxy — guaranteed a boot hard-exit. Either it is a
// supported way to name the public origin or it should not be asserted; it is
// listed as a source, so make it one.
if (process.env.PUBLIC_BASE_URL) trustedOrigins.push(process.env.PUBLIC_BASE_URL);

// FIX_FORWARD 5.10: assert any configured public base URL is actually in
// trustedOrigins. Defends against a future refactor that drops the
// push — a misconfigured BetterAuth would silently 403 every sign-in
// from the tunnel, which is the user-facing symptom most likely to be
// blamed on something else.
const PUBLIC_BASE_URL_SOURCES: Array<[string, string | undefined]> = [
  ["config.publicUrl", cfg.publicUrl],
  ["env.BETTER_AUTH_URL", process.env.BETTER_AUTH_URL],
  ["env.PUBLIC_BASE_URL", process.env.PUBLIC_BASE_URL],
];
for (const [source, url] of PUBLIC_BASE_URL_SOURCES) {
  if (!url) continue;
  if (!trustedOrigins.includes(url)) {
    const msg =
      `FATAL: ${source}=${url} is not present in BetterAuth trustedOrigins ` +
      `(${trustedOrigins.join(", ")}). Refusing to start.`;

    console.error(msg);
    process.exit(1);
  }
}

// baseURL is what BetterAuth uses to generate absolute URLs (cookies,
// redirects). When a tunnel is configured, prefer the public HTTPS URL —
// otherwise BetterAuth would emit `http://localhost` URLs that browsers
// reject as mixed content on the secure page.
//
// Vite dev exception: BetterAuth derives the session cookie's `Secure`
// flag and `__Secure-` name prefix from `baseURL.startsWith("https://")`
// (see `better-auth/dist/cookies/index.mjs`). If we hand it the public
// HTTPS URL while serving on http://localhost:5173, every Set-Cookie
// comes back as `__Secure-…; Secure`, which browsers silently drop on
// http origins — sign-in returns 200 but the cookie never lands. In
// dev, pin baseURL to the dev dashboard's own http origin so cookies
// are issued without the secure prefix and the localhost login flow
// works end-to-end.
const baseURL =
  process.env.BETTER_AUTH_URL ?? (dev ? DEV_DASHBOARD_LOCAL : (cfg.publicUrl ?? localUrl));

function buildAuth() {
  const db = getDb();
  return betterAuth({
    // Our schema exports keys with plural names (`users`, `sessions`,
    // `accounts`, `verifications`) while the physical pg tables use
    // BetterAuth's expected singular names. `usePlural: true` aligns the
    // adapter's lookups with our schema's exported symbol names.
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
    baseURL,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      /** Public sign-up is permanently disabled — first account is created via `friday setup`. */
      disableSignUp: true,
    },
    session: {
      // FIX_FORWARD 5.6: tighter session lifetime. 7d absolute expiry with a
      // sliding 1d refresh window — a forgotten session times out within a
      // week; an active user's cookie auto-refreshes daily so they don't
      // get logged out mid-task.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    secret: fridayEnv.betterAuthSecret,
    // FRI-171 (ADR-047): the API Key plugin issues Capture keys for the
    // stateless `POST /api/capture` endpoint (the Apple Watch / quick-add
    // path that has no session cookie). The standalone `@better-auth/api-key`
    // package backs the `apikey` Drizzle table declared in
    // `packages/shared/src/db/schema.ts` (server-only, NOT Zero-replicated).
    plugins: [
      apiKey({
        // SECURITY-CRITICAL: a Capture key authenticates a stateless POST,
        // it does NOT log anyone in. Left at the plugin default (`false`)
        // and pinned EXPLICITLY so a future edit can't silently flip it —
        // with `true`, any request bearing `x-api-key` would mint a full
        // session, turning a write-scoped device key into a login bypass.
        enableSessionForAPIKeys: false,
        // Capture keys carry the `{ capture: ["write"] }` scope, set on the
        // server-side `createApiKey` call (a server-only property in 1.6.9).
        // `verifyApiKey({ body: { permissions: { capture: ["write"] } } })`
        // in the capture route then rejects any key lacking that grant.
        permissions: {
          defaultPermissions: { capture: ["write"] },
        },
        // Header the capture route reads the raw key from (plugin default,
        // pinned for clarity since the route depends on it).
        apiKeyHeaders: "x-api-key",
      }),
    ],
  });
}

// The `@better-auth/api-key` plugin touches the DB adapter at `betterAuth()`
// construction time. Constructing at module scope would force a `getDb()` pool
// resolve during SvelteKit's build-time `analyse` pass (CI builds with no
// DATABASE_URL), failing the dashboard build. Defer construction to the first
// runtime property access so the build never touches the DB; every existing
// `auth.api` / `auth.handler` call site is unchanged. Methods are bound to the
// real instance so `this` is preserved through the proxy.
let _auth: ReturnType<typeof buildAuth> | undefined;
export const auth = new Proxy({} as ReturnType<typeof buildAuth>, {
  get(_target, prop) {
    _auth ??= buildAuth();
    const value = Reflect.get(_auth as object, prop);
    return typeof value === "function" ? value.bind(_auth) : value;
  },
});
