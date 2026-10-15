/**
 * FRI-2013: a row census for verifying a database move.
 *
 * The cutover's failure mode is silent. Point a Deployment at a fresh Postgres
 * and migrations run on boot, create every table, and the stack comes up
 * perfectly healthy — with nothing in it. You discover it by noticing the
 * tickets and chat history are gone.
 *
 * So a migration is not "done" when the stack boots; it is done when the rows
 * that were there before are there after. This counts them on both sides.
 *
 * Only the tables that exist SOLELY in Postgres matter for the comparison.
 * Memory entries are canonical as `memory/entries/*.md` with the database as a
 * searchable mirror, so a memory row count can legitimately differ after a
 * reindex; `tickets`, `blocks`, `mail`, `habits`, `schedules` and
 * `inbox_items` have exactly one copy and must match.
 */

/**
 * THE SOURCE MUST BE STOPPED BEFORE THE DUMP.
 *
 * Learned the hard way doing the first real host→container migration: the
 * census read 34175 blocks, the restored copy held 34176, and the source was
 * at 34178 twenty seconds later. Nothing was corrupt — the daemon was running
 * and writing the whole time.
 *
 * Two consequences, and the second is the serious one. A census of a live
 * database can never match, so verification is meaningless while the source is
 * up. And every write between the dump and the cutover is silently lost: the
 * new Deployment starts from a snapshot that is already stale, with no error
 * anywhere to say so.
 *
 * So a cutover is: stop the source, census, dump, restore, census, compare —
 * in that order. `friday restore` already refuses to run while the daemon is
 * up for the same reason; this is the other half of that rule, on the source
 * side, where nothing currently enforces it.
 */

/** Tables whose only copy is Postgres — a mismatch here is data loss. */
export const CENSUS_TABLES = [
  "tickets",
  "ticket_comments",
  "ticket_relations",
  "ticket_external_links",
  "blocks",
  "mail",
  "habits",
  "habit_checkins",
  "schedules",
  "schedule_runs",
  "inbox_items",
  "agents",
  "attachments",
  "apps",
  "evolve_proposals",
  "user",
] as const;

export type RowCensus = Record<string, number>;

export interface CensusDiff {
  ok: boolean;
  /** Tables whose counts differ, with both sides. */
  mismatches: Array<{ table: string; before: number; after: number }>;
  /** Tables present in one census but not the other. */
  missing: string[];
}

/**
 * Compare two censuses. `after` having MORE rows is still a mismatch — a
 * restore should reproduce the source exactly, and a surplus means the target
 * was not empty, which is its own problem.
 *
 * Pure, so the comparison is testable without two databases.
 */
export function diffCensus(before: RowCensus, after: RowCensus): CensusDiff {
  const mismatches: CensusDiff["mismatches"] = [];
  const missing: string[] = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[table];
    const a = after[table];
    if (b === undefined || a === undefined) {
      missing.push(table);
      continue;
    }
    if (b !== a) mismatches.push({ table, before: b, after: a });
  }
  return {
    ok: mismatches.length === 0 && missing.length === 0,
    mismatches: mismatches.sort((x, y) => x.table.localeCompare(y.table)),
    missing: missing.sort(),
  };
}

/** Human-readable report for the CLI. */
export function formatCensusDiff(diff: CensusDiff): string {
  if (diff.ok) return "row counts match on every Postgres-only table";
  const lines: string[] = [];
  for (const m of diff.mismatches) {
    const delta = m.after - m.before;
    lines.push(`  ${m.table}: ${m.before} → ${m.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  for (const t of diff.missing) lines.push(`  ${t}: present on only one side`);
  return lines.join("\n");
}
