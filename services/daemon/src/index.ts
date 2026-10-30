import {
  closeDb,
  ensureDirs,
  ensureSoul,
  loadConfig,
  GENERATION_PATH,
  loadFridayConfig,
  readGeneration,
  resolveDaemonPort,
  warmVaultCache,
  unlockVault,
  clearFridayConfigCache,
  clearSecretsCache,
  resolveModelForRole,
  runMigrations,
  reconcileSyncPublication,
} from "@friday/shared";
import { logger } from "./log.js";
import { startServer, DAEMON_VERSION } from "./api/server.js";
import { ensureVapidKeys } from "./notifications/vapid.js";
import { registerIntakeTargets } from "./intake/registry.js";
import { startHealthHeartbeat, clearHealth } from "./monitor/health.js";
import { backfillUsageFromLegacyJsonl, replayPending } from "@friday/shared/services";
import { seedMetaAgents, startScheduler } from "./scheduler/scheduler.js";
import { reconcile as reconcileLinear } from "@friday/integrations-linear";
import * as registry from "./agent/registry.js";
import { isDaemonOwnedWorkspace } from "./agent/workspace.js";
import { recoverFromJsonl, type RecoveryAgent } from "./agent/jsonl-recovery.js";
import { recoverDanglingToolUses } from "./agent/dangling-tool-use-recovery.js";
import { startMailBridge } from "./comms/mail-bridge.js";
import { reconcileAppsOnBoot } from "./apps/reconcile.js";
import { reconcileBoundedHabits, startHabitReconcile } from "./habits/reconcile.js";
import { runEvolveBootSync } from "./evolve/projector.js";
import { startWatchdog, stopWatchdog } from "./agent/watchdog.js";
import { startCompactionSweep, stopCompactionSweep } from "./scheduler/compaction-sweep.js";
import { sweepOrphanedScheduleRuns } from "./scheduler/runs.js";
import {
  startPendingBlockReaper,
  stopPendingBlockReaper,
} from "./scheduler/pending-block-reaper.js";
import {
  archiveAgent,
  dispatchTurn,
  reapAllLiveWorkers,
  setAgentProjection,
  startTurnStallWatchdog,
  stopTurnStallWatchdog,
} from "./agent/lifecycle.js";
import { sandboxExecAvailable } from "./agent/sandbox-profile.js";
import { startInvariantAuditor, stopInvariantAuditor } from "./agent/invariants.js";
import { startMailPruner, stopMailPruner } from "./services/mail-prune.js";
import { buildDispatchPrompt } from "./prompts/build-dispatch-prompt.js";
import "./hooks/register.js";
import { agentCwdPinV1 } from "./state-migrations/agent-cwd-pin-v1.js";
import { embedBackfillV1 } from "./state-migrations/embed-backfill-v1.js";
import { runStateMigrations } from "./state-migrations/runner.js";
import { warmEmbedChild } from "@friday/memory";
import { syncProposalsForClosedTickets } from "./services/proposal-sync.js";
import { runSettingsBootScan, startSettingsListener } from "./settings/listener.js";
import { runMemoryBootScan, startMemoryListener } from "./memory/listener.js";
import { runScheduleBootScan, startScheduleListener } from "./scheduler/listener.js";
import { runAppBootScan, startAppListener } from "./apps/listener.js";
import { runArchiveBootScan, startArchiveListener } from "./agent/archive-listener.js";
import { runCancelBootScan, startCancelListener } from "./agent/cancel-listener.js";
import { runAbortBootScan, startAbortListener } from "./agent/abort-listener.js";
import { runDispatchBootScan, startDispatchListener } from "./agent/dispatch-listener.js";
import { runResumeBootScan, startResumeListener } from "./agent/resume-listener.js";
import { deleteBlockById, inbox as mailInbox, listQueuedUserBlocks } from "@friday/shared/services";
import { buildMailPrompt } from "./comms/mail-prompt.js";
import { randomUUID } from "node:crypto";
import { existsSync, watchFile } from "node:fs";
import { posthog, DISTINCT_ID, initPosthog } from "./posthog.js";

