/**
 * Worker lifecycle: forks per-agent processes, owns the IPC channel, and
 * routes events to the daemon's eventBus. Each forked worker can be either
 * one-shot (scheduled) or long-lived (orchestrator/builder/helper/bare).
 *
 * Long-lived semantics:
 *   - The first turn arrives via spawnTurn() with the initial prompt.
 *   - Subsequent turns arrive via dispatchTurn(); if the agent is already
 *     live we send a `prompt` IPC instead of forking.
 *   - turn-complete from the worker emits `turn_done` and inserts usage,
 *     but does NOT shut the worker down — the worker drives its own loop
 *     (drain mail, idle, repeat).
 *   - If a new prompt arrives while the worker is mid-turn, we queue it
 *     parent-side and flush on the next turn-complete so events from the
 *     in-flight turn keep their original turn_id.
 */

import { eq } from "drizzle-orm";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentType } from "@friday/shared";
import { getDb, loadConfig, schema } from "@friday/shared";
import {
  claimPendingSession,
  getTurnAuthorUserId,
  insertUsage,
  insertUsageRequests,
  updateBlock,
} from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { sanitizedProcessEnvForChild } from "../shell-env.js";
import { logger } from "../log.js";
import { captureFor } from "../posthog.js";
import { type ArchiveReason } from "@friday/shared";
import { closeTicketForArchive } from "../services/ticket-close.js";
import { notify } from "../notifications/notify.js";
import * as registry from "./registry.js";
import {
  open as bsOpen,
  append as bsAppend,
  close as bsClose,
  cancel as bsCancel,
  tearDownTurn as bsTearDownTurn,
  __endTurnForArchivedHardExit,
  IllegalBlockTransitionError,
} from "./block-stream.js";
import {
  recordError as bsRecordError,
  recordCompactionMarker as bsRecordCompactionMarker,
} from "./block-injectors.js";
import { appContextForAgent } from "../apps/installer.js";
import { noteForceKillForRespawn, noteTurnComplete } from "../comms/respawn-orphan-mail.js";
import { recoverFromJsonl } from "./jsonl-recovery.js";
import { enqueueTransition, enqueueTransitionResult } from "./transition-queue.js";
import {
  apply as applyTransition,
  applyAdmin,
  buildTurnFinalization,
  projectStatus,
  FORCED_ABORT_ERROR_PAYLOAD,
  FSM_VIOLATION_ERROR_PAYLOAD,
  STALE_TURN_ERROR_PAYLOAD,
  WEDGE_ERROR_PAYLOAD,
  type AdminTransition,
  type StatusProjection,
  type Transition,
  type TurnContext,
  type TurnState,
} from "./turn-state-machine.js";
import { executeIntents, type TurnStatePorts } from "./turn-state-ports.js";
import {
  profileInputsFor,
  removeProfile,
  sandboxExecAvailable,
  writeProfile,
} from "./sandbox-profile.js";
import type {
  WorkerCommand,
  WorkerEvent,
  WorkerPromptCommand,
  WorkerSpawnOptions,
} from "./worker-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "worker.js");

/**
 * FRI-148 §5.C: per-turn threshold for `IllegalBlockTransitionError`
 * occurrences before the daemon force-kills the worker as FSM-desynced.
 * Each violation is logged at L1 (`block.transition.illegal`); the threshold
 * trip emits L2 (`block.transition.illegal.threshold`) and triggers
 * `forceKillStuckWorker(reason: "fsm-violation")`. Reset at every dispatch
 * boundary alongside `blocksThisTurn`.
 */
const FSM_VIOLATION_THRESHOLD = 3;

export interface ExitInfo {
  sessionId?: string;
  durationMs: number;
  /** Whether the parent observed a turn-complete before the exit. */
  completed: boolean;
  status: "complete" | "aborted" | "error";
}

export interface LiveWorker {
  child: ChildProcess;
  /** Process-group id of the worker. With `detached: true` this equals
   * child.pid, which lets `kill(-pgid)` reap descendants the worker leaked
   * (e.g. `(sleep 200 &); disown`). In-memory only — not persisted, since
   * boot recovery deliberately doesn't reap by stored pgid (PID-reuse risk
   * on a long daemon downtime). */
  pgid: number;
  agentName: string;
  agentType: AgentType;
  model: string;
  /** Parent agent's name (helper/builder/bare spawned by another agent).
   *  Undefined for the orchestrator. FRI-127 §5: drives the mail-back
   *  backstop's "did this turn mail the parent" detection. */
  parentName?: string;
  /** Active turn id; updated on each prompt dispatch. */
  turnId: string;
  sessionId?: string;
  /** The cwd the SDK runs under (== JSONL transcript dir). For builders this
   * is the worktree path; for in-process types it's the daemon's cwd. The
   * JSONL mirror needs this to compute the right ~/.claude/projects file. */
  workingDirectory: string;
  abortRequested: boolean;
  lastHeartbeat: number;
  /** Wall-clock start of the *current* turn, for usage duration. Undefined
   *  between turns — set on prompt dispatch (sendPrompt + the first
   *  child.once("message", …) callback for the spawn-fresh path) and cleared
   *  at every turn-end exit (`turn-complete`, `error`, `forceKillStuckWorker`).
   *  The watchdog's `if (isCurrentGeneration(w) && w.turnStart)` gate relies on
   *  this field being falsy between turns so a 4h idle period does not get
   *  arithmetic'd against a stale timestamp from a long-completed turn
   *  (FRI-110). */
  turnStart: number | undefined;
  /** Wall-clock start of the worker process; used for one-shot duration. */
  spawnedAt: number;
  /** Wall-clock of the most recent block-stop. The turn-stall timer uses
   * this as the "model is making progress" signal — heartbeats don't count
   * because a stuck SDK still emits them. */
  lastBlockStop: number;
  /**
   * FRI-145 M3: the authoritative Turn state (CONTEXT.md → "Agent turn
   * lifecycle"). `idle | working | aborting | force-killed`. The
   * Turn-state machine is the only writer (via `setWorkerStatus`). `status`
   * below is a DERIVED Status projection of this field — never authored
   * independently, so the old "`w.status` and `w.turnStart` are parallel
   * sources of the same truth" drift hazard is closed.
   */
  turnState: TurnState;
  /**
   * DERIVED Status projection (`idle | working`). Always equals
   * `projectStatus(w.turnState)` — written only by `setWorkerStatus`
   * alongside `turnState`, never on its own. Read by the watchdog stall
   * check, `abortTurn`'s working-gate, `dispatchTurn`'s idle/busy branch,
   * and `peekLiveWorker`. (M5 adds the `stalled` Status projection on the
   * agents row; the in-memory Turn state has no resting `stalled` value.)
   */
  status: "idle" | "working";
  /**
   * FIFO of prompts that arrived while a previous turn was in flight. Drained
   * on each turn-complete so per-turn events stay tagged with the correct
   * turn_id.
   */
  nextPrompts: WorkerPromptCommand[];
  /** The prompt currently dispatched to the worker (set by `sendPrompt`,
   *  cleared on turn-end). `drainLiveWorker` prepends this to the drained
   *  queue so a stall-kill redelivers the in-flight message on the fresh
   *  worker — it was already popped off `nextPrompts` and sent, so without
   *  this field it would be silently dropped (FRI-58). */
  activePrompt?: WorkerPromptCommand;
  mode: "long-lived" | "one-shot";
  /** FRI-156 follow-up: DB `blocks.source` of the block that originated the
   *  CURRENT turn. Set at every dispatch boundary (spawn-fresh first turn +
   *  `sendPrompt`). Read by the turn-state machine's zero-block carve-out so a
   *  `user_chat`-origin turn that produced zero content blocks emits a VISIBLE
   *  notice block instead of vanishing silently. Undefined for
   *  autonomous/system-origin turns. */
  turnSource?: string;
  /** Set by handleEvent on turn-complete; consumed by onExit. */
  lastExitStatus: "complete" | "aborted" | "error";
  completedAtLeastOnce: boolean;
  onExit?: (info: ExitInfo) => void;
  /** Stop force-kill safety net (FRI-12). When `abortTurn` fires, we
   *  schedule a 2s deadline; if the worker doesn't acknowledge the abort
   *  by then, `forceKillStuckWorker` finalizes the turn and SIGTERMs the
   *  process group. The deadline is cleared on any worker response
   *  (turn-complete, error, status-change) so a worker that aborted
   *  cleanly doesn't get killed on the way out. */
  abortDeadline?: NodeJS.Timeout;
  /** FRI-61 wedge detector: count of `block-start` IPCs observed on the
   *  current turn. Reset on every `turn-complete`/`error` and on
   *  `sendPrompt` (defense-in-depth for future re-orderings). */
  blocksThisTurn: number;
  /** FRI-148 §5.C: count of `IllegalBlockTransitionError` occurrences
   *  observed on the current turn (caught by `safeHandleEvent`). Each
   *  occurrence emits L1 `block.transition.illegal`; on reaching
   *  `FSM_VIOLATION_THRESHOLD` we emit L2
   *  `block.transition.illegal.threshold` and `forceKillStuckWorker` with
   *  `reason: "fsm-violation"`. Reset at every dispatch boundary
   *  (LiveWorker construction, spawn-fresh first turn, `sendPrompt`). */
  illegalTransitionsThisTurn: number;
  /** FRI-61 wedge detector: consecutive `turn-complete`/`error` events
   *  that arrived with `blocksThisTurn === 0`. The SDK iterator only
   *  produces zero content blocks when the model emitted nothing —
   *  observed on the 2026-05-20 wedge where SDK could not find the
   *  resume transcript and silently returned an empty `result`. Healthy
   *  turns always emit ≥1 block-start (`mail_close`-only responses
   *  produce 2: tool_use + tool_result). When the streak reaches
   *  `FRIDAY_WEDGE_THRESHOLD` (default 10), force-kill with
   *  `reason: "wedge"`. */
  zeroBlockTurnStreak: number;
  /** FRI-127 §5 mail-back backstop. Count of `mail_send` tool_use blocks
   *  targeting this worker's parent observed on the current turn. Incremented
   *  at block-stop (where the tool_use input — and thus `to` — is finalized,
   *  still well before `turn-complete`, closing the in-flight-mail race).
   *  Reset to 0 at the start of every turn. */
  mailSendToParentThisTurn: number;
  /** FRI-127 §5: set when this turn's no-mail-back miss triggered an
   *  Option-B re-dispatch (single-fire guard). A SECOND consecutive
   *  no-mail-back turn-complete falls through to Option C (structured warning
   *  + SSE + log streak) instead of looping. Reset to false on any turn that
   *  DID mail the parent. */
  noMailBackNudgedThisTurn: boolean;
  /** FRI-127 §5: count of consecutive no-mail-back turn-completes. Surfaces
   *  on the Option-C `worker.no-mail-back-streak` log + SSE event. */
  noMailBackStreak: number;
}

const live = new Map<string, LiveWorker>();

/**
 * Generation check (FRI-145 M2): a worker instance `w` is the *current*
 * Generation of its agent name iff it is still the live map's entry for that
 * name (`live.get(name) === w`). Identity-as-epoch — same-process pointer
 * comparison, no monotonic counter.
 *
 * Every teardown / Status-projection mutation gates on this. A Transition
 * arriving from a superseded Generation (a stale worker whose name has already
 * been re-`live.set` by a replacement, or already `live.delete`d by archive /
 * force-kill / refork) is a structural no-op: it must not delete the
 * replacement's entry, must not write a Status projection over the live
 * generation's, and must not re-finalize an already-finalized turn.
 *
 * This single rule replaces the two old hand-rolled LiveWorker flags — one
 * an intra-generation "already torn down, ignore late IPC" guard, the other a
 * cross-channel "refork owns the status write" guard (both documented in
 * CONTEXT.md → "Agent turn lifecycle"). Both were point guards against the
 * same underlying hazard: a superseded generation writing state. The teardown
 * paths (`forceKillStuckWorker`, `archiveAgent`, `forceWorkerRefork`)
 * synchronously `live.delete` up front, so the very next Generation check by
 * any racing path — re-entry, a late IPC Transition, or the `child.on("exit")`
 * handler — sees `live.get(name) !== w` and no-ops.
 */
function isCurrentGeneration(w: LiveWorker): boolean {
  return live.get(w.agentName) === w;
}

/**
 * SIGTERM (or SIGKILL) the entire process group of a worker. With
 * `detached:true` at fork time, the worker's pgid is the same as its pid,
 * and `process.kill(-pgid, sig)` reaches every descendant — including
 * `(sleep 200 &); disown` style leaks that wouldn't be caught by killing
 * the worker pid alone. Safe to call even when the group is already gone;
 * ESRCH is swallowed.
 *
 * Exported only so the integration test can drive it directly against a
 * real subprocess tree.
 */
