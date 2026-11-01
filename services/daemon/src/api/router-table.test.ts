import { describe, it, expect } from "vitest";
import { ROUTES } from "./server.js";
import type { RouteRow } from "./router.js";

/**
 * Route-table CONTRACT test (handoff Test Strategy §5). The cascade→table
 * migration's highest-leverage safety net: it asserts, against the REAL 84-row
 * table, the invariants a per-route integration test can't see —
 *   1. every row has a unique (method, match) key (no accidental shadow/dupe),
 *   2. the table covers EXACTLY the golden (method, match) set the original
 *      cascade served — no route silently dropped or added,
 *   3. ordering-sensitive specific routes precede the broad regexes that would
 *      otherwise swallow them,
 *   4. the auth-gated set is exactly the 22 routes the cascade gated inline
 *      (a security-regression guard), and
 *   5. the streaming/binary/seam routes are exactly the 6 `raw` rows.
 *
 * A new route is expected to update GOLDEN/GOLDEN_AUTH here — that friction is
 * the point: it forces every routing change to be intentional and reviewed.
 */

/** Stable string key for a row's matcher (string ↔ itself; regex ↔ source;
 *  predicate ↔ a sentinel — there is exactly one predicate route). */
function matchKey(row: RouteRow): string {
  const m = row.match;
  if (typeof m === "string") return m;
  if (m instanceof RegExp) return `re:${m.source}`;
  return "fn:predicate";
}

function rowKey(row: RouteRow): string {
  return `${row.method} ${matchKey(row)}`;
}

