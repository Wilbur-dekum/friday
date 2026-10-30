import { mkdirSync } from "node:fs";
import { eq, isNotNull } from "drizzle-orm";
import {
  type AgentEntry,
  type AgentStatus,
  type AgentType,
  type ArchiveReason,
  agentWorkingDir,
  getDb,
  schema,
} from "@friday/shared";
import { captureFor } from "../posthog.js";
import { logger } from "../log.js";
import type { WorkspaceOwner } from "./workspace.js";

/**
 * FRI-113: status state machine. Every write to `agents.status` flows
 * through `setStatus` below, which checks the (type, current, next)
 * triple against the matrix defined here. Illegal transitions throw
 * `IllegalTransitionError` — see ADR-031.
 *
 * Reading rules:
 *   - Same-status writes (e.g. idle→idle) are no-ops, never illegal.
 *   - `archived` is terminal; the only escape is `unarchiveAgent`, which
 *     uses the privileged `_setStatusUnchecked` helper.
 *   - Orchestrators cannot reach `archived` from any state — this closes
 *     the "friday alive but archived" class of bug surfaced in the
 *     2026-05-22 grill.
 *   - `archive_requested` is in the DB check constraint
 *     (`schema.ts:97`) but NOT yet in the TS `AgentStatus` union
 *     (`agents.ts:5-10`). The intermediate value is written by the
 *     Zero mutator path; the daemon's LISTEN handler flips it to
 *     `archived` immediately. The matrix below now codifies both
 *     edges (`* → archive_requested` for non-orchestrators via the
 *     mutator and `archive_requested → archived` for the listener).
 */
type StatusTransitionTable = Readonly<Record<AgentStatus, ReadonlyArray<AgentStatus>>>;

const COMMON_TRANSITIONS: StatusTransitionTable = {
  idle: ["working", "stalled", "archived", "archive_requested"],
  working: ["idle", "stalled", "archived", "archive_requested"],
  stalled: ["idle", "working", "archived", "archive_requested"],
  // Transient state written by the Zero mutator path; the listener
  // immediately flips to `archived`. The only legal next state.
  archive_requested: ["archived"],
  // Terminal. Only `unarchiveAgent` can leave this status, and it uses
  // the privileged unchecked path. Nothing else may.
  archived: [],
};

const ORCHESTRATOR_TRANSITIONS: StatusTransitionTable = {
  idle: ["working", "stalled"],
  working: ["idle", "stalled"],
  stalled: ["idle", "working"],
  // The orchestrator-not-archivable invariant: no edge into `archived`
  // OR `archive_requested` from anywhere. If a row ever lands at
  // either, the auditor's rule #3 heals it back to `idle` via the
  // unchecked path.
  archive_requested: [],
  archived: [],
};

const TRANSITIONS_BY_TYPE: Readonly<Record<AgentType, StatusTransitionTable>> = {
  orchestrator: ORCHESTRATOR_TRANSITIONS,
  builder: COMMON_TRANSITIONS,
  helper: COMMON_TRANSITIONS,
  scheduled: COMMON_TRANSITIONS,
  bare: COMMON_TRANSITIONS,
  // FRI-16: planners follow the same archiving rules as helpers/builders.
  planner: COMMON_TRANSITIONS,
};

export type IllegalTransitionCode =
  | "ORCHESTRATOR_NOT_ARCHIVABLE"
  | "INVALID_STATUS_TRANSITION"
  | "MISSING_ARCHIVE_REASON"
  | "AGENT_NOT_FOUND";

export class IllegalTransitionError extends Error {
  readonly code: IllegalTransitionCode;
  readonly from: AgentStatus | null;
  readonly to: AgentStatus;
  readonly type: AgentType | null;
  readonly agentName: string;

  constructor(opts: {
    code: IllegalTransitionCode;
    from: AgentStatus | null;
    to: AgentStatus;
    type: AgentType | null;
    name: string;
  }) {
    super(
      `IllegalTransitionError[${opts.code}]: agent="${opts.name}" type=${opts.type ?? "?"} from=${opts.from ?? "?"} to=${opts.to}`,
    );
    this.name = "IllegalTransitionError";
    this.code = opts.code;
    this.from = opts.from;
    this.to = opts.to;
    this.type = opts.type;
    this.agentName = opts.name;
  }
}

/**
 * Pure predicate over the FSM matrix. Exported so the auditor can ask
 * "is this (type, status) the legal resting set for this agent?" without
 * doing a no-op write to provoke the gate.
 */