export function killPgrp(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!pgid || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      logger.log("warn", "worker.pgrp.kill.fail", {
        pgid,
        signal,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Send a signal to every process in `pgid` EXCEPT the worker itself.
 * Used by `abortTurn` to kill in-flight tool subprocesses (the SDK CLI
 * subprocess + Bash et al. that it spawned) the instant Stop is pressed,
 * without taking down the worker — the worker stays alive long enough to
 * see the SDK iterator close, run its catch block (flushInflightBlocks),
 * and emit `turn-complete` cleanly. Returns the count of descendants
 * signaled, for log instrumentation + test assertion.
 *
 * Uses `pgrep -g <pgid>` to enumerate group members. Available on macOS
 * + Linux — matches Friday's deployment surface.
 *
 * Defensive: if pgrep is unavailable or returns nothing useful, return 0
 * and let the IPC + safety-net path do the work. Production correctness
 * does not depend on this helper succeeding; this is an aggressiveness
 * boost for the destructive-tool case.
 */
export function killPgrpDescendants(
  pgid: number,
  workerPid: number,
  signal: "SIGTERM" | "SIGKILL",
): number {
  if (!pgid || pgid <= 1 || !workerPid) return 0;
  const out = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
  if (out.status !== 0 || typeof out.stdout !== "string") return 0;
  const pids = out.stdout
    .trim()
    .split("\n")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 1 && n !== workerPid);
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") {
        logger.log("warn", "worker.descendant.kill.fail", {
          pgid,
          pid,
          signal,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return pids.length;
}

export interface SpawnTurnInput {
  agentName: string;
  options: WorkerSpawnOptions;
  /** Called when the worker process exits. Used by scheduled to write last-run.md. */
  onExit?: (info: ExitInfo) => void;
  /** Called when the worker could not be started at all — `spawnTurn` threw
   *  before the `child.on("exit")` handler was registered (e.g. the pre-fork
   *  `registry.setStatus` / `writeProfile` / `spawn()` itself throws). Because
   *  `dispatchTurn` is fire-and-forget, such a throw is swallowed by its
   *  `.catch`; without this hook a caller that opened external bookkeeping (the
   *  scheduler's `schedule_runs` row, ADR-024) would never learn the fork never
   *  happened and the row would leak `running` forever. Distinct from `onExit`,
   *  which only fires once a `child` object exists. Best-effort; invoked at most
   *  once and never together with `onExit`. */
  onSpawnError?: (err: unknown) => void;
  /** Present only when the caller recorded the user block as `status='queued'`
   *  (the worker was already busy at POST time). Propagates to the queued
   *  `WorkerPromptCommand` so `sendPrompt` knows to re-stamp the row on
   *  dispatch. Omitted for immediate dispatch (`recordUserBlock` already
   *  wrote `status='complete'`). */
  userBlockId?: string;
}

/**
 * Forks a fresh worker for `agentName` and starts the initial turn. Throws
 * if the agent already has a live worker — the caller should use
 * `dispatchTurn` instead, which handles both fork and reuse.
 */
export async function spawnTurn(input: SpawnTurnInput): Promise<void> {
  if (live.has(input.agentName)) {
    throw new Error(`agent "${input.agentName}" already has a live worker`);
  }
  await registry.setStatus(input.agentName, "working");

  // FRI-78: auto-populate per-app context for agents owned by an
  // installed app. Centralized here so every dispatch path (api, mail,
  // schedule, watchdog refork) inherits the wiring; callers don't need
  // to remember to set it.
  if (!input.options.appContext) {
    const ctx = await appContextForAgent(input.agentName);
    if (ctx) {
      input.options = { ...input.options, appContext: ctx };
    }
  }

  // M2: builders run under `sandbox-exec` so the kernel denies writes to
  // credentials, dotfiles, LaunchAgents, Keychains, and Friday's own state
  // even if the M1 PreToolUse hook misses (e.g. a PATH-wrapped binary that
  // the regex didn't spot). Non-builder agents run with the daemon's
  // permissions because their working directory is the daemon repo and
  // they legitimately need broader filesystem access.
  const sandboxStatus = sandboxExecAvailable();
  const wrapWithSandbox = input.options.agentType === "builder" && sandboxStatus.available;
  let profilePath: string | undefined;
  if (wrapWithSandbox) {
    profilePath = writeProfile(input.agentName, profileInputsFor(input.options.workingDirectory));
  }

  logger.log("info", "worker.fork", {
    agent: input.agentName,
    type: input.options.agentType,
    mode: input.options.mode,
    turnId: input.options.turnId,
    resumeSessionId: input.options.resumeSessionId ?? null,
    sandboxed: wrapWithSandbox,
    sandboxReason: wrapWithSandbox ? "ok" : sandboxStatus.reason,
  });

  // env block shared between worker spawn paths.
  //
  // We deliberately do NOT set NPM_CONFIG_IGNORE_SCRIPTS / equivalent here.
  // pnpm v9+ already requires explicit opt-in via `pnpm.onlyBuiltDependencies`
  // (or `pnpm approve-builds`) before any postinstall fires — a blanket
  // disable would break legitimate flows like Husky `prepare` hooks and
  // repo-vetted native-module builds. M1's package-manager rule keeps npm /
  // yarn behind `--ignore-scripts` (those run all postinstalls by default);
  // for pnpm we trust the repo's own gating.
  // FRI-150 (pivot, ADR-037): the worker captures its own shell env at
  // entry — no daemon-side forwarding. Workers see process.env from the
  // daemon (post-loadFridayConfig refactor that's clean of secrets) plus
  // CI / COREPACK_* overrides, then run `$SHELL -ilc` to layer the
  // user's interactive shell env on top of that.
  // FRI-2012: sanitized, not raw. `sanitizedProcessEnvForChild()` already
  // existed as the INPUT gate for the shell-capture child but was never
  // applied here, so the worker — which is where untrusted repo code actually
  // runs — inherited everything. Measured in the compose stack, that included
  // FRIDAY_ADMIN_DATABASE_URL, the superuser connection string.
  const env = {
    ...sanitizedProcessEnvForChild(),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    CI: "1",
  };

  // M5: ulimit wrapper for CPU + nofile. The bash prelude applies the
  // rlimits before exec'ing node so the limits are in effect from worker.js
  // line 0. `exec "$@"` passes positional args through unmodified, avoiding
  // shell quoting of paths.
  //
  // Defaults: 1h CPU (catches honest infinite loops without hitting on
  // legitimate long Builder turns; wall-clock is enforced by the M5 turn
  // stall watchdog separately), 4096 file descriptors (generous).
  // Overridable via env for emergency tuning.
  const cpuLimit = process.env.FRIDAY_WORKER_CPU_LIMIT ?? "3600";
  const nofileLimit = process.env.FRIDAY_WORKER_NOFILE_LIMIT ?? "4096";
  const ULIMIT_PRELUDE = `ulimit -t ${cpuLimit}; ulimit -n ${nofileLimit}; exec "$@"`;

  const spawnOpts: SpawnOptions = {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // M4: detached makes the worker its own process-group leader so we can
    // SIGTERM the whole group on destroy. Without this, a leaked descendant
    // (`(sleep 200 &); disown`) survives the worker exit.
    detached: true,
    env,
  };

  // Both paths terminate in `bash -c 'ulimit …; exec "$@"' -- node <execArgv> WORKER`.
  // The triple chain (sandbox-exec → bash → node) preserves NODE_CHANNEL_FD
  // through both exec()s; verified by sandbox-profile-kernel.test.ts and
  // lifecycle-spawn-ipc.test.ts.
  //
  // We forward `process.execArgv` so loader hooks on the parent (`--import
  // tsx/esm` under `tsx watch`, `--experimental-vm-modules`, etc.) reach the
  // worker too — otherwise the worker's plain `node WORKER_PATH` can't
  // resolve `.ts` sources in dev. `fork()` does this implicitly; we have to
  // do it ourselves now that we go through bash.
  const nodeArgs = [...process.execArgv, WORKER_PATH];
  const child: ChildProcess = wrapWithSandbox
    ? spawn(
        "/usr/bin/sandbox-exec",
        [
          "-f",
          profilePath!,
          "/bin/bash",
          "-c",
          ULIMIT_PRELUDE,
          "--",
          process.execPath,
          ...nodeArgs,
        ],
        spawnOpts,
      )
    : spawn("/bin/bash", ["-c", ULIMIT_PRELUDE, "--", process.execPath, ...nodeArgs], spawnOpts);
  // With detached:true the child is the leader of its own process group, so
  // pgid === child.pid. If fork failed pid will be undefined; we keep 0 as
  // a sentinel so killPgrp can skip safely.
  const pgid = child.pid ?? 0;
  const w: LiveWorker = {
    child,
    pgid,
    agentName: input.agentName,
    agentType: input.options.agentType,
    model: input.options.model,
    parentName: input.options.parentName,
    turnId: input.options.turnId,
    workingDirectory: input.options.workingDirectory,
    abortRequested: false,
    lastHeartbeat: Date.now(),
    // FRI-110: `turnStart` is set only when a turn actually dispatches —
    // here (the first turn after fork) it is set inside the
    // `child.once("message", …)` callback below, immediately before the
    // `start` IPC ships. For subsequent turns, `sendPrompt` sets it. A
    // worker sitting idle between turns has `turnStart === undefined`, which
    // is what keeps the stale-turn watchdog from arithmetic-ing against a
    // stale value after a 4h idle.
    turnStart: undefined,
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    // FRI-145 M3: `turnState` is authoritative; `status` is its derived
    // projection. A freshly-forked worker is about to run its first turn.
    turnState: "working",
    status: "working",
    nextPrompts: [],
    mode: input.options.mode,
    turnSource: input.options.turnSource,
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    onExit: input.onExit,
    blocksThisTurn: 0,
    illegalTransitionsThisTurn: 0,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
  };
  live.set(input.agentName, w);

  // Agent-keyed Transition queue (FRI-145 M1): serialize IPC events so block
  // start→delta→stop writes land in order even though each block-stream handler
  // is async. Node's `on("message")` callback is sync; the queue chains promises
  // so the next Transition doesn't dispatch until the previous one's DB writes
  // commit. Keying by agent NAME (not this worker instance, as the old
  // closure-local `ipcChain` did) means a stale generation's exit Transition and
  // the next generation's spawn/IPC Transitions for the same name still apply in
  // strict arrival order. Fire-and-forget: the queue swallows + logs Transition
  // errors so one bad event can't wedge the chain.
  // Single-fire guard for `onExit`. The `exit` and `error` events can both
  // fire for one fork (e.g. a spawn that emits `error` and then `exit`), or
  // `error` can fire with NO matching `exit` (ENOENT / EMFILE — the child
  // never actually started). The scheduler's terminal-row write must run
  // exactly once, so whichever event arrives first owns the `onExit` call.
  let onExitFired = false;
  const fireOnExit = (status: ExitInfo["status"]): void => {
    if (onExitFired) return;
    onExitFired = true;
    if (!w.onExit) return;
    try {
      w.onExit({
        sessionId: w.sessionId,
        durationMs: Date.now() - w.spawnedAt,
        completed: w.completedAtLeastOnce,
        status,
      });
    } catch (err) {
      logger.log("warn", "worker.onexit.error", {
        agent: input.agentName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  child.on("message", (raw: unknown) => {
    void enqueueTransition(input.agentName, () => safeHandleEvent(w, raw));
  });
  // A failed `spawn()` (ENOENT — bad interpreter path, EMFILE — fd exhaustion)
  // surfaces asynchronously as an `error` event and frequently emits NO `exit`
  // event, so the `child.on("exit")` teardown below never runs. Without this
  // handler the worker stays in the live map and any external bookkeeping the
  // caller opened (the scheduler's `schedule_runs` row, ADR-024) leaks
  // `running` forever. Demote the Generation and fire `onExit` as `error`.
  child.on("error", (err) => {
    logger.log("warn", "worker.spawn.error", {
      agent: input.agentName,
      message: err instanceof Error ? err.message : String(err),
    });
    if (profilePath) removeProfile(profilePath);
    if (isCurrentGeneration(w)) live.delete(input.agentName);
    fireOnExit("error");
  });
  child.on("exit", (code, signal) => {
    logger.log("info", "worker.exit", {
      agent: input.agentName,
      code,
      signal,
    });
    // M2: clean up the per-worker SBPL profile. Best-effort; the file is
    // owner-only and idempotent so a leak is harmless beyond the disk space.
    // Always runs — the profile file belongs to THIS worker process whether
    // or not it is still the current Generation.
    if (profilePath) removeProfile(profilePath);

    // FRI-145 M2 Generation no-op: a superseded Generation's exit does NO
    // teardown. If `forceKillStuckWorker` / `archiveAgent` / `forceWorkerRefork`
    // already `live.delete`d this name (and possibly a replacement Generation
    // already `live.set` it), then `live.get(name) !== w`: that other path
    // already owns the finalize, the live-map delete, and the Status-projection
    // write. Re-running them here would (a) `live.delete` the REPLACEMENT
    // Generation's entry — the latent name-keyed-delete clobber the old
    // unconditional `live.delete(input.agentName)` carried — and (b) double-
    // finalize an already-closed turn. The Generation guard closes both.
    // `onExit` (below) still runs either way: one-shot bookkeeping is
    // per-process, not per-Generation.
    if (isCurrentGeneration(w)) {
      // FRI-145 M5: demote this Generation up front so any racing IPC / abort-
      // deadline / archive Transition sees `live.get(name) !== w` and no-ops,
      // then drive the self-heal through the Turn-state machine's `hard-exit`
      // Transition (fire-and-forget — the exit handler is sync but the machine
      // is async under ADR-023). The machine finalizes any streaming blocks as
      // `error`, publishes the previously-MISSING `turn_done{status:"error"}`
      // (Bug #2: a SIGTERM/OOM/crash mid-turn used to finalize blocks + reset
      // the row but never publish the terminal event, so the dashboard's
      // inflight pin stayed up forever despite the agent being dispatchable),
      // and heals the row to `idle`. The forced-refork case is handled by the
      // Generation guard above: `forceWorkerRefork` `live.delete`s before the
      // drain so this exit fires for a superseded Generation and skips here.
      live.delete(input.agentName);
      void (async () => {
        try {
          await finalizeHardExit(w);
        } catch {
          // finalizeHardExit logs its own errors; swallow so the respawn
          // check still runs.
        }
        // FRI-154: after the hard-exit teardown, queue a respawn if this
        // agent still has unprocessed mail in its inbox. Anti-loop gated;
        // dead-letters after `RESPAWN_MAX_ATTEMPTS` failed cycles.
        await noteForceKillForRespawn(input.agentName, { code, signal });
      })();
    } else {
      // FRI-154: superseded Generation — `forceKillStuckWorker` /
      // `archiveAgent` / `forceWorkerRefork` already owned the teardown.
      // Archive sets `agents.status='archived'`, which the respawn function
      // skips. `forceWorkerRefork` `live.set`s a replacement before this
      // exit fires (or `live.delete`s and the agent isn't live), so
      // `noteForceKillForRespawn`'s `isAgentLive` early-out covers the
      // refork case. The only path that legitimately wants a respawn here
      // is `forceKillStuckWorker(reason: "abort"|"stale"|"wedge"|"fsm")`
      // followed by orphan mail in the inbox.
      void noteForceKillForRespawn(input.agentName, { code, signal });
    }
    // Phase 5: `agent_lifecycle` SSE retired — Zero replicates the
    // agents row UPDATE so the dashboard sees the status drop on
    // worker exit. `fireOnExit` is single-fire — if a preceding `error`
    // event already closed out this fork, this is a no-op.
    const status: ExitInfo["status"] = w.completedAtLeastOnce
      ? w.lastExitStatus
      : code === 0
        ? "complete"
        : "error";
    fireOnExit(status);
  });

  // Send `start` after the worker emits its first `ready`. Inject
  // user-configured MCP servers from `~/.friday/config.json` here so callers
  // don't each have to remember to wire them; tests can pre-set
  // `input.options.userMcpServers` to bypass the disk read.
  child.once("message", () => {
    const userMcpServers = input.options.userMcpServers ?? loadConfig().mcpServers ?? [];
    // FRI-110: stamp the turn-start clock at the *actual* turn dispatch
    // (not at fork) so the stale-turn watchdog measures from when the
    // worker began the turn — not from when the worker process came up
    // (which could be milliseconds before, but conceptually is "no turn
    // is live"). Symmetric with `sendPrompt` for subsequent turns.
    w.turnStart = Date.now();
    // FRI-148 §5.C: a fresh turn starts with no observed FSM violations.
    // Initialization at LiveWorker construction covers the cold-start case;
    // pinning it here keeps the three dispatch boundaries (construction,
    // spawn-fresh first turn, sendPrompt) structurally parallel.
    w.illegalTransitionsThisTurn = 0;
    send(child, {
      type: "start",
      options: { ...input.options, userMcpServers },
    });
  });

  // Mirror sendPrompt's queued-block bookkeeping for the fork-fresh path:
  // when a queued user block triggers a worker spawn (rehydration or POST
  // against an offline worker), the block is sitting at status='queued'
  // with the POST-time ts. Re-stamp it now so the dashboard's pinned
  // bubble unpins as the worker comes up.
  restampQueuedUserBlock(input.agentName, input.options.turnId, input.userBlockId);
  // Phase 5: `agent_lifecycle:spawn` SSE retired — Zero replicates
  // the agents row's new status (idle → working) reactively to the
  // dashboard sidebar.
  eventBus.publish({
    v: 1,
    type: "turn_started",
    turn_id: input.options.turnId,
    agent: input.agentName,
    ts: Date.now(),
  });
}

/**
 * Smart entrypoint for "send a turn to this agent". Forks a fresh worker if
 * the agent isn't live; otherwise sends a `prompt` IPC (or queues it if the
 * worker is mid-turn).
 */
export function dispatchTurn(input: SpawnTurnInput): void {
  const existing = live.get(input.agentName);
  if (!existing) {
    // Fire-and-forget the async spawn — the worker fork is itself
    // asynchronous; the registry write + appContext lookup that newly
    // need awaiting (ADR-023) don't change the contract that callers
    // see "the turn has been accepted" the moment dispatchTurn returns.
    // Errors during the async setup are logged inside spawnTurn.
    void spawnTurn(input).catch((err: unknown) => {
      logger.log("warn", "spawn.async-setup-error", {
        agent: input.agentName,
        message: err instanceof Error ? err.message : String(err),
      });
      // The fork never happened (threw before `child.on("exit")` was wired),
      // so `onExit` will never fire. Let the caller close out any external
      // bookkeeping it opened (the scheduler's `schedule_runs` row). Best-
      // effort: a throw here must not escape the fire-and-forget dispatch.
      try {
        input.onSpawnError?.(err);
      } catch (cbErr) {
        logger.log("warn", "spawn.on-spawn-error.callback-error", {
          agent: input.agentName,
          message: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    });
    return;
  }
  const promptCmd: WorkerPromptCommand = {
    prompt: input.options.prompt,
    attachments: input.options.attachments,
    turnId: input.options.turnId,
    // FRI-127 §6: prefer the LIVE worker's session id over the POST/NOTIFY-time
    // capture. `input.options.resumeSessionId` was read synchronously when the
    // dispatch was queued; by the time a mid-turn-queued prompt drains, the
    // just-finished turn has moved the session on (the `session-update` IPC
    // updates `existing.sessionId`). Resuming the stale value drops the queued
    // prompt into an obsolete session JSONL and surfaces as "Agent didn't
    // respond". Only fall back to the parent-provided value on first-turn-after-
    // spawn, where `existing.sessionId` is undefined.
    resumeSessionId: existing.sessionId ?? input.options.resumeSessionId ?? undefined,
    allowedToolsOverride: input.options.allowedToolsOverride,
    turnSource: input.options.turnSource,
    userBlockId: input.userBlockId,
  };
  if (existing.status === "idle") {
    sendPrompt(existing, promptCmd);
  } else {
    existing.nextPrompts.push(promptCmd);
    // FIX_FORWARD 2.4: signal the worker so it can break at the next SDK
    // iteration boundary. The worker emits `turn-complete` on the break;
    // our existing turn-complete handler then pops nextPrompts and sends
    // the queued prompt forward via the normal `prompt` IPC.
    send(existing.child, { type: "prompts-pending" });
    logger.log("info", "worker.prompt.queued", {
      agent: input.agentName,
      turnId: promptCmd.turnId,
      depth: existing.nextPrompts.length,
      // FRI-72: capture daemon's view of why this turn queued. If
      // `existingStatus` is "working" but the prior turn-complete never
      // landed, this is the canonical fingerprint of the stuck-status
      // bug (Seth's "queued for a fraction of a second" symptom).
      existingStatus: existing.status,
      existingTurnId: existing.turnId,
    });
  }
}

/**
 * Flip a queued user block to `status='complete'` with a fresh `ts` and
 * announce it on SSE so the dashboard unpins the bubble and re-sorts it
 * inline. ADR-004 ordering: the row UPDATE commits before the SSE event
 * is published (the column-level seq matching dance retired in FRI-125).
 *
 * Called from both `sendPrompt` (queue-drain → existing live worker) and
 * `spawnTurn` (rehydrated queue or POST against an offline worker forces
 * a fresh fork). Safe to call with `undefined` blockId — no-op.
 */
function restampQueuedUserBlock(
  agentName: string,
  turnId: string,
  userBlockId: string | undefined,
): void {
  if (!userBlockId) return;
  const dispatchTs = Date.now();
  // Phase 5: the legacy `block_meta_update` SSE event is retired —
  // Zero replicates the row UPDATE to the dashboard's blocks slice
  // reactively. (FRI-125 retired the per-row `last_event_seq` bump
  // alongside the column itself.)
  void updateBlock(userBlockId, {
    status: "complete",
    ts: dispatchTs,
  }).catch((err: unknown) => {
    logger.log("warn", "queued-block.meta-update.error", {
      agent: agentName,
      turnId,
      blockId: userBlockId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * FRI-145 M3: the single writer of the authoritative Turn state. Sets
 * `w.turnState` and derives `w.status` from it via `projectStatus` — `status`
 * is never authored independently, so it can no longer drift from the Turn
 * state (or, transitively, from `w.turnStart`). Accepts either a full
 * {@link TurnState} (the machine's vocabulary: `aborting` / `force-killed`) or
 * a resting projection (`idle` / `working`) at call sites that predate the
 * machine.
 *
 * FRI-72 instrumentation: every transition flows through here so the daemon log
 * captures who changed it and why. The "queued for a fraction" symptom (daemon
 * thinks the worker is still working long after its last turn) points at a
 * missing or out-of-order status update; this trace makes the misordering
 * visible.
 */
function setWorkerStatus(w: LiveWorker, next: TurnState, source: string): void {
  const projected = projectStatus(next);
  if (w.turnState !== next || w.status !== projected) {
    logger.log("info", "worker.status.transition", {
      agent: w.agentName,
      prev: w.turnState,
      next,
      projected,
      source,
      turnId: w.turnId,
    });
  }
  w.turnState = next;
  w.status = projected;
}

/**
 * FRI-145 M3: build the production ports bag for the Turn-state machine. The
 * machine (`turn-state-machine.ts`) returns intents; `executeIntents`
 * (`turn-state-ports.ts`) runs them against THESE collaborators. Unit tests
 * pass fakes instead — the machine itself does no I/O.
 *
 * `registry.setStatus` stays the only DB door (ADR-031); it is reached only via
 * a `set-status` intent executed here. `forceKill` is the wedge escalation —
 * the machine signals it, the prod port invokes `forceKillStuckWorker`.
 */
function makeProdPorts(): TurnStatePorts<LiveWorker> {
  return {
    setStatus: (name, status) => registry.setStatus(name, status),
    archive: (name, opts) => registry.archiveAgent(name, opts),
    heal: (name, status, opts) =>
      registry._auditorHealStatusUnchecked(name, status, {
        auditorHeal: true,
        clearArchiveReason: opts.clearArchiveReason,
      }),
    closeTicket: (opts) => closeTicketForArchive(opts),
    publish: (event) => eventBus.publish(event),
    blockStream: {
      tearDownTurn: (w, status) => bsTearDownTurn(w, status),
    },
    blockInjector: {
      recordError: (w, payload) => bsRecordError(w, payload),
    },
    recoverFromJsonl: (inputs) => recoverFromJsonl(inputs),
    insertUsage: (row) => insertUsage(row),
    insertUsageRequests: (rows) => insertUsageRequests(rows),
    // PR #145: attribute the turn analytics event to the turn's author
    // (resolved from its user block; null → service actor). The resolve is a
    // DB read, kept here in the port so the machine stays pure. Self-guarded:
    // an attribution failure must never break turn completion.
    captureTurnEvent: async (turnId, event, properties) => {
      try {
        const author = await getTurnAuthorUserId(turnId);
        captureFor(author, event, properties);
      } catch (err) {
        logger.log("warn", "posthog.attribute.error", {
          turnId,
          event,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    sendPrompt: (w, p) => sendPrompt(w, p),
    forceKill: (w, opts) => forceKillStuckWorker(w, opts),
    logWarn: (event, payload) => logger.log("warn", event, payload),
    logInfo: (event, payload) => logger.log("info", event, payload),
  };
}

const prodPorts = makeProdPorts();

/**
 * Project a {@link LiveWorker} onto the read-only {@link TurnContext} the pure
 * machine consumes. The machine never sees the full LiveWorker bag — only the
 * turn-boundary-relevant fields — so it can't reach for state it has no
 * business reading.
 */
function toTurnContext(w: LiveWorker): TurnContext {
  return {
    agentName: w.agentName,
    agentType: w.agentType,
    model: w.model,
    parentName: w.parentName,
    turnId: w.turnId,
    sessionId: w.sessionId,
    workingDirectory: w.workingDirectory,
    abortRequested: w.abortRequested,
    turnStart: w.turnStart,
    blocksThisTurn: w.blocksThisTurn,
    turnSource: w.turnSource,
    zeroBlockTurnStreak: w.zeroBlockTurnStreak,
    mailSendToParentThisTurn: w.mailSendToParentThisTurn,
    noMailBackNudgedThisTurn: w.noMailBackNudgedThisTurn,
    noMailBackStreak: w.noMailBackStreak,
    nextPrompts: w.nextPrompts,
  };
}

/** The dependency bag for one machine `apply` — captured at call time so the
 *  wedge threshold honors a live `FRIDAY_WEDGE_THRESHOLD` override and the
 *  clock/uuid are the real ones. (`wedgeThreshold` is a hoisted function
 *  declaration defined in the watchdog section below.) */
function MACHINE_DEPS(): { wedgeThreshold: number; now: number; uuid: () => string } {
  return { wedgeThreshold: wedgeThreshold(), now: Date.now(), uuid: randomUUID };
}

/**
 * Drive one Transition through the machine: apply the pure function, write the
 * machine's in-memory mutations + derived Status projection onto the live
 * worker, pop the queue for a `send-next`/`mailback-nudge` (so the dispatched
 * prompt is removed from `nextPrompts` exactly as the old `.shift()` did), then
 * execute the intents against the ports bag.
 *
 * The Turn-state machine is the only application-level writer of
 * `agents.status` — the `set-status` intent inside `intents` is the single DB
 * door. Returns nothing; the caller awaits it inside the on-chain handler.
 */
async function runTransition(
  w: LiveWorker,
  transition: Transition,
  ports: TurnStatePorts<LiveWorker> = prodPorts,
): Promise<void> {
  const result = applyTransition(toTurnContext(w), transition, MACHINE_DEPS());

  // Apply the in-memory mutations the machine decided (its own bookkeeping —
  // per-turn resets, streak bumps, lastExitStatus). These are not external
  // side effects; the `set-status` projection write is an INTENT.
  const m = result.mutations;
  if ("turnStart" in m) w.turnStart = m.turnStart;
  if ("activePrompt" in m) w.activePrompt = m.activePrompt;
  if (m.blocksThisTurn !== undefined) w.blocksThisTurn = m.blocksThisTurn;
  if (m.zeroBlockTurnStreak !== undefined) w.zeroBlockTurnStreak = m.zeroBlockTurnStreak;
  if (m.mailSendToParentThisTurn !== undefined)
    w.mailSendToParentThisTurn = m.mailSendToParentThisTurn;
  if (m.noMailBackNudgedThisTurn !== undefined)
    w.noMailBackNudgedThisTurn = m.noMailBackNudgedThisTurn;
  if (m.noMailBackStreak !== undefined) w.noMailBackStreak = m.noMailBackStreak;
  if (m.lastExitStatus !== undefined) w.lastExitStatus = m.lastExitStatus;
  if (m.completedAtLeastOnce !== undefined) w.completedAtLeastOnce = m.completedAtLeastOnce;

  // Project the derived Status onto the in-memory worker via the single writer.
  // (The DURABLE agents.status write is the `set-status` intent below.)
  setWorkerStatus(w, result.state, `machine.${transition.kind}`);

  // The machine's `send-next` / `mailback-nudge` intent carries the prompt it
  // chose; remove it from the queue so `sendPrompt` (run inside the intent)
  // dispatches it exactly once. `send-next` uses `nextPrompts[0]`; the nudge is
  // a synthetic prompt not in the queue.
  for (const intent of result.intents) {
    if (intent.kind === "send-next") {
      w.nextPrompts.shift();
    }
  }

  await executeIntents(w, result.intents, ports);
}

/**
 * FRI-145 M4: run one ADMINISTRATIVE Transition through the machine. The three
 * non-turn-boundary channels — archive, boot-recovery, auditor — route their
 * `agents.status` writes here so the Turn-state machine stays the single
 * application-level writer (the inviolate single-writer invariant). The pure
 * {@link applyAdmin} decides the Status projection + ordered intents; the
 * executor runs them against the ports bag (the same `set-status` /
 * `close-ticket` / `archive` / `heal` DB doors prod wires in {@link prodPorts}).
 *
 * Admin intents operate on an agent NAME, never on a live worker, so we pass a
 * name-only {@link PortWorker} stub — the block-stream / sendPrompt ports are
 * never reached by an admin transition's intents.
 *
 * If a live worker exists for this name it gets its in-memory Status projection
 * mirrored too (so a racing `peekLiveWorker` / watchdog sees the new resting
 * state), but the durable write is always the intent.
 */
async function runAdminTransition(
  name: string,
  transition: AdminTransition,
  ports: TurnStatePorts<LiveWorker> = prodPorts,
): Promise<void> {
  const result = applyAdmin(name, transition);
  // Mirror the projection onto a live worker if one is still resident. Archive
  // demotes the worker up front (live.delete before enqueue), so this only
  // fires for set-projection / heal on a still-live agent.
  const w = live.get(name);
  if (w && (result.projection === "idle" || result.projection === "working")) {
    setWorkerStatus(w, result.projection, `machine.admin.${transition.kind}`);
  }
  // The admin intents never touch the block-stream / sendPrompt ports, so a
  // name-only stub is sufficient as the executor's worker target.
  const stub = (w ?? { agentName: name, turnId: "" }) as LiveWorker;
  await executeIntents(stub, result.intents, ports);
}

/**
 * FRI-145 M4 archive channel. Every `archiveAgent` caller (REST endpoint,
 * archive LISTEN handler, apps uninstall, boot orphan sweep, auditor Rule 1)
 * funnels here so the terminal `archived` write is a Transition on the
 * agent-keyed queue — never a direct `registry.archiveAgent` outside the
 * machine.
 *
 * The non-status work sequences AROUND the Transition, preserving the original
 * structural ordering:
 *   1. Read `ticketId` from the row BEFORE the archive (so the closer reads the
 *      captured value, not a row a future refactor might null on archive). This
 *      ordering is pinned by `lifecycle-ticket-close.test.ts`.
 *   2. Demote the live worker's Generation (`live.delete`) up front so any
 *      racing IPC / exit / abort-deadline Transition is a Generation no-op and
 *      cannot write `idle` over the incoming `archived` (AC #17).
 *   3. Enqueue the archive Transition (result-bearing) and AWAIT it: the
 *      machine emits `close-ticket` THEN `archive`, so the ticket closes
 *      happens-before the terminal write (AC #6). The await surfaces the FSM
 *      gate's `IllegalTransitionError` (orchestrator-not-archivable) to the
 *      caller exactly as the pre-M4 direct call did.
 *   4. AFTER the Transition resolves, drain + tear down the worker (off the
 *      status-write critical section; V3 — never await a same-key enqueue from
 *      inside a Transition).
 */
export async function archiveAgent(
  agentName: string,
  opts: { reason: ArchiveReason },
): Promise<WorkerPromptCommand[]> {
  const w = live.get(agentName);
  // Capture ticketId BEFORE the archive Transition — defensive against a
  // future refactor that nulls the row's fields on archive. The closer reads
  // this captured value (pinned by lifecycle-ticket-close.test.ts).
  const agentRow = await registry.getAgent(agentName);
  const ticketId = agentRow && "ticketId" in agentRow ? (agentRow.ticketId ?? null) : null;
  // Demote this Generation up front so a racing IPC / exit / abort-deadline
  // Transition sees `live.get(name) !== w` and no-ops, and cannot write `idle`
  // over the `archived` projection this Transition is about to write.
  if (w) live.delete(agentName);
  // The archive Transition: close-ticket (happens-before) → archived write.
  // Result-bearing so the FSM gate's rejection reaches this awaiting caller.
  await enqueueTransitionResult(agentName, () =>
    runAdminTransition(agentName, { kind: "archive", reason: opts.reason, ticketId }),
  );
  // FRI-142 / ADR-048 producer seam #2 — builder_archive. A Builder finishing
  // or failing is an async machine→human event worth surfacing. Fire-and-forget
  // AFTER the archived projection lands; never blocks teardown. Only builders
  // (the "your branch is ready" case) raise it — bare/scheduled/helper archives
  // are routine lifecycle churn, not a notification.
  if (agentRow?.type === "builder") {
    void notify({
      type: "builder_archive",
      title: opts.reason === "completed" ? "A builder finished" : "A builder stopped",
      body: `${agentName} archived (${opts.reason}).`,
      // No per-builder route exists; land on the dashboard root.
      deepLink: "/",
    });
  }
  // Worker teardown sequences AFTER the status Transition resolves — off the
  // single-writer critical section (V3).
  if (!w) return [];
  return drainLiveWorker(w);
}

/**
 * FRI-145 M4 auditor heal channel. The invariants auditor's Rule 3 routes its
 * privileged force-set through the machine instead of calling
 * `registry._auditorHealStatusUnchecked` directly, so the auditor is no longer
 * an independent writer of `agents.status`. `registry._auditorHealStatusUnchecked`
 * stays for genuinely-out-of-band psql edits, but no in-process caller reaches
 * it except via this Transition.
 */
export async function healAgentStatus(
  agentName: string,
  target: StatusProjection,
  opts: { clearArchiveReason: boolean },
): Promise<void> {
  await enqueueTransition(agentName, () =>
    runAdminTransition(agentName, {
      kind: "heal",
      target,
      clearArchiveReason: opts.clearArchiveReason,
    }),
  );
}

/**
 * FRI-145 M4 projection channel for boot-recovery + auditor zombie-demote. A
 * gated `registry.setStatus` write that moves an agent to a resting projection
 * (`working→idle` on boot, zombie-demote `→idle`). Routed through the machine
 * so these channels are not independent `registry.setStatus` callers.
 */
export async function setAgentProjection(
  agentName: string,
  status: StatusProjection,
): Promise<void> {
  await enqueueTransition(agentName, () =>
    runAdminTransition(agentName, { kind: "set-projection", status }),
  );
}

/**
 * FRI-145 M5 stall channel. The per-agent watchdog (`watchdog.ts`) calls this
 * fire-and-forget when a working worker blows past its heartbeat budget. The
 * `stall` Transition projects `agents.status="stalled"` (the dashboard's
 * warn-colored dot) through the single-writer machine — restoring the producer
 * that was lost when the `agent_status` SSE was retired (Phase 5).
 *
 * V3 (the only deadlock/HOL guard): the watchdog NEVER awaits this inside its
 * tick loop. It enqueues onto the agent-keyed Transition queue and moves on, so
 * one stalled agent's queued status write can't head-of-line-block the watchdog
 * across every other agent. The enqueue keeps the single-writer invariant — the
 * watchdog does NOT call `registry.setStatus` directly.
 *
 * No-op when the agent isn't live (the worker already exited / was reforked):
 * there is no in-flight turn to flag and the row's resting projection is the
 * exit handler's concern, not the stall flag's.
 */
export async function stallAgent(agentName: string): Promise<void> {
  const w = live.get(agentName);
  if (!w) return;
  await enqueueTransition(agentName, () => {
    // Re-check the Generation inside the queued closure: by the time this runs
    // the worker may have been reforked / archived / completed its turn. A
    // superseded Generation must not write the durable `stalled` projection
    // over a live replacement's `working`/`idle` or a terminal `archived`.
    if (!isCurrentGeneration(w)) return Promise.resolve();
    return runTransition(w, { kind: "stall" });
  });
}

function sendPrompt(w: LiveWorker, p: WorkerPromptCommand): void {
  // FRI-127 §6: defensively re-resolve the resume session id at the moment we
  // actually drain the prompt. The queue-drain path (`nextPrompts.shift()`)
  // hands us a `WorkerPromptCommand` built at queue time with a possibly-stale
  // value; the live worker's `w.sessionId` (updated by the `session-update`
  // IPC) is the freshest signal. Only keep the queued value if the worker has
  // no observed session yet.
  p.resumeSessionId = w.sessionId ?? p.resumeSessionId;
  restampQueuedUserBlock(w.agentName, p.turnId, p.userBlockId);
  w.turnId = p.turnId;
  // FRI-156 follow-up: refresh the turn's origin source at the dispatch
  // boundary so the zero-block carve-out keys off THIS turn's origin, not a
  // prior turn's. A queue-drained prompt carries its own `turnSource`.
  w.turnSource = p.turnSource;
  w.turnStart = Date.now();
  // FRI-58: reset lastBlockStop so the turn-stall watchdog measures from the
  // start of this turn, not the end of the previous one. Without this, any
  // idle period >30min leaves lastBlockStop stale and the next watchdog tick
  // (9s later) sees stalledMs > threshold and SIGTERMs the worker.
  w.lastBlockStop = Date.now();
  w.activePrompt = p;
  w.abortRequested = false;
  // FRI-61 wedge detector: a fresh turn starts with no observed blocks.
  // Today's IPC chain serialises events so this is a no-op (turn-complete
  // already reset the counter before this), but pinning it here protects
  // against future re-orderings.
  w.blocksThisTurn = 0;
  // FRI-148 §5.C: a fresh turn starts with no observed FSM violations.
  // The L1/L2 heal counts violations per-turn; resetting here ensures a
  // worker that hit two violations on the previous turn doesn't carry that
  // ledger into the next one and get force-killed on its first stumble.
  w.illegalTransitionsThisTurn = 0;
  // FRI-127 §5: a fresh turn starts with no observed mail-back. Same
  // defense-in-depth as blocksThisTurn.
  w.mailSendToParentThisTurn = 0;
  setWorkerStatus(w, "working", "sendPrompt");
  // Intentionally no registry.setStatus("working") here. The worker emits
  // a status-change:working IPC when runQuery starts; the handleEvent handler
  // awaits that write (see the status-change case below). A fire-and-forget
  // write here would race with turn-complete's await setStatus("idle"),
  // resolving late and leaving the agent stuck on "working" between turns.
  // spawnTurn (fresh worker spawns) still does an awaited setStatus("working")
  // before forking, which is race-free because no IPC pipeline exists yet.
  eventBus.publish({
    v: 1,
    type: "turn_started",
    turn_id: p.turnId,
    agent: w.agentName,
    ts: Date.now(),
  });
  send(w.child, { type: "prompt", options: p });
}

/**
 * Test seams: insert / remove a fake LiveWorker without going through the
 * spawn pipeline. Used by `lifecycle-stop-forcekill.test.ts` to drive
 * `abortTurn` against a synthetic worker. Not for production use; the
 * inserted entry has no real child process and skipping the spawn path
 * means events the spawn handler would normally publish won't fire.
 */
export function __putLiveWorkerForTest(name: string, w: LiveWorker): void {
  live.set(name, w);
}
export function __deleteLiveWorkerForTest(name: string): void {
  live.delete(name);
}

export function abortTurn(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  w.abortRequested = true;
  // FRI-95: gate on worker state. If the worker isn't currently working,
  // the abort is a no-op — the fast-path got there first (and the worker
  // already emitted error/turn-complete IPC clearing the deadline), the
  // turn completed independently, or this is a stale LISTEN re-fire.
  // Re-arming the 500ms force-kill deadline on an already-idle worker
  // SIGTERMs a cooperative worker 500ms after it cleanly aborted.
  if (w.status !== "working") {
    logger.log("info", "worker.abort.noop-idle", {
      agent: w.agentName,
      turnId: w.turnId,
      workerStatus: w.status,
    });
    return false;
  }
  // FRI-72 instrumentation: pair this with `worker.ipc.recv` so the log
  // shows whether the worker acknowledged the abort (turn-complete /
  // status-change / error) before forceKillStuckWorker's safety net.
  logger.log("info", "worker.ipc.send", {
    agent: w.agentName,
    type: "abort",
    turnId: w.turnId,
    workerStatus: w.status,
  });
  send(w.child, { type: "abort" });
  // FRI-145 M3: project the `aborting` Turn state via the machine. The abort
  // Transition returns no intents and writes no durable Status projection (the
  // agents row stays `working` until the cooperative turn-complete/error or the
  // force-kill deadline heals it to `idle`); it only pins the in-memory Turn
  // state so a racing second `abortTurn` sees the working-gate as
  // already-not-working and no-ops, and the watchdog's stall check (which keys
  // on the derived `w.status`) stops counting progress against a worker that is
  // tearing down. Synchronous: the abort Transition is intent-free, so we apply
  // its state without going through the async intent executor.
  const abortResult = applyTransition(toTurnContext(w), { kind: "abort" }, MACHINE_DEPS());
  setWorkerStatus(w, abortResult.state, "abortTurn");
  // T+0 destructive-tool kill: SIGTERM every process in the worker's
  // pgrp EXCEPT the worker itself. This kills the SDK CLI subprocess
  // and any in-flight tool subprocesses (Bash, Read, WebFetch, …) the
  // instant Stop is pressed — no waiting for the SDK's abortController
  // to propagate, no waiting for the safety-net deadline. Critical
  // for the destructive-Bash case: a runaway `find /` or `rm -rf`
  // dies in milliseconds, not the 2 seconds the prior implementation
  // allowed. The worker process stays alive: its for-await loop sees
  // the SDK iterator close (the CLI subprocess died) and runs the
  // catch arm's `flushInflightBlocks("aborted")` + emits
  // `turn-complete` cleanly.
  const workerPid = w.child.pid ?? 0;
  const descendantsKilled = killPgrpDescendants(w.pgid, workerPid, "SIGTERM");
  logger.log("info", "worker.abort.descendants-killed", {
    agent: w.agentName,
    turnId: w.turnId,
    pgid: w.pgid,
    workerPid,
    descendantsKilled,
  });
  // FRI-12 safety net: if the worker is wedged inside an SDK call (the
  // 529 lockup) AND the descendant kill above didn't free the loop
  // (e.g., the SDK subprocess was the wedged one and is now dead but
  // the worker's for-await iterator is still suspended on a
  // non-cancellable promise), the abort IPC is silently ignored. Without
  // this deadline, the dashboard's bubble would freeze in 'stopping'
  // forever. 500ms is generous for a healthy worker (an honest abort
  // lands in tens of milliseconds once descendants are dead) and tight
  // enough that the user's Stop click feels instant. Was 2000ms before
  // the descendant-kill landed; the descendants-already-dead case
  // doesn't need the longer grace.
  if (w.abortDeadline) clearTimeout(w.abortDeadline);
  // forceKillStuckWorker is async under ADR-023; setTimeout callback is sync,
  // so fire-and-forget with logging. We still set/clear the timer through
  // `w.abortDeadline` so a fast worker response can cancel the kill.
  w.abortDeadline = setTimeout(() => {
    void forceKillStuckWorker(w).catch((err: unknown) => {
      logger.log("warn", "worker.force-kill.error", {
        agent: w.agentName,
        turnId: w.turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, 500);
  w.abortDeadline.unref();
  return true;
}

function clearAbortDeadline(w: LiveWorker): void {
  if (w.abortDeadline) {
    clearTimeout(w.abortDeadline);
    w.abortDeadline = undefined;
  }
}

/**
 * The worker didn't respond to abort within the deadline — finalize the
 * turn ourselves and tear down the process. The next user message will
 * dispatch a fresh fork via the normal `dispatchTurn → spawnTurn` path.
 *
 * Idempotent via the Generation no-op (FRI-145 M2): the first call
 * synchronously `live.delete`s this worker, so any re-entry — a second
 * deadline, a wedge path, or a late IPC Transition from the dying worker —
 * sees `live.get(name) !== w` and bails before re-finalizing the turn. This
 * also closes the abort-deadline-after-archive clobber (AC #17): if an archive
 * already `live.delete`d the name (and wrote `archived`), the leading
 * Generation check no-ops the whole force-kill so its `setStatus(idle)` can't
 * overwrite the terminal `archived` projection.
 */
async function forceKillStuckWorker(
  w: LiveWorker,
  opts: {
    reason?: "abort" | "stale" | "wedge" | "fsm-violation";
    msSinceTurnStart?: number;
    zeroBlockTurnStreak?: number;
  } = {},
): Promise<void> {
  // FRI-145 M2: the Generation no-op replaces the old per-worker re-entry
  // flag AND the `live.has(w.agentName)` presence check. A superseded
  // Generation (already deleted by archive / refork / a prior force-kill, or
  // re-`set` by a replacement) does nothing.
  if (!isCurrentGeneration(w)) return;
  // Synchronously demote this Generation BEFORE the first await. Now any racing
  // path — re-entry, a late error/turn-complete IPC Transition — sees
  // `live.get(name) !== w` and short-circuits, so this turn is finalized
  // exactly once with no re-entry flag. The `child.on("exit")` handler's
  // teardown is likewise a Generation no-op after this delete.
  live.delete(w.agentName);
  w.abortDeadline = undefined;
  const reason = opts.reason ?? "abort";

  if (reason === "stale") {
    logger.log("warn", "worker.turn.stale-killed", {
      agent: w.agentName,
      turnId: w.turnId,
      msSinceTurnStart: opts.msSinceTurnStart ?? null,
    });
  } else if (reason === "wedge") {
    logger.log("warn", "worker.wedge.force-kill", {
      agent: w.agentName,
      turnId: w.turnId,
      zeroBlockTurnStreak: opts.zeroBlockTurnStreak ?? null,
    });
  } else if (reason === "fsm-violation") {
    logger.log("warn", "worker.fsm-violation.force-kill", {
      agent: w.agentName,
      turnId: w.turnId,
      illegalTransitionsThisTurn: w.illegalTransitionsThisTurn,
    });
  } else {
    logger.log("warn", "worker.abort.force-kill", {
      agent: w.agentName,
      turnId: w.turnId,
    });
  }

  // FRI-175: the four per-reason error block payloads now live as named exports
  // in the turn-state machine (single source of truth — a copy edit can no
  // longer drift from `applyFail`'s wedge path). Select one by reason.
  const errorPayload =
    reason === "stale"
      ? STALE_TURN_ERROR_PAYLOAD
      : reason === "wedge"
        ? WEDGE_ERROR_PAYLOAD
        : reason === "fsm-violation"
          ? FSM_VIOLATION_ERROR_PAYLOAD
          : FORCED_ABORT_ERROR_PAYLOAD;
  // Wedge, stale-turn, and fsm-violation all ride `error` status; only an
  // explicit abort synthesizes `abort_reason: "forced"`.
  const ridesError = reason === "stale" || reason === "wedge" || reason === "fsm-violation";
  // The per-reason in-band `error` event message (distinct from the error
  // block's rawMessage and from its code). Stays a local ternary feeding the
  // builder's errorEvent.message.
  const errorMessage =
    reason === "stale"
      ? "Turn timed out — stale-turn ceiling exceeded"
      : reason === "wedge"
        ? "Wedge detected — agent looped without producing output"
        : reason === "fsm-violation"
          ? "FSM violations exceeded threshold — block bookkeeping desynced"
          : "Stop forced — worker unresponsive";
  // FRI-175: the hand-rolled finalize core (record-error → tear-down → publish
  // error → publish turn_done) is now the shared pure builder, executed through
  // the prod ports. Same collaborator calls, same await structure (record-error
  // + tear-down awaited; the two publishes synchronous), same array order — see
  // FRI-175 §8 behaviour-preservation proof. The Generation `live.delete` above
  // still precedes the first await here (record-error-block), preserving the
  // FRI-145 happens-before.
  await executeIntents(
    w,
    buildTurnFinalization({
      turnId: w.turnId,
      agentName: w.agentName,
      errorBlock: errorPayload,
      errorEvent: { code: errorPayload.code, message: errorMessage, recoverable: true },
      turnStatus: ridesError ? "error" : "aborted",
      ...(reason === "abort" ? { abortReason: "forced" as const } : {}),
    }),
    prodPorts,
  );
  w.lastExitStatus = ridesError ? "error" : "aborted";
  setWorkerStatus(w, "idle", "forceKillStuckWorker");
  // FRI-110: keep the `turnStart` invariant universally true. After
  // force-kill the worker is being torn down; a late IPC that races the kill
  // is already a Generation no-op (`live.get(name) !== w`), but clear the
  // timestamp anyway so any future read site can't arithmetic against a stale
  // value.
  w.turnStart = undefined;
  w.activePrompt = undefined;
  await registry.setStatus(w.agentName, "idle").catch((err: unknown) => {
    logger.log("warn", "registry.set-status.error", {
      agent: w.agentName,
      status: "idle",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // Tear down the process group. We've already waited 2s for the worker
  // to honor the abort IPC, so skip the graceful 'stop' command and go
  // straight to SIGTERM. SIGKILL fallback at +1.5s catches anything that
  // ignored SIGTERM. The child.on("exit") handler emits onExit; the next
  // dispatchTurn forks fresh. The live entry is already gone (deleted up
  // front), so the SIGKILL fallback gates on the child still being alive
  // (no exit event yet) rather than on live-map presence.
  killPgrp(w.pgid, "SIGTERM");
  setTimeout(() => {
    if (w.child.exitCode === null && !w.child.killed) killPgrp(w.pgid, "SIGKILL");
  }, 1_500).unref();
}

/**
 * FRI-145 M5 hard-exit self-heal. A worker process exited with a turn still in
 * flight and NO terminal turn-complete/error ever processed (SIGTERM from the
 * stall watchdog, SIGKILL, OOM, crash). The caller (`child.on("exit")`) has
 * already demoted this Generation (`live.delete`) so this runs exactly once for
 * the dying worker; a concurrent archive would have demoted the Generation
 * first and the exit handler would never have reached here.
 *
 * Bug #2: the old exit handler finalized streaming blocks and reset the row to
 * `idle` but never published `turn_done`, so the dashboard's inflight turn pin
 * stayed up forever even though the agent was dispatchable. The `hard-exit`
 * Transition publishes the missing `turn_done{status:"error"}` (plus the
 * in-band `error` event) when a turn was live, then heals to `idle`.
 *
 * F1-A archived guard: if the row is already terminal (`archived` — a row a
 * racing archive committed), DO NOT heal it to `idle`; the archive's
 * workspace-cleanup half would otherwise race the wrong status. Read the row
 * first and skip the whole Transition for an archived agent. (The pre-M5 guard
 * also checked `!== "error"`; the agent-status `error` was pruned in M5, so the
 * archived check is the only terminal state left to preserve.)
 *
 * Exported so the unit test can drive the self-heal directly with a fake worker
 * + spied collaborators, without spawning a real child process whose `exit`
 * event can't be reliably synthesized.
 */
export async function finalizeHardExit(
  w: LiveWorker,
  ports: TurnStatePorts<LiveWorker> = prodPorts,
): Promise<void> {
  try {
    const cur = await registry.getAgent(w.agentName);
    if (cur && cur.status === "archived") {
      // Terminal — a racing archive owns this row. Preserve it; the archive
      // already finalized the worker's turn. Still drop the per-turn block
      // accumulators so the daemon doesn't leak state for a dead turn.
      // FRI-148 A: archive's bare end-turn (no finalize — the archive already
      // wrote the rows) lives behind the narrow __endTurnForArchivedHardExit
      // export so non-archive paths can't accidentally bypass the finalize
      // half of the fused tearDownTurn.
      __endTurnForArchivedHardExit(w.turnId);
      logger.log("info", "lifecycle.exit.archived-preserved", {
        agent: w.agentName,
        turnId: w.turnId,
      });
      return;
    }
    await runTransition(w, { kind: "hard-exit" }, ports);
  } catch (err) {
    logger.log("warn", "lifecycle.exit.hard-exit.error", {
      agent: w.agentName,
      turnId: w.turnId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Find the live agent whose current turn matches `turnId`. Used by the
 * abort endpoint so a Stop click on agent A doesn't tear down B and C
 * just because all three happened to be mid-turn. Returns null when the
 * turn has already completed or never started — the abort caller should
 * surface that as `aborted: false`.
 */
export function findAgentByTurnId(turnId: string): string | null {
  for (const [name, w] of live) {
    if (w.turnId === turnId) return name;
  }
  return null;
}

/**
 * Drive a live worker through stop → exit → kill-fallback. FIX_FORWARD 4.1:
 * the returned promise resolves only after the child process has actually
 * exited (or after a 5s SIGKILL fallback fires). Callers await this so the
 * next fork can't race the dying worker's lingering IPC traffic.
 *
 * F4-B: the resolved value is the captured `nextPrompts` queue. Watchdog
 * refork redispatches these so user prompts that arrived while the old
 * worker was hung aren't dropped (FRI-4).
 *
 * Internal helper. The caller is responsible for the synchronous side
 * effects (live-map delete, optional registry archive, optional ticket
 * close) BEFORE invoking — see `archiveAgent` and `forceWorkerRefork`.
 */
async function drainLiveWorker(w: LiveWorker): Promise<WorkerPromptCommand[]> {
  // FRI-58: prepend the in-flight prompt (already dispatched, not in nextPrompts)
  // so the refork path redelivers it along with any queued prompts.
  const drainedPrompts: WorkerPromptCommand[] = [
    ...(w.activePrompt ? [w.activePrompt] : []),
    ...w.nextPrompts,
  ];

  // Ask the worker to stop gracefully, then wait for the actual exit
  // event. SIGTERM-on-pgrp backstop at 5s catches descendants the worker
  // leaked; SIGKILL-on-pgrp at 7s is the hard floor.
  send(w.child, { type: "stop" });
  if (w.child.exitCode !== null || w.child.killed) {
    // Child is already gone, but descendants may still be running.
    killPgrp(w.pgid, "SIGTERM");
    setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
    return drainedPrompts;
  }

  return new Promise<WorkerPromptCommand[]>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(drainedPrompts);
    };
    w.child.once("exit", () => {
      // Even on clean child exit, send a pgrp SIGTERM to reap any leaked
      // descendants (`(sleep &); disown`). No-op if the group is empty.
      killPgrp(w.pgid, "SIGTERM");
      setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
      finish();
    });
    setTimeout(() => {
      if (done) return;
      // Graceful stop ignored — SIGTERM the whole pgrp (catches leaked
      // descendants too). The `exit` listener resolves the promise once
      // the kernel reaps the worker process.
      killPgrp(w.pgid, "SIGTERM");
      // 2 s after that, SIGKILL the group if anything is still alive.
      setTimeout(() => killPgrp(w.pgid, "SIGKILL"), 2_000).unref();
    }, 5_000).unref();
  });
}

/**
 * Tear down a live worker WITHOUT archiving its registry row. Used by
 * `/clear` and by the FRI-33 watchdog refork: the agent stays present and
 * dispatchable, just with a freshly forked process on the next turn.
 * Returns any queued prompts captured from the dying worker so the
 * watchdog can redispatch them on the replacement.
 *
 * `archived` is reserved for actual archives; using it as a teardown
 * mechanism made `agents.status='archived'` mean two unrelated things
 * (terminal vs. transient refork) and left the dashboard rendering the
 * archived dot for an agent that was about to come back. The
 * `child.on("exit")` handler resets status to `idle` whenever the row
 * is neither `archived` nor `error`, so the post-teardown state for a
 * forced refork is honestly `idle` (or `working`, once the replacement
 * worker's first turn lands).
 */
export async function forceWorkerRefork(agentName: string): Promise<WorkerPromptCommand[]> {
  const w = live.get(agentName);
  if (w) {
    // FRI-145 M2: demote this Generation by deleting the live entry. The
    // exit handler's fire-and-forget setStatus('idle') is now Generation-
    // gated, so once this delete lands the dying worker's exit sees
    // `live.get(name) !== w` and skips the reset entirely — we own the
    // post-teardown status write below. (This replaces the old per-worker
    // suppress-reset flag, which existed only to block that exit reset
    // from racing a watchdog replacement worker's spawnTurn 'working' write.)
    live.delete(agentName);
  }
  if (!w) {
    // No live worker — the row may still be at 'working' from a stale
    // setStatus, so converge it explicitly. No-op when already idle.
    await registry.setStatus(agentName, "idle");
    return [];
  }
  const drained = await drainLiveWorker(w);
  // Explicit terminal write: the agent's row is now `idle` with no live
  // worker. The exit handler's reset path is a Generation no-op (the live
  // entry was deleted above before the drain), so this is the only writer of
  // 'idle' on this teardown.
  await registry.setStatus(agentName, "idle");
  return drained;
}

export async function stopWorkersForApp(appId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.agents.name })
    .from(schema.agents)
    .where(eq(schema.agents.appId, appId));
  let stopped = 0;
  for (const { name } of rows) {
    if (live.has(name)) {
      await forceWorkerRefork(name);
      stopped++;
    }
  }
  return stopped;
}

/**
 * Synchronously SIGTERM every live worker's process group. Called from the
 * daemon shutdown handler so descendants don't get orphaned to launchd on
 * normal SIGTERM/SIGINT. Doesn't wait for exits — the daemon shutdown has
 * its own 2 s ceiling.
 */
export function reapAllLiveWorkers(): void {
  for (const w of live.values()) {
    killPgrp(w.pgid, "SIGTERM");
  }
}

/* ---------------- Turn-stall watchdog (M5) ---------------- */

const DEFAULT_TURN_STALL_MS = 30 * 60 * 1000; // 30 minutes
const TURN_STALL_CHECK_MS = 60 * 1000; // 1 minute

/**
 * FRI-33: hard ceiling on how long a single turn may stay live before the
 * daemon force-reaps the worker. The stall watchdog (`worker.turn.stalled`)
 * already catches workers with no block-stop progress, but it can be defeated
 * by long-running tool loops that emit block-stops periodically while the
 * turn itself never completes. The ~12.5h `msSinceTurnStart` observed on the
 * `path-to-prod-design` worker prior to recurring `daemon.fatal` crashes is
 * exactly that shape: stalled forward progress, healthy IPC.
 *
 * Overridable via `FRIDAY_TURN_STALE_CEILING_MS` (milliseconds).
 */
const DEFAULT_STALE_TURN_CEILING_MS = 4 * 60 * 60 * 1000; // 4 hours

function staleTurnCeilingMs(): number {
  const raw = process.env.FRIDAY_TURN_STALE_CEILING_MS;
  if (!raw) return DEFAULT_STALE_TURN_CEILING_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_TURN_CEILING_MS;
}

/**
 * FRI-61 wedge threshold: the number of consecutive `turn-complete` /
 * `error` events with zero block-starts that triggers force-kill.
 *
 * The 2026-05-20 wedge produced ~290 such turns in 13 minutes; a healthy
 * long-lived worker draining mail emits ≥1 block per turn (even a
 * `mail_close`-only response emits a `tool_use` + `tool_result` pair).
 * A streak of 10 is conservative but well below pathological — overridable
 * via `FRIDAY_WEDGE_THRESHOLD`.
 */
const DEFAULT_WEDGE_THRESHOLD = 10;

function wedgeThreshold(): number {
  const raw = process.env.FRIDAY_WEDGE_THRESHOLD;
  if (!raw) return DEFAULT_WEDGE_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEDGE_THRESHOLD;
}

let stallInterval: NodeJS.Timeout | undefined;

/**
 * The shape of a stalled-worker check input. Decoupled from LiveWorker so
 * the inner loop is testable without populating the live map.
 */
export interface StallCandidate {
  agentName: string;
  turnId: string;
  pgid: number;
  status: "idle" | "working";
  lastBlockStop: number;
}

/**
 * Pure stall-detector. Returns the list of worker names that exceeded the
 * threshold and invokes `kill` on each (test injects a spy). Mutates each
 * candidate's `lastBlockStop` to `now` so a follow-up tick before the
 * worker's `exit` event doesn't re-fire.
 */
export function checkStalledWorkers(
  workers: Iterable<StallCandidate>,
  now: number,
  threshold: number,
  kill: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void,
): string[] {
  const terminated: string[] = [];
  for (const w of workers) {
    if (w.status !== "working") continue;
    const since = now - w.lastBlockStop;
    if (since > threshold) {
      logger.log("warn", "worker.turn.stalled", {
        agent: w.agentName,
        turnId: w.turnId,
        stalledMs: since,
        thresholdMs: threshold,
      });
      kill(w.pgid, "SIGTERM");
      setTimeout(() => kill(w.pgid, "SIGKILL"), 2_000).unref();
      w.lastBlockStop = now;
      terminated.push(w.agentName);
    }
  }
  return terminated;
}

/**
 * Start the per-turn stall watchdog. Periodically scans live workers; if a
 * worker has been in `working` status for longer than the stall threshold
 * without any block-stop, pgrp-SIGTERM it. Honest runaway loops (no model
 * output for half an hour) get reaped before they cost real money or
 * burn a day's worth of background CPU. Threshold overridable via
 * `FRIDAY_TURN_STALL_MS` env (milliseconds).
 */
export function startTurnStallWatchdog(): void {
  if (stallInterval) return;
  const threshold = Number(process.env.FRIDAY_TURN_STALL_MS ?? DEFAULT_TURN_STALL_MS);
  stallInterval = setInterval(() => {
    checkStalledWorkers(live.values(), Date.now(), threshold, killPgrp);
  }, TURN_STALL_CHECK_MS);
  stallInterval.unref();
}

export function stopTurnStallWatchdog(): void {
  if (stallInterval) {
    clearInterval(stallInterval);
    stallInterval = undefined;
  }
}

/**
 * Send a `mail-wakeup` IPC to a live worker so it drains its inbox without
 * waiting for the 60s idle timeout. Returns true if delivered, false if the
 * agent isn't currently live.
 */
export function wakeAgent(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  send(w.child, { type: "mail-wakeup" });
  return true;
}

/**
 * Send a `mail-wakeup-critical` IPC. The worker breaks its current SDK
 * iterator at the next assistant-message boundary (FIX_FORWARD 2.4) and
 * drains the inbox — the critical mail row is at minimum the first to be
 * included in the resulting mail prompt.
 */
export function wakeAgentCritical(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  send(w.child, { type: "mail-wakeup-critical" });
  return true;
}

export function isAgentLive(agentName: string): boolean {
  return live.has(agentName);
}

export function liveAgentNames(): string[] {
  return [...live.keys()];
}

/**
 * Watchdog-only readonly peek at a live worker. Returns a frozen view of the
 * fields the watchdog needs; never returns the LiveWorker itself, so callers
 * can't mutate the live map by accident.
 */
export function peekLiveWorker(agentName: string): {
  status: "idle" | "working";
  lastHeartbeat: number;
  agentType: AgentType;
  turnId: string;
} | null {
  const w = live.get(agentName);
  if (!w) return null;
  return {
    status: w.status,
    lastHeartbeat: w.lastHeartbeat,
    agentType: w.agentType,
    turnId: w.turnId,
  };
}

/**
 * Remove a queued prompt (one that hasn't yet been dispatched to the worker)
 * matching `turnId` from the live worker's `nextPrompts`. Returns the
 * removed `WorkerPromptCommand` so callers can inspect the prompt text
 * (used by the DELETE cancel endpoint to return the recovered text to the
 * dashboard). Returns null when no live worker for this agent, or when no
 * queued entry matches.
 */
export function removeQueuedPrompt(agentName: string, turnId: string): WorkerPromptCommand | null {
  const w = live.get(agentName);
  if (!w) return null;
  const idx = w.nextPrompts.findIndex((p) => p.turnId === turnId);
  if (idx < 0) return null;
  const [removed] = w.nextPrompts.splice(idx, 1);
  return removed;
}

/**
 * FRI-33 outer IPC boundary. `handleEvent` calls `eventBus.publish` from
 * every branch and external subscribers run synchronously on that thread;
 * any sync throw from a subscriber, a malformed payload, or a bug in a
 * downstream handler used to escape into Node's default `uncaughtException`
 * handler (no top-level handler is installed in `services/daemon/src/`)
 * and end the daemon — taking every other live worker with it. Trap once
 * at the IPC boundary so the crash class is closed regardless of which
 * branch threw; per-event `type` is captured for attribution.
 *
 * Exported so the unit test can exercise the boundary directly without
 * spawning a real child process.
 */
export async function safeHandleEvent(w: LiveWorker, raw: unknown): Promise<void> {
  const ev = raw as WorkerEvent;
  try {
    await handleEvent(w, ev);
  } catch (err) {
    if (err instanceof IllegalBlockTransitionError) {
      // FRI-148 §5.C: real-time FSM heal.
      //   L1 — per occurrence: emit `block.transition.illegal` with the
      //        offending op/code and the running per-turn count. Evolve
      //        scans this as a low-severity signal; one stray transition
      //        is interesting but not actionable on its own.
      //   L2 — on threshold: when the per-turn count crosses
      //        FSM_VIOLATION_THRESHOLD, emit the dedicated
      //        `block.transition.illegal.threshold` event (medium severity)
      //        and force-kill the worker with reason "fsm-violation". The
      //        worker's local block bookkeeping is desynced from the
      //        daemon's; a fresh fork is the only safe recovery.
      // The typed error is *not* re-thrown — this branch fully owns the
      // outcome, so the generic `worker.ipc.error` log below stays silent
      // for FSM violations (no double-counting in Evolve).
      w.illegalTransitionsThisTurn++;
      const count = w.illegalTransitionsThisTurn;
      logger.log("warn", "block.transition.illegal", {
        agent: w.agentName,
        type: (ev as { type?: string })?.type ?? "unknown",
        turnId: err.turnId,
        clientBlockId: err.clientBlockId,
        code: err.code,
        op: err.op,
        countThisTurn: count,
      });
      if (count >= FSM_VIOLATION_THRESHOLD) {
        logger.log("warn", "block.transition.illegal.threshold", {
          agent: w.agentName,
          turnId: err.turnId,
          countThisTurn: count,
          threshold: FSM_VIOLATION_THRESHOLD,
        });
        await forceKillStuckWorker(w, { reason: "fsm-violation" });
      }
      return;
    }
    logger.log("error", "worker.ipc.error", {
      agent: w.agentName,
      type: (ev as { type?: string })?.type ?? "unknown",
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleEvent(w: LiveWorker, e: WorkerEvent): Promise<void> {
  // FRI-33: stale-turn ceiling. Any inbound IPC — heartbeat or otherwise —
  // gives us a chance to notice that the worker has been on the same turn
  // longer than is plausible. Reap before downstream handlers run their own
  // arithmetic on `w.turnStart` and before another hour of bills accrues.
  // Idempotent via the Generation no-op: a superseded `w` (already torn down
  // by a prior force-kill, an archive, or a refork) short-circuits below, and
  // `forceKillStuckWorker` itself no-ops on a non-current Generation, so
  // multiple events landing in the same tick reap exactly once.
  //
  // FRI-110 invariant: `w.turnStart` is non-undefined *only* when a turn is
  // live — set on prompt dispatch (sendPrompt + the spawn-fresh
  // `child.once("message", …)` callback) and cleared at every turn-end
  // exit (turn-complete, error, forceKillStuckWorker). The truthy gate
  // below makes between-turns IPC (e.g. the `status-change: idle` the
  // worker emits in its mail-poll loop, which has existed since `0f59da1`
  // and which the original FRI-33 comment incorrectly claimed did not
  // exist) short-circuit cleanly. If a future change re-adds a code path
  // where `turnStart` survives past the turn it describes, the 4h reaper
  // resumes the original FRI-110 bug — keep the three turn-end clears in
  // sync with any new turn-end exit.
  if (isCurrentGeneration(w) && w.turnStart) {
    const msSinceTurnStart = Date.now() - w.turnStart;
    if (msSinceTurnStart > staleTurnCeilingMs()) {
      await forceKillStuckWorker(w, { reason: "stale", msSinceTurnStart });
      return;
    }
  }

  // FRI-72 instrumentation: log lifecycle-significant IPC arrivals.
  // Heartbeats and per-block frames are skipped — too chatty and the
  // canonical block table already records that pipeline. The interesting
  // diagnostics are turn boundaries, status changes, errors, and ready —
  // exactly the events whose absence (or out-of-order arrival) causes the
  // stuck-status family of bugs we're tracking.
  if (
    e.type === "turn-complete" ||
    e.type === "status-change" ||
    e.type === "error" ||
    e.type === "ready"
  ) {
    logger.log("info", "worker.ipc.recv", {
      agent: w.agentName,
      type: e.type,
      turnId: w.turnId,
      workerStatus: w.status,
      msSinceTurnStart: w.turnStart ? Date.now() - w.turnStart : null,
      msSinceLastHeartbeat: Date.now() - w.lastHeartbeat,
    });
  }
  w.lastHeartbeat = Date.now();
  switch (e.type) {
    case "session-update":
      w.sessionId = e.sessionId;
      await registry.setSession(w.agentName, e.sessionId);
      // Sweep this turn's `__pending__` blocks over to the SDK's
      // freshly-minted session id. The dashboard mutator writes user
      // blocks with the sentinel before the daemon has resolved the
      // real id, and the dispatch-listener's pre-worker UPDATE can only
      // rewrite the row if the agent already has a `resumeSessionId` —
      // so a fresh / just-cleared agent's first user block stays at
      // `__pending__` until this sweep runs. Without it, the sidebar's
      // expand-history list and the agents row's `session_count` count
      // every cold-start as a phantom session forever.
      //
      // SCOPED TO `w.turnId`. Sweeping every `__pending__` row for
      // the agent (the simpler shape) would mis-attribute historical
      // orphan rows from prior turns into the current SDK session,
      // pulling yesterday's user prompts into today's context.
      try {
        const swept = await claimPendingSession(w.agentName, w.turnId, e.sessionId);
        if (swept > 0) {
          logger.log("info", "session-update.pending-swept", {
            agent: w.agentName,
            turnId: w.turnId,
            session: e.sessionId,
            rewritten: swept,
          });
        }
      } catch (err) {
        // The sweep is a follow-up data-integrity step, not a turn
        // prerequisite — log and move on rather than wedging the
        // session-update handler. The orphan rows stay at `__pending__`
        // and are still excluded from the sidebar by
        // `listAgentSessions`'s filter.
        logger.log("warn", "session-update.pending-sweep.error", {
          agent: w.agentName,
          turnId: w.turnId,
          session: e.sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // No live JSONL tail-watcher: blocks are persisted directly via the
      // worker → daemon IPC pipeline (FIX_FORWARD 1.2). JSONL is reconciled
      // at boot (FIX_FORWARD 1.3) and after every turn-complete on this
      // worker (catches mid-turn iterator-break drift; see the
      // turn-complete handler below).
      break;
    case "block-start": {
      await bsOpen(w, e);
      break;
    }
    case "block-delta": {
      await bsAppend(w, e);
      break;
    }
    case "block-stop": {
      // M5: block-stop is the canonical "model made progress" signal for
      // the turn-stall watchdog. Heartbeats don't count — a hung SDK still
      // emits them, but no block ever lands.
      w.lastBlockStop = Date.now();
      // FRI-127 §5: count `mail_send` tool_use blocks that target this
      // worker's parent. The tool_use input (and thus `to`) is finalized in
      // the block-stop `contentJson` (`{tool_use_id, name, input}`), which
      // lands during streaming — well before `turn-complete` — so the
      // mail-back backstop reads an accurate count with no race against an
      // in-flight mail_send. `mail_send` resolves the symbolic `parent`/`self`
      // recipients, so accept either the literal parent name or `parent`.
      if (w.parentName) {
        try {
          const parsed = JSON.parse(e.contentJson) as {
            name?: string;
            input?: { to?: string };
          };
          if (
            parsed.name === "mcp__friday-mail__mail_send" &&
            (parsed.input?.to === w.parentName || parsed.input?.to === "parent")
          ) {
            w.mailSendToParentThisTurn++;
          }
        } catch {
          // Non-tool_use or unparseable payload — leave the counter untouched.
        }
      }
      await bsClose(w, e);
      break;
    }
    case "block-cancel": {
      // FRI-78 follow-up: the SDK started a content block and the
      // worker exited the for-await before any deltas accumulated. The
      // block was never persisted (Phase 5: no INSERT until close);
      // block-stream's cancel just publishes `block_canceled` so live
      // clients drop the bubble.
      await bsCancel(w, e);
      break;
    }
    case "error": {
      // FRI-12: a worker response — even an error — means the abort was
      // honored; cancel the force-kill deadline so we don't redundantly
      // kill an already-cooperative worker.
      clearAbortDeadline(w);
      // FRI-145 M2 Generation no-op: if this worker is no longer the current
      // Generation, `forceKillStuckWorker` / archive / refork already deleted
      // it (and finalized this turn). The dying worker may still emit a final
      // error IPC before the kernel reaps it; ignore it so we don't double-
      // publish turn_done over an already-finalized turn.
      if (!isCurrentGeneration(w)) break;
      // FRI-145 M3: the error tail is now ONE Transition. The Turn-state
      // machine decides everything (record-error block, finalize streaming
      // blocks, publish error + turn_done, posthog, the FRI-61 wedge streak +
      // escalation, the FRI-110 turnStart clear, the idle Status projection,
      // and the queue-drain) and returns intents; `runTransition` applies its
      // in-memory mutations + the single `set-status` DB-door intent. The
      // machine is the only writer of `agents.status`.
      await runTransition(w, {
        kind: "fail",
        payload: {
          message: e.message,
          recoverable: e.recoverable,
          code: e.code,
          headline: e.headline,
          httpStatus: e.httpStatus,
          retryAfterSeconds: e.retryAfterSeconds,
          requestId: e.requestId,
          rawMessage: e.rawMessage,
        },
      });
      break;
    }
    case "status-change": {
      // Capture the prior in-memory status BEFORE setWorkerStatus updates it,
      // so the FRI-151 reset below can gate on the idle→working edge rather
      // than firing on the working→working same-status writes the
      // sendPrompt/spawnTurn paths already produce.
      const wasIdle = w.status === "idle";
      setWorkerStatus(w, e.status, "handleEvent.status-change");
      // FRI-151: FRI-127 §6 introduced a worker-internal mail-fetch path
      // (worker.ts mainLoop → buildMailPrompt → runQuery) that drives a new
      // turn WITHOUT calling sendPrompt on the daemon side. FRI-58's
      // lastBlockStop/turnStart reset only fires inside sendPrompt, so a
      // worker that wakes from >30 min idle on the mail path enters `working`
      // with lastBlockStop still pinned at the previous turn's turn-complete.
      // The next watchdog tick (≤60s) measures `Date.now() - lastBlockStop`
      // against the 30 min threshold and SIGTERMs the worker before any
      // block-stop can refresh the bookkeeping. Mirror FRI-58 here so the
      // stall check measures from this turn's start, not the previous one's
      // end. The dispatcher path already set status=working synchronously
      // before this IPC arrives, so wasIdle is false there and we don't
      // double-reset.
      if (wasIdle && e.status === "working") {
        const prevLastBlockStop = w.lastBlockStop;
        const prevTurnId = w.turnId;
        const now = Date.now();
        w.lastBlockStop = now;
        w.turnStart = now;
        // FRI-151 F1: the mail-fetch path mints its own turnId worker-side
        // (worker.ts mainLoop → `t_${randomUUID()}`) and the runQuery
        // status-change now carries it back. Without this refresh every
        // per-turn payload that reads `w.turnId` (block-start / block-stop /
        // usage / SSE / stall log) attributes the mail-driven turn to the
        // PREVIOUS turn's id for its full lifetime. Optional in the IPC for
        // backwards compatibility with workers that haven't been re-forked
        // since the protocol change — they'll still get the bookkeeping
        // reset, just not the id refresh.
        if (e.turnId) w.turnId = e.turnId;
        // FRI-151 F2: positive signal that the reset fired. If this bug ever
        // regresses the operator sees `worker.turn.stalled` + SIGTERM in the
        // logs with no preceding `worker.mail-wake.reset` — the absence of
        // this breadcrumb is the diagnostic.
        logger.log("info", "worker.mail-wake.reset", {
          agent: w.agentName,
          msSinceLastBlockStop: now - prevLastBlockStop,
          prevTurnId,
          newTurnId: w.turnId,
        });
      }
      // FRI-95 defense in depth: a worker that flips to idle has acknowledged
      // any in-flight abort. The turn-complete / error handlers normally
      // clear the deadline, but a status-change without one of those
      // (e.g., the worker exits the for-await before emitting turn-complete)
      // would otherwise leave the safety net armed and force-kill an
      // already-cooperative worker.
      if (e.status === "idle") clearAbortDeadline(w);
      // FRI-145 M2 Generation no-op: a superseded Generation's late
      // status-change must NOT write the durable Status projection. If this
      // worker was already torn down (force-kill / archive / refork) — or a
      // replacement Generation already took the name — `live.get(name) !== w`,
      // and writing `agents.status` here would clobber the live generation's
      // (or a terminal `archived`) projection. The in-memory `setWorkerStatus`
      // above only mutates this dying worker's own field and is harmless.
      if (!isCurrentGeneration(w)) break;
      // Mirror the worker's in-process status into the DB so Zero replicates
      // it to the dashboard. The sendPrompt/spawnTurn paths write "working"
      // for dispatcher-initiated turns; this covers the mail-triggered path
      // where the worker discovers mail in its own inbox and starts a turn
      // without the parent calling sendPrompt — in that case no one else
      // updates the registry and the agent's dot stays grey the entire turn.
      // Same-status writes (e.g., working→working when a dispatcher-initiated
      // turn fires this after sendPrompt already wrote the DB) are legal
      // no-ops per the FSM and just bump updated_at.
      await registry.setStatus(w.agentName, e.status).catch((err: unknown) => {
        logger.log("warn", "registry.set-status.error", {
          agent: w.agentName,
          status: e.status,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      break;
    }
    case "compaction-boundary":
      // FRI-145 M2 Generation no-op: a superseded `w` (already torn down by
      // force-kill / archive / refork, its turn finalized) must not insert a
      // stray durable divider or bump w.blocksThisTurn on a dead worker. The
      // dying worker may still emit a late compaction-boundary IPC mid-teardown
      // — drop it, mirroring the error / turn-complete cases.
      if (!isCurrentGeneration(w)) break;
      // FRI-156 §D: persist a DURABLE compaction-marker block (kind:'compaction'
      // on this turn) instead of the old ephemeral `type:'compaction'` SSE
      // event. The durable row replicates via Zero (survives reload — the bug
      // the ephemeral event could not fix) and is the SOLE divider producer:
      // the dashboard renders it from the replicated row in parseBlocks, NOT
      // from any live SSE frame (the old block_start/block_complete pair was a
      // dead write — no dashboard handler for kind:'compaction' — and has been
      // removed from recordCompactionMarker). The old event's consumer side
      // (compactionTurnIds + .compaction-notice + the CompactionEvent wire
      // type) is deleted in the dashboard chunk; this is one coordinated
      // add-new-path-delete-old-path migration. The marker also bumps
      // w.blocksThisTurn (see the injector doc-comment) so the durable divider
      // replaces the synthesized "Compacted — no response" bubble and a legit
      // /compact turn doesn't advance the wedge streak. Insert unconditionally
      // per boundary frame: multiple compactions in one long turn are
      // legitimate, each deserves a divider. The marker insert is best-effort
      // (returns null + logs on failure) so a CHECK/dup error can never wedge
      // this handler.
      await bsRecordCompactionMarker(w, {
        preTokens: e.preTokens,
        postTokens: e.postTokens,
        durationMs: e.durationMs,
        sessionId: e.sessionId,
      });
      break;
    case "compacting-status":
      // Generation no-op: a superseded worker's late status frame must not
      // publish a spinner toggle / log line over an already-finalized turn.
      if (!isCurrentGeneration(w)) break;
      // FRI-156 §C: live compaction-in-progress signal. Surface the transient
      // `compacting` wire event so the dashboard can show a "Compacting
      // context…" spinner at 'start' and clear it at 'done'. This carries NO
      // durable state — the settled artifact is the kind:'compaction' marker
      // block written by the compaction-boundary case above. The wire type is
      // CompactingEvent (shared); the dashboard chunk consumes it.
      eventBus.publish({
        v: 1,
        type: "compacting",
        agent: w.agentName,
        turn_id: w.turnId,
        phase: e.phase,
      });
      // Durable mirror of the transient signal above: stamp `now()` on start,
      // clear to NULL on done. The SSE event is in-memory on the client and
      // lost across a reload or the daemon-restart window; this `compacting_
      // since` column (replicated via Zero) is what lets the indicator
      // RECONSTRUCT. `new Date()` is the daemon's receipt instant for the start
      // frame — within IPC latency of the SDK's actual compaction start, fine
      // for an elapsed-time readout. Best-effort: a transient UPDATE failure
      // must not wedge the live spinner or the turn, so log-and-continue. The
      // `_setStatusUnchecked` backstop + boot reconcile clear any value this
      // path failed to clear, so a dropped done-write can't wedge it on.
      try {
        await registry.setCompactingSince(w.agentName, e.phase === "start" ? new Date() : null);
        // Race guard: a force-kill's `setStatus(idle)` runs OFF the per-agent
        // transition queue and nulls the flag via its backstop; if it demotes
        // this worker's generation WHILE the start-stamp above is awaiting its
        // UPDATE, our stamp can land last and wedge `compacting_since` set on a
        // now-idle agent. Re-check generation after the await and undo the
        // stamp if we've been superseded. (Only `start` writes a non-null
        // value, so only `start` can wedge.) Backstop + boot reconcile would
        // self-heal on the next turn/boot anyway; this closes the window now.
        if (e.phase === "start" && !isCurrentGeneration(w)) {
          await registry.setCompactingSince(w.agentName, null);
        }
      } catch (err) {
        logger.log("warn", "worker.compact.compacting-since.error", {
          agent: w.agentName,
          turn_id: w.turnId,
          phase: e.phase,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // FRI-156 §F / AC8: log compact_result/compact_error on the closing
      // frame. The wire CompactingEvent has no error slot, so a FAILED
      // compaction's reason would otherwise be discarded entirely. Daemon-log
      // only (forensic) — the spinner/divider are the user-facing surface.
      if (e.phase === "done") {
        logger.log(e.result === "failed" ? "warn" : "info", "worker.compact.result", {
          agent: w.agentName,
          turn_id: w.turnId,
          result: e.result,
          ...(e.error ? { error: e.error } : {}),
        });
      }
      break;
    case "memory-flush": {
      // Generation no-op: drop a superseded worker's late flush log lines.
      if (!isCurrentGeneration(w)) break;
      // FRI-27: the PreCompact memory-flush sub-query lifecycle. Logging-only —
      // there is no SSE/durable artifact (the flush's effect is the 0..n
      // memory_save rows it writes via the memory MCP). Maps the worker's
      // phase to the FRI-27 forensic event names (worker.compact.flush.
      // {started,saved,error}) in daemon.jsonl.
      const flushEvent =
        e.phase === "start"
          ? "worker.compact.flush.started"
          : e.phase === "complete"
            ? "worker.compact.flush.saved"
            : "worker.compact.flush.error";
      logger.log(e.phase === "error" ? "warn" : "info", flushEvent, {
        agent: w.agentName,
        session_id: e.sessionId,
        ...(e.savedCount !== undefined ? { saved_count: e.savedCount } : {}),
        ...(e.message ? { message: e.message } : {}),
      });
      break;
    }
    case "turn-complete": {
      // FRI-12: same cancellation as the error path. If the worker raced
      // to completion right around the abort deadline, the in-flight
      // turn_done is the truthful one — don't kill the worker on top of
      // a successful (or cleanly-aborted) turn.
      clearAbortDeadline(w);
      // FRI-145 M2 Generation no-op: a superseded `w`'s late turn-complete
      // (its turn was already finalized by force-kill / archive / refork)
      // must not re-publish turn_done.
      if (!isCurrentGeneration(w)) break;
      // FRI-145 M3: the turn-complete tail is now ONE Transition. The
      // Turn-state machine decides the turn_done payload (incl. the FRI-60
      // zero-block reason + FRI-95 abort metadata), the usage insert, the
      // posthog event, the FRI-4 streaming-block finalize, the FRI-61 wedge
      // streak + escalation, the FRI-110 turnStart clear, the idle Status
      // projection, the per-turn JSONL recovery sweep, the FRI-127 §5
      // mail-back backstop (Option B nudge / Option C warn), and the
      // queue-drain — and returns intents. `runTransition` applies the
      // in-memory mutations + the single `set-status` DB-door write. The
      // machine is the sole writer of `agents.status`.
      await runTransition(w, {
        kind: "complete",
        payload: {
          sessionId: e.sessionId,
          compactionThisTurn: e.compactionThisTurn,
          usage: e.usage,
          requestUsages: e.requestUsages,
        },
      });
      // FRI-154: a successful turn-complete is the "this agent made forward
      // progress" signal. Reset the anti-loop respawn counter so a long-lived
      // agent that survived 2 force-kill respawns over months doesn't
      // dead-letter on the next unrelated death.
      noteTurnComplete(w.agentName);
      break;
    }
    case "heartbeat":
      // No SSE wire event yet; lastHeartbeat update at top of handler is
      // enough for the Phase 6 watchdog.
      break;
    case "ready":
      // Already handled by the once() listener that sends `start`.
      break;
  }
}

function send(child: ChildProcess, cmd: WorkerCommand): void {
  if (child.send) child.send(cmd);
}
