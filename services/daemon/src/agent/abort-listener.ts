/**
 * Phase 4.10 — abortTurn LISTEN handler + boot-recovery scan.
 *
 * The `abortTurn` mutator UPDATEs the user block's status from
 * 'complete' to 'abort_requested'. A Postgres trigger (migration
 * `0009_block_abort_notify_trigger.sql`) fires
 * `NOTIFY friday_abort_requested` with the row's `block_id` as
 * payload; this handler:
 *
 *   1. Calls the existing `abortTurn(agentName)` lifecycle function
 *      — idempotent against the fast-path
 *      (`POST /api/internal/abort-turn`) winning the race. If no
 *      live worker exists for this agent (the worker already finished
 *      or the fast-path's force-kill arm fired), the function
 *      returns false and we proceed to the flip-back step regardless.
 *   2. UPDATEs the row back to status='complete' (the natural
 *      terminal state for a user block) so the AFTER UPDATE trigger
 *      doesn't keep re-firing on subsequent unrelated UPDATEs.
 *
 * Boot-recovery scan (plan §5): on daemon boot, scan
 * `blocks WHERE status='abort_requested'` and apply the same
 * handler — catches aborts that landed while the daemon was down.
 * Runs BEFORE `recoverQueuedTurns()` so a turn marked aborted
 * pre-shutdown isn't accidentally re-dispatched on restart.
 *
 * Coexists with the legacy `POST /api/chat/turn/<id>/abort` REST
 * path which calls `abortTurn(agentName)` directly without touching
 * the block row. The two paths are safe to interleave because the
 * trigger only fires on transition INTO 'abort_requested'.
 */

import { eq } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  INTENT_STATUS,
  loadFridayConfig,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import { getBlockById } from "@friday/shared/services";
import { abortTurn } from "./lifecycle.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

/**
 * Process a single block row that's been flipped to
 * status='abort_requested'. Idempotent — re-running on a row that's
 * already been flipped back to 'complete' is a no-op (the row read
 * short-circuits).
 */
async function processAbortRequestedRow(blockId: string): Promise<void> {
  const row = await getBlockById(blockId);
  if (!row) {
    // Block deleted (e.g. by the cancelQueued path racing the abort
    // path on a queued-then-cancelled turn). Nothing to do.
    return;
  }
  if (row.status !== INTENT_STATUS.abortRequested) {
    // Status moved on (the daemon flipped it back to 'complete' on a
    // prior handler run, or another path overwrote it). No-op.
    return;
  }

  // Dispatch the existing lifecycle abort. Returns false when no
  // live worker exists — that's fine; the row's status flip-back
  // below still completes the cycle.
  const aborted = await abortTurn(row.agentName);

  // Flip the row back to its terminal state so the trigger doesn't
  // re-fire on the next UPDATE to this row. The user block lives at
  // 'complete' in its natural state — that's the post-condition the
  // dashboard's reactive query expects.
  const db = getDb();
  await db
    .update(schema.blocks)
    .set({ status: "complete" })
    .where(eq(schema.blocks.blockId, blockId));

  logger.log("info", "block.abort.applied", {
    block_id: blockId,
    agent: row.agentName,
    turn_id: row.turnId,
    aborted_live_worker: aborted,
  });
}

export async function runAbortBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ blockId: schema.blocks.blockId })
      .from(schema.blocks)
      .where(eq(schema.blocks.status, INTENT_STATUS.abortRequested));
    for (const row of rows) {
      await processAbortRequestedRow(row.blockId);
    }
    logger.log("info", "block.abort-boot-scan.complete", {
      processed: rows.length,
    });
  } catch (err) {
    logger.log("warn", "block.abort-boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface AbortListenerHandle {
  stop: () => Promise<void>;
}

export async function startAbortListener(): Promise<AbortListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    loadFridayConfig().databaseUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the abortTurn LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // FRI-121 B: reconnect loop with keepAlive + exponential backoff.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.abortRequested) return;
          const blockId = msg.payload;
          if (!blockId) return;
          void processAbortRequestedRow(blockId).catch((err) => {
            logger.log("warn", "block.abort-listen.process.error", {
              block_id: blockId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "block.abort-listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.abortRequested}`);
        logger.log("info", "block.abort-listen.ready", {
          channel: LISTEN_CHANNELS.abortRequested,
        });
        await runAbortBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "block.abort-listen.connect.error", {
          message: err instanceof Error ? err.message : String(err),
          retryIn: delay,
        });
        if (!stopped) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 30_000);
        }
      } finally {
        activeClient = null;
      }
    }
  }

  void connectWithRetry();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (activeClient) {
        try {
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.abortRequested}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}

// Test-only export: lets `abort-listener.test.ts` drive the handler
// without spinning up the LISTEN connection.
export { processAbortRequestedRow as _processAbortRequestedRow };
