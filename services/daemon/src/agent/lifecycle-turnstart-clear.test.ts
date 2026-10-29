/**
 * FRI-110 + FRI-116: `w.turnStart = undefined` is the post-condition of
 * every turn-end exit. The lifecycle handler has FIVE such exits:
 *
 *   1. happy `turn-complete` (lifecycle.ts ~line 1631 — happy-path clear)
 *   2. `error` event (lifecycle.ts ~line 1502 — happy-path clear)
 *   3. wedge force-kill via `turn-complete` (lifecycle.ts ~line 1597 — hoisted clear)
 *   4. wedge force-kill via `error` (lifecycle.ts ~line 1473 — hoisted clear)
 *   5. `forceKillStuckWorker` itself (lifecycle.ts ~line 879)
 *
 * Original FRI-110 fix relied on (5)'s clear to cover (3) and (4) — a
 * "trust the chain" pattern. FRI-116 hoists the clear into the wedge
 * branches themselves so each branch holds its own invariant locally.
 *
 * This file pins the post-condition end-to-end: after any turn-end path,
 * `w.turnStart` is falsy.
 *
 * FRI-145 M2 update: `handleEvent`'s `error` / `turn-complete` cases now
 * begin with a Generation guard (`if (!isCurrentGeneration(w)) break;`). A
 * worker only ever receives IPC while it is the live map's current
 * Generation (the `child.on("message")` handler closes over a worker that was
 * `live.set`), so every test here registers the worker in the live map — the
 * realistic state. The pre-M2 shortcut of leaving the worker out of the map
 * (to no-op `forceKillStuckWorker`) is no longer valid: an unregistered worker
 * is a superseded Generation and `handleEvent` would short-circuit before
 * reaching the turn-end clear at all. The wedge tests still pin the
 * end-to-end invariant (turnStart cleared on the wedge path); the hoisted
 * clear runs before `forceKillStuckWorker`, and `forceKillStuckWorker` is now
 * exercised for real (worker registered) rather than no-op'd.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_turnstart_clear" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: { turnStart: number | undefined } & Record<string, unknown>;
  handle: FakeWorkerHandle;
} {
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    pgid: 0,
    agentName: "ts-clear-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-ts-1",
    sessionId: "sess-ts-1",
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
    blocksThisTurn: 0,
    zeroBlockTurnStreak: 0,
    ...overrides,
  };
  return { worker: w, handle };
}

describe("lifecycle: w.turnStart cleared on every turn-end path (FRI-110, FRI-116)", () => {
  it("happy turn-complete clears w.turnStart", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 1, // produced a block → not wedge
      zeroBlockTurnStreak: 0,
    });
    __putLiveWorkerForTest("ts-clear-agent", worker as never);
    try {
      await handleEvent(
        worker as never,
        {
          type: "turn-complete",
          sessionId: "sess-ts-1",
        } as never,
      );
      expect(worker.turnStart).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest("ts-clear-agent");
    }
  });

  it("error event clears w.turnStart", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 1,
      zeroBlockTurnStreak: 0,
    });
    __putLiveWorkerForTest("ts-clear-agent", worker as never);
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
      expect(worker.turnStart).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest("ts-clear-agent");
    }
  });

  it("wedge force-kill via turn-complete clears w.turnStart (hoisted clear)", async () => {
    // The hoist puts `w.turnStart = undefined` BEFORE the
    // `forceKillStuckWorker(...)` call. FRI-145 M2: the worker is registered
    // in the live map (the realistic state — handleEvent only runs for a
    // current Generation), so the wedge branch's `forceKillStuckWorker`
    // executes for real. The hoisted clear still runs first; the end-to-end
    // post-condition (turnStart cleared on the wedge path) is what we pin.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 0,
      zeroBlockTurnStreak: 9, // one more zero-block turn trips the default threshold of 10
    });
    __putLiveWorkerForTest("ts-clear-agent", worker as never);
    try {
      await handleEvent(
        worker as never,
        {
          type: "turn-complete",
          sessionId: "sess-ts-1",
        } as never,
      );
      expect(worker.turnStart).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest("ts-clear-agent");
    }
  });

  it("wedge force-kill via error clears w.turnStart (hoisted clear)", async () => {
    // Symmetric to the turn-complete case; the error case has its own
    // independent wedge branch in lifecycle.ts. Both must hoist.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      blocksThisTurn: 0,
      zeroBlockTurnStreak: 9,
    });
    __putLiveWorkerForTest("ts-clear-agent", worker as never);
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
      expect(worker.turnStart).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest("ts-clear-agent");
    }
  });

  it("force-kill via stale-turn ceiling clears w.turnStart", async () => {
    // The stale-turn reaper (handleEvent prologue) calls forceKillStuckWorker
    // directly. FRI-145 M2: the prologue gates on `isCurrentGeneration(w)` and
    // forceKillStuckWorker is idempotent via the Generation no-op
    // (`live.get(name) !== w` short-circuits re-entry). With the worker
    // registered in the live map below, the FIRST stale heartbeat runs
    // forceKillStuckWorker fully — it clears `w.turnStart`, then `live.delete`s
    // to demote the Generation. We confirm the turnStart-clear post-condition
    // by registering the worker, then driving the prologue once.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeFakeWorker({
      // Push turnStart far enough in the past to trip the 4h
      // FRIDAY_TURN_STALE_CEILING_MS default. ~5h ago.
      turnStart: Date.now() - 5 * 60 * 60 * 1000,
      blocksThisTurn: 1,
      zeroBlockTurnStreak: 0,
    });
    __putLiveWorkerForTest("ts-clear-agent", worker as never);
    try {
      await handleEvent(
        worker as never,
        {
          type: "heartbeat",
        } as never,
      );
      expect(worker.turnStart).toBeUndefined();
    } finally {
      __deleteLiveWorkerForTest("ts-clear-agent");
    }
  });
});
