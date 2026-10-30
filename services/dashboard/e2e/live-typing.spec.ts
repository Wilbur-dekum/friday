/**
 * Browser-driven user-visible round-trip (item #50, plan §4 step 4e).
 *
 * This suite supersedes the originally-planned synthetic two-Zero-
 * client convergence test (which was dropped — `@rocicorp/zero`'s
 * Node client closes WS with code 1006 in the harness and the
 * repo has no precedent for a real Node Zero client). The
 * user-visible convergence path is what actually matters for
 * Friday's reliability — testing it in a real Chromium picks up
 * any browser-specific Zero / SvelteKit / hydration bug the unit +
 * server e2e suites can't see.
 *
 * Verifies:
 *
 *   1. The dashboard's auth gate accepts a pre-minted session
 *      cookie injected into the browser context (no login form
 *      round-trip needed).
 *
 *   2. The chat UI hydrates and the input is interactive.
 *
 *   3. Typing a message + clicking Send produces a user-side
 *      bubble in the chat scroller (the optimistic Zero-mutate
 *      write reflects locally) and persists to Postgres (the
 *      canonical commit lands).
 *
 *   4. The bubble text matches what was typed (no encoding /
 *      attachment-handler bug).
 *
 * Out of scope: agent streaming tokens. That requires a real
 * Claude SDK round-trip or a worker mock; the daemon-side stress
 * test already covers exactly-once dispatch from the LISTEN
 * handler. This test deliberately doesn't depend on
 * `ANTHROPIC_API_KEY`.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { newTestClient } from "@friday/shared/test/sync-harness";
import { envPath } from "./global-setup";

interface EnvSnapshot {
  dashboardURL: string;
  databaseUrl: string;
  cookie: string;
  userId: string;
  deviceId: string;
}

function loadEnv(): EnvSnapshot {
  return JSON.parse(readFileSync(envPath(), "utf8")) as EnvSnapshot;
}

/**
 * Translate the harness's `Cookie:` header string into Playwright's
 * `addCookies(...)` array shape. Splits on `; ` and rebuilds each
 * pair with the dashboard's origin so the browser scopes them
 * correctly. URL of the dashboard origin determines the
 * `secure` flag — adapter-node runs HTTP locally, so `secure: false`
 * is correct here even though prod cookies use the `__Secure-` prefix.
 */
function parseCookiesForPlaywright(
  cookieHeader: string,
  url: string,
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
}> {
  const u = new URL(url);
  return cookieHeader.split("; ").map((pair) => {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    return {
      name,
      value,
      domain: u.hostname,
      path: "/",
      httpOnly: false,
      // adapter-node in our harness binds HTTP, no TLS; secure:false
      // is the only setting that lets Playwright accept the cookie
      // on a http:// origin.
      secure: false,
      sameSite: "Lax" as const,
    };
  });
}

async function readBlocksForUser(
  databaseUrl: string,
  textFilter: string,
): Promise<
  Array<{ block_id: string; agent_name: string; status: string; content: { text?: string } }>
> {
  const c = newTestClient({ connectionString: databaseUrl });
  await c.connect();
  try {
    // `content_json` is a JSONB column — node-postgres auto-parses
    // jsonb into a JS object, so the row value is already structured.
    // No JSON.parse needed.
    const r = await c.query<{
      block_id: string;
      agent_name: string;
      status: string;
      content_json: { text?: string };
    }>(
      `SELECT block_id, agent_name, status, content_json
         FROM blocks
         WHERE role = 'user'
           AND source = 'user_chat'
           AND content_json::text LIKE $1`,
      [`%${textFilter}%`],
    );
    return r.rows.map((row) => ({
      block_id: row.block_id,
      agent_name: row.agent_name,
      status: row.status,
      content: row.content_json,
    }));
  } finally {
    await c.end();
  }
}

