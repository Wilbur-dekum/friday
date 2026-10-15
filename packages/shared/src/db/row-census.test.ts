/**
 * FRI-2013 — verifying a database move.
 *
 * The cutover's failure mode is silent: a fresh Postgres gets every table
 * created by boot-time migrations and the stack comes up healthy and empty.
 * These pin the comparison that catches it.
 */

import { describe, expect, it } from "vitest";
import { diffCensus, formatCensusDiff, CENSUS_TABLES } from "./row-census.js";

describe("diffCensus", () => {
  it("passes when every count matches", () => {
    const c = { tickets: 57, blocks: 1200, mail: 3 };
    expect(diffCensus(c, { ...c }).ok).toBe(true);
  });

  it("catches the silent-empty case the ticket exists for", () => {
    const before = { tickets: 57, blocks: 1200, mail: 3 };
    const after = { tickets: 0, blocks: 0, mail: 0 };
    const d = diffCensus(before, after);
    expect(d.ok).toBe(false);
    expect(d.mismatches).toHaveLength(3);
  });

  it("treats a SURPLUS as a mismatch too", () => {
    // A restore should reproduce the source exactly. More rows after means the
    // target was not empty, which is its own problem — not a success.
    const d = diffCensus({ tickets: 57 }, { tickets: 58 });
    expect(d.ok).toBe(false);
    expect(d.mismatches[0]).toEqual({ table: "tickets", before: 57, after: 58 });
  });

  it("flags a table present on only one side rather than ignoring it", () => {
    const d = diffCensus({ tickets: 1, habits: 2 }, { tickets: 1 });
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual(["habits"]);
  });

  it("reports the delta in a form an operator can act on", () => {
    const out = formatCensusDiff(diffCensus({ tickets: 57 }, { tickets: 0 }));
    expect(out).toContain("tickets: 57 → 0 (-57)");
  });

  it("covers the Postgres-only tables, and not memory", () => {
    // memory_entries is canonical on disk as markdown with the DB as a
    // searchable mirror, so its count can legitimately differ after a reindex.
    // Including it would produce false alarms on a correct migration.
    expect(CENSUS_TABLES).toContain("tickets");
    expect(CENSUS_TABLES).toContain("blocks");
    expect(CENSUS_TABLES).toContain("inbox_items");
    expect(CENSUS_TABLES).not.toContain("memory_entries");
  });
});
