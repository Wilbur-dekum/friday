/**
 * friday-supervisor — the launchd-supervised entrypoint for Friday's
 * production stack.
 *
 * Spawns daemon + dashboard + zero-cache as children with shared process
 * group. Watches each for exit; restarts with exponential backoff
 * (capped). Treats `zero-cache` exit code 14 (`AutoResetSignal`) as a
 * fast restart. Crash-loop guard: 5 failed restarts inside 60s causes
 * the supervisor itself to exit non-zero so launchd surfaces it.
 *
 * On SIGTERM / SIGINT: sends SIGTERM to its own process group, waits up
 * to 10s for descendants to exit, then escalates to SIGKILL. The
 * supervisor's process group includes every child and every grandchild
 * — closing the FRI-83 zombie gap from `tmux kill-session`, which only
 * signals the pane shell.
 *
 * The plist entry runs this binary as `bin/friday-supervisor`. launchd's
 * job-level process-group cleanup is the safety net under any
 * supervisor failure path; the supervisor's own cascade-stop is the
 * happy path.
 *
 * Design constraints (FRI-88 §0):
 *  - No tmux. No bash respawn wrappers. `friday stop` (now
 *    `launchctl bootout`) leaves zero descendants alive.
 *
 * Child-spawn command resolution (FRI-146 / ADR-034): every child is
 * spawned via `process.execPath` — the fnm-resolved pinned node the
 * supervisor itself runs under (the launchd plist launches the supervisor
 * via `fnm exec -- node …`). This bypasses pnpm and the pnpm-generated
 * `.bin` shims (which bake a pack-time absolute `NODE_PATH` that doesn't
 * survive relocation to `~/.local/share/friday/versions/<v>/`). zero-cache
 * and zero-deploy-permissions are spawned via `process.execPath` directly
 * against `@rocicorp/zero`'s `cli.js` / `deploy-permissions.js`.
 */

import { ChildProcess, spawn, spawnSync, type StdioOptions } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLogPath,
  LOGS_DIR,
  loadConfig,
  loadFridayConfig,
  resolveDaemonPort,
  resolveDashboardPort,
} from "@friday/shared";
import {
  buildZeroCacheEnv,
  runZeroDeployPermissions,
  zeroCacheCli,
  zeroCacheCwd,
} from "../lib/zero-cache.js";
import { checkDeps, clearBlockedState, writeBlockedState, type DepReport } from "../lib/deps.js";

// ---- Layout -----------------------------------------------------------

/**
 * Repo root, derived from this script's location. The supervisor is
 * compiled to `<repo>/packages/cli/dist/bin/supervisor.js`; walk five
 * dirnames up to land on the repo root. Works identically in the dev
 * checkout and in the curl install (where the tree lives under
 * `~/.local/share/friday/versions/<v>/`, reached via the `current`
 * symlink).
 */
function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "pnpm-workspace.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("supervisor: cannot locate repo root (no pnpm-workspace.yaml)");
}

// ---- .env loading -----------------------------------------------------

/**
 * FRI-150 (pivot, ADR-037): the supervisor used to load `~/.friday/.env`
 * into its own `process.env` and let children inherit secrets that way.
 * That polluted the entire process tree (supervisor → daemon → worker →
 * MCP) with daemon-private secrets, making the worker-fork → MCP-spawn
 * trust gradient impossible to enforce.
 *
 * The new model:
 *   - `loadFridayConfig()` returns an immutable object; supervisor reads
 *     it once at boot, uses it to construct each child's env explicitly.
 *   - daemon + dashboard children inherit a CLEAN `process.env` and call
 *     `loadFridayConfig()` themselves for secret access.
 *   - zero-cache is an external binary that can't call our loader; its
 *     spawn env explicitly injects the four secrets it needs
 *     (ZERO_UPSTREAM_DB / ZERO_AUTH_SECRET / ZERO_ADMIN_PASSWORD / ZERO_REPLICA_FILE).
 */
function ensureFridayEnvFileExists(): void {
  // loadFridayConfig() creates ~/.friday/.env on first call + autogens
  // missing load-bearing secrets. Run it eagerly so subsequent boots
  // don't have to re-generate. The returned object is discarded here —
  // children read it themselves.
  loadFridayConfig();
}

// ---- Child specs ------------------------------------------------------

