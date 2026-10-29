import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// FRI-61 wedge detector.
//
// Wedge signature: the SDK iterator yields only `result` (no
// `content_block_start` fires) for N consecutive turns. We count those via
// `blocksThisTurn` + `zeroBlockTurnStreak` on LiveWorker. When the streak
// reaches `FRIDAY_WEDGE_THRESHOLD` (default 10), the daemon force-kills
// with `reason: "wedge"`.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_wedge" });
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
  worker: unknown;
  handle: FakeWorkerHandle;
} {
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    pgid: 0,
    agentName: "wedge-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-wedge-1",
    sessionId: "sess-wedge-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
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

interface CapturedEvent {
  type: string;
  code?: string;
  status?: string;
  message?: string;
  agent?: string;
  turn_id?: string;
}

describe("lifecycle: wedge detector (FRI-61)", () => {
  it("force-kills after 10 consecutive turn-completes with zero blocks", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker();
    __putLiveWorkerForTest("wedge-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));
    const logSpy = vi.spyOn(logger, "log");

    // 9 turn-completes don't trigger the kill.
    for (let i = 0; i < 9; i++) {
      await handleEvent(
        worker as never,
        {
          type: "turn-complete",
          sessionId: "sess-wedge-1",
        } as never,
      );
      // FRI-145 M2: the wedge worker has NOT been force-killed yet, so it is
      // still the current Generation in the live map (force-kill is what
      // demotes it via `live.delete`). This replaces the deleted per-worker
      // re-entry flag the old assertion checked.
      expect(isAgentLive("wedge-agent")).toBe(true);
    }
    expect((worker as { zeroBlockTurnStreak: number }).zeroBlockTurnStreak).toBe(9);

    // 10th turn-complete trips the threshold.
    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-wedge-1",
      } as never,
    );
    unsub();

    // FRI-145 M2: the wedge force-kill demoted this Generation — the live map
    // no longer holds it (`live.delete` inside `forceKillStuckWorker`).
    expect(isAgentLive("wedge-agent")).toBe(false);

    const killLog = logSpy.mock.calls.find(([, event]) => event === "worker.wedge.force-kill");
    expect(killLog).toBeDefined();
    const [level, , payload] = killLog!;
    expect(level).toBe("warn");
    const p = payload as { zeroBlockTurnStreak: number };
    expect(p.zeroBlockTurnStreak).toBe(10);

    const errorEvent = captured.find((e) => e.type === "error" && e.code === "worker_wedged");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe("worker_wedged");

    // The final turn_done is the wedge force-kill one — status='error'.
    // Earlier turn-completes emitted their own turn_done with
    // status='complete' before the streak tripped the threshold.
    const turnDones = captured.filter((e) => e.type === "turn_done");
    expect(turnDones.at(-1)?.status).toBe("error");

    __deleteLiveWorkerForTest("wedge-agent");
  });

  it("force-kills after 10 consecutive error events (non-abort) with zero blocks", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const { worker } = makeFakeWorker({
      agentName: "wedge-err-agent",
      turnId: "turn-wedge-err-1",
    });
    __putLiveWorkerForTest("wedge-err-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    for (let i = 0; i < 10; i++) {
      await handleEvent(
        worker as never,
        {
          type: "error",
          message: "SDK CLI exited 1 — resume target missing",
          code: "resume_missing",
          recoverable: false,
        } as never,
      );
    }
    unsub();

    // FRI-145 M2: force-kill demoted the Generation (live entry deleted).
    expect(isAgentLive("wedge-err-agent")).toBe(false);
    expect((worker as { zeroBlockTurnStreak: number }).zeroBlockTurnStreak).toBe(10);
    const wedgeError = captured.find((e) => e.type === "error" && e.code === "worker_wedged");
    expect(wedgeError).toBeDefined();

    __deleteLiveWorkerForTest("wedge-err-agent");
  });

  it("does not force-kill when each turn produces at least one block", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const { worker } = makeFakeWorker({
      agentName: "wedge-healthy-agent",
      turnId: "turn-wedge-healthy-1",
    });
    __putLiveWorkerForTest("wedge-healthy-agent", worker as never);

    // 11 turn-completes, each preceded by one block-start. Streak should
    // stay at 0 throughout.
    for (let i = 0; i < 11; i++) {
      // Manually bump blocksThisTurn — handleBlockStart writes DB rows
      // which would require a fuller scaffold; the increment is the
      // load-bearing signal for the detector.
      (worker as { blocksThisTurn: number }).blocksThisTurn = 1;
      await handleEvent(
        worker as never,
        {
          type: "turn-complete",
          sessionId: "sess-healthy",
        } as never,
      );
    }

    // FRI-145 M2: a healthy worker is never force-killed, so it stays the
    // current Generation in the live map throughout.
    expect(isAgentLive("wedge-healthy-agent")).toBe(true);
    expect((worker as { zeroBlockTurnStreak: number }).zeroBlockTurnStreak).toBe(0);

    __deleteLiveWorkerForTest("wedge-healthy-agent");
  });

  it("respects FRIDAY_WEDGE_THRESHOLD env override", async () => {
    const prev = process.env.FRIDAY_WEDGE_THRESHOLD;
    process.env.FRIDAY_WEDGE_THRESHOLD = "3";
    try {
      const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
        await import("./lifecycle.js");

      const { worker } = makeFakeWorker({
        agentName: "wedge-env-agent",
        turnId: "turn-wedge-env-1",
      });
      __putLiveWorkerForTest("wedge-env-agent", worker as never);

      // 3 zero-block turn-completes trigger the override threshold.
      for (let i = 0; i < 3; i++) {
        await handleEvent(
          worker as never,
          {
            type: "turn-complete",
            sessionId: "sess-env",
          } as never,
        );
      }

      // FRI-145 M2: the override threshold tripped a force-kill, demoting the
      // Generation (live entry deleted).
      expect(isAgentLive("wedge-env-agent")).toBe(false);
      expect((worker as { zeroBlockTurnStreak: number }).zeroBlockTurnStreak).toBe(3);

      __deleteLiveWorkerForTest("wedge-env-agent");
    } finally {
      if (prev === undefined) delete process.env.FRIDAY_WEDGE_THRESHOLD;
      else process.env.FRIDAY_WEDGE_THRESHOLD = prev;
    }
  });

  it("does not count a user-initiated abort toward the streak", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const { worker } = makeFakeWorker({
      agentName: "wedge-abort-agent",
      turnId: "turn-wedge-abort-1",
      abortRequested: true,
    });
    __putLiveWorkerForTest("wedge-abort-agent", worker as never);

    // Multiple abort-triggered turn-completes with zero blocks — must
    // NOT trip the wedge detector.
    for (let i = 0; i < 15; i++) {
      await handleEvent(
        worker as never,
        {
          type: "turn-complete",
          sessionId: "sess-abort",
        } as never,
      );
      // Re-arm abort flag per call — the abort handler resets it after
      // each turn.
      (worker as { abortRequested: boolean }).abortRequested = true;
    }

    // FRI-145 M2: a user abort is cooperative, not a wedge, so no force-kill
    // fires and the worker stays the current Generation.
    expect(isAgentLive("wedge-abort-agent")).toBe(true);
    expect((worker as { zeroBlockTurnStreak: number }).zeroBlockTurnStreak).toBe(0);

    __deleteLiveWorkerForTest("wedge-abort-agent");
  });
});
