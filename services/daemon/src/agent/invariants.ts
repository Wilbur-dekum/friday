/**
 * Continuous invariant auditor. Boot recovery reconciles drift at
 * startup, but state can also diverge mid-run — a filesystem write
 * deletes a worktree out from under us, a worker crashes without firing
 * its exit handler, an SSE replay confuses the dashboard's local model
 * (PR D). Boot-only healing means "wait until next restart"; this
 * auditor catches it within `AUDIT_INTERVAL_MS` and self-corrects.
 *
 * Each tick checks every registered agent for known impossible states.
 * The single source of truth for each invariant is named explicitly in
 * the rule so future contributors don't have to guess which side wins.
 *
 * Cheap by design: read-only over the agent list, file-existence stats,
 * one in-memory Map lookup per agent. Safe to run every minute even on
 * a cold laptop.
 */

import { existsSync } from "node:fs";
import { logger } from "../log.js";
import * as registry from "./registry.js";
import { isDaemonOwnedWorkspace } from "./workspace.js";
import { archiveAgent, healAgentStatus, isAgentLive, setAgentProjection } from "./lifecycle.js";

const AUDIT_INTERVAL_MS = 60_000;

let interval: NodeJS.Timeout | undefined;

/**
 * Start the auditor. Idempotent — calling twice is a no-op.
 *
 * Source-of-truth rules currently checked:
 *
 * 1. **Builder worktree presence** — for any builder whose `worktreePath`
 *    is set: the dir must exist OR the agent must be archived. The
 *    filesystem is authoritative. A builder without a worktree can't
 *    run another turn (the SDK's cwd would be missing), so this is an
 *    impossible state and we archive instead of letting it leak into
 *    mail-recovery dispatches.
 *
 * 2. **`status=working` ⇒ live map has the agent** — the live worker
 *    map is authoritative for runtime status. A row marked working
 *    without a corresponding worker is a zombie; demote to idle so the
 *    sidebar reads truthfully and the next dispatch forks fresh.
 *
 * Add new invariants here as we identify drift modes. Each rule should
 * be cheap, idempotent, and name its source of truth in a comment so
 * the reader doesn't have to guess.
 */
export function startInvariantAuditor(): NodeJS.Timeout | undefined {
  if (interval) return interval;
  interval = setInterval(() => {
    void audit().catch((err: unknown) => {
      logger.log("warn", "invariant.audit.error", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, AUDIT_INTERVAL_MS);
  interval.unref();
  // Run one pass at start so we don't have to wait the full interval
  // after a restart to catch boot-recovery's blind spots.
  void audit().catch((err: unknown) => {
    logger.log("warn", "invariant.audit.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return interval;
}

export function stopInvariantAuditor(): void {
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
}

/**
 * One audit pass. Exported for testability — tests drive `audit()`
 * directly instead of waiting on the interval.
 *
 * Rule precedence: terminal states (archive) beat transient ones
 * (demote/heal). A row that violates multiple rules in one pass is
 * archived rather than incrementally healed — a half-fixed row that
 * still triggers Rule 1 next tick wastes work.
 */
export async function audit(): Promise<{
  archived: string[];
  demoted: string[];
  healed: string[];
}> {
  const archived: string[] = [];
  const demoted: string[] = [];
  const healed: string[] = [];
  for (const a of await registry.listAgents()) {
    // Rule 1: builder worktree presence. Filesystem is the source of
    // truth — if the dir is gone, the agent can't function and the
    // registry row was lying.
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
      logger.log("warn", "invariant.archive-orphan", {
        agent: a.name,
        worktreePath: a.worktreePath,
        previousStatus: a.status,
      });
      // FRI-145 M4: route through the machine's archive Transition (the single
      // writer of `agents.status`) instead of calling registry.archiveAgent
      // directly. `lifecycle.archiveAgent` closes the linked ticket
      // happens-before the terminal `archived` write and tears down any live
      // worker after the Transition resolves.
      await archiveAgent(a.name, { reason: "abandoned" });
      // Phase 5: SSE retirement — Zero replicates the agent row's
      // status transition; no `agent_lifecycle` event needed.
      archived.push(a.name);
      continue;
    }

    // Rule 2: working ⇒ live. The live worker map is the source of
    // truth for runtime activity. A row marked working with no worker
    // is a zombie. Demote to idle so the next dispatch forks fresh
    // instead of trying to send a `prompt` IPC to a non-existent child.
    if (a.status === "working" && !isAgentLive(a.name)) {
      logger.log("warn", "invariant.demote-zombie-working", {
        agent: a.name,
      });
      // FRI-145 M4: route the zombie-demote through the machine's projection
      // Transition (the single writer) rather than calling registry.setStatus
      // directly.
      await setAgentProjection(a.name, "idle");
      // Phase 5: `agent_status` SSE retired — Zero replicates the
      // setStatus UPDATE reactively.
      demoted.push(a.name);
      continue;
    }

    // Rule 3 (FRI-113 / ADR-031): FSM type-status invariant.
    // The gate at `registry.setStatus` prevents new violations;
    // this rule heals rows that arrived at an illegal (type, status)
    // through paths the gate cannot cover — direct psql writes,
    // pre-FSM data, future code that bypasses the registry. The
    // canonical case is `orchestrator` rows stuck at `archived` from
    // before this ADR landed. The heal still uses the privileged
    // unchecked path under the hood (the FSM matrix forbids
    // `archived → idle` for anyone but `unarchiveAgent`), but FRI-145
    // M4 routes it through the machine's `heal` Transition so the auditor
    // is no longer an independent writer of `agents.status` — the
    // Turn-state machine is the single writer.
    if (isIllegalRestingState(a.type, a.status)) {
      const target = "idle" as const;
      logger.log("warn", "invariant.heal.illegal-resting-state", {
        agent: a.name,
        type: a.type,
        from: a.status,
        to: target,
      });
      await healAgentStatus(a.name, target, { clearArchiveReason: true });
      healed.push(a.name);
    }
  }
  if (archived.length || demoted.length || healed.length) {
    logger.log("info", "invariant.audit.summary", {
      archived,
      demoted,
      healed,
    });
  }
  return { archived, demoted, healed };
}

/**
 * Same as the FSM check, but answering "is this row in a state it is
 * legally allowed to be in *as a resting/observed state*?" Orchestrator
 * rows stuck at `archived` are the canonical illegal-resting case
 * because no transition into `archived` is allowed for `orchestrator`.
 */
function isIllegalRestingState(type: AgentType, status: AgentStatus): boolean {
  if (type === "orchestrator" && status === "archived") return true;
  return false;
}

type AgentStatus = import("@friday/shared").AgentStatus;
type AgentType = import("@friday/shared").AgentType;
