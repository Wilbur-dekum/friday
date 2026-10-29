/**
 * FRI-123 — resumeTurn LISTEN handler + boot-recovery scan.
 *
 * The `resumeTurn` Zero mutator UPDATEs the user block's status
 * from 'complete' to 'resume_requested'. A Postgres trigger
 * (migration `0023_block_resume_notify_trigger.sql`) fires
 * `NOTIFY friday_resume_requested` with the row's `block_id` as
 * payload; this handler:
 *
 *   1. Reads the block row by id and validates (status still
 *      'resume_requested', role=user, kind=text).
 *   2. Validates the parent turn actually errored (an assistant
 *      error block exists for this turn_id) — guards against
 *      stray mutator calls re-firing arbitrary historical user
 *      prompts.
 *   3. Bails on guards that should preserve the row for retry:
 *      - duplicate dispatch already in flight for this turn_id
 *      - agent busy on a different turn
 *      Neither flips the row back — leaving status='resume_requested'
 *      means a future NOTIFY (user re-clicks Resume once the busy
 *      condition clears) or the next daemon boot scan picks it up.
 *   4. Bails on guards that should NOT retry (flips back to
 *      'complete'): wrong shape, no error block in turn, no agent,
 *      corrupt content_json, empty userText.
 *   5. Parses `userText` + `attachments` from content_json.
 *   6. Atomic claim: `UPDATE blocks SET status='complete' WHERE
 *      block_id=$1 AND status='resume_requested'`. If the UPDATE
 *      matches zero rows, another handler won the race — bail
 *      without dispatching. This is the only mechanism that
 *      prevents two concurrent NOTIFYs from producing two
 *      dispatches under the same turn_id.
 *   7. Runs `matchSkillInvocation` on userText so `/<skill> args`
 *      invocations strip the slash command + thread `skillMatch`
 *      through `buildDispatchPrompt` (same as `dispatch-listener`).
 *   8. Calls `buildDispatchPrompt(agentRow, { kind: 'user_chat',
 *      userText, skillMatch })` — same identity, same pinned
 *      facts, same recall + skill-context hook surface as a fresh
 *      user turn.
 *   9. Calls `dispatchTurn` re-using the original `turnId` so the
 *      retry's content blocks visually group with the original
 *      error bubble (FRI-12 contract). Forwards `attachments` so
 *      images/files the user originally sent ride with the retry.
 *      Does NOT insert a new user block — the original user block
 *      is the prompt origin.
 *
 * Boot-recovery scan: on daemon boot, scan
 * `blocks WHERE status='resume_requested'` and apply the same
 * handler — catches resumes that landed while the daemon was
 * down, and resumes the daemon dropped because the agent was
 * busy / a previous resume was in flight at the time. Runs
 * after `runArchiveBootScan` and before `recoverQueuedTurns`.
 *
 * Replaces the retired `POST /api/chat/turn/<id>/resume` REST path
 * (ADR-024 retirement set; deleted in the same PR that added this
 * handler).
 */

import { and, eq } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  INTENT_STATUS,
  loadConfig,
  loadFridayConfig,
  parseUserMessageContent,
  resolveDaemonPort,
  resolveModelForRole,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import { resolveActingUser } from "@friday/shared/services";
import { getBlockById } from "@friday/shared/services";
import * as registry from "./registry.js";
import { dispatchTurn, findAgentByTurnId, peekLiveWorker } from "./lifecycle.js";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import { matchSkillInvocation } from "../skills/match.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

/**
 * Process a single block row that's been flipped to
 * status='resume_requested'. Idempotent: a re-run on a row that's
 * already at 'complete' (another handler claimed and dispatched)
 * is a no-op via the status check.
 */