export function isLegalTransition(type: AgentType, from: AgentStatus, to: AgentStatus): boolean {
  if (from === to) return true;
  const allowed = TRANSITIONS_BY_TYPE[type][from] ?? [];
  return allowed.includes(to);
}

export async function listAgents(): Promise<AgentEntry[]> {
  const db = getDb();
  const rows = await db.select().from(schema.agents);
  return rows.map(rowToEntry);
}

export async function getAgent(name: string): Promise<AgentEntry | null> {
  const db = getDb();
  const rows = await db.select().from(schema.agents).where(eq(schema.agents.name, name)).limit(1);
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export interface RegisterInput {
  name: string;
  type: AgentType;
  parentName?: string;
  worktreePath?: string;
  branch?: string;
  ticketId?: string;
  appId?: string;
  /**
   * ADR-022: free-text rationale recorded when a non-orchestrator (a
   * Builder or Helper) spawned this agent. The daemon's spawn handler
   * requires this to be non-empty for builder/helper callers; orchestrator
   * spawns leave it null. Watchdog refork preserves the prior row's value
   * so the audit trail survives recovery (FRI-102 AC #11).
   */
  spawnReason?: string | null;
  /**
   * Free-form metadata persisted to the `meta_json` column. For builders this
   * carries `{ repo }` — the original `worktree.repo` the workspace was created
   * from — so the archive route can resolve the correct git dir (the bare
   * mirror, in remote mode) deterministically WITHOUT depending on the
   * in-workspace marker the SDK may have already deleted (PR-271 BLOCKER 1).
   */
  metaJson?: Record<string, unknown> | null;
}

export async function registerAgent(input: RegisterInput): Promise<AgentEntry> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(schema.agents)
    .values({
      name: input.name,
      type: input.type,
      status: "idle",
      parentName: input.parentName ?? null,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? null,
      ticketId: input.ticketId ?? null,
      appId: input.appId ?? null,
      spawnReason: input.spawnReason ?? null,
      metaJson: input.metaJson ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.agents.name,
      set: { status: "idle", updatedAt: now },
    });
  const got = await getAgent(input.name);
  if (!got) throw new Error(`registerAgent: row vanished after insert: ${input.name}`);
  captureFor(null, "agent_registered", {
    agent_name: got.name,
    agent_type: got.type,
    parent_name: input.parentName ?? null,
    has_worktree: !!input.worktreePath,
    has_ticket: !!input.ticketId,
    has_app: !!input.appId,
  });
  return got;
}

/**
 * Seed the orchestrator agent row on daemon boot if it doesn't exist yet.
 *
 * Insert-only and idempotent: when the orchestrator already exists this is a
 * no-op that NEVER touches its status/session/history (unlike a bare
 * `registerAgent`, whose conflict-update would flip `status` to idle). That
 * matters because the orchestrator is otherwise registered lazily — only when
 * the first message is dispatched to it (`dispatch-listener.ts`). On a brand-new
 * install that leaves the `agents` table with no orchestrator row until the user
 * sends a message, so the dashboard's always-present orchestrator chat 404s on
 * `GET /api/agents/<name>` (→ 502 through the proxy) and the transcript hangs on
 * the loading skeleton forever (`applyZeroBlocks` bails on the missing agents
 * row before it can clear `loadingInitial`). Seeding here makes the first-ever
 * open render an empty chat instead.
 */
export async function ensureOrchestratorAgent(name: string): Promise<void> {
  if (await getAgent(name)) return;
  await registerAgent({ name, type: "orchestrator" });
}

/**
 * Read the raw `spawn_reason` column for an agent. AgentEntry is the
 * user-facing wire shape and deliberately omits this field, so the
 * watchdog refork (and any future audit consumer) reads it directly via
 * this helper. Returns null when the agent doesn't exist or was spawned
 * by the orchestrator (no reason required, column stays null).
 */
export async function getSpawnReason(name: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ spawnReason: schema.agents.spawnReason })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0]?.spawnReason ?? null;
}

/**
 * Read the original source repo a builder's workspace was created from
 * (`meta_json.repo`). The archive route passes this to `archiveWorkspace` so
 * teardown resolves the correct git dir (the bare mirror, in remote mode)
 * deterministically — see PR-271 BLOCKER 1. Returns null when absent (older
 * builder rows created before this was persisted; non-builders).
 */
export async function getWorkspaceRepo(name: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ metaJson: schema.agents.metaJson })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  const meta = rows[0]?.metaJson as { repo?: unknown } | null | undefined;
  return meta && typeof meta.repo === "string" && meta.repo.length > 0 ? meta.repo : null;
}

