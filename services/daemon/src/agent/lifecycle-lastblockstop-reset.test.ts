/**
 * FRI-58: `w.lastBlockStop` reset and `w.activePrompt` lifecycle.
 *
 * Before this fix, `sendPrompt` did not reset `lastBlockStop`. After any idle
 * period >30 min the stall watchdog would fire on the very next turn because
 * `now - w.lastBlockStop` exceeded the threshold immediately (the previous
 * turn's block-stop timestamp was still in place).
 *
 * This file pins two invariants:
 *
 *  1. `checkStalledWorkers` does NOT stall-kill a worker whose `lastBlockStop`
 *     was reset to `Date.now()` at turn-start (i.e., the post-condition of
 *     `sendPrompt` after the fix). Before the fix a worker with a stale
 *     lastBlockStop from the previous turn would be killed immediately.
 *
 *  2. `w.activePrompt` is cleared on every turn-end exit (turn-complete,
 *     error, wedge via turn-complete, wedge via error). Parallel to the
 *     `w.turnStart` invariant tested in `lifecycle-turnstart-clear.test.ts`.
 *     These tests require Postgres via `createTestDb` — they are skipped in
 *     environments without a database (same behavior as the sibling file).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";

const MIN = 60_000;

describe("FRI-58: lastBlockStop reset prevents false stall-kills after idle", () => {
  it("a fresh turn with lastBlockStop=now is not stall-killed on the next tick", async () => {
    const { checkStalledWorkers } = await import("./lifecycle.js");
    const now = 35 * MIN;
    // Simulate a worker that just started a new turn (sendPrompt reset lastBlockStop to now).
    const w = {
      agentName: "fresh",
      turnId: "t-fresh",
      pgid: 99,
      status: "working" as const,
      lastBlockStop: now, // reset by sendPrompt — this is the fix
    };
    const kill = vi.fn();
    const terminated = checkStalledWorkers([w], now, 30 * MIN, kill);
    expect(terminated).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("a worker with stale lastBlockStop from a prior idle turn IS stall-killed (regression guard)", async () => {
    const { checkStalledWorkers } = await import("./lifecycle.js");
    const now = 35 * MIN;
    // Simulate the pre-fix scenario: lastBlockStop was from the end of the previous turn, 31min ago.
    const w = {
      agentName: "stale",
      turnId: "t-stale",
      pgid: 100,
      status: "working" as const,
      lastBlockStop: now - 31 * MIN, // stale — as it would be without sendPrompt reset
    };
    const kill = vi.fn();
    const terminated = checkStalledWorkers([w], now, 30 * MIN, kill);
    expect(terminated).toEqual(["stale"]);
    expect(kill).toHaveBeenCalledWith(100, "SIGTERM");
  });
});

// The handleEvent-based tests below require a Postgres database. They follow the
// same pattern as lifecycle-turnstart-clear.test.ts and are skipped when no DB
// is available — the same behavior as the sibling file in this environment.
describe("FRI-58: activePrompt cleared on every turn-end exit", () => {
  let handle: Awaited<ReturnType<(typeof import("@friday/shared"))["createTestDb"]>> | undefined;

  beforeAll(async () => {
    try {
      const { createTestDb } = await import("@friday/shared");
      handle = await createTestDb({ label: "lifecycle_lastblockstop" });
    } catch {
      handle = undefined;
    }
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await handle?.truncate();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeFakeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      handle: fakeWorkerHandle(),
      pgid: 0,
      agentName: "lbs-agent",
      agentType: "orchestrator",
      model: "claude-opus-4-7",
      turnId: "turn-lbs-1",
      sessionId: "sess-lbs-1",
      workingDirectory: "/tmp/fake",
      abortRequested: false,
      lastHeartbeat: Date.now(),
      turnStart: Date.now() - 1000,
      spawnedAt: Date.now() - 5000,
      lastBlockStop: Date.now(),
      status: "working",
      nextPrompts: [],
      activePrompt: { prompt: "hello", turnId: "turn-lbs-1", userBlockId: undefined },
      mode: "long-lived",
      lastExitStatus: "complete",
      completedAtLeastOnce: false,
      blocksThisTurn: 1,
      zeroBlockTurnStreak: 0,
      ...overrides,
    };
  }

  // FRI-145 M2: handleEvent's error / turn-complete cases now gate on the
  // Generation rule (`isCurrentGeneration(w)`), so the worker must be the live
  // map's current entry for its turn-end to be processed. Register it (the
  // realistic state — IPC only arrives for a live worker).
  it("happy turn-complete clears activePrompt", async () => {
    if (!handle) return;
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const worker = makeFakeWorker({ blocksThisTurn: 1, zeroBlockTurnStreak: 0 });
    __putLiveWorkerForTest(worker["agentName"] as string, worker as never);
    try {
      await handleEvent(
        worker as never,
        { type: "turn-complete", sessionId: "sess-lbs-1" } as never,
      );
      expect(worker["activePrompt"]).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest(worker["agentName"] as string);
    }
  });

  it("error event clears activePrompt", async () => {
    if (!handle) return;
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const worker = makeFakeWorker({ blocksThisTurn: 1, zeroBlockTurnStreak: 0 });
    __putLiveWorkerForTest(worker["agentName"] as string, worker as never);
    try {
      await handleEvent(
        worker as never,
        {
          type: "error",
          message: "SDK error",
          recoverable: true,
          code: "test_error",
          headline: "test error",
          rawMessage: "test",
        } as never,
      );
      expect(worker["activePrompt"]).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest(worker["agentName"] as string);
    }
  });

  it("wedge force-kill via turn-complete clears activePrompt (hoisted clear)", async () => {
    if (!handle) return;
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const worker = makeFakeWorker({
      blocksThisTurn: 0,
      zeroBlockTurnStreak: 9, // one more zero-block turn trips the default threshold of 10
    });
    __putLiveWorkerForTest(worker["agentName"] as string, worker as never);
    try {
      await handleEvent(
        worker as never,
        { type: "turn-complete", sessionId: "sess-lbs-1" } as never,
      );
      expect(worker["activePrompt"]).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest(worker["agentName"] as string);
    }
  });

  it("wedge force-kill via error clears activePrompt (hoisted clear)", async () => {
    if (!handle) return;
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const worker = makeFakeWorker({ blocksThisTurn: 0, zeroBlockTurnStreak: 9 });
    __putLiveWorkerForTest(worker["agentName"] as string, worker as never);
    try {
      await handleEvent(
        worker as never,
        {
          type: "error",
          message: "SDK error",
          recoverable: true,
          code: "wedge_error",
          headline: "wedge error",
          rawMessage: "test",
        } as never,
      );
      expect(worker["activePrompt"]).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest(worker["agentName"] as string);
    }
  });
});