interface ChildSpec {
  name: "daemon" | "dashboard" | "zero-cache";
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** One-shot setup step run before the child is spawned for the first
   *  time. Used by zero-cache to deploy permissions. */
  preStart?: () => Promise<void>;
  /** Exit codes that should trigger a fast restart (no backoff). */
  fastRestartCodes?: number[];
}

function buildSpecs(repoRoot: string): ChildSpec[] {
  const cfg = loadConfig();
  const daemonPort = resolveDaemonPort(cfg);
  const dashboardPort = resolveDashboardPort(cfg);
  // FRI-150 (pivot, ADR-037): zero-cache is an external binary that can't
  // call `loadFridayConfig()`. The supervisor reads the secrets it needs
  // and injects them explicitly into the zero-cache spawn env. daemon +
  // dashboard children inherit a CLEAN process.env and call the loader
  // themselves.
  const fridayEnv = loadFridayConfig();

  return [
    {
      name: "daemon",
      // Spawn via the fnm-resolved pinned node the supervisor runs under,
      // never bare `node` from PATH (FRI-146).
      cmd: process.execPath,
      args: ["dist/index.js"],
      cwd: join(repoRoot, "services", "daemon"),
      env: {
        ...process.env,
        // Daemon resolves its own port from its env / config / constant
        // chain; passing it here is belt-and-braces.
        FRIDAY_DAEMON_PORT: String(daemonPort),
        // FRI-116: the supervisor pipes the child's stdout to the same
        // `~/.friday/logs/<service>.jsonl` file the child's own
        // createLogger writes via its fd. Without disabling the
        // child's stdout-mode, every log line lands twice. Dev mode
        // (`pnpm dev:daemon`) bypasses the supervisor and keeps the
        // default `stdoutMode: "json"` for terminal visibility.
        FRIDAY_LOG_STDOUT: "off",
      },
    },
    {
      name: "zero-cache",
      // Spawn zero-cache via `process.execPath` directly against
      // @rocicorp/zero's cli.js — never `pnpm exec` / the `.bin` shim, whose
      // baked absolute NODE_PATH doesn't survive relocation (FRI-146). The
      // env-construction + deploy-permissions preStart live in lib/zero-cache
      // so the dev launcher (`bin/dev-zero.ts`) can't drift from prod.
      cmd: process.execPath,
      args: [zeroCacheCli(repoRoot)],
      cwd: zeroCacheCwd(repoRoot),
      env: buildZeroCacheEnv(fridayEnv, dashboardPort),
      // Zero exits 14 on AutoResetSignal (replica schema-version drift
      // vs upstream Postgres); restart immediately, no backoff.
      fastRestartCodes: [14],
      async preStart(): Promise<void> {
        runZeroDeployPermissions(repoRoot, fridayEnv);
      },
    },
    {
      name: "dashboard",
      // Spawn via the fnm-resolved pinned node the supervisor runs under,
      // never bare `node` from PATH (FRI-146).
      cmd: process.execPath,
      args: ["server-entry.mjs"],
      cwd: join(repoRoot, "services", "dashboard"),
      env: {
        ...process.env,
        // adapter-node + server-entry.mjs both read PORT.
        PORT: String(dashboardPort),
        // FRI-116: same rationale as the daemon spec — supervisor pipes
        // child stdout to dashboard.jsonl and the dashboard's
        // createLogger writes its own fd, so without this each line
        // doubles. Dev mode (`pnpm dev:dashboard`) bypasses the
        // supervisor and keeps the default stdout mode for terminal
        // visibility.
        FRIDAY_LOG_STDOUT: "off",
      },
    },
  ];
}

// ---- Supervisor state -------------------------------------------------

interface ChildState {
  spec: ChildSpec;
  proc: ChildProcess | null;
  /** Wall-clock timestamps of recent exits for crash-loop detection. */
  exitTimestamps: number[];
  /** Current exponential-backoff delay (ms). Reset on clean ready. */
  backoffMs: number;
  /** True once cascade-stop begins; suppresses respawn. */
  shuttingDown: boolean;
}

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 5;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
const CASCADE_STOP_DEADLINE_MS = 10_000;

const children: Map<string, ChildState> = new Map();
let supervisorShuttingDown = false;

function supervisorLogPath(): string {
  return join(LOGS_DIR, "supervisor.jsonl");
}