// The golden (method, match) set the original cascade served — hand-listed
// independently of the table so a drop/add/rename in ROUTES fails loudly.
const GOLDEN: string[] = [
  "POST re:^\\/api\\/mcp\\/[a-z0-9-]+$",
  "GET /api/health",
  "POST /api/secrets/reload",
  "POST /api/secrets/audit",
  "GET /api/commands",
  "POST /api/commands/dispatch",
  "GET /api/events",
  // FRI-2078: GitHub on Friday's own credential. The repo and head branch
  // come from the caller's registry row, so neither is a path parameter —
  // and there is deliberately NO merge route, which is how "halt at a green
  // PR, never merge" stops being a prompt rule.
  "POST /api/github/pr",
  "GET /api/github/pr-checks",
  // FRI-2076/FRI-2077: the Builder's repo, served to its container. The
  // repository is NOT a path parameter — it is resolved from the per-worker
  // token — so these are three fixed verbs, not a prefix match. The fetch
  // verbs are served from the repo the Builder was cut from; `git-receive-pack`
  // from its per-task staging repo, which nothing prunes.
  "GET /api/worker/git/info/refs",
  "POST /api/worker/git/git-upload-pack",
  "POST /api/worker/git/git-receive-pack",
  // FRI-2084: brokered model access. The builder holds no Anthropic
  // credential; the daemon injects it, so this is how a containerised Builder
  // takes a turn at all.
  "POST re:^\\/api\\/model\\/.+$",
  "GET re:^\\/api\\/model\\/.+$",
  "POST /api/elicitation/wait",
  "POST fn:predicate",
  "POST /api/internal/cancel-queued",
  "POST /api/internal/abort-turn",
  "GET /api/agents",
  "GET re:^\\/api\\/agents\\/[^/]+\\/sessions$",
  "POST /api/agents",
  "GET re:^\\/api\\/agents\\/[^/]+$",
  "POST re:^\\/api\\/agents\\/[^/]+\\/archive$",
  "POST re:^\\/api\\/agents\\/[^/]+\\/unarchive$",
  "POST re:^\\/api\\/agents\\/[^/]+\\/abort$",
  "GET re:^\\/api\\/agents\\/[^/]+\\/blocks$",
  "GET /api/tickets",
  "POST /api/tickets",
  "GET re:^\\/api\\/tickets\\/[^/]+$",
  "PATCH re:^\\/api\\/tickets\\/[^/]+$",
  "POST re:^\\/api\\/tickets\\/[^/]+\\/comments$",
  "POST re:^\\/api\\/tickets\\/[^/]+\\/links$",
  "DELETE re:^\\/api\\/tickets\\/[^/]+\\/links$",
  "GET /api/schedules",
  "POST /api/schedules",
  "POST re:^\\/api\\/schedules\\/[^/]+\\/trigger$",
  "POST re:^\\/api\\/schedules\\/[^/]+\\/(pause|resume)$",
  "POST re:^\\/api\\/schedules\\/[^/]+\\/snooze$",
  "GET re:^\\/api\\/schedules\\/[^/]+$",
  "GET re:^\\/api\\/schedules\\/[^/]+\\/state$",
  "DELETE re:^\\/api\\/schedules\\/[^/]+$",
  "POST /api/habits",
  "GET /api/habits",
  "DELETE re:^\\/api\\/habits\\/checkin\\/[^/]+$",
  "POST re:^\\/api\\/habits\\/[^/]+\\/checkin$",
  "POST re:^\\/api\\/habits\\/[^/]+\\/archive$",
  "GET re:^\\/api\\/habits\\/[^/]+$",
  "PATCH re:^\\/api\\/habits\\/[^/]+$",
  "GET /api/memory",
  "GET /api/memory/search",
  "POST /api/memory",
  "GET re:^\\/api\\/memory\\/[^/]+$",
  "PATCH re:^\\/api\\/memory\\/[^/]+$",
  "DELETE re:^\\/api\\/memory\\/[^/]+$",
  "GET /api/evolve/proposals",
  "POST /api/evolve/proposals",
  "GET re:^\\/api\\/evolve\\/proposals\\/[^/]+$",
  "PATCH re:^\\/api\\/evolve\\/proposals\\/[^/]+$",
  "DELETE re:^\\/api\\/evolve\\/proposals\\/[^/]+$",
  "POST re:^\\/api\\/evolve\\/proposals\\/[^/]+\\/apply$",
  "POST re:^\\/api\\/evolve\\/proposals\\/[^/]+\\/dismiss$",
  "POST /api/evolve/scan",
  "POST /api/evolve/enrich",
  "POST /api/evolve/cluster",
  "POST /api/integrations/linear/import",
  "POST /api/integrations/linear/create-issue",
  "POST /api/integrations/linear/update-issue",
  "POST /api/integrations/linear/reconcile",
  "POST /api/intake",
  "POST /api/intake/approve",
  "POST /api/intake/undo",
  "POST /api/intake/triage",
  "GET /api/intake/inbox",
  "POST /api/intake/act",
  "GET /api/push/vapid-public-key",
  "POST /api/push/subscribe",
  "POST /api/push/forget-device",
  "POST /api/presence",
  "POST /api/notify/test",
  "GET re:^\\/api\\/mail\\/inbox\\/[^/]+$",
  "POST /api/mail/send",
  "POST re:^\\/api\\/mail\\/\\d+\\/read$",
  "POST re:^\\/api\\/mail\\/\\d+\\/close$",
  "GET /api/mail/search",
  "POST /api/uploads",
  "GET re:^\\/api\\/uploads\\/[a-f0-9]{64}$",
  "GET /api/apps",
  "POST /api/apps",
  "GET re:^\\/api\\/apps\\/[^/]+$",
  "DELETE re:^\\/api\\/apps\\/[^/]+$",
  "POST re:^\\/api\\/apps\\/[^/]+\\/reload$",
];

// The routes the original cascade gated inline with authorizeSameHost. Lifting
// the gate to a per-row flag must not silently make any of these public — nor
// gate anything that wasn't.
const GOLDEN_AUTH: string[] = [
  "POST re:^\\/api\\/mcp\\/[a-z0-9-]+$",
  "GET /api/health",
  "POST /api/secrets/reload",
  "POST /api/secrets/audit",
  "POST /api/intake",
  "POST /api/intake/approve",
  "POST /api/intake/undo",
  "POST /api/intake/triage",
  "GET /api/intake/inbox",
  "POST /api/intake/act",
  "GET /api/push/vapid-public-key",
  "POST /api/push/subscribe",
  "POST /api/push/forget-device",
  "POST /api/presence",
  "POST /api/notify/test",
  "POST /api/uploads",
  "GET re:^\\/api\\/uploads\\/[a-f0-9]{64}$",
  "GET /api/apps",
  "POST /api/apps",
  "GET re:^\\/api\\/apps\\/[^/]+$",
  "DELETE re:^\\/api\\/apps\\/[^/]+$",
  "POST re:^\\/api\\/apps\\/[^/]+\\/reload$",
];