async function processResumeRequestedRow(blockId: string): Promise<void> {
  const db = getDb();
  const row = await getBlockById(blockId);
  if (!row) {
    // Row deleted out from under us. Nothing to do.
    return;
  }
  if (row.status !== INTENT_STATUS.resumeRequested) {
    // Status moved on (handler ran already, or another path
    // overwrote it). No-op.
    return;
  }
  if (row.role !== "user" || row.kind !== "text") {
    logger.log("warn", "block.resume.skip.shape-mismatch", {
      block_id: row.blockId,
      role: row.role,
      kind: row.kind,
    });
    // Terminal: malformed row, no retry.
    await flipBackToComplete(blockId);
    return;
  }

  const turnId = row.turnId;
  const agentName = row.agentName;

  // Validate the parent turn actually has an error block — the
  // Resume CTA is gated on the dashboard side too (chat.canResumeTurn),
  // but server-side validation closes the gap for stray mutator
  // calls (test, bookmark, accidental call) that would otherwise
  // re-fire arbitrary historical user prompts.
  const errorBlocks = await db
    .select({ blockId: schema.blocks.blockId })
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.turnId, turnId),
        eq(schema.blocks.role, "assistant"),
        eq(schema.blocks.kind, "error"),
      ),
    )
    .limit(1);
  if (errorBlocks.length === 0) {
    logger.log("warn", "block.resume.skip.no-error-block", {
      block_id: blockId,
      turn_id: turnId,
    });
    // Terminal: not a valid resume target (turn didn't error).
    await flipBackToComplete(blockId);
    return;
  }

  // Don't double-dispatch under the same turnId. A duplicate
  // resume click while the previous re-dispatch is still running
  // hits this guard. Leave the row at 'resume_requested' so a
  // future NOTIFY (user re-clicks once the in-flight turn
  // finishes) or boot scan picks it up; don't flip back, which
  // would silently lose the click.
  if (findAgentByTurnId(turnId)) {
    logger.log("warn", "block.resume.skip.turn-in-flight", {
      block_id: blockId,
      turn_id: turnId,
      agent: agentName,
    });
    return;
  }

  const agentRow = await registry.getAgent(agentName);
  if (!agentRow) {
    logger.log("warn", "block.resume.skip.no-agent", {
      block_id: blockId,
      agent: agentName,
    });
    // Terminal: agent gone, can't dispatch ever.
    await flipBackToComplete(blockId);
    return;
  }

  const live = peekLiveWorker(agentName);
  if (live && live.status === "working") {
    logger.log("warn", "block.resume.skip.agent-busy", {
      block_id: blockId,
      agent: agentName,
    });
    // Soft retry: agent is on some other turn. Leave row marked
    // so the user can re-click after, or so boot scan retries.
    return;
  }

  // Parse the original user prompt out of content_json via the shared view
  // (ADR-049) — the same parser the dispatch listener uses. Unlike dispatch,
  // a malformed payload (`ok: false`) is a TERMINAL no-retry bail here: a
  // resume re-fires a historical prompt, and a corrupt one can't be rebuilt.
  const parsed = parseUserMessageContent(row.contentJson);
  if (!parsed.ok) {
    logger.log("warn", "block.resume.skip.content-corrupt", {
      block_id: blockId,
      turn_id: turnId,
    });
    await flipBackToComplete(blockId);
    return;
  }
  const userText = parsed.content.text;
  const attachments = parsed.content.attachments;
  if (!userText.trim()) {
    logger.log("warn", "block.resume.skip.empty-text", {
      block_id: blockId,
      turn_id: turnId,
    });
    await flipBackToComplete(blockId);
    return;
  }

  // Atomic claim: only one handler wins the transition
  // resume_requested → complete. Any concurrent NOTIFY whose
  // handler reaches this point will find rowCount=0 and bail —
  // that's the dedup that prevents two dispatches under the same
  // turn_id. Done BEFORE dispatchTurn (which is fire-and-forget)
  // so the row is at 'complete' the moment the worker starts
  // working; a subsequent click correctly fires a new NOTIFY.
  const claim = await db
    .update(schema.blocks)
    .set({ status: "complete" })
    .where(
      and(
        eq(schema.blocks.blockId, blockId),
        eq(schema.blocks.status, INTENT_STATUS.resumeRequested),
      ),
    )
    .returning({ blockId: schema.blocks.blockId });
  if (claim.length === 0) {
    logger.log("debug", "block.resume.skip.claim-lost", {
      block_id: blockId,
      turn_id: turnId,
    });
    return;
  }

  // Skill detection mirrors dispatch-listener exactly so a
  // `/<skill> args` retry strips the slash command, fires
  // skillContextHook, and applies the skill's allowedTools
  // restriction — same shape as the original user-chat turn.
  const skillMatch = matchSkillInvocation(userText, agentRow.type);
  const promptText = skillMatch ? skillMatch.userText : userText;

  const {
    body: dispatchBody,
    systemPrompt,
    allowedToolsOverride,
  } = await buildDispatchPrompt(
    agentRow,
    {
      kind: "user_chat",
      userText: promptText,
      skillMatch: skillMatch ?? undefined,
    },
    // FRI-2016: same acting User as the original user-chat turn this resumes.
    (await resolveActingUser(row.userId)) ?? undefined,
  );

  const cfg = loadConfig();
  const modelCfg = resolveModelForRole(cfg, agentRow.type);
  const resumeCwd = await registry.workingDirectoryFor(agentRow);
  dispatchTurn({
    agentName,
    options: {
      agentName,
      agentType: agentRow.type,
      workingDirectory: resumeCwd,
      systemPrompt,
      prompt: dispatchBody,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      turnId, // <-- reuse the failed turn's id (FRI-12 contract)
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId: agentRow.sessionId ?? undefined,
      daemonPort: resolveDaemonPort(cfg),
      parentName: "parentName" in agentRow ? (agentRow.parentName ?? undefined) : undefined,
      // FRI-156 follow-up (SEV-0): a Resume re-fires an INTERACTIVE user_chat
      // turn (validated role=user, kind=text above) the user is waiting on. It
      // must run `long-lived` so the agent actually responds — dispatching a
      // scheduled-type agent `one-shot` here short-circuits the worker loop and
      // the user's resumed message silently vanishes (same chain as
      // dispatch-listener). Gate on the block source, not the agent type.
      mode: "long-lived",
      turnSource: row.source ?? "user_chat",
      allowedToolsOverride,
    },
  });

  logger.log("info", "block.resume.applied", {
    block_id: blockId,
    agent: agentName,
    turn_id: turnId,
    skill: skillMatch?.skill.name ?? null,
    attachmentCount: attachments?.length ?? 0,
  });
}