/**
 * Read who owns a builder's workspace directory (`meta_json.workspaceOwner`).
 *
 * FRI-2080. Returns null when absent — every builder row written before this
 * is daemon-owned, which is what `isDaemonOwnedWorkspace` defaults to.
 */
export async function getWorkspaceOwner(name: string): Promise<WorkspaceOwner | null> {
  const db = getDb();
  const rows = await db
    .select({ metaJson: schema.agents.metaJson })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  const meta = rows[0]?.metaJson as { workspaceOwner?: unknown } | null | undefined;
  return meta?.workspaceOwner === "container" || meta?.workspaceOwner === "daemon"
    ? meta.workspaceOwner
    : null;
}

/**
 * Set the owning app id for an existing agent row. Used by the apps
 * installer when rebinding a previously-unaffiliated or other-app agent
 * to a new owner. Pass `null` to clear.
 */
export async function setAppId(name: string, appId: string | null): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ appId, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

/**
 * Read the raw `app_id` for an agent. Returns null when the agent
 * doesn't exist or isn't owned by an app.
 */
export async function getAppId(name: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ appId: schema.agents.appId })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0]?.appId ?? null;
}

/**
 * FRI-113: privileged unchecked status write. Bypasses the FSM gate.
 * Only legitimate callers are (a) `unarchiveAgent` (terminal-state
 * escape, which the FSM matrix deliberately does not permit) and (b)
 * the invariants auditor rule #3 (healing FSM violations writes status
 * transitions the matrix forbids — e.g. orchestrator-archived → idle).
 *
 * Internal to this module. Do NOT export. Callers that need the gated
 * path use `setStatus`; callers that need the unchecked path live in
 * this file or call `unarchiveAgent`.
 */
async function _setStatusUnchecked(
  name: string,
  status: AgentStatus,
  opts: { archiveReason?: ArchiveReason | null } = {},
): Promise<void> {
  const db = getDb();
  const setShape: {
    status: AgentStatus;
    updatedAt: Date;
    archiveReason?: ArchiveReason | null;
    compactingSince?: Date | null;
  } = { status, updatedAt: new Date() };
  if (opts.archiveReason !== undefined) {
    setShape.archiveReason = opts.archiveReason;
  }
  // Backstop for the durable compaction-in-progress flag: compaction only
  // happens DURING a turn (status === 'working'), so any transition OUT of
  // 'working' (→ idle/stalled/archived) must null `compacting_since` in the
  // SAME write. This guarantees a worker that dies mid-compaction — and never
  // emits the `compacting` done frame that primarily clears the flag (see
  // `setCompactingSince`, called from the lifecycle's `compacting-status`
  // handler) — can't wedge the indicator on. A 'working' target is left alone
  // so it never races an in-flight compaction flag set during the same turn.
  if (status !== "working") {
    setShape.compactingSince = null;
  }
  await db.update(schema.agents).set(setShape).where(eq(schema.agents.name, name));
}

/**
 * Privileged unchecked write for the invariants auditor's rule #3.
 * Exported so `invariants.ts` can heal FSM violations the gate forbids
 * (e.g. orchestrator-archived → idle). NO other caller should reach
 * for this — it is the explicit escape hatch documented in ADR-031.
 *
 * The shape forces callers to acknowledge the escape: the `auditorHeal`
 * key in the opts object is the marker future readers grep for to find
 * every privileged use site.
 */
export async function _auditorHealStatusUnchecked(
  name: string,
  status: AgentStatus,
  opts: {
    auditorHeal: true;
    clearArchiveReason?: boolean;
  },
): Promise<void> {
  void opts.auditorHeal; // shape-only marker
  await _setStatusUnchecked(name, status, {
    archiveReason: opts.clearArchiveReason ? null : undefined,
  });
}

/**
 * FRI-113: gated status write. Validates the (type, current, next)
 * triple against the FSM matrix. Throws `IllegalTransitionError` on
 * any invalid transition; writes `archive_reason` atomically when the
 * target is `archived`.
 *
 * `opts.archiveReason` is REQUIRED when `status === "archived"`. Any
 * other target ignores the field.
 */