// The streaming/binary/seam routes that must own req/res (raw), never the
// JSON envelope.
const GOLDEN_RAW: string[] = [
  "POST re:^\\/api\\/mcp\\/[a-z0-9-]+$",
  "POST /api/commands/dispatch",
  "GET /api/events",
  "POST /api/evolve/scan",
  "POST /api/uploads",
  "GET re:^\\/api\\/uploads\\/[a-f0-9]{64}$",
  // git's smart HTTP is binary pkt-line, streamed straight from
  // git-http-backend's stdout — nothing about it survives a JSON envelope.
  "GET /api/worker/git/info/refs",
  "POST /api/worker/git/git-upload-pack",
  "POST /api/worker/git/git-receive-pack",
  // A turn is a long SSE response: the handler owns req/res and streams.
  "POST re:^\\/api\\/model\\/.+$",
  "GET re:^\\/api\\/model\\/.+$",
];

describe("ROUTES contract", () => {
  it("has unique (method, match) keys — no accidental shadow or duplicate", () => {
    const keys = ROUTES.map(rowKey);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
    expect(new Set(keys).size).toBe(ROUTES.length);
  });

  it("covers EXACTLY the golden (method, match) set — nothing dropped or added", () => {
    const actual = new Set(ROUTES.map(rowKey));
    const golden = new Set(GOLDEN);
    const dropped = [...golden].filter((k) => !actual.has(k));
    const added = [...actual].filter((k) => !golden.has(k));
    expect({ dropped, added }).toEqual({ dropped: [], added: [] });
    expect(ROUTES.length).toBe(GOLDEN.length);
    expect(ROUTES.length).toBe(91);
  });

  it("orders every specific route before the broad regex that would swallow it", () => {
    const idx = (key: string): number => {
      const i = ROUTES.findIndex((r) => rowKey(r) === key);
      expect(i, `route not found: ${key}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // [specific, broad] pairs — specific MUST come first.
    const pairs: Array<[string, string]> = [
      ["GET /api/memory/search", "GET re:^\\/api\\/memory\\/[^/]+$"],
      ["GET re:^\\/api\\/agents\\/[^/]+\\/sessions$", "GET re:^\\/api\\/agents\\/[^/]+$"],
      ["DELETE re:^\\/api\\/habits\\/checkin\\/[^/]+$", "GET re:^\\/api\\/habits\\/[^/]+$"],
      ["POST re:^\\/api\\/habits\\/[^/]+\\/checkin$", "GET re:^\\/api\\/habits\\/[^/]+$"],
      ["POST re:^\\/api\\/habits\\/[^/]+\\/archive$", "GET re:^\\/api\\/habits\\/[^/]+$"],
      ["POST /api/elicitation/wait", "POST fn:predicate"],
      ["POST re:^\\/api\\/schedules\\/[^/]+\\/trigger$", "GET re:^\\/api\\/schedules\\/[^/]+$"],
      ["POST re:^\\/api\\/schedules\\/[^/]+\\/snooze$", "GET re:^\\/api\\/schedules\\/[^/]+$"],
    ];
    for (const [specific, broad] of pairs) {
      expect(idx(specific), `${specific} must precede ${broad}`).toBeLessThan(idx(broad));
    }
  });

  it("gates EXACTLY the 22 cascade-gated routes with auth:true (no public regression)", () => {
    const gated = new Set(ROUTES.filter((r) => r.auth === true).map(rowKey));
    const golden = new Set(GOLDEN_AUTH);
    const lostGate = [...golden].filter((k) => !gated.has(k));
    const newGate = [...gated].filter((k) => !golden.has(k));
    expect({ lostGate, newGate }).toEqual({ lostGate: [], newGate: [] });
    expect(gated.size).toBe(22);
  });

  it("marks EXACTLY the 11 streaming/binary/seam routes as raw (owns req/res)", () => {
    const raw = new Set(ROUTES.filter((r) => r.raw != null).map(rowKey));
    expect([...raw].sort()).toEqual([...GOLDEN_RAW].sort());
    // raw rows own the response: they carry no JSON handler/schema.
    for (const r of ROUTES.filter((row) => row.raw != null)) {
      expect(r.handler, `raw row ${rowKey(r)} must not also have a handler`).toBeUndefined();
      expect(r.schema, `raw row ${rowKey(r)} must not declare a schema`).toBeUndefined();
    }
  });

  it("gives every non-raw row a handler (well-formed rows)", () => {
    for (const r of ROUTES.filter((row) => row.raw == null)) {
      expect(typeof r.handler, `row ${rowKey(r)} must have a handler`).toBe("function");
    }
  });
});
