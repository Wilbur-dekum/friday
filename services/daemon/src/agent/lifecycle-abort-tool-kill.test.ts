/**
 * Stop must kill in-flight tool subprocesses immediately (item #1 in
 * `~/.claude/plans/mellow-sparking-dusk.md`).
 *
 * The bug this test pins: prior to the descendant-kill landing, `abortTurn`
 * sent the IPC and waited up to 2 seconds for the SDK's abortController to
 * propagate through the CLI subprocess to in-flight tools (Bash, etc.). A
 * destructive `rm -rf` or runaway `find /` kept executing for that window.
 *
 * New contract:
 *   - `abortTurn` calls `killPgrpDescendants(pgid, workerPid, "SIGTERM")`
 *     at T+0, alongside the IPC send.
 *   - The worker process itself is left alive; its for-await loop sees the
 *     SDK CLI subprocess close and runs the catch arm cleanly.
 *   - Tool subprocesses in the worker's pgrp are reaped within milliseconds.
 *
 * The test spawns a real shell subprocess whose own child is a long `sleep`,
 * sets up a synthetic `LiveWorker` whose pgrp matches that shell, then calls
 * `abortTurn`. The descendant `sleep` must die within 100ms; the shell
 * itself must stay alive (it's the worker stand-in).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { killPgrp, killPgrpDescendants } from "./worker-runtime.js";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "abort_tool_kill" });
});

beforeEach(async () => {
  await handle.truncate();
});

afterEach(async () => {
  vi.useRealTimers();
});

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

/**
 * Spawn a detached shell that itself runs a long `sleep`. The shell is its
 * own pgrp leader (detached:true). Returns once the `sleep` subprocess is
 * confirmed to exist as a child of the shell — that gives the test a real
 * descendant to assert on without racing the fork.
 */
async function spawnShellWithSleepChild(): Promise<{
  shellPid: number;
  sleepPid: number;
  cleanup: () => void;
}> {
  const shell = spawn("sh", ["-c", "sleep 60 & while :; do sleep 30; done"], {
    detached: true,
    stdio: "ignore",
  });
  const shellPid = shell.pid;
  if (!shellPid) throw new Error("shell did not spawn");

  // Wait for the shell to fork `sleep`. Poll pgrep until we see the child.
  let sleepPid = 0;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const r = spawnSync("pgrep", ["-P", String(shellPid)], { encoding: "utf8" });
    if (r.status === 0) {
      const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        sleepPid = Number.parseInt(lines[0], 10);
        if (Number.isFinite(sleepPid) && sleepPid > 0) break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!sleepPid) {
    try {
      process.kill(-shellPid, "SIGKILL");
    } catch {
      /* ignore */
    }
    throw new Error("sleep child never appeared under shell pgrp");
  }

  return {
    shellPid,
    sleepPid,
    cleanup: () => {
      try {
        process.kill(-shellPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    },
  };
}

describe("abortTurn kills in-flight tool subprocesses immediately", () => {
  it("SIGTERMs the worker's descendants at T+0 (no 2s grace) while leaving the worker process alive", async () => {
    const { abortTurn, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const { shellPid, sleepPid, cleanup } = await spawnShellWithSleepChild();
    try {
      // Synthetic LiveWorker whose pgrp matches the real shell + sleep
      // subprocess tree. `child.pid = shellPid` is critical so
      // `killPgrpDescendants` excludes the shell (worker stand-in) and only
      // signals the sleep child.
      // FRI-2037: a REAL handle, not `fakeWorkerHandle()`. This case is an
      // integration test of the descendant kill — it spawns an actual shell
      // with an actual `sleep` child and asserts the sleep dies while the
      // shell survives. A fake handle would stub out the exact behaviour
      // under test and the case would pass while proving nothing.
      //
      // `pid` is the shell for both roles: with `detached: true` a real
      // worker leads its own group, so pgid === pid, and passing shellPid as
      // the worker pid is what makes `killPgrpDescendants` exclude the shell
      // and signal only the sleep child.
      const sendSpy = vi.fn();
      const handle = {
        pid: shellPid,
        send: sendSpy,
        onMessage: () => {},
        onceMessage: () => {},
        onError: () => {},
        onExit: () => {},
        onceExit: () => {},
        isAlive: () => Promise.resolve(true),
        terminate: async (sig: "SIGTERM" | "SIGKILL") => {
          killPgrp(shellPid, sig);
        },
        terminateDescendants: async (sig: "SIGTERM" | "SIGKILL") =>
          killPgrpDescendants(shellPid, shellPid, sig),
      };
      const worker = {
        handle,
        pgid: shellPid,
        agentName: "abort-tool-kill-agent",
        agentType: "orchestrator",
        model: "claude-opus-4-7",
        turnId: "turn-att-1",
        sessionId: "sess-att-1",
        workingDirectory: "/tmp/fake",
        abortRequested: false,
        lastHeartbeat: Date.now(),
        turnStart: Date.now() - 1000,
        spawnedAt: Date.now() - 5000,
        lastBlockStop: Date.now(),
        status: "working",
        nextPrompts: [],
        mode: "long-lived",
        lastExitStatus: "complete",
        completedAtLeastOnce: false,
      };
      __putLiveWorkerForTest("abort-tool-kill-agent", worker as never);

      // Sanity: sleep is alive before abort.
      expect(pidIsAlive(sleepPid)).toBe(true);
      expect(pidIsAlive(shellPid)).toBe(true);

      // Fire.
      expect(await abortTurn("abort-tool-kill-agent")).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({ type: "abort" });

      // Poll until sleep is reaped. The whole point of the descendant-kill
      // is that destructive tools die within a human-imperceptible window —
      // pin a tight 100ms timeout here so a regression is caught.
      await vi.waitFor(() => expect(pidIsAlive(sleepPid)).toBe(false), {
        timeout: 100,
        interval: 5,
      });

      // Worker stand-in (the shell) is still alive — descendant-kill is
      // surgical. The shell runs `while :; do sleep 30; done` so it stays
      // alive indefinitely even after the sleep children are killed.
      expect(pidIsAlive(shellPid)).toBe(true);

      __deleteLiveWorkerForTest("abort-tool-kill-agent");
    } finally {
      cleanup();
    }
  });

  it("is a no-op on agents that aren't live", async () => {
    const { abortTurn } = await import("./lifecycle.js");
    expect(await abortTurn("agent-that-does-not-exist")).toBe(false);
  });
});