export async function setStatus(
  name: string,
  status: AgentStatus,
  opts: { archiveReason?: ArchiveReason } = {},
): Promise<void> {
  const row = await getAgent(name);
  if (!row) {
    // Matches pre-FSM behavior: a bare UPDATE that matches no rows is
    // a silent no-op. Production callers should never reach this with
    // a real-but-missing agent (the live worker map and dispatch
    // surface keep them aligned), but worker IPC handlers and test
    // doubles occasionally fire setStatus against an unregistered
    // name. Throwing would be a hard regression; log-and-no-op keeps
    // the new contract narrow to actual transition violations.
    return;
  }
  if (!isLegalTransition(row.type, row.status, status)) {
    const code: IllegalTransitionCode =
      row.type === "orchestrator" && status === "archived"
        ? "ORCHESTRATOR_NOT_ARCHIVABLE"
        : "INVALID_STATUS_TRANSITION";
    throw new IllegalTransitionError({
      code,
      from: row.status,
      to: status,
      type: row.type,
      name,
    });
  }
  if (status === "archived" && !opts.archiveReason) {
    throw new IllegalTransitionError({
      code: "MISSING_ARCHIVE_REASON",
      from: row.status,
      to: status,
      type: row.type,
      name,
    });
  }
  await _setStatusUnchecked(name, status, {
    archiveReason: status === "archived" ? opts.archiveReason : undefined,
  });
}

export async function setSession(name: string, sessionId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ sessionId, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

export async function clearSession(name: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ sessionId: null, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

/**
 * Set or clear the durable compaction-in-progress flag for an agent.
 * Pass a `Date` (the compaction start instant) on the SDK's `compacting`
 * start frame, and `null` on the matching done frame. Replicated via Zero so
 * the dashboard's "Compacting context…" indicator reconstructs on
 * reload/reconnect. This is the PRIMARY writer; `_setStatusUnchecked` clears
 * it as a backstop whenever the agent leaves `working`, and boot reconcile
 * clears any stale value. Independent of `status` (compaction runs while the
 * agent stays `working`), so it does NOT go through the FSM-gated status door.
 */
export async function setCompactingSince(name: string, since: Date | null): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ compactingSince: since, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

/**
 * Boot reconcile: clear every stale `compacting_since`. A daemon that died
 * mid-compaction leaves the flag set with no worker alive to emit the done
 * frame; on the next boot no compaction is in flight until the SDK re-signals,
 * so any lingering value is stale by definition. Returns the number of rows
 * cleared (for the boot log). The per-agent `working → idle` reset already
 * nulls the flag via the `_setStatusUnchecked` backstop; this is the
 * belt-and-braces sweep that also catches a row whose status drifted from its
 * flag. NOT scoped to status so it heals any inconsistency.
 */
export async function clearStaleCompacting(): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(schema.agents)
    .set({ compactingSince: null, updatedAt: new Date() })
    .where(isNotNull(schema.agents.compactingSince))
    .returning({ name: schema.agents.name });
  return rows.length;
}

/**
 * Transition an agent to `archived` with a required reason. The reason
 * is persisted to the `archive_reason` column atomically with the
 * status write. Goes through the FSM gate, so orchestrator-archive
 * attempts throw `IllegalTransitionError` with code
 * `ORCHESTRATOR_NOT_ARCHIVABLE`.
 */
export async function archiveAgent(name: string, opts: { reason: ArchiveReason }): Promise<void> {
  await setStatus(name, "archived", { archiveReason: opts.reason });
  captureFor(null, "agent_archived", {
    agent_name: name,
    archive_reason: opts.reason,
  });
}

/**
 * Reverse of `archiveAgent`. Flips an `archived` row back to `idle`,
 * preserving `sessionId` so previously-recorded chat history continues
 * into the un-archived agent. Used by the apps installer on reinstall.
 *
 * Uses the privileged unchecked write because the FSM matrix has no
 * `archived → idle` edge (terminal state). This is the ONLY non-auditor
 * caller that bypasses the gate.
 */
export async function unarchiveAgent(name: string): Promise<void> {
  const row = await getAgent(name);
  if (!row) throw new Error(`unarchiveAgent: no agent named "${name}"`);
  if (row.status !== "archived") {
    throw new Error(`unarchiveAgent: "${name}" is not archived (status=${row.status})`);
  }
  await _setStatusUnchecked(row.name, "idle", { archiveReason: null });
  captureFor(null, "agent_unarchived", { agent_name: name });
}

/**
 * Hard-remove a registry row. Reserved for stub rows that have no history
 * (e.g. a scheduled-agent stub created by `schedule_upsert` whose schedule
 * was deleted before the first fire). The general policy is preserve-over-
 * delete; callers must verify the row has no session and no blocks first.
 */
export async function deleteAgent(name: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.agents).where(eq(schema.agents.name, name));
}