function logSupervisor(event: string, extra: Record<string, unknown> = {}): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    service: "supervisor",
    event,
    ...extra,
  });
  // Append synchronously — supervisor events are infrequent and we want
  // them durable before the process moves on (especially during shutdown).
  try {
    appendFileSync(supervisorLogPath(), line + "\n");
  } catch {
    // Last-resort: write to stderr so launchd captures it.
    process.stderr.write(line + "\n");
  }
}

// ---- Spawning + restart loop -----------------------------------------

async function spawnChild(state: ChildState): Promise<void> {
  if (state.shuttingDown || supervisorShuttingDown) return;
  const { spec } = state;
  try {
    if (spec.preStart) {
      logSupervisor("child.pre-start", { name: spec.name });
      await spec.preStart();
    }
  } catch (err) {
    logSupervisor("child.pre-start.error", {
      name: spec.name,
      message: err instanceof Error ? err.message : String(err),
    });
    scheduleRestart(state);
    return;
  }

  const logPath = getLogPath(spec.name);
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  // Pipe stdout + stderr into the same JSONL file. daemon/dashboard
  // already write their own structured logs; zero-cache emits JSON
  // when ZERO_LOG_FORMAT=json. Either way, stdout = log.
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];

  logSupervisor("child.spawn", {
    name: spec.name,
    cmd: spec.cmd,
    args: spec.args,
    cwd: spec.cwd,
  });
  const proc = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio,
    // `detached: true` makes the child a process-group leader (pgid =
    // child.pid). Cascade-stop then does `process.kill(-child.pid,
    // 'SIGTERM')` to signal the child AND every descendant in its
    // tree — exactly closing the FRI-83 zombie gap where zero-cache's
    // worker pool survived parent SIGTERM. We don't call `unref()`
    // because we want the supervisor's event loop to track the child.
    detached: true,
  });
  state.proc = proc;
  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  proc.on("exit", (code, signal) => {
    state.proc = null;
    logSupervisor("child.exit", {
      name: spec.name,
      code,
      signal,
    });
    logStream.end();
    if (state.shuttingDown || supervisorShuttingDown) return;
    state.exitTimestamps.push(Date.now());
    // Trim to the crash-loop window.
    const cutoff = Date.now() - CRASH_LOOP_WINDOW_MS;
    state.exitTimestamps = state.exitTimestamps.filter((t) => t > cutoff);
    if (state.exitTimestamps.length >= CRASH_LOOP_MAX) {
      logSupervisor("child.crash-loop", {
        name: spec.name,
        exits: state.exitTimestamps.length,
        windowMs: CRASH_LOOP_WINDOW_MS,
      });
      // Exit the supervisor so launchd surfaces the failure. The
      // operator can investigate via `friday logs <name>` or
      // `friday doctor`.
      void cascadeStop(/* exitCode */ 1);
      return;
    }
    scheduleRestart(state, code ?? null);
  });
  proc.on("error", (err) => {
    logSupervisor("child.error", {
      name: spec.name,
      message: err.message,
    });
  });
}

function scheduleRestart(state: ChildState, exitCode: number | null = null): void {
  if (state.shuttingDown || supervisorShuttingDown) return;
  const fastRestart = exitCode !== null && (state.spec.fastRestartCodes ?? []).includes(exitCode);
  const delayMs = fastRestart ? 0 : state.backoffMs;
  if (!fastRestart) {
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_CAP_MS);
  }
  logSupervisor("child.restart.scheduled", {
    name: state.spec.name,
    delayMs,
    fastRestart,
  });
  setTimeout(() => void spawnChild(state), delayMs);
}

// ---- Shutdown ---------------------------------------------------------

/**
 * Walk a process subtree and signal every descendant of `rootPid`,
 * post-order (leaves first, root last). Uses `pgrep -P <pid>` to find
 * direct children; recurses.
 *
 * Process-group signaling (`kill -<pgid>`) alone is NOT sufficient.
 * Discovered during the FRI-88 operator flip: zero-cache's
 * multi-process server (`replicator.js`, `change-streamer.js`,
 * `reaper.js`, `syncer.js` x N) explicitly calls `setsid()` on each
 * worker, placing them in their own process group. A `kill -<pgid>`
 * against the supervisor's child pgid then misses every worker.
 * Walking the parent-child tree via `pgrep -P` finds them regardless
 * of how many pgid boundaries they've crossed.
 */