async function flipBackToComplete(blockId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.blocks)
    .set({ status: "complete" })
    .where(eq(schema.blocks.blockId, blockId));
}

export async function runResumeBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ blockId: schema.blocks.blockId })
      .from(schema.blocks)
      .where(eq(schema.blocks.status, INTENT_STATUS.resumeRequested));
    for (const row of rows) {
      await processResumeRequestedRow(row.blockId);
    }
    logger.log("info", "block.resume-boot-scan.complete", {
      processed: rows.length,
    });
  } catch (err) {
    logger.log("warn", "block.resume-boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ResumeListenerHandle {
  stop: () => Promise<void>;
}

export async function startResumeListener(): Promise<ResumeListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    loadFridayConfig().databaseUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to start the resumeTurn LISTEN connection.");
  }

  let stopped = false;
  let activeClient: InstanceType<typeof Client> | null = null;

  // Mirror abort-listener: reconnect loop with keepAlive + exponential backoff.
  async function connectWithRetry(): Promise<void> {
    let delay = 1_000;
    while (!stopped) {
      try {
        const c = new Client({ connectionString, keepAlive: true });
        activeClient = c;
        await c.connect();
        c.on("notification", (msg) => {
          if (msg.channel !== LISTEN_CHANNELS.resumeRequested) return;
          const blockId = msg.payload;
          if (!blockId) return;
          void processResumeRequestedRow(blockId).catch((err) => {
            logger.log("warn", "block.resume-listen.process.error", {
              block_id: blockId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        });
        c.on("error", (err) => {
          logger.log("warn", "block.resume-listen.client.error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await c.query(`LISTEN ${LISTEN_CHANNELS.resumeRequested}`);
        logger.log("info", "block.resume-listen.ready", {
          channel: LISTEN_CHANNELS.resumeRequested,
        });
        await runResumeBootScan();
        delay = 1_000;
        await new Promise<void>((resolve) => c.once("end", resolve));
      } catch (err) {
        logger.log("warn", "block.resume-listen.connect.error", {
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
          await activeClient.query(`UNLISTEN ${LISTEN_CHANNELS.resumeRequested}`);
        } catch {
          // best-effort
        }
        await activeClient.end().catch(() => {});
      }
    },
  };
}

// Test-only export: lets `resume-listener.test.ts` drive the handler
// without spinning up the LISTEN connection.
export { processResumeRequestedRow as _processResumeRequestedRow };
