import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { logger } from "../log.js";

/**
 * The worker boundary, as a protocol seam (FRI-2037).
 *
 * Today a worker is a detached child process reached over node IPC and killed
 * by signalling its process group. Under FRI-2038 it becomes a container
 * reached over a message channel and stopped by the runtime. Both are the same
 * handful of capabilities — start it, talk to it, hear from it, ask if it is
 * alive, stop it — so they go behind one interface now rather than being
 * retrofitted later, which the ticket calls the expensive version.
 *
 * The surface turned out far smaller than feared: the `ChildProcess` never
 * escapes `lifecycle.ts` (measured — zero references to `.child` or `.pgid`
 * anywhere else), so this is a dozen call sites in one file rather than a
 * cross-cutting rewrite.
 *
 * WHY THE SEAM IS ASYNC. Liveness and termination are synchronous today
 * (`child.exitCode`, `process.kill(-pgid)`). A container runtime cannot answer
 * either synchronously — both are calls over a socket. The alternative was a
 * cached liveness flag kept fresh by the event stream, which is a smaller diff
 * but puts a possibly-stale value underneath the force-kill decision, the one
 * place where being wrong is worst. The measured cost of async was two route
 * handlers gaining the keyword.
 *
 * Deliberately NOT modelled: process groups, `bash`, `sandbox-exec`, `ulimit`.
 * Those are how the LOCAL runtime implements the capabilities, not part of the
 * capability. A container runtime gets cgroups and its own isolation, and must
 * not be handed concepts it cannot honour.
 */

/** What the daemon needs started, in runtime-neutral terms. */
export interface WorkerSpawnRequest {
  /** Absolute path to the worker entry module. */
  workerPath: string;
  /** Extra argv for the node process (loader hooks, etc.). */
  execArgv: string[];
  env: NodeJS.ProcessEnv;
  /** CPU seconds and max open files. The local runtime maps these to a
   *  `ulimit` prelude; a container runtime to cgroup limits. */
  limits: { cpuSeconds: string; openFiles: string };
  /** macOS sandbox profile, when the local runtime should wrap the worker in
   *  `sandbox-exec`. Absent elsewhere — see docs/sandbox.md § "Linux and
   *  containers" for why this is local-only. */
  sandboxProfilePath?: string;
}

/**
 * A started worker.
 *
 * `pid` is the one leak of local semantics, and it is deliberate: the daemon
 * logs it, and the local runtime uses it as the process-group id. Nothing
 * downstream interprets the number beyond logging and equality, so a container
 * runtime can report whatever identifies its container.
 */
export interface WorkerHandle {
  readonly pid: number;
  /** Send a command. Fire-and-forget, as node IPC is today. */
  send(msg: unknown): void;
  onMessage(cb: (raw: unknown) => void): void;
  /** Fires once, on the worker's first message — the ready handshake. */
  onceMessage(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** One-shot exit listener, for callers awaiting a single teardown. */
  onceExit(cb: () => void): void;
  /** Whether the worker is still running. */
  isAlive(): Promise<boolean>;
  /** Stop the worker AND everything it spawned. */
  terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  /**
   * Stop the worker's DESCENDANTS, leaving the worker running.
   *
   * Narrow but load-bearing: `abortTurn` uses it to reap tool subprocesses a
   * cancelled turn leaked, without taking down the agent — the worker has to
   * survive long enough to see the SDK iterator close and emit `turn-complete`
   * cleanly. Returns the count signalled, for the log line and the test.
   */
  terminateDescendants(signal: "SIGTERM" | "SIGKILL"): Promise<number>;
}

export interface WorkerRuntime {
  spawn(req: WorkerSpawnRequest): WorkerHandle;
}

/**
 * Signal a whole process group.
 *
 * Moved VERBATIM from lifecycle.ts rather than reimplemented — a first draft
 * of this file rewrote it and silently changed behaviour (threw where this
 * logs, filtered pids differently, counted kills rather than members). The
 * kill primitives belong with the runtime, so they live here and lifecycle.ts
 * re-exports them; `lifecycle-pgrp.test.ts` keeps covering them unchanged.
 *
 * `-pgid` reaches every descendant, including ones that escaped into the
 * background. `ESRCH` means it already exited and `EPERM` that it is not ours
 * to signal; neither is worth propagating. `pgid <= 1` is refused outright —
 * that would target the daemon's own group, or init.
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
 * Signal every process in `pgid` EXCEPT the worker itself.
 *
 * `pgrep -g` is available on macOS and Linux, which is Friday's whole
 * deployment surface.
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

/** `exec "$@"` so the rlimits are in effect from the worker's first line. */
function ulimitPrelude(limits: WorkerSpawnRequest["limits"]): string {
  return `ulimit -t ${limits.cpuSeconds}; ulimit -n ${limits.openFiles}; exec "$@"`;
}

class LocalProcessHandle implements WorkerHandle {
  readonly pid: number;