function pgrepDirectChildren(parentPid: number): number[] {
  const r = spawnSync("pgrep", ["-P", String(parentPid)], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function killDescendantTree(rootPid: number, signal: NodeJS.Signals): void {
  for (const child of pgrepDirectChildren(rootPid)) {
    killDescendantTree(child, signal); // post-order: kill grandchildren first
    try {
      process.kill(child, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        logSupervisor("descendant.kill.error", {
          pid: child,
          signal,
          code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Cascade-kill a child and every descendant in its process tree.
 * Walks the parent-child tree post-order (leaves first), then signals
 * the immediate child. The tree walk catches descendants that
 * `setsid()`'d themselves into their own process group — the pattern
 * that defeats naive `kill -<pgid>` cascade-stop.
 */
function killChildGroup(state: ChildState, signal: NodeJS.Signals): void {
  const pid = state.proc?.pid;
  if (!pid) return;
  killDescendantTree(pid, signal);
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      logSupervisor("child.kill.error", {
        name: state.spec.name,
        signal,
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function cascadeStop(exitCode = 0): Promise<void> {
  if (supervisorShuttingDown) return;
  supervisorShuttingDown = true;
  logSupervisor("cascade-stop.begin", {});
  for (const state of children.values()) {
    state.shuttingDown = true;
  }

  // SIGTERM each child's process group. This catches grandchildren
  // (zero-cache's workers, the daemon's worker forks) because the
  // children were spawned with `detached: true`.
  for (const state of children.values()) {
    killChildGroup(state, "SIGTERM");
  }

  // Wait up to CASCADE_STOP_DEADLINE_MS for all children to exit.
  const deadline = Date.now() + CASCADE_STOP_DEADLINE_MS;
  while (Date.now() < deadline) {
    const alive = [...children.values()].filter((s) => s.proc !== null);
    if (alive.length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Anything still alive gets SIGKILL to its process group.
  const stragglers = [...children.values()].filter((s) => s.proc !== null);
  if (stragglers.length > 0) {
    logSupervisor("cascade-stop.sigkill", {
      stragglers: stragglers.map((s) => s.spec.name),
    });
    for (const state of stragglers) {
      killChildGroup(state, "SIGKILL");
    }
  }
  logSupervisor("cascade-stop.done", { exitCode });
  process.exit(exitCode);
}

// ---- Dependency preflight gate ---------------------------------------

/** How often the parked supervisor re-checks deps so the stack self-heals
 *  once `friday provision` makes them present — no `friday restart` needed. */
const DEPS_RECHECK_MS = 15_000;

let depsRecheckTimer: ReturnType<typeof setInterval> | null = null;
let stackBroughtUp = false;

/**
 * Spawn the three children in dependency order: daemon first (it owns
 * migrations), then zero-cache (needs the daemon-applied schema current), then
 * dashboard (proxies WS to zero-cache via server-entry.mjs).
 */
async function bringUpStack(): Promise<void> {
  if (stackBroughtUp || supervisorShuttingDown) return;
  stackBroughtUp = true;
  for (const name of ["daemon", "zero-cache", "dashboard"] as const) {
    const state = children.get(name);
    if (!state) continue;
    await spawnChild(state);
    // Small inter-spawn gap to let daemon settle before zero-cache probes its
    // schema, and zero-cache settle before dashboard tries to proxy /api/sync.
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * READ-ONLY dependency preflight. A HARD-missing dep (pgvector binary or
 * extension, Postgres unreachable, wal_level != logical, …) would crash-loop
 * the daemon and cascade-stop the healthy children — so we refuse to bring up
 * the stack at all (whole-stack park), record WHY in a blocked-state file
 * `friday status` reads, and stay alive re-checking. The supervisor NEVER
 * installs anything here (no `brew install` on the launchd boot path); the
 * remedy points at the interactive `friday provision`. Once deps are healthy
 * the re-check brings the stack up automatically.
 */
async function preflightAndBringUp(opts?: {
  check?: () => Promise<DepReport>;
  bringUp?: () => Promise<void>;
}): Promise<void> {
  if (supervisorShuttingDown) return;
  const check = opts?.check ?? checkDeps;
  const bringUp = opts?.bringUp ?? bringUpStack;
  let report: DepReport;
  try {
    report = await check();
  } catch (err) {
    // A preflight that itself errors must NOT silently block the stack — fail
    // OPEN to the legacy behaviour (bring the stack up; the daemon's own
    // fail-loud path still applies) rather than park on a probe bug.
    logSupervisor("deps.preflight.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    clearBlockedState();
    await bringUp();
    return;
  }

  if (report.ok) {
    clearBlockedState();
    await bringUp();
    return;
  }

  // Park: record the blocked state and re-check on an interval. The interval is
  // the ONLY thing keeping the parked supervisor alive — do NOT unref it, or
  // the process would exit and launchd KeepAlive would thrash-restart it.
  writeBlockedState({ ts: new Date().toISOString(), hard: report.hard });
  logSupervisor("deps.blocked", {
    hard: report.hard.map((i) => i.name),
    // FRI-2003: log the per-issue remedies rather than one blanket remedy.
    // `checkDeps` already tailors each remedy to the environment (a container
    // is told to fix DATABASE_URL, not to run `brew services`), so a hardcoded
    // summary contradicted the detail it was summarising.
    remedies: report.hard.map((i) => `${i.name}: ${i.remedy}`),
  });
  if (depsRecheckTimer) return;
  depsRecheckTimer = setInterval(() => {
    void (async () => {
      if (supervisorShuttingDown) return;
      let r: DepReport;
      try {
        r = await check();
      } catch {
        return; // transient probe error — keep parked, try again next tick
      }
      if (!r.ok) {
        // Refresh the remedy list in case the missing set changed.
        writeBlockedState({ ts: new Date().toISOString(), hard: r.hard });
        return;
      }
      if (depsRecheckTimer) {
        clearInterval(depsRecheckTimer);
        depsRecheckTimer = null;
      }
      logSupervisor("deps.unblocked", {});
      clearBlockedState();
      await bringUp();
    })();
  }, DEPS_RECHECK_MS);
}

/** Test-only: clear the park re-check timer and reset the one-shot bring-up
 *  latch so a fresh `preflightAndBringUp` can run in the next test case. */
function resetGateForTest(): void {
  if (depsRecheckTimer) {
    clearInterval(depsRecheckTimer);
    depsRecheckTimer = null;
  }
  stackBroughtUp = false;
}

// ---- Main -------------------------------------------------------------

async function main(): Promise<void> {
  ensureFridayEnvFileExists();
  const repoRoot = findRepoRoot();
  logSupervisor("startup", { pid: process.pid, repoRoot });

  const specs = buildSpecs(repoRoot);
  for (const spec of specs) {
    children.set(spec.name, {
      spec,
      proc: null,
      exitTimestamps: [],
      backoffMs: BACKOFF_INITIAL_MS,
      shuttingDown: false,
    });
  }

  // Register signal handlers BEFORE the preflight so a parked supervisor (deps
  // missing, no children spawned) still shuts down cleanly on `friday stop` /
  // `friday restart`'s kickstart.
  process.on("SIGTERM", () => void cascadeStop());
  process.on("SIGINT", () => void cascadeStop());

  // Gate the whole stack on a read-only dependency preflight. If deps are
  // healthy this brings the stack up immediately; if not, it parks (spawns
  // nothing) with a clear remedy and self-heals on the re-check.
  await preflightAndBringUp();

  // Stay alive: the event loop is kept turning by the child stdio pipes and the
  // spawn-retry timers (healthy path) or the deps re-check interval (parked
  // path). If every child has exited and shutdown hasn't fired, the supervisor
  // exits naturally (and launchd will restart it via KeepAlive).
}

// Only run when invoked as a script (not when imported by tests). The
// `process.argv[1]` resolution handles both `node supervisor.js` and the
// `bin/friday-supervisor` wrapper's `exec node …`.
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/friday-supervisor") === true ||
  process.argv[1]?.endsWith("/supervisor.js") === true;

if (invokedAsScript) {
  main().catch((err) => {
    logSupervisor("supervisor.fatal", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}

// Test-facing exports. Not part of the public CLI surface; the binary
// itself is the only intended consumer. Marked here so `supervisor.test.ts`
// can drive `killChildGroup` against subprocess fixtures and assert the
// child specs' env (e.g. the zero-cache sync-worker pin).
export {
  buildSpecs,
  killChildGroup,
  preflightAndBringUp,
  resetGateForTest,
  CRASH_LOOP_WINDOW_MS,
  CRASH_LOOP_MAX,
  BACKOFF_INITIAL_MS,
  BACKOFF_CAP_MS,
  CASCADE_STOP_DEADLINE_MS,
  DEPS_RECHECK_MS,
};
export type { ChildSpec, ChildState };