function rowToEntry(r: typeof schema.agents.$inferSelect): AgentEntry {
  const base = {
    name: r.name,
    type: r.type as AgentType,
    status: r.status as AgentStatus,
    sessionId: r.sessionId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  switch (base.type) {
    case "orchestrator":
      return { ...base, type: "orchestrator" } as AgentEntry;
    case "builder":
      return {
        ...base,
        type: "builder",
        parentName: r.parentName!,
        worktreePath: r.worktreePath!,
        branch: r.branch ?? undefined,
        ticketId: r.ticketId ?? undefined,
      } as AgentEntry;
    case "helper":
      return {
        ...base,
        type: "helper",
        parentName: r.parentName!,
      } as AgentEntry;
    case "scheduled":
      return {
        ...base,
        type: "scheduled",
        taskPrompt: "",
        paused: false,
      } as AgentEntry;
    case "bare":
      return {
        ...base,
        type: "bare",
        parentName: r.parentName ?? undefined,
      } as AgentEntry;
    case "planner":
      // FRI-16: planners are parented sub-agents like helpers, but the
      // parent is optional (PlannerEntry) — cwd inheritance falls back to
      // the per-agent home when the parent is missing or archived.
      return {
        ...base,
        type: "planner",
        parentName: r.parentName ?? undefined,
      } as AgentEntry;
  }
}

/**
 * Resolve the cwd a worker should run under for a given agent. Branch order:
 *
 *   0. Planners → their parent's cwd (FRI-16; resolved recursively through
 *      `parentName`, bounded — see below). A planner under a builder runs
 *      inside that builder's worktree (read-mostly, middle-path guarded);
 *      under the orchestrator it runs in the orchestrator's home. When the
 *      parent is archived or missing, fall through to the planner's own
 *      per-agent home (never read a dead worktree).
 *   1. Builders → their git worktree (workspace containment, Constitution rule).
 *   2. App-installed agents → `~/.friday/apps/<id>/` (the app owns its dir).
 *   3. Everyone else → `~/.friday/agents/<name>/` (FRI-61 per-agent home).
 *
 * Centralized so every dispatch path (initial create, mail-driven,
 * watchdog refork, recovery) agrees. Pre-FRI-61 the fallback was
 * `process.cwd()`, which silently broke session resume when the daemon's
 * launch cwd changed (e.g. dev-tree → Homebrew). The SDK encodes cwd
 * into the JSONL transcript path, so any divergence vs. previous fires
 * makes the prior session unreachable.
 *
 * AgentEntry doesn't carry `appId` (it's not part of the user-facing wire
 * shape), so we re-read it via `getAppId(a.name)` when the appDir branch
 * needs to fire.
 */
export async function workingDirectoryFor(a: AgentEntry): Promise<string> {
  return workingDirectoryForBounded(a, 0);
}

/**
 * FRI-16: hard ceiling on the planner parent-inheritance walk. A corrupted
 * planner→planner parent cycle would otherwise recurse forever; at the
 * bound we log `registry.cwd.cycle-bounded` and fall through to the
 * current entry's own per-agent home.
 */
const CWD_PARENT_HOP_BOUND = 8;

async function workingDirectoryForBounded(a: AgentEntry, hops: number): Promise<string> {
  // Branch 0 (FRI-16): planner inherits the parent's cwd.
  if (a.type === "planner" && a.parentName) {
    if (hops >= CWD_PARENT_HOP_BOUND) {
      logger.log("warn", "registry.cwd.cycle-bounded", {
        agent: a.name,
        parent: a.parentName,
        hops,
      });
      // Fall through to the per-agent home below.
    } else {
      const parent = await getAgent(a.parentName);
      if (parent && parent.status !== "archived") {
        return workingDirectoryForBounded(parent, hops + 1);
      }
      // Parent missing or archived — fall through to the per-agent home
      // below (don't read a dead worktree).
    }
  }
  // Leaf resolution (worktree → app → per-agent home) is shared with
  // backup/restore via `agentWorkingDir`, so the three can never disagree about
  // where an agent's Claude transcript lives (the divergence that silently
  // dropped app-agent sessions from migration bundles).
  const worktreePath = "worktreePath" in a ? a.worktreePath : null;
  const appId = await getAppId(a.name);
  const dir = agentWorkingDir({ name: a.name, worktreePath, appId });
  // The per-agent home (non-worktree, non-app) must exist before the worker
  // chdir's into it; worktrees and app dirs already exist on disk.
  if (!worktreePath && !appId) mkdirSync(dir, { recursive: true });
  return dir;
}