  constructor(private readonly child: ChildProcess) {
    // With `detached: true` the child leads its own group, so pgid === pid.
    // A failed spawn leaves pid undefined; 0 is the sentinel that makes every
    // kill path a safe no-op.
    this.pid = child.pid ?? 0;
  }

  send(msg: unknown): void {
    if (this.child.send) this.child.send(msg as never);
  }

  onMessage(cb: (raw: unknown) => void): void {
    this.child.on("message", cb);
  }

  onceMessage(cb: () => void): void {
    this.child.once("message", cb);
  }

  onError(cb: (err: Error) => void): void {
    this.child.on("error", cb);
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.on("exit", cb);
  }

  onceExit(cb: () => void): void {
    this.child.once("exit", cb);
  }

  isAlive(): Promise<boolean> {
    // Synchronous underneath; async at the seam because a container's answer
    // cannot be. `exitCode === null` means it has not exited; `killed` means a
    // signal was delivered.
    return Promise.resolve(this.child.exitCode === null && !this.child.killed);
  }

  terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    killPgrp(this.pid, signal);
    return Promise.resolve();
  }

  terminateDescendants(signal: "SIGTERM" | "SIGKILL"): Promise<number> {
    return Promise.resolve(killPgrpDescendants(this.pid, this.pid, signal));
  }
}

/**
 * The runtime Friday uses today: a detached child process over node IPC.
 *
 * The triple chain (`sandbox-exec` → `bash` → `node`) preserves
 * NODE_CHANNEL_FD through both `exec()`s, which is what keeps IPC working —
 * pinned by sandbox-profile-kernel.test.ts and lifecycle-spawn-ipc.test.ts.
 * `process.execArgv` is forwarded so loader hooks on the daemon (`--import
 * tsx/esm` under `tsx watch`) reach the worker; `fork()` did that implicitly
 * and going through bash means doing it explicitly.
 */
export const localProcessRuntime: WorkerRuntime = {
  spawn(req: WorkerSpawnRequest): WorkerHandle {
    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Makes the worker its own process-group leader, so the whole group can
      // be signalled on teardown. Without it a leaked descendant
      // (`(sleep 200 &); disown`) survives the worker.
      detached: true,
      env: req.env,
    };
    const nodeArgs = [...req.execArgv, req.workerPath];
    const prelude = ulimitPrelude(req.limits);
    const child = req.sandboxProfilePath
      ? spawn(
          "/usr/bin/sandbox-exec",
          [
            "-f",
            req.sandboxProfilePath,
            "/bin/bash",
            "-c",
            prelude,
            "--",
            process.execPath,
            ...nodeArgs,
          ],
          spawnOpts,
        )
      : spawn("/bin/bash", ["-c", prelude, "--", process.execPath, ...nodeArgs], spawnOpts);
    return new LocalProcessHandle(child);
  },
};