test.describe("user-visible round-trip (item #50 — plan §4 step 4e)", () => {
  test("auth cookie + send message → bubble renders + row lands in PG", async ({ browser }) => {
    const env = loadEnv();
    const context = await browser.newContext();
    await context.addCookies(parseCookiesForPlaywright(env.cookie, env.dashboardURL));
    const page = await context.newPage();

    // Surface browser console errors in the Playwright report so a
    // failed bundle hydration shows up as something better than a
    // vague selector timeout.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // Capture network traffic to /api/mutators — if Zero's WS push
    // never lands on the dashboard, the server-side commit doesn't
    // happen and the row never appears in PG. Logging this gives us
    // direct evidence vs. inferring from "the row didn't appear."
    const mutatorCalls: Array<{ url: string; status: number }> = [];
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/mutators") || url.includes("/api/sync")) {
        mutatorCalls.push({ url, status: res.status() });
      }
    });

    await page.goto(env.dashboardURL, { waitUntil: "domcontentloaded" });

    // If the auth gate fails, SvelteKit redirects to /login. Assert
    // we landed on the chat page instead.
    await expect(page).not.toHaveURL(/\/login/);

    // The chat input has placeholder "Message Friday… or /command".
    // Wait for hydration; without `await page.waitForLoadState`, the
    // input could be present but disabled until JS bootstraps.
    const input = page.getByPlaceholder(/Message Friday/);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(input).toBeEnabled();

    // Type a unique message + send. The send button uses
    // aria-label="Send"; getByRole("button", { name: "Send" })
    // picks it up via accessibility tree (more stable than a CSS
    // selector against the icon-btn class).
    const marker = `e2e-${Date.now()}`;
    const messageText = `Playwright round-trip ${marker}`;
    await input.fill(messageText);
    await page.getByRole("button", { name: "Send" }).click();

    // The user-side bubble should appear in the scroller within a
    // couple seconds. Match on the marker token so we don't false-
    // positive on a prior bubble. The daemon may also produce a
    // "Queued — waiting to send" bubble for its response shell —
    // pick the FIRST matching bubble (the user-typed one always
    // lands before the daemon's placeholder).
    await expect(page.locator(".bubble").filter({ hasText: marker }).first()).toBeVisible({
      timeout: 10_000,
    });

    // Canonical-write check: poll Postgres until a row with our
    // marker appears. Proves the mutator round-trip (client →
    // dashboard /api/mutators → PG) actually landed, not just the
    // optimistic in-memory write. Generous deadline because zero-
    // cache's mutator dispatch goes through CVR + bundles writes;
    // a fresh client group can take a few seconds on first send.
    // FRI-2081: wait for the mutation to be PUSHED before polling Postgres.
    //
    // The bubble above proves only the OPTIMISTIC local write. Zero holds the
    // mutation client-side until it has a live connection, and nothing before
    // this point waits for one: `toBeEnabled()` is DOM hydration, not sync
    // readiness. The CI failure this fixes had the bubble rendered, zero rows
    // in `blocks`, and exactly one recorded call — `/api/sync/refresh` — so
    // the push had never happened at all.
    //
    // Polling PG first turned that into "expected 1, received 0", which reads
    // like a broken write path and is not. Waiting here does two things: it
    // gives a slow first client group time to connect and flush (the real
    // race), and when the push genuinely never happens it fails with that
    // fact instead of blaming Postgres.
    const pushDeadline = Date.now() + 20_000;
    while (Date.now() < pushDeadline) {
      if (mutatorCalls.some((c) => c.url.includes("/api/mutators"))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(
      mutatorCalls.filter((c) => c.url.includes("/api/mutators")),
      `client never pushed the mutation — Zero likely never connected. Calls seen: ${JSON.stringify(mutatorCalls)}`,
    ).not.toHaveLength(0);

    let rows: Awaited<ReturnType<typeof readBlocksForUser>> = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      rows = await readBlocksForUser(env.databaseUrl, marker);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (rows.length === 0) {
      // Surface diagnostic info before the assertion fires so test
      // failures don't reduce to "expected 1 received 0."
      const all = await newTestClient({ connectionString: env.databaseUrl })
        .connect()
        .then(async (_v): Promise<unknown> => {
          const c = newTestClient({ connectionString: env.databaseUrl });
          await c.connect();
          try {
            const r = await c.query<{
              block_id: string;
              agent_name: string;
              role: string;
              source: string;
              status: string;
            }>(
              `SELECT block_id, agent_name, role, source, status FROM blocks ORDER BY ts DESC LIMIT 5`,
            );
            return r.rows;
          } finally {
            await c.end();
          }
        });

      console.error("[live-typing] marker not found; recent rows:", JSON.stringify(all, null, 2));

      console.error("[live-typing] marker:", marker);

      console.error("[live-typing] mutator + sync calls:", JSON.stringify(mutatorCalls, null, 2));

      console.error("[live-typing] console errors:", consoleErrors);
    }
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_name).toBe("friday");
    // Status may be 'pending' (briefly) or already flipped to
    // 'queued' / 'complete' by the daemon's LISTEN handler. Any of
    // those proves the write committed; the daemon-down suite
    // pins the LISTEN-handler convergence separately.
    expect(["pending", "queued", "complete"]).toContain(rows[0]!.status);
    expect(rows[0]!.content.text).toContain(marker);

    // JS-level errors during the round-trip (would mask real bugs).
    // Ignore HTTP resource-load failures: SSE reconnect attempts and
    // similar transient 4xx/5xx are environmental noise from the
    // mocked-out-of-band paths (we're not running a real Claude
    // turn), not application bugs. A genuine JS exception or a Zero
    // protocol error would surface as a non-"Failed to load
    // resource:" string and trip this assertion.
    const realErrors = consoleErrors.filter((e) => !e.startsWith("Failed to load resource:"));
    expect(realErrors, `Unexpected JS errors: ${realErrors.join("\n")}`).toEqual([]);

    await context.close();
  });
});