async function main(): Promise<void> {
  ensureDirs();
  // FRI-150 (pivot, ADR-037): load Friday config into an immutable object —
  // does NOT mutate process.env. Daemon-side callers read secrets via
  // `loadFridayConfig().<field>`; the daemon's process.env is kept clean
  // of secrets so the worker fork doesn't inherit them.
  await warmVaultCache();
  loadFridayConfig();
  // FRI-166 follow-up: build the PostHog client now that the vault is warm (it
  // resolves POSTHOG_API_KEY from the warmed cache, and exception-autocapture
  // installs at startup). posthog.ts is lazy precisely so its key read lands
  // here, after the warm, not at its module-load import above.
  initPosthog();
  startSecretsGenerationWatch();
  // FRI-150 (pivot, ADR-037): shell-env capture has moved from the daemon
  // boot path to the per-worker entry point (`services/daemon/src/agent/
  // worker.ts`). Workers capture their own user-shell env at startup; the
  // daemon no longer holds a shared singleton and no longer forwards it
  // via `FRIDAY_RESOLVED_SHELL_ENV_JSON`. This matches the trust gradient
  // — daemon process has no user-shell context, workers get the full
  // shell, MCP children get a restricted allowlist (see mcp/builder.ts).
  await runMigrations();
  // Reconcile the Zero logical-replication publication to the just-migrated
  // schema. Migrations create new replicated tables (e.g. FRI-169 `habits`),
  // but historically ONLY `friday setup` added them to `friday_pub`. A box
  // upgraded via `friday update` never re-ran setup, so a newly-shipped
  // replicated table was absent from the publication and every client whose
  // bundled Zero schema knew the table fell into a SchemaVersionNotSupported
  // reload loop. Running it here — right after migrations, where the daemon
  // already owns boot-time schema reconciliation — makes `friday update`
  // /`restart`/`start` all fully complete an upgrade. zero-cache's autoReset
  // (default on) re-COPYs the added table once it lands in the publication.
  // Best-effort: a failure degrades to the prior "new table not synced"
  // behavior (recoverable via `friday setup`), never a boot crash.
  try {
    const pub = await reconcileSyncPublication((msg) =>
      logger.log("debug", "publication.reconcile.step", { msg }),
    );
    if (pub.created || pub.added.length > 0 || pub.dropped.length > 0) {
      logger.log("info", "publication.reconcile.changed", {
        created: pub.created,
        added: pub.added,
        dropped: pub.dropped,
      });
    }
  } catch (err) {
    logger.log("error", "publication.reconcile.error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // FRI-61: state migrations run AFTER schema migrations (Drizzle just
  // created the `_friday_state_migrations` table) and BEFORE any
  // dispatch / mail bridge / scheduler / recovery path that could spawn
  // a worker against stale paths.
  // FRI-24: `embed-backfill-v1` fills the NULL `memory_entries.embedding`
  // column that migration 0036 added. Per-entry fail-open inside
  // backfillEmbeddings keeps boot non-blocking if the embedding runtime
  // isn't provisioned yet (recall degrades to FTS-only).
  await runStateMigrations([agentCwdPinV1, embedBackfillV1]);
  ensureSoul();

  // FRI-142 / ADR-048: ensure the server-only Web Push VAPID keypair exists in
  // Postgres (atomic INSERT … ON CONFLICT DO NOTHING; generated once, never
  // overwritten — regenerating would invalidate every existing subscription).
  // Best-effort like reconcileSyncPublication: a failure degrades push to
  // unavailable (the public-key endpoint re-ensures defensively), it is NOT a
  // hard preflight — never crash boot over a missing keypair.
  try {
    await ensureVapidKeys();
  } catch (err) {
    logger.log("error", "vapid.ensure.boot.error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const backfill = await backfillUsageFromLegacyJsonl();
  if ("skipped" in backfill && backfill.skipped) {
    logger.log("info", "usage.backfill.skip", { reason: backfill.reason });
  } else {
    logger.log("info", "usage.backfill.done", {
      inserted: backfill.inserted,
      source: backfill.source,
    });
  }

  // Phase 4.3: settings boot-recovery scan. Must run BEFORE the
  // first `loadConfig()` below — settings changes that landed while
  // the daemon was down need to be applied to ~/.friday/config.json
  // so the daemon sees the user's intent on the very first read.
  await runSettingsBootScan();

  const cfg = loadConfig();
  const daemonPort = resolveDaemonPort(cfg);
  // Seed the orchestrator agent row BEFORE the API serves, so a fresh install
  // has it from the very first request. Without it the dashboard's orchestrator
  // chat 404s on GET /api/agents/<name> (→ 502) and hangs on the loading
  // skeleton until the user sends a message. Insert-only — no-op once it exists.
  await registry.ensureOrchestratorAgent(cfg.orchestratorName);
  // FRI-142 / ADR-048 (Layer 3): populate the producer-agnostic Route-target
  // registry with Intake's targets (core targets statically + a dynamic
  // provider for app/orchestrator mail targets) BEFORE the API serves, so any
  // inbox approve/undo/triage — Intake's or a future non-Intake producer's —
  // resolves through the same registry. Idempotent.
  registerIntakeTargets();
  const server = startServer({ port: daemonPort });
  const heartbeat = startHealthHeartbeat(daemonPort);

  // Phase 4.3: open the long-lived LISTEN connection for
  // `friday_settings_changed`. Subsequent settings updates from the
  // dashboard mutator rewrite config.json without a daemon restart,
  // so the next worker spawn picks up the new value.
  const settingsListener = await startSettingsListener();

  // Phase 4.5: open the long-lived LISTEN connection for
  // `friday_memory_file_changed`. Boot-recovery scan first to apply
  // any pending rows that landed while the daemon was down.
  await runMemoryBootScan();
  const memoryListener = await startMemoryListener();

  // FRI-24: best-effort, NON-BLOCKING warmup of the embedding CHILD (the same
  // forked process the recall/store/backfill paths use). This keeps the ~240MB
  // onnxruntime-web runtime OUT of the daemon process (the whole point of the
  // forked child + idle reaper), warms the actual path the first recall hits so
  // it doesn't cold-load under the query timeout, and is reaped when idle. The
  // PRIMARY asset provisioning (model download) lives in `friday update`; this
  // just spins the child up against the on-disk model. FAIL-OPEN — never throws,
  // returns false on a missing runtime/model; not awaited so boot proceeds.
  void warmEmbedChild().then(
    (ok) => logger.log("info", "embed-warm.boot.done", { ok }),
    (err) =>
      logger.log("warn", "embed-warm.boot.error", {
        message: err instanceof Error ? err.message : String(err),
      }),
  );

  // Phase 4.6: open the long-lived LISTEN connection for
  // `friday_schedule_changed`. Boot-recovery scan first to apply
  // pending registers/reloads/deletes that landed while the daemon
  // was down. Runs BEFORE the scheduler's 30s tick starts so a
  // dashboard-created schedule is registered before its first fire
  // window opens.
  await runScheduleBootScan();
  const scheduleListener = await startScheduleListener();

  // Item #54: project FS-canonical evolve proposals into Postgres so
  // the dashboard's /evolve page can read them via Zero reactively.
  // Idempotent UPSERT — re-running this on a clean tree is a no-op
  // write set. Drops PG rows whose FS file was deleted during the
  // downtime window.
  await runEvolveBootSync();

  // Phase 4.7: open the long-lived LISTEN connection for
  // `friday_app_changed`. Boot-recovery scan runs AFTER
  // `reconcileAppsOnBoot()` (already invoked earlier) — that one
  // handles disk-vs-DB drift; this one handles the narrower case
  // of dashboard-mutator-initiated pending requests that didn't
  // get processed before the daemon went down.
  await runAppBootScan();
  const appListener = await startAppListener();

  // Phase 4.8: open the long-lived LISTEN connection for
  // `friday_archive_requested`. Boot-recovery scan picks up
  // archive requests that landed during daemon downtime.
  await runArchiveBootScan();
  const archiveListener = await startArchiveListener();

  // Phase 4.9: open the long-lived LISTEN connection for
  // `friday_block_canceled`. Boot-recovery scan applies any
  // `status='cancel_requested'` rows that landed during daemon
  // downtime (the mutator commits durably even when the daemon is
  // down; the LISTEN handler picks them up on next boot). Must run
  // BEFORE `recoverQueuedTurns()` so a row marked `cancel_requested`
  // pre-shutdown is yanked from the queue before any worker re-spawn
  // could re-dispatch it.
  await runCancelBootScan();
  const cancelListener = await startCancelListener();

  // Phase 4.10: open the long-lived LISTEN connection for
  // `friday_abort_requested`. Boot-recovery scan applies any
  // `status='abort_requested'` rows that landed during daemon
  // downtime, calls the lifecycle abort (no-op if no live worker)
  // and flips the row back to 'complete'. Must run BEFORE
  // `recoverQueuedTurns()` so a turn marked aborted pre-shutdown
  // isn't accidentally re-dispatched on restart.
  await runAbortBootScan();
  const abortListener = await startAbortListener();

  // Phase 4.11b: open the long-lived LISTEN connection for
  // `friday_new_pending_block`. Boot-recovery scan dispatches any
  // user-chat blocks that landed at status='pending' while the
  // daemon was down (the mutator commits durably even when the
  // daemon is offline). Must run BEFORE `recoverQueuedTurns()` so
  // the dispatch path isn't doubled up.
  await runDispatchBootScan();
  const dispatchListener = await startDispatchListener();

  // FRI-123: open the long-lived LISTEN connection for
  // `friday_resume_requested`. Boot-recovery scan picks up any
  // resume-requested rows that landed during daemon downtime, then
  // re-dispatches the failed turn under its original turn_id (FRI-12
  // visual-grouping contract). Runs BEFORE `recoverQueuedTurns()`
  // so a resume that landed mid-shutdown re-fires on the existing
  // turnId before queue replay.
  await runResumeBootScan();
  const resumeListener = await startResumeListener();

  // Boot recovery
  startMailBridge(); // subscribe before replayPending so recovered mail fires through the bridge
  await replayPending();
  await seedMetaAgents();
  await reconcileAppsOnBoot();
  await recoverAgents(cfg);
  // Heal SDK sessions wedged on an unresolved tool_use (worker died
  // mid-tool-call — `kill -9`, OOM, daemon crash). Runs BEFORE
  // `recoverQueuedTurns` so any queued user block waiting on a
  // wedged agent dispatches into a freshly-reset session, not the
  // dead one.
  await recoverDanglingToolUses();
  await recoverQueuedTurns(cfg);
  // ADR-024 leak backstop: close any `schedule_runs` row left `running` by a
  // crash/kill after `openScheduleRun` but before its terminal close (the row
  // handle is in-memory only, so no live worker can ever close it). Must run
  // BEFORE the scheduler tick re-fires anything. Best-effort, never throws.
  await sweepOrphanedScheduleRuns();
  // FRI-169: archive Bounded Habits whose window closed while the daemon was
  // DOWN. A Bounded window closes on a clock boundary with no write event, so
  // nothing flips the row to completed|expired unless a sweep does — this boot
  // sweep catches windows that closed during downtime; startHabitReconcile()
  // below covers the live-daemon case. Best-effort, never blocks boot.
  await reconcileBoundedHabits().catch((err: unknown) => {
    logger.log("warn", "habits.reconcile.boot.error", { error: String(err) });
  });
  const schedTick = startScheduler();
  const habitReconcileTick = startHabitReconcile();
  const watchdog = startWatchdog();
  // FRI-156 §B: the nightly maintenance compaction sweep — a daemon-internal
  // timer (NOT a schedules-table row). Unref'd, so it never holds the loop open.
  const compactionSweep = startCompactionSweep();
  // SEV-0 "no user message is ever lost": the pending-block reaper is the
  // live-daemon backstop for a `user_chat` block stranded at status='pending'
  // by a missed NOTIFY or the boot-scan shape-mismatch skip. The boot scan
  // only re-picks pending rows at STARTUP; this unref'd timer covers the
  // live-daemon case. Complements (does not replace) the zero-block net.
  const pendingBlockReaper = startPendingBlockReaper();
  startTurnStallWatchdog();
  startInvariantAuditor();
  startMailPruner();
  void reconcileLinear()
    .then(async (result) => {
      if (!result.ran) {
        logger.log("debug", "linear.reconcile.skip", { reason: result.reason });
        return;
      }
      if (result.orphans.length > 0) {
        // Phase 5: `system_banner` SSE retired. The dashboard's
        // sidebar will pick up the orphan-count signal from the
        // `system_banners` table (ADR-024) in Phase 6; for now the
        // info-level surface is the daemon log entry below.
        logger.log("info", "linear.reconcile.orphans", {
          count: result.orphans.length,
          stale: result.staleLinks.length,
          closed: result.closedTicketIds.length,
          linked: result.linkedCount,
        });
      } else {
        logger.log("info", "linear.reconcile.clean", {
          linked: result.linkedCount,
          stale: result.staleLinks.length,
          closed: result.closedTicketIds.length,
        });
      }
      // FRI-66: tickets that reconcile just transitioned to terminal
      // because Linear's GitHub integration closed them on PR merge.
      // Cascade to any originating evolve proposals.
      if (result.closedTicketIds.length > 0) {
        await syncProposalsForClosedTickets(result.closedTicketIds);
      }
    })
    .catch((err) =>
      logger.log("warn", "linear.reconcile.error", {
        message: err instanceof Error ? err.message : String(err),
      }),
    );

  const modelCfg = resolveModelForRole(cfg, "orchestrator");
  logger.log("info", "daemon.ready", {
    port: daemonPort,
    version: DAEMON_VERSION,
    model: modelCfg.name,
    thinking: modelCfg.thinking?.type ?? "default",
    effort: modelCfg.effort ?? "default",
  });

  // M2: Surface the kernel-sandbox status loudly at boot so an accidental
  // disable (FRIDAY_SANDBOX_EXEC=0) or a missing binary doesn't fail silent.
  const sb = sandboxExecAvailable();
  logger.log(sb.available ? "info" : "warn", "daemon.sandbox-exec", {
    enabled: sb.available,
    reason: sb.reason,
    note: sb.available
      ? "builders run under sandbox-exec; M2 kernel backstop active"
      : "builders NOT sandboxed; relying on M1 PreToolUse + M4 pgrp only",
  });

  const shutdown = (signal: string) => {
    logger.log("info", "daemon.shutdown", { signal });
    // M4: SIGTERM every live worker's process group before we exit so leaked
    // descendants don't get orphaned to launchd. Doesn't wait for the kill
    // to complete — the 2s ceiling below is the hard floor.
    reapAllLiveWorkers();
    clearInterval(heartbeat);
    clearInterval(schedTick);
    clearInterval(habitReconcileTick);
    void watchdog;
    void compactionSweep;
    void pendingBlockReaper;
    stopWatchdog();
    stopCompactionSweep();
    stopPendingBlockReaper();
    stopTurnStallWatchdog();
    stopInvariantAuditor();
    stopMailPruner();
    void settingsListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void memoryListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void scheduleListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void appListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void archiveListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void cancelListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void abortListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void dispatchListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    void resumeListener.stop().catch(() => {
      /* shutdown best-effort; the process is about to exit */
    });
    clearHealth();
    flushDb();
    void posthog.shutdown().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Boot recovery for agents:
 *  - Heal orphaned builders: row says builder but the worktree directory
 *    is gone (e.g. the user archived it pre-F1-A, the buggy exit handler
 *    reset status to idle, and the workspace was already cleaned up).
 *    Archive them here so they don't get re-dispatched on every boot.
 *  - Reset any `working` status left by a daemon that died mid-turn (no
 *    worker is alive to drive the turn forward).
 *  - Reconcile each agent's JSONL against the blocks table once (FIX_FORWARD
 *    1.3). No live tail-watcher; live writes flow through worker IPC.
 *  - For long-lived agents (orchestrator/builder/helper/bare) with non-empty
 *    inboxes, dispatch a fresh turn so the pending mail isn't stranded.
 */
async function recoverAgents(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const daemonPort = resolveDaemonPort(cfg);
  const jsonlAgents: RecoveryAgent[] = [];
  // Clear any stale `compacting_since` left by a daemon that died
  // mid-compaction: no worker is alive to emit the `compacting` done frame,
  // and no compaction is in flight until the SDK re-signals on resume. Without
  // this, the dashboard would reconstruct a permanent "Compacting context…"
  // indicator from the orphaned flag after a restart — the very scenario this
  // feature exists to fix, inverted.
  const clearedCompacting = await registry.clearStaleCompacting();
  if (clearedCompacting > 0) {
    logger.log("info", "agent.recovery.clear-stale-compacting", { count: clearedCompacting });
  }
  for (const a of await registry.listAgents()) {
    // Heal-on-boot: a builder whose worktree was already removed cannot
    // run another turn. If we don't archive it here, the eligibility
    // check below would happily re-dispatch (sending it into the
    // missing-worktree void) every boot, and the dashboard would see a
    // ghost "working" agent forever. The migration to "archived" only
    // catches rows whose status was literally "killed" — agents that
    // were raced into "idle" by the pre-F1-A exit handler slip through
    // and land here.
    // FRI-2080: a container-owned workspace is a volume at `/workspace` inside
    // a builder container. The daemon cannot see it, so `existsSync` would be
    // false for every one of them and this rule would archive every
    // containerised Builder on sight. "I cannot see it" and "it is gone" are
    // different facts; only the second one means the Builder is broken.
    if (
      a.type === "builder" &&
      a.status !== "archived" &&
      "worktreePath" in a &&
      a.worktreePath &&
      isDaemonOwnedWorkspace(await registry.getWorkspaceOwner(a.name)) &&
      !existsSync(a.worktreePath)
    ) {
      logger.log("info", "agent.recovery.archive-orphan", {
        agent: a.name,
        worktreePath: a.worktreePath,
      });
      // FRI-145 M4: route through the machine's archive Transition (the single
      // writer of `agents.status`). `lifecycle.archiveAgent` reads the ticketId
      // from the row, closes the linked ticket (happens-before the terminal
      // write — AC #6: "agent archived: abandoned" closes the orphan's ticket),
      // then writes `archived` via a Transition on the agent-keyed queue. No
      // direct `registry.archiveAgent` + fire-and-forget closeTicketForArchive
      // here anymore — both are folded into the one Transition.
      await archiveAgent(a.name, { reason: "abandoned" });
      continue;
    }
    if (a.status === "working") {
      logger.log("info", "agent.recovery.reset-working", { agent: a.name });
      // FRI-145 M4: route the working→idle reset through the machine's
      // projection Transition rather than calling registry.setStatus directly.
      await setAgentProjection(a.name, "idle");
    }
    const cwd = await registry.workingDirectoryFor(a);
    if (a.sessionId) {
      jsonlAgents.push({
        agentName: a.name,
        sessionId: a.sessionId,
        workingDirectory: cwd,
      });
    }

    if (a.type !== "scheduled" && a.status !== "archived") {
      const pending = await mailInbox(a.name);
      if (pending.length > 0) {
        const modelCfg = resolveModelForRole(cfg, a.type);
        const turnId = `t_${randomUUID()}`;
        logger.log("info", "agent.recovery.drain-mail", {
          agent: a.name,
          pending: pending.length,
        });
        try {
          const intent = pending.map((m) => m.body).join("\n\n");
          const mailPrompt = buildMailPrompt(a.name, pending);
          const { body: dispatchBody, systemPrompt: finalSystemPrompt } = await buildDispatchPrompt(
            a,
            { kind: "mail", body: mailPrompt, intentText: intent },
          );
          dispatchTurn({
            agentName: a.name,
            options: {
              agentName: a.name,
              agentType: a.type,
              workingDirectory: cwd,
              systemPrompt: finalSystemPrompt,
              prompt: dispatchBody,
              turnId,
              model: modelCfg.name,
              thinking: modelCfg.thinking,
              effort: modelCfg.effort,
              resumeSessionId: a.sessionId ?? undefined,
              daemonPort,
              parentName: "parentName" in a ? (a.parentName ?? undefined) : undefined,
              mode: "long-lived",
            },
          });
        } catch (err) {
          logger.log("warn", "agent.recovery.dispatch-error", {
            agent: a.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  if (jsonlAgents.length > 0) {
    try {
      await recoverFromJsonl(jsonlAgents);
    } catch (err) {
      logger.log("warn", "agent.recovery.jsonl-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Rehydrate user blocks left at `status='queued'` by a previous daemon
 * lifetime (the dashboard's send queue persisted them; the worker never
 * got to dispatch them before the process died). Each block dispatches
 * via `dispatchTurn` with its original turn_id and the row's blockId —
 * the first one for an agent spawns the worker, subsequent ones for the
 * same agent land in `nextPrompts` FIFO. On dispatch the row flips to
 * `complete` with a fresh `ts` via `block_meta_update`, so the dashboard
 * unpins each queued bubble as it runs.
 *
 * Archived agents are skipped and their queued rows deleted — there's no
 * worker to send the prompt to, and leaving them in the table would
 * surface as ghost pinned bubbles on the dashboard forever.
 */
async function recoverQueuedTurns(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const queued = await listQueuedUserBlocks();
  if (queued.length === 0) return;
  const daemonPort = resolveDaemonPort(cfg);
  for (const block of queued) {
    const a = await registry.getAgent(block.agentName);
    if (!a || a.status === "archived") {
      logger.log("info", "queued-turn.recovery.skip", {
        agent: block.agentName,
        turnId: block.turnId,
        reason: a ? "archived" : "agent_missing",
      });
      await deleteBlockById(block.blockId);
      continue;
    }
    let text = "";
    let attachments: Array<{ sha256: string; filename: string; mime: string }> | undefined;
    try {
      const parsed = JSON.parse(block.contentJson) as {
        text?: unknown;
        attachments?: Array<{ sha256: string; filename: string; mime: string }>;
      };
      if (typeof parsed.text === "string") text = parsed.text;
      if (Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
        attachments = parsed.attachments;
      }
    } catch {
      logger.log("warn", "queued-turn.recovery.parse-error", {
        agent: block.agentName,
        turnId: block.turnId,
      });
      await deleteBlockById(block.blockId);
      continue;
    }
    if (!text.trim() && !attachments) {
      await deleteBlockById(block.blockId);
      continue;
    }
    const { body: dispatchBody, systemPrompt: finalSystemPrompt } = await buildDispatchPrompt(a, {
      kind: "user_chat",
      userText: text,
    });
    const queuedCwd = await registry.workingDirectoryFor(a);
    const modelCfg = resolveModelForRole(cfg, a.type);
    try {
      dispatchTurn({
        agentName: a.name,
        options: {
          agentName: a.name,
          agentType: a.type,
          workingDirectory: queuedCwd,
          systemPrompt: finalSystemPrompt,
          prompt: dispatchBody,
          attachments,
          turnId: block.turnId,
          model: modelCfg.name,
          thinking: modelCfg.thinking,
          effort: modelCfg.effort,
          resumeSessionId: a.sessionId ?? undefined,
          daemonPort,
          parentName: "parentName" in a ? (a.parentName ?? undefined) : undefined,
          // FRI-156 follow-up (SEV-0): a recovered queued block is an
          // INTERACTIVE user turn the dashboard persisted while the daemon was
          // down. It must run `long-lived` so the agent responds — a
          // scheduled-type agent dispatched `one-shot` short-circuits the
          // worker loop and the user's message silently vanishes. Gate on the
          // block source (these are user_chat blocks), not the agent type.
          mode: "long-lived",
          turnSource: block.source ?? "user_chat",
        },
        userBlockId: block.blockId,
      });
      logger.log("info", "queued-turn.recovery.dispatch", {
        agent: a.name,
        turnId: block.turnId,
      });
    } catch (err) {
      logger.log("warn", "queued-turn.recovery.error", {
        agent: a.name,
        turnId: block.turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Close the Postgres pool on shutdown. Postgres manages its own WAL —
 * no explicit checkpoint needed (Postgres autovacuum + bgwriter handle
 * it). This is fire-and-forget; the shutdown timer below caps wait time.
 */
/** Reload vault cache when CLI bumps `secrets/.generation`. */
function startSecretsGenerationWatch(): void {
  let lastGen = readGeneration();
  const reload = async (): Promise<void> => {
    const gen = readGeneration();
    if (gen === lastGen) return;
    lastGen = gen;
    clearSecretsCache();
    clearFridayConfigCache();
    await unlockVault(true);
    loadFridayConfig();
    logger.log("info", "secrets.generation.reload", { generation: gen });
  };
  if (!existsSync(GENERATION_PATH)) return;
  watchFile(GENERATION_PATH, { interval: 2000 }, () => {
    void reload();
  });
}

function flushDb(): void {
  void closeDb().catch((err: unknown) => {
    logger.log("warn", "db.close.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
}

// Node 15+ defaults to terminating the process on an unhandled promise
// rejection. The daemon owns long-lived listeners and async worker IPC
// pipes that don't always propagate failures back through awaited
// boundaries — a stray rejection from a child callback or LISTEN handler
// would otherwise kill the daemon with no log at all (tmux session
// vanishes, last log line is whatever happened before the rejection).
//
// Log with the rejection's stack so the underlying bug is fixable, but
// don't exit: a single misbehaved subsystem shouldn't take the daemon
// down. `uncaughtException` is a different beast — the runtime state is
// unsafe to continue in, so log and exit 1.
process.on("unhandledRejection", (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.log("error", "daemon.unhandled-rejection", {
    message: err.message,
    stack: err.stack,
    promise: String(promise),
  });
  posthog.captureException(err, DISTINCT_ID, { source: "unhandledRejection" });
});
process.on("uncaughtException", (err) => {
  logger.log("error", "daemon.uncaught-exception", {
    message: err.message,
    stack: err.stack,
  });
  posthog.captureException(err, DISTINCT_ID, { source: "uncaughtException" });
  process.exit(1);
});

main().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.log("error", "daemon.fatal", { message: error.message });
  posthog.captureException(error, DISTINCT_ID, { source: "main" });
  void posthog.shutdown().catch(() => {});
  process.exit(1);
});
